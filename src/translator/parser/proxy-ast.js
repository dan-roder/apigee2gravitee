'use strict';

/**
 * src/parser/proxy-ast.js
 *
 * Reads a BundleIR JSON (from ./ir/proxies/ or ./ir/sharedflows/) and
 * produces a fully annotated Proxy AST that the policy mapper walks.
 *
 * The IR from the extractor contains raw_xml and raw_dict for every policy,
 * and flow steps as simple { name, condition } pairs. The AST adds:
 *
 *   1. Per-policy structured config  — policy-type-specific fields extracted
 *      from raw_dict by the policy registry; the mapper never touches raw XML
 *
 *   2. Per-policy mapper tier        — 'security' | 'auto' | 'llm' | 'manual'
 *      so the mapper knows exactly how to handle each policy
 *
 *   3. Translated conditions          — each step and named flow condition is
 *      translated from Apigee syntax to Gravitee EL; needsReview is propagated
 *
 *   4. Resolved step objects          — each step reference is resolved to its
 *      full policy AST node so the mapper never needs to look up by name
 *
 *   5. Unified flow graph             — a flat ordered list of annotated phases:
 *      preflow-request, [named-flow-request per flow], postflow-request,
 *      preflow-response, [named-flow-response per flow], postflow-response
 *      This is the structure the mapper iterates to build Gravitee flows
 *
 *   6. Security classification        — which security policy type governs this
 *      proxy (API_KEY | OAUTH2 | JWT | KEYLESS) for Plan generation
 *
 *   7. Gap annotations                — policies flagged as 'llm' or 'manual',
 *      KVM write operations, unknown policy types — all surfaced for the
 *      gap reporter without the mapper needing to re-derive them
 *
 * Output AST shape (ProxyAST):
 * {
 *   // Identity (from IR)
 *   type:          'proxy' | 'sharedflow',
 *   name:          string,
 *   revision:      string,
 *   displayName:   string,
 *   description:   string,
 *   basePath:      string,
 *
 *   // Policies — keyed by name, augmented with tier + config
 *   policies: {
 *     [name]: {
 *       name:          string,
 *       policyType:    string,
 *       enabled:       boolean,
 *       tier:          'security'|'auto'|'llm'|'manual',
 *       known:         boolean,      // false if type not in registry
 *       config:        object|null,  // structured config from extractor
 *       rawXml:        string,       // passed to LLM fallback if tier==='llm'
 *       resourceUrls:  string[],
 *     }
 *   },
 *
 *   // Endpoint flow graphs
 *   proxyEndpoints:  [ ProxyEndpointAST ],
 *   targetEndpoints: [ TargetEndpointAST ],
 *
 *   // Unified flat flow graph (primary structure for the mapper)
 *   flowGraph: [ FlowPhase ],
 *
 *   // Security
 *   securityScheme: {
 *     type:   'API_KEY'|'OAUTH2'|'JWT'|'KEYLESS',
 *     policy: PolicyAST | null,   // the governing policy node
 *   },
 *
 *   // Gap annotations
 *   gaps: {
 *     llmPolicies:      string[],  // policy names needing LLM translation
 *     manualPolicies:   string[],  // policy names needing manual redesign
 *     unknownPolicies:  string[],  // types not in the registry
 *     kvmWriteOps:      KvmRef[],  // from IR kvm_refs where flagged=true
 *     reviewConditions: string[],  // condition strings that couldn't be translated
 *   },
 *
 *   // Pass-through from IR
 *   resources:         object,
 *   sharedFlowRefs:    string[],
 *   targetServerRefs:  string[],
 * }
 *
 * FlowPhase:
 * {
 *   phase:     'preflow'|'flow'|'postflow',
 *   side:      'request'|'response',
 *   flowName:  string,          // '' for pre/postflow, named flow name otherwise
 *   condition: { el, needsReview, original },  // flow-level condition (named flows only)
 *   steps:     [ StepAST ],
 * }
 *
 * StepAST:
 * {
 *   name:        string,
 *   condition:   { el, needsReview, original },
 *   policy:      PolicyAST,   // resolved reference
 * }
 */

