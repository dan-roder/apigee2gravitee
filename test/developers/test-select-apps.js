'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadDeveloperDomain } = require('../../src/developers/developer-loader');
const {
  parseSelectionAnswer,
  runSelectDevelopersApps,
} = require('../../src/developers/select-apps');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-select-apps-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig(baseDir, overrides = {}) {
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
    ...overrides,
  };
}

function fakeLoader() {
  return {
    developers() {
      return [
        { email: 'active@example.com', status: 'active' },
        { email: 'inactive@example.com', status: 'inactive' },
      ];
    },
    apps() {
      return [
        { developer_email: 'active@example.com', name: 'orders-app', status: 'approved' },
        { developer_email: 'active@example.com', name: 'billing-app', status: 'approved' },
        { developer_email: 'inactive@example.com', name: 'legacy-app', status: 'revoked' },
      ];
    },
    credentials() {
      return [
        {
          developer_email: 'active@example.com',
          app_name: 'orders-app',
          consumer_key: 'key-orders',
          api_products: [{ name: 'orders-product' }],
        },
        {
          developer_email: 'active@example.com',
          app_name: 'billing-app',
          consumer_key: 'key-billing',
          api_products: [{ name: 'billing-product' }],
        },
        {
          developer_email: 'inactive@example.com',
          app_name: 'legacy-app',
          consumer_key: 'key-legacy',
          api_products: [{ name: 'legacy-product' }],
        },
      ];
    },
  };
}

function writeMinimalIr(irDir) {
  writeJson(path.join(irDir, 'developers', 'active.json'), { email: 'active@example.com', status: 'active' });
  writeJson(path.join(irDir, 'developers', 'inactive.json'), { email: 'inactive@example.com', status: 'inactive' });
  writeJson(path.join(irDir, 'apps', 'orders.json'), {
    developer_email: 'active@example.com',
    name: 'orders-app',
    status: 'approved',
    credentials: [{ consumer_key: 'key-orders' }],
  });
  writeJson(path.join(irDir, 'apps', 'legacy.json'), {
    developer_email: 'inactive@example.com',
    name: 'legacy-app',
    status: 'approved',
    credentials: [{ consumer_key: 'key-legacy' }],
  });
  writeJson(path.join(irDir, 'credentials', 'orders.json'), {
    developer_email: 'active@example.com',
    app_name: 'orders-app',
    consumer_key: 'key-orders',
    status: 'approved',
    api_products: [{ name: 'orders-product', status: 'approved' }],
  });
  writeJson(path.join(irDir, 'credentials', 'legacy.json'), {
    developer_email: 'inactive@example.com',
    app_name: 'legacy-app',
    consumer_key: 'key-legacy',
    status: 'approved',
    api_products: [{ name: 'legacy-product', status: 'approved' }],
  });
  writeJson(path.join(irDir, 'references', 'subscription-intent.json'), {
    credentials: [
      {
        credentialId: 'active@example.com/orders-app/key-orders',
        productAssociations: [{
          productName: 'orders-product',
          sourceStatus: 'approved',
          recommendedAction: 'create-subscription',
          targetStatusHint: 'ACCEPTED',
        }],
      },
      {
        credentialId: 'inactive@example.com/legacy-app/key-legacy',
        productAssociations: [{
          productName: 'legacy-product',
          sourceStatus: 'approved',
          recommendedAction: 'create-subscription',
          targetStatusHint: 'ACCEPTED',
        }],
      },
    ],
  });
}

function testSelectionParser() {
  assert.deepStrictEqual(parseSelectionAnswer('1', 5).indexes, [1]);
  assert.deepStrictEqual(parseSelectionAnswer('1,3-5', 5).indexes, [1, 3, 4, 5]);
  assert.deepStrictEqual(parseSelectionAnswer('a', 3).indexes, [1, 2, 3]);
  assert.deepStrictEqual(parseSelectionAnswer('n', 3).indexes, []);
  assert.deepStrictEqual(parseSelectionAnswer('', 3, [2]).indexes, [2]);
  assert.strictEqual(parseSelectionAnswer('s', 3, [1]).kind, 'skip');
  assert.throws(() => parseSelectionAnswer('0', 3), /out of range/);
  assert.throws(() => parseSelectionAnswer('4', 3), /out of range/);
  assert.throws(() => parseSelectionAnswer('3-1', 3), /invalid selection range/);
  assert.throws(() => parseSelectionAnswer('x', 3), /invalid selection token/);
}

