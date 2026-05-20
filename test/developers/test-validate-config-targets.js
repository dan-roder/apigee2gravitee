'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runValidateDevelopersConfigTargets } = require('../../src/developers/validate-config-targets');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DATA = path.join(PROJECT_ROOT, 'test', 'extractor', 'fixtures', 'data');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-validate-config-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function generateIrFromData(dataDir, irDir) {
  const result = spawnSync(
    'python3',
    ['-m', 'src.extractor.extractor', '--data-dir', dataDir, '--ir-dir', irDir],
    { cwd: PROJECT_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`IR generation failed: ${result.stderr}`);
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function setCredentialAuthHints(irDir, developerEmail, appName, consumerKey, authHints) {
  const credentialPath = path.join(irDir, 'credentials', developerEmail, appName, `${consumerKey}.json`);
  const credential = readJson(credentialPath);
  credential.auth_hints = authHints;
  writeJson(credentialPath, credential);
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
        targetApi: 'Orders API',
        targetPlan: 'Orders API Key',
      },
    },
    reporting: {
      reportDir: './report',
      stateFile: './state/developers-import-state.json',
    },
  };
}

function makeClient() {
  return {
    async listApis() {
      return [
        { id: 'api-orders-1', name: 'Orders API' },
        { id: 'api-hello-1', name: 'Hello API' },
      ];
    },
    async listApiPlans(apiId) {
      const plansByApi = {
        'api-orders-1': [{ id: 'plan-orders-1', name: 'Orders API Key', security: { type: 'API_KEY' }, status: 'PUBLISHED' }],
        'api-hello-1': [{ id: 'plan-hello-1', name: 'Hello API Key', security: { type: 'API_KEY' }, status: 'PUBLISHED' }],
      };
      return plansByApi[apiId] || [];
    },
  };
}

async function testValidateConfigTargetsSucceedsWithExactMatches() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(), null, 2));

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath, 'ir-dir': irDir },
      { client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.report.summary.targets, 1);
    assert.strictEqual(result.report.summary.validTargets, 1);
    assert.deepStrictEqual(result.report.summary.productsWithSingleValidTarget, ['orders-product']);
  });
}

async function testValidateConfigTargetsSupportsAliasMatching() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);
    const config = makeConfig();
    config.productPlanMap['orders-product'] = {
      targetApi: 'Orders Manual Import',
      targetApiAliases: ['Orders API'],
      targetPlan: 'Orders Manual Key',
      targetPlanAliases: ['Orders API Key'],
      matchMode: 'alias',
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath, 'ir-dir': irDir },
      { client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.report.summary.validTargets, 1);
  });
}

async function testValidateConfigTargetsBlocksOnSecurityMismatchForOAuthCredentials() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);
    setCredentialAuthHints(irDir, 'alice@example.com', 'orders-consumer', 'abc123def456', ['OAUTH2']);
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(), null, 2));

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath, 'ir-dir': irDir },
      { client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.report.findings.some((item) => (
      item.severity === 'blocker' && item.code === 'TARGET_PLAN_SECURITY_MISMATCH'
    )));
  });
}

async function testValidateConfigTargetsBlocksOnAmbiguousAndUnsuitablePlans() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);
    const config = makeConfig();
    config.productPlanMap['orders-product'] = {
      targetApi: 'Orders API',
      targetPlan: 'Orders',
      targetPlanAliases: ['Orders API Key', 'Orders Keyless'],
      matchMode: 'alias',
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const client = {
      async listApis() {
        return [{ id: 'api-orders-1', name: 'Orders API' }];
      },
      async listApiPlans() {
        return [
          { id: 'plan-orders-1', name: 'Orders API Key', security: { type: 'API_KEY' }, status: 'CLOSED' },
          { id: 'plan-orders-2', name: 'Orders Keyless', security: { type: 'KEY_LESS' }, status: 'PUBLISHED' },
        ];
      },
    };

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath, 'ir-dir': irDir },
      { client },
    );

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.report.findings.some((item) => item.code === 'TARGET_PLAN_NAME_AMBIGUOUS'));
  });
}

async function testValidateConfigTargetsDowngradesInactiveProductBlockersToWarnings() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const config = makeConfig();
    config.productPlanMap['unused-product'] = {
      targetApi: 'Missing API',
      targetApiId: 'missing-api-id',
      targetPlan: 'Missing Plan',
      targetPlanId: 'missing-plan-id',
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath, 'ir-dir': irDir },
      { client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    const unusedTarget = result.report.targets.find((item) => item.productName === 'unused-product');
    assert.strictEqual(unusedTarget.activeProduct, false);
    assert.strictEqual(unusedTarget.status, 'VALID_WITH_WARNINGS');
    assert.ok(unusedTarget.findings.some((item) => item.code === 'TARGET_API_ID_NOT_FOUND_INACTIVE_PRODUCT'));
  });
}

async function testValidateConfigTargetsSeparatesIntentionalMultiTargetMappingsFromSelection() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const config = makeConfig();
    config.productPlanMap['orders-product'] = [
      {
        targetApi: 'Orders API',
        targetPlan: 'Orders API Key',
      },
      {
        targetApi: 'Hello API',
        targetPlan: 'Hello API Key',
      },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = await runValidateDevelopersConfigTargets(
      { config: configPath, 'ir-dir': irDir },
      { client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(result.report.summary.productsNeedingSelection, []);
    assert.deepStrictEqual(result.report.summary.productsWithMultipleValidTargets, ['orders-product']);
  });
}

async function run() {
  await testValidateConfigTargetsSucceedsWithExactMatches();
  await testValidateConfigTargetsSupportsAliasMatching();
  await testValidateConfigTargetsBlocksOnSecurityMismatchForOAuthCredentials();
  await testValidateConfigTargetsBlocksOnAmbiguousAndUnsuitablePlans();
  await testValidateConfigTargetsDowngradesInactiveProductBlockersToWarnings();
  await testValidateConfigTargetsSeparatesIntentionalMultiTargetMappingsFromSelection();
  console.log('test-validate-config-targets.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
