'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runDevelopersPlan } = require('../../src/developers/plan');
const { runDevelopersImport } = require('../../src/developers/import');
const { runDevelopersReconcile } = require('../../src/developers/reconcile');
const { runDevelopersDeleteImported } = require('../../src/developers/delete-imported');

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
    roleAssignmentIds: {
      organization: ['role-org-1'],
      environment: ['role-env-1'],
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
    customFields: new Set(['team', 'environment']),
    plans: new Map([
      ['plan-orders-1', { id: 'plan-orders-1', apiId: 'api-orders-1', name: 'Orders API Key' }],
      ['plan-orders-audit-1', { id: 'plan-orders-audit-1', apiId: 'api-orders-audit-1', name: 'Orders Audit API Key' }],
      ['plan-billing-1', { id: 'plan-billing-1', apiId: 'api-billing-1', name: 'Billing API Key' }],
    ]),
    subscriptions: new Map(),
    apiKeys: new Map(),
    counts: {
      createUser: 0,
      createApplication: 0,
      createSubscription: 0,
      createCustomField: 0,
      upsertApplicationMetadata: 0,
      deleteSubscription: 0,
      deleteApplication: 0,
      deleteUser: 0,
    },
  };

  return {
    _state: state,
    async healthCheck() { return { ok: true }; },
    async verifyEnvironmentAccess() { return { ok: true }; },
    async listRoles() { return new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']); },
    async listCustomFields() { return new Set(state.customFields); },
    async ensureApplicationCustomFields(fieldNames) {
      const created = [];
      const skipped = [];
      for (const fieldName of fieldNames) {
        if (state.customFields.has(fieldName)) {
          skipped.push(fieldName);
          continue;
        }
        state.customFields.add(fieldName);
        state.counts.createCustomField += 1;
        created.push(fieldName);
      }
      return { created, skipped, failed: [] };
    },
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
    async findApplicationByNameAndOwnerHint({ name, ownerHint, sourceId }) {
      return Array.from(state.applications.values()).find((item) => item.metadata?.sourceId === sourceId)
        || Array.from(state.applications.values()).find((item) => item.name === name && item.metadata?.developerEmail === ownerHint)
        || null;
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
    async upsertApplicationMetadata(applicationId, metadata) {
      state.counts.upsertApplicationMetadata += Object.keys(metadata || {}).length;
      const app = state.applications.get(applicationId);
      if (app) {
        app.metadata = { ...(app.metadata || {}), ...(metadata || {}) };
      }
      return { ok: true };
    },
    async listApplicationMetadata(applicationId) {
      const app = state.applications.get(applicationId);
      return Object.entries(app?.metadata || {}).map(([key, value]) => ({
        key,
        name: key,
        value,
        applicationId,
      }));
    },
    async addApplicationMember(applicationId, payload) {
      const members = state.members.get(applicationId) || [];
      members.push({ userId: payload.user });
      state.members.set(applicationId, members);
      return { ok: true };
    },
    async transferApplicationOwnership(applicationId, payload) {
      const app = state.applications.get(applicationId);
      if (app) {
        app.owner = { id: payload.userId || payload.id || payload.user || null, email: null };
        state.applications.set(applicationId, app);
      }
      const members = state.members.get(applicationId) || [];
      const userId = payload.userId || payload.id || payload.user || null;
      if (userId && !members.some((item) => item.userId === userId || item.id === userId)) {
        members.push({ userId });
      }
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
    async deleteSubscription({ subscriptionId }) {
      state.counts.deleteSubscription += 1;
      for (const [key, value] of state.subscriptions.entries()) {
        if (value.id === subscriptionId) state.subscriptions.delete(key);
      }
      state.apiKeys.delete(subscriptionId);
      return { ok: true };
    },
    async deleteApplication(applicationId) {
      state.counts.deleteApplication += 1;
      state.applications.delete(applicationId);
      state.members.delete(applicationId);
      return { ok: true };
    },
    async deleteUser(userId) {
      state.counts.deleteUser += 1;
      for (const [email, user] of state.users.entries()) {
        if (user.id === userId) state.users.delete(email);
      }
      state.roles.delete(userId);
      return { ok: true };
    },
    ...options.overrides,
  };
}

function setDeveloperStatus(dataDir, email, status) {
  const filePath = path.join(dataDir, 'devs', email, `${email}.json`);
  const payload = readJson(filePath);
  payload.status = status;
  writeJson(filePath, payload);
}

function addDeveloperWithoutApps(dataDir, email = 'noapps@example.com') {
  writeJson(path.join(dataDir, 'devs', email, `${email}.json`), {
    email,
    firstName: 'No',
    lastName: 'Apps',
    userName: email,
    status: 'active',
    apps: [],
    attributes: [],
  });
}

function addDeveloperWithApp(dataDir, email, appName, products) {
  writeJson(path.join(dataDir, 'devs', email, `${email}.json`), {
    email,
    firstName: 'Test',
    lastName: 'Developer',
    userName: email,
    status: 'active',
    apps: [appName],
    attributes: [],
  });
  writeJson(path.join(dataDir, 'apps', email, `${appName}.json`), {
    name: appName,
    appId: `${appName}-uuid`,
    status: 'approved',
    callbackUrl: '',
    attributes: [],
    credentials: [{
      consumerKey: `${appName}-key`,
      consumerSecret: `${appName}-secret`,
      status: 'approved',
      expiresAt: -1,
      scopes: [],
      apiProducts: products.map((product) => ({ apiproduct: product, status: 'approved' })),
    }],
  });
}

function addBillingProductToData(dataDir) {
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
}

function setAppAttributes(dataDir, attributes) {
  const appPath = path.join(dataDir, 'apps', 'alice@example.com', 'orders-consumer.json');
  const app = readJson(appPath);
  app.attributes = attributes;
  writeJson(appPath, app);
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

async function testPlanBlocksSubscriptionsForIncompatibleTargetPlanSecurity() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    client._state.plans.set('plan-orders-1', {
      id: 'plan-orders-1',
      apiId: 'api-orders-1',
      name: 'Orders Keyless',
      security: { type: 'KEY_LESS' },
      status: 'PUBLISHED',
    });

    const result = await runDevelopersPlan(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    const resolvePlan = result.manifest.actions.find((item) => item.kind === 'RESOLVE_PLAN');
    const upsertSubscription = result.manifest.actions.find((item) => item.kind === 'UPSERT_SUBSCRIPTION');

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(resolvePlan.plannedStatus, 'BLOCKED');
    assert.ok(resolvePlan.blockers.includes('TARGET_PLAN_SECURITY_MISMATCH'));
    assert.strictEqual(upsertSubscription.plannedStatus, 'BLOCKED');
    assert.strictEqual(upsertSubscription.operation, 'BLOCK');
    assert.ok(upsertSubscription.blockers.includes('TARGET_PLAN_SECURITY_MISMATCH'));
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
    const application = Array.from(client._state.applications.values())[0];
    assert.deepStrictEqual(application.metadata, {
      developerEmail: 'alice@example.com',
      sourceId: 'alice@example.com/orders-consumer',
      environment: 'production',
    });
    assert.strictEqual(client._state.counts.upsertApplicationMetadata, 3);
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

async function testImportWritesApplicationMetadataPerApplication() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    client._state.customFields.clear();

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(client._state.counts.createCustomField, 0);
    assert.strictEqual(client._state.counts.upsertApplicationMetadata, 3);
    const application = Array.from(client._state.applications.values())[0];
    assert.strictEqual(application.metadata.environment, 'production');
  });
}

async function testImportOnlyWritesToolMetadataWithoutAppAttributes() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    setAppAttributes(dataDir, []);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    client._state.customFields.clear();

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(client._state.counts.createCustomField, 0);
    assert.strictEqual(client._state.counts.upsertApplicationMetadata, 2);
  });
}

