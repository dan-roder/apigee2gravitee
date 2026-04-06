'use strict';

const fs = require('fs');
const path = require('path');

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

function loadApisConfig(configPath, flags = {}) {
  if (!configPath) {
    throw new Error('--config is required for apis commands');
  }
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`config not found: ${configPath}`);
  }

  const config = clone(readJson(absolutePath));
  config._meta = { path: absolutePath };

  config.gravitee = config.gravitee || {};
  config.reporting = config.reporting || {};
  config.filters = config.filters || {};

  overrideIfPresent(config.gravitee, 'url', flags['gravitee-url']);
  overrideIfPresent(config.gravitee, 'orgId', flags.org);
  overrideIfPresent(config.gravitee, 'envId', flags.env);
  overrideIfPresent(config.reporting, 'reportDir', flags['report-dir']);
  overrideIfPresent(config.reporting, 'stateFile', flags['state-file']);

  return config;
}

function validateString(value, field, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return;
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${field} must contain only non-empty strings`);
      return;
    }
  }
}

function validateApisConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['config must be a JSON object'] };
  }

  validateString(config.gravitee?.url, 'gravitee.url', errors);
  validateString(config.gravitee?.orgId, 'gravitee.orgId', errors);
  validateString(config.gravitee?.envId, 'gravitee.envId', errors);
  validateString(config.reporting?.reportDir, 'reporting.reportDir', errors);
  validateString(config.reporting?.stateFile, 'reporting.stateFile', errors);

  validateStringArray(config.filters?.includeProxies || [], 'filters.includeProxies', errors);
  validateStringArray(config.filters?.excludeProxies || [], 'filters.excludeProxies', errors);

  return { valid: errors.length === 0, errors };
}

module.exports = {
  loadApisConfig,
  validateApisConfig,
};
