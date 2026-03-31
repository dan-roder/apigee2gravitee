'use strict';

/**
 * src/parser/policy-registry.js
 *
 * Two responsibilities:
 *
 * 1. CLASSIFICATION — assigns every known Apigee policy type a mapper tier:
 *      'auto'     — a direct Gravitee policy equivalent exists; the mapper
 *                   handles it fully without human review
 *      'llm'      — no clean 1-to-1 mapping; the LLM fallback module will
 *                   attempt a translation that requires human sign-off
 *      'manual'   — no programmatic equivalent; must be redesigned by hand
 *      'security' — handled as a Plan-level security scheme rather than a
 *                   flow policy
 *
 * 2. CONFIG EXTRACTION — each 'auto' and 'security' type has an extractor
 *    function that pulls type-specific fields out of the raw_dict node and
 *    returns a clean, strongly-typed config object for the mapper.
 *
 *    The extractor receives a fully recursive node parsed from raw_xml —
 *    not the shallow raw_dict (which the Python extractor only serialises
 *    one level deep). The mapper never touches raw_xml or raw_dict directly.
 *
 * Adding a new policy type:
 *   1. Add an entry to POLICY_REGISTRY with tier + extractor.
 *   2. Add test coverage in test/parser/test-parser.js.
 */

// ─── Full XML parser (recursive, from raw_xml) ────────────────────────────────

const sax = require('sax');

/**
 * Parse an XML string into a fully recursive node tree.
 * Uses the same sax package already available in node_modules.
 * @param {string} xmlStr
 * @returns {object}  Root node { _tag, _attrs, _text, _children }
 */
function parseXmlFull(xmlStr) {
  if (!xmlStr) return { _tag: '', _attrs: {}, _text: '', _children: [] };
  const parser = sax.parser(true, { trim: false, normalize: false });
  const sentinel = { _tag: '__root__', _attrs: {}, _text: '', _children: [] };
  const stack = [sentinel];

  parser.onopentag = (node) => {
    const el = { _tag: node.name, _attrs: node.attributes || {}, _text: '', _children: [] };
    stack[stack.length - 1]._children.push(el);
    stack.push(el);
  };
  parser.onclosetag = () => {
    const el = stack.pop();
    el._text = el._text.trim();
  };
  parser.ontext = (t) => { stack[stack.length - 1]._text += t; };
  parser.oncdata = (t) => { stack[stack.length - 1]._text += t; };
  parser.onerror = () => {}; // swallow — malformed XML should not crash the parser

  try { parser.write(xmlStr).close(); } catch (_) {}
  return sentinel._children[0] || sentinel;
}

// ─── Raw-dict helpers ──────────────────────────────────────────────────────────

/** Get the text content of the first matching child tag. */
function text(node, tag, fallback = '') {
  if (!node || !Array.isArray(node._children)) return fallback;
  const child = node._children.find(c => c._tag === tag);
  return child ? (child._text || '').trim() : fallback;
}

/** Get all child nodes matching a tag. */
function children(node, tag) {
  if (!node || !Array.isArray(node._children)) return [];
  return node._children.filter(c => c._tag === tag);
}

/** Get an attribute value from a node. */
function attr(node, name, fallback = '') {
  return (node?._attrs?.[name] || fallback).trim();
}

/** Get text or attr ref — returns { value, ref } */
function textOrRef(node, tag) {
  if (!node) return { value: '', ref: '' };
  const child = (node._children || []).find(c => c._tag === tag);
  if (!child) return { value: '', ref: '' };
  return { value: (child._text || '').trim(), ref: attr(child, 'ref') };
}

// ─── Config extractors (one per auto/security policy type) ────────────────────

