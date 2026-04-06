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

async function run() {
  await testFindUserByEmailFiltersResults();
  await testCreateSubscriptionUsesV2Endpoint();
  await testFindPlanByIdUsesExpectedEndpoint();
  await testFindApplicationPrefersSourceMarker();
  await testNormalizeCollectionSupportsItemsShape();
  await testFindApiByNameFiltersExactName();
  await testFindPlanResolvesApiByNameWhenIdMissing();
  console.log('test-gravitee-client.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
