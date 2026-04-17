'use strict';

const {
  readJsonIfExists,
  writeJson,
  writeNdjson,
} = require('./state-store');
const { prepareDevelopersWorkflow, persistPlanningArtifacts } = require('./workflow');

function makeEvent(type, payload = {}) {
  return { ts: new Date().toISOString(), type, ...payload };
}

function formatCleanupError(err, resourceLabel = 'resource') {
  if (!err) {
    return `Unknown ${resourceLabel} cleanup error`;
  }

  const code = typeof err.code === 'string' ? err.code : null;
  const message = typeof err.message === 'string' ? err.message.trim() : '';
  const hasBody = err.body !== undefined;
  const bodyText = hasBody
    ? (typeof err.body === 'string' ? err.body : JSON.stringify(err.body))
    : '';

  if (hasBody && message) {
    return `${message}: ${bodyText}`;
  }
  if (hasBody && bodyText) {
    return bodyText;
  }
  if (message) {
    return message;
  }

  if (code && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code)) {
    return `Unable to reach Gravitee while cleaning up ${resourceLabel} (${code}). Verify the management API is running and reachable.`;
  }

  if (code) {
    return `Cleanup failed for ${resourceLabel} (${code}).`;
  }

  return `Unknown ${resourceLabel} cleanup error`;
}

function readActionTargetId(state, actionId, key) {
  return state?.actions?.[actionId]?.targetIds?.[key]
    || state?.actions?.[actionId]?.reconcileHints?.[key]
    || null;
}

async function resolveDeleteTargets(result, idMap, state) {
  const targets = {
    subscriptions: [],
    applications: [],
    users: [],
  };

  for (const subscription of result.domain.subscriptions) {
    const subscriptionId = idMap?.subscriptions?.[subscription.sourceId]
      || readActionTargetId(state, `UPSERT_SUBSCRIPTION:${subscription.sourceId}`, 'subscriptionId')
      || readActionTargetId(state, `VERIFY_SUBSCRIPTION:${subscription.sourceId}`, 'subscriptionId')
      || null;
    const applicationSourceId = `${subscription.developerEmail}/${subscription.appName}`;
    const applicationId = idMap?.applications?.[applicationSourceId]
      || readActionTargetId(state, `UPSERT_APPLICATION:${applicationSourceId}`, 'applicationId')
      || readActionTargetId(state, `VERIFY_APPLICATION:${applicationSourceId}`, 'applicationId')
      || null;
    const plan = subscription.planMapping && typeof result.client.findPlan === 'function'
      ? await result.client.findPlan(subscription.planMapping).catch(() => null)
      : null;
    const apiId = plan?.apiId
      || readActionTargetId(state, `UPSERT_SUBSCRIPTION:${subscription.sourceId}`, 'apiId')
      || readActionTargetId(state, `VERIFY_SUBSCRIPTION:${subscription.sourceId}`, 'apiId')
      || readActionTargetId(state, `RESOLVE_PLAN:${subscription.sourceId}`, 'apiId')
      || subscription.planMapping?.targetApiId
      || null;

    if (subscriptionId && apiId) {
      targets.subscriptions.push({
        sourceId: subscription.sourceId,
        subscriptionId,
        apiId,
        applicationId,
        strategy: 'id-map',
      });
      continue;
    }

    if (!applicationId || !plan || typeof result.client.findSubscription !== 'function') continue;
    try {
      const found = await result.client.findSubscription({
        applicationId,
        apiId: apiId || null,
        planId: plan.id,
      });
      if (found?.id && apiId) {
        targets.subscriptions.push({
          sourceId: subscription.sourceId,
          subscriptionId: found.id,
          apiId,
          applicationId,
          strategy: 'lookup',
        });
      }
    } catch (_) {
      // Keep cleanup conservative; unresolved subscriptions are skipped.
    }
  }

  for (const application of result.domain.applications) {
    const applicationId = idMap?.applications?.[application.sourceId]
      || readActionTargetId(state, `UPSERT_APPLICATION:${application.sourceId}`, 'applicationId')
      || readActionTargetId(state, `VERIFY_APPLICATION:${application.sourceId}`, 'applicationId')
      || null;
    if (applicationId) {
      targets.applications.push({
        sourceId: application.sourceId,
        applicationId,
        developerEmail: application.developerEmail,
        appName: application.appName,
        strategy: 'id-map',
      });
      continue;
    }

    if (typeof result.client.findApplicationByNameAndOwnerHint !== 'function') continue;
    try {
      const found = await result.client.findApplicationByNameAndOwnerHint(application.lookupHints);
      if (found?.id) {
        targets.applications.push({
          sourceId: application.sourceId,
          applicationId: found.id,
          developerEmail: application.developerEmail,
          appName: application.appName,
          strategy: 'lookup',
        });
      }
    } catch (_) {
      // Ambiguous matches are skipped during cleanup.
    }
  }

  for (const user of result.domain.users) {
    const userId = idMap?.users?.[user.sourceId]
      || readActionTargetId(state, `UPSERT_USER:${user.sourceId}`, 'userId')
      || readActionTargetId(state, `VERIFY_USER:${user.sourceId}`, 'userId')
      || null;
    if (userId) {
      targets.users.push({
        sourceId: user.sourceId,
        userId,
        email: user.email,
        strategy: 'id-map',
      });
      continue;
    }

    if (typeof result.client.findUserByEmail !== 'function') continue;
    try {
      const found = await result.client.findUserByEmail(user.email);
      if (found?.id) {
        targets.users.push({
          sourceId: user.sourceId,
          userId: found.id,
          email: user.email,
          strategy: 'lookup',
        });
      }
    } catch (_) {
      // Ambiguous matches are skipped during cleanup.
    }
  }

  return targets;
}

