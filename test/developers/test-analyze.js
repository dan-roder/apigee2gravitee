'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runDevelopersAnalyze } = require('../../src/developers/analyze');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DATA = path.join(PROJECT_ROOT, 'test', 'extractor', 'fixtures', 'data');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-analyze-'));
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

function makeConfig(baseDir, overrides = {}) {
  const reportDir = path.join(baseDir, 'report');
  const stateFile = path.join(baseDir, 'state', 'developers-import-state.json');
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
        targetApiId: 'api_orders_123',
        targetPlan: 'Orders API Key',
        targetPlanId: 'plan_orders_key_123',
      },
    },
    customFieldMap: {
      team: 'team',
      environment: 'environment',
    },
    filters: {
      includeDevelopers: [],
      excludeDevelopers: [],
      includeApps: [],
      excludeApps: [],
    },
    reporting: {
      reportDir,
      stateFile,
    },
    ...overrides,
  };
}

function makeClient(overrides = {}) {
  return {
    async healthCheck() { return { ok: true }; },
    async verifyEnvironmentAccess() { return { ok: true }; },
    async listRoles() { return new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']); },
    async listCustomFields() { return new Set(['team', 'environment']); },
    ...overrides,
  };
}

async function testAnalyzeSucceedsAndWritesOutputs() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const config = makeConfig(dir);
    const result = await runDevelopersAnalyze(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.plan.summary.users, 1);
    assert.strictEqual(result.plan.summary.subscriptions, 1);
    assert.ok(fs.existsSync(result.outputPaths.plan));
    assert.ok(fs.existsSync(result.outputPaths.gapReport));
    assert.ok(fs.existsSync(result.outputPaths.state));
    assert.ok(fs.existsSync(result.outputPaths.idMap));
    assert.ok(fs.existsSync(result.outputPaths.log));
  });
}

async function testAnalyzeFailsWhenProductMappingMissing() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const config = makeConfig(dir, { productPlanMap: {} });
    const result = await runDevelopersAnalyze(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 1);
  });
}

async function testAnalyzeFailsWhenSilentUserCreationUnsupported() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const config = makeConfig(dir, {
      capabilities: {
        silentUserCreation: 'unsupported',
        apiKeyValuePreservation: 'unknown',
        oauthClientValuePreservation: 'unknown',
        applicationOwnership: 'metadata-only',
      },
    });

    const result = await runDevelopersAnalyze(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 3);
    assert.ok(result.preflight.blockers.some((item) => item.code === 'SILENT_USER_CREATION_UNSUPPORTED'));
  });
}

async function testAnalyzeFlagsMissingCustomFields() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const config = makeConfig(dir);
    const result = await runDevelopersAnalyze(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client: makeClient({ listCustomFields: async () => new Set(['team']) }) },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.preflight.warnings.some((item) => item.code === 'CUSTOM_FIELD_MISSING'));
  });
}

async function testAnalyzeSurfacesAmbiguousProbeAsManualReview() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const config = makeConfig(dir);
    const result = await runDevelopersAnalyze(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      {
        config,
        client: makeClient({
          async verifyApplicationOwnershipCapabilities() {
            return {
              ok: true,
              supported: true,
              checks: {
                list: { ok: true, supported: true, status: 200 },
                create: { ok: true, supported: true, status: 200 },
                addMember: { ok: false, supported: true, status: 405, required: false, classification: 'method-not-allowed' },
              },
            };
          },
        }),
      },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.gapReport.summary.manualReview > 0);
    assert.ok(result.gapReport.manualReviewFindings.some((item) => item.code === 'APPLICATION_OWNERSHIP_ADDMEMBER_UNVERIFIED'));
    assert.strictEqual(result.gapReport.operatorGuidance.nextSuggestedScope, '--users-only');
  });
}

async function testMultiProductCredentialCreatesMultipleSubscriptions() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);

    writeJson(path.join(dataDir, 'products', 'billing-product.json'), {
      name: 'billing-product',
      displayName: 'Billing Product',
      description: 'Access to billing',
      approvalType: 'auto',
      quota: '1000',
      quotaInterval: '1',
      quotaTimeUnit: 'hour',
      scopes: ['read'],
      environments: ['dev'],
      proxies: ['orders-api'],
      attributes: [],
    });

    const appPath = path.join(dataDir, 'apps', 'alice@example.com', 'orders-consumer.json');
    const app = readJson(appPath);
    app.credentials[0].apiProducts.push({ apiproduct: 'billing-product', status: 'approved' });
    writeJson(appPath, app);

    generateIrFromData(dataDir, irDir);

    const config = makeConfig(dir, {
      productPlanMap: {
        'orders-product': {
          targetApi: 'orders-api',
          targetPlan: 'Orders API Key',
        },
        'billing-product': {
          targetApi: 'billing-api',
          targetPlan: 'Billing API Key',
        },
      },
    });

    const result = await runDevelopersAnalyze(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.plan.records.subscriptions.length, 2);
  });
}

async function run() {
  await testAnalyzeSucceedsAndWritesOutputs();
  await testAnalyzeFailsWhenProductMappingMissing();
  await testAnalyzeFailsWhenSilentUserCreationUnsupported();
  await testAnalyzeFlagsMissingCustomFields();
  await testAnalyzeSurfacesAmbiguousProbeAsManualReview();
  await testMultiProductCredentialCreatesMultipleSubscriptions();
  console.log('test-analyze.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
