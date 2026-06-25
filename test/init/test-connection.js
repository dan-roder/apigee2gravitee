'use strict';

const assert = require('assert');

const { runTestConnectionCommand, classifyFailure } = require('../../src/test-connection');

async function testSuccessfulConnection() {
  const result = await runTestConnectionCommand({}, {
    config: {
      gravitee: {
        url: 'https://gravitee.example.com',
        orgId: 'ORG',
        envId: 'ENV',
      },
    },
    client: {
      async healthCheck() { return { ok: true }; },
      async verifyEnvironmentAccess() { return { ok: true }; },
    },
  });

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.checks.organization.ok, true);
  assert.strictEqual(result.checks.environment.ok, true);
}

async function testOrganizationFailureSkipsEnvironment() {
  let environmentChecked = false;
  const result = await runTestConnectionCommand({}, {
    config: {
      gravitee: {
        url: 'https://bad.example.com',
        orgId: 'ORG',
        envId: 'ENV',
      },
    },
    client: {
      async healthCheck() { return { ok: false, status: 404, error: 'Not found' }; },
      async verifyEnvironmentAccess() {
        environmentChecked = true;
        return { ok: true };
      },
    },
  });

  assert.strictEqual(result.exitCode, 2);
  assert.strictEqual(environmentChecked, false);
  assert.strictEqual(result.checks.organization.classification, 'not-found');
  assert.strictEqual(result.checks.environment.skipped, true);
}

async function testBareTokenFlagIsRejected() {
  await assert.rejects(
    () => runTestConnectionCommand({ 'gravitee-token': true }, {
      config: {
        gravitee: {
          url: 'https://gravitee.example.com',
          orgId: 'ORG',
          envId: 'ENV',
        },
      },
    }),
    /Gravitee token is required/,
  );
}

function testFailureClassification() {
  assert.strictEqual(classifyFailure({ status: 401 }), 'authentication');
  assert.strictEqual(classifyFailure({ error: 'getaddrinfo ENOTFOUND gravitee.example.com' }), 'network');
}

async function run() {
  await testSuccessfulConnection();
  await testOrganizationFailureSkipsEnvironment();
  await testBareTokenFlagIsRejected();
  testFailureClassification();
  console.log('test-connection.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
