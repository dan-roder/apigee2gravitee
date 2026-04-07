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

  if (action.kind === 'UPSERT_PLAN') {
    const api = await result.client.findApiByName(proxy.definition.name);
    if (!api) throw new Error(`API ${proxy.definition.name} was not found before plan import`);
    const planKey = action.payload.planKey;
    const planDefinition = proxy.definition.plans?.[planKey];
    if (!planDefinition) throw new Error(`Plan ${planKey} is not defined for API ${proxy.definition.name}`);

    const existing = await result.client.findApiPlanByName(api.id, planDefinition.name);
    const payload = {
      ...planDefinition,
      name: planDefinition.name,
      description: planDefinition.description,
      security: planDefinition.security,
      flows: Array.isArray(planDefinition.flows) ? planDefinition.flows : [],
      characteristics: planDefinition.characteristics || [],
      commentRequired: !!planDefinition.commentRequired,
      commentMessage: planDefinition.commentMessage || '',
      excludedGroups: planDefinition.excludedGroups || [],
      generalConditions: planDefinition.generalConditions || '',
      mode: planDefinition.mode,
      order: Number.isFinite(planDefinition.order) ? planDefinition.order : 0,
      selectionRule: planDefinition.selectionRule || '',
      status: planDefinition.status,
      tags: planDefinition.tags || [],
      type: planDefinition.type || 'API',
      validation: planDefinition.validation || 'AUTO',
    };

    const plan = existing
      ? await result.client.updateApiPlan(api.id, existing.id, payload)
      : await result.client.createApiPlan(api.id, payload);

    const resolvedPlanId = plan?.id || existing?.id || null;
    setIdMapValue(idMap, action.kind, action.sourceId, { planKey, planId: resolvedPlanId });
    return { apiId: api.id, planId: resolvedPlanId, planKey };
  }

  if (action.kind === 'VERIFY_PLAN') {
    const target = await result.client.findApiByName(proxy.definition.name);
    if (!target) throw new Error(`API ${proxy.definition.name} was not found`);
    const expectedName = action.payload.expectedName;
    const plan = await result.client.findApiPlanByName(target.id, expectedName);
    if (!plan) {
      throw new Error(`API ${proxy.definition.name} is missing plan ${expectedName}`);
    }
    setIdMapValue(idMap, action.kind, action.sourceId, { planKey: action.payload.planKey, planId: plan.id });
    return { apiId: target.id, planId: plan.id, planKey: action.payload.planKey };
  }

  if (action.kind === 'VERIFY_API') {
    const target = await result.client.findApiByName(proxy.definition.name);
    if (!target) throw new Error(`API ${proxy.definition.name} was not found`);
    setIdMapValue(idMap, action.kind, action.sourceId, target.id);
    return { apiId: target.id };
  }

  return {};
}

function formatImportError(err) {
  if (!err) return 'Unknown import error';
  if (Array.isArray(err.attempts)) {
    return err.attempts.map((attempt) => {
      const body = attempt.body === undefined
        ? ''
        : `: ${typeof attempt.body === 'string' ? attempt.body : JSON.stringify(attempt.body)}`;
      return `${attempt.strategy} -> ${attempt.message}${body}`;
    }).join(' | ');
  }
  if (err.body !== undefined) {
    const rendered = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
    return `${err.message}: ${rendered}`;
  }
  return err.message || String(err);
}

function isCompatibilityError(err) {
  if (!err) return false;
  if (err.classification === 'compatibility') return true;
  const message = formatImportError(err).toLowerCase();
  return message.includes('deserialize')
    || message.includes('virtualhosts')
    || message.includes('getproxy()')
    || message.includes('unsupported-endpoint')
    || message.includes('unverified');
}

function markDependentActions(state, manifest, actionId, status, reason) {
  const dependents = manifest.actions.filter((item) => (item.dependencies || []).includes(actionId));
  for (const dependent of dependents) {
    markActionCompleted(state, dependent.actionId, status, { lastError: reason });
  }
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
  const maxErrors = Number.isFinite(Number(flags['max-errors'])) ? Number(flags['max-errors']) : 10;
  let failureCount = 0;

  for (const action of result.manifest.actions) {
    if (flags.resume && !flags.force && state.actions[action.actionId]?.status === 'SUCCEEDED') continue;
    const dependencyStatuses = (action.dependencies || []).map((id) => state.actions[id]?.status);
    if (dependencyStatuses.some((status) => status && status !== 'SUCCEEDED')) {
      const dependencyReason = `dependency not satisfied: ${(action.dependencies || []).map((id) => `${id}=${state.actions[id]?.status || 'UNKNOWN'}`).join(', ')}`;
      const inheritedStatus = dependencyStatuses.some((status) => status === 'MANUAL_REVIEW') ? 'MANUAL_REVIEW' : 'BLOCKED';
      markActionCompleted(state, action.actionId, inheritedStatus, { lastError: dependencyReason });
      events.push({
        ts: new Date().toISOString(),
        type: inheritedStatus === 'MANUAL_REVIEW' ? 'import.manual_review' : 'import.blocked',
        actionId: action.actionId,
        kind: action.kind,
        error: dependencyReason,
      });
      continue;
    }
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
      if (isCompatibilityError(err)) {
        markActionCompleted(state, action.actionId, 'MANUAL_REVIEW', { lastError: detailedError });
        markDependentActions(state, result.manifest, action.actionId, 'MANUAL_REVIEW', `upstream action requires manual review: ${action.actionId}`);
        events.push({
          ts: new Date().toISOString(),
          type: 'import.manual_review',
          actionId: action.actionId,
          kind: action.kind,
          error: detailedError,
        });
      } else {
        failureCount += 1;
        markActionCompleted(state, action.actionId, 'FAILED', { lastError: detailedError });
        markDependentActions(state, result.manifest, action.actionId, 'BLOCKED', `upstream action failed: ${action.actionId}`);
        events.push({ ts: new Date().toISOString(), type: 'import.failed', actionId: action.actionId, kind: action.kind, error: detailedError });
        if (failureCount >= maxErrors) {
          writeJson(result.outputPaths.state, state);
          writeJson(result.outputPaths.idMap, idMap);
          writeNdjson(result.outputPaths.log, events);
          break;
        }
      }
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
