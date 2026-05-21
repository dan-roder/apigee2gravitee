'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSyncDevelopersLiveIds } = require('../../src/developers/sync-live-ids');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-sync-live-ids-'));
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
      applicationOwnership: 'metadata-only',
    },
    productPlanMap: {
      'orders-product': {
        targetApi: 'orders-api',
        targetApiId: 'api-orders',
        targetPlan: 'Orders API Key',
        targetPlanId: 'plan-orders',
      },
    },
    filters: {
      includeDevelopers: [],
      excludeDevelopers: [],
      includeApps: [],
      excludeApps: [],
    },
    reporting: {
      reportDir: path.join(baseDir, 'report'),
      stateFile: path.join(baseDir, 'state', 'developers-import-state.json'),
    },
  };
}

function makeDomain() {
  const planMapping = {
    productName: 'orders-product',
    targetApi: 'orders-api',
    targetApiId: 'api-orders',
    targetPlan: 'Orders API Key',
    targetPlanId: 'plan-orders',
    targetKey: 'orders-api::Orders API Key',
  };
  return {
    irDir: '/tmp/ir',
    manifest: { extracted_at: '2026-01-01T00:00:00.000Z' },
    extractionReport: {},
    references: {},
    inventories: {},
    products: [],
    users: [{
      sourceId: 'alice@example.com',
      email: 'alice@example.com',
      status: 'active',
      blockers: [],
      warnings: [],
      manualReviewReasons: [],
    }],
    applications: [{
      sourceId: 'alice@example.com/orders-consumer',
      developerEmail: 'alice@example.com',
      developerStatus: 'active',
      appName: 'orders-consumer',
      status: 'approved',
      lookupHints: {
        name: 'orders-consumer',
        ownerHint: 'alice@example.com',
        sourceId: 'alice@example.com/orders-consumer',
      },
      metadata: {},
      blockers: [],
      warnings: [],
      manualReviewReasons: [],
      ownershipStrategy: 'metadata-only',
    }],
    credentials: [],
    subscriptions: [{
      sourceId: 'alice@example.com/orders-consumer/key/orders-product/orders-api::Orders API Key',
      developerEmail: 'alice@example.com',
      developerStatus: 'active',
      appName: 'orders-consumer',
      productName: 'orders-product',
      recommendedAction: 'CREATE_SUBSCRIPTION',
      planMapping,
      planTargets: [planMapping],
      blockers: [],
      warnings: [],
      manualReviewReasons: [],
    }],
    completeness: {
      manifestPresent: true,
      extractionReportPresent: true,
      subscriptionIntentPresent: true,
      credentialContinuityPresent: true,
      inactiveImpactPresent: true,
    },
  };
}

function makeClient() {
  return {
    async healthCheck() { return { ok: true }; },
    async verifyEnvironmentAccess() { return { ok: true }; },
    async listRoles() { return new Set(['ORGANIZATION:USER', 'ENVIRONMENT:API_CONSUMER']); },
    async listCustomFields() { return new Set(); },
    async findUserByEmail(email) {
      return email === 'alice@example.com' ? { id: 'user-live', email } : null;
    },
    async findApplicationByNameAndOwnerHint({ sourceId }) {
      return sourceId === 'alice@example.com/orders-consumer'
        ? { id: 'app-live', name: 'orders-consumer', metadata: { sourceId } }
        : null;
    },
    async findPlan(mapping) {
      return { id: mapping.targetPlanId, apiId: mapping.targetApiId, name: mapping.targetPlan };
    },
    async findSubscription({ applicationId, apiId, planId }) {
      if (applicationId === 'app-live' && apiId === 'api-orders' && planId === 'plan-orders') {
        return { id: 'sub-live' };
      }
      return null;
    },
  };
}

async function testReportOnlyDoesNotWriteIdMap() {
  await withTempDir(async (dir) => {
    const result = await runSyncDevelopersLiveIds(
      { 'ir-dir': path.join(dir, 'ir'), config: path.join(dir, 'config.json') },
      { config: makeConfig(dir), domain: makeDomain(), client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.wroteIdMap, false);
    assert.strictEqual(result.report.summary.users.matched, 1);
    assert.strictEqual(result.report.summary.applications.matched, 1);
    assert.strictEqual(result.report.summary.subscriptions.matched, 1);
    assert.ok(fs.existsSync(result.reportPath));
    assert.ok(!fs.existsSync(result.outputPaths.idMap));
  });
}

async function testWriteIdMapRefreshesLiveIds() {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const idMapPath = path.join(dir, 'state', 'developers-id-map.json');
    writeJson(idMapPath, {
      generatedAt: 'old',
      users: { 'alice@example.com': 'user-old' },
      applications: { 'alice@example.com/orders-consumer': 'app-old' },
      subscriptions: {
        'alice@example.com/orders-consumer/key/orders-product/orders-api::Orders API Key': 'sub-old',
      },
    });

    const result = await runSyncDevelopersLiveIds(
      { 'ir-dir': path.join(dir, 'ir'), config: path.join(dir, 'config.json'), 'write-id-map': true },
      { config, domain: makeDomain(), client: makeClient() },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.wroteIdMap, true);
    assert.strictEqual(result.report.summary.users.updated, 1);
    assert.strictEqual(result.report.summary.applications.updated, 1);
    assert.strictEqual(result.report.summary.subscriptions.updated, 1);
    const idMap = readJson(idMapPath);
    assert.strictEqual(idMap.users['alice@example.com'], 'user-live');
    assert.strictEqual(idMap.applications['alice@example.com/orders-consumer'], 'app-live');
    assert.strictEqual(idMap.subscriptions['alice@example.com/orders-consumer/key/orders-product/orders-api::Orders API Key'], 'sub-live');
    assert.strictEqual(idMap.updatedBy, 'developers sync-live-ids');
  });
}

