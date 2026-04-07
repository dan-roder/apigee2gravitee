'use strict';

const {
  readJsonIfExists,
  writeJson,
  writeNdjson,
  mergeSavedActionState,
  markActionStarted,
  markActionCompleted,
  setIdMapValue,
} = require('./state-store');
const { prepareApisWorkflow, persistPlanningArtifacts } = require('./workflow');

async function executeAction(action, result, idMap) {
  const proxy = result.domain.proxies.find((item) => item.sourceId === action.sourceId);
  if (action.kind === 'UPSERT_API') {
    const existing = await result.client.findApiByName(proxy.definition.name);
    const payload = {
      ...proxy.definition,
      crossId: proxy.sourceId,
      definitionContext: {
        origin: {
          sourceId: proxy.sourceId,
          sourceType: 'apigee-proxy',
        },
      },
    };
    delete payload._migrationMeta;

    let api = null;
    if (!existing) {
      api = await result.client.createApi(payload);
    } else {
      api = await result.client.updateApi(existing.id, payload);
    }
    const resolvedId = api?.id || existing?.id || null;
    setIdMapValue(idMap, action.kind, action.sourceId, resolvedId);
    return { apiId: resolvedId };
  }

  if (action.kind === 'VERIFY_API') {
    const target = await result.client.findApiByName(proxy.definition.name);
    if (!target) throw new Error(`API ${proxy.definition.name} was not found`);
    const plans = await result.client.listApiPlans(target.id);
    for (const planName of action.payload.expectedPlans) {
      if (!plans.some((item) => item.name === planName)) {
        throw new Error(`API ${proxy.definition.name} is missing plan ${planName}`);
      }
    }
    setIdMapValue(idMap, action.kind, action.sourceId, target.id);
    return { apiId: target.id };
  }

  return {};
}

function formatImportError(err) {
  if (!err) return 'Unknown import error';
  if (err.body !== undefined) {
    const rendered = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
    return `${err.message}: ${rendered}`;
  }
  return err.message || String(err);
}

async function runApisImport(flags, deps = {}) {
  const result = await prepareApisWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result, { preserveRuntimeState: !!(flags.resume || flags.force) });
  if (result.preflight.blockers.length > 0 && !flags.force) {
    return { ...result, exitCode: 3 };
  }

  const savedState = (flags.resume || flags.force) ? readJsonIfExists(result.outputPaths.state) : null;
  const state = mergeSavedActionState(result.state, savedState);
  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const events = [...result.events];

  for (const action of result.manifest.actions) {
    if (flags.resume && !flags.force && state.actions[action.actionId]?.status === 'SUCCEEDED') continue;
    if (action.plannedStatus === 'BLOCKED') {
      markActionCompleted(state, action.actionId, 'BLOCKED', { lastError: action.blockers.join(', ') || null });
      continue;
    }

    try {
      markActionStarted(state, action.actionId);
      const targetIds = await executeAction(action, result, idMap);
      markActionCompleted(state, action.actionId, 'SUCCEEDED', { targetIds, reconcileHints: targetIds });
      events.push({ ts: new Date().toISOString(), type: 'import.succeeded', actionId: action.actionId, kind: action.kind });
    } catch (err) {
      const detailedError = formatImportError(err);
      markActionCompleted(state, action.actionId, 'FAILED', { lastError: detailedError });
      events.push({ ts: new Date().toISOString(), type: 'import.failed', actionId: action.actionId, kind: action.kind, error: detailedError });
      break;
    }
    writeJson(result.outputPaths.state, state);
    writeJson(result.outputPaths.idMap, idMap);
    writeNdjson(result.outputPaths.log, events);
  }

  writeJson(result.outputPaths.state, state);
  writeJson(result.outputPaths.idMap, idMap);
  writeNdjson(result.outputPaths.log, events);
  const failed = Object.values(state.actions).filter((item) => item.status === 'FAILED').length;
  const blocked = Object.values(state.actions).filter((item) => item.status === 'BLOCKED').length;
  return { ...result, state, idMap, exitCode: failed > 0 || blocked > 0 ? 4 : 0 };
}

module.exports = { runApisImport };
