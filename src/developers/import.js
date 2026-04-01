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
const { prepareDevelopersWorkflow, persistPlanningArtifacts } = require('./workflow');

function shouldIncludeAction(action, flags) {
  if (flags['users-only']) {
    return action.kind.includes('USER');
  }
  if (flags['apps-only']) {
    return action.kind.includes('APPLICATION');
  }
  if (flags['subscriptions-only']) {
    return action.kind.includes('PLAN') || action.kind.includes('SUBSCRIPTION');
  }
  return true;
}

function dependenciesSatisfied(action, state) {
  return (action.dependencies || []).every((dependencyId) => (
    ['SUCCEEDED', 'SKIPPED', 'BLOCKED', 'MANUAL_REVIEW'].includes(state.actions[dependencyId]?.status)
  ));
}

function buildImportContext(result) {
  return {
    usersBySourceId: new Map(result.domain.users.map((item) => [item.sourceId, item])),
    appsBySourceId: new Map(result.domain.applications.map((item) => [item.sourceId, item])),
    subscriptionsBySourceId: new Map(result.domain.subscriptions.map((item) => [item.sourceId, item])),
    actionsById: new Map(result.manifest.actions.map((item) => [item.actionId, item])),
  };
}

function persistRuntimeArtifacts(outputPaths, state, idMap, events) {
  writeJson(outputPaths.state, state);
  writeJson(outputPaths.idMap, idMap);
  writeNdjson(outputPaths.log, events);
}

function inactivePolicySatisfied(target, policy) {
  if (!target || !policy || policy === 'skip') return true;
  const status = String(target.status || target.state || '').toLowerCase();
  if (policy === 'import-disabled') {
    return target.enabled === false || ['inactive', 'disabled', 'suspended'].includes(status);
  }
  if (policy === 'import-and-revoke') {
    return target.revoked === true || target.enabled === false || ['revoked', 'inactive', 'disabled', 'suspended'].includes(status);
  }
  return true;
}

async function ensureUser(action, ctx, client, idMap) {
  const user = ctx.usersBySourceId.get(action.sourceId);
  let target = null;
  if (action.operation === 'CREATE') {
    target = await client.createUser({
      email: user.email,
      firstname: user.firstName,
      lastname: user.lastName,
      displayName: user.userName || user.email,
    });
  } else if (action.operation === 'UPDATE') {
    const existing = await client.findUserByEmail(user.email);
    target = await client.updateUser(existing.id, {
      email: user.email,
      firstname: user.firstName,
      lastname: user.lastName,
      displayName: user.userName || user.email,
    });
  } else {
    target = await client.findUserByEmail(user.email);
  }

  const userId = target?.id || target?.userId || null;
  if (userId) {
    await client.assignUserRoles(userId, {
      organization: action.payload.roles.organization,
      environment: action.payload.roles.environment,
    });
    setIdMapValue(idMap, action.kind, action.sourceId, userId);
  }
  return { userId };
}

async function verifyUser(action, ctx, client, idMap) {
  const user = ctx.usersBySourceId.get(action.sourceId);
  const target = await client.findUserByEmail(user.email);
  if (!target) {
    throw new Error(`User ${user.email} was not found`);
  }
  const roles = await client.getUserRoles(target.id);
  for (const role of [...action.payload.expectedRoles.organization, ...action.payload.expectedRoles.environment]) {
    if (!roles.has(role)) throw new Error(`User ${user.email} is missing role ${role}`);
  }
  if (user.status !== 'active' && !inactivePolicySatisfied(target, action.payload.inactivePolicy)) {
    throw new Error(`User ${user.email} does not satisfy inactive policy ${action.payload.inactivePolicy}`);
  }
  setIdMapValue(idMap, action.kind, action.sourceId, target.id);
  return { userId: target.id };
}