const extractors = {

  // ── Security policies (become Gravitee Plan security config) ────────────────

  VerifyAPIKey(n) {
    const keyNode = (n._children || []).find(c => c._tag === 'APIKey');
    return {
      apiKeyRef:    attr(keyNode, 'ref'),     // e.g. 'request.header.x-api-key'
      apiKeyHeader: attr(keyNode, 'ref').replace('request.header.', ''),
    };
  },

  OAuthV2(n) {
    const op = text(n, 'Operation');
    return {
      operation:              op,                              // VerifyAccessToken | GenerateAccessToken
      isVerify:               op === 'VerifyAccessToken',
      generateResponse:       text(n, 'GenerateResponse') !== 'false',
      externalAuthorizationUrl: text(n, 'ExternalAuthorization'),
      scopes:                 children(n, 'Scope').map(s => s._text.trim()).filter(Boolean),
    };
  },

  VerifyJWT(n) {
    return {
      algorithm:  text(n, 'Algorithm'),
      secretRef:  text(n, 'SecretKey'),
      jwksUri:    text(n, 'JWKSUri'),
      issuer:     text(n, 'Issuer'),
      audience:   text(n, 'Audience'),
    };
  },

  // ── Rate control ────────────────────────────────────────────────────────────

  SpikeArrest(n) {
    const rawRate = text(n, 'Rate');                    // e.g. '100ps', '30pm'
    const match   = rawRate.match(/^(\d+)(ps|pm)$/i);
    return {
      rawRate,
      count:          match ? parseInt(match[1], 10) : null,
      unit:           match ? (match[2].toLowerCase() === 'ps' ? 'second' : 'minute') : null,
      identifierRef:  attr((n._children || []).find(c => c._tag === 'Identifier'), 'ref'),
      useEffective:   text(n, 'UseEffectiveCount') !== 'false',
    };
  },

  Quota(n) {
    const allowNode = (n._children || []).find(c => c._tag === 'Allow');
    return {
      count:         attr(allowNode, 'count'),
      countRef:      attr(allowNode, 'countRef'),
      interval:      textOrRef(n, 'Interval'),
      timeUnit:      textOrRef(n, 'TimeUnit'),
      identifierRef: attr((n._children || []).find(c => c._tag === 'Identifier'), 'ref'),
      distributed:   text(n, 'Distributed') === 'true',
      synchronous:   text(n, 'Synchronous') === 'true',
    };
  },

  // ── Message transformation ──────────────────────────────────────────────────

  AssignMessage(n) {
    const assignToNode = (n._children || []).find(c => c._tag === 'AssignTo');
    const setNode      = (n._children || []).find(c => c._tag === 'Set');
    const addNode      = (n._children || []).find(c => c._tag === 'Add');
    const removeNode   = (n._children || []).find(c => c._tag === 'Remove');
    const copyNode     = (n._children || []).find(c => c._tag === 'Copy');

    function extractHeaders(parentNode) {
      if (!parentNode) return [];
      const headersNode = (parentNode._children || []).find(c => c._tag === 'Headers');
      return children(headersNode, 'Header').map(h => ({
        name:  attr(h, 'name'),
        value: h._text || '',
      }));
    }

    function extractQueryParams(parentNode) {
      if (!parentNode) return [];
      const qpNode = (parentNode._children || []).find(c => c._tag === 'QueryParams');
      return children(qpNode, 'QueryParam').map(q => ({
        name:  attr(q, 'name'),
        value: q._text || '',
      }));
    }

    function extractFormParams(parentNode) {
      if (!parentNode) return [];
      const fpNode = (parentNode._children || []).find(c => c._tag === 'FormParams');
      return children(fpNode, 'FormParam').map(f => ({
        name:  attr(f, 'name'),
        value: f._text || '',
      }));
    }

    return {
      assignTo: {
        type:        attr(assignToNode, 'type', 'request'),   // request | response
        createNew:   attr(assignToNode, 'createNew') === 'true',
        variable:    (assignToNode?._text || '').trim(),
      },
      set: {
        headers:     extractHeaders(setNode),
        queryParams: extractQueryParams(setNode),
        formParams:  extractFormParams(setNode),
        payload:     text(setNode, 'Payload'),
        verb:        text(setNode, 'Verb'),
        path:        text(setNode, 'Path'),
        statusCode:  text(setNode, 'StatusCode'),
        reasonPhrase: text(setNode, 'ReasonPhrase'),
      },
      add: {
        headers:     extractHeaders(addNode),
        queryParams: extractQueryParams(addNode),
        formParams:  extractFormParams(addNode),
      },
      remove: {
        headers:     extractHeaders(removeNode),
        queryParams: extractQueryParams(removeNode),
        formParams:  extractFormParams(removeNode),
        payload:     text(removeNode, 'Payload') === 'true',
      },
      copy: {
        source:      attr(copyNode, 'source'),
        headers:     extractHeaders(copyNode),
        queryParams: extractQueryParams(copyNode),
      },
      ignoreUnresolvedVariables: text(n, 'IgnoreUnresolvedVariables') !== 'false',
      assignVariable: children(n, 'AssignVariable').map(v => ({
        name:  text(v, 'Name'),
        value: text(v, 'Value'),
        ref:   text(v, 'Ref'),
      })),
    };
  },

  RaiseFault(n) {
    const faultNode    = (n._children || []).find(c => c._tag === 'FaultResponse');
    const setNode      = faultNode ? (faultNode._children || []).find(c => c._tag === 'Set') : null;
    const payloadNode  = setNode   ? (setNode._children   || []).find(c => c._tag === 'Payload') : null;
    return {
      statusCode:   text(setNode, 'StatusCode'),
      reasonPhrase: text(setNode, 'ReasonPhrase'),
      payload: {
        contentType: attr(payloadNode, 'contentType'),
        body:        payloadNode?._text || '',
      },
    };
  },

  ExtractVariables(n) {
    return {
      source:      text(n, 'Source'),
      variablePrefix: text(n, 'VariablePrefix'),
      jsonPaths:   children(n, 'JSONPayload').flatMap(j => children(j, 'Variable')).map(v => ({
        name:    attr(v, 'name'),
        type:    attr(v, 'type', 'string'),
        jsonPath: text(v, 'JSONPath'),
      })),
      xPaths:      children(n, 'XMLPayload').flatMap(x => children(x, 'Variable')).map(v => ({
        name:    attr(v, 'name'),
        type:    attr(v, 'type', 'string'),
        xPath:   text(v, 'XPath'),
      })),
      headers:     children(n, 'Header').map(h => ({
        name:     attr(h, 'name'),
        variable: text(h, 'Pattern'),
      })),
      queryParams: children(n, 'QueryParam').map(q => ({
        name:     attr(q, 'name'),
        variable: text(q, 'Pattern'),
      })),
    };
  },

  // ── KVM operations ──────────────────────────────────────────────────────────

  KeyValueMapOperations(n) {
    const gets    = children(n, 'Get').map(g => ({
      assignTo: attr(g, 'assignTo'),
      key:      text((g._children || []).find(c => c._tag === 'Key'), 'Parameter'),
      keyRef:   attr(((g._children || []).find(c => c._tag === 'Key')?._children || []).find(c => c._tag === 'Parameter'), 'ref'),
    }));
    const puts    = children(n, 'Put').map(p => ({
      override: attr(p, 'override') !== 'false',
      key:      text((p._children || []).find(c => c._tag === 'Key'), 'Parameter'),
      keyRef:   attr(((p._children || []).find(c => c._tag === 'Key')?._children || []).find(c => c._tag === 'Parameter'), 'ref'),
      valueRef: attr((p._children || []).find(c => c._tag === 'Value'), 'ref'),
    }));
    const deletes = children(n, 'Delete').map(d => ({
      key:    text((d._children || []).find(c => c._tag === 'Key'), 'Parameter'),
      keyRef: attr(((d._children || []).find(c => c._tag === 'Key')?._children || []).find(c => c._tag === 'Parameter'), 'ref'),
    }));
    return {
      mapIdentifier: attr(n, 'mapIdentifier'),
      scope:         attr(n, 'scope', 'apiproxy'),
      gets,
      puts,
      deletes,
      hasWrites:     puts.length > 0 || deletes.length > 0,
    };
  },

  // ── Callouts ────────────────────────────────────────────────────────────────

  ServiceCallout(n) {
    const reqNode = (n._children || []).find(c => c._tag === 'Request');
    const resNode = (n._children || []).find(c => c._tag === 'Response');
    const httpNode = (n._children || []).find(c => c._tag === 'HTTPTargetConnection');
    return {
      requestVariable:  attr(reqNode, 'variable'),
      responseVariable: resNode?._text?.trim() || '',
      targetUrl:        text(httpNode, 'URL'),
      timeout:          text(n, 'Timeout') || '10000',
    };
  },

  // ── Caching ─────────────────────────────────────────────────────────────────

  ResponseCache(n) {
    return {
      cacheKeyRef:       text(n, 'CacheKey'),
      expirySettings: {
        ttlSeconds:    text((n._children || []).find(c => c._tag === 'ExpirySettings'), 'TimeoutInSeconds'),
      },
      skipCacheCondition: text(n, 'SkipCacheLookup'),
      scope:             text(n, 'Scope'),
    };
  },

  LookupCache(n) {
    return {
      cacheKey:     text((n._children || []).find(c => c._tag === 'CacheKey'), 'KeyFragment'),
      assignTo:     text(n, 'AssignTo'),
      cacheResource: text(n, 'CacheResource'),
    };
  },

  PopulateCache(n) {
    return {
      cacheKey:     text((n._children || []).find(c => c._tag === 'CacheKey'), 'KeyFragment'),
      sourceRef:    text(n, 'Source'),
      cacheResource: text(n, 'CacheResource'),
      ttlSeconds:   text((n._children || []).find(c => c._tag === 'ExpirySettings'), 'TimeoutInSeconds'),
    };
  },

  InvalidateCache(n) {
    return {
      cacheKey:     text((n._children || []).find(c => c._tag === 'CacheKey'), 'KeyFragment'),
      cacheResource: text(n, 'CacheResource'),
    };
  },

  // ── Access control ──────────────────────────────────────────────────────────

  AccessControl(n) {
    return {
      allowRules: children(n, 'IPRules').filter(r => attr(r, 'noRuleMatchAction') === 'ALLOW')
        .flatMap(r => children(r, 'MatchRule').filter(m => attr(m, 'action') === 'ALLOW'))
        .flatMap(m => children(m, 'SourceAddress').map(s => s._text.trim())),
      denyRules:  children(n, 'IPRules')
        .flatMap(r => children(r, 'MatchRule').filter(m => attr(m, 'action') === 'DENY'))
        .flatMap(m => children(m, 'SourceAddress').map(s => s._text.trim())),
    };
  },

  // ── CORS ────────────────────────────────────────────────────────────────────

  CORS(n) {
    return {
      allowOrigins:     children(n, 'AllowOrigins').map(o => o._text.trim()).filter(Boolean),
      allowMethods:     text(n, 'AllowMethods').split(',').map(s => s.trim()).filter(Boolean),
      allowHeaders:     text(n, 'AllowHeaders').split(',').map(s => s.trim()).filter(Boolean),
      exposeHeaders:    text(n, 'ExposeHeaders').split(',').map(s => s.trim()).filter(Boolean),
      allowCredentials: text(n, 'AllowCredentials') === 'true',
      maxAge:           text(n, 'MaxAge'),
    };
  },

  // ── Transformation ──────────────────────────────────────────────────────────

  JSONToXML(n) {
    return {
      source:          text(n, 'Source'),
      outputVariable:  text(n, 'OutputVariable'),
      options: {
        namespaceBlockName: text(n, 'Options.NamespaceBlockName'),
        defaultNamespaceNodeName: text(n, 'Options.DefaultNamespaceNodeName'),
        namespaceSeparator: text(n, 'Options.NamespaceSeparator'),
        textNodeName:  text(n, 'Options.TextNodeName'),
        attributeBlockName: text(n, 'Options.AttributeBlockName'),
      },
    };
  },

  XMLToJSON(n) {
    return {
      source:         text(n, 'Source'),
      outputVariable: text(n, 'OutputVariable'),
    };
  },

  XSLTransform(n) {
    return {
      source:       text(n, 'Source'),
      resourceUrl:  text(n, 'ResourceURL'),
      outputVariable: text(n, 'OutputVariable'),
    };
  },

  // ── Flow callout (shared flow reference) ────────────────────────────────────

  FlowCallout(n) {
    return {
      sharedFlowBundle: text(n, 'SharedFlowBundle'),
      parameters:       children(n, 'Parameter').map(p => ({
        name:     attr(p, 'name'),
        value:    p._text || '',
        ref:      attr(p, 'ref'),
      })),
    };
  },

  // ── JavaScript ──────────────────────────────────────────────────────────────

  Javascript(n) {
    return {
      resourceUrl: text(n, 'ResourceURL'),
      timeLimit:   attr(n, 'timeLimit'),
      properties:  children(n, 'Properties').flatMap(ps => children(ps, 'Property')).map(p => ({
        name:  attr(p, 'name'),
        value: p._text || '',
      })),
    };
  },

};