async function testApplicationMetadataReservedAndDuplicateKeys() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    setAppAttributes(dataDir, [
      { name: 'sourceId', value: 'bad-source' },
      { name: 'developerEmail', value: 'bad-owner@example.com' },
      { name: 'team', value: 'first' },
      { name: 'team', value: 'second' },
      { name: 'empty-value', value: null },
    ]);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    const application = Array.from(client._state.applications.values())[0];
    assert.strictEqual(application.metadata.sourceId, 'alice@example.com/orders-consumer');
    assert.strictEqual(application.metadata.developerEmail, 'alice@example.com');
    assert.strictEqual(application.metadata.team, 'second');
    assert.strictEqual(application.metadata['empty-value'], '');
    assert.strictEqual(client._state.counts.createCustomField, 0);
    assert.strictEqual(client._state.counts.upsertApplicationMetadata, 4);
    const plannedApplication = result.domain.applications[0];
    assert.ok(plannedApplication.warnings.includes('APPLICATION_METADATA_RESERVED_KEY:sourceId'));
    assert.ok(plannedApplication.warnings.includes('APPLICATION_METADATA_RESERVED_KEY:developerEmail'));
    assert.ok(plannedApplication.warnings.includes('DUPLICATE_APPLICATION_METADATA_KEY:team'));
  });
}

