'use strict';

const {
  readJsonIfExists,
  writeJson,
} = require('./state-store');
const { prepareDevelopersWorkflow } = require('./workflow');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSyncItem(kind, sourceId, previousId, liveId, strategy, details = {}) {
  const status = liveId
    ? (previousId && previousId !== liveId ? 'updated' : 'matched')
    : (previousId ? 'missing-with-existing-id' : 'missing');
  return {
    kind,
    sourceId,
    previousId: previousId || null,
    liveId: liveId || null,
    status,
    strategy,
    ...details,
  };
}

function summarize(items) {
  return items.reduce((acc, item) => {
    acc.total += 1;
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { total: 0 });
}

function formatError(err) {
  if (!err) return null;
  if (err.body !== undefined) {
    const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
    return `${err.message || 'Request failed'}: ${body}`;
  }
  return err.message || String(err);
}

function makeDiagnosticState() {
  return {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    inFlight: null,
    counts: {
      started: 0,
      succeeded: 0,
      failed: 0,
      timedOut: 0,
    },
    operations: [],
  };
}

function maybeWriteCheckpoint(options) {
  if (!options.reportPath) return;
  writeJson(options.reportPath, {
    generatedAt: new Date().toISOString(),
    command: 'developers sync-live-ids',
    status: options.diagnostics.status,
    diagnosticCheckpoint: true,
    diagnostics: options.diagnostics,
    partialSummary: {
      users: summarize(options.partial.users),
      applications: summarize(options.partial.applications),
      subscriptions: summarize(options.partial.subscriptions),
    },
    users: options.partial.users,
    applications: options.partial.applications,
    subscriptions: options.partial.subscriptions,
  });
}

async function runDiagnosticLookup(options, descriptor, fn) {
  const startedAt = new Date();
  const operation = {
    ...descriptor,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    durationMs: null,
    status: 'running',
    error: null,
  };
  options.diagnostics.counts.started += 1;
  options.diagnostics.inFlight = operation;
  options.diagnostics.updatedAt = new Date().toISOString();
  if (options.verbose) {
    console.log(`[sync-live-ids] ${descriptor.phase}.${descriptor.operation}: ${descriptor.sourceId}`);
  }
  maybeWriteCheckpoint(options);

  const timeoutMs = Number(options.timeoutMs || 0);
  let timeoutId = null;
  try {
    const value = timeoutMs > 0
      ? await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const err = new Error(`Lookup exceeded ${timeoutMs}ms`);
            err.code = 'LOOKUP_TIMEOUT';
            reject(err);
          }, timeoutMs);
        }),
      ])
      : await fn();
    operation.status = 'succeeded';
    options.diagnostics.counts.succeeded += 1;
    return value;
  } catch (err) {
    operation.status = err?.code === 'LOOKUP_TIMEOUT' ? 'timed_out' : 'failed';
    operation.error = formatError(err);
    if (operation.status === 'timed_out') {
      options.diagnostics.counts.timedOut += 1;
    } else {
      options.diagnostics.counts.failed += 1;
    }
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    operation.completedAt = new Date().toISOString();
    operation.durationMs = new Date(operation.completedAt).getTime() - startedAt.getTime();
    options.diagnostics.operations.push(operation);
    options.diagnostics.inFlight = null;
    options.diagnostics.updatedAt = new Date().toISOString();
    maybeWriteCheckpoint(options);
  }
}

function updateIdMapValue(idMap, bucket, sourceId, liveId, options) {
  if (liveId) {
    idMap[bucket][sourceId] = liveId;
    return;
  }
  if (options.clearMissing) {
    idMap[bucket][sourceId] = null;
  }
}

async function inspectUsers(domain, client, idMap, options) {
  const items = [];
  for (const user of domain.users) {
    let found = null;
    if (typeof client.findUserByEmail === 'function') {
      found = await runDiagnosticLookup(options, {
        phase: 'users',
        operation: 'findUserByEmail',
        sourceId: user.sourceId,
        email: user.email,
      }, () => client.findUserByEmail(user.email));
    }
    const previousId = idMap.users?.[user.sourceId] || options.previousUserIds?.[user.sourceId] || null;
    let strategy = 'email';
    if (!found && previousId && typeof client.getUser === 'function') {
      const byPreviousId = await runDiagnosticLookup(options, {
        phase: 'users',
        operation: 'getUserByPreviousId',
        sourceId: user.sourceId,
        userId: previousId,
      }, () => client.getUser(previousId));
      if (byPreviousId) {
        found = byPreviousId;
        strategy = 'previous-id';
      }
    }
    const item = makeSyncItem('user', user.sourceId, previousId, found?.id || found?.userId || null, strategy, {
      email: user.email,
    });
    items.push(item);
    options.partial.users.push(item);
    updateIdMapValue(idMap, 'users', user.sourceId, item.liveId, options);
  }
  return items;
}

