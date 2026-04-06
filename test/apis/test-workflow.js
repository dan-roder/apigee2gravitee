'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runApisAnalyze } = require('../../src/apis/analyze');
const { runApisImport } = require('../../src/apis/import');
const { runApisReconcile } = require('../../src/apis/reconcile');

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
    async findApiByName(name) { return Array.from(state.apis.values()).find((item) => item.name === name) || null; },
    async createApi(payload) {
      state.createApi += 1;
      const api = { id: `api-${state.createApi}`, name: payload.name, definitionContext: payload.definitionContext };
      state.apis.set(api.id, api);
      state.plans.set(api.id, Object.values(payload.plans || {}).map((plan, index) => ({ id: `${api.id}-plan-${index + 1}`, name: plan.name })));
      return api;
    },
    async updateApi(apiId, payload) {
      const api = { id: apiId, name: payload.name, definitionContext: payload.definitionContext };
      state.apis.set(apiId, api);
      state.plans.set(apiId, Object.values(payload.plans || {}).map((plan, index) => ({ id: `${api.id}-plan-${index + 1}`, name: plan.name })));
      return api;
    },
    async listApiPlans(apiId) {
      return state.plans.get(apiId) || [];
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

async function run() {
  await testApisAnalyzeBuildsPlan();
  await testApisImportCreatesApiAndPlans();
  await testApisReconcileDetectsMissingApi();
  console.log('test-workflow.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
