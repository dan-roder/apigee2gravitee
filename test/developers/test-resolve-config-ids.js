'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runResolveDevelopersConfigIds } = require('../../src/developers/resolve-config-ids');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-resolve-config-'));
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
        targetApiId: 'REPLACE_WITH_GRAVITEE_API_ID_FOR_ORDERS_API',
        targetPlan: 'Orders API Key',
        targetPlanId: 'REPLACE_WITH_GRAVITEE_PLAN_ID_FOR_ORDERS_API_KEY',
      },
      'misc-product': [
        {
          targetApi: 'Hello API',
          targetApiId: 'REPLACE_WITH_GRAVITEE_API_ID_FOR_HELLO_API',
          targetPlan: 'Hello API Key',
          targetPlanId: 'REPLACE_WITH_GRAVITEE_PLAN_ID_FOR_HELLO_API_KEY',
        },
        {
          targetApi: 'Facts API',
          targetApiId: 'REPLACE_WITH_GRAVITEE_API_ID_FOR_FACTS_API',
          targetPlan: 'Facts API Key',
          targetPlanId: 'REPLACE_WITH_GRAVITEE_PLAN_ID_FOR_FACTS_API_KEY',
        },
      ],
    },
    reporting: {
      reportDir: './report',
      stateFile: './state/developers-import-state.json',
    },
  };
}

async function testResolveConfigIdsWritesResolvedFile() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.json');
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(), null, 2));

    const client = {
      async findApiByName(name) {
        const apiByName = {
          'Orders API': { id: 'api-orders-1', name },
          'Hello API': { id: 'api-hello-1', name },
          'Facts API': { id: 'api-facts-1', name },
        };
        return apiByName[name] || null;
      },
      async getApi(apiId) {
        return { id: apiId };
      },
      async findPlan(mapping) {
        const key = `${mapping.targetApiId}:${mapping.targetPlan}`;
        const planByKey = {
          'api-orders-1:Orders API Key': { id: 'plan-orders-1', apiId: 'api-orders-1' },
          'api-hello-1:Hello API Key': { id: 'plan-hello-1', apiId: 'api-hello-1' },
          'api-facts-1:Facts API Key': { id: 'plan-facts-1', apiId: 'api-facts-1' },
        };
        return planByKey[key] || null;
      },
    };

    const result = await runResolveDevelopersConfigIds(
      { config: configPath },
      { client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.summary.apiIdsResolved, 3);
    assert.strictEqual(result.summary.planIdsResolved, 3);
    const written = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));
    assert.strictEqual(written.productPlanMap['orders-product'].targetApiId, 'api-orders-1');
    assert.strictEqual(written.productPlanMap['orders-product'].targetPlanId, 'plan-orders-1');
    assert.strictEqual(written.productPlanMap['misc-product'][0].targetApiId, 'api-hello-1');
    assert.strictEqual(written.productPlanMap['misc-product'][1].targetPlanId, 'plan-facts-1');
  });
}

async function testResolveConfigIdsSurfacesUnresolvedMappings() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.json');
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(), null, 2));

    const client = {
      async findApiByName(name) {
        if (name === 'Facts API') return null;
        return { id: `resolved-${name}`, name };
      },
      async getApi(apiId) {
        return { id: apiId };
      },
      async findPlan(mapping) {
        if (mapping.targetApi === 'Hello API') return null;
        return { id: `resolved-${mapping.targetPlan}`, apiId: mapping.targetApiId };
      },
    };

    const result = await runResolveDevelopersConfigIds(
      { config: configPath },
      { client },
    );

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.findings.length > 0);
  });
}

async function run() {
  await testResolveConfigIdsWritesResolvedFile();
  await testResolveConfigIdsSurfacesUnresolvedMappings();
  console.log('test-resolve-config-ids.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
