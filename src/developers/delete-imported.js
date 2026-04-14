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

async function resolveDeleteTargets(result, idMap) {
  const targets = {
    subscriptions: [],
    applications: [],
    users: [],
  };

  for (const subscription of result.domain.subscriptions) {
    const subscriptionId = idMap?.subscriptions?.[subscription.sourceId] || null;
    const applicationId = idMap?.applications?.[`${subscription.developerEmail}/${subscription.appName}`] || null;
    const plan = subscription.planMapping && typeof result.client.findPlan === 'function'
      ? await result.client.findPlan(subscription.planMapping).catch(() => null)
      : null;
    const apiId = plan?.apiId || subscription.planMapping?.targetApiId || null;

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
    const applicationId = idMap?.applications?.[application.sourceId] || null;
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
    const userId = idMap?.users?.[user.sourceId] || null;
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

async function runDevelopersDeleteImported(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result, { preserveRuntimeState: true });

  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const state = readJsonIfExists(result.outputPaths.state) || result.state;
  const events = [...result.events];
  const targets = await resolveDeleteTargets(result, idMap);

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
          const message = closeErr.body !== undefined
            ? `${closeErr.message}: ${typeof closeErr.body === 'string' ? closeErr.body : JSON.stringify(closeErr.body)}`
            : closeErr.message;
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
      const message = err.body !== undefined
        ? `${err.message}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`
        : err.message;
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
      const message = err.body !== undefined
        ? `${err.message}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`
        : err.message;
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
      const message = err.body !== undefined
        ? `${err.message}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`
        : err.message;
      failures.push({ ...target, error: message });
      events.push(makeEvent('cleanup.user.failed', { ...target, error: message }));
    }
  }

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
    },
    exitCode: summary.failed > 0 ? 4 : 0,
  };
}

module.exports = { runDevelopersDeleteImported };