async function testImportSkipsDevelopersWithoutApps() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    addDeveloperWithoutApps(dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.ok(!result.manifest.records.users.some((item) => item.email === 'noapps@example.com'));
    assert.strictEqual(client._state.users.has('noapps@example.com'), false);
    assert.strictEqual(client._state.counts.createUser, 1);
  });
}

async function testImportRollsBackOrReusesUserAfterRoleAssignmentFailure() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    let failRoleAssignment = true;
    const client = makeWorkflowClient({
      overrides: {
        async assignUserRoles(userId, roles) {
          if (failRoleAssignment) {
            const err = new Error('PUT http://localhost:8083/management/organizations/DEFAULT/users/user-1/roles → HTTP 500');
            err.status = 500;
            err.body = { message: 'role assignment failed' };
            throw err;
          }
          this._state.roles.set(userId, new Set([...roles.organization, ...roles.environment]));
          return { ok: true };
        },
      },
    });
    client._state.roles.set('user-saved', new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']));

    const first = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(first.exitCode, 4);
    assert.strictEqual(client._state.users.size, 0);
    assert.ok(String(first.state.actions['UPSERT_USER:alice@example.com']?.lastError || '').includes('role assignment failed'));

    failRoleAssignment = false;

    const second = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true, resume: true },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(second.exitCode, 0);
    assert.strictEqual(client._state.users.size, 1);
  });
}

async function testImportSucceedsWhenUserRoleReadIsUnsupported() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async getUserRoles(_userId, options = {}) {
          if (options.allowUnsupported) return null;
          const err = new Error('GET http://localhost:8083/management/organizations/DEFAULT/users/user-1/roles → HTTP 405');
          err.status = 405;
          err.body = { message: 'HTTP 405 Method Not Allowed' };
          throw err;
        },
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.state.actions['UPSERT_USER:alice@example.com'].status, 'SUCCEEDED');
    assert.strictEqual(result.state.actions['VERIFY_USER:alice@example.com'].status, 'SUCCEEDED');
    assert.strictEqual(result.state.actions['VERIFY_USER:alice@example.com'].reconcileHints.roleVerification, 'unverified');
  });
}

async function testImportReusesUserAfterCreateConflict() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    let lookupCount = 0;
    const existingUser = { id: 'user-existing-after-conflict', email: 'alice@example.com' };
    const client = makeWorkflowClient({
      overrides: {
        async findUserByEmail(email) {
          lookupCount += 1;
          if (email === 'alice@example.com' && lookupCount > 1) return existingUser;
          return null;
        },
        async createUser(payload) {
          if (payload.email === 'alice@example.com') {
            const err = new Error('POST http://localhost:8083/management/organizations/DEFAULT/users -> HTTP 400');
            err.status = 400;
            err.body = {
              message: 'A user [alice@example.com] already exists for organization DEFAULT.',
              technicalCode: 'user.exists',
              http_status: 400,
            };
            throw err;
          }
          return makeWorkflowClient().createUser(payload);
        },
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.idMap.users['alice@example.com'], 'user-existing-after-conflict');
    assert.strictEqual(result.state.actions['UPSERT_USER:alice@example.com'].status, 'SUCCEEDED');
  });
}

async function testImportResolvesUserIdFromCreateConflictBody() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async findUserByEmail() {
          return null;
        },
        async getUser(userId) {
          if (userId === 'user-from-conflict') return { id: userId, email: 'alice@example.com' };
          return null;
        },
        async createUser(payload) {
          if (payload.email === 'alice@example.com') {
            const err = new Error('POST http://localhost:8083/management/organizations/DEFAULT/users -> HTTP 400');
            err.status = 400;
            err.body = {
              message: 'A user [alice@example.com] already exists for organization DEFAULT.',
              technicalCode: 'user.exists',
              userId: 'user-from-conflict',
            };
            throw err;
          }
          return makeWorkflowClient().createUser(payload);
        },
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.idMap.users['alice@example.com'], 'user-from-conflict');
    assert.strictEqual(result.state.actions['UPSERT_USER:alice@example.com'].status, 'SUCCEEDED');
  });
}

