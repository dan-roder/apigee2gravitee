'use strict';

const assert = require('assert');

const { GraviteeClient, normalizeCollection } = require('../../src/shared/gravitee-client');

async function testFindUserByEmailFiltersResults() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.get = async () => ({ data: [{ id: '1', email: 'alice@example.com' }, { id: '2', email: 'bob@example.com' }] });
  const user = await client.findUserByEmail('bob@example.com');
  assert.strictEqual(user.id, '2');
}

async function testFindUserByEmailUsesEnvironmentSearchEndpointFirst() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?q=dev2%40540.co') {
      return { data: [{ id: 'user-2', email: 'dev2@540.co' }] };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const user = await client.findUserByEmail('dev2@540.co');
  assert.strictEqual(user.id, 'user-2');
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?q=dev2%40540.co',
  ]);
}

async function testFindUserByEmailFollowsPaginatedSearchResults() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?q=dev2%40540.co') {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?query=dev2%40540.co') {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/users?query=dev2%40540.co') {
      return {
        data: Array.from({ length: 10 }, (_, index) => ({ id: `user-${index + 1}`, email: `dev2${index}@540.co` })),
        page: 1,
        size: 10,
        total: 12,
      };
    }
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/users?query=dev2%40540.co&page=2&size=10') {
      return {
        data: [
          { id: 'user-11', email: 'dev200@540.co' },
          { id: 'user-12', email: 'dev2@540.co' },
        ],
        page: 2,
        size: 10,
        total: 12,
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const user = await client.findUserByEmail('dev2@540.co');
  assert.strictEqual(user.id, 'user-12');
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?q=dev2%40540.co',
    'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?query=dev2%40540.co',
    'https://gravitee.example.com/management/organizations/DEFAULT/users?query=dev2%40540.co',
    'https://gravitee.example.com/management/organizations/DEFAULT/users?query=dev2%40540.co&page=2&size=10',
  ]);
}

async function testFindUserByEmailFallsBackToUnfilteredScanWhenSearchMisses() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?q=dev12%40540.co') {
      return { data: [], page: 1, size: 10, total: 0 };
    }
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?query=dev12%40540.co') {
      return { data: [], page: 1, size: 10, total: 0 };
    }
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/users?query=dev12%40540.co') {
      return { data: [], page: 1, size: 10, total: 0 };
    }
    if (url === 'https://gravitee.example.com/management/organizations/DEFAULT/users') {
      return {
        data: [
          { id: 'user-1', email: 'dev10@540.co' },
          { id: 'user-2', email: 'dev12@540.co' },
        ],
        page: 1,
        size: 10,
        total: 2,
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const user = await client.findUserByEmail('dev12@540.co');
  assert.strictEqual(user.id, 'user-2');
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?q=dev12%40540.co',
    'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/search/users?query=dev12%40540.co',
    'https://gravitee.example.com/management/organizations/DEFAULT/users?query=dev12%40540.co',
    'https://gravitee.example.com/management/organizations/DEFAULT/users',
  ]);
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

async function testFindApplicationMatchesLowercaseMetadataKeys() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.listApplications = async () => ([
    { id: 'app-1', name: 'Orders', metadata: { sourceid: 'alice@example.com/Orders', developeremail: 'alice@example.com' } },
  ]);
  const app = await client.findApplicationByNameAndOwnerHint({
    name: 'Orders',
    ownerHint: 'alice@example.com',
    sourceId: 'alice@example.com/Orders',
  });
  assert.strictEqual(app.id, 'app-1');
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

async function testListApisFollowsPaginatedResponses() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url === 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis') {
      return {
        data: Array.from({ length: 10 }, (_, index) => ({ id: `api-${index + 1}`, name: `API ${index + 1}` })),
        page: 1,
        size: 10,
        total: 12,
      };
    }
    if (url === 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis?page=2&size=10') {
      return {
        data: [
          { id: 'api-11', name: 'API 11' },
          { id: 'api-12', name: 'API 12' },
        ],
        page: 2,
        size: 10,
        total: 12,
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const apis = await client.listApis();
  assert.strictEqual(apis.length, 12);
  assert.strictEqual(apis[10].id, 'api-11');
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis',
    'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis?page=2&size=10',
  ]);
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

