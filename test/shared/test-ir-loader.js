'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IrLoader } = require('../../src/shared/ir-loader');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function writeText(filePath, payload) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, payload);
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-loader-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testLoadsRicherDeveloperMigrationInputs() {
  withTempDir((irDir) => {
    writeJson(path.join(irDir, 'manifest.json'), { extractedAt: '2026-03-31T00:00:00Z' });
    writeJson(path.join(irDir, 'extraction-report.json'), { summary: { failedArtifactCount: 0 } });
    writeJson(
      path.join(irDir, 'credentials', 'alice@example.com', 'orders-consumer', 'abc123.json'),
      { consumerKey: 'abc123', appName: 'orders-consumer' },
    );
    writeJson(path.join(irDir, 'inventories', 'credentials.json'), { items: [{ id: 'abc123' }] });
    writeJson(path.join(irDir, 'references', 'subscription-intent.json'), {
      credentials: [{ credentialId: 'alice@example.com/orders-consumer/abc123' }],
    });
    writeJson(
      path.join(irDir, '_protected', 'credentials', 'alice@example.com', 'orders-consumer', 'abc123', 'secret-meta.json'),
      { consumerKey: 'abc123' },
    );
    writeText(
      path.join(irDir, '_protected', 'credentials', 'alice@example.com', 'orders-consumer', 'abc123', 'consumer-secret.txt'),
      'super-secret',
    );

    const loader = new IrLoader(irDir);

    assert.deepStrictEqual(loader.extractionReport(), { summary: { failedArtifactCount: 0 } });
    assert.deepStrictEqual(loader.credentials(), [{ consumerKey: 'abc123', appName: 'orders-consumer' }]);
    assert.deepStrictEqual(loader.inventory('credentials'), { items: [{ id: 'abc123' }] });
    assert.deepStrictEqual(loader.reference('subscription-intent'), {
      credentials: [{ credentialId: 'alice@example.com/orders-consumer/abc123' }],
    });
    assert.deepStrictEqual(loader.credentialSecretMeta('alice@example.com', 'orders-consumer', 'abc123'), {
      consumerKey: 'abc123',
    });
    assert.strictEqual(loader.credentialSecret('alice@example.com', 'orders-consumer', 'abc123'), 'super-secret');
  });
}

function testReturnsAllInventoriesAndReferencesByName() {
  withTempDir((irDir) => {
    writeJson(path.join(irDir, 'inventories', 'developers.json'), { items: ['alice@example.com'] });
    writeJson(path.join(irDir, 'inventories', 'apps.json'), { items: ['orders-consumer'] });
    writeJson(path.join(irDir, 'references', 'inactive-impact.json'), { inactiveDevelopers: [] });
    writeJson(path.join(irDir, 'references', 'credential-continuity-index.json'), { credentials: [] });

    const loader = new IrLoader(irDir);

    assert.deepStrictEqual(loader.inventories(), {
      apps: { items: ['orders-consumer'] },
      developers: { items: ['alice@example.com'] },
    });
    assert.deepStrictEqual(loader.references(), {
      'credential-continuity-index': { credentials: [] },
      'inactive-impact': { inactiveDevelopers: [] },
    });
  });
}

testLoadsRicherDeveloperMigrationInputs();
testReturnsAllInventoriesAndReferencesByName();

console.log('test-ir-loader.js passed');
