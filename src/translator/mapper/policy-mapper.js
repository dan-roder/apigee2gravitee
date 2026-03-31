'use strict';

/**
 * src/mapper/policy-mapper.js
 *
 * Walks a ProxyAST (from src/parser/proxy-ast.js) and produces a complete
 * Gravitee v4 API definition JSON ready to POST to the Management API.
 *
 * Output shape (Gravitee v4 API definition):
 * {
 *   definitionVersion: "V4",
 *   type:              "PROXY",
 *   name:              string,
 *   apiVersion:        string,
 *   description:       string,
 *   tags:              [],
 *
 *   listeners: [{
 *     type:        "HTTP",
 *     paths:       [{ path: string }],
 *     entrypoints: [{ type: "http-proxy" }]
 *   }],
 *
 *   endpointGroups: [{
 *     name:      "default-group",
 *     type:      "http-proxy",
 *     endpoints: [{ name, type, weight, inheritConfiguration, configuration: { target } }],
 *     services:  {},
 *   }],
 *
 *   flows: [GraviteeFlow],
 *
 *   properties: [{ key, value, encrypted }],
 *
 *   plans: {
 *     "<PLAN_NAME>": {
 *       name, description, security: { type }, mode, status
 *     }
 *   },
 *
 *   flowExecution: { mode: "DEFAULT", matchRequired: false },
 *
 *   _migrationMeta: {
 *     sourceProxy:     string,
 *     securityScheme:  string,
 *     needsReviewSteps: [...],   // steps flagged for review
 *     llmSteps:        [...],    // steps needing LLM translation
 *     manualSteps:     [...],    // steps needing manual redesign
 *     unmappedConditions: [...], // conditions that couldn't be translated
 *   }
 * }
 *
 * Gravitee flow shape:
 * {
 *   name:      string,
 *   enabled:   boolean,
 *   selectors: [{ type: "HTTP", path: "/", pathOperator: "STARTS_WITH", methods: [] }],
 *   request:   [GraviteeStep],
 *   response:  [GraviteeStep],
 * }
 */

const { mapPolicyStep } = require('./policy-handlers');

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFINITION_VERSION = 'V4';
const API_TYPE           = 'PROXY';
const ENTRYPOINT_TYPE    = 'http-proxy';
const ENDPOINT_TYPE      = 'http-proxy';
const DEFAULT_API_VERSION = '1.0.0';

// ─── Endpoint group builder ───────────────────────────────────────────────────

/**
 * Build the endpointGroups array from target endpoint ASTs.
 *
 * If a target server resolution map is provided (from bootstrap state),
 * TargetServer names are resolved to URLs. Otherwise a placeholder is used.
 *
 * @param {object[]} targetEndpoints   TargetEndpointAST[]
 * @param {object}   resolvedServers   { [name]: { url } } from bootstrap state
 * @returns {object[]}
 */
function buildEndpointGroups(targetEndpoints, resolvedServers = {}) {
  if (!targetEndpoints || targetEndpoints.length === 0) {
    return [{
      name:      'default-group',
      type:      ENDPOINT_TYPE,
      endpoints: [{
        name:                 'default',
        type:                 ENDPOINT_TYPE,
        weight:               1,
        inheritConfiguration: false,
        configuration:        { target: 'https://PLACEHOLDER_TARGET_URL' },
      }],
      services: {},
    }];
  }

  return targetEndpoints.map((te, idx) => {
    const conn = te.connection || {};
    const lb   = conn.load_balancer;
    let endpoints;

    if (lb && lb.servers && lb.servers.length > 0) {
      // Load-balanced target — one Gravitee endpoint per LB server
      endpoints = lb.servers.map(server => {
        const resolved = resolvedServers[server.name];
        const target   = resolved?.url || `https://${server.name}/`;
        return {
          name:                 server.name,
          type:                 ENDPOINT_TYPE,
          weight:               server.weight || 1,
          secondary:            !server.is_enabled,
          inheritConfiguration: false,
          configuration:        { target },
          services:             {},
        };
      });
    } else if (conn.url) {
      // Direct URL target
      endpoints = [{
        name:                 te.name || 'default',
        type:                 ENDPOINT_TYPE,
        weight:               1,
        inheritConfiguration: false,
        configuration:        { target: conn.url },
        services:             {},
      }];
    } else {
      // No URL and no LB — placeholder
      endpoints = [{
        name:                 te.name || 'default',
        type:                 ENDPOINT_TYPE,
        weight:               1,
        inheritConfiguration: false,
        configuration:        { target: 'https://PLACEHOLDER_TARGET_URL' },
        services:             {},
        _needsReview:         true,
      }];
    }

    return {
      name:      idx === 0 ? 'default-group' : `group-${te.name}`,
      type:      ENDPOINT_TYPE,
      endpoints,
      loadBalancer: lb ? { type: lb.algorithm === 'WeightedRoundRobin' ? 'WEIGHTED_ROUND_ROBIN' : 'ROUND_ROBIN' } : undefined,
      services:  {},
    };
  });
}