async function testWriteConfigAndReport() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.resolved.json');
    writeJson(configPath, makeConfig(dir));
    const result = await runSelectDevelopersApps({
      'ir-dir': path.join(dir, 'ir'),
      config: configPath,
      'write-config': true,
    }, {
      loader: fakeLoader(),
      prompt: async () => '1,3',
    });

    assert.strictEqual(result.exitCode, 0);
    const updated = readJson(configPath);
    assert.deepStrictEqual(updated.filters.includeApps, [
      'active@example.com/billing-app',
      'inactive@example.com/legacy-app',
    ]);
    assert.strictEqual(result.report.summary.totalAppsDiscovered, 3);
    assert.strictEqual(result.report.summary.selectedApps, 2);
    assert.strictEqual(result.report.summary.excludedApps, 1);
    assert.deepStrictEqual(result.report.missingProductPlanMappings, ['billing-product', 'legacy-product']);
    assert.ok(fs.existsSync(result.reportPath));
  });
}

async function testExistingSelectionCanBeReplaced() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.resolved.json');
    writeJson(configPath, makeConfig(dir, {
      filters: {
        includeDevelopers: [],
        excludeDevelopers: [],
        includeApps: ['active@example.com/orders-app'],
        excludeApps: [],
      },
    }));
    const result = await runSelectDevelopersApps({
      'ir-dir': path.join(dir, 'ir'),
      config: configPath,
      'write-config': true,
    }, {
      loader: fakeLoader(),
      prompt: async () => '2',
    });

    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(readJson(configPath).filters.includeApps, ['active@example.com/orders-app']);
  });
}

async function testClearSelection() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'developers.config.resolved.json');
    writeJson(configPath, makeConfig(dir, {
      filters: {
        includeDevelopers: [],
        excludeDevelopers: [],
        includeApps: ['active@example.com/orders-app'],
        excludeApps: [],
      },
    }));

    const result = await runSelectDevelopersApps({
      'ir-dir': path.join(dir, 'ir'),
      config: configPath,
      'clear-selection': true,
    }, {
      loader: fakeLoader(),
    });

    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(readJson(configPath).filters.includeApps, []);
    assert.strictEqual(result.report.cleared, true);
  });
}

async function testLoaderUsesSelectedApps() {
  await withTempDir(async (dir) => {
    const irDir = path.join(dir, 'ir');
    writeMinimalIr(irDir);
    const config = makeConfig(dir, {
      productPlanMap: {
        'orders-product': {
          targetApi: 'orders-api',
          targetApiId: 'api-orders',
          targetPlan: 'Orders API Key',
          targetPlanId: 'plan-orders',
        },
        'legacy-product': {
          targetApi: 'legacy-api',
          targetApiId: 'api-legacy',
          targetPlan: 'Legacy API Key',
          targetPlanId: 'plan-legacy',
        },
      },
      filters: {
        includeDevelopers: [],
        excludeDevelopers: [],
        includeApps: ['active@example.com/orders-app'],
        excludeApps: [],
      },
    });

    const domain = loadDeveloperDomain(irDir, config);
    assert.deepStrictEqual(domain.users.map((item) => item.email), ['active@example.com']);
    assert.deepStrictEqual(domain.applications.map((item) => item.sourceId), ['active@example.com/orders-app']);
    assert.deepStrictEqual(domain.credentials.map((item) => item.sourceId), ['active@example.com/orders-app/key-orders']);
    assert.strictEqual(domain.subscriptions.length, 1);
    assert.strictEqual(domain.subscriptions[0].developerEmail, 'active@example.com');
  });
}

async function testCliOutputIncludesNextCommand() {
  await withTempDir(async (dir) => {
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.resolved.json');
    writeMinimalIr(irDir);
    writeJson(configPath, makeConfig(dir));

    const result = spawnSync(
      'node',
      [
        'bin/migrator.js',
        'developers',
        'select-apps',
        '--ir-dir',
        irDir,
        '--config',
        configPath,
        '--write-config',
      ],
      {
        cwd: PROJECT_ROOT,
        input: '1\n',
        encoding: 'utf8',
      },
    );

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('Developers select-apps'));
    assert.ok(result.stdout.includes('Next step'));
    assert.ok(result.stdout.includes('validate-config-targets'));
  });
}

(async () => {
  testSelectionParser();
  await testWriteConfigAndReport();
  await testExistingSelectionCanBeReplaced();
  await testClearSelection();
  await testLoaderUsesSelectedApps();
  await testCliOutputIncludesNextCommand();
  console.log('developers select-apps tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