const fs   = require('fs');
const path = require('path');
const { classifyAndExtract } = require('./policy-registry');
const { translateCondition } = require('./condition-translator');

// ─── Policy augmentation ──────────────────────────────────────────────────────

/**
 * Augment a raw IR policy object with tier, config, and translated fields.
 * @param {object} irPolicy  Raw policy object from the IR JSON
 * @returns {object}         PolicyAST node
 */
function buildPolicyNode(irPolicy) {
  const { tier, config, known } = classifyAndExtract(
    irPolicy.policy_type,
    irPolicy.raw_dict,
    irPolicy.raw_xml      // full XML — enables deep child traversal
  );

  return {
    name:         irPolicy.name,
    policyType:   irPolicy.policy_type,
    enabled:      irPolicy.enabled !== false,
    tier,
    known,
    config,
    rawXml:       irPolicy.raw_xml || '',
    rawDict:      irPolicy.raw_dict || {},
    resourceUrls: irPolicy.resource_urls || [],
  };
}

// ─── Step resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a raw IR step to a StepAST, linking it to its PolicyAST.
 * @param {object}              irStep    { name, condition }
 * @param {Map<string, object>} policyMap name → PolicyAST
 * @returns {object}  StepAST
 */
function resolveStep(irStep, policyMap) {
  const policy = policyMap.get(irStep.name);
  const translatedCondition = translateCondition(irStep.condition || '');

  return {
    name:      irStep.name,
    condition: translatedCondition,
    policy:    policy || null,   // null if step references a policy not in the bundle
    _missing:  !policy,
  };
}

// ─── Phase builders ───────────────────────────────────────────────────────────

function buildPhase(phase, side, flowName, condition, irSteps, policyMap) {
  return {
    phase,
    side,
    flowName,
    condition: condition || { el: '', needsReview: false, original: '' },
    steps: (irSteps || []).map(s => resolveStep(s, policyMap)),
  };
}

/**
 * Build the unified flow graph from a ProxyEndpoint IR.
 * Order: preflow-request, [named-flow requests], postflow-request,
 *        preflow-response, [named-flow responses], postflow-response
 */
function buildFlowGraph(proxyEndpoint, policyMap) {
  const phases = [];

  // PreFlow
  phases.push(buildPhase('preflow', 'request', '', null,
    proxyEndpoint.pre_flow?.request, policyMap));
  phases.push(buildPhase('preflow', 'response', '', null,
    proxyEndpoint.pre_flow?.response, policyMap));

  // Named flows
  for (const flow of (proxyEndpoint.flows || [])) {
    const flowCondition = translateCondition(flow.condition || '');
    phases.push(buildPhase('flow', 'request', flow.name, flowCondition,
      flow.request, policyMap));
    phases.push(buildPhase('flow', 'response', flow.name, flowCondition,
      flow.response, policyMap));
  }

  // PostFlow
  phases.push(buildPhase('postflow', 'request', '', null,
    proxyEndpoint.post_flow?.request, policyMap));
  phases.push(buildPhase('postflow', 'response', '', null,
    proxyEndpoint.post_flow?.response, policyMap));

  // Filter out completely empty phases (no steps and not a named flow)
  return phases.filter(p => p.steps.length > 0 || p.flowName);
}

// ─── ProxyEndpoint AST ────────────────────────────────────────────────────────

function buildProxyEndpointAST(irEndpoint, policyMap) {
  return {
    name:        irEndpoint.name,
    connection:  irEndpoint.connection,
    preFlow: {
      request:  (irEndpoint.pre_flow?.request  || []).map(s => resolveStep(s, policyMap)),
      response: (irEndpoint.pre_flow?.response || []).map(s => resolveStep(s, policyMap)),
    },
    flows: (irEndpoint.flows || []).map(flow => ({
      name:      flow.name,
      condition: translateCondition(flow.condition || ''),
      request:   (flow.request  || []).map(s => resolveStep(s, policyMap)),
      response:  (flow.response || []).map(s => resolveStep(s, policyMap)),
    })),
    postFlow: {
      request:  (irEndpoint.post_flow?.request  || []).map(s => resolveStep(s, policyMap)),
      response: (irEndpoint.post_flow?.response || []).map(s => resolveStep(s, policyMap)),
    },
    routeRules: (irEndpoint.route_rules || []).map(rr => ({
      name:      rr.name,
      condition: translateCondition(rr.condition || ''),
      target:    rr.target,
    })),
  };
}

