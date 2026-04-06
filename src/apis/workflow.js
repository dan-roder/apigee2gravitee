'use strict';

const fs = require('fs');

const { loadApisConfig, validateApisConfig } = require('./config');
const { loadApiDomain } = require('./api-loader');
const { validateApisPreflight } = require('./preflight-validator');
const { buildPlan, buildGapReport } = require('./report-builder');
const {
  resolveOutputPaths,
  initializeStateFromManifest,
  initializeIdMap,
  writeJson,
  writeNdjson,
} = require('./state-store');
const { GraviteeClient } = require('../shared/gravitee-client');

function makeEvent(type, payload = {}) {
  return { ts: new Date().toISOString(), type, ...payload };
}

async function resolveTargetState(domain, client) {
  const state = {
    apisBySourceId: new Map(),
    apisByName: new Map(),
    plansByApiSourceId: new Map(),
  };
  if (!client) return state;

  let apis = [];
  if (typeof client.listApis === 'function') {
    try {
      apis = await client.listApis();
    } catch (_) {
      apis = [];
    }
  }

  for (const api of apis) {
    if (api?.name) state.apisByName.set(api.name, api);
    const sourceId = api?.definitionContext?.origin?.sourceId || api?.metadata?.sourceId || null;
    if (sourceId) state.apisBySourceId.set(sourceId, api);
  }

  for (const proxy of domain.proxies) {
    const api = state.apisBySourceId.get(proxy.sourceId) || state.apisByName.get(proxy.definition.name);
    if (api && typeof client.listApiPlans === 'function') {
      try {
        state.plansByApiSourceId.set(proxy.sourceId, await client.listApiPlans(api.id));
      } catch (_) {}
    }
  }

  return state;
}

function buildPlanningEvents(domain, preflight, manifest) {
  return [
    makeEvent('preflight.summary', {
      proxies: domain.proxies.length,
      blockers: preflight.blockers.length,
      warnings: preflight.warnings.length,
    }),
    ...preflight.findings.map((finding) => makeEvent(`preflight.${finding.severity}`, finding)),
    ...manifest.actions.map((item) => makeEvent('plan.action', {
      actionId: item.actionId,
      kind: item.kind,
      sourceId: item.sourceId,
      plannedStatus: item.plannedStatus,
      operation: item.operation,
    })),
  ];
}

async function prepareApisWorkflow(flags, deps = {}) {
  const irDir = flags['ir-dir'] || './ir';
  const config = deps.config || loadApisConfig(flags.config, flags);
  const validation = validateApisConfig(config);
  if (!validation.valid) {
    return { exitCode: 1, error: 'Invalid apis config', validationErrors: validation.errors };
  }

  const client = deps.client || new GraviteeClient({
    baseUrl: config.gravitee.url,
    orgId: config.gravitee.orgId,
    envId: config.gravitee.envId,
    token: flags['gravitee-token'] || process.env.GRAVITEE_TOKEN,
    dryRun: !!flags['dry-run'],
  });

  const domain = deps.domain || loadApiDomain(irDir, config);
  const preflight = await validateApisPreflight({ domain, client });
  const targetState = deps.targetState || await resolveTargetState(domain, client);
  const manifest = buildPlan(domain, preflight, targetState);
  const gapReport = buildGapReport(domain, preflight, manifest);
  const state = initializeStateFromManifest(manifest, 'plan');
  const idMap = initializeIdMap(domain);
  const outputPaths = resolveOutputPaths(config);
  const events = buildPlanningEvents(domain, preflight, manifest);

  return {
    exitCode: preflight.blockers.length > 0 ? 3 : 0,
    config,
    client,
    domain,
    preflight,
    targetState,
    manifest,
    gapReport,
    state,
    idMap,
    outputPaths,
    events,
  };
}

function persistPlanningArtifacts(result, options = {}) {
  const { preserveRuntimeState = false } = options;
  writeJson(result.outputPaths.plan, result.manifest);
  writeJson(result.outputPaths.gapReport, result.gapReport);
  if (!preserveRuntimeState || !fs.existsSync(result.outputPaths.state)) {
    writeJson(result.outputPaths.state, result.state);
  }
  if (!preserveRuntimeState || !fs.existsSync(result.outputPaths.idMap)) {
    writeJson(result.outputPaths.idMap, result.idMap);
  }
  writeNdjson(result.outputPaths.log, result.events);
}

module.exports = {
  prepareApisWorkflow,
  persistPlanningArtifacts,
};