// ─── Flow builder ─────────────────────────────────────────────────────────────

/**
 * Extract HTTP method(s) from an Apigee condition EL string.
 * Used to populate the flow selector's `methods` array.
 *
 * @param {string} conditionEl  e.g. "{#request.method == 'GET'}"
 * @returns {string[]}  e.g. ['GET'] or [] if not determinable
 */
function extractMethodsFromCondition(conditionEl) {
  if (!conditionEl) return [];
  const methods = [];
  for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    if (conditionEl.includes(`'${m}'`) || conditionEl.includes(`"${m}"`)) {
      methods.push(m);
    }
  }
  return methods;
}

/**
 * Build a Gravitee flow selector from a flow condition EL.
 * @param {object} condition  { el, original } from condition-translator
 * @param {string} basePath   The API base path
 * @returns {object[]}        Gravitee selectors array
 */
function buildSelectors(condition, basePath) {
  const methods = extractMethodsFromCondition(condition?.el || '');

  const selector = {
    type:         'HTTP',
    path:         basePath || '/',
    pathOperator: 'STARTS_WITH',
  };

  if (methods.length > 0) {
    selector.methods = methods;
  }

  return [selector];
}

/**
 * Build Gravitee flow steps array from an array of StepASTs.
 * Skips security-tier steps (handled at Plan level) from the enabled steps
 * but still emits them as disabled stubs for auditability.
 *
 * @param {object[]} steps   StepAST[]
 * @param {string}   side    'request' | 'response'
 * @returns {{ steps: object[], meta: object }}
 */
function buildFlowSteps(steps, side) {
  const graviteeSteps = [];
  const meta = { needsReview: [], llm: [], manual: [] };

  for (const stepAst of steps) {
    const mapped = mapPolicyStep(stepAst, side);

    // Build the clean Gravitee step (strip internal _meta fields)
    const graviteeStep = {
      name:          mapped.name,
      description:   mapped.description || '',
      enabled:       mapped.enabled !== false,
      policy:        mapped.policy,
      configuration: mapped.configuration,
    };

    // Only include condition if non-empty
    if (mapped.condition) {
      graviteeStep.condition = mapped.condition;
    }

    graviteeSteps.push(graviteeStep);

    // Collect meta for _migrationMeta
    if (mapped._needsReview) {
      meta.needsReview.push(mapped._originalName || mapped.name);
    }
    if (mapped._tier === 'llm') {
      meta.llm.push({ name: mapped._originalName, rawXml: mapped._rawXml });
    }
    if (mapped._tier === 'manual') {
      meta.manual.push(mapped._originalName);
    }
  }

  return { steps: graviteeSteps, meta };
}

/**
 * Convert the AST's unified flowGraph into Gravitee flows array.
 *
 * The AST flowGraph is already split into discrete (phase, side, flowName) tuples.
 * We need to merge request and response sides of the same named flow into
 * one Gravitee flow object with both .request and .response arrays.
 *
 * PreFlow and PostFlow phases become a single "Common Flow" in Gravitee.
 *
 * @param {object[]} flowGraph   ProxyAST.flowGraph
 * @param {string}   basePath
 * @returns {{ flows: object[], meta: object }}
 */