async function testWriteIdMapKeepsSearchInvisibleUserWhenPreviousIdResolves() {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const idMapPath = path.join(dir, 'state', 'developers-id-map.json');
    writeJson(idMapPath, {
      generatedAt: 'old',
      users: { 'alice@example.com': 'user-hidden' },
      applications: {},
      subscriptions: {},
    });
    const client = {
      ...makeClient(),
      async findUserByEmail() { return null; },
      async getUser(userId) {
        return userId === 'user-hidden' ? { id: userId, email: 'alice@example.com' } : null;
      },
      async findApplicationByNameAndOwnerHint() { return null; },
    };

    const result = await runSyncDevelopersLiveIds(
      { 'ir-dir': path.join(dir, 'ir'), config: path.join(dir, 'config.json'), 'write-id-map': true },
      { config, domain: makeDomain(), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.report.users[0].status, 'matched');
    assert.strictEqual(result.report.users[0].strategy, 'previous-id');
    const idMap = readJson(idMapPath);
    assert.strictEqual(idMap.users['alice@example.com'], 'user-hidden');
  });
}

async function testWriteIdMapRecoversSearchInvisibleUserFromPreviousReport() {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const idMapPath = path.join(dir, 'state', 'developers-id-map.json');
    writeJson(idMapPath, {
      generatedAt: 'old',
      users: { 'alice@example.com': null },
      applications: {},
      subscriptions: {},
    });
    writeJson(path.join(dir, 'report', 'developers-live-id-sync-report.json'), {
      users: [{
        kind: 'user',
        sourceId: 'alice@example.com',
        previousId: 'user-from-previous-report',
        liveId: null,
        status: 'missing-with-existing-id',
      }],
    });
    const client = {
      ...makeClient(),
      async findUserByEmail() { return null; },
      async getUser(userId) {
        return userId === 'user-from-previous-report' ? { id: userId, email: 'alice@example.com' } : null;
      },
      async findApplicationByNameAndOwnerHint() { return null; },
    };

    const result = await runSyncDevelopersLiveIds(
      { 'ir-dir': path.join(dir, 'ir'), config: path.join(dir, 'config.json'), 'write-id-map': true },
      { config, domain: makeDomain(), client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.report.users[0].status, 'matched');
    assert.strictEqual(result.report.users[0].strategy, 'previous-id');
    const idMap = readJson(idMapPath);
    assert.strictEqual(idMap.users['alice@example.com'], 'user-from-previous-report');
  });
}

async function testClearMissingNullsMissingIds() {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const idMapPath = path.join(dir, 'state', 'developers-id-map.json');
    writeJson(idMapPath, {
      generatedAt: 'old',
      users: { 'alice@example.com': 'user-old' },
      applications: { 'alice@example.com/orders-consumer': 'app-old' },
      subscriptions: {},
    });
    const client = {
      ...makeClient(),
      async findUserByEmail() { return null; },
      async findApplicationByNameAndOwnerHint() { return null; },
    };

    const result = await runSyncDevelopersLiveIds(
      { 'ir-dir': path.join(dir, 'ir'), config: path.join(dir, 'config.json'), 'write-id-map': true, 'clear-missing': true },
      { config, domain: makeDomain(), client },
    );

    assert.strictEqual(result.exitCode, 0);
    const idMap = readJson(idMapPath);
    assert.strictEqual(idMap.users['alice@example.com'], null);
    assert.strictEqual(idMap.applications['alice@example.com/orders-consumer'], null);
    assert.strictEqual(result.report.summary.users['missing-with-existing-id'], 1);
    assert.strictEqual(result.report.summary.applications['missing-with-existing-id'], 1);
  });
}

(async () => {
  await testReportOnlyDoesNotWriteIdMap();
  await testWriteIdMapRefreshesLiveIds();
  await testWriteIdMapKeepsSearchInvisibleUserWhenPreviousIdResolves();
  await testWriteIdMapRecoversSearchInvisibleUserFromPreviousReport();
  await testClearMissingNullsMissingIds();
  console.log('test-sync-live-ids.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