async function testUpsertApplicationMetadataUsesApplicationScopedEndpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.put = async (url, body) => {
    calls.push({ method: 'PUT', url, body });
    return { ok: true };
  };
  client.post = async (url, body) => {
    calls.push({ method: 'POST', url, body });
    return { ok: true };
  };

  const result = await client.upsertApplicationMetadata('app-1', {
    sourceId: 'alice@example.com/orders-consumer',
    DisplayName: 'Orders Consumer',
  });

  assert.deepStrictEqual(calls, [
    {
      method: 'PUT',
      url: 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/applications/app-1/metadata/sourceId',
      body: { name: 'sourceId', format: 'STRING', value: 'alice@example.com/orders-consumer', applicationId: 'app-1', hidden: false },
    },
    {
      method: 'PUT',
      url: 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/applications/app-1/metadata/DisplayName',
      body: { name: 'DisplayName', format: 'STRING', value: 'Orders Consumer', applicationId: 'app-1', hidden: false },
    },
  ]);
  assert.strictEqual(result.diagnostics.keyCount, 2);
  assert.strictEqual(result.diagnostics.keys.sourceId.status, 'written');
  assert.strictEqual(result.diagnostics.keys.sourceId.method, 'PUT');
}

async function testUpsertApplicationMetadataFallsBackAcrossPutShapes() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.put = async (url, body) => {
    calls.push({ method: 'PUT', url, body });
    if (calls.length < 2) {
      const err = new Error(`PUT ${url} -> HTTP 400`);
      err.status = 400;
      throw err;
    }
    return { ok: true };
  };
  client.post = async (url, body) => {
    calls.push({ method: 'POST', url, body });
    return { ok: true };
  };

  const result = await client.upsertApplicationMetadata('app-1', {
    sourceId: 'alice@example.com/orders-consumer',
  });

  assert.deepStrictEqual(calls, [
    {
      method: 'PUT',
      url: 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/applications/app-1/metadata/sourceId',
      body: { name: 'sourceId', format: 'STRING', value: 'alice@example.com/orders-consumer', applicationId: 'app-1', hidden: false },
    },
    {
      method: 'PUT',
      url: 'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/applications/app-1/metadata/sourceId',
      body: { key: 'sourceId', name: 'sourceId', format: 'STRING', value: 'alice@example.com/orders-consumer', applicationId: 'app-1', hidden: false },
    },
  ]);
  assert.strictEqual(result.diagnostics.keys.sourceId.failedAttemptCount, 1);
  assert.deepStrictEqual(result.diagnostics.keys.sourceId.payloadShape, ['applicationId', 'format', 'hidden', 'key', 'name', 'value']);
}

async function testListApplicationMetadataWithDiagnosticsReportsReadShape() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.get = async () => ({
    data: [
      { key: 'sourceId', value: 'alice@example.com/orders-consumer' },
      { name: 'developerEmail', value: 'alice@example.com' },
    ],
    page: 1,
    size: 2,
    total: 2,
  });

  const result = await client.listApplicationMetadataWithDiagnostics('app-1');

  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.diagnostics.readStrategy.itemCount, 2);
  assert.deepStrictEqual(result.diagnostics.readStrategy.sampleKeys, ['sourceId', 'developerEmail']);
  assert.deepStrictEqual(result.diagnostics.readStrategy.rawShape, ['data', 'page', 'size', 'total']);
}

async function testListRolesUsesScopedConfigurationEndpoints() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url.endsWith('/configuration/rolescopes/ORGANIZATION/roles')) {
      return [{ id: 'role-org-1', name: 'USER' }];
    }
    if (url.endsWith('/configuration/rolescopes/ENVIRONMENT/roles')) {
      return [{ id: 'role-env-1', name: 'API_CONSUMER' }];
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const roles = await client.listRoles();
  assert.deepStrictEqual(Array.from(roles).sort(), ['ENVIRONMENT:API_CONSUMER', 'ORGANIZATION:USER']);
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/organizations/DEFAULT/configuration/rolescopes/ORGANIZATION/roles',
    'https://gravitee.example.com/management/organizations/DEFAULT/configuration/rolescopes/ENVIRONMENT/roles',
  ]);
}

async function testListRolesByScopeFallsBackToLegacyRoleScopesEndpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url.endsWith('/configuration/rolescopes/ENVIRONMENT/roles')) {
      const err = new Error('GET roles by scope → HTTP 404');
      err.status = 404;
      err.body = { message: 'Not found' };
      throw err;
    }
    if (url.endsWith('/rolescopes')) {
      return [
        { scope: 'ORGANIZATION', roles: [{ id: 'role-org-1', name: 'USER' }] },
        { scope: 'ENVIRONMENT', roles: [{ id: 'role-env-1', name: 'USER' }] },
      ];
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const roles = await client.listRolesByScope('ENVIRONMENT');
  assert.deepStrictEqual(roles, [{ id: 'role-env-1', name: 'USER', scope: 'ENVIRONMENT' }]);
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/organizations/DEFAULT/configuration/rolescopes/ENVIRONMENT/roles',
    'https://gravitee.example.com/management/organizations/DEFAULT/rolescopes',
  ]);
}