async function ensureApplication(action, ctx, client, idMap) {
  const application = ctx.appsBySourceId.get(action.sourceId);
  let target = null;
  if (action.operation === 'CREATE') {
    target = await client.createApplication({
      name: application.appName,
      description: `Migrated application for ${application.developerEmail}`,
      metadata: { developerEmail: application.developerEmail, sourceId: application.sourceId },
    });
  } else if (action.operation === 'UPDATE') {
    const existing = await client.findApplicationByNameAndOwnerHint(action.lookup);
    target = await client.updateApplication(existing.id, {
      name: application.appName,
      description: `Migrated application for ${application.developerEmail}`,
      metadata: { developerEmail: application.developerEmail, sourceId: application.sourceId },
    });
  } else {
    target = await client.findApplicationByNameAndOwnerHint(action.lookup);
  }

  const applicationId = target?.id || target?.applicationId || null;
  if (applicationId && action.payload.ownershipStrategy === 'direct-member') {
    const ownerUserId = idMap.users[application.developerEmail];
    if (ownerUserId) {
      await client.addApplicationMember(applicationId, { user: ownerUserId, role: 'OWNER' });
    }
  }
  if (applicationId) setIdMapValue(idMap, action.kind, action.sourceId, applicationId);
  return { applicationId };
}

async function verifyApplication(action, ctx, client, idMap) {
  const application = ctx.appsBySourceId.get(action.sourceId);
  const target = await client.findApplicationByNameAndOwnerHint(action.lookup);
  if (!target) throw new Error(`Application ${application.appName} was not found`);
  if (action.lookup.sourceId && target.metadata?.sourceId && target.metadata.sourceId !== action.lookup.sourceId) {
    throw new Error(`Application ${application.appName} matched unexpected source marker ${target.metadata.sourceId}`);
  }
  if (action.payload.ownershipStrategy === 'direct-member') {
    const members = await client.listApplicationMembers(target.id);
    const ownerUserId = idMap.users[application.developerEmail];
    const found = members.some((item) => item.id === ownerUserId || item.userId === ownerUserId || item.email === application.developerEmail);
    if (!found) throw new Error(`Application ${application.appName} is missing expected owner membership`);
  }
  setIdMapValue(idMap, action.kind, action.sourceId, target.id);
  return { applicationId: target.id };
}

async function resolvePlan(action, client) {
  const target = await client.findPlan(action.payload);
  if (!target) throw new Error(`Plan could not be resolved for ${action.sourceId}`);
  return { planId: target.id, apiId: target.apiId || action.payload.targetApiId || null };
}

async function ensureSubscription(action, ctx, client, idMap, state) {
  if (action.operation === 'SKIP') return {};

  const planState = state.actions[`RESOLVE_PLAN:${action.sourceId}`];
  const apiId = planState?.targetIds?.apiId;
  const planId = planState?.targetIds?.planId;
  const applicationSourceId = action.lookup.applicationSourceId;
  const applicationId = idMap.applications[applicationSourceId];

  let target = null;
  if (action.operation === 'REUSE') {
    target = await client.findSubscription({ applicationId, apiId, planId });
  } else {
    target = await client.createSubscription({ apiId, applicationId, planId });
  }

  const subscriptionId = target?.id || target?.subscriptionId || null;
  if (subscriptionId) {
    setIdMapValue(idMap, action.kind, action.sourceId, subscriptionId);
  }
  return { subscriptionId, apiId, planId };
}

async function verifySubscription(action, ctx, client, idMap, state) {
  if (state.actions[`UPSERT_SUBSCRIPTION:${action.sourceId}`]?.status === 'SKIPPED') {
    return {};
  }

  const planState = state.actions[`RESOLVE_PLAN:${action.sourceId}`];
  const apiId = planState?.targetIds?.apiId;
  const planId = planState?.targetIds?.planId;
  const applicationId = idMap.applications[action.lookup.applicationSourceId];
  const target = await client.findSubscription({ applicationId, apiId, planId });
  if (!target) throw new Error(`Subscription ${action.sourceId} was not found`);
  if (target.plan?.id && target.plan.id !== planId) {
    throw new Error(`Subscription ${action.sourceId} resolved to unexpected plan ${target.plan.id}`);
  }
  if (target.apiId && apiId && target.apiId !== apiId) {
    throw new Error(`Subscription ${action.sourceId} resolved to unexpected API ${target.apiId}`);
  }

  if (action.payload.apiKeyPolicy === 'fail-if-not-preservable') {
    const apiKeys = await client.listSubscriptionApiKeys({ apiId, subscriptionId: target.id });
    const matched = apiKeys.some((item) => item.key === action.payload.sourceConsumerKey);
    if (!matched) {
      throw new Error(`Subscription ${action.sourceId} does not preserve API key continuity`);
    }
  }

  setIdMapValue(idMap, action.kind, action.sourceId, target.id);
  return { subscriptionId: target.id, apiId };
}

