'use strict';

const { prepareDevelopersWorkflow, persistPlanningArtifacts } = require('./workflow');
const { buildReconcileReport } = require('./report-builder');
const { readJsonIfExists, writeJson, writeNdjson } = require('./state-store');

async function runDevelopersReconcile(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result);

  const state = readJsonIfExists(result.outputPaths.state) || result.state;
  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const mismatches = [];

  for (const user of result.domain.users) {
    const target = await result.client.findUserByEmail(user.email);
    if (!target) {
      mismatches.push({ severity: 'blocker', code: 'USER_MISSING', sourceId: user.sourceId, message: `User ${user.email} is missing` });
      continue;
    }
    const roles = await result.client.getUserRoles(target.id);
    for (const role of [...result.config.roles.organization, ...result.config.roles.environment]) {
      if (!roles.has(role)) {
        mismatches.push({ severity: 'blocker', code: 'USER_ROLE_MISMATCH', sourceId: user.sourceId, message: `User ${user.email} is missing role ${role}` });
      }
    }
  }

  for (const application of result.domain.applications) {
    const target = await result.client.findApplicationByNameAndOwnerHint(application.lookupHints);
    if (!target) {
      mismatches.push({ severity: 'blocker', code: 'APPLICATION_MISSING', sourceId: application.sourceId, message: `Application ${application.appName} is missing` });
      continue;
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
