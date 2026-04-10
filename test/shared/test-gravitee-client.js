'use strict';

const assert = require('assert');

const { GraviteeClient, normalizeCollection } = require('../../src/shared/gravitee-client');

async function testFindUserByEmailFiltersResults() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.get = async () => ({ data: [{ id: '1', email: 'alice@example.com' }, { id: '2', email: 'bob@example.com' }] });
  const user = await client.findUserByEmail('bob@example.com');
  assert.strictEqual(user.id, '2');
}

async function testCreateSubscriptionUsesV2Endpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  let called = null;
  client.post = async (url, body) => {
    called = { url, body };
    return { id: 'sub-1' };
  };
  await client.createSubscription({ apiId: 'api-1', applicationId: 'app-1', planId: 'plan-1' });
  assert.strictEqual(called.url, 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis/api-1/subscriptions');
  assert.deepStrictEqual(called.body, { applicationId: 'app-1', planId: 'plan-1' });
}

async function testFindPlanByIdUsesExpectedEndpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  let called = null;
  client.get = async (url) => {
    called = url;
    return { id: 'plan-1', apiId: 'api-1' };
  };
  const plan = await client.findPlan({ targetApiId: 'api-1', targetPlanId: 'plan-1', targetPlan: 'Orders' });
  assert.strictEqual(called, 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis/api-1/plans/plan-1');
  assert.strictEqual(plan.id, 'plan-1');
}

async function testFindApplicationPrefersSourceMarker() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.listApplications = async () => ([
    { id: 'app-1', name: 'Orders', metadata: { sourceId: 'someone@example.com/Orders', developerEmail: 'someone@example.com' } },
    { id: 'app-2', name: 'Orders', metadata: { sourceId: 'alice@example.com/Orders', developerEmail: 'alice@example.com' } },
  ]);
  const app = await client.findApplicationByNameAndOwnerHint({
    name: 'Orders',
    ownerHint: 'alice@example.com',
    sourceId: 'alice@example.com/Orders',
  });
  assert.strictEqual(app.id, 'app-2');
}

async function testNormalizeCollectionSupportsItemsShape() {
  const items = normalizeCollection({ items: [{ id: 'a' }] });
  assert.deepStrictEqual(items, [{ id: 'a' }]);
}

async function testFindApiByNameFiltersExactName() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.listApis = async () => ([
    { id: 'api-1', name: 'Orders API' },
    { id: 'api-2', name: 'Billing API' },
  ]);
  const api = await client.findApiByName('Billing API');
  assert.strictEqual(api.id, 'api-2');
}

async function testFindPlanResolvesApiByNameWhenIdMissing() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.findApiByName = async (name) => ({ id: 'api-1', name });
  client.listApiPlans = async (apiId) => ([
    { id: 'plan-1', apiId, name: 'Orders API Key' },
  ]);
  const plan = await client.findPlan({ targetApi: 'Orders API', targetPlan: 'Orders API Key' });
  assert.strictEqual(plan.id, 'plan-1');
  assert.strictEqual(plan.apiId, 'api-1');
}

async function testCreateApiPlanNormalizesPlanPayload() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  let called = null;
  client.post = async (url, body) => {
    called = { url, body };
    return { id: 'plan-1' };
  };
  await client.createApiPlan('api-1', {
    name: 'Keyless Plan',
    security: { type: 'KEY_LESS' },
    flows: [],
  });
  assert.strictEqual(called.url, 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis/api-1/plans');
  assert.strictEqual(called.body.name, 'Keyless Plan');
  assert.strictEqual(called.body.definitionVersion, 'V4');
  assert.deepStrictEqual(called.body.security, { type: 'KEY_LESS' });
  assert.deepStrictEqual(called.body.flows, []);
}

async function testCreateApplicationCustomFieldUsesApplicationsMetadataEndpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  let called = null;
  client.postOrIgnoreConflict = async (url, body) => {
    called = { url, body };
    return { key: body.key || body.name };
  };
  await client.createApplicationCustomField('DisplayName');
  assert.strictEqual(called.url, 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/applications/metadata');
  assert.strictEqual(called.body.key, 'DisplayName');
  assert.strictEqual(called.body.format, 'STRING');
}

async function testDeleteUserUsesExpectedEndpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  let called = null;
  client.delete = async (url) => {
    called = url;
    return { ok: true };
  };
  await client.deleteUser('user-1');
  assert.strictEqual(called, 'https://gravitee.example.com/management/organizations/DEFAULT/users/user-1');
}

async function testAssignUserRolesFallsBackAcrossPayloadShapes() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.put = async (url, body) => {
    calls.push({ url, body });
    if (calls.length < 2) {
      const err = new Error(`PUT ${url} → HTTP 500`);
      err.status = 500;
      err.body = { message: 'boom' };
      throw err;
    }
    return { ok: true };
  };
  const response = await client.assignUserRoles('user-1', {
    organization: ['ORGANIZATION:USER'],
    environment: ['ENVIRONMENT:API_CONSUMER'],
  });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, 'https://gravitee.example.com/management/organizations/DEFAULT/users/user-1/roles');
  assert.deepStrictEqual(calls[1].body, {
    ORGANIZATION: ['ORGANIZATION:USER'],
    ENVIRONMENT: ['ENVIRONMENT:API_CONSUMER'],
  });
  assert.strictEqual(response._strategy, 'scoped-object-uppercase');
}

async function run() {
  await testFindUserByEmailFiltersResults();
  await testCreateSubscriptionUsesV2Endpoint();
  await testFindPlanByIdUsesExpectedEndpoint();
  await testFindApplicationPrefersSourceMarker();
  await testNormalizeCollectionSupportsItemsShape();
  await testFindApiByNameFiltersExactName();
  await testFindPlanResolvesApiByNameWhenIdMissing();
  await testCreateApiPlanNormalizesPlanPayload();
  await testCreateApplicationCustomFieldUsesApplicationsMetadataEndpoint();
  await testDeleteUserUsesExpectedEndpoint();
  await testAssignUserRolesFallsBackAcrossPayloadShapes();
  console.log('test-gravitee-client.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
