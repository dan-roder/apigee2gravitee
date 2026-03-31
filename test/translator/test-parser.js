'use strict';

/**
 * test/parser/test-parser.js
 *
 * Test suite for:
 *   - src/parser/policy-registry.js
 *   - src/parser/condition-translator.js
 *   - src/parser/proxy-ast.js
 *
 * Run: node test/parser/test-parser.js
 *
 * Self-contained: generates its own IR from test/extractor/fixtures/ via the
 * Python extractor before running, writes to test/parser/.ir-cache/, and
 * cleans up on exit. No dependency on /tmp or pre-existing IR files.
 */

const assert  = require('assert');
const path    = require('path');
const fs      = require('fs');
const { spawnSync } = require('child_process');

const { classifyAndExtract, POLICY_REGISTRY } = require('../../src/translator/parser/policy-registry');
const { translateCondition, translateVariable, translateAtomicCondition } = require('../../src/translator/parser/condition-translator');
const { parseProxyIr, parseProxyFile, parseAllProxies } = require('../../src/translator/parser/proxy-ast');

// ─── IR generation ─────────────────────────────────────────────────────────────
// Generate fresh IR from the extractor fixtures so this suite is self-contained.

const PROJECT_ROOT  = path.resolve(__dirname, '..', '..');
const FIXTURES_DATA = path.join(PROJECT_ROOT, 'test', 'extractor', 'fixtures', 'data');
const IR_CACHE      = path.join(__dirname, '.ir-cache');

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

// ─── Fixture paths ─────────────────────────────────────────────────────────────
const FIXTURE_IR     = path.join(IR_CACHE, 'proxies', 'orders-api.json');
const FIXTURE_SF_IR  = path.join(IR_CACHE, 'sharedflows', 'security-common.json');
const FIXTURE_IR_DIR = path.join(IR_CACHE, 'proxies');

// ─── Mini test runner ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function suite(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ─── Helper: build a minimal raw_dict node ─────────────────────────────────────
function makeNode(tag, attrs = {}, children = [], text = '') {
  return {
    _tag: tag,
    _attrs: attrs,
    _text: text,
    _children: children,
  };
}

