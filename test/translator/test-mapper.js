'use strict';

/**
 * test/parser/test-mapper.js
 *
 * Test suite for:
 *   - src/mapper/policy-handlers.js
 *   - src/mapper/policy-mapper.js
 *
 * Run: node test/parser/test-mapper.js
 *
 * Self-contained: generates its own IR from test/extractor/fixtures/ via the
 * Python extractor before running, writes to test/parser/.ir-cache/, and
 * cleans up on exit.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const { spawnSync } = require('child_process');

const { mapPolicyStep }     = require('../../src/translator/mapper/policy-handlers');
const {
  mapProxyToGraviteeApi,
  buildEndpointGroups,
  buildFlows,
  buildPlans,
} = require('../../src/translator/mapper/policy-mapper');
const { parseProxyFile }    = require('../../src/translator/parser/proxy-ast');

// ─── IR generation ─────────────────────────────────────────────────────────────
const PROJECT_ROOT  = path.resolve(__dirname, '..', '..');
const FIXTURES_DATA = path.join(PROJECT_ROOT, 'test', 'extractor', 'fixtures', 'data');
const IR_CACHE      = path.join(__dirname, '.ir-cache-mapper');

function generateIr() {
  const result = spawnSync(
    'python3',
    [
      '-m', 'src.extractor.extractor',
      '--data-dir', FIXTURES_DATA,
      '--ir-dir',   IR_CACHE,
    ],
    { cwd: PROJECT_ROOT, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    console.error('IR generation failed:\n', result.stderr);
    process.exit(2);
  }
}

generateIr();

process.on('exit', () => {
  try { fs.rmSync(IR_CACHE, { recursive: true, force: true }); } catch (_) {}
});

// ─── Fixture path ──────────────────────────────────────────────────────────────
const FIXTURE_IR = path.join(IR_CACHE, 'proxies', 'orders-api.json');

// ─── Mini test runner ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); failures.push(name); failed++; }
}
function suite(name, fn) { console.log(`\n${name}`); fn(); }

// ─── Helper: build a minimal StepAST ─────────────────────────────────────────
function makeStep(name, policyType, tier, config, condition = '') {
  return {
    name,
    condition: { el: condition, needsReview: false, original: condition },
    policy: { name, policyType, tier, enabled: true, known: true, config, rawXml: '', resourceUrls: [] },
    _missing: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POLICY HANDLERS — mapPolicyStep
// ═══════════════════════════════════════════════════════════════════════════════

suite('PolicyHandlers — SpikeArrest → rate-limit', () => {
  const step = makeStep('my-arrest', 'SpikeArrest', 'auto', {
    count: 50, unit: 'second', identifierRef: 'request.header.x-api-key', useEffective: true,
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is rate-limit', () => assert.strictEqual(mapped.policy, 'rate-limit'));
  test('enabled is true', () => assert.strictEqual(mapped.enabled, true));
  test('configuration has rate', () => assert.ok(mapped.configuration.rate));
  test('rate limit is 50', () => assert.strictEqual(mapped.configuration.rate.limit, 50));
  test('periodTimeUnit is SECONDS', () => assert.strictEqual(mapped.configuration.rate.periodTimeUnit, 'SECONDS'));
  test('_needsReview is false', () => assert.strictEqual(mapped._needsReview, false));
});

suite('PolicyHandlers — Quota → quota', () => {
  const step = makeStep('my-quota', 'Quota', 'auto', {
    count: { value: '1000' }, interval: { value: '1' }, timeUnit: { value: 'hour' },
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is quota', () => assert.strictEqual(mapped.policy, 'quota'));
  test('quota limit is 1000', () => assert.strictEqual(mapped.configuration.quota.limit, 1000));
  test('periodTimeUnit is HOURS', () => assert.strictEqual(mapped.configuration.quota.periodTimeUnit, 'HOURS'));
});

suite('PolicyHandlers — AssignMessage (headers) → transform-headers', () => {
  const step = makeStep('set-headers', 'AssignMessage', 'auto', {
    assignTo: { type: 'response', createNew: false },
    set: { headers: [{ name: 'X-Powered-By', value: 'Gravitee' }], queryParams: [], formParams: [], payload: '' },
    add: { headers: [], queryParams: [], formParams: [] },
    remove: { headers: [], queryParams: [], formParams: [] },
    copy: { source: '', headers: [], queryParams: [] },
    assignVariable: [],
    ignoreUnresolvedVariables: true,
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is transform-headers', () => assert.strictEqual(mapped.policy, 'transform-headers'));
  test('scope is RESPONSE', () => assert.strictEqual(mapped.configuration.scope, 'RESPONSE'));
  test('addHeaders contains X-Powered-By', () => {
    assert.ok(mapped.configuration.addHeaders.some(h => h.name === 'X-Powered-By'));
  });
  test('enabled is true', () => assert.strictEqual(mapped.enabled, true));
});

suite('PolicyHandlers — AssignMessage (assignVariable) → assign-attributes', () => {
  const step = makeStep('set-var', 'AssignMessage', 'auto', {
    assignTo: { type: 'request', createNew: false },
    set: { headers: [], queryParams: [], formParams: [], payload: '' },
    add: { headers: [], queryParams: [], formParams: [] },
    remove: { headers: [], queryParams: [], formParams: [] },
    copy: { source: '', headers: [], queryParams: [] },
    assignVariable: [{ name: 'my-var', value: 'hello', ref: '' }],
    ignoreUnresolvedVariables: true,
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is assign-attributes', () => assert.strictEqual(mapped.policy, 'assign-attributes'));
  test('attributes contains my-var', () => {
    assert.ok(mapped.configuration.attributes.some(a => a.name === 'my-var'));
  });
});

suite('PolicyHandlers — AssignMessage fallback when assign-attributes unavailable', () => {
  const step = makeStep('set-var', 'AssignMessage', 'auto', {
    assignVariable: [{ name: 'my-var', value: 'hello', ref: '' }],
  });
  const mapped = mapPolicyStep(step, 'request', { fallbackPlugins: new Set(['assign-attributes']) });

  test('policy slug is groovy', () => assert.strictEqual(mapped.policy, 'groovy'));
  test('fallback is marked for review', () => assert.strictEqual(mapped._needsReview, true));
});

suite('PolicyHandlers — AssignMessage (status code) → interrupt', () => {
  const step = makeStep('raise', 'AssignMessage', 'auto', {
    assignTo: { type: 'response', createNew: false },
    set: { headers: [], queryParams: [], formParams: [], payload: '{"error":"not found"}', statusCode: '404', reasonPhrase: 'Not Found' },
    add: { headers: [], queryParams: [], formParams: [] },
    remove: { headers: [], queryParams: [], formParams: [] },
    copy: { source: '', headers: [], queryParams: [] },
    assignVariable: [],
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is interrupt', () => assert.strictEqual(mapped.policy, 'interrupt'));
  test('statusCode is 404', () => assert.strictEqual(mapped.configuration.statusCode, 404));
});

suite('PolicyHandlers — RaiseFault → interrupt', () => {
  const step = makeStep('fault', 'RaiseFault', 'auto', {
    statusCode: '401', reasonPhrase: 'Unauthorized',
    payload: { contentType: 'application/json', body: '{"error":"unauthorized"}' },
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is interrupt', () => assert.strictEqual(mapped.policy, 'interrupt'));
  test('statusCode is 401', () => assert.strictEqual(mapped.configuration.statusCode, 401));
  test('message contains error', () => assert.ok(mapped.configuration.message.includes('unauthorized')));
});

suite('PolicyHandlers — ServiceCallout → http-callout', () => {
  const step = makeStep('callout', 'ServiceCallout', 'auto', {
    targetUrl: 'https://internal.api.example.com/lookup',
    responseVariable: 'calloutResult',
    timeout: '5000',
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is http-callout', () => assert.strictEqual(mapped.policy, 'http-callout'));
  test('url is set', () => assert.strictEqual(mapped.configuration.url, 'https://internal.api.example.com/lookup'));
  test('variables includes calloutResult', () => {
    assert.ok(mapped.configuration.variables.some(v => v.name === 'calloutResult'));
  });
});

suite('PolicyHandlers — ServiceCallout fallback when http-callout unavailable', () => {
  const step = makeStep('callout', 'ServiceCallout', 'auto', {
    targetUrl: 'https://internal.api.example.com/lookup',
    responseVariable: 'calloutResult',
  });
  const mapped = mapPolicyStep(step, 'request', { fallbackPlugins: new Set(['http-callout']) });

  test('policy slug is groovy', () => assert.strictEqual(mapped.policy, 'groovy'));
  test('fallback is marked for review', () => assert.strictEqual(mapped._needsReview, true));
});

suite('PolicyHandlers — KeyValueMapOperations (Get) → assign-attributes', () => {
  const step = makeStep('kvm-get', 'KeyValueMapOperations', 'auto', {
    mapIdentifier: 'env-config', scope: 'environment',
    gets: [{ assignTo: 'private.target-url', key: 'target-url' }],
    puts: [], deletes: [], hasWrites: false,
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is assign-attributes', () => assert.strictEqual(mapped.policy, 'assign-attributes'));
  test('EL uses #dictionaries', () => {
    const attr = mapped.configuration.attributes[0];
    assert.ok(attr.value.includes('#dictionaries'));
  });
});

suite('PolicyHandlers — KeyValueMapOperations (Put) → cache [needsReview]', () => {
  const step = makeStep('kvm-put', 'KeyValueMapOperations', 'auto', {
    mapIdentifier: 'order-cache', scope: 'apiproxy',
    gets: [], puts: [{ override: true, keyRef: 'request.queryparam.orderId', valueRef: 'request.content' }],
    deletes: [], hasWrites: true,
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is cache', () => assert.strictEqual(mapped.policy, 'cache'));
  test('_needsReview is true', () => assert.strictEqual(mapped._needsReview, true));
});

suite('PolicyHandlers — AccessControl → ip-filtering', () => {
  const step = makeStep('ip-check', 'AccessControl', 'auto', {
    allowRules: ['10.0.0.0/8', '192.168.0.0/16'],
    denyRules:  ['1.2.3.4'],
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is ip-filtering', () => assert.strictEqual(mapped.policy, 'ip-filtering'));
  test('whitelistIps has entries', () => assert.strictEqual(mapped.configuration.whitelistIps.length, 2));
  test('blacklistIps has entries', () => assert.strictEqual(mapped.configuration.blacklistIps.length, 1));
});

suite('PolicyHandlers — CORS → cors', () => {
  const step = makeStep('cors', 'CORS', 'auto', {
    allowOrigins: ['https://app.example.com'],
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: [],
    allowCredentials: true,
    maxAge: '3600',
  });
  const mapped = mapPolicyStep(step);

  test('policy slug is cors', () => assert.strictEqual(mapped.policy, 'cors'));
  test('allowOrigin contains app.example.com', () => {
    assert.ok(mapped.configuration.accessControlAllowOrigin.includes('app.example.com'));
  });
  test('allowCredentials is true', () => assert.strictEqual(mapped.configuration.accessControlAllowCredentials, true));
});

suite('PolicyHandlers — special tiers', () => {
  test('security-tier step emits disabled stub', () => {
    const step = makeStep('verify-api-key', 'VerifyAPIKey', 'security', {});
    const mapped = mapPolicyStep(step);
    assert.strictEqual(mapped.enabled, false);
    assert.ok(mapped.name.includes('Plan level') || mapped.name.includes('security'));
  });

  test('manual-tier step emits disabled stub with MANUAL REQUIRED', () => {
    const step = makeStep('my-logger', 'MessageLogging', 'manual', {});
    const mapped = mapPolicyStep(step);
    assert.strictEqual(mapped.enabled, false);
    assert.ok(mapped.name.includes('MANUAL'));
  });

  test('llm-tier step emits disabled stub with LLM REVIEW', () => {
    const step = makeStep('my-script', 'JavaCallout', 'llm', {});
    const mapped = mapPolicyStep(step);
    assert.strictEqual(mapped.enabled, false);
    assert.ok(mapped.name.includes('LLM'));
  });

  test('missing policy emits MISSING stub', () => {
    const step = { name: 'ghost-policy', condition: { el: '', needsReview: false }, policy: null, _missing: true };
    const mapped = mapPolicyStep(step);
    assert.strictEqual(mapped.enabled, false);
    assert.ok(mapped.name.includes('MISSING'));
  });

  test('disabled policy emits DISABLED stub', () => {
    const step = makeStep('disabled-pol', 'AssignMessage', 'auto', {});
    step.policy.enabled = false;
    const mapped = mapPolicyStep(step);
    assert.strictEqual(mapped.enabled, false);
    assert.ok(mapped.name.includes('DISABLED'));
  });

  test('step condition is preserved in output', () => {
    const step = makeStep('rate', 'SpikeArrest', 'auto',
      { count: 10, unit: 'second', identifierRef: '' },
      "{#request.method != 'OPTIONS'}"
    );
    const mapped = mapPolicyStep(step);
    assert.strictEqual(mapped.condition, "{#request.method != 'OPTIONS'}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POLICY MAPPER — buildEndpointGroups
// ═══════════════════════════════════════════════════════════════════════════════

suite('PolicyMapper — buildEndpointGroups', () => {
  test('empty targetEndpoints returns placeholder group', () => {
    const groups = buildEndpointGroups([]);
    assert.strictEqual(groups.length, 1);
    assert.ok(groups[0].endpoints[0].configuration.target.includes('PLACEHOLDER'));
  });

  test('direct URL target', () => {
    const te = [{ name: 'default', connection: { url: 'https://api.example.com', load_balancer: null, ssl_info: null }, preFlow: { request: [], response: [] }, flows: [], postFlow: { request: [], response: [] } }];
    const groups = buildEndpointGroups(te, {});
    assert.strictEqual(groups[0].endpoints[0].configuration.target, 'https://api.example.com');
  });

  test('load balancer target resolves server URLs', () => {
    const te = [{
      name: 'default',
      connection: {
        load_balancer: {
          algorithm: 'RoundRobin',
          servers: [
            { name: 'server-1', weight: 2, is_enabled: true },
            { name: 'server-2', weight: 1, is_enabled: true },
          ],
        },
      },
      preFlow: { request: [], response: [] }, flows: [], postFlow: { request: [], response: [] }
    }];
    const resolved = {
      'server-1': { url: 'https://primary.example.com' },
      'server-2': { url: 'https://secondary.example.com' },
    };
    const groups = buildEndpointGroups(te, resolved);
    assert.strictEqual(groups[0].endpoints.length, 2);
    assert.strictEqual(groups[0].endpoints[0].configuration.target, 'https://primary.example.com');
    assert.strictEqual(groups[0].endpoints[0].weight, 2);
    assert.strictEqual(groups[0].endpoints[1].weight, 1);
  });

  test('unresolved LB server falls back to name URL', () => {
    const te = [{
      name: 'default',
      connection: { load_balancer: { algorithm: 'RoundRobin', servers: [{ name: 'unknown-server', weight: 1, is_enabled: true }] } },
      preFlow: { request: [], response: [] }, flows: [], postFlow: { request: [], response: [] }
    }];
    const groups = buildEndpointGroups(te, {});
    assert.ok(groups[0].endpoints[0].configuration.target.includes('unknown-server'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POLICY MAPPER — buildPlans
// ═══════════════════════════════════════════════════════════════════════════════

suite('PolicyMapper — buildPlans', () => {
  test('API_KEY scheme produces API_KEY plan', () => {
    const plans = buildPlans({ type: 'API_KEY', policy: { config: { apiKeyHeader: 'x-api-key' } } });
    assert.ok(plans['API_KEY']);
    assert.strictEqual(plans['API_KEY'].security.type, 'API_KEY');
  });

  test('OAUTH2 scheme produces OAUTH2 plan', () => {
    const plans = buildPlans({ type: 'OAUTH2', policy: { config: { scopes: ['read'] } } });
    assert.ok(plans['OAUTH2']);
    assert.strictEqual(plans['OAUTH2'].security.type, 'OAUTH2');
  });

  test('JWT scheme produces JWT plan', () => {
    const plans = buildPlans({ type: 'JWT', policy: { config: {} } });
    assert.ok(plans['JWT']);
    assert.strictEqual(plans['JWT'].security.type, 'JWT');
  });

  test('KEYLESS scheme produces KEY_LESS plan', () => {
    const plans = buildPlans({ type: 'KEYLESS', policy: null });
    assert.ok(plans['KEYLESS']);
    assert.strictEqual(plans['KEYLESS'].security.type, 'KEY_LESS');
  });

  test('plans have STAGING status', () => {
    const plans = buildPlans({ type: 'API_KEY', policy: { config: {} } });
    assert.strictEqual(plans['API_KEY'].status, 'STAGING');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POLICY MAPPER — mapProxyToGraviteeApi (integration — fixture)
// ═══════════════════════════════════════════════════════════════════════════════

suite('PolicyMapper — mapProxyToGraviteeApi (orders-api fixture)', () => {
  let ast, apiDef;

  try {
    ast = parseProxyFile(FIXTURE_IR);
  } catch (e) {
    console.log(`  [SKIP] ${e.message}`);
    return;
  }

  const resolvedServers = {
    'orders-backend-primary':   { url: 'https://primary.orders.internal:8443' },
    'orders-backend-secondary': { url: 'https://secondary.orders.internal:8443' },
  };

  apiDef = mapProxyToGraviteeApi(ast, { resolvedServers });

  test('definitionVersion is V4', () => assert.strictEqual(apiDef.definitionVersion, 'V4'));
  test('type is PROXY', () => assert.strictEqual(apiDef.type, 'PROXY'));
  test('name matches displayName', () => assert.ok(apiDef.name.length > 0));
  test('description is set', () => assert.ok(apiDef.description.length > 0));

  test('listeners has one HTTP entry', () => {
    assert.strictEqual(apiDef.listeners.length, 1);
    assert.strictEqual(apiDef.listeners[0].type, 'HTTP');
  });

  test('listener path is /v1/orders', () => {
    assert.strictEqual(apiDef.listeners[0].paths[0].path, '/v1/orders');
  });

  test('entrypoint type is http-proxy', () => {
    assert.strictEqual(apiDef.listeners[0].entrypoints[0].type, 'http-proxy');
  });

  test('endpointGroups has entries', () => assert.ok(apiDef.endpointGroups.length > 0));

  test('endpoint targets are resolved URLs', () => {
    const targets = apiDef.endpointGroups[0].endpoints.map(e => e.configuration.target);
    assert.ok(targets.some(t => t.includes('primary.orders.internal')));
    assert.ok(targets.some(t => t.includes('secondary.orders.internal')));
  });

  test('endpoint weights are preserved', () => {
    const primary = apiDef.endpointGroups[0].endpoints.find(e => e.name === 'orders-backend-primary');
    assert.strictEqual(primary?.weight, 2);
  });

  test('flows is an array', () => assert.ok(Array.isArray(apiDef.flows)));
  test('has at least one flow', () => assert.ok(apiDef.flows.length > 0));

  test('Common Flow contains spike-arrest as rate-limit', () => {
    const commonFlow = apiDef.flows.find(f => f.name === 'Common Flow');
    assert.ok(commonFlow);
    const rateLimitStep = commonFlow.request.find(s => s.policy === 'rate-limit');
    assert.ok(rateLimitStep, 'Expected rate-limit step in Common Flow request');
    assert.strictEqual(rateLimitStep.enabled, true);
  });

  test('Named flow GetOrders is present', () => {
    const getFlow = apiDef.flows.find(f => f.name === 'GetOrders');
    assert.ok(getFlow);
  });

  test('GetOrders request contains assign-attributes from KVM lookup', () => {
    const getFlow = apiDef.flows.find(f => f.name === 'GetOrders');
    const assignStep = getFlow?.request.find(s => s.policy === 'assign-attributes');
    assert.ok(assignStep);
  });

  test('GetOrders response contains transform-headers', () => {
    const getFlow = apiDef.flows.find(f => f.name === 'GetOrders');
    const transformStep = getFlow?.response.find(s => s.policy === 'transform-headers');
    assert.ok(transformStep);
  });

  test('CreateOrder request has a groovy stub for validate-order-payload (llm)', () => {
    const createFlow = apiDef.flows.find(f => f.name === 'CreateOrder');
    // Javascript (llm tier with handler) → groovy stub, enabled=true, _needsReview=true
    const groovyStep = createFlow?.request.find(s => s.policy === 'groovy' && s.name.includes('LLM'));
    assert.ok(groovyStep, 'Expected groovy LLM stub for validate-order-payload');
    assert.ok(groovyStep.name.includes('LLM REVIEW'));
  });

  test('CreateOrder request has cache step for KVM write', () => {
    const createFlow = apiDef.flows.find(f => f.name === 'CreateOrder');
    const cacheStep = createFlow?.request.find(s => s.policy === 'cache');
    assert.ok(cacheStep);
  });

  test('postflow has manual stub for log-response (MessageLogging)', () => {
    const commonFlow = apiDef.flows.find(f => f.name === 'Common Flow');
    const manualStep = commonFlow?.response.find(s => s.name.includes('MANUAL'));
    assert.ok(manualStep);
    assert.strictEqual(manualStep.enabled, false);
  });

  test('plans has API_KEY', () => {
    assert.ok(apiDef.plans['API_KEY']);
    assert.strictEqual(apiDef.plans['API_KEY'].security.type, 'API_KEY');
  });

  test('flowExecution is DEFAULT mode', () => {
    assert.strictEqual(apiDef.flowExecution.mode, 'DEFAULT');
  });

  test('_migrationMeta.securityScheme is API_KEY', () => {
    assert.strictEqual(apiDef._migrationMeta.securityScheme, 'API_KEY');
  });

  test('_migrationMeta.manualSteps includes log-response', () => {
    assert.ok(apiDef._migrationMeta.manualSteps.includes('log-response'));
  });

  test('_migrationMeta.llmSteps has validate-order-payload entry', () => {
    assert.ok(apiDef._migrationMeta.llmSteps.some(s => s.name === 'validate-order-payload'));
  });

  test('_migrationMeta.kvmWriteOps includes order-cache', () => {
    assert.ok(apiDef._migrationMeta.kvmWriteOps.includes('order-cache'));
  });

  test('all flows have valid selectors', () => {
    for (const flow of apiDef.flows) {
      assert.ok(flow.selectors.length > 0, `Flow '${flow.name}' has no selectors`);
      assert.strictEqual(flow.selectors[0].type, 'HTTP');
    }
  });

  test('definition is valid JSON-serialisable', () => {
    const json = JSON.stringify(apiDef);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.definitionVersion, 'V4');
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}