// ─── TargetEndpoint AST ───────────────────────────────────────────────────────

function buildTargetEndpointAST(irEndpoint, policyMap) {
  return {
    name:       irEndpoint.name,
    connection: irEndpoint.connection,
    preFlow: {
      request:  (irEndpoint.pre_flow?.request  || []).map(s => resolveStep(s, policyMap)),
      response: (irEndpoint.pre_flow?.response || []).map(s => resolveStep(s, policyMap)),
    },
    flows: (irEndpoint.flows || []).map(flow => ({
      name:      flow.name,
      condition: translateCondition(flow.condition || ''),
      request:   (flow.request  || []).map(s => resolveStep(s, policyMap)),
      response:  (flow.response || []).map(s => resolveStep(s, policyMap)),
    })),
    postFlow: {
      request:  (irEndpoint.post_flow?.request  || []).map(s => resolveStep(s, policyMap)),
      response: (irEndpoint.post_flow?.response || []).map(s => resolveStep(s, policyMap)),
    },
  };
}

// ─── Security classification ─────────────────────────────────────────────────

const SECURITY_TYPE_MAP = {
  VerifyAPIKey: 'API_KEY',
  OAuthV2:      'OAUTH2',
  VerifyJWT:    'JWT',
};

/**
 * Identify the primary security scheme for this proxy by finding a 'security'
 * tier policy that is applied in the preflow request pipeline.
 *
 * Falls back to scanning ALL flow steps if not in preflow.
 * Returns KEYLESS if no security policy is found.
 *
 * @param {Map<string, object>} policyMap
 * @param {object[]}            proxyEndpoints  (AST nodes, already built)
 * @returns {{ type: string, policy: object|null }}
 */
function classifySecurityScheme(policyMap, proxyEndpoints) {
  // Priority: preflow request first (most common placement)
  for (const ep of proxyEndpoints) {
    for (const step of ep.preFlow.request) {
      if (step.policy && step.policy.tier === 'security') {
        const type = SECURITY_TYPE_MAP[step.policy.policyType] || 'UNKNOWN';
        return { type, policy: step.policy };
      }
    }
  }

  // Fallback: scan named flows
  for (const ep of proxyEndpoints) {
    for (const flow of ep.flows) {
      for (const step of flow.request) {
        if (step.policy && step.policy.tier === 'security') {
          const type = SECURITY_TYPE_MAP[step.policy.policyType] || 'UNKNOWN';
          return { type, policy: step.policy };
        }
      }
    }
  }

  // Also check for OAuthV2 VerifyAccessToken specifically
  for (const [, policy] of policyMap) {
    if (policy.tier === 'security' && policy.policyType === 'OAuthV2') {
      if (policy.config?.isVerify) {
        return { type: 'OAUTH2', policy };
      }
    }
  }

  return { type: 'KEYLESS', policy: null };
}

// ─── Gap collection ───────────────────────────────────────────────────────────

