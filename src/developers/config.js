'use strict';

const fs = require('fs');
const path = require('path');

const ENUMS = {
  inactiveDeveloper: new Set(['skip', 'import-disabled', 'import-and-revoke']),
  smtp: new Set(['acknowledged', 'suppressed', 'live']),
  defaultApplication: new Set(['must-be-disabled', 'allowed']),
  apiKeyContinuity: new Set(['preserve-if-supported', 'accept-regenerated', 'fail-if-not-preservable']),
  oauthClientContinuity: new Set(['preserve-if-supported', 'accept-regenerated', 'fail-if-not-preservable']),
  existingUser: new Set(['match-and-reuse', 'match-and-update', 'fail-on-existing']),
  existingApplication: new Set(['match-and-reuse', 'match-and-update', 'fail-on-existing']),
  userProvisioning: new Set(['reuse-only', 'reuse-or-create-silently', 'allow-invites']),
  supportState: new Set(['supported', 'unsupported', 'unknown']),
  ownershipMode: new Set(['direct-member', 'metadata-only', 'unknown']),
  matchMode: new Set(['id-only', 'exact', 'alias']),
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function overrideIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== '') {
    target[key] = value;
  }
}

function loadDevelopersConfig(configPath, flags = {}) {
  if (!configPath) {
    throw new Error('--config is required for developers commands');
  }
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`config not found: ${configPath}`);
  }

  const config = clone(readJson(absolutePath));
  config._meta = { path: absolutePath };

  config.gravitee = config.gravitee || {};
  config.reporting = config.reporting || {};
  config.policies = config.policies || {};

  overrideIfPresent(config.gravitee, 'url', flags['gravitee-url']);
  overrideIfPresent(config.gravitee, 'orgId', flags['org']);
  overrideIfPresent(config.gravitee, 'envId', flags['env']);
  overrideIfPresent(config.reporting, 'reportDir', flags['report-dir']);
  overrideIfPresent(config.reporting, 'stateFile', flags['state-file']);
  overrideIfPresent(config.policies, 'inactiveDeveloper', flags['inactive-policy']);
  overrideIfPresent(config.policies, 'smtp', flags['smtp-policy']);
  overrideIfPresent(config.policies, 'defaultApplication', flags['default-app-policy']);
  overrideIfPresent(config.policies, 'apiKeyContinuity', flags['api-key-policy']);
  overrideIfPresent(config.policies, 'oauthClientContinuity', flags['oauth-client-policy']);
  overrideIfPresent(config.policies, 'existingUser', flags['existing-user-policy']);
  overrideIfPresent(config.policies, 'existingApplication', flags['existing-app-policy']);

  return config;
}

function validateString(value, field, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function validateStringArray(value, field, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return;
  }
  if (nonEmpty && value.length === 0) {
    errors.push(`${field} must contain at least one value`);
    return;
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${field} must contain only non-empty strings`);
      return;
    }
  }
}

function validateEnum(value, field, allowed, errors) {
  if (!allowed.has(value)) {
    errors.push(`${field} must be one of: ${Array.from(allowed).join(', ')}`);
  }
}

function validatePlanTarget(entry, field, errors) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${field} must be an object`);
    return;
  }
  validateString(entry.targetApi, `${field}.targetApi`, errors);
  validateString(entry.targetPlan, `${field}.targetPlan`, errors);
  if (entry.targetApiId !== undefined) {
    validateString(entry.targetApiId, `${field}.targetApiId`, errors);
  }
  if (entry.targetPlanId !== undefined) {
    validateString(entry.targetPlanId, `${field}.targetPlanId`, errors);
  }
  if (entry.targetApiAliases !== undefined) {
    validateStringArray(entry.targetApiAliases, `${field}.targetApiAliases`, errors);
  }
  if (entry.targetPlanAliases !== undefined) {
    validateStringArray(entry.targetPlanAliases, `${field}.targetPlanAliases`, errors);
  }
  if (entry.matchMode !== undefined) {
    validateEnum(entry.matchMode, `${field}.matchMode`, ENUMS.matchMode, errors);
  }
}