function buildFlows(flowGraph, basePath) {
  // Group phases by flowName ('' for pre/postflow)
  const flowMap = new Map();   // flowName → { request, response, condition, phase }

  for (const phase of flowGraph) {
    const key = phase.flowName || '__common__';

    if (!flowMap.has(key)) {
      flowMap.set(key, {
        name:      phase.flowName || 'Common Flow',
        phase:     phase.phase,
        condition: phase.condition,
        request:   [],
        response:  [],
      });
    }

    const entry = flowMap.get(key);
    if (phase.side === 'request') {
      entry.request.push(...phase.steps);
    } else {
      entry.response.push(...phase.steps);
    }
  }

  const flows = [];
  const allMeta = { needsReview: [], llm: [], manual: [] };

  for (const [, entry] of flowMap) {
    const { steps: reqSteps, meta: reqMeta } = buildFlowSteps(entry.request, 'request');
    const { steps: resSteps, meta: resMeta } = buildFlowSteps(entry.response, 'response');

    // Merge meta
    allMeta.needsReview.push(...reqMeta.needsReview, ...resMeta.needsReview);
    allMeta.llm.push(...reqMeta.llm, ...resMeta.llm);
    allMeta.manual.push(...reqMeta.manual, ...resMeta.manual);

    // Skip completely empty flows
    if (reqSteps.length === 0 && resSteps.length === 0) continue;

    const selectors = buildSelectors(entry.condition, basePath);

    flows.push({
      name:      entry.name,
      enabled:   true,
      selectors,
      request:   reqSteps,
      response:  resSteps,
    });
  }

  return { flows, meta: allMeta };
}

// ─── Plan builder ─────────────────────────────────────────────────────────────

/**
 * Build the plans map from the security scheme classified by the AST.
 *
 * @param {object} securityScheme  { type: 'API_KEY'|'OAUTH2'|'JWT'|'KEYLESS', policy }
 * @returns {object}  Gravitee plans map
 */
function buildPlans(securityScheme) {
  const { type, policy } = securityScheme;

  switch (type) {
    case 'API_KEY': {
      const keyHeader = policy?.config?.apiKeyHeader || 'x-api-key';
      return {
        'API_KEY': {
          name:        'API Key Plan',
          description: `Migrated from Apigee VerifyAPIKey — key header: ${keyHeader}`,
          security:    { type: 'API_KEY' },
          mode:        'STANDARD',
          status:      'STAGING',
          flows:       [],
        },
      };
    }

    case 'OAUTH2':
      return {
        'OAUTH2': {
          name:        'OAuth2 Plan',
          description: 'Migrated from Apigee OAuthV2 VerifyAccessToken',
          security: {
            type:          'OAUTH2',
            configuration: {
              extractPayload:    false,
              checkRequiredScopes: false,
              requiredScopes:    policy?.config?.scopes || [],
              modeStrict:        false,
            },
          },
          mode:   'STANDARD',
          status: 'STAGING',
          flows:  [],
        },
      };

    case 'JWT':
      return {
        'JWT': {
          name:        'JWT Plan',
          description: 'Migrated from Apigee VerifyJWT',
          security: {
            type:          'JWT',
            configuration: {
              signature:     'RSA_RS256',
              publicKeyResolver: 'GIVEN_KEY',
            },
          },
          mode:   'STANDARD',
          status: 'STAGING',
          flows:  [],
        },
      };

    case 'KEYLESS':
    default:
      return {
        'KEYLESS': {
          name:        'Keyless Plan',
          description: 'No security — migrated from Apigee proxy with no auth policy',
          security:    { type: 'KEY_LESS' },
          mode:        'STANDARD',
          status:      'STAGING',
          flows:       [],
        },
      };
  }
}

// ─── Properties builder ───────────────────────────────────────────────────────

