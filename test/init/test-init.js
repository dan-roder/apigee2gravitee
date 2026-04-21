'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runInitCommand } = require('../../src/init');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-init-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function copyExamples(projectRoot, targetDir) {
  fs.mkdirSync(path.join(targetDir, 'config'), { recursive: true });
  fs.copyFileSync(
    path.join(projectRoot, 'config', 'apis.config.example.json'),
    path.join(targetDir, 'config', 'apis.config.example.json'),
  );
  fs.copyFileSync(
    path.join(projectRoot, 'config', 'developers.config.example.json'),
    path.join(targetDir, 'config', 'developers.config.example.json'),
  );
}

function makePrompter(answers, confirmations = []) {
  let answerIndex = 0;
  let confirmIndex = 0;
  return {
    async ask(_prompt, defaultValue) {
      if (answerIndex >= answers.length) return defaultValue || '';
      return answers[answerIndex++];
    },
    async confirm() {
      if (confirmIndex >= confirmations.length) return false;
      return confirmations[confirmIndex++];
    },
    close() {},
  };
}

async function testInitWritesConfigs() {
  const projectRoot = path.resolve(__dirname, '..', '..');
  await withTempDir(async (dir) => {
    copyExamples(projectRoot, dir);

    const result = await runInitCommand({}, null, {
      cwd: dir,
      prompter: makePrompter([
        'https://gravitee.local',
        'ORG1',
        'ENV1',
      ]),
    });

    assert.strictEqual(result.exitCode, 0);
    const apisConfig = readJson(path.join(dir, 'config', 'apis.config.json'));
    const developersConfig = readJson(path.join(dir, 'config', 'developers.config.json'));
    const developersResolved = readJson(path.join(dir, 'config', 'developers.config.resolved.json'));

    assert.strictEqual(apisConfig.gravitee.url, 'https://gravitee.local');
    assert.strictEqual(apisConfig.gravitee.orgId, 'ORG1');
    assert.strictEqual(apisConfig.gravitee.envId, 'ENV1');
    assert.strictEqual(developersConfig.gravitee.url, 'https://gravitee.local');
    assert.strictEqual(developersResolved.gravitee.envId, 'ENV1');
    assert.ok(result.writes.every((item) => item.status === 'written'));
  });
}

async function testInitSkipsExistingFilesWhenOverwriteDeclined() {
  const projectRoot = path.resolve(__dirname, '..', '..');
  await withTempDir(async (dir) => {
    copyExamples(projectRoot, dir);
    fs.writeFileSync(
      path.join(dir, 'config', 'apis.config.json'),
      `${JSON.stringify({ gravitee: { url: 'https://keep.example.com', orgId: 'KEEP', envId: 'KEEP' } }, null, 2)}\n`,
    );

    const result = await runInitCommand({}, null, {
      cwd: dir,
      prompter: makePrompter(
        ['https://gravitee.changed', 'ORG2', 'ENV2'],
        [false, true, true],
      ),
    });

    const apisConfig = readJson(path.join(dir, 'config', 'apis.config.json'));
    assert.strictEqual(apisConfig.gravitee.url, 'https://keep.example.com');
    assert.strictEqual(result.writes[0].status, 'skipped');
    assert.strictEqual(result.writes[1].status, 'written');
    assert.strictEqual(result.writes[2].status, 'written');
  });
}

async function run() {
  await testInitWritesConfigs();
  await testInitSkipsExistingFilesWhenOverwriteDeclined();
  console.log('test-init.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