async function testGetUserRolesReturnsNullWhenUnsupportedLookupAllowed() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.get = async () => {
    const err = new Error('GET roles → HTTP 405');
    err.status = 405;
    err.body = { message: 'Method not allowed' };
    throw err;
  };
  const roles = await client.getUserRoles('user-1', { allowUnsupported: true });
  assert.strictEqual(roles, null);
}

async function testGetUserRolesFallsBackToEnvironmentUserEndpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url.endsWith('/management/organizations/DEFAULT/users/user-1/roles')) {
      const err = new Error('GET roles → HTTP 405');
      err.status = 405;
      err.body = { message: 'Method not allowed' };
      throw err;
    }
    if (url.endsWith('/management/organizations/DEFAULT/environments/DEFAULT/users/user-1')) {
      return {
        id: 'user-1',
        organizationRoles: ['USER'],
        environmentRoles: [{ name: 'API_CONSUMER' }],
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const roles = await client.getUserRoles('user-1', { allowUnsupported: true });
  assert.deepStrictEqual(Array.from(roles).sort(), ['ENVIRONMENT:API_CONSUMER', 'ORGANIZATION:USER']);
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/organizations/DEFAULT/users/user-1/roles',
    'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/users/user-1',
  ]);
}

async function testGetUserFallsBackToEnvironmentUserEndpoint() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.get = async (url) => {
    calls.push(url);
    if (url.endsWith('/management/organizations/DEFAULT/users/user-1')) {
      const err = new Error('GET user → HTTP 404');
      err.status = 404;
      throw err;
    }
    if (url.endsWith('/management/organizations/DEFAULT/environments/DEFAULT/users/user-1')) {
      return { id: 'user-1', email: 'user@example.com' };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const user = await client.getUser('user-1');
  assert.strictEqual(user.email, 'user@example.com');
  assert.deepStrictEqual(calls, [
    'https://gravitee.example.com/management/organizations/DEFAULT/users/user-1',
    'https://gravitee.example.com/management/organizations/DEFAULT/environments/DEFAULT/users/user-1',
  ]);
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
    if (calls.length < 3) {
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
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0].url, 'https://gravitee.example.com/management/organizations/DEFAULT/users/user-1/roles');
  assert.deepStrictEqual(calls[0].body, {
    organization: 'USER',
    environment: 'API_CONSUMER',
  });
  assert.deepStrictEqual(calls[2].body, {
    organization: ['ORGANIZATION:USER'],
    environment: ['ENVIRONMENT:API_CONSUMER'],
  });
  assert.strictEqual(response._strategy, 'scoped-object-lowercase');
}

async function testAssignUserRolesUsesReferencePayloadWhenRoleIdsProvided() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.put = async (url, body) => {
    calls.push({ url, body });
    return { ok: true };
  };
  const response = await client.assignUserRoles('user-1', {
    organization: ['ORGANIZATION:USER'],
    environment: ['ENVIRONMENT:API_CONSUMER'],
    organizationIds: ['role-org-1', 'role-org-2'],
    environmentIds: ['role-env-1', 'role-env-2'],
  });
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0].body, {
    user: 'user-1',
    referenceId: 'DEFAULT',
    referenceType: 'ORGANIZATION',
    roles: ['role-org-1', 'role-org-2'],
  });
  assert.deepStrictEqual(calls[1].body, {
    user: 'user-1',
    referenceId: 'DEFAULT',
    referenceType: 'ENVIRONMENT',
    roles: ['role-env-1', 'role-env-2'],
  });
  assert.strictEqual(response._strategy, 'reference-payload');
}

async function testTransferApplicationOwnershipFallsBackAcrossPayloadShapes() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.post = async (url, body) => {
    calls.push({ url, body });
    if (calls.length < 3) {
      const err = new Error(`POST ${url} → HTTP 400`);
      err.status = 400;
      err.body = { message: 'bad payload' };
      throw err;
    }
    return { ok: true };
  };

  const response = await client.transferApplicationOwnership('app-1', { userId: 'user-1', role: 'OWNER' });
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0].url, 'https://gravitee.example.com/management/v1/organizations/DEFAULT/environments/DEFAULT/applications/app-1/members/transfer_ownership');
  assert.deepStrictEqual(calls[0].body, {
    id: 'user-1',
    referenceType: 'USER',
    role: 'OWNER',
  });
  assert.deepStrictEqual(calls[2].body, {
    user: 'user-1',
    role: 'OWNER',
  });
  assert.strictEqual(response._strategy, 'v1-transfer-user');
}