function countTargets(targets) {
  return targets.subscriptions.length + targets.applications.length + targets.users.length;
}

function buildCleanupReport(summary, failures, targets) {
  return {
    generatedAt: new Date().toISOString(),
    summary,
    targets: {
      subscriptions: targets.subscriptions.map((item) => ({
        sourceId: item.sourceId,
        subscriptionId: item.subscriptionId,
        apiId: item.apiId,
        applicationId: item.applicationId,
        strategy: item.strategy,
      })),
      applications: targets.applications.map((item) => ({
        sourceId: item.sourceId,
        applicationId: item.applicationId,
        developerEmail: item.developerEmail,
        appName: item.appName,
        strategy: item.strategy,
      })),
      users: targets.users.map((item) => ({
        sourceId: item.sourceId,
        userId: item.userId,
        email: item.email,
        strategy: item.strategy,
      })),
    },
    failures,
  };
}

async function runDevelopersDeleteImported(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result, { preserveRuntimeState: true });

  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const state = readJsonIfExists(result.outputPaths.state) || result.state;
  const events = [...result.events];
  const targets = await resolveDeleteTargets(result, idMap, state);

  const summary = {
    requested: countTargets(targets),
    deleted: 0,
    skipped: 0,
    failed: 0,
  };
  const failures = [];

  for (const target of targets.subscriptions) {
    if (flags['dry-run']) {
      summary.skipped += 1;
      events.push(makeEvent('cleanup.subscription.dry_run', target));
      continue;
    }
    try {
      if (typeof result.client.deleteSubscription === 'function') {
        await result.client.deleteSubscription({ apiId: target.apiId, subscriptionId: target.subscriptionId });
      } else if (typeof result.client.closeOrPauseSubscription === 'function') {
        await result.client.closeOrPauseSubscription({ apiId: target.apiId, subscriptionId: target.subscriptionId, status: 'CLOSED' });
      }
      idMap.subscriptions[target.sourceId] = null;
      summary.deleted += 1;
      events.push(makeEvent('cleanup.subscription.deleted', target));
    } catch (err) {
      if (err.status === 405 && typeof result.client.closeOrPauseSubscription === 'function') {
        try {
          await result.client.closeOrPauseSubscription({ apiId: target.apiId, subscriptionId: target.subscriptionId, status: 'CLOSED' });
          idMap.subscriptions[target.sourceId] = null;
          summary.deleted += 1;
          events.push(makeEvent('cleanup.subscription.closed', target));
          continue;
        } catch (closeErr) {
          const message = formatCleanupError(closeErr, 'subscription');
          summary.failed += 1;
          failures.push({ ...target, error: message });
          events.push(makeEvent('cleanup.subscription.failed', { ...target, error: message }));
          continue;
        }
      }
      if (err.status === 404) {
        idMap.subscriptions[target.sourceId] = null;
        summary.skipped += 1;
        events.push(makeEvent('cleanup.subscription.already_missing', target));
        continue;
      }
      summary.failed += 1;
      const message = formatCleanupError(err, 'subscription');
      failures.push({ ...target, error: message });
      events.push(makeEvent('cleanup.subscription.failed', { ...target, error: message }));
    }
  }

  for (const target of targets.applications) {
    if (flags['dry-run']) {
      summary.skipped += 1;
      events.push(makeEvent('cleanup.application.dry_run', target));
      continue;
    }
    try {
      await result.client.deleteApplication(target.applicationId);
      idMap.applications[target.sourceId] = null;
      summary.deleted += 1;
      events.push(makeEvent('cleanup.application.deleted', target));
    } catch (err) {
      if (err.status === 404) {
        idMap.applications[target.sourceId] = null;
        summary.skipped += 1;
        events.push(makeEvent('cleanup.application.already_missing', target));
        continue;
      }
      summary.failed += 1;
      const message = formatCleanupError(err, 'application');
      failures.push({ ...target, error: message });
      events.push(makeEvent('cleanup.application.failed', { ...target, error: message }));
    }
  }

  for (const target of targets.users) {
    if (flags['dry-run']) {
      summary.skipped += 1;
      events.push(makeEvent('cleanup.user.dry_run', target));
      continue;
    }
    try {
      await result.client.deleteUser(target.userId);
      idMap.users[target.sourceId] = null;
      summary.deleted += 1;
      events.push(makeEvent('cleanup.user.deleted', target));
    } catch (err) {
      if (err.status === 404) {
        idMap.users[target.sourceId] = null;
        summary.skipped += 1;
        events.push(makeEvent('cleanup.user.already_missing', target));
        continue;
      }
      summary.failed += 1;
      const message = formatCleanupError(err, 'user');
      failures.push({ ...target, error: message });
      events.push(makeEvent('cleanup.user.failed', { ...target, error: message }));
    }
  }

  const cleanupReport = buildCleanupReport(summary, failures, targets);

  writeJson(result.outputPaths.cleanupReport, cleanupReport);
  writeJson(result.outputPaths.idMap, idMap);
  writeJson(result.outputPaths.state, state);
  writeNdjson(result.outputPaths.log, events);

  return {
    ...result,
    idMap,
    state,
    cleanup: {
      summary,
      failures,
      targets,
      report: cleanupReport,
    },
    exitCode: summary.failed > 0 ? 4 : 0,
  };
}

module.exports = { runDevelopersDeleteImported, formatCleanupError };