async function testImportContinuesIndependentActionsAfterUserFailureByDefault() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    addDeveloperWithApp(dataDir, 'bob@example.com', 'bob-app', ['orders-product']);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async createUser(payload) {
          if (payload.email === 'alice@example.com') {
            const err = new Error('create user failed');
            err.status = 400;
            throw err;
          }
          const user = { id: `user-${this._state.users.size + 1}`, email: payload.email };
          this._state.users.set(payload.email, user);
          return user;
        },
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 4);
    assert.strictEqual(result.state.actions['UPSERT_USER:alice@example.com'].status, 'FAILED');
    assert.strictEqual(result.state.actions['UPSERT_APPLICATION:bob@example.com/bob-app'].status, 'SUCCEEDED');
  });
}

async function testImportUsesSavedUserIdWhenEmailLookupMisses() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async findUserByEmail() { return null; },
        async getUser(userId) {
          if (userId === 'user-saved') return { id: 'user-saved', email: 'alice@example.com' };
          return null;
        },
        async createUser() {
          throw new Error('createUser should not be called when saved id resolves');
        },
      },
    });
    const config = makeConfig(dir);
    const idMapPath = path.join(dir, 'state', 'developers-id-map.json');
    writeJson(idMapPath, {
      generatedAt: new Date().toISOString(),
      users: { 'alice@example.com': 'user-saved' },
      applications: {},
      subscriptions: {},
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config, client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.idMap.users['alice@example.com'], 'user-saved');
    assert.strictEqual(result.state.actions['UPSERT_USER:alice@example.com'].status, 'SUCCEEDED');
  });
}

async function testImportReusesExistingResourcesBySourceMarker() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    client._state.users.set('alice@example.com', { id: 'user-existing', email: 'alice@example.com' });
    client._state.roles.set('user-existing', new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']));
    client._state.applications.set('app-existing', {
      id: 'app-existing',
      name: 'orders-consumer',
      metadata: { developerEmail: 'alice@example.com', sourceId: 'alice@example.com/orders-consumer', environment: 'production' },
    });
    client._state.subscriptions.set('app-existing:api-orders-1:plan-orders-1', {
      id: 'sub-existing',
      application: { id: 'app-existing' },
      plan: { id: 'plan-orders-1' },
      apiId: 'api-orders-1',
    });
    client._state.apiKeys.set('sub-existing', [{ key: 'abc123def456' }]);

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(client._state.counts.createUser, 0);
    assert.strictEqual(client._state.counts.createApplication, 0);
    assert.strictEqual(client._state.counts.createSubscription, 0);
    assert.strictEqual(result.idMap.users['alice@example.com'], 'user-existing');
    assert.strictEqual(result.idMap.applications['alice@example.com/orders-consumer'], 'app-existing');
    assert.strictEqual(
      result.idMap.subscriptions['alice@example.com/orders-consumer/abc123def456/orders-product/orders-api::Orders API Key'],
      'sub-existing',
    );
  });
}

async function testImportVerifiesApplicationMetadataFromScopedEndpoint() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const scopedMetadataByApplication = new Map();
    const client = makeWorkflowClient({
      overrides: {
        async createApplication(payload) {
          this._state.counts.createApplication += 1;
          const app = { id: `app-${this._state.counts.createApplication}`, name: payload.name };
          this._state.applications.set(app.id, app);
          return app;
        },
        async findApplicationByNameAndOwnerHint({ name, ownerHint, sourceId }) {
          const apps = Array.from(this._state.applications.values());
          for (const app of apps) {
            app.metadata = { ...(app.metadata || {}), ...(scopedMetadataByApplication.get(app.id) || {}) };
          }
          return apps.find((item) => item.metadata?.sourceId === sourceId)
            || apps.find((item) => item.name === name && item.metadata?.developerEmail === ownerHint)
            || null;
        },
        async upsertApplicationMetadata(applicationId, metadata) {
          this._state.counts.upsertApplicationMetadata += Object.keys(metadata || {}).length;
          scopedMetadataByApplication.set(applicationId, { ...(scopedMetadataByApplication.get(applicationId) || {}), ...(metadata || {}) });
          return { ok: true };
        },
        async listApplicationMetadata(applicationId) {
          return Object.entries(scopedMetadataByApplication.get(applicationId) || {}).map(([key, value]) => ({
            key,
            name: key,
            value,
            applicationId,
          }));
        },
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.state.actions['VERIFY_APPLICATION:alice@example.com/orders-consumer'].status, 'SUCCEEDED');
  });
}

