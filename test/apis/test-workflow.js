'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runApisAnalyze } = require('../../src/apis/analyze');
const { runApisImport } = require('../../src/apis/import');
const { runApisReconcile } = require('../../src/apis/reconcile');
const { runApisDeleteImported } = require('../../src/apis/delete-imported');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DATA = path.join(PROJECT_ROOT, 'test', 'extractor', 'fixtures', 'data');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apis-workflow-'));
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
  if (result.status !== 0) throw new Error(`IR generation failed: ${result.stderr}`);
}

function makeConfig(baseDir, overrides = {}) {
  return {
    gravitee: {
      url: 'https://gravitee.example.com',
      orgId: 'DEFAULT',
      envId: 'DEFAULT',
    },
    filters: {
      includeProxies: [],
      excludeProxies: [],
    },
    reporting: {
      reportDir: path.join(baseDir, 'report'),
      stateFile: path.join(baseDir, 'state', 'apis-import-state.json'),
    },
    ...overrides,
  };
}

function makeClient() {
  const state = {
    apis: new Map(),
    plans: new Map(),
    createApi: 0,
    deleteApi: 0,
  };

  return {
    _state: state,
    async healthCheck() { return { ok: true }; },
    async verifyEnvironmentAccess() { return { ok: true }; },
    async verifyApiImportCapabilities() {
      return {
        checks: {
          listApis: { ok: true, supported: true, status: 200 },
          createApi: { ok: true, supported: true, status: 200 },
          updateApi: { ok: true, supported: true, status: 200 },
        },
      };
    },
    async listApis() { return Array.from(state.apis.values()); },
    async getApi(apiId) { return state.apis.get(apiId) || null; },
    async findApiByName(name) { return Array.from(state.apis.values()).find((item) => item.name === name) || null; },
    async createApi(payload) {
      state.createApi += 1;
      const api = {
        id: `api-${state.createApi}`,
        name: payload.name,
        crossId: payload.crossId,
        definitionContext: payload.definitionContext,
      };
      state.apis.set(api.id, api);
      state.plans.set(api.id, Object.values(payload.plans || {}).map((plan, index) => ({ id: `${api.id}-plan-${index + 1}`, name: plan.name })));
      return api;
    },
    async updateApi(apiId, payload) {
      const api = {
        id: apiId,
        name: payload.name,
        crossId: payload.crossId,
        definitionContext: payload.definitionContext,
      };
      state.apis.set(apiId, api);
      state.plans.set(apiId, Object.values(payload.plans || {}).map((plan, index) => ({ id: `${api.id}-plan-${index + 1}`, name: plan.name })));
      return api;
    },
    async deleteApi(apiId) {
      state.deleteApi += 1;
      state.apis.delete(apiId);
      state.plans.delete(apiId);
      return null;
    },
    async listApiPlans(apiId) {
      return state.plans.get(apiId) || [];
    },
    async findApiPlanByName(apiId, name) {
      return (state.plans.get(apiId) || []).find((item) => item.name === name) || null;
    },
    async createApiPlan(apiId, payload) {
      const plans = state.plans.get(apiId) || [];
      const plan = { id: `${apiId}-plan-${plans.length + 1}`, name: payload.name };
      plans.push(plan);
      state.plans.set(apiId, plans);
      return plan;
    },
    async updateApiPlan(apiId, planId, payload) {
      const plans = state.plans.get(apiId) || [];
      const index = plans.findIndex((item) => item.id === planId);
      const plan = { id: planId, name: payload.name };
      if (index >= 0) plans[index] = plan;
      else plans.push(plan);
      state.plans.set(apiId, plans);
      return plan;
    },
    async publishApiPlan() {
      return null;
    },
    async findApiBySourceId(sourceId) {
      return Array.from(state.apis.values()).find((item) => {
        return item.definitionContext?.origin?.sourceId === sourceId || item.crossId === sourceId;
      }) || null;
    },
  };
}

async function testApisAnalyzeBuildsPlan() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const result = await runApisAnalyze(
      { 'ir-dir': irDir, config: path.join(dir, 'apis.config.json') },
      { config: makeConfig(dir), client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.domain.proxies.length, 1);
    assert.ok(result.manifest.actions.some((item) => item.kind === 'UPSERT_API'));
    assert.ok(result.manifest.actions.some((item) => item.kind === 'UPSERT_PLAN'));
    assert.ok(result.manifest.actions.some((item) => item.kind === 'VERIFY_PLAN'));
    assert.ok(result.manifest.actions.some((item) => item.kind === 'VERIFY_API'));
  });
}

async function testApisImportCreatesApiAndPlans() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeClient();
    const result = await runApisImport(
      { 'ir-dir': irDir, config: path.join(dir, 'apis.config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(client._state.createApi, 1);
    assert.ok(result.idMap.apis['orders-api']);
    assert.ok(result.idMap.plans['orders-api']);
    assert.ok(Object.keys(result.idMap.plans['orders-api']).length > 0);
  });
}

async function testApisImportCompatibilityIssuesBecomeManualReview() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeClient();
    client.createApi = async () => {
      const err = new Error('legacy-import-wrapper: deserialize failure');
      err.classification = 'compatibility';
      err.attempts = [
        {
          strategy: 'legacy-import-wrapper',
          message: 'HTTP 500',
          body: { message: 'deserialize failure' },
        },
      ];
      throw err;
    };

    const result = await runApisImport(
      { 'ir-dir': irDir, config: path.join(dir, 'apis.config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.state.actions['UPSERT_API:orders-api'].status, 'MANUAL_REVIEW');
    assert.strictEqual(result.state.actions['VERIFY_API:orders-api'].status, 'MANUAL_REVIEW');
  });
}

async function testApisReconcileDetectsMissingApi() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeClient();
    const result = await runApisReconcile(
      { 'ir-dir': irDir, config: path.join(dir, 'apis.config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 6);
    assert.ok(result.report.mismatches.some((item) => item.code === 'API_MISSING'));
  });
}

async function testApisDeleteImportedDeletesKnownApis() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeClient();
    const importResult = await runApisImport(
      { 'ir-dir': irDir, config: path.join(dir, 'apis.config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(importResult.exitCode, 0);
    assert.ok(importResult.idMap.apis['orders-api']);

    const cleanupResult = await runApisDeleteImported(
      { 'ir-dir': irDir, config: path.join(dir, 'apis.config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(cleanupResult.exitCode, 0);
    assert.strictEqual(client._state.deleteApi, 1);
    assert.strictEqual(cleanupResult.idMap.apis['orders-api'], null);
  });
}

async function run() {
  await testApisAnalyzeBuildsPlan();
  await testApisImportCreatesApiAndPlans();
  await testApisImportCompatibilityIssuesBecomeManualReview();
  await testApisReconcileDetectsMissingApi();
  await testApisDeleteImportedDeletesKnownApis();
  console.log('test-workflow.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
