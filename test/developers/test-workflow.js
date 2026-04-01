'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runDevelopersPlan } = require('../../src/developers/plan');
const { runDevelopersImport } = require('../../src/developers/import');
const { runDevelopersReconcile } = require('../../src/developers/reconcile');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-workflow-'));
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
      apiKeyValuePreservation: 'supported',
      oauthClientValuePreservation: 'unknown',
      applicationOwnership: 'direct-member',
    },
    productPlanMap: {
      'orders-product': {
        targetApi: 'orders-api',
        targetApiId: 'api-orders-1',
        targetPlan: 'Orders API Key',
        targetPlanId: 'plan-orders-1',
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

function makeWorkflowClient(options = {}) {
  const state = {
    users: new Map(),
    roles: new Map(),
    applications: new Map(),
    members: new Map(),
    plans: new Map([
      ['plan-orders-1', { id: 'plan-orders-1', apiId: 'api-orders-1', name: 'Orders API Key' }],
      ['plan-billing-1', { id: 'plan-billing-1', apiId: 'api-billing-1', name: 'Billing API Key' }],
    ]),
    subscriptions: new Map(),
    apiKeys: new Map(),
    counts: {
      createUser: 0,
      createApplication: 0,
      createSubscription: 0,
    },
  };

  return {
    _state: state,
    async healthCheck() { return { ok: true }; },
    async verifyEnvironmentAccess() { return { ok: true }; },
    async listRoles() { return new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']); },
    async listCustomFields() { return new Set(['team', 'environment']); },
    async findUserByEmail(email) { return state.users.get(email) || null; },
    async getUserRoles(userId) { return state.roles.get(userId) || new Set(); },
    async createUser(payload) {
      state.counts.createUser += 1;
      const user = { id: `user-${state.counts.createUser}`, email: payload.email };
      state.users.set(payload.email, user);
      return user;
    },
    async updateUser(userId, payload) {
      const user = { id: userId, email: payload.email };
      state.users.set(payload.email, user);
      return user;
    },
    async assignUserRoles(userId, roles) {
      state.roles.set(userId, new Set([...roles.organization, ...roles.environment]));
      return { ok: true };
    },
    async listApplications() { return Array.from(state.applications.values()); },
    async findApplicationByNameAndOwnerHint({ name, ownerHint }) {
      return Array.from(state.applications.values()).find((item) => item.name === name && item.metadata?.developerEmail === ownerHint) || null;
    },
    async createApplication(payload) {
      state.counts.createApplication += 1;
      const app = { id: `app-${state.counts.createApplication}`, name: payload.name, metadata: payload.metadata };
      state.applications.set(app.id, app);
      return app;
    },
    async updateApplication(applicationId, payload) {
      const app = { id: applicationId, name: payload.name, metadata: payload.metadata };
      state.applications.set(applicationId, app);
      return app;
    },
    async addApplicationMember(applicationId, payload) {
      const members = state.members.get(applicationId) || [];
      members.push({ userId: payload.user });
      state.members.set(applicationId, members);
      return { ok: true };
    },
    async listApplicationMembers(applicationId) { return state.members.get(applicationId) || []; },
    async findPlan(mapping) {
      return state.plans.get(mapping.targetPlanId) || null;
    },
    async findSubscription({ applicationId, apiId, planId }) {
      const key = `${applicationId}:${apiId}:${planId}`;
      return state.subscriptions.get(key) || null;
    },
    async createSubscription({ apiId, applicationId, planId }) {
      state.counts.createSubscription += 1;
      const key = `${applicationId}:${apiId}:${planId}`;
      const subscription = { id: `sub-${state.counts.createSubscription}`, application: { id: applicationId }, plan: { id: planId }, apiId };
      state.subscriptions.set(key, subscription);
      const apiKey = options.subscriptionApiKey || 'abc123def456';
      state.apiKeys.set(subscription.id, [{ key: apiKey }]);
      return subscription;
    },
    async listSubscriptionApiKeys({ subscriptionId }) {
      return state.apiKeys.get(subscriptionId) || [];
    },
    async closeOrPauseSubscription() { return { ok: true }; },
    ...options.overrides,
  };
}

async function testPlanBuildsExecutableManifest() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const result = await runDevelopersPlan(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client: makeWorkflowClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.manifest.actions.some((item) => item.kind === 'UPSERT_USER'));
    assert.ok(result.manifest.actions.some((item) => item.kind === 'UPSERT_APPLICATION'));
    assert.ok(result.manifest.actions.some((item) => item.kind === 'RESOLVE_PLAN'));
    assert.ok(result.manifest.actions.some((item) => item.kind === 'UPSERT_SUBSCRIPTION'));
    assert.ok(result.manifest.actions.some((item) => item.kind === 'VERIFY_SUBSCRIPTION'));
  });
}

