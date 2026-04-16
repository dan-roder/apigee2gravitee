'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSyncDevelopersApiTargets, derivePlanKey } = require('../../src/developers/sync-api-targets');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-sync-targets-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig(baseDir) {
  return {
    gravitee: {
      url: 'https://gravitee.example.com',
      orgId: 'DEFAULT',
      envId: 'DEFAULT',
    },
    roles: {
      organization: ['ORGANIZATION:USER'],
      environment: ['ENVIRONMENT:USER'],
    },
    policies: {
      inactiveDeveloper: 'import-and-revoke',
      smtp: 'acknowledged',
      defaultApplication: 'must-be-disabled',
      apiKeyContinuity: 'preserve-if-supported',
      oauthClientContinuity: 'preserve-if-supported',
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
        targetPlan: 'API Key Plan',
      },
      'misc-product': [
        {
          targetApi: 'hello-api',
          targetPlan: 'Keyless Plan',
        },
      ],
    },
    reporting: {
      reportDir: path.join(baseDir, 'report'),
      stateFile: path.join(baseDir, 'state', 'developers-import-state.json'),
    },
    filters: {
      includeDevelopers: [],
      excludeDevelopers: [],
      includeApps: [],
      excludeApps: [],
    },
  };
}

async function testDerivePlanKeyNormalizesPlanNames() {
  assert.strictEqual(derivePlanKey('API Key Plan'), 'API_KEY');
  assert.strictEqual(derivePlanKey('Keyless Plan'), 'KEYLESS');
}

async function testSyncApiTargetsUpdatesIdsFromApisIdMap() {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const configPath = path.join(dir, 'developers.config.json');
    writeJson(configPath, config);
    const apisIdMapPath = path.join(dir, 'state', 'apis-id-map.json');
    writeJson(apisIdMapPath, {
      generatedAt: new Date().toISOString(),
      apis: {
        'orders-api': 'api-orders-1',
        'hello-api': 'api-hello-1',
      },
      plans: {
        'orders-api': {
          API_KEY: 'plan-orders-1',
        },
        'hello-api': {
          KEYLESS: 'plan-hello-1',
        },
      },
    });

    const result = await runSyncDevelopersApiTargets({
      config: configPath,
      'apis-id-map': apisIdMapPath,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.summary.apiIdsUpdated, 2);
    assert.strictEqual(result.summary.planIdsUpdated, 2);
    assert.strictEqual(result.outputPath, path.join(dir, 'developers.config.resolved.json'));
    assert.ok(result.reportPath.endsWith(path.join('report', 'developers-sync-api-targets-report.json')));
    assert.strictEqual(result.config.productPlanMap['orders-product'].targetApiId, 'api-orders-1');
    assert.strictEqual(result.config.productPlanMap['orders-product'].targetPlanId, 'plan-orders-1');
    assert.strictEqual(result.config.productPlanMap['misc-product'][0].targetApiId, 'api-hello-1');
    assert.strictEqual(result.config.productPlanMap['misc-product'][0].targetPlanId, 'plan-hello-1');
    assert.strictEqual(result.config._meta.syncApiTargets.apisIdMapPath, apisIdMapPath);
    assert.strictEqual(result.report.summary.targets, 2);
    assert.ok(fs.existsSync(result.reportPath));
  });
}

async function testSyncApiTargetsKeepsResolvedPathStableWhenRefreshingResolvedConfig() {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const configPath = path.join(dir, 'developers.config.resolved.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const apisIdMapPath = path.join(dir, 'state', 'apis-id-map.json');
    writeJson(apisIdMapPath, {
      generatedAt: new Date().toISOString(),
      apis: {
        'orders-api': 'api-orders-1',
        'hello-api': 'api-hello-1',
      },
      plans: {
        'orders-api': {
          API_KEY: 'plan-orders-1',
        },
        'hello-api': {
          KEYLESS: 'plan-hello-1',
        },
      },
    });

    const result = await runSyncDevelopersApiTargets({
      config: configPath,
      'apis-id-map': apisIdMapPath,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.outputPath, configPath);
    assert.ok(!result.outputPath.endsWith('.synced.json'));
  });
}

async function run() {
  await testDerivePlanKeyNormalizesPlanNames();
  await testSyncApiTargetsUpdatesIdsFromApisIdMap();
  await testSyncApiTargetsKeepsResolvedPathStableWhenRefreshingResolvedConfig();
  console.log('test-sync-api-targets.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
