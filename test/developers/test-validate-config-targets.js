'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runValidateDevelopersConfigTargets } = require('../../src/developers/validate-config-targets');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-validate-config-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig() {
  return {
    gravitee: {
      url: 'http://localhost:8083',
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
        targetApi: 'Orders API',
        targetApiId: 'api-orders-1',
        targetPlan: 'Orders API Key',
        targetPlanId: 'plan-orders-1',
      },
      'misc-product': [
        {
          targetApi: 'Hello API',
          targetPlan: 'Hello API Key',
        },
        {
          targetApi: 'Facts API',
          targetPlan: 'Facts API Key',
        },
      ],
    },
    reporting: {
      reportDir: './report',
      stateFile: './state/developers-import-state.json',
    },
  };
}

async function testValidateConfigTargetsSucceeds() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.json');
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(), null, 2));

    const client = {
      async getApi(apiId) {
        return { id: apiId, name: 'Orders API' };
      },
      async findApiByName(name) {
        return { id: `id-${name}`, name };
      },
      async listApiPlans(apiId) {
        const plansByApi = {
          'api-orders-1': [{ id: 'plan-orders-1', name: 'Orders API Key' }],
          'id-Hello API': [{ id: 'plan-hello-1', name: 'Hello API Key' }],
          'id-Facts API': [{ id: 'plan-facts-1', name: 'Facts API Key' }],
        };
        return plansByApi[apiId] || [];
      },
    };

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath },
      { client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.report.summary.targets, 3);
    assert.strictEqual(result.report.summary.validTargets, 3);
    assert.strictEqual(result.report.summary.blockers, 0);
    assert.ok(fs.existsSync(result.outputPath));
  });
}

async function testValidateConfigTargetsDetectsMissingAndAmbiguousMappings() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.json');
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(), null, 2));

    const client = {
      async getApi() {
        throw new Error('not found');
      },
      async findApiByName(name) {
        if (name === 'Hello API') {
          throw new Error('Ambiguous Gravitee API match for Hello API');
        }
        return null;
      },
      async listApiPlans() {
        return [];
      },
    };

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath },
      { client },
    );

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.report.findings.some((item) => item.code === 'TARGET_API_ID_NOT_FOUND'));
    assert.ok(result.report.findings.some((item) => item.code === 'TARGET_API_NAME_AMBIGUOUS'));
    assert.ok(result.report.findings.some((item) => item.code === 'TARGET_API_NAME_NOT_FOUND'));
  });
}

async function run() {
  await testValidateConfigTargetsSucceeds();
  await testValidateConfigTargetsDetectsMissingAndAmbiguousMappings();
  console.log('test-validate-config-targets.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