async function testImportUpsertsMetadataForReusedApplications() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    client._state.users.set('alice@example.com', { id: 'user-existing', email: 'alice@example.com' });
    client._state.applications.set('app-existing', {
      id: 'app-existing',
      name: 'orders-consumer',
      metadata: { sourceId: 'alice@example.com/orders-consumer' },
      owner: { id: 'user-existing' },
    });
    client._state.members.set('app-existing', [{ userId: 'user-existing' }]);

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      {
        config: makeConfig(dir, {
          capabilities: {
            silentUserCreation: 'supported',
            apiKeyValuePreservation: 'supported',
            oauthClientValuePreservation: 'unknown',
            applicationOwnership: 'metadata-only',
          },
        }),
        client,
      },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(
      result.manifest.actions.find((item) => item.actionId === 'UPSERT_APPLICATION:alice@example.com/orders-consumer').operation,
      'REUSE',
    );
    assert.strictEqual(client._state.applications.get('app-existing').metadata.developerEmail, 'alice@example.com');
    assert.strictEqual(client._state.applications.get('app-existing').metadata.sourceId, 'alice@example.com/orders-consumer');
  });
}

async function testImportDoesNotFailVerificationWhenMetadataReadbackIsUnavailable() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async listApplicationMetadata() {
          return [];
        },
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.state.actions['VERIFY_APPLICATION:alice@example.com/orders-consumer'].status, 'SUCCEEDED');
  });
}

async function testReconcileWarnsWhenUserRoleReadIsUnsupported() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async getUserRoles(_userId, options = {}) {
          if (options.allowUnsupported) return null;
          const err = new Error('GET http://localhost:8083/management/organizations/DEFAULT/users/user-1/roles → HTTP 405');
          err.status = 405;
          err.body = { message: 'HTTP 405 Method Not Allowed' };
          throw err;
        },
      },
    });

    await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config: makeConfig(dir), client },
    );

    const reconcile = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.ok(reconcile.report.mismatches.some((item) => item.code === 'USER_ROLE_LOOKUP_UNSUPPORTED' && item.severity === 'warning'));
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

async function testInactiveDeveloperSkipPolicySkipsActions() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    setDeveloperStatus(dataDir, 'alice@example.com', 'inactive');
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir, {
      policies: {
        inactiveDeveloper: 'skip',
        smtp: 'acknowledged',
        defaultApplication: 'must-be-disabled',
        apiKeyContinuity: 'preserve-if-supported',
        existingUser: 'match-and-reuse',
        existingApplication: 'match-and-reuse',
        userProvisioning: 'reuse-or-create-silently',
      },
    });

    const planned = await runDevelopersPlan(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.ok(planned.manifest.actions.every((item) => item.plannedStatus === 'SKIPPED' || item.kind === 'RESOLVE_PLAN'));

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);
    assert.strictEqual(client._state.counts.createUser, 0);
    assert.strictEqual(client._state.counts.createApplication, 0);
    assert.strictEqual(client._state.counts.createSubscription, 0);
  });
}

async function testInactiveDeveloperImportDisabledReusesDisabledUser() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    setDeveloperStatus(dataDir, 'alice@example.com', 'inactive');
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    client._state.users.set('alice@example.com', {
      id: 'user-disabled',
      email: 'alice@example.com',
      enabled: false,
      status: 'inactive',
    });
    client._state.roles.set('user-disabled', new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']));

    const config = makeConfig(dir, {
      policies: {
        inactiveDeveloper: 'import-disabled',
        smtp: 'acknowledged',
        defaultApplication: 'must-be-disabled',
        apiKeyContinuity: 'preserve-if-supported',
        existingUser: 'match-and-reuse',
        existingApplication: 'match-and-reuse',
        userProvisioning: 'reuse-or-create-silently',
      },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json'), 'users-only': true },
      { config, client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(client._state.counts.createUser, 0);
    assert.strictEqual(result.idMap.users['alice@example.com'], 'user-disabled');
    assert.strictEqual(result.state.actions['VERIFY_USER:alice@example.com'].status, 'SUCCEEDED');
  });
}

async function testImportFailsWhenApplicationReuseMatchesWrongSourceMarker() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    client._state.users.set('alice@example.com', { id: 'user-existing', email: 'alice@example.com' });
    client._state.roles.set('user-existing', new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']));
    client._state.applications.set('app-wrong-source', {
      id: 'app-wrong-source',
      name: 'orders-consumer',
      metadata: { developerEmail: 'alice@example.com', sourceId: 'alice@example.com/some-other-app' },
    });

    const result = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config: makeConfig(dir), client },
    );

    assert.strictEqual(result.exitCode, 4);
    assert.strictEqual(result.state.actions['UPSERT_USER:alice@example.com'].status, 'SUCCEEDED');
    assert.strictEqual(result.state.actions['UPSERT_APPLICATION:alice@example.com/orders-consumer'].status, 'FAILED');
    assert.strictEqual(result.state.actions['VERIFY_APPLICATION:alice@example.com/orders-consumer'].status, 'BLOCKED');
    assert.ok(
      String(result.state.actions['UPSERT_APPLICATION:alice@example.com/orders-consumer'].lastError || '').includes('unexpected source marker'),
    );
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

