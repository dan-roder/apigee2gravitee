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
      found = await client.findUserByEmail(user.email).catch(() => null);
    }
    const previousId = idMap.users?.[user.sourceId] || options.previousUserIds?.[user.sourceId] || null;
    let strategy = 'email';
    if (!found && previousId && typeof client.getUser === 'function') {
      const byPreviousId = await client.getUser(previousId).catch(() => null);
      if (byPreviousId) {
        found = byPreviousId;
        strategy = 'previous-id';
      }
    }
    const item = makeSyncItem('user', user.sourceId, previousId, found?.id || found?.userId || null, strategy, {
      email: user.email,
    });
    items.push(item);
    updateIdMapValue(idMap, 'users', user.sourceId, item.liveId, options);
  }
  return items;
}

async function inspectApplications(domain, client, idMap, options) {
  const items = [];
  for (const application of domain.applications) {
    let found = null;
    if (typeof client.findApplicationByNameAndOwnerHint === 'function') {
      found = await client.findApplicationByNameAndOwnerHint(application.lookupHints).catch(() => null);
    }
    const item = makeSyncItem('application', application.sourceId, idMap.applications?.[application.sourceId], found?.id || null, 'source-marker-or-owner-name', {
      developerEmail: application.developerEmail,
      appName: application.appName,
    });
    items.push(item);
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
      plan = await client.findPlan(subscription.planMapping).catch(() => null);
    }
    if (applicationId && plan && typeof client.findSubscription === 'function') {
      found = await client.findSubscription({
        applicationId,
        apiId: plan.apiId || subscription.planMapping.targetApiId || null,
        planId: plan.id || subscription.planMapping.targetPlanId || null,
      }).catch(() => null);
    }
    const item = makeSyncItem('subscription', subscription.sourceId, idMap.subscriptions?.[subscription.sourceId], found?.id || null, 'application-plan', {
      applicationSourceId,
      applicationId,
      productName: subscription.productName,
      planId: plan?.id || subscription.planMapping.targetPlanId || null,
      apiId: plan?.apiId || subscription.planMapping.targetApiId || null,
    });
    items.push(item);
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
  };
  const users = await inspectUsers(result.domain, result.client, idMap, options);
  const applications = await inspectApplications(result.domain, result.client, idMap, options);
  const subscriptions = await inspectSubscriptions(result.domain, result.client, idMap, options);
  const items = [...users, ...applications, ...subscriptions];
  const report = {
    generatedAt: new Date().toISOString(),
    command: 'developers sync-live-ids',
    wroteIdMap: !!flags['write-id-map'],
    clearMissing: options.clearMissing,
    idMapPath: result.outputPaths.idMap,
    summary: {
      users: summarize(users),
      applications: summarize(applications),
      subscriptions: summarize(subscriptions),
      all: summarize(items),
    },
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