function collectGaps(policyMap, proxyEndpoints, targetEndpoints, irBundle) {
  const llmPolicies      = [];
  const manualPolicies   = [];
  const unknownPolicies  = [];
  const reviewConditions = [];

  for (const [name, policy] of policyMap) {
    if (policy.tier === 'llm')    llmPolicies.push(name);
    if (policy.tier === 'manual') manualPolicies.push(name);
    if (!policy.known)            unknownPolicies.push(`${name} (type: ${policy.policyType})`);
  }

  // Collect conditions that need review
  function scanSteps(steps) {
    for (const step of steps) {
      if (step.condition?.needsReview && step.condition.original) {
        reviewConditions.push(step.condition.original);
      }
    }
  }
  function scanEndpoint(ep) {
    scanSteps(ep.preFlow.request);
    scanSteps(ep.preFlow.response);
    for (const flow of ep.flows) {
      if (flow.condition?.needsReview && flow.condition.original) {
        reviewConditions.push(flow.condition.original);
      }
      scanSteps(flow.request);
      scanSteps(flow.response);
    }
    scanSteps(ep.postFlow.request);
    scanSteps(ep.postFlow.response);
  }

  for (const ep of proxyEndpoints)   scanEndpoint(ep);
  for (const ep of targetEndpoints)  scanEndpoint(ep);

  return {
    llmPolicies,
    manualPolicies,
    unknownPolicies,
    kvmWriteOps:      (irBundle.kvm_refs || []).filter(r => r.flagged),
    reviewConditions: [...new Set(reviewConditions)],
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parse a BundleIR object into a fully annotated ProxyAST.
 *
 * @param {object} irBundle  Parsed JSON from ir/proxies/{name}.json
 * @returns {object}         ProxyAST
 */
function parseProxyIr(irBundle) {
  // 1. Build the policy map (name → PolicyAST)
  const policyMap = new Map();
  for (const [name, irPolicy] of Object.entries(irBundle.policies || {})) {
    policyMap.set(name, buildPolicyNode(irPolicy));
  }

  // 2. Build endpoint ASTs
  const proxyEndpoints  = (irBundle.proxy_endpoints  || []).map(ep => buildProxyEndpointAST(ep, policyMap));
  const targetEndpoints = (irBundle.target_endpoints || []).map(ep => buildTargetEndpointAST(ep, policyMap));

  // 3. Build unified flow graph (from first proxy endpoint — multi-endpoint is rare)
  const primaryEndpoint = irBundle.proxy_endpoints?.[0];
  const flowGraph = primaryEndpoint
    ? buildFlowGraph(primaryEndpoint, policyMap)
    : [];

  // 4. Security classification
  const securityScheme = classifySecurityScheme(policyMap, proxyEndpoints);

  // 5. Gap collection
  const gaps = collectGaps(policyMap, proxyEndpoints, targetEndpoints, irBundle);

  return {
    // Identity
    type:         irBundle.type,
    name:         irBundle.name,
    revision:     irBundle.revision     || '',
    displayName:  irBundle.display_name || irBundle.name,
    description:  irBundle.description  || '',
    basePath:     irBundle.base_path    || '/',

    // Policy map as plain object for serialisation
    policies:       Object.fromEntries(policyMap),

    // Endpoint ASTs
    proxyEndpoints,
    targetEndpoints,

    // Unified flow graph
    flowGraph,

    // Security
    securityScheme,

    // Gaps
    gaps,

    // Pass-through from IR
    resources:        irBundle.resources        || {},
    kvmRefs:          irBundle.kvm_refs         || [],
    sharedFlowRefs:   irBundle.shared_flow_refs || [],
    targetServerRefs: irBundle.target_server_refs || [],

    _meta: irBundle.meta || {},
  };
}

/**
 * Load a proxy IR JSON file from disk and return its ProxyAST.
 *
 * @param {string} irFilePath  Path to ir/proxies/{name}.json
 * @returns {object}           ProxyAST
 */
function parseProxyFile(irFilePath) {
  const raw      = fs.readFileSync(irFilePath, 'utf8');
  const irBundle = JSON.parse(raw);
  return parseProxyIr(irBundle);
}

/**
 * Parse all proxy IR files in a directory.
 *
 * @param {string} irProxiesDir  Path to ir/proxies/
 * @returns {object[]}           Array of ProxyAST objects
 */
function parseAllProxies(irProxiesDir) {
  if (!fs.existsSync(irProxiesDir)) return [];
  return fs.readdirSync(irProxiesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => parseProxyFile(path.join(irProxiesDir, f)));
}

module.exports = { parseProxyIr, parseProxyFile, parseAllProxies };
