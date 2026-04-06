'use strict';

function issue(severity, code, message, details = {}) {
  return { severity, code, message, details };
}

function collectRequiredCustomFieldNames(domain, config) {
  const mapped = config.customFieldMap || {};
  const names = new Set();

  for (const user of domain.users) {
    for (const attr of user.attributes) {
      names.add(mapped[attr.name] || attr.name);
    }
  }
  for (const application of domain.applications) {
    for (const attr of application.attributes) {
      names.add(mapped[attr.name] || attr.name);
    }
  }
  return Array.from(names).sort();
}

function checkCompleteness(domain) {
  const findings = [];
  if (!domain.completeness.manifestPresent) {
    findings.push(issue('blocker', 'IR_MANIFEST_MISSING', 'manifest.json is missing'));
  }
  if (!domain.completeness.extractionReportPresent) {
    findings.push(issue('blocker', 'IR_EXTRACTION_REPORT_MISSING', 'extraction-report.json is missing'));
  }
  if (!domain.completeness.subscriptionIntentPresent) {
    findings.push(issue('blocker', 'IR_SUBSCRIPTION_INTENT_MISSING', 'references/subscription-intent.json is missing'));
  }
  if (!domain.completeness.credentialContinuityPresent) {
    findings.push(issue('blocker', 'IR_CREDENTIAL_CONTINUITY_MISSING', 'references/credential-continuity-index.json is missing'));
  }
  if (!domain.completeness.inactiveImpactPresent) {
    findings.push(issue('warning', 'IR_INACTIVE_IMPACT_MISSING', 'references/inactive-impact.json is missing'));
  }
  return findings;
}

function checkProductPlanMappings(domain, config) {
  const findings = [];
  const missing = new Set();
  const multiTarget = new Set();

  for (const subscription of domain.subscriptions) {
    if (!subscription.planMapping) {
      missing.add(subscription.productName);
    }
    if ((subscription.planTargets || []).length > 1) {
      multiTarget.add(subscription.productName);
    }
  }

  for (const productName of Array.from(missing).sort()) {
    findings.push(issue(
      'blocker',
      'PRODUCT_PLAN_MAPPING_MISSING',
      `Missing productPlanMap entry for source product ${productName}`,
      { productName },
    ));
  }

  for (const productName of Array.from(multiTarget).sort()) {
    findings.push(issue(
      'warning',
      'PRODUCT_PLAN_MAPPING_MULTI_TARGET',
      `Source product ${productName} maps to multiple Gravitee API/plan targets`,
      { productName },
    ));
  }

  return findings;
}

function checkCapabilities(config, domain) {
  const findings = [];
  const capabilities = config.capabilities || {};
  const policies = config.policies || {};

  if (policies.userProvisioning === 'reuse-or-create-silently' && capabilities.silentUserCreation !== 'supported') {
    findings.push(issue(
      'blocker',
      'SILENT_USER_CREATION_UNSUPPORTED',
      'Configured user provisioning requires silent user creation, but capabilities.silentUserCreation is not supported',
      { actual: capabilities.silentUserCreation || 'unknown' },
    ));
  }

  if (policies.apiKeyContinuity === 'fail-if-not-preservable') {
    if (capabilities.apiKeyValuePreservation !== 'supported' && domain.credentials.some((credential) => (
      credential.continuity?.riskFlags || []
    ).includes('API_KEY_CONTINUITY_RISK'))) {
      findings.push(issue(
        'blocker',
        'API_KEY_CONTINUITY_UNSUPPORTED',
        'Config requires exact API key continuity, but capabilities.apiKeyValuePreservation is not supported',
        { actual: capabilities.apiKeyValuePreservation || 'unknown' },
      ));
    }
  }

  if (capabilities.applicationOwnership === 'unknown') {
    findings.push(issue(
      'warning',
      'APPLICATION_OWNERSHIP_UNKNOWN',
      'Application ownership support is unknown; ownership may need metadata-only preservation',
    ));
  }

  if (capabilities.oauthClientValuePreservation !== 'supported') {
    findings.push(issue(
      'warning',
      'OAUTH_CLIENT_CONTINUITY_UNKNOWN',
      'OAuth client value preservation is not confirmed as supported',
      { actual: capabilities.oauthClientValuePreservation || 'unknown' },
    ));
  }

  return findings;
}

async function checkTargetAccess(config, client) {
  const findings = [];
  if (!client) {
    findings.push(issue('blocker', 'GRAVITEE_CLIENT_UNAVAILABLE', 'Unable to create Gravitee client'));
    return findings;
  }

  const health = await client.healthCheck();
  if (!health.ok) {
    findings.push(issue(
      'blocker',
      'GRAVITEE_AUTH_FAILED',
      `Gravitee health check failed: ${health.error || 'unknown error'}`,
      { status: health.status || null },
    ));
    return findings;
  }

  if (typeof client.verifyEnvironmentAccess === 'function') {
    const envCheck = await client.verifyEnvironmentAccess();
    if (!envCheck.ok) {
      findings.push(issue(
        'blocker',
        'GRAVITEE_ENV_ACCESS_FAILED',
        envCheck.error || 'Unable to verify organization/environment access',
      ));
    }
  }

  return findings;
}

