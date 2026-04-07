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
      await result.client.deleteApi(target.apiId);
      summary.deleted += 1;
      if (idMap.apis) idMap.apis[target.sourceId] = null;
      events.push(makeEvent('cleanup.deleted', target));
    } catch (err) {
      if (err.status === 404) {
        summary.skipped += 1;
        if (idMap.apis) idMap.apis[target.sourceId] = null;
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

module.exports = { runApisDeleteImported };