async function testReconcileDetectsPartiallyDriftedTargetResources() {
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
        apiKeyContinuity: 'preserve-if-supported',
        existingUser: 'match-and-reuse',
        existingApplication: 'match-and-reuse',
        userProvisioning: 'reuse-or-create-silently',
      },
    });

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(imported.exitCode, 0);

    const application = Array.from(client._state.applications.values())[0];
    application.metadata.sourceId = 'alice@example.com/drifted-app';
    application.metadata.environment = 'staging';

    const subscription = Array.from(client._state.subscriptions.values())[0];
    subscription.plan.id = 'plan-drifted';
    subscription.apiId = 'api-drifted';

    const idMapPath = path.join(dir, 'state', 'developers-id-map.json');
    const driftedIdMap = readJson(idMapPath);
    driftedIdMap.users['alice@example.com'] = 'user-drifted';
    writeJson(idMapPath, driftedIdMap);

    const result = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(result.exitCode, 6);
    assert.ok(result.report.mismatches.some((item) => item.code === 'USER_ID_MAP_MISMATCH'));
    assert.ok(result.report.mismatches.some((item) => item.code === 'APPLICATION_SOURCE_MARKER_MISMATCH'));
    const metadataMismatch = result.report.mismatches.find((item) => item.code === 'APPLICATION_METADATA_MISMATCH');
    assert.ok(metadataMismatch);
    assert.ok(metadataMismatch.diagnostics);
    assert.ok(result.report.diagnostics.applicationMetadata.summary.metadataMismatchApplications >= 1);
    assert.ok(result.report.mismatches.some((item) => item.code === 'SUBSCRIPTION_PLAN_MISMATCH'));
    assert.ok(result.report.mismatches.some((item) => item.code === 'SUBSCRIPTION_API_MISMATCH'));
  });
}

async function testReconcileAcceptsLowercaseApplicationMetadataKeys() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async upsertApplicationMetadata(applicationId, metadata) {
          this._state.counts.upsertApplicationMetadata += Object.keys(metadata || {}).length;
          const app = this._state.applications.get(applicationId);
          if (app) {
            app.metadata = {
              ...(app.metadata || {}),
              ...Object.fromEntries(Object.entries(metadata || {}).map(([key, value]) => [key.toLowerCase(), value])),
            };
          }
          return { ok: true };
        },
      },
    });
    const config = makeConfig(dir);

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(imported.exitCode, 0);

    const result = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.ok(!result.report.mismatches.some((item) => item.code === 'APPLICATION_METADATA_MISMATCH'));
  });
}

async function testReconcileUsesSavedUserIdWhenEmailLookupMissesPaginatedUserSearch() {
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
        apiKeyContinuity: 'preserve-if-supported',
        existingUser: 'match-and-reuse',
        existingApplication: 'match-and-reuse',
        userProvisioning: 'reuse-or-create-silently',
      },
    });

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(imported.exitCode, 0);

    const realFindUserByEmail = client.findUserByEmail;
    client.findUserByEmail = async (email) => {
      if (email === 'alice@example.com') return null;
      return realFindUserByEmail.call(client, email);
    };
    client.getUser = async (userId) => (
      Array.from(client._state.users.values()).find((user) => user.id === userId) || null
    );

    const result = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.ok(!result.report.mismatches.some((item) => item.code === 'USER_MISSING'));
  });
}

async function testFullDeleteAndReimportCycleRemainsDeterministic() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir);

    const firstImport = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(firstImport.exitCode, 0);

    const firstReconcile = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(firstReconcile.exitCode, 0);

    const cleaned = await runDevelopersDeleteImported(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(cleaned.exitCode, 0);
    assert.strictEqual(cleaned.cleanup.report.summary.failed, 0);

    const secondImport = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(secondImport.exitCode, 0);
    assert.strictEqual(client._state.counts.createUser, 2);
    assert.strictEqual(client._state.counts.createApplication, 2);
    assert.strictEqual(client._state.counts.createSubscription, 2);

    const secondReconcile = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );
    assert.strictEqual(secondReconcile.exitCode, 0);
    assert.strictEqual(secondReconcile.report.summary.blockers, 0);
  });
}

