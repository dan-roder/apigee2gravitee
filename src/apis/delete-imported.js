'use strict';

const {
  readJsonIfExists,
  writeJson,
  writeNdjson,
} = require('./state-store');
const { prepareApisWorkflow, persistPlanningArtifacts } = require('./workflow');

function makeEvent(type, payload = {}) {
  return { ts: new Date().toISOString(), type, ...payload };
}

async function resolveDeleteTargets(result, idMap) {
  const targets = [];

  for (const proxy of result.domain.proxies) {
    const sourceId = proxy.sourceId;
    const targetId = idMap?.apis?.[sourceId] || null;

    if (targetId) {
      targets.push({
        sourceId,
        proxyName: proxy.proxyName,
        apiId: targetId,
        strategy: 'id-map',
      });
      continue;
    }

    if (typeof result.client.findApiBySourceId === 'function') {
      try {
        const api = await result.client.findApiBySourceId(sourceId);
        if (api?.id) {
          targets.push({
            sourceId,
            proxyName: proxy.proxyName,
            apiId: api.id,
            strategy: 'source-marker',
          });
        }
      } catch (_) {
        // Keep cleanup conservative; ambiguous source markers are skipped.
      }
    }
  }

  return targets;
}

function buildCleanupReport(summary, failures, targets) {
  return {
    generatedAt: new Date().toISOString(),
    summary,
    targets: targets.map((item) => ({
      sourceId: item.sourceId,
      proxyName: item.proxyName,
      apiId: item.apiId,
      strategy: item.strategy,
    })),
    failures,
  };
}

async function runApisDeleteImported(flags, deps = {}) {
  const result = await prepareApisWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result, { preserveRuntimeState: true });

  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const state = readJsonIfExists(result.outputPaths.state) || result.state;
  const events = [...result.events];
  const targets = await resolveDeleteTargets(result, idMap);

  const summary = {
    requested: targets.length,
    deleted: 0,
    skipped: 0,
    failed: 0,
  };
  const failures = [];

  for (const target of targets) {
    if (flags['dry-run']) {
      summary.skipped += 1;
      events.push(makeEvent('cleanup.dry_run', target));
      continue;
    }

    try {
      try {
        await result.client.deleteApi(target.apiId);
      } catch (err) {
        const message = err.body !== undefined
          ? `${err.message}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`
          : err.message;
        const requiresClosedPlans = err.status === 400
          && /must be closed before being able to delete the api/i.test(message);
        if (!requiresClosedPlans) throw err;

        const plans = typeof result.client.listApiPlans === 'function'
          ? await result.client.listApiPlans(target.apiId)
          : [];
        for (const plan of plans) {
          if (!plan?.id) continue;
          if (typeof result.client.closeApiPlan === 'function') {
            await result.client.closeApiPlan(target.apiId, plan.id);
            events.push(makeEvent('cleanup.plan_closed', {
              ...target,
              planId: plan.id,
              planName: plan.name || null,
            }));
          }
        }
        await result.client.deleteApi(target.apiId);
      }
      summary.deleted += 1;
      if (idMap.apis) idMap.apis[target.sourceId] = null;
      if (idMap.plans) idMap.plans[target.sourceId] = {};
      events.push(makeEvent('cleanup.deleted', target));
    } catch (err) {
      if (err.status === 404) {
        summary.skipped += 1;
        if (idMap.apis) idMap.apis[target.sourceId] = null;
        if (idMap.plans) idMap.plans[target.sourceId] = {};
        events.push(makeEvent('cleanup.already_missing', target));
        continue;
      }
      summary.failed += 1;
      const message = err.body !== undefined
        ? `${err.message}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`
        : err.message;
      failures.push({ ...target, error: message });
      events.push(makeEvent('cleanup.failed', { ...target, error: message }));
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

module.exports = { runApisDeleteImported };