async function inspectApplications(domain, client, idMap, options) {
  const items = [];
  for (const application of domain.applications) {
    let found = null;
    if (typeof client.findApplicationByNameAndOwnerHint === 'function') {
      found = await runDiagnosticLookup(options, {
        phase: 'applications',
        operation: 'findApplicationByNameAndOwnerHint',
        sourceId: application.sourceId,
        appName: application.appName,
        developerEmail: application.developerEmail,
      }, () => client.findApplicationByNameAndOwnerHint(application.lookupHints));
    }
    const item = makeSyncItem('application', application.sourceId, idMap.applications?.[application.sourceId], found?.id || null, 'source-marker-or-owner-name', {
      developerEmail: application.developerEmail,
      appName: application.appName,
    });
    items.push(item);
    options.partial.applications.push(item);
    updateIdMapValue(idMap, 'applications', application.sourceId, item.liveId, options);
  }
  return items;
}

async function inspectSubscriptions(domain, client, idMap, options) {
  const items = [];
  for (const subscription of domain.subscriptions) {
    if (!subscription.planMapping || subscription.recommendedAction === 'SKIP_SUBSCRIPTION') {
      continue;
    }
    const applicationSourceId = `${subscription.developerEmail}/${subscription.appName}`;
    const applicationId = idMap.applications?.[applicationSourceId] || null;
    let plan = null;
    let found = null;
    if (applicationId && typeof client.findPlan === 'function') {
      plan = await runDiagnosticLookup(options, {
        phase: 'subscriptions',
        operation: 'findPlan',
        sourceId: subscription.sourceId,
        productName: subscription.productName,
      }, () => client.findPlan(subscription.planMapping));
    }
    if (applicationId && plan && typeof client.findSubscription === 'function') {
      found = await runDiagnosticLookup(options, {
        phase: 'subscriptions',
        operation: 'findSubscription',
        sourceId: subscription.sourceId,
        applicationId,
        apiId: plan.apiId || subscription.planMapping.targetApiId || null,
        planId: plan.id || subscription.planMapping.targetPlanId || null,
      }, () => client.findSubscription({
        applicationId,
        apiId: plan.apiId || subscription.planMapping.targetApiId || null,
        planId: plan.id || subscription.planMapping.targetPlanId || null,
      }));
    }
    const item = makeSyncItem('subscription', subscription.sourceId, idMap.subscriptions?.[subscription.sourceId], found?.id || null, 'application-plan', {
      applicationSourceId,
      applicationId,
      productName: subscription.productName,
      planId: plan?.id || subscription.planMapping.targetPlanId || null,
      apiId: plan?.apiId || subscription.planMapping.targetApiId || null,
    });
    items.push(item);
    options.partial.subscriptions.push(item);
    updateIdMapValue(idMap, 'subscriptions', subscription.sourceId, item.liveId, options);
  }
  return items;
}

async function runSyncDevelopersLiveIds(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;

  const idMap = clone(readJsonIfExists(result.outputPaths.idMap) || result.idMap);
  const previousReport = readJsonIfExists(result.outputPaths.liveIdSyncReport) || {};
  const previousUserIds = Object.fromEntries((previousReport.users || [])
    .filter((item) => item?.sourceId && item?.previousId)
    .map((item) => [item.sourceId, item.previousId]));
  idMap.users = idMap.users || {};
  idMap.applications = idMap.applications || {};
  idMap.subscriptions = idMap.subscriptions || {};

  const options = {
    clearMissing: !!flags['clear-missing'],
    previousUserIds,
    verbose: !!(flags.diagnostics || flags.verbose),
    timeoutMs: Number(flags['diagnostic-timeout-ms'] || 0),
    reportPath: result.outputPaths.liveIdSyncReport,
    diagnostics: makeDiagnosticState(),
    partial: {
      users: [],
      applications: [],
      subscriptions: [],
    },
  };
  maybeWriteCheckpoint(options);
  const users = await inspectUsers(result.domain, result.client, idMap, options);
  const applications = await inspectApplications(result.domain, result.client, idMap, options);
  const subscriptions = await inspectSubscriptions(result.domain, result.client, idMap, options);
  const items = [...users, ...applications, ...subscriptions];
  options.diagnostics.status = 'complete';
  options.diagnostics.completedAt = new Date().toISOString();
  options.diagnostics.updatedAt = options.diagnostics.completedAt;
  const report = {
    generatedAt: new Date().toISOString(),
    command: 'developers sync-live-ids',
    status: 'complete',
    wroteIdMap: !!flags['write-id-map'],
    clearMissing: options.clearMissing,
    idMapPath: result.outputPaths.idMap,
    summary: {
      users: summarize(users),
      applications: summarize(applications),
      subscriptions: summarize(subscriptions),
      all: summarize(items),
    },
    diagnostics: options.diagnostics,
    users,
    applications,
    subscriptions,
  };

  writeJson(result.outputPaths.liveIdSyncReport, report);
  if (flags['write-id-map']) {
    idMap.generatedAt = new Date().toISOString();
    idMap.updatedBy = 'developers sync-live-ids';
    writeJson(result.outputPaths.idMap, idMap);
  }

  return {
    ...result,
    idMap,
    report,
    reportPath: result.outputPaths.liveIdSyncReport,
    wroteIdMap: !!flags['write-id-map'],
    exitCode: 0,
  };
}

module.exports = {
  runSyncDevelopersLiveIds,
};
