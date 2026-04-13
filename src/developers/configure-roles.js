'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { GraviteeClient } = require('../shared/gravitee-client');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultOutputPath(configPath, flags) {
  if (flags['in-place']) return path.resolve(configPath);
  if (flags['output-config']) return path.resolve(flags['output-config']);
  return path.resolve(configPath);
}

function normalizeRoleName(roleName, scope) {
  const scopedPrefix = `${String(scope || '').toUpperCase()}:`;
  const value = String(roleName || '').trim();
  if (!value) return '';
  if (value.toUpperCase().startsWith(scopedPrefix)) return value.toUpperCase();
  return `${scopedPrefix}${value.toUpperCase()}`;
}

function findRoleBySelection(roles, scope, selection) {
  if (!selection) return null;
  const normalized = String(selection).trim();
  if (!normalized) return null;

  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= roles.length) {
    return roles[asNumber - 1];
  }

  const scopedName = normalizeRoleName(normalized, scope);
  return roles.find((role) => (
    role.id === normalized
      || normalizeRoleName(role.name, scope) === scopedName
  )) || null;
}

function buildRoleChoices(roles, scope, currentRole) {
  return roles.map((role, index) => ({
    index: index + 1,
    id: role.id,
    name: role.name,
    scopedName: normalizeRoleName(role.name, scope),
    isCurrent: normalizeRoleName(role.name, scope) === normalizeRoleName(currentRole, scope),
  }));
}

async function promptForRole(scope, choices, currentRole, promptImpl) {
  const scopeLabel = scope.toLowerCase();
  const currentLabel = currentRole ? ` [current: ${normalizeRoleName(currentRole, scope)}]` : '';
  const lines = [
    `${scope} roles:`,
    ...choices.map((choice) => `  ${choice.index}. ${choice.scopedName} (${choice.id})${choice.isCurrent ? ' [current]' : ''}`),
  ];
  const question = `${lines.join('\n')}\nChoose the default ${scopeLabel} role by number, name, or role id${currentLabel}: `;
  const answer = await promptImpl(question);
  const selected = findRoleBySelection(choices, scope, answer);
  if (!selected) {
    throw new Error(`Invalid ${scopeLabel} role selection: ${answer}`);
  }
  return selected;
}

async function withPrompt(flags, handler) {
  if (typeof flags.__prompt === 'function') {
    return handler(flags.__prompt);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await handler((question) => rl.question(question));
  } finally {
    rl.close();
  }
}

async function runConfigureDevelopersRoles(flags, deps = {}) {
  const configPath = flags.config;
  if (!configPath) {
    return { exitCode: 1, error: '--config is required' };
  }

  const config = deps.config || loadDevelopersConfig(configPath, flags);
  const validation = validateDevelopersConfig(config);
  if (!validation.valid) {
    return {
      exitCode: 1,
      validationErrors: validation.errors,
    };
  }

  const client = deps.client || new GraviteeClient({
    baseUrl: config.gravitee.url,
    orgId: config.gravitee.orgId,
    envId: config.gravitee.envId,
    token: flags['gravitee-token'] || process.env.GRAVITEE_TOKEN,
    dryRun: false,
  });

  const organizationRoles = buildRoleChoices(
    await client.listRolesByScope('ORGANIZATION'),
    'ORGANIZATION',
    config.roles?.organization?.[0],
  );
  const environmentRoles = buildRoleChoices(
    await client.listRolesByScope('ENVIRONMENT'),
    'ENVIRONMENT',
    config.roles?.environment?.[0],
  );

  if (organizationRoles.length === 0) {
    return { exitCode: 2, error: 'No organization roles were returned by Gravitee' };
  }
  if (environmentRoles.length === 0) {
    return { exitCode: 2, error: 'No environment roles were returned by Gravitee' };
  }

  const configuredConfig = clone(config);
  delete configuredConfig._meta;

  let selectedOrganization = findRoleBySelection(organizationRoles, 'ORGANIZATION', flags['organization-role']);
  let selectedEnvironment = findRoleBySelection(environmentRoles, 'ENVIRONMENT', flags['environment-role']);

  if (!selectedOrganization || !selectedEnvironment) {
    const prompted = await withPrompt(flags, async (promptImpl) => {
      const orgRole = selectedOrganization || await promptForRole(
        'ORGANIZATION',
        organizationRoles,
        configuredConfig.roles?.organization?.[0],
        promptImpl,
      );
      const envRole = selectedEnvironment || await promptForRole(
        'ENVIRONMENT',
        environmentRoles,
        configuredConfig.roles?.environment?.[0],
        promptImpl,
      );
      return { orgRole, envRole };
    });
    selectedOrganization = selectedOrganization || prompted.orgRole;
    selectedEnvironment = selectedEnvironment || prompted.envRole;
  }

  configuredConfig.roles = configuredConfig.roles || {};
  configuredConfig.roleAssignmentIds = configuredConfig.roleAssignmentIds || {};
  configuredConfig.roles.organization = [selectedOrganization.scopedName];
  configuredConfig.roles.environment = [selectedEnvironment.scopedName];
  configuredConfig.roleAssignmentIds.organization = selectedOrganization.id ? [selectedOrganization.id] : [];
  configuredConfig.roleAssignmentIds.environment = selectedEnvironment.id ? [selectedEnvironment.id] : [];

  const outputPath = defaultOutputPath(configPath, flags);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(configuredConfig, null, 2)}\n`);

  return {
    exitCode: 0,
    outputPath,
    selections: {
      organization: selectedOrganization,
      environment: selectedEnvironment,
    },
    roles: {
      organization: organizationRoles,
      environment: environmentRoles,
    },
    config: configuredConfig,
  };
}

module.exports = {
  runConfigureDevelopersRoles,
  normalizeRoleName,
  findRoleBySelection,
};
