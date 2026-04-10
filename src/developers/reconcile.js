'use strict';

const { prepareDevelopersWorkflow, persistPlanningArtifacts } = require('./workflow');
const { buildReconcileReport } = require('./report-builder');
const { readJsonIfExists, writeJson, writeNdjson } = require('./state-store');

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

async function runDevelopersReconcile(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result, { preserveRuntimeState: true });

  const state = readJsonIfExists(result.outputPaths.state) || result.state;
  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const mismatches = [];

  for (const user of result.domain.users) {
    const expectedUserId = idMap.users[user.sourceId];
    const target = await result.client.findUserByEmail(user.email);
    if (user.status !== 'active' && result.config.policies.inactiveDeveloper === 'skip') {
      if (expectedUserId) {
        mismatches.push({ severity: 'blocker', code: 'INACTIVE_USER_SKIP_POLICY_MISMATCH', sourceId: user.sourceId, message: `Inactive user ${user.email} should have been skipped` });
      }
      continue;
    }
    if (!target) {
      mismatches.push({ severity: 'blocker', code: 'USER_MISSING', sourceId: user.sourceId, message: `User ${user.email} is missing` });
      continue;
    }
    if (expectedUserId && target.id !== expectedUserId) {
      mismatches.push({ severity: 'blocker', code: 'USER_ID_MAP_MISMATCH', sourceId: user.sourceId, message: `User ${user.email} resolved to ${target.id} instead of ${expectedUserId}` });
    }
    const roles = await result.client.getUserRoles(target.id, { allowUnsupported: true });
    if (roles) {
      for (const role of [...result.config.roles.organization, ...result.config.roles.environment]) {
        if (!roles.has(role)) {
          mismatches.push({ severity: 'blocker', code: 'USER_ROLE_MISMATCH', sourceId: user.sourceId, message: `User ${user.email} is missing role ${role}` });
        }
      }
    } else {
      mismatches.push({ severity: 'warning', code: 'USER_ROLE_LOOKUP_UNSUPPORTED', sourceId: user.sourceId, message: `User ${user.email} roles could not be read from this Gravitee deployment` });
    }
    if (user.status !== 'active' && !inactivePolicySatisfied(target, result.config.policies.inactiveDeveloper)) {
      mismatches.push({ severity: 'blocker', code: 'INACTIVE_USER_POLICY_MISMATCH', sourceId: user.sourceId, message: `User ${user.email} does not satisfy inactive policy ${result.config.policies.inactiveDeveloper}` });
    }
  }

  for (const application of result.domain.applications) {
    if (application.developerStatus !== 'active' && result.config.policies.inactiveDeveloper === 'skip') {
      if (idMap.applications[application.sourceId]) {
        mismatches.push({ severity: 'blocker', code: 'INACTIVE_APPLICATION_SKIP_POLICY_MISMATCH', sourceId: application.sourceId, message: `Application ${application.appName} should have been skipped` });
      }
      continue;
    }
    const expectedApplicationId = idMap.applications[application.sourceId];
    const target = await result.client.findApplicationByNameAndOwnerHint(application.lookupHints);
    if (!target) {
      mismatches.push({ severity: 'blocker', code: 'APPLICATION_MISSING', sourceId: application.sourceId, message: `Application ${application.appName} is missing` });
      continue;
    }
    if (expectedApplicationId && target.id !== expectedApplicationId) {
      mismatches.push({ severity: 'blocker', code: 'APPLICATION_ID_MAP_MISMATCH', sourceId: application.sourceId, message: `Application ${application.appName} resolved to ${target.id} instead of ${expectedApplicationId}` });
    }
    if (application.lookupHints.sourceId && target.metadata?.sourceId && target.metadata.sourceId !== application.lookupHints.sourceId) {
      mismatches.push({ severity: 'blocker', code: 'APPLICATION_SOURCE_MARKER_MISMATCH', sourceId: application.sourceId, message: `Application ${application.appName} has mismatched source marker ${target.metadata.sourceId}` });
    }
    if (application.ownershipStrategy === 'direct-member') {
      const members = await result.client.listApplicationMembers(target.id);
      const ownerUserId = idMap.users[application.developerEmail];
      const found = members.some((item) => item.id === ownerUserId || item.userId === ownerUserId || item.email === application.developerEmail);
      if (!found) {
        mismatches.push({ severity: 'blocker', code: 'APPLICATION_OWNER_MISMATCH', sourceId: application.sourceId, message: `Application ${application.appName} is missing expected owner membership` });
      }
    }
  }

  for (const subscription of result.domain.subscriptions) {
    if (subscription.recommendedAction === 'SKIP_SUBSCRIPTION') continue;
    if (subscription.developerStatus !== 'active' && result.config.policies.inactiveDeveloper === 'skip') {
      if (idMap.subscriptions[subscription.sourceId]) {
        mismatches.push({ severity: 'blocker', code: 'INACTIVE_SUBSCRIPTION_SKIP_POLICY_MISMATCH', sourceId: subscription.sourceId, message: `Subscription ${subscription.sourceId} should have been skipped` });
      }
      continue;
    }
    const plan = await result.client.findPlan(subscription.planMapping);
    if (!plan) {
      mismatches.push({ severity: 'blocker', code: 'PLAN_UNRESOLVED', sourceId: subscription.sourceId, message: `Target plan could not be resolved for ${subscription.productName}` });
      continue;
    }
    const applicationId = idMap.applications[`${subscription.developerEmail}/${subscription.appName}`];
    const target = await result.client.findSubscription({
      applicationId,
      apiId: plan.apiId || subscription.planMapping.targetApiId || null,
      planId: plan.id,
    });
    if (!target) {
      mismatches.push({ severity: 'blocker', code: 'SUBSCRIPTION_MISSING', sourceId: subscription.sourceId, message: `Subscription ${subscription.sourceId} is missing` });
      continue;
    }
    if (idMap.subscriptions[subscription.sourceId] && target.id !== idMap.subscriptions[subscription.sourceId]) {
      mismatches.push({ severity: 'blocker', code: 'SUBSCRIPTION_ID_MAP_MISMATCH', sourceId: subscription.sourceId, message: `Subscription ${subscription.sourceId} resolved to ${target.id} instead of ${idMap.subscriptions[subscription.sourceId]}` });
    }
    if (target.plan?.id && target.plan.id !== plan.id) {
      mismatches.push({ severity: 'blocker', code: 'SUBSCRIPTION_PLAN_MISMATCH', sourceId: subscription.sourceId, message: `Subscription ${subscription.sourceId} is bound to plan ${target.plan.id} instead of ${plan.id}` });
    }
    if (target.apiId && (plan.apiId || subscription.planMapping.targetApiId) && target.apiId !== (plan.apiId || subscription.planMapping.targetApiId)) {
      mismatches.push({ severity: 'blocker', code: 'SUBSCRIPTION_API_MISMATCH', sourceId: subscription.sourceId, message: `Subscription ${subscription.sourceId} is bound to API ${target.apiId}` });
    }

    if (result.config.policies.apiKeyContinuity === 'fail-if-not-preservable') {
      const apiKeys = await result.client.listSubscriptionApiKeys({
        apiId: plan.apiId || subscription.planMapping.targetApiId || null,
        subscriptionId: target.id,
      });
      const matched = apiKeys.some((item) => item.key === subscription.consumerKey);
      if (!matched) {
        mismatches.push({ severity: 'blocker', code: 'API_KEY_DRIFT', sourceId: subscription.sourceId, message: `Subscription ${subscription.sourceId} failed API key continuity verification` });
      }
    }
  }

  const summary = {
    checkedUsers: result.domain.users.length,
    checkedApplications: result.domain.applications.length,
    checkedSubscriptions: result.domain.subscriptions.length,
    blockers: mismatches.filter((item) => item.severity === 'blocker').length,
    warnings: mismatches.filter((item) => item.severity === 'warning').length,
  };

  const report = buildReconcileReport(summary, mismatches);
  const events = [
    { ts: new Date().toISOString(), type: 'reconcile.summary', ...summary },
    ...mismatches.map((item) => ({ ts: new Date().toISOString(), type: `reconcile.${item.severity}`, ...item })),
  ];

  writeJson(result.outputPaths.reconcileReport, report);
  writeNdjson(result.outputPaths.log, events);

  return {
    ...result,
    state,
    idMap,
    report,
    exitCode: summary.blockers > 0 ? 6 : 0,
  };
}

module.exports = { runDevelopersReconcile };