function validateProductPlanMap(map, errors, options = {}) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    errors.push('productPlanMap must be an object');
    return;
  }
  const entries = Object.entries(map);
  for (const [productName, entry] of entries) {
    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        errors.push(`productPlanMap.${productName} must contain at least one target mapping`);
        continue;
      }
      for (let index = 0; index < entry.length; index += 1) {
        validatePlanTarget(entry[index], `productPlanMap.${productName}[${index}]`, errors);
      }
      continue;
    }
    validatePlanTarget(entry, `productPlanMap.${productName}`, errors);
  }
}

function validateCapabilities(capabilities, errors) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    errors.push('capabilities must be an object');
    return;
  }
  validateEnum(capabilities.silentUserCreation, 'capabilities.silentUserCreation', ENUMS.supportState, errors);
  validateEnum(capabilities.apiKeyValuePreservation, 'capabilities.apiKeyValuePreservation', ENUMS.supportState, errors);
  validateEnum(capabilities.oauthClientValuePreservation, 'capabilities.oauthClientValuePreservation', ENUMS.supportState, errors);
  validateEnum(capabilities.applicationOwnership, 'capabilities.applicationOwnership', ENUMS.ownershipMode, errors);
}

function validateRoleAssignmentIds(roleAssignmentIds, errors) {
  if (roleAssignmentIds === undefined) return;
  if (!roleAssignmentIds || typeof roleAssignmentIds !== 'object' || Array.isArray(roleAssignmentIds)) {
    errors.push('roleAssignmentIds must be an object');
    return;
  }
  for (const scope of ['organization', 'environment']) {
    if (roleAssignmentIds[scope] !== undefined) {
      validateStringArray(roleAssignmentIds[scope], `roleAssignmentIds.${scope}`, errors);
    }
  }
}

function validateDevelopersConfig(config, options = {}) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['config must be a JSON object'] };
  }

  const gravitee = config.gravitee || {};
  validateString(gravitee.url, 'gravitee.url', errors);
  validateString(gravitee.orgId, 'gravitee.orgId', errors);
  validateString(gravitee.envId, 'gravitee.envId', errors);

  const roles = config.roles || {};
  validateStringArray(roles.organization, 'roles.organization', errors, { nonEmpty: true });
  validateStringArray(roles.environment, 'roles.environment', errors, { nonEmpty: true });

  const policies = config.policies || {};
  validateEnum(policies.inactiveDeveloper, 'policies.inactiveDeveloper', ENUMS.inactiveDeveloper, errors);
  validateEnum(policies.smtp, 'policies.smtp', ENUMS.smtp, errors);
  validateEnum(policies.defaultApplication, 'policies.defaultApplication', ENUMS.defaultApplication, errors);
  validateEnum(policies.apiKeyContinuity, 'policies.apiKeyContinuity', ENUMS.apiKeyContinuity, errors);
  if (policies.oauthClientContinuity !== undefined) {
    validateEnum(policies.oauthClientContinuity, 'policies.oauthClientContinuity', ENUMS.oauthClientContinuity, errors);
  }
  validateEnum(policies.existingUser, 'policies.existingUser', ENUMS.existingUser, errors);
  validateEnum(policies.existingApplication, 'policies.existingApplication', ENUMS.existingApplication, errors);
  validateEnum(policies.userProvisioning, 'policies.userProvisioning', ENUMS.userProvisioning, errors);

  validateProductPlanMap(config.productPlanMap, errors, options);
  validateCapabilities(config.capabilities, errors);
  validateRoleAssignmentIds(config.roleAssignmentIds, errors);

  if (config.customFieldMap !== undefined && (typeof config.customFieldMap !== 'object' || Array.isArray(config.customFieldMap))) {
    errors.push('customFieldMap must be an object');
  }

  const filters = config.filters || {};
  if (config.filters !== undefined) {
    validateStringArray(filters.includeDevelopers || [], 'filters.includeDevelopers', errors);
    validateStringArray(filters.excludeDevelopers || [], 'filters.excludeDevelopers', errors);
    validateStringArray(filters.includeApps || [], 'filters.includeApps', errors);
    validateStringArray(filters.excludeApps || [], 'filters.excludeApps', errors);
  }

  const reporting = config.reporting || {};
  validateString(reporting.reportDir, 'reporting.reportDir', errors);
  validateString(reporting.stateFile, 'reporting.stateFile', errors);

  return { valid: errors.length === 0, errors };
}

module.exports = {
  loadDevelopersConfig,
  validateDevelopersConfig,
};