async function testDeleteImportedRemovesSubscriptionsApplicationsAndUsers() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir);

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);

    const cleaned = await runDevelopersDeleteImported(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(cleaned.exitCode, 0);
    assert.strictEqual(client._state.counts.deleteSubscription, 1);
    assert.strictEqual(client._state.counts.deleteApplication, 1);
    assert.strictEqual(client._state.counts.deleteUser, 1);
    assert.strictEqual(cleaned.idMap.subscriptions['alice@example.com/orders-consumer/abc123def456/orders-product/orders-api::Orders API Key'], null);
    assert.strictEqual(cleaned.idMap.applications['alice@example.com/orders-consumer'], null);
    assert.strictEqual(cleaned.idMap.users['alice@example.com'], null);
    assert.strictEqual(cleaned.cleanup.report.summary.deleted, 3);
    assert.strictEqual(readJson(path.join(dir, 'report', 'developers-cleanup-report.json')).summary.deleted, 3);
  });
}

async function testDeleteImportedFallsBackToClosingSubscriptionsWhenDeleteUnsupported() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async deleteSubscription({ subscriptionId }) {
          const err = new Error(`DELETE subscription ${subscriptionId} → HTTP 405`);
          err.status = 405;
          err.body = { message: 'HTTP 405 Method Not Allowed' };
          throw err;
        },
      },
    });
    const config = makeConfig(dir);

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);

    const cleaned = await runDevelopersDeleteImported(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(cleaned.exitCode, 0);
    assert.strictEqual(client._state.counts.deleteApplication, 1);
    assert.strictEqual(client._state.counts.deleteUser, 1);
    assert.strictEqual(cleaned.idMap.subscriptions['alice@example.com/orders-consumer/abc123def456/orders-product/orders-api::Orders API Key'], null);
    assert.strictEqual(readJson(path.join(dir, 'report', 'developers-cleanup-report.json')).summary.failed, 0);
  });
}

async function testDeleteImportedRecoversTargetsFromSavedStateWhenIdMapWasPartiallyCleared() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async deleteSubscription({ subscriptionId }) {
          const err = new Error(`DELETE subscription ${subscriptionId} → HTTP 405`);
          err.status = 405;
          err.body = { message: 'HTTP 405 Method Not Allowed' };
          throw err;
        },
      },
    });
    const config = makeConfig(dir);
    const configPath = path.join(dir, 'config.json');
    writeJson(configPath, config);

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': configPath },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);

    const idMapPath = path.join(dir, 'state', 'developers-id-map.json');
    const savedIdMap = readJson(idMapPath);
    savedIdMap.users['alice@example.com'] = null;
    savedIdMap.applications['alice@example.com/orders-consumer'] = null;
    writeJson(idMapPath, savedIdMap);

    const cleaned = await runDevelopersDeleteImported(
      { 'ir-dir': irDir, 'config': configPath },
      { config, client },
    );

    assert.strictEqual(cleaned.exitCode, 0);
    assert.strictEqual(client._state.counts.deleteApplication, 1);
    assert.strictEqual(client._state.counts.deleteUser, 1);
    assert.strictEqual(cleaned.idMap.subscriptions['alice@example.com/orders-consumer/abc123def456/orders-product/orders-api::Orders API Key'], null);
    assert.strictEqual(cleaned.idMap.applications['alice@example.com/orders-consumer'], null);
    assert.strictEqual(cleaned.idMap.users['alice@example.com'], null);
    assert.strictEqual(readJson(path.join(dir, 'report', 'developers-cleanup-report.json')).summary.deleted, 3);
  });
}

async function testDeleteImportedSurfacesGraviteeUnavailableErrors() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient({
      overrides: {
        async deleteSubscription() {
          const err = new Error('');
          err.code = 'ECONNREFUSED';
          throw err;
        },
        async deleteApplication() {
          const err = new Error('');
          err.code = 'ECONNREFUSED';
          throw err;
        },
        async deleteUser() {
          const err = new Error('');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      },
    });
    const config = makeConfig(dir);

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);

    const cleaned = await runDevelopersDeleteImported(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(cleaned.exitCode, 4);
    assert.strictEqual(cleaned.cleanup.report.summary.failed, 3);
    for (const failure of cleaned.cleanup.report.failures) {
      assert.match(failure.error, /Unable to reach Gravitee while cleaning up/);
      assert.match(failure.error, /ECONNREFUSED/);
    }
  });
}