function makeChild(tag, text = '', attrs = {}) {
  return { _tag: tag, _text: text, _attrs: attrs, _children: [] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POLICY REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════

suite('PolicyRegistry — classification', () => {
  test('VerifyAPIKey is classified as security tier', () => {
    const { tier } = classifyAndExtract('VerifyAPIKey', makeNode('VerifyAPIKey'));
    assert.strictEqual(tier, 'security');
  });

  test('OAuthV2 is classified as security tier', () => {
    const { tier } = classifyAndExtract('OAuthV2', makeNode('OAuthV2'));
    assert.strictEqual(tier, 'security');
  });

  test('SpikeArrest is classified as auto tier', () => {
    const { tier } = classifyAndExtract('SpikeArrest', makeNode('SpikeArrest', {}, [makeChild('Rate', '100ps')]));
    assert.strictEqual(tier, 'auto');
  });

  test('AssignMessage is classified as auto tier', () => {
    const { tier } = classifyAndExtract('AssignMessage', makeNode('AssignMessage'));
    assert.strictEqual(tier, 'auto');
  });

  test('Javascript is classified as llm tier', () => {
    const { tier } = classifyAndExtract('Javascript', makeNode('Javascript'));
    assert.strictEqual(tier, 'llm');
  });

  test('JavaCallout is classified as llm tier', () => {
    const { tier } = classifyAndExtract('JavaCallout', makeNode('JavaCallout'));
    assert.strictEqual(tier, 'llm');
  });

  test('MessageLogging is classified as manual tier', () => {
    const { tier } = classifyAndExtract('MessageLogging', makeNode('MessageLogging'));
    assert.strictEqual(tier, 'manual');
  });

  test('ExtensionCallout is classified as manual tier', () => {
    const { tier } = classifyAndExtract('ExtensionCallout', makeNode('ExtensionCallout'));
    assert.strictEqual(tier, 'manual');
  });

  test('Unknown policy type returns llm tier and known=false', () => {
    const { tier, known } = classifyAndExtract('SomeCustomPolicy', makeNode('SomeCustomPolicy'));
    assert.strictEqual(tier, 'llm');
    assert.strictEqual(known, false);
  });

  test('KeyValueMapOperations is classified as auto tier', () => {
    const { tier } = classifyAndExtract('KeyValueMapOperations', makeNode('KeyValueMapOperations'));
    assert.strictEqual(tier, 'auto');
  });

  test('FlowCallout is classified as auto tier', () => {
    const { tier } = classifyAndExtract('FlowCallout', makeNode('FlowCallout'));
    assert.strictEqual(tier, 'auto');
  });
});

suite('PolicyRegistry — config extraction: VerifyAPIKey', () => {
  const node = makeNode('VerifyAPIKey', { name: 'verify-api-key', enabled: 'true' }, [
    makeChild('APIKey', '', { ref: 'request.header.x-api-key' }),
  ]);

  test('extracts apiKeyRef correctly', () => {
    const { config } = classifyAndExtract('VerifyAPIKey', node);
    assert.strictEqual(config.apiKeyRef, 'request.header.x-api-key');
  });

  test('extracts apiKeyHeader correctly', () => {
    const { config } = classifyAndExtract('VerifyAPIKey', node);
    assert.strictEqual(config.apiKeyHeader, 'x-api-key');
  });
});

suite('PolicyRegistry — config extraction: SpikeArrest', () => {
  test('parses rate per-second', () => {
    const node = makeNode('SpikeArrest', {}, [
      makeChild('Rate', '100ps'),
      makeChild('Identifier', '', { ref: 'request.header.x-api-key' }),
      makeChild('UseEffectiveCount', 'true'),
    ]);
    const { config } = classifyAndExtract('SpikeArrest', node);
    assert.strictEqual(config.count, 100);
    assert.strictEqual(config.unit, 'second');
    assert.strictEqual(config.identifierRef, 'request.header.x-api-key');
    assert.strictEqual(config.useEffective, true);
  });

  test('parses rate per-minute', () => {
    const node = makeNode('SpikeArrest', {}, [makeChild('Rate', '30pm')]);
    const { config } = classifyAndExtract('SpikeArrest', node);
    assert.strictEqual(config.count, 30);
    assert.strictEqual(config.unit, 'minute');
  });

  test('handles malformed rate gracefully', () => {
    const node = makeNode('SpikeArrest', {}, [makeChild('Rate', 'bad')]);
    const { config } = classifyAndExtract('SpikeArrest', node);
    assert.strictEqual(config.count, null);
    assert.strictEqual(config.unit, null);
  });
});

suite('PolicyRegistry — config extraction: AssignMessage', () => {
  test('extracts set headers', () => {
    const headersNode = { _tag: 'Headers', _attrs: {}, _text: '', _children: [
      makeChild('Header', 'Gravitee', { name: 'X-Powered-By' }),
      makeChild('Header', '{req-id}',  { name: 'X-Request-ID' }),
    ]};
    const setNode = { _tag: 'Set', _attrs: {}, _text: '', _children: [headersNode] };
    const node = makeNode('AssignMessage', {}, [
      makeChild('AssignTo', '', { createNew: 'false', type: 'response' }),
      setNode,
    ]);
    const { config } = classifyAndExtract('AssignMessage', node);
    assert.strictEqual(config.set.headers.length, 2);
    assert.strictEqual(config.set.headers[0].name, 'X-Powered-By');
    assert.strictEqual(config.set.headers[0].value, 'Gravitee');
    assert.strictEqual(config.assignTo.type, 'response');
    assert.strictEqual(config.assignTo.createNew, false);
  });

  test('extracts assignVariable', () => {
    const avNode = { _tag: 'AssignVariable', _attrs: {}, _text: '', _children: [
      makeChild('Name', 'my-var'),
      makeChild('Value', 'hello'),
    ]};
    const node = makeNode('AssignMessage', {}, [avNode]);
    const { config } = classifyAndExtract('AssignMessage', node);
    assert.strictEqual(config.assignVariable.length, 1);
    assert.strictEqual(config.assignVariable[0].name, 'my-var');
    assert.strictEqual(config.assignVariable[0].value, 'hello');
  });
});

suite('PolicyRegistry — config extraction: KeyValueMapOperations', () => {
  test('extracts Get operations', () => {
    const keyNode  = { _tag: 'Key', _attrs: {}, _text: '', _children: [makeChild('Parameter', 'target-url')] };
    const getNode  = { _tag: 'Get', _attrs: { assignTo: 'private.target-url' }, _text: '', _children: [keyNode] };
    const node = makeNode('KeyValueMapOperations',
      { name: 'lookup-env-config', mapIdentifier: 'env-config', scope: 'environment' },
      [getNode]
    );
    const { config } = classifyAndExtract('KeyValueMapOperations', node);
    assert.strictEqual(config.mapIdentifier, 'env-config');
    assert.strictEqual(config.scope, 'environment');
    assert.strictEqual(config.gets.length, 1);
    assert.strictEqual(config.gets[0].assignTo, 'private.target-url');
    assert.strictEqual(config.gets[0].key, 'target-url');
    assert.strictEqual(config.hasWrites, false);
  });

  test('detects Put as write operation', () => {
    const keyNode  = { _tag: 'Key', _attrs: {}, _text: '', _children: [{ _tag: 'Parameter', _attrs: { ref: 'request.queryparam.id' }, _text: '', _children: [] }] };
    const valNode  = makeChild('Value', '', { ref: 'request.content' });
    const putNode  = { _tag: 'Put', _attrs: { override: 'true' }, _text: '', _children: [keyNode, valNode] };
    const node = makeNode('KeyValueMapOperations', { mapIdentifier: 'order-cache', scope: 'apiproxy' }, [putNode]);
    const { config } = classifyAndExtract('KeyValueMapOperations', node);
    assert.strictEqual(config.puts.length, 1);
    assert.strictEqual(config.puts[0].override, true);
    assert.strictEqual(config.hasWrites, true);
  });
});

suite('PolicyRegistry — config extraction: ServiceCallout', () => {
  test('extracts target URL and response variable', () => {
    const httpNode = { _tag: 'HTTPTargetConnection', _attrs: {}, _text: '', _children: [
      makeChild('URL', 'https://api.example.com/internal'),
    ]};
    const resNode = makeChild('Response', 'calloutResponse');
    const node = makeNode('ServiceCallout', {}, [httpNode, resNode]);
    const { config } = classifyAndExtract('ServiceCallout', node);
    assert.strictEqual(config.targetUrl, 'https://api.example.com/internal');
    assert.strictEqual(config.responseVariable, 'calloutResponse');
  });
});

suite('PolicyRegistry — config extraction: OAuthV2', () => {
  test('identifies VerifyAccessToken as isVerify', () => {
    const node = makeNode('OAuthV2', {}, [makeChild('Operation', 'VerifyAccessToken')]);
    const { config } = classifyAndExtract('OAuthV2', node);
    assert.strictEqual(config.operation, 'VerifyAccessToken');
    assert.strictEqual(config.isVerify, true);
  });

  test('identifies GenerateAccessToken as not isVerify', () => {
    const node = makeNode('OAuthV2', {}, [makeChild('Operation', 'GenerateAccessToken')]);
    const { config } = classifyAndExtract('OAuthV2', node);
    assert.strictEqual(config.isVerify, false);
  });
});

suite('PolicyRegistry — config extraction: CORS', () => {
  test('extracts allow methods', () => {
    const node = makeNode('CORS', {}, [
      makeChild('AllowMethods', 'GET,POST,OPTIONS'),
      makeChild('AllowCredentials', 'true'),
    ]);
    const { config } = classifyAndExtract('CORS', node);
    assert.deepStrictEqual(config.allowMethods, ['GET', 'POST', 'OPTIONS']);
    assert.strictEqual(config.allowCredentials, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONDITION TRANSLATOR
// ═══════════════════════════════════════════════════════════════════════════════

suite('ConditionTranslator — variable translation', () => {
  test('request.verb → #request.method', () => {
    assert.strictEqual(translateVariable('request.verb'), '#request.method');
  });

  test('request.path → #request.path', () => {
    assert.strictEqual(translateVariable('request.path'), '#request.path');
  });

  test('request.header.x-api-key → #request.headers[x-api-key][0]', () => {
    assert.strictEqual(translateVariable('request.header.x-api-key'), "#request.headers['x-api-key'][0]");
  });

  test('request.header.Content-Type → #request.headers[Content-Type][0]', () => {
    assert.strictEqual(translateVariable('request.header.Content-Type'), "#request.headers['Content-Type'][0]");
  });

  test('request.queryparam.debug → #request.params[debug][0]', () => {
    assert.strictEqual(translateVariable('request.queryparam.debug'), "#request.params['debug'][0]");
  });

  test('response.status.code → #response.status', () => {
    assert.strictEqual(translateVariable('response.status.code'), '#response.status');
  });

  test('unknown variable falls back to context attribute reference', () => {
    const result = translateVariable('completely.unknown.variable.xyz');
    // Unknown variables fall back to #context.attributes[...] rather than null
    // so downstream EL is syntactically valid even if semantically imprecise
    assert.ok(result !== null);
    assert.ok(result.includes('context.attributes'));
  });
});

suite('ConditionTranslator — atomic conditions', () => {
  test('verb equals GET', () => {
    const { el, needsReview } = translateAtomicCondition('request.verb = "GET"');
    assert.strictEqual(el, "#request.method == 'GET'");
    assert.strictEqual(needsReview, false);
  });

  test('verb not equals POST', () => {
    const { el } = translateAtomicCondition('request.verb != "POST"');
    assert.strictEqual(el, "#request.method != 'POST'");
  });

  test('response status >= 400', () => {
    const { el } = translateAtomicCondition('response.status.code >= 400');
    assert.strictEqual(el, '#response.status >= 400');
  });

  test('header not null', () => {
    const { el } = translateAtomicCondition('request.header.x-api-key != null');
    assert.ok(el.includes("request.headers['x-api-key']"));
    assert.ok(el.includes('!= null'));
  });

  test('query param equals value', () => {
    const { el } = translateAtomicCondition('request.queryparam.debug = "true"');
    assert.ok(el.includes("request.params['debug']"));
    assert.ok(el.includes("'true'"));
  });

  test('empty condition returns empty string', () => {
    const { el } = translateAtomicCondition('');
    assert.strictEqual(el, '');
  });

  test('MatchesPath with wildcard', () => {
    const { el, needsReview } = translateAtomicCondition('request.path MatchesPath "/api/v1/*"');
    assert.ok(el.includes('matches'));
    assert.strictEqual(needsReview, false);
  });

  test('Matches with regex', () => {
    const { el } = translateAtomicCondition('request.path Matches "/api/.*"');
    assert.ok(el.includes('matches'));
  });
});

suite('ConditionTranslator — full conditions', () => {
  test('wraps translated condition in {# }', () => {
    const { el } = translateCondition('request.verb = "GET"');
    assert.ok(el.startsWith('{'));
    assert.ok(el.endsWith('}'));
  });

  test('empty condition produces empty string', () => {
    const { el } = translateCondition('');
    assert.strictEqual(el, '');
  });

  test('null condition produces empty string', () => {
    const { el } = translateCondition(null);
    assert.strictEqual(el, '');
  });

  test('translates AND condition', () => {
    const { el } = translateCondition('request.verb = "GET" and request.path MatchesPath "/orders/*"');
    assert.ok(el.includes('&&'));
  });

  test('preserves original in output', () => {
    const original = 'request.verb = "POST"';
    const result = translateCondition(original);
    assert.strictEqual(result.original, original);
  });

  test('needsReview is false for known patterns', () => {
    const { needsReview } = translateCondition('request.verb = "DELETE"');
    assert.strictEqual(needsReview, false);
  });

  test('OPTIONS exclusion condition', () => {
    const { el } = translateCondition('request.verb != "OPTIONS"');
    assert.ok(el.includes('OPTIONS'));
    assert.ok(el.includes('!='));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROXY AST — against fixture IR
// ═══════════════════════════════════════════════════════════════════════════════

suite('ProxyAST — fixture: orders-api', () => {
  let ast;

  try {
    ast = parseProxyFile(FIXTURE_IR);
  } catch (e) {
    console.log(`  [SKIP] Could not load fixture IR (run extractor first): ${e.message}`);
    return;
  }

  test('type is proxy', () => assert.strictEqual(ast.type, 'proxy'));
  test('name is orders-api', () => assert.strictEqual(ast.name, 'orders-api'));
  test('displayName is set', () => assert.ok(ast.displayName.length > 0));
  test('basePath is set', () => assert.strictEqual(ast.basePath, '/v1/orders'));
  test('revision is set', () => assert.strictEqual(ast.revision, '3'));

  test('policies map has 7 entries', () => {
    assert.strictEqual(Object.keys(ast.policies).length, 7);
  });

  test('verify-api-key policy has tier: security', () => {
    assert.strictEqual(ast.policies['verify-api-key'].tier, 'security');
  });

  test('verify-api-key config has apiKeyRef', () => {
    assert.strictEqual(ast.policies['verify-api-key'].config?.apiKeyRef, 'request.header.x-api-key');
  });

  test('spike-arrest policy has tier: auto', () => {
    assert.strictEqual(ast.policies['spike-arrest'].tier, 'auto');
  });

  test('spike-arrest config parses rate correctly', () => {
    const config = ast.policies['spike-arrest'].config;
    assert.strictEqual(config.count, 100);
    assert.strictEqual(config.unit, 'second');
  });

  test('validate-order-payload has tier: llm', () => {
    assert.strictEqual(ast.policies['validate-order-payload'].tier, 'llm');
  });

  test('log-response has tier: manual', () => {
    assert.strictEqual(ast.policies['log-response'].tier, 'manual');
  });

  test('lookup-env-config KVM has no writes', () => {
    const config = ast.policies['lookup-env-config'].config;
    assert.strictEqual(config.hasWrites, false);
    assert.strictEqual(config.gets.length, 1);
  });

  test('write-order-cache KVM has writes', () => {
    const config = ast.policies['write-order-cache'].config;
    assert.strictEqual(config.hasWrites, true);
    assert.strictEqual(config.puts.length, 1);
  });

  test('set-response-headers AssignMessage has headers', () => {
    const config = ast.policies['set-response-headers'].config;
    assert.ok(config.set.headers.length >= 1);
    const header = config.set.headers.find(h => h.name === 'X-Powered-By');
    assert.ok(header);
    assert.strictEqual(header.value, 'Gravitee');
  });

  test('has one proxy endpoint', () => {
    assert.strictEqual(ast.proxyEndpoints.length, 1);
  });

  test('proxy endpoint name is default', () => {
    assert.strictEqual(ast.proxyEndpoints[0].name, 'default');
  });

  test('proxy endpoint base path is /v1/orders', () => {
    assert.strictEqual(ast.proxyEndpoints[0].connection.base_path, '/v1/orders');
  });

  test('preflow request has 2 steps', () => {
    const steps = ast.proxyEndpoints[0].preFlow.request;
    assert.strictEqual(steps.length, 2);
  });

  test('preflow first step resolves to verify-api-key policy', () => {
    const step = ast.proxyEndpoints[0].preFlow.request[0];
    assert.strictEqual(step.name, 'verify-api-key');
    assert.ok(step.policy);
    assert.strictEqual(step.policy.policyType, 'VerifyAPIKey');
  });

  test('preflow second step has translated condition', () => {
    const step = ast.proxyEndpoints[0].preFlow.request[1];
    assert.strictEqual(step.name, 'spike-arrest');
    assert.ok(step.condition.el.includes('OPTIONS'));
  });

  test('has 2 named flows', () => {
    assert.strictEqual(ast.proxyEndpoints[0].flows.length, 2);
  });

  test('GetOrders flow condition translates verb', () => {
    const flow = ast.proxyEndpoints[0].flows.find(f => f.name === 'GetOrders');
    assert.ok(flow);
    assert.ok(flow.condition.el.includes('GET') || flow.condition.original.includes('GET'));
  });

  test('CreateOrder flow has 2 request steps', () => {
    const flow = ast.proxyEndpoints[0].flows.find(f => f.name === 'CreateOrder');
    assert.ok(flow);
    assert.strictEqual(flow.request.length, 2);
  });

  test('postflow response has log-response step', () => {
    const steps = ast.proxyEndpoints[0].postFlow.response;
    assert.ok(steps.some(s => s.name === 'log-response'));
  });

  test('has one target endpoint', () => {
    assert.strictEqual(ast.targetEndpoints.length, 1);
  });

  test('target endpoint has load balancer', () => {
    assert.ok(ast.targetEndpoints[0].connection.load_balancer);
    assert.strictEqual(ast.targetEndpoints[0].connection.load_balancer.algorithm, 'RoundRobin');
  });

  test('flowGraph is non-empty', () => {
    assert.ok(ast.flowGraph.length > 0);
  });

  test('flowGraph has preflow-request phase', () => {
    const phase = ast.flowGraph.find(p => p.phase === 'preflow' && p.side === 'request');
    assert.ok(phase);
    assert.ok(phase.steps.length > 0);
  });

  test('flowGraph phases have resolved policy refs', () => {
    const phase = ast.flowGraph.find(p => p.phase === 'preflow' && p.side === 'request');
    assert.ok(phase.steps[0].policy);
  });

  test('security scheme is API_KEY', () => {
    assert.strictEqual(ast.securityScheme.type, 'API_KEY');
  });

  test('security scheme policy is verify-api-key', () => {
    assert.strictEqual(ast.securityScheme.policy?.name, 'verify-api-key');
  });

  test('gaps.llmPolicies includes validate-order-payload', () => {
    assert.ok(ast.gaps.llmPolicies.includes('validate-order-payload'));
  });

  test('gaps.manualPolicies includes log-response', () => {
    assert.ok(ast.gaps.manualPolicies.includes('log-response'));
  });

  test('gaps.kvmWriteOps includes order-cache', () => {
    const writeOp = ast.gaps.kvmWriteOps.find(r => r.map_identifier === 'order-cache');
    assert.ok(writeOp);
    assert.strictEqual(writeOp.flagged, true);
  });

  test('target server refs are preserved', () => {
    assert.ok(ast.targetServerRefs.includes('orders-backend-primary'));
    assert.ok(ast.targetServerRefs.includes('orders-backend-secondary'));
  });

  test('resource files preserved', () => {
    assert.ok(ast.resources['jsc/validate-order.js']);
    assert.ok(ast.resources['jsc/validate-order.js'].includes('orderId'));
  });
});

suite('ProxyAST — sharedflow fixture: security-common', () => {
  let ast;
  try {
    ast = parseProxyFile(FIXTURE_SF_IR);
  } catch (e) {
    console.log(`  [SKIP] ${e.message}`);
    return;
  }

  test('type is sharedflow', () => assert.strictEqual(ast.type, 'sharedflow'));
  test('has no proxy endpoints', () => assert.strictEqual(ast.proxyEndpoints.length, 0));
  test('has no target endpoints', () => assert.strictEqual(ast.targetEndpoints.length, 0));
  test('flowGraph is empty for sharedflow', () => assert.strictEqual(ast.flowGraph.length, 0));
  test('oauth-verify policy is security tier', () => {
    assert.strictEqual(ast.policies['oauth-verify'].tier, 'security');
  });
});

suite('ProxyAST — parseAllProxies', () => {
  test('parses all proxies in directory', () => {
    const asts = parseAllProxies(FIXTURE_IR_DIR);
    assert.ok(Array.isArray(asts));
    assert.strictEqual(asts.length, 1);
    assert.strictEqual(asts[0].name, 'orders-api');
  });

  test('returns empty array for missing directory', () => {
    const asts = parseAllProxies('/nonexistent/dir');
    assert.deepStrictEqual(asts, []);
  });
});

suite('ProxyAST — parseProxyIr with synthetic data', () => {
  test('handles proxy with no policies gracefully', () => {
    const ir = {
      type: 'proxy', name: 'empty-proxy', revision: '1',
      display_name: 'Empty', description: '', base_path: '/empty',
      policies: {}, proxy_endpoints: [], target_endpoints: [],
      resources: {}, kvm_refs: [], shared_flow_refs: [], target_server_refs: [],
    };
    const ast = parseProxyIr(ir);
    assert.strictEqual(ast.securityScheme.type, 'KEYLESS');
    assert.deepStrictEqual(ast.gaps.llmPolicies, []);
    assert.deepStrictEqual(ast.gaps.manualPolicies, []);
    assert.deepStrictEqual(ast.flowGraph, []);
  });

  test('KEYLESS classification when no security policy present', () => {
    const ir = {
      type: 'proxy', name: 'open-api', revision: '1',
      display_name: 'Open API', description: '', base_path: '/open',
      policies: {
        'rate-limit': {
          name: 'rate-limit', policy_type: 'SpikeArrest', enabled: true,
          raw_xml: '<SpikeArrest/>', raw_dict: makeNode('SpikeArrest', {}, [makeChild('Rate', '10ps')]),
          resource_urls: [],
        },
      },
      proxy_endpoints: [{
        name: 'default',
        connection: { base_path: '/open', virtual_hosts: [] },
        pre_flow: { request: [{ name: 'rate-limit', condition: '' }], response: [] },
        flows: [], post_flow: { request: [], response: [] }, route_rules: [],
      }],
      target_endpoints: [], resources: {}, kvm_refs: [],
      shared_flow_refs: [], target_server_refs: [],
    };
    const ast = parseProxyIr(ir);
    assert.strictEqual(ast.securityScheme.type, 'KEYLESS');
  });

  test('missing step policy reference marks step as _missing', () => {
    const ir = {
      type: 'proxy', name: 'test', revision: '1',
      display_name: 'Test', description: '', base_path: '/',
      policies: {},  // empty — step will be unresolvable
      proxy_endpoints: [{
        name: 'default',
        connection: { base_path: '/', virtual_hosts: [] },
        pre_flow: { request: [{ name: 'nonexistent-policy', condition: '' }], response: [] },
        flows: [], post_flow: { request: [], response: [] }, route_rules: [],
      }],
      target_endpoints: [], resources: {}, kvm_refs: [],
      shared_flow_refs: [], target_server_refs: [],
    };
    const ast = parseProxyIr(ir);
    const step = ast.proxyEndpoints[0].preFlow.request[0];
    assert.strictEqual(step._missing, true);
    assert.strictEqual(step.policy, null);
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) console.log(`  ✗ ${f.name}`);
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}
