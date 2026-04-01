'use strict';

function addSummaryCount(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function action(actionId, kind, sourceId, payload = {}) {
  return {
    actionId,
    kind,
    sourceId,
    dependencies: [],
    plannedStatus: 'READY',
    operation: 'NOOP',
    desiredState: null,
    lookup: {},
    payload: {},
    continuity: {},
    skipConditions: [],
    failConditions: [],
    blockers: [],
    warnings: [],
    manualReviewReasons: [],
    ...payload,
  };
}

function resolveUserOperation(user, config, targetState) {
  if (user.status !== 'active' && config.policies.inactiveDeveloper === 'skip') {
    return {
      plannedStatus: 'SKIPPED',
      operation: 'SKIP',
      targetId: null,
      skipConditions: ['INACTIVE_DEVELOPER_SKIPPED'],
    };
  }

  const existing = targetState.usersByEmail.get(user.email);
  if (!existing) {
    if (config.policies.userProvisioning === 'reuse-only') {
      return {
        plannedStatus: 'BLOCKED',
        operation: 'BLOCK',
        blockers: ['USER_NOT_FOUND_AND_REUSE_ONLY'],
      };
    }
    return {
      plannedStatus: 'READY',
      operation: 'CREATE',
      targetId: null,
    };
  }

  if (config.policies.existingUser === 'fail-on-existing') {
    return {
      plannedStatus: 'BLOCKED',
      operation: 'BLOCK',
      targetId: existing.id,
      blockers: ['USER_ALREADY_EXISTS'],
    };
  }

  return {
    plannedStatus: 'READY',
    operation: config.policies.existingUser === 'match-and-update' ? 'UPDATE' : 'REUSE',
    targetId: existing.id,
  };
}

function resolveApplicationOperation(application, config, targetState) {
  if (application.developerStatus !== 'active' && config.policies.inactiveDeveloper === 'skip') {
    return {
      plannedStatus: 'SKIPPED',
      operation: 'SKIP',
      targetId: null,
      skipConditions: ['INACTIVE_DEVELOPER_SKIPPED'],
    };
  }

  const existing = targetState.applicationsBySourceId.get(application.sourceId);
  if (!existing) {
    return {
      plannedStatus: 'READY',
      operation: 'CREATE',
      targetId: null,
    };
  }

  if (config.policies.existingApplication === 'fail-on-existing') {
    return {
      plannedStatus: 'BLOCKED',
      operation: 'BLOCK',
      targetId: existing.id,
      blockers: ['APPLICATION_ALREADY_EXISTS'],
    };
  }

  return {
    plannedStatus: 'READY',
    operation: config.policies.existingApplication === 'match-and-update' ? 'UPDATE' : 'REUSE',
    targetId: existing.id,
  };
}

function resolveSubscriptionOperation(subscription, targetState) {
  if (subscription.developerStatus !== 'active' && subscription.inactiveDeveloperPolicy === 'skip') {
    return {
      plannedStatus: 'SKIPPED',
      operation: 'SKIP',
      skipConditions: ['INACTIVE_DEVELOPER_SKIPPED'],
    };
  }

  if (subscription.recommendedAction === 'SKIP_SUBSCRIPTION') {
    return {
      plannedStatus: 'SKIPPED',
      operation: 'SKIP',
      skipConditions: ['SOURCE_STATUS_SKIPS_SUBSCRIPTION'],
    };
  }

  if (!subscription.planMapping) {
    return {
      plannedStatus: 'BLOCKED',
      operation: 'BLOCK',
      blockers: ['PLAN_MAPPING_MISSING'],
    };
  }

  const existing = targetState.subscriptionsBySourceId.get(subscription.sourceId);
  if (existing) {
    return {
      plannedStatus: 'READY',
      operation: 'REUSE',
      targetId: existing.id,
    };
  }

  return {
    plannedStatus: 'READY',
    operation: subscription.recommendedAction === 'CREATE_PENDING_SUBSCRIPTION' ? 'CREATE_PENDING' : 'CREATE',
    targetId: null,
  };
}

function buildPlan(domain, preflight, config, targetState = {
  usersByEmail: new Map(),
  applicationsBySourceId: new Map(),
  plansBySourceId: new Map(),
  subscriptionsBySourceId: new Map(),
  apiKeysBySubscriptionSourceId: new Map(),
}) {
  const actions = [];

  for (const user of domain.users) {
    const resolution = resolveUserOperation(user, config, targetState);
    const upsert = action(`UPSERT_USER:${user.sourceId}`, 'UPSERT_USER', user.sourceId, {
      plannedStatus: resolution.plannedStatus,
      operation: resolution.operation,
      desiredState: user.status,
      lookup: user.lookupHints,
      payload: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        userName: user.userName,
        customFields: user.customFields,
        roles: config.roles,
      },
      continuity: {},
      blockers: [...user.blockers, ...(resolution.blockers || [])],
      warnings: [...user.warnings],
      manualReviewReasons: [...user.manualReviewReasons],
      skipConditions: resolution.skipConditions || [],
      targetHint: resolution.targetId ? { userId: resolution.targetId } : {},
      failConditions: resolution.blockers || [],
    });
    actions.push(upsert);

    const verify = action(`VERIFY_USER:${user.sourceId}`, 'VERIFY_USER', user.sourceId, {
      dependencies: [upsert.actionId],
      plannedStatus: upsert.plannedStatus === 'READY' ? 'READY' : upsert.plannedStatus,
      operation: 'VERIFY',
      lookup: user.lookupHints,
      payload: { expectedRoles: config.roles, inactivePolicy: config.policies.inactiveDeveloper },
      blockers: [...upsert.blockers],
      warnings: [...upsert.warnings],
      manualReviewReasons: [...upsert.manualReviewReasons],
    });
    actions.push(verify);
  }

  for (const application of domain.applications) {
    const resolution = resolveApplicationOperation(application, config, targetState);
    const userDependency = `UPSERT_USER:${application.developerEmail}`;
    const upsert = action(`UPSERT_APPLICATION:${application.sourceId}`, 'UPSERT_APPLICATION', application.sourceId, {
      dependencies: [userDependency],
      plannedStatus: resolution.plannedStatus,
      operation: resolution.operation,
      desiredState: application.status,
      lookup: application.lookupHints,
      payload: {
        name: application.appName,
        ownerEmail: application.developerEmail,
        callbackUrl: application.callbackUrl,
        attributes: application.attributes,
        customFields: application.customFields,
        ownershipStrategy: application.ownershipStrategy,
        apiKeyMode: config.policies.defaultApplication,
      },
      blockers: [...application.blockers, ...(resolution.blockers || [])],
      warnings: [...application.warnings],
      manualReviewReasons: [...application.manualReviewReasons],
      skipConditions: resolution.skipConditions || [],
      targetHint: resolution.targetId ? { applicationId: resolution.targetId } : {},
      failConditions: resolution.blockers || [],
    });
    actions.push(upsert);

    const verify = action(`VERIFY_APPLICATION:${application.sourceId}`, 'VERIFY_APPLICATION', application.sourceId, {
      dependencies: [upsert.actionId],
      plannedStatus: upsert.plannedStatus === 'READY' ? 'READY' : upsert.plannedStatus,
      operation: 'VERIFY',
      lookup: application.lookupHints,
      payload: {
        ownershipStrategy: application.ownershipStrategy,
        ownerEmail: application.developerEmail,
      },
      blockers: [...upsert.blockers],
      warnings: [...upsert.warnings],
      manualReviewReasons: [...upsert.manualReviewReasons],
    });
    actions.push(verify);
  }

  for (const subscription of domain.subscriptions) {
    const appSourceId = `${subscription.developerEmail}/${subscription.appName}`;
    const plan = targetState.plansBySourceId.get(subscription.sourceId);
    const resolution = resolveSubscriptionOperation(subscription, targetState);

    const resolvePlanAction = action(`RESOLVE_PLAN:${subscription.sourceId}`, 'RESOLVE_PLAN', subscription.sourceId, {
      dependencies: [`UPSERT_APPLICATION:${appSourceId}`],
      plannedStatus: subscription.planMapping ? 'READY' : 'BLOCKED',
      operation: plan ? 'REUSE' : 'RESOLVE',
      lookup: subscription.planMapping || {},
      payload: subscription.planMapping || {},
      blockers: subscription.planMapping ? [] : ['PLAN_MAPPING_MISSING'],
      targetHint: plan ? { planId: plan.id, apiId: plan.apiId || subscription.planMapping?.targetApiId || null } : {},
      failConditions: subscription.planMapping ? [] : ['PLAN_MAPPING_MISSING'],
    });
    actions.push(resolvePlanAction);

    const upsertSubscription = action(`UPSERT_SUBSCRIPTION:${subscription.sourceId}`, 'UPSERT_SUBSCRIPTION', subscription.sourceId, {
      dependencies: [`UPSERT_APPLICATION:${appSourceId}`, resolvePlanAction.actionId],
      plannedStatus: resolution.plannedStatus,
      operation: resolution.operation,
      desiredState: subscription.desiredStatus,
      lookup: {
        applicationSourceId: appSourceId,
        productName: subscription.productName,
        credentialId: subscription.credentialId,
      },
      payload: {
        productName: subscription.productName,
        target: subscription.planMapping,
        desiredStatus: subscription.desiredStatus,
      },
      continuity: {
        apiKeyPolicy: config.policies.apiKeyContinuity,
        sourceConsumerKey: subscription.consumerKey,
      },
      blockers: [...subscription.blockers, ...(resolution.blockers || [])],
      warnings: [...subscription.warnings],
      manualReviewReasons: [...subscription.manualReviewReasons],
      skipConditions: resolution.skipConditions || [],
      failConditions: resolution.blockers || [],
      targetHint: resolution.targetId ? { subscriptionId: resolution.targetId } : {},
    });
    actions.push(upsertSubscription);

    const verifySubscription = action(`VERIFY_SUBSCRIPTION:${subscription.sourceId}`, 'VERIFY_SUBSCRIPTION', subscription.sourceId, {
      dependencies: [upsertSubscription.actionId],
      plannedStatus: upsertSubscription.plannedStatus === 'READY' ? 'READY' : upsertSubscription.plannedStatus,
      operation: 'VERIFY',
      lookup: upsertSubscription.lookup,
      payload: {
        desiredStatus: subscription.desiredStatus,
        apiKeyPolicy: config.policies.apiKeyContinuity,
        sourceConsumerKey: subscription.consumerKey,
      },
      continuity: upsertSubscription.continuity,
      blockers: [...upsertSubscription.blockers],
      warnings: [...upsertSubscription.warnings],
      manualReviewReasons: [...upsertSubscription.manualReviewReasons],
    });
    actions.push(verifySubscription);
  }

  const actionsByKind = {};
  const actionsByStatus = {};
  for (const item of actions) {
    addSummaryCount(actionsByKind, item.kind);
    addSummaryCount(actionsByStatus, item.plannedStatus);
  }

  return {
    generatedAt: new Date().toISOString(),
    kind: 'DevelopersMigrationManifest',
    source: {
      irDir: domain.irDir,
      manifestExtractedAt: domain.manifest?.extracted_at || null,
    },
    policies: config.policies,
    capabilities: config.capabilities,
    summary: {
      users: domain.users.length,
      applications: domain.applications.length,
      credentials: domain.credentials.length,
      subscriptions: domain.subscriptions.length,
      blockers: preflight.blockers.length,
      warnings: preflight.warnings.length,
      actions: actions.length,
      actionsByKind,
      actionsByStatus,
    },
    records: {
      users: domain.users,
      applications: domain.applications,
      credentials: domain.credentials,
      subscriptions: domain.subscriptions,
    },
    findings: preflight.findings,
    actions,
  };
}

function buildGapReport(domain, preflight, config, manifest = null) {
  const continuityRisks = domain.credentials
    .filter((credential) => (credential.continuity?.riskFlags || []).length > 0)
    .map((credential) => ({
      credentialId: credential.credentialId,
      riskFlags: credential.continuity.riskFlags,
      authHints: credential.authHints,
      consumerSecretPresent: credential.consumerSecretPresent,
    }));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      users: domain.users.length,
      applications: domain.applications.length,
      credentials: domain.credentials.length,
      subscriptions: domain.subscriptions.length,
      actions: manifest?.actions?.length || 0,
      blockers: preflight.blockers.length,
      warnings: preflight.warnings.length,
      inactiveDevelopers: domain.users.filter((user) => user.status !== 'active').length,
      continuityRiskCount: continuityRisks.length,
    },
    findings: preflight.findings,
    continuityRisks,
    capabilitySnapshot: config.capabilities,
    manifestSummary: manifest?.summary || null,
  };
}

function buildReconcileReport(summary, mismatches) {
  return {
    generatedAt: new Date().toISOString(),
    summary,
    mismatches,
  };
}

module.exports = {
  buildPlan,
  buildGapReport,
  buildReconcileReport,
};