async function testTransferApplicationOwnershipTreatsExistingMembershipAsSuccess() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  client.post = async (url) => {
    const err = new Error(`POST ${url} → HTTP 400`);
    err.status = 400;
    err.body = {
      message: 'A Membership for member : USER user-1 and ref : APPLICATION app-1 already exists.',
      technicalCode: 'api.exists',
    };
    throw err;
  };

  const response = await client.transferApplicationOwnership('app-1', { userId: 'user-1', role: 'OWNER' });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response._strategy, 'v1-transfer-userId-referenceType-already-existing');
}

async function testCloseOrPauseSubscriptionFallsBackAcrossCompatibilityStrategies() {
  const client = new GraviteeClient({ baseUrl: 'https://gravitee.example.com', orgId: 'DEFAULT', envId: 'DEFAULT', token: 'token' });
  const calls = [];
  client.patch = async (url, body) => {
    calls.push({ method: 'PATCH', url, body });
    const err = new Error(`PATCH ${url} → HTTP 405`);
    err.status = 405;
    err.body = { message: 'Method not allowed' };
    throw err;
  };
  client.put = async (url, body) => {
    calls.push({ method: 'PUT', url, body });
    const err = new Error(`PUT ${url} → HTTP 405`);
    err.status = 405;
    err.body = { message: 'Method not allowed' };
    throw err;
  };
  client.post = async (url, body) => {
    calls.push({ method: 'POST', url, body });
    if (url.endsWith('/_close')) return { ok: true };
    const err = new Error(`POST ${url} → HTTP 404`);
    err.status = 404;
    err.body = { message: 'Not found' };
    throw err;
  };
  const response = await client.closeOrPauseSubscription({
    apiId: 'api-1',
    subscriptionId: 'sub-1',
    status: 'CLOSED',
  });
  assert.deepStrictEqual(calls.slice(0, 3), [
    {
      method: 'PATCH',
      url: 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis/api-1/subscriptions/sub-1',
      body: { status: 'CLOSED' },
    },
    {
      method: 'PUT',
      url: 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis/api-1/subscriptions/sub-1',
      body: { status: 'CLOSED' },
    },
    {
      method: 'POST',
      url: 'https://gravitee.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/apis/api-1/subscriptions/sub-1/_close',
      body: {},
    },
  ]);
  assert.strictEqual(response._strategy, 'v4-subscription-close-endpoint');
}

async function run() {
  await testFindUserByEmailFiltersResults();
  await testFindUserByEmailUsesEnvironmentSearchEndpointFirst();
  await testFindUserByEmailFollowsPaginatedSearchResults();
  await testFindUserByEmailFallsBackToUnfilteredScanWhenSearchMisses();
  await testCreateSubscriptionUsesV2Endpoint();
  await testFindPlanByIdUsesExpectedEndpoint();
  await testFindApplicationPrefersSourceMarker();
  await testFindApplicationMatchesLowercaseMetadataKeys();
  await testNormalizeCollectionSupportsItemsShape();
  await testFindApiByNameFiltersExactName();
  await testListApisFollowsPaginatedResponses();
  await testFindPlanResolvesApiByNameWhenIdMissing();
  await testCreateApiPlanNormalizesPlanPayload();
  await testCreateApplicationCustomFieldUsesApplicationsMetadataEndpoint();
  await testUpsertApplicationMetadataUsesApplicationScopedEndpoint();
  await testUpsertApplicationMetadataFallsBackAcrossPutShapes();
  await testListApplicationMetadataWithDiagnosticsReportsReadShape();
  await testListRolesUsesScopedConfigurationEndpoints();
  await testListRolesByScopeFallsBackToLegacyRoleScopesEndpoint();
  await testGetUserRolesReturnsNullWhenUnsupportedLookupAllowed();
  await testGetUserRolesFallsBackToEnvironmentUserEndpoint();
  await testGetUserFallsBackToEnvironmentUserEndpoint();
  await testDeleteUserUsesExpectedEndpoint();
  await testAssignUserRolesFallsBackAcrossPayloadShapes();
  await testAssignUserRolesUsesReferencePayloadWhenRoleIdsProvided();
  await testTransferApplicationOwnershipFallsBackAcrossPayloadShapes();
  await testTransferApplicationOwnershipTreatsExistingMembershipAsSuccess();
  await testCloseOrPauseSubscriptionFallsBackAcrossCompatibilityStrategies();
  console.log('test-gravitee-client.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