async function executeAction(action, ctx, client, idMap, state) {
  switch (action.kind) {
    case 'UPSERT_USER':
      return ensureUser(action, ctx, client, idMap);
    case 'VERIFY_USER':
      return verifyUser(action, ctx, client, idMap);
    case 'UPSERT_APPLICATION':
      return ensureApplication(action, ctx, client, idMap);
    case 'VERIFY_APPLICATION':
      return verifyApplication(action, ctx, client, idMap);
    case 'RESOLVE_PLAN':
      return resolvePlan(action, client);
    case 'UPSERT_SUBSCRIPTION':
      return ensureSubscription(action, ctx, client, idMap, state);
    case 'VERIFY_SUBSCRIPTION':
      return verifySubscription(action, ctx, client, idMap, state);
    default:
      return {};
  }
}

async function runDevelopersImport(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result, { preserveRuntimeState: !!(flags.resume || flags.force) });

  if (result.preflight.blockers.length > 0 && !flags.force) {
    return {
      ...result,
      exitCode: 3,
    };
  }

  const ctx = buildImportContext(result);
  const savedState = (flags.resume || flags.force) ? readJsonIfExists(result.outputPaths.state) : null;
  const state = mergeSavedActionState(result.state, savedState);
  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const events = [...result.events];
  const maxErrors = Number(flags['max-errors'] || 1);
  let errorCount = 0;

  for (const action of result.manifest.actions) {
    if (!shouldIncludeAction(action, flags)) continue;
    if (!dependenciesSatisfied(action, state)) continue;

    const current = state.actions[action.actionId];
    if (action.plannedStatus === 'BLOCKED') {
      markActionCompleted(state, action.actionId, 'BLOCKED', { lastError: action.blockers.join(', ') || null });
      persistRuntimeArtifacts(result.outputPaths, state, idMap, events);
      continue;
    }
    if (action.plannedStatus === 'SKIPPED' || action.operation === 'SKIP') {
      markActionCompleted(state, action.actionId, 'SKIPPED');
      persistRuntimeArtifacts(result.outputPaths, state, idMap, events);
      continue;
    }
    if (action.manualReviewReasons?.length > 0 && action.plannedStatus !== 'READY') {
      markActionCompleted(state, action.actionId, 'MANUAL_REVIEW', { lastError: action.manualReviewReasons.join(', ') });
      persistRuntimeArtifacts(result.outputPaths, state, idMap, events);
      continue;
    }
    if (flags.resume && !flags.force && current?.status === 'SUCCEEDED') {
      continue;
    }

    try {
      markActionStarted(state, action.actionId);
      const targetIds = await executeAction(action, ctx, result.client, idMap, state);
      markActionCompleted(state, action.actionId, 'SUCCEEDED', { targetIds, reconcileHints: targetIds });
      events.push({ ts: new Date().toISOString(), type: 'import.succeeded', actionId: action.actionId, kind: action.kind });
    } catch (err) {
      errorCount += 1;
      markActionCompleted(state, action.actionId, 'FAILED', { lastError: err.message });
      events.push({ ts: new Date().toISOString(), type: 'import.failed', actionId: action.actionId, kind: action.kind, error: err.message });
      if (errorCount >= maxErrors || action.kind === 'VERIFY_SUBSCRIPTION') {
        break;
      }
    }

    persistRuntimeArtifacts(result.outputPaths, state, idMap, events);
  }

  for (const action of result.manifest.actions) {
    if (state.actions[action.actionId].status === 'PENDING') {
      markActionCompleted(state, action.actionId, 'BLOCKED', {
        lastError: `Dependencies were not satisfied: ${(action.dependencies || []).join(', ') || 'none'}`,
      });
    }
  }

  persistRuntimeArtifacts(result.outputPaths, state, idMap, events);

  const failed = Object.values(state.actions).filter((item) => item.status === 'FAILED').length;
  const blocked = Object.values(state.actions).filter((item) => item.status === 'BLOCKED').length;
  const exitCode = failed > 0 || blocked > 0 ? 4 : 0;

  return {
    ...result,
    state,
    idMap,
    exitCode,
  };
}

module.exports = { runDevelopersImport };