async function testMultiProductImportAndReconcile() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    addBillingProductToData(dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir, {
      productPlanMap: {
        'orders-product': {
          targetApi: 'orders-api',
          targetApiId: 'api-orders-1',
          targetPlan: 'Orders API Key',
          targetPlanId: 'plan-orders-1',
        },
        'billing-product': {
          targetApi: 'billing-api',
          targetApiId: 'api-billing-1',
          targetPlan: 'Billing API Key',
          targetPlanId: 'plan-billing-1',
        },
      },
    });

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);
    assert.strictEqual(client._state.counts.createSubscription, 2);

    const reconciled = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(reconciled.exitCode, 0);
    assert.strictEqual(reconciled.report.summary.checkedSubscriptions, 2);
  });
}

async function testMultiTargetProductImportAndReconcile() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);

    const client = makeWorkflowClient();
    const config = makeConfig(dir, {
      productPlanMap: {
        'orders-product': [
          {
            targetApi: 'orders-api',
            targetApiId: 'api-orders-1',
            targetPlan: 'Orders API Key',
            targetPlanId: 'plan-orders-1',
          },
          {
            targetApi: 'orders-audit-api',
            targetApiId: 'api-orders-audit-1',
            targetPlan: 'Orders Audit API Key',
            targetPlanId: 'plan-orders-audit-1',
          },
        ],
      },
    });

    const imported = await runDevelopersImport(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(imported.exitCode, 0);
    assert.strictEqual(client._state.counts.createSubscription, 2);
    assert.ok(imported.manifest.records.subscriptions.every((item) => item.productName === 'orders-product'));
    assert.ok(imported.manifest.records.subscriptions.some((item) => item.planTargets.length === 2));

    const reconciled = await runDevelopersReconcile(
      { 'ir-dir': irDir, 'config': path.join(dir, 'config.json') },
      { config, client },
    );

    assert.strictEqual(reconciled.exitCode, 0);
    assert.strictEqual(reconciled.report.summary.checkedSubscriptions, 2);
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
  await testPlanBlocksSubscriptionsForIncompatibleTargetPlanSecurity();
  await testPlanFailsWhenCapabilityProbeContradictsConfig();
  await testImportCreatesResourcesAndResumeSkipsRework();
  await testImportWritesApplicationMetadataPerApplication();
  await testImportOnlyWritesToolMetadataWithoutAppAttributes();
  await testApplicationMetadataReservedAndDuplicateKeys();
  await testImportSkipsDevelopersWithoutApps();
  await testImportRollsBackOrReusesUserAfterRoleAssignmentFailure();
  await testImportSucceedsWhenUserRoleReadIsUnsupported();
  await testImportReusesUserAfterCreateConflict();
  await testImportResolvesUserIdFromCreateConflictBody();
  await testImportContinuesIndependentActionsAfterUserFailureByDefault();
  await testImportUsesSavedUserIdWhenEmailLookupMisses();
  await testImportReusesExistingResourcesBySourceMarker();
  await testImportVerifiesApplicationMetadataFromScopedEndpoint();
  await testImportUpsertsMetadataForReusedApplications();
  await testImportDoesNotFailVerificationWhenMetadataReadbackIsUnavailable();
  await testReconcileWarnsWhenUserRoleReadIsUnsupported();
  await testImportFailsOnContinuityMismatch();
  await testInactiveDeveloperSkipPolicySkipsActions();
  await testInactiveDeveloperImportDisabledReusesDisabledUser();
  await testImportFailsWhenApplicationReuseMatchesWrongSourceMarker();
  await testReconcileDetectsMismatches();
  await testReconcileDetectsPartiallyDriftedTargetResources();
  await testReconcileAcceptsLowercaseApplicationMetadataKeys();
  await testReconcileUsesSavedUserIdWhenEmailLookupMissesPaginatedUserSearch();
  await testDeleteImportedRemovesSubscriptionsApplicationsAndUsers();
  await testDeleteImportedFallsBackToClosingSubscriptionsWhenDeleteUnsupported();
  await testDeleteImportedRecoversTargetsFromSavedStateWhenIdMapWasPartiallyCleared();
  await testDeleteImportedSurfacesGraviteeUnavailableErrors();
  await testFullDeleteAndReimportCycleRemainsDeterministic();
  await testMultiProductImportAndReconcile();
  await testMultiTargetProductImportAndReconcile();
  await testImportAndReconcileSupportMetadataOnlyOwnership();
  console.log('test-workflow.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