/**
 * Build the Gravitee API properties array from proxy-scoped KVM entries.
 * Proxy-scoped KVMs (scope === 'apiproxy') become API Properties,
 * accessible via {#api.properties['key']} in EL.
 *
 * @param {object[]} kvmRefs         From AST.kvmRefs
 * @param {object[]} proxyKvms       KvmIR objects where scope === 'proxy' for this proxy
 * @returns {object[]}               Gravitee properties array
 */
function buildProperties(kvmRefs, proxyKvms = []) {
  const properties = [];

  for (const kvm of proxyKvms) {
    for (const entry of (kvm.entries || [])) {
      if (entry.value === null) {
        // Encrypted — emit placeholder
        properties.push({
          key:       entry.name,
          value:     'ENCRYPTED_VALUE_REQUIRED',
          encrypted: true,
          dynamic:   false,
        });
      } else {
        properties.push({
          key:       entry.name,
          value:     entry.value,
          encrypted: false,
          dynamic:   false,
        });
      }
    }
  }

  return properties;
}

// ─── Main mapper ──────────────────────────────────────────────────────────────

/**
 * Map a ProxyAST to a Gravitee v4 API definition JSON.
 *
 * @param {object}   ast             ProxyAST from proxy-ast.js
 * @param {object}   [opts]          Optional overrides
 * @param {object}   [opts.resolvedServers]  { [name]: { url } } from bootstrap state
 * @param {object[]} [opts.proxyKvms]        Proxy-scoped KvmIR objects for this proxy
 * @param {string}   [opts.apiVersion]       Override API version string
 * @returns {object}  Gravitee v4 API definition
 */
function mapProxyToGraviteeApi(ast, opts = {}) {
  const resolvedServers = opts.resolvedServers || {};
  const proxyKvms       = opts.proxyKvms       || [];
  const apiVersion      = opts.apiVersion       || DEFAULT_API_VERSION;

  const basePath = ast.basePath || '/';

  // ── Listeners ───────────────────────────────────────────────────────────────
  const listeners = [{
    type:  'HTTP',
    paths: [{ path: basePath }],
    entrypoints: [{ type: ENTRYPOINT_TYPE }],
  }];

  // ── Endpoint groups ─────────────────────────────────────────────────────────
  const endpointGroups = buildEndpointGroups(ast.targetEndpoints, resolvedServers);

  // ── Flows ───────────────────────────────────────────────────────────────────
  const { flows, meta: flowMeta } = buildFlows(ast.flowGraph, basePath);

  // ── Plans ───────────────────────────────────────────────────────────────────
  const plans = buildPlans(ast.securityScheme);

  // ── Properties (proxy-scoped KVM entries) ────────────────────────────────────
  const properties = buildProperties(ast.kvmRefs, proxyKvms);

  // ── Migration meta (for gap reporter + importer decisions) ──────────────────
  const migrationMeta = {
    sourceProxy:          ast.name,
    sourceRevision:       ast.revision,
    securityScheme:       ast.securityScheme.type,
    needsReviewSteps:     [...new Set(flowMeta.needsReview)],
    llmSteps:             flowMeta.llm,
    manualSteps:          [...new Set(flowMeta.manual)],
    unmappedConditions:   ast.gaps?.reviewConditions || [],
    kvmWriteOps:          (ast.gaps?.kvmWriteOps || []).map(r => r.map_identifier),
    encryptedProperties:  properties.filter(p => p.encrypted).map(p => p.key),
    sharedFlowRefs:       ast.sharedFlowRefs || [],
    targetServerRefs:     ast.targetServerRefs || [],
  };

  return {
    definitionVersion: DEFINITION_VERSION,
    type:              API_TYPE,
    name:              ast.displayName || ast.name,
    apiVersion,
    description:       ast.description || `Migrated from Apigee proxy: ${ast.name}`,
    tags:              [],
    listeners,
    endpointGroups,
    flows,
    properties,
    plans,
    flowExecution: {
      mode:          'DEFAULT',
      matchRequired: false,
    },
    _migrationMeta: migrationMeta,
  };
}

module.exports = { mapProxyToGraviteeApi, buildEndpointGroups, buildFlows, buildPlans, buildProperties };