// ─── Policy registry ─────────────────────────────────────────────────────────

/**
 * Master registry mapping Apigee policy type names to their tier and extractor.
 *
 * tier:
 *   'security'  — handled at Plan level, not as a flow policy
 *   'auto'      — fully automatable mapping to Gravitee policy
 *   'llm'       — sent to LLM fallback; result requires human review
 *   'manual'    — no programmatic equivalent; flagged for redesign
 */
const POLICY_REGISTRY = {
  // Security — become Plan config
  VerifyAPIKey:            { tier: 'security', extractor: extractors.VerifyAPIKey },
  OAuthV2:                 { tier: 'security', extractor: extractors.OAuthV2 },
  VerifyJWT:               { tier: 'security', extractor: extractors.VerifyJWT },
  BasicAuthentication:     { tier: 'auto',     extractor: null },   // Gravitee Basic Auth policy

  // Rate control
  SpikeArrest:             { tier: 'auto',     extractor: extractors.SpikeArrest },
  Quota:                   { tier: 'auto',     extractor: extractors.Quota },

  // Message transformation
  AssignMessage:           { tier: 'auto',     extractor: extractors.AssignMessage },
  RaiseFault:              { tier: 'auto',     extractor: extractors.RaiseFault },
  ExtractVariables:        { tier: 'auto',     extractor: extractors.ExtractVariables },
  JSONToXML:               { tier: 'auto',     extractor: extractors.JSONToXML },
  XMLToJSON:               { tier: 'auto',     extractor: extractors.XMLToJSON },
  XSLTransform:            { tier: 'auto',     extractor: extractors.XSLTransform },

  // KVM / cache
  KeyValueMapOperations:   { tier: 'auto',     extractor: extractors.KeyValueMapOperations },
  ResponseCache:           { tier: 'auto',     extractor: extractors.ResponseCache },
  LookupCache:             { tier: 'auto',     extractor: extractors.LookupCache },
  PopulateCache:           { tier: 'auto',     extractor: extractors.PopulateCache },
  InvalidateCache:         { tier: 'auto',     extractor: extractors.InvalidateCache },

  // Callouts
  ServiceCallout:          { tier: 'auto',     extractor: extractors.ServiceCallout },
  FlowCallout:             { tier: 'auto',     extractor: extractors.FlowCallout },

  // Access control
  AccessControl:           { tier: 'auto',     extractor: extractors.AccessControl },
  CORS:                    { tier: 'auto',     extractor: extractors.CORS },

  // LLM fallback — bespoke logic, no clean mapping
  Javascript:              { tier: 'llm',      extractor: extractors.Javascript },
  JavaCallout:             { tier: 'llm',      extractor: null },
  PythonScript:            { tier: 'llm',      extractor: null },

  // Manual — no Gravitee equivalent
  MessageLogging:          { tier: 'manual',   extractor: null },
  StatisticsCollector:     { tier: 'manual',   extractor: null },
  ExtensionCallout:        { tier: 'manual',   extractor: null },
  GenerateSAMLAssertion:   { tier: 'manual',   extractor: null },
  ValidateSAMLAssertion:   { tier: 'manual',   extractor: null },
  GenerateJWT:             { tier: 'llm',      extractor: null },
  DecodeJWT:               { tier: 'llm',      extractor: null },
};

/**
 * Look up a policy type's tier and extract its config.
 *
 * Accepts either:
 *   - rawDict alone (shallow, from IR) — used in tests with synthetic nodes
 *   - rawXml string — parsed into a full recursive tree before extraction
 *
 * When rawXml is provided it takes precedence, ensuring deep traversal works
 * for policies like AssignMessage whose important data lives in grandchildren.
 *
 * @param {string}        policyType  e.g. 'AssignMessage'
 * @param {object}        rawDict     Shallow raw_dict from the IR (fallback)
 * @param {string}        [rawXml]    Full policy XML string (preferred)
 * @returns {{ tier: string, config: object|null, known: boolean }}
 */
function classifyAndExtract(policyType, rawDict, rawXml) {
  const entry = POLICY_REGISTRY[policyType];
  if (!entry) {
    return { tier: 'llm', config: null, known: false };
  }
  // Parse full recursive tree from raw_xml when available
  const node = rawXml ? parseXmlFull(rawXml) : rawDict;
  const config = entry.extractor ? entry.extractor(node) : null;
  return { tier: entry.tier, config, known: true };
}

module.exports = { POLICY_REGISTRY, classifyAndExtract };
