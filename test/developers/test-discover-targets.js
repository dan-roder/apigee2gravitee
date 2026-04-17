'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runDiscoverDevelopersTargets } = require('../../src/developers/discover-targets');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DATA = path.join(PROJECT_ROOT, 'test', 'extractor', 'fixtures', 'data');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'developers-discover-targets-'));
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

function setCredentialAuthHints(irDir, developerEmail, appName, consumerKey, authHints) {
  const credentialPath = path.join(irDir, 'credentials', developerEmail, appName, `${consumerKey}.json`);
  const credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  credential.auth_hints = authHints;
  writeJson(credentialPath, credential);
}

function makeConfig(baseDir) {
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
    productPlanMap: {},
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

async function testDiscoverTargetsFindsExactMatchesAndCanWriteConfig() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(dir), null, 2));

    const client = {
      async listApis() {
        return [{ id: 'api-orders-1', name: 'orders-api' }];
      },
      async listApiPlans() {
        return [{ id: 'plan-orders-1', name: 'Orders API Key', security: { type: 'API_KEY' }, status: 'PUBLISHED' }];
      },
    };

    const result = await runDiscoverDevelopersTargets(
      { config: configPath, 'ir-dir': irDir, 'write-config': true },
      { client },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(result.report.summary.productsWithSingleValidTarget, ['orders-product']);
    assert.ok(fs.existsSync(result.reportPath));
    assert.ok(fs.existsSync(result.outputPath));
    const written = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));
    assert.strictEqual(written.productPlanMap['orders-product'].targetApiId, 'api-orders-1');
    assert.strictEqual(written.productPlanMap['orders-product'].targetPlanId, 'plan-orders-1');
  });
}

async function testDiscoverTargetsEmitsAmbiguityAndSecurityBlocking() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);
    setCredentialAuthHints(irDir, 'alice@example.com', 'orders-consumer', 'abc123def456', ['OAUTH2']);
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(dir), null, 2));

    const client = {
      async listApis() {
        return [
          { id: 'api-orders-1', name: 'orders-api' },
          { id: 'api-orders-2', name: 'Orders API' },
        ];
      },
      async listApiPlans(apiId) {
        if (apiId === 'api-orders-1') {
          return [{ id: 'plan-orders-key-1', name: 'Orders API Key', security: { type: 'API_KEY' }, status: 'PUBLISHED' }];
        }
        return [{ id: 'plan-orders-key-2', name: 'Orders API Key', security: { type: 'API_KEY' }, status: 'PUBLISHED' }];
      },
    };

    const result = await runDiscoverDevelopersTargets(
      { config: configPath, 'ir-dir': irDir },
      { client },
    );

    assert.strictEqual(result.exitCode, 2);
    assert.deepStrictEqual(result.report.summary.blockedProducts, ['orders-product']);
    assert.ok(result.report.findings.some((item) => item.code === 'DISCOVER_TARGET_NO_SUITABLE_PLAN'));
  });
}

async function testDiscoverTargetsCanPromptForManualSelectionAndWriteConfig() {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const irDir = path.join(dir, 'ir');
    const configPath = path.join(dir, 'developers.config.json');
    copyDir(FIXTURES_DATA, dataDir);
    generateIrFromData(dataDir, irDir);
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(dir), null, 2));

    const client = {
      async listApis() {
        return [
          { id: 'api-orders-manual-1', name: 'Orders Manual API' },
          { id: 'api-other-1', name: 'Other API' },
        ];
      },
      async listApiPlans(apiId) {
        if (apiId === 'api-orders-manual-1') {
          return [{ id: 'plan-orders-manual-1', name: 'Orders API Key', security: { type: 'API_KEY' }, status: 'PUBLISHED' }];
        }
        return [{ id: 'plan-other-1', name: 'Other Keyless', security: { type: 'KEY_LESS' }, status: 'PUBLISHED' }];
      },
    };

    const answers = ['1', '1'];
    const result = await runDiscoverDevelopersTargets(
      {
        config: configPath,
        'ir-dir': irDir,
        'write-config': true,
        'prompt-matches': true,
        __prompt: async () => answers.shift(),
      },
      { client },
    );

    assert.strictEqual(result.outputPath, path.resolve(configPath.replace(/\.json$/, '.resolved.json')));
    const written = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));
    assert.strictEqual(written.productPlanMap['orders-product'].targetApiId, 'api-orders-manual-1');
    assert.strictEqual(written.productPlanMap['orders-product'].targetPlanId, 'plan-orders-manual-1');
    assert.strictEqual(result.report.promptedSelections.length, 1);
  });
}

async function run() {
  await testDiscoverTargetsFindsExactMatchesAndCanWriteConfig();
  await testDiscoverTargetsEmitsAmbiguityAndSecurityBlocking();
  await testDiscoverTargetsCanPromptForManualSelectionAndWriteConfig();
  console.log('test-discover-targets.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
