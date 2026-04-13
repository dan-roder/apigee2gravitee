'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runConfigureDevelopersRoles, normalizeRoleName, findRoleBySelection } = require('../../src/developers/configure-roles');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-configure-roles-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeConfig() {
  return {
    gravitee: {
      url: 'https://gravitee.example.com',
      orgId: 'DEFAULT',
      envId: 'DEFAULT',
    },
    roles: {
      organization: ['ORGANIZATION:USER'],
      environment: ['ENVIRONMENT:API_CONSUMER'],
    },
    policies: {
      inactiveDeveloper: 'import-and-revoke',
      smtp: 'acknowledged',
      defaultApplication: 'must-be-disabled',
      apiKeyContinuity: 'preserve-if-supported',
      existingUser: 'match-and-reuse',
      existingApplication: 'match-and-reuse',
      userProvisioning: 'reuse-or-create-silently',
    },
    capabilities: {
      silentUserCreation: 'supported',
      apiKeyValuePreservation: 'unknown',
      oauthClientValuePreservation: 'unknown',
      applicationOwnership: 'metadata-only',
    },
    productPlanMap: {
      'orders-product': {
        targetApi: 'orders-api',
        targetApiId: 'api-orders-1',
        targetPlan: 'Orders API Key',
        targetPlanId: 'plan-orders-1',
      },
    },
    customFieldMap: {},
    filters: {
      includeDevelopers: [],
      excludeDevelopers: [],
      includeApps: [],
      excludeApps: [],
    },
    reporting: {
      reportDir: './report',
      stateFile: './state/developers-import-state.json',
    },
  };
}

async function testConfigureRolesWritesSelectedRolesAndIds() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.json');
    writeJson(configPath, makeConfig());

    const client = {
      async listRolesByScope(scope) {
        if (scope === 'ORGANIZATION') {
          return [
            { id: 'org-user-id', name: 'USER' },
            { id: 'org-admin-id', name: 'ADMIN' },
          ];
        }
        return [
          { id: 'env-user-id', name: 'USER' },
          { id: 'env-api-publisher-id', name: 'API_PUBLISHER' },
        ];
      },
    };

    const result = await runConfigureDevelopersRoles({
      config: configPath,
      'organization-role': 'ADMIN',
      'environment-role': '2',
    }, { client });

    assert.strictEqual(result.exitCode, 0);
    const written = readJson(configPath);
    assert.deepStrictEqual(written.roles.organization, ['ORGANIZATION:ADMIN']);
    assert.deepStrictEqual(written.roles.environment, ['ENVIRONMENT:API_PUBLISHER']);
    assert.deepStrictEqual(written.roleAssignmentIds.organization, ['org-admin-id']);
    assert.deepStrictEqual(written.roleAssignmentIds.environment, ['env-api-publisher-id']);
  });
}

function testNormalizeRoleName() {
  assert.strictEqual(normalizeRoleName('user', 'ORGANIZATION'), 'ORGANIZATION:USER');
  assert.strictEqual(normalizeRoleName('ENVIRONMENT:api_consumer', 'ENVIRONMENT'), 'ENVIRONMENT:API_CONSUMER');
}

function testFindRoleBySelectionSupportsNameIdAndIndex() {
  const roles = [
    { id: 'role-1', name: 'USER', scopedName: 'ENVIRONMENT:USER' },
    { id: 'role-2', name: 'API_CONSUMER', scopedName: 'ENVIRONMENT:API_CONSUMER' },
  ];
  assert.strictEqual(findRoleBySelection(roles, 'ENVIRONMENT', '2').id, 'role-2');
  assert.strictEqual(findRoleBySelection(roles, 'ENVIRONMENT', 'API_CONSUMER').id, 'role-2');
  assert.strictEqual(findRoleBySelection(roles, 'ENVIRONMENT', 'role-1').id, 'role-1');
}

async function run() {
  await testConfigureRolesWritesSelectedRolesAndIds();
  testNormalizeRoleName();
  testFindRoleBySelectionSupportsNameIdAndIndex();
  console.log('test-configure-roles.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