async function checkRolesAndFields(config, domain, client) {
  const findings = [];
  const roleSet = new Set([
    ...(config.roles?.organization || []),
    ...(config.roles?.environment || []),
  ]);

  let targetRoles = null;
  if (typeof client.listRoles === 'function') {
    try {
      targetRoles = await client.listRoles();
    } catch (err) {
      findings.push(issue('warning', 'ROLE_LOOKUP_FAILED', `Unable to verify roles via Gravitee API: ${err.message}`));
    }
  }

  if (targetRoles) {
    for (const roleName of Array.from(roleSet).sort()) {
      if (!targetRoles.has(roleName)) {
        findings.push(issue(
          'blocker',
          'ROLE_CONFIGURATION_MISSING',
          `Configured role ${roleName} was not found in Gravitee`,
          { roleName },
        ));
      }
    }
  } else {
    findings.push(issue('warning', 'ROLE_LOOKUP_UNVERIFIED', 'Role configuration could not be auto-verified'));
  }

  const requiredCustomFields = collectRequiredCustomFieldNames(domain, config);
  let targetFields = null;
  if (typeof client.listCustomFields === 'function') {
    try {
      targetFields = await client.listCustomFields();
    } catch (err) {
      findings.push(issue('warning', 'CUSTOM_FIELD_LOOKUP_FAILED', `Unable to verify custom fields: ${err.message}`));
    }
  }

  if (targetFields) {
    for (const fieldName of requiredCustomFields) {
      if (!targetFields.has(fieldName)) {
        findings.push(issue(
          'warning',
          'CUSTOM_FIELD_MISSING',
          `Required custom field ${fieldName} was not found in Gravitee`,
          { fieldName },
        ));
      }
    }
  } else if (requiredCustomFields.length > 0) {
    findings.push(issue(
      'warning',
      'CUSTOM_FIELD_LOOKUP_UNVERIFIED',
      'Custom field existence could not be auto-verified',
      { requiredCustomFields },
    ));
  }

  return findings;
}

function pushProbeFindings(findings, prefix, result, options = {}) {
  if (!result) return;
  const checks = result.checks || {};
  for (const [name, check] of Object.entries(checks)) {
    if (!check) continue;
    const unsupportedSeverity = check.required === false
      ? (options.degradedSeverity || 'warning')
      : (options.unsupportedSeverity || 'blocker');
    if (!check.supported) {
      findings.push(issue(
        unsupportedSeverity,
        `${prefix}_${name.toUpperCase()}_UNSUPPORTED`,
        `${options.label || prefix} probe failed for ${name}`,
        { status: check.status || null, classification: check.classification || null, error: check.error || null },
      ));
    } else if (!check.ok) {
      findings.push(issue(
        options.degradedSeverity || 'warning',
        `${prefix}_${name.toUpperCase()}_UNVERIFIED`,
        `${options.label || prefix} probe could not fully verify ${name}`,
        { status: check.status || null, classification: check.classification || null, error: check.error || null },
      ));
    }
  }
}

async function checkCapabilityProbes(config, client) {
  const findings = [];
  if (!client) return findings;

  let userProvisioning = null;
  let applicationOwnership = null;
  let apiKeyContinuity = null;

  if (typeof client.verifyUserProvisioningCapabilities === 'function') {
    userProvisioning = await client.verifyUserProvisioningCapabilities();
    pushProbeFindings(findings, 'USER_PROVISIONING', userProvisioning, { label: 'User provisioning' });
  }

  if (typeof client.verifyApplicationOwnershipCapabilities === 'function') {
    applicationOwnership = await client.verifyApplicationOwnershipCapabilities();
    pushProbeFindings(findings, 'APPLICATION_OWNERSHIP', applicationOwnership, { label: 'Application ownership' });
  }

  if (typeof client.verifyApiKeyContinuityCapabilities === 'function') {
    apiKeyContinuity = await client.verifyApiKeyContinuityCapabilities();
    pushProbeFindings(findings, 'API_KEY_CONTINUITY', apiKeyContinuity, { label: 'API key continuity' });
  }

  if (config.policies?.userProvisioning === 'reuse-or-create-silently' && userProvisioning && !userProvisioning.supported) {
    findings.push(issue(
      'blocker',
      'SILENT_USER_CREATION_PROBE_FAILED',
      'Live Gravitee probes did not confirm silent user provisioning support',
    ));
  }

  if (config.capabilities?.applicationOwnership === 'direct-member' && applicationOwnership && !applicationOwnership.supported) {
    findings.push(issue(
      'blocker',
      'APPLICATION_OWNERSHIP_PROBE_FAILED',
      'Live Gravitee probes did not confirm direct-member application ownership support',
    ));
  }

  if (config.policies?.apiKeyContinuity === 'fail-if-not-preservable' && apiKeyContinuity && !apiKeyContinuity.supported) {
    findings.push(issue(
      'blocker',
      'API_KEY_CONTINUITY_PROBE_FAILED',
      'Live Gravitee probes did not confirm API key continuity support',
    ));
  }

  return findings;
}

async function validateAnalyzePreflight({ config, domain, client }) {
  const findings = [
    ...checkCompleteness(domain),
    ...checkProductPlanMappings(domain, config),
    ...checkCapabilities(config, domain),
    ...(await checkTargetAccess(config, client)),
    ...(await checkCapabilityProbes(config, client)),
    ...(await checkRolesAndFields(config, domain, client)),
  ];

  return {
    findings,
    blockers: findings.filter((item) => item.severity === 'blocker'),
    warnings: findings.filter((item) => item.severity === 'warning'),
  };
}

module.exports = {
  validateAnalyzePreflight,
  collectRequiredCustomFieldNames,
};