async function testPlanFailsWhenCapabilityProbeContradictsConfig() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const result = await runDevelopersPlan(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      {
        config: makeConfig(dir),
        client: makeWorkflowClient({
          overrides: {
            async verifyUserProvisioningCapabilities() {
              return {
                ok: false,
                supported: false,
                checks: {
                  lookup: { ok: true, supported: true, status: 200 },
                  create: { ok: false, supported: false, status: 404, classification: 'unsupported-endpoint' },
                },
              };
            },
          },
        }),
      },
    );

    assert.strictEqual(result.exitCode, 3);
    assert.ok(result.preflight.blockers.some((item) => item.code === 'SILENT_USER_CREATION_PROBE_FAILED'));
  });
}

async function testImportCreatesResourcesAndResumeSkipsRework() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir);

    const first = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(first.exitCode, 0);
    assert.strictEqual(client._state.counts.createUser, 1);
    assert.strictEqual(client._state.counts.createApplication, 1);
    assert.strictEqual(client._state.counts.createSubscription, 1);
    assert.ok(Object.values(first.state.actions).some((item) => item.status === 'SUCCEEDED'));

    const second = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), resume: true },
      { config, client },
    );

    assert.strictEqual(second.exitCode, 0);
    assert.strictEqual(client._state.counts.createUser, 1);
    assert.strictEqual(client._state.counts.createApplication, 1);
    assert.strictEqual(client._state.counts.createSubscription, 1);
  });
}

async function testImportFailsOnContinuityMismatch() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({ subscriptionApiKey: 'different-key' });
    const config = makeConfig(dir, {
      policies: {
        inactiveDeveloper: 'import-and-revoke',
        smtp: 'acknowledged',
        defaultApplication: 'must-be-disabled',
        apiKeyContinuity: 'fail-if-not-preservable',
        existingUser: 'match-and-reuse',
        existingApplication: 'match-and-reuse',
        userProvisioning: 'reuse-or-create-silently',
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(result.exitCode, 4);
    assert.ok(Object.values(result.state.actions).some((item) => item.status === 'FAILED'));
  });
}

async function testReconcileDetectsMismatches() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir, {
      policies: {
        inactiveDeveloper: 'import-and-revoke',
        smtp: 'acknowledged',
        defaultApplication: 'must-be-disabled',
        apiKeyContinuity: 'fail-if-not-preservable',
        existingUser: 'match-and-reuse',
        existingApplication: 'match-and-reuse',
        userProvisioning: 'reuse-or-create-silently',
      },
    });

    await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    client._state.roles.clear();
    client._state.subscriptions.clear();

    const result = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(result.exitCode, 6);
    assert.ok(result.report.mismatches.some((item) => item.code === 'USER_ROLE_MISMATCH'));
    assert.ok(result.report.mismatches.some((item) => item.code === 'SUBSCRIPTION_MISSING'));
  });
}

async function testImportAndReconcileSupportMetadataOnlyOwnership() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir, {
      capabilities: {
        silentUserCreation: 'supported',
        apiKeyValuePreservation: 'supported',
        oauthClientValuePreservation: 'unknown',
        applicationOwnership: 'metadata-only',
      },
    });

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);

    const reconciled = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(reconciled.exitCode, 0);
  });
}

async function run() {
  await testPlanBuildsExecutableManifest();
  await testPlanFailsWhenCapabilityProbeContradictsConfig();
  await testImportCreatesResourcesAndResumeSkipsRework();
  await testImportFailsOnContinuityMismatch();
  await testReconcileDetectsMismatches();
  await testImportAndReconcileSupportMetadataOnlyOwnership();
  console.log('test-workflow.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
