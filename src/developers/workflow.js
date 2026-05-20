'use strict';

const path = require('path');
const fs = require('fs');

const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { loadDeveloperDomain } = require('./developer-loader');
const { validateAnalyzePreflight } = require('./preflight-validator');
const { buildPlan, buildGapReport } = require('./report-builder');
const {
  initializeStateFromManifest,
  initializeIdMap,
  resolveOutputPaths,
  writeJson,
  writeNdjson,
} = require('./state-store');
const { GraviteeClient } = require('../shared/gravitee-client');

function makeEvent(type, payload = {}) {
  return { ts: new Date().toISOString(), type, ...payload };
}

async function resolveTargetState(domain, config, client) {
  const state = {
    usersByEmail: new Map(),
    applicationsBySourceId: new Map(),
    plansBySourceId: new Map(),
    subscriptionsBySourceId: new Map(),
    apiKeysBySubscriptionSourceId: new Map(),
  };

  if (!client) return state;

  for (const user of domain.users) {
    if (typeof client.findUserByEmail === 'function') {
      try {
        const found = await client.findUserByEmail(user.email);
        if (found) state.usersByEmail.set(user.email, found);
      } catch (_) {}
    }
  }

  for (const application of domain.applications) {
    if (typeof client.findApplicationByNameAndOwnerHint === 'function') {
      try {
        const found = await client.findApplicationByNameAndOwnerHint({
          name: application.appName,
          ownerHint: application.developerEmail,
          sourceId: application.sourceId,
        });
        if (found) state.applicationsBySourceId.set(application.sourceId, found);
      } catch (_) {}
    }
  }

  for (const subscription of domain.subscriptions) {
    const mapping = subscription.planMapping;
    if (typeof client.findPlan === 'function' && mapping) {
      try {
        const plan = await client.findPlan(mapping);
        if (plan) state.plansBySourceId.set(subscription.sourceId, plan);
      } catch (_) {}
    }

    const application = state.applicationsBySourceId.get(`${subscription.developerEmail}/${subscription.appName}`);
    const plan = state.plansBySourceId.get(subscription.sourceId);

    if (typeof client.findSubscription === 'function' && application && plan) {
      try {
        const found = await client.findSubscription({
          applicationId: application.id,
          apiId: plan.apiId || mapping.targetApiId || null,
          planId: plan.id || mapping.targetPlanId || null,
          sourceId: subscription.sourceId,
        });
        if (found) {
          state.subscriptionsBySourceId.set(subscription.sourceId, found);
          if (typeof client.listSubscriptionApiKeys === 'function') {
            try {
              const apiKeys = await client.listSubscriptionApiKeys({
                apiId: plan.apiId || mapping.targetApiId || null,
                subscriptionId: found.id,
              });
              state.apiKeysBySubscriptionSourceId.set(subscription.sourceId, apiKeys || []);
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  }

  return state;
}

function buildPlanningEvents(domain, preflight, manifest) {
  return [
    makeEvent('preflight.summary', {
      developers: domain.users.length,
      applications: domain.applications.length,
      credentials: domain.credentials.length,
      subscriptions: domain.subscriptions.length,
      blockers: preflight.blockers.length,
      warnings: preflight.warnings.length,
    }),
    ...preflight.findings.map((finding) => makeEvent(`preflight.${finding.severity}`, finding)),
    ...manifest.actions.map((action) => makeEvent('plan.action', {
      actionId: action.actionId,
      kind: action.kind,
      sourceId: action.sourceId,
      plannedStatus: action.plannedStatus,
      operation: action.operation,
    })),
  ];
}

async function prepareDevelopersWorkflow(flags, deps = {}) {
  const irDir = path.resolve(flags['ir-dir'] || './ir');
  const config = deps.config || loadDevelopersConfig(flags['config'], flags);
  const validation = validateDevelopersConfig(config);
  if (!validation.valid) {
    return {
      exitCode: 1,
      error: 'Invalid developers config',
      validationErrors: validation.errors,
    };
  }

  const outputPaths = resolveOutputPaths(config);
  const domain = deps.domain || loadDeveloperDomain(irDir, config);
  const client = deps.client || new GraviteeClient({
    baseUrl: config.gravitee.url,
    orgId: config.gravitee.orgId,
    envId: config.gravitee.envId,
    token: flags['gravitee-token'] || process.env.GRAVITEE_TOKEN,
    dryRun: !!flags['dry-run'],
  });

  const preflight = await validateAnalyzePreflight({ config, domain, client });
  const targetState = deps.targetState || await resolveTargetState(domain, config, client);
  const manifest = buildPlan(domain, preflight, config, targetState);
  const gapReport = buildGapReport(domain, preflight, config, manifest);
  const state = initializeStateFromManifest(manifest, 'plan');
  const idMap = initializeIdMap(domain);
  const events = buildPlanningEvents(domain, preflight, manifest);

  return {
    exitCode: preflight.blockers.length > 0 ? 3 : 0,
    config,
    domain,
    client,
    preflight,
    targetState,
    manifest,
    gapReport,
    state,
    idMap,
    events,
    outputPaths,
  };
}

function persistPlanningArtifacts(result, options = {}) {
  const {
    preserveRuntimeState = false,
    preserveIdMap = preserveRuntimeState,
  } = options;
  writeJson(result.outputPaths.plan, result.manifest);
  writeJson(result.outputPaths.gapReport, result.gapReport);
  if (!preserveRuntimeState || !fs.existsSync(result.outputPaths.state)) {
    writeJson(result.outputPaths.state, result.state);
  }
  if (!preserveIdMap || !fs.existsSync(result.outputPaths.idMap)) {
    writeJson(result.outputPaths.idMap, result.idMap);
  }
  writeNdjson(result.outputPaths.log, result.events);
}

module.exports = {
  prepareDevelopersWorkflow,
  persistPlanningArtifacts,
};
