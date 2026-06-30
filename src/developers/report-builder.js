'use strict';

const {
  classifyPlanSecurity,
  evaluatePlanSuitability,
  isPlanStatusSuitable,
  summarizeProductCredentialType,
} = require('./target-matching');

function addSummaryCount(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function addNestedSummaryCount(map, key, nestedKey) {
  map[key] = map[key] || {};
  map[key][nestedKey] = (map[key][nestedKey] || 0) + 1;
}

function isManualReviewFinding(finding) {
  return finding.severity === 'warning' && (
    finding.code.endsWith('_UNVERIFIED') ||
    finding.code.endsWith('_UNKNOWN') ||
    finding.code.includes('LOOKUP_FAILED') ||
    finding.code.includes('LOOKUP_UNVERIFIED') ||
    finding.code.includes('CUSTOM_FIELD_MISSING')
  );
}

function summarizeOperatorActions(actions) {
  const byKind = {};
  const byOperation = {};
  const blockedReasons = {};
  const deferredReasons = {};

  for (const item of actions) {
    if (item.kind.startsWith('VERIFY_') || item.kind === 'RESOLVE_PLAN') continue;
    addNestedSummaryCount(byKind, item.kind, item.operation || item.plannedStatus);
    addSummaryCount(byOperation, item.operation || item.plannedStatus);
    for (const blocker of item.blockers || []) addSummaryCount(blockedReasons, blocker);
    for (const reason of item.deferReasons || []) addSummaryCount(deferredReasons, reason);
  }

  return {
    byKind,
    byOperation,
    blockedReasons,
    deferredReasons,
  };
}

function recommendNextScope(manifest, preflight) {
  if (preflight.blockers.length > 0) return null;
  const actions = manifest.actions || [];
  const hasReadyUsers = actions.some((item) => item.kind === 'UPSERT_USER' && item.plannedStatus === 'READY');
  const hasReadyApps = actions.some((item) => item.kind === 'UPSERT_APPLICATION' && item.plannedStatus === 'READY');
  const hasReadySubscriptions = actions.some((item) => item.kind === 'UPSERT_SUBSCRIPTION' && item.plannedStatus === 'READY');

  if (hasReadyUsers) return '--users-only';
  if (hasReadyApps) return '--apps-only';
  if (hasReadySubscriptions) return '--subscriptions-only';
  return null;
}

function summarizeApplicationMetadata(domain) {
  const inventory = domain.inventories?.['app-attributes']?.attributes || [];
  const selectedAppIds = new Set(domain.applications.map((application) => application.sourceId));
  const selectedAttributes = [];
  const selectedAttributeNames = new Set(domain.applications.flatMap((application) => Object.keys(application.metadata || {})));

  for (const item of inventory) {
    const apps = (item.apps || []).filter((appId) => selectedAppIds.has(appId));
    if (apps.length === 0) continue;
    selectedAttributes.push({
      name: item.name,
      metadataKey: item.name,
      appCount: apps.length,
      occurrenceCount: item.occurrenceCount,
      apps,
      sampleValues: item.sampleValues || [],
      emptyValueCount: item.emptyValueCount || 0,
      nonEmptyValueCount: item.nonEmptyValueCount || 0,
      recommendedAction: item.recommendedAction || null,
      riskFlags: item.riskFlags || [],
    });
  }

  for (const name of selectedAttributeNames) {
    if (!selectedAttributes.some((item) => item.name === name)) {
      const apps = domain.applications
        .filter((application) => Object.prototype.hasOwnProperty.call(application.metadata || {}, name))
        .map((application) => application.sourceId)
        .sort();
      selectedAttributes.push({
        name,
        metadataKey: name,
        appCount: apps.length,
        occurrenceCount: apps.length,
        apps,
        sampleValues: [],
        emptyValueCount: 0,
        nonEmptyValueCount: apps.length,
        recommendedAction: 'MAP_VERBATIM',
        riskFlags: [],
      });
    }
  }

  selectedAttributes.sort((a, b) => a.name.localeCompare(b.name));
  return {
    attributes: selectedAttributes,
    summary: {
      attributeCount: selectedAttributes.length,
      appCount: selectedAppIds.size,
      mappedMetadataKeys: selectedAttributes.map((item) => item.metadataKey),
      riskFlagCounts: selectedAttributes.reduce((acc, item) => {
        for (const flag of item.riskFlags || []) {
          acc[flag] = (acc[flag] || 0) + 1;
        }
        return acc;
      }, {}),
    },
  };
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
      plannedStatus: 'DEFERRED',
      operation: 'DEFER',
      deferReasons: ['PLAN_MAPPING_MISSING'],
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

function resolvePlanBlockers(domain, subscription, plan) {
  if (!subscription.planMapping) return [];
  if (!plan) return [];

  const blockers = [];
  const credentialProfile = summarizeProductCredentialType(domain, subscription.productName);
  const planSecurity = classifyPlanSecurity(plan);
  const suitability = evaluatePlanSuitability(plan, credentialProfile);

  if (planSecurity !== 'unknown' && !suitability.suitable) {
    blockers.push(suitability.advisoryCode || 'TARGET_PLAN_SECURITY_MISMATCH');
  }
  if (!isPlanStatusSuitable(plan)) {
    blockers.push('TARGET_PLAN_STATUS_UNSUITABLE');
  }

  return Array.from(new Set(blockers));
}

function targetIdsUnresolved(mapping) {
  if (!mapping) return false;
  return !mapping.targetApiId
    || !mapping.targetPlanId
    || String(mapping.targetApiId).startsWith('REPLACE_WITH_')
    || String(mapping.targetPlanId).startsWith('REPLACE_WITH_');
}

function resolveSubscriptionDeferralReasons(subscription, plan, planIssues, targetState) {
  const reasons = [];
  if (!subscription.planMapping) reasons.push('PLAN_MAPPING_MISSING');
  if (targetIdsUnresolved(subscription.planMapping)) reasons.push('TARGET_IDS_UNRESOLVED');
  if (
    subscription.planMapping
    && targetState.planLookupAttempted?.has(subscription.sourceId)
    && !plan
  ) {
    reasons.push('TARGET_PLAN_UNAVAILABLE');
  }
  reasons.push(...planIssues);
  return Array.from(new Set(reasons));
}

function buildPlan(domain, preflight, config, targetState = {
  usersByEmail: new Map(),
  applicationsBySourceId: new Map(),
  plansBySourceId: new Map(),
  subscriptionsBySourceId: new Map(),
  apiKeysBySubscriptionSourceId: new Map(),
  planLookupAttempted: new Set(),
  planLookupErrors: new Map(),
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
        roleAssignmentIds: config.roleAssignmentIds || null,
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
        metadata: application.metadata,
        customFields: application.customFields,
        ownershipStrategy: application.ownershipStrategy,
        apiKeyMode: config.policies.defaultApplication,
        expectedNotifications: {
          subscriptionAccepted: config.applicationNotifications?.subscriptionAccepted !== false,
          hooks: config.applicationNotifications?.subscriptionAccepted !== false
            ? ['SUBSCRIPTION_ACCEPTED']
            : [],
        },
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
        expectedMetadata: application.metadata,
        expectedNotifications: {
          subscriptionAccepted: config.applicationNotifications?.subscriptionAccepted !== false,
          hooks: config.applicationNotifications?.subscriptionAccepted !== false
            ? ['SUBSCRIPTION_ACCEPTED']
            : [],
        },
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
    const planBlockers = resolvePlanBlockers(domain, subscription, plan);
    const deferReasons = resolveSubscriptionDeferralReasons(subscription, plan, planBlockers, targetState);
    const planWarnings = plan && planBlockers.includes('TARGET_PLAN_SECURITY_MISMATCH')
      ? [{
        code: 'TARGET_PLAN_SECURITY_MISMATCH',
        message: `Mapped plan security ${classifyPlanSecurity(plan)} is not compatible with ${subscription.productName} credentials.`,
        productName: subscription.productName,
        sourceId: subscription.sourceId,
        targetPlanId: plan.id || subscription.planMapping?.targetPlanId || null,
        targetPlan: plan.name || subscription.planMapping?.targetPlan || null,
      }]
      : [];
    const deferred = deferReasons.length > 0;
    const planResolutionStatus = deferred ? 'DEFERRED' : 'READY';
    const subscriptionStatus = deferred ? 'DEFERRED' : resolution.plannedStatus;
    const subscriptionOperation = deferred ? 'DEFER' : resolution.operation;

    const resolvePlanAction = action(`RESOLVE_PLAN:${subscription.sourceId}`, 'RESOLVE_PLAN', subscription.sourceId, {
      dependencies: [`UPSERT_APPLICATION:${appSourceId}`],
      plannedStatus: planResolutionStatus,
      operation: deferred ? 'DEFER' : (plan ? 'REUSE' : 'RESOLVE'),
      lookup: subscription.planMapping || {},
      payload: {
        ...(subscription.planMapping || {}),
        planSecurity: plan ? classifyPlanSecurity(plan) : null,
      },
      blockers: [],
      deferReasons,
      warnings: planWarnings,
      targetHint: plan ? { planId: plan.id, apiId: plan.apiId || subscription.planMapping?.targetApiId || null } : {},
      failConditions: [],
    });
    actions.push(resolvePlanAction);

    const upsertSubscription = action(`UPSERT_SUBSCRIPTION:${subscription.sourceId}`, 'UPSERT_SUBSCRIPTION', subscription.sourceId, {
      dependencies: [`UPSERT_APPLICATION:${appSourceId}`, resolvePlanAction.actionId],
      plannedStatus: subscriptionStatus,
      operation: subscriptionOperation,
      desiredState: subscription.desiredStatus,
      lookup: {
        applicationSourceId: appSourceId,
        productName: subscription.productName,
        credentialId: subscription.credentialId,
        targetKey: subscription.planMapping?.targetKey || null,
      },
      payload: {
        productName: subscription.productName,
        target: subscription.planMapping,
        desiredStatus: subscription.desiredStatus,
      },
      continuity: {
        apiKeyPolicy: config.policies.apiKeyContinuity,
        sourceConsumerKey: subscription.consumerKey,
        sourceCredentialId: subscription.credentialId,
      },
      blockers: [...subscription.blockers],
      deferReasons,
      warnings: [...subscription.warnings, ...planWarnings],
      manualReviewReasons: [...subscription.manualReviewReasons],
      skipConditions: resolution.skipConditions || [],
      failConditions: [],
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
      deferReasons: [...upsertSubscription.deferReasons],
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
      manualReview: preflight.findings.filter(isManualReviewFinding).length,
      actions: actions.length,
      actionsByKind,
      actionsByStatus,
      operatorActions: summarizeOperatorActions(actions),
      deferredSubscriptions: actions.filter((item) => item.kind === 'UPSERT_SUBSCRIPTION' && item.plannedStatus === 'DEFERRED').length,
      deferredActions: actions.filter((item) => item.plannedStatus === 'DEFERRED').length,
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
    .filter((credential) => (
      (credential.continuity?.riskFlags || []).length > 0
      || credential.consumerSecretPresent
      || credential.protectedSecretMaterialPresent
    ))
    .map((credential) => ({
      credentialId: credential.credentialId,
      riskFlags: credential.continuity?.riskFlags || [],
      authHints: credential.authHints,
      oauthContinuityRelevant: credential.oauthContinuityRelevant,
      consumerSecretPresent: credential.consumerSecretPresent,
      protectedSecretMetaPresent: credential.protectedSecretMetaPresent,
      protectedSecretValuePresent: credential.protectedSecretValuePresent,
      protectedSecretMaterialPresent: credential.protectedSecretMaterialPresent,
      protectedSecretRef: credential.protectedSecretRef,
      continuityClass: credential.oauthContinuityRelevant ? 'oauth-client' : 'api-key',
    }));

  const consumerSecretCount = domain.credentials.filter((credential) => credential.consumerSecretPresent).length;
  const protectedSecretMaterialCount = domain.credentials.filter((credential) => credential.protectedSecretMaterialPresent).length;
  const oauthRelevantSecretCount = domain.credentials.filter((credential) => (
    credential.oauthContinuityRelevant && credential.consumerSecretPresent
  )).length;
  const missingProtectedSecretCount = domain.credentials.filter((credential) => (
    credential.consumerSecretPresent && !credential.protectedSecretMaterialPresent
  )).length;
  const apiKeyContinuityRiskCount = domain.credentials.filter((credential) => (
    !credential.oauthContinuityRelevant
    && ((credential.continuity?.riskFlags || []).includes('API_KEY_CONTINUITY_RISK') || credential.consumerSecretPresent)
  )).length;
  const oauthContinuityRiskCount = domain.credentials.filter((credential) => (
    credential.oauthContinuityRelevant
  )).length;
  const oauthSecretManualReviewCount = preflight.findings.filter((finding) => (
    finding.code === 'OAUTH_CLIENT_SECRET_MANUAL_REVIEW_REQUIRED'
  )).length;

  const manualReviewFindings = preflight.findings.filter(isManualReviewFinding);
  const applicationMetadata = summarizeApplicationMetadata(domain);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      users: domain.users.length,
      applications: domain.applications.length,
      credentials: domain.credentials.length,
      subscriptions: domain.subscriptions.length,
      deferredSubscriptions: manifest?.summary?.deferredSubscriptions || 0,
      deferredActions: manifest?.summary?.deferredActions || 0,
      deferredReasons: manifest?.summary?.operatorActions?.deferredReasons || {},
      actions: manifest?.actions?.length || 0,
      blockers: preflight.blockers.length,
      warnings: preflight.warnings.length,
      manualReview: manualReviewFindings.length,
      inactiveDevelopers: domain.users.filter((user) => user.status !== 'active').length,
      continuityRiskCount: continuityRisks.length,
      apiKeyContinuityRiskCount,
      oauthContinuityRiskCount,
      consumerSecretCount,
      protectedSecretMaterialCount,
      oauthRelevantSecretCount,
      missingProtectedSecretCount,
      oauthSecretManualReviewCount,
      applicationMetadataAttributeCount: applicationMetadata.summary.attributeCount,
    },
    findings: preflight.findings,
    manualReviewFindings,
    continuityRisks,
    applicationMetadata,
    capabilitySnapshot: config.capabilities,
    manifestSummary: manifest?.summary || null,
    operatorGuidance: {
      nextSuggestedScope: manifest ? recommendNextScope(manifest, preflight) : null,
      resumeSafe: preflight.blockers.length === 0,
      blockerCategories: Object.fromEntries(
        preflight.blockers.map((item) => [item.code, (preflight.blockers.filter((entry) => entry.code === item.code).length)]),
      ),
    },
  };
}

function buildReconcileReport(summary, mismatches, diagnostics = {}) {
  return {
    generatedAt: new Date().toISOString(),
    summary,
    mismatches,
    diagnostics,
  };
}

module.exports = {
  buildPlan,
  buildGapReport,
  buildReconcileReport,
  summarizeApplicationMetadata,
};
