'use strict';

/**
 * src/mapper/policy-handlers.js
 *
 * Per-policy handler registry.
 *
 * Each handler receives a PolicyAST node (with `.config` already extracted
 * by the policy-registry) and returns:
 *   {
 *     policy:        string,   // Gravitee policy slug, e.g. 'rate-limit'
 *     configuration: object,   // Gravitee policy configuration block
 *     name:          string,   // display name for the step
 *   }
 *
 * Handlers are only defined for 'auto' and 'security' tier policies.
 * 'llm' and 'manual' tiers are handled by the mapper directly as stubs.
 *
 * Gravitee policy slugs reference:
 *   rate-limit             SpikeArrest
 *   quota                  Quota
 *   transform-headers      AssignMessage (header ops)
 *   assign-attributes      AssignMessage (variable assignment)
 *   override-http-method   AssignMessage (verb override)
 *   http-callout           ServiceCallout
 *   cache                  ResponseCache / LookupCache / PopulateCache
 *   assign-content         AssignMessage (payload set)
 *   ip-filtering           AccessControl
 *   cors                   CORS
 *   xml-json               XMLToJSON / JSONToXML
 *   xslt                   XSLTransform
 *   groovy                 Javascript (nearest equivalent)
 *   interrupt              RaiseFault
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert Apigee EL variable ref to Gravitee EL. */
function toGraviteeEl(ref) {
  if (!ref) return '';
  // Already translated by condition-translator — pass through
  // Simple refs like 'request.header.x-api-key' not yet wrapped in {# }
  return ref.startsWith('{') ? ref : `{#context.attributes['${ref}']}`;
}

/** Normalise a time unit string to Gravitee's expected values. */
function normaliseTimeUnit(unit) {
  const u = (unit || '').toLowerCase();
  if (u === 'minute' || u === 'minutes' || u === 'pm') return 'MINUTES';
  if (u === 'second' || u === 'seconds' || u === 'ps') return 'SECONDS';
  if (u === 'hour'   || u === 'hours')   return 'HOURS';
  if (u === 'day'    || u === 'days')    return 'DAYS';
  return 'MINUTES';
}

function pluginFallbackStub(policyName, originalName, reason, scriptLines = []) {
  return {
    policy: 'groovy',
    name: `${policyName} [PLUGIN FALLBACK]`,
    configuration: {
      scope: 'REQUEST',
      script: [
        `// Plugin fallback for ${originalName}`,
        `// Reason: ${reason}`,
        ...scriptLines,
      ].join('\n'),
    },
    _needsReview: true,
  };
}

function shouldFallbackPlugin(options, pluginName) {
  const set = options?.fallbackPlugins;
  return !!(set && set.has(pluginName));
}

// ─── Handler registry ─────────────────────────────────────────────────────────

const HANDLERS = {

  // ── SpikeArrest → rate-limit ────────────────────────────────────────────────
  SpikeArrest(node) {
    const c = node.config || {};
    return {
      policy: 'rate-limit',
      name:   `Rate Limit (migrated from SpikeArrest: ${node.name})`,
      configuration: {
        async:      false,
        addHeaders: true,
        rate: {
          useKeyOnly:     false,
          periodTime:     c.count || 1,
          limit:          c.count || 100,
          periodTimeUnit: normaliseTimeUnit(c.unit || 'second'),
          key:            c.identifierRef ? `{#request.headers['${c.identifierRef.replace('request.header.', '')}'][0]}` : '',
        },
      },
    };
  },

  // ── Quota → quota ───────────────────────────────────────────────────────────
  Quota(node) {
    const c = node.config || {};
    const countVal = c.count?.value || c.count || '1000';
    const intervalVal = c.interval?.value || c.interval || '1';
    const timeUnitVal = c.timeUnit?.value || c.timeUnit || 'hour';
    return {
      policy: 'quota',
      name:   `Quota (migrated from: ${node.name})`,
      configuration: {
        async:      false,
        addHeaders: true,
        quota: {
          useKeyOnly:     false,
          periodTime:     parseInt(intervalVal, 10) || 1,
          limit:          parseInt(countVal, 10) || 1000,
          periodTimeUnit: normaliseTimeUnit(timeUnitVal),
          key:            '',
        },
      },
    };
  },

  // ── AssignMessage → multiple Gravitee policies depending on what it does ────
  AssignMessage(node, options = {}) {
    const c = node.config || {};

    // If it sets headers — use transform-headers
    if (c.set?.headers?.length > 0 || c.add?.headers?.length > 0 || c.remove?.headers?.length > 0) {
      const addHeaders = [
        ...(c.set?.headers || []).map(h => ({ name: h.name, value: h.value })),
        ...(c.add?.headers || []).map(h => ({ name: h.name, value: h.value })),
      ];
      const removeHeaders = (c.remove?.headers || []).map(h => h.name);

      return {
        policy: 'transform-headers',
        name:   `Transform Headers (migrated from: ${node.name})`,
        configuration: {
          scope:         c.assignTo?.type === 'response' ? 'RESPONSE' : 'REQUEST',
          addHeaders,
          removeHeaders,
          whitelistHeaders: [],
        },
      };
    }

    // If it overrides the HTTP verb
    if (c.set?.verb) {
      return {
        policy: 'override-http-method',
        name:   `Override HTTP Method (migrated from: ${node.name})`,
        configuration: {
          method: c.set.verb.toUpperCase(),
        },
      };
    }

    // If it sets response status code + payload (fault response pattern)
    if (c.set?.statusCode) {
      return {
        policy: 'interrupt',
        name:   `Interrupt (migrated from AssignMessage: ${node.name})`,
        configuration: {
          statusCode:   parseInt(c.set.statusCode, 10) || 200,
          message:      c.set.payload || '',
          contentType:  'application/json',
        },
      };
    }

    // If it assigns a variable → assign-attributes
    if (c.assignVariable?.length > 0) {
      if (shouldFallbackPlugin(options, 'assign-attributes')) {
        return pluginFallbackStub(
          `Assign Attributes (migrated from: ${node.name})`,
          node.name,
          'assign-attributes plugin unavailable',
          (c.assignVariable || []).map((item) => `// assign ${item.name} <= ${item.ref || JSON.stringify(item.value || '')}`),
        );
      }
      const attributes = c.assignVariable.map(v => ({
        name:  v.name,
        value: v.ref ? `{#context.attributes['${v.ref}']}` : v.value,
      }));
      return {
        policy: 'assign-attributes',
        name:   `Assign Attributes (migrated from: ${node.name})`,
        configuration: { scope: 'REQUEST', attributes },
      };
    }

    // If it sets body payload → assign-content
    if (c.set?.payload) {
      return {
        policy: 'assign-content',
        name:   `Assign Content (migrated from: ${node.name})`,
        configuration: {
          scope:   c.assignTo?.type === 'response' ? 'RESPONSE' : 'REQUEST',
          body:    c.set.payload,
        },
      };
    }

    // Fallback — generic transform-headers with empty config (mapper will flag it)
    return {
      policy: 'transform-headers',
      name:   `Transform Headers (migrated from: ${node.name}) [REVIEW NEEDED]`,
      configuration: { scope: 'REQUEST', addHeaders: [], removeHeaders: [], whitelistHeaders: [] },
      _needsReview: true,
    };
  },

  // ── RaiseFault → interrupt ──────────────────────────────────────────────────
  RaiseFault(node) {
    const c = node.config || {};
    return {
      policy: 'interrupt',
      name:   `Interrupt (migrated from RaiseFault: ${node.name})`,
      configuration: {
        statusCode:  parseInt(c.statusCode, 10) || 500,
        message:     c.payload?.body || c.reasonPhrase || 'Error',
        contentType: c.payload?.contentType || 'application/json',
      },
    };
  },

  // ── ServiceCallout → http-callout ───────────────────────────────────────────
  ServiceCallout(node, options = {}) {
    const c = node.config || {};
    if (shouldFallbackPlugin(options, 'http-callout')) {
      return pluginFallbackStub(
        `HTTP Callout (migrated from ServiceCallout: ${node.name})`,
        node.name,
        'http-callout plugin unavailable',
        [
          `// targetUrl: ${c.targetUrl || ''}`,
          `// responseVariable: ${c.responseVariable || ''}`,
        ],
      );
    }
    return {
      policy: 'http-callout',
      name:   `HTTP Callout (migrated from ServiceCallout: ${node.name})`,
      configuration: {
        method:             'GET',
        url:                c.targetUrl || '',
        headers:            [],
        body:               '',
        fireAndForget:      false,
        exitOnError:        true,
        errorCondition:     '{#calloutResponse.status >= 400}',
        errorStatusCode:    '500',
        errorContent:       '{"error":"callout failed"}',
        variables: c.responseVariable
          ? [{ name: c.responseVariable, value: '{#calloutResponse.content}' }]
          : [],
      },
    };
  },

  // ── KeyValueMapOperations → depends on operation type ───────────────────────
  KeyValueMapOperations(node, options = {}) {
    const c = node.config || {};

    // Read-only KVM get → assign-attributes using Dictionary EL
    if (!c.hasWrites && c.gets?.length > 0) {
      if (shouldFallbackPlugin(options, 'assign-attributes')) {
        return pluginFallbackStub(
          `Assign Attributes from KVM (migrated from: ${node.name})`,
          node.name,
          'assign-attributes plugin unavailable',
          (c.gets || []).map((get) => `// kvm get ${c.mapIdentifier}.${get.key || get.keyRef || ''} -> ${get.assignTo || get.key || ''}`),
        );
      }
      const attributes = c.gets.map(get => {
        let elValue;
        const scope = c.scope;
        if (scope === 'environment' || scope === 'organization') {
          elValue = `{#dictionaries['${c.mapIdentifier}']['${get.key || get.keyRef || ''}']}`;
        } else {
          // apiproxy scope → API Properties
          elValue = `{#api.properties['${get.key || get.keyRef || ''}']}`;
        }
        return { name: get.assignTo || get.key, value: elValue };
      });
      return {
        policy: 'assign-attributes',
        name:   `Assign Attributes from KVM (migrated from: ${node.name})`,
        configuration: { scope: 'REQUEST', attributes },
      };
    }

    // Write ops → cache policy (Data Cache)
    if (c.hasWrites) {
      const puts = c.puts || [];
      return {
        policy: 'cache',
        name:   `Cache Write (migrated from KVM Put: ${node.name})`,
        configuration: {
          cacheName:    c.mapIdentifier,
          key:          puts[0]?.keyRef ? `{#request.params['${puts[0].keyRef.replace('request.queryparam.', '')}'][0]}` : '{#request.path}',
          timeToLiveSeconds: 3600,
          useResponseCacheHeaders: false,
        },
        _needsReview: true,  // KVM write → cache is a semantic shift requiring review
      };
    }

    // Empty KVM ops — passthrough stub
    return {
      ...(shouldFallbackPlugin(options, 'assign-attributes')
        ? pluginFallbackStub(
          `KVM Operation (migrated from: ${node.name}) [EMPTY]`,
          node.name,
          'assign-attributes plugin unavailable',
        )
        : {
          policy: 'assign-attributes',
          name:   `KVM Operation (migrated from: ${node.name}) [EMPTY]`,
          configuration: { scope: 'REQUEST', attributes: [] },
        }),
    };
  },

  // ── ResponseCache / LookupCache / PopulateCache → cache ────────────────────
  ResponseCache(node) {
    const c = node.config || {};
    return {
      policy: 'cache',
      name:   `Cache (migrated from ResponseCache: ${node.name})`,
      configuration: {
        cacheName:               c.cacheKeyRef || 'response-cache',
        key:                     '{#request.uri}',
        timeToLiveSeconds:       parseInt(c.expirySettings?.ttlSeconds, 10) || 600,
        useResponseCacheHeaders: false,
      },
    };
  },

  LookupCache(node) {
    const c = node.config || {};
    return {
      policy: 'cache',
      name:   `Cache Lookup (migrated from LookupCache: ${node.name})`,
      configuration: {
        cacheName:               c.cacheResource || 'response-cache',
        key:                     c.cacheKey ? `{#request.path}` : '{#request.uri}',
        timeToLiveSeconds:       600,
        useResponseCacheHeaders: false,
      },
    };
  },

  PopulateCache(node) {
    const c = node.config || {};
    return {
      policy: 'cache',
      name:   `Cache Populate (migrated from PopulateCache: ${node.name})`,
      configuration: {
        cacheName:               c.cacheResource || 'response-cache',
        key:                     '{#request.uri}',
        timeToLiveSeconds:       parseInt(c.ttlSeconds, 10) || 600,
        useResponseCacheHeaders: false,
      },
    };
  },

  InvalidateCache(node) {
    return {
      policy: 'cache',
      name:   `Cache Invalidate (migrated from InvalidateCache: ${node.name})`,
      configuration: {
        cacheName: node.config?.cacheResource || 'response-cache',
        key:       '{#request.uri}',
        timeToLiveSeconds: 0,
        useResponseCacheHeaders: false,
      },
    };
  },

  // ── AccessControl → ip-filtering ────────────────────────────────────────────
  AccessControl(node) {
    const c = node.config || {};
    return {
      policy: 'ip-filtering',
      name:   `IP Filtering (migrated from AccessControl: ${node.name})`,
      configuration: {
        matchAllFromXForwardedFor: false,
        whitelistIps: c.allowRules || [],
        blacklistIps: c.denyRules  || [],
      },
    };
  },

  // ── CORS → cors ─────────────────────────────────────────────────────────────
  CORS(node) {
    const c = node.config || {};
    return {
      policy: 'cors',
      name:   `CORS (migrated from: ${node.name})`,
      configuration: {
        accessControlAllowOrigin:      c.allowOrigins?.join(',') || '*',
        accessControlAllowHeaders:     c.allowHeaders?.join(',') || '',
        accessControlAllowMethods:     c.allowMethods?.join(',') || 'GET,POST,PUT,DELETE,OPTIONS',
        accessControlExposeHeaders:    c.exposeHeaders?.join(',') || '',
        accessControlMaxAge:           c.maxAge || '-1',
        accessControlAllowCredentials: c.allowCredentials === true,
      },
    };
  },

  // ── ExtractVariables → assign-attributes ────────────────────────────────────
  ExtractVariables(node, options = {}) {
    const c = node.config || {};
    if (shouldFallbackPlugin(options, 'assign-attributes')) {
      return pluginFallbackStub(
        `Assign Attributes from Extract (migrated from: ${node.name})`,
        node.name,
        'assign-attributes plugin unavailable',
        [
          ...((c.jsonPaths || []).map(v => `// extract json ${v.jsonPath} -> ${v.name}`)),
          ...((c.xPaths || []).map(v => `// extract xpath ${v.xPath} -> ${v.name}`)),
          ...((c.headers || []).map(v => `// extract header ${v.name}`)),
        ],
      );
    }
    const attributes = [
      ...(c.jsonPaths || []).map(v => ({
        name:  v.name,
        value: `{#jsonPath(#request.content, '${v.jsonPath}')}`,
      })),
      ...(c.xPaths || []).map(v => ({
        name:  v.name,
        value: `{#xpath(#request.content, '${v.xPath}')}`,
      })),
      ...(c.headers || []).map(v => ({
        name:  v.name,
        value: `{#request.headers['${v.name}'][0]}`,
      })),
    ];
    return {
      policy: 'assign-attributes',
      name:   `Assign Attributes from Extract (migrated from: ${node.name})`,
      configuration: { scope: 'REQUEST', attributes },
    };
  },

  // ── XMLToJSON / JSONToXML → xml-json ────────────────────────────────────────
  XMLToJSON(node) {
    return {
      policy: 'xml-json',
      name:   `XML to JSON (migrated from: ${node.name})`,
      configuration: { scope: 'RESPONSE' },
    };
  },

  JSONToXML(node) {
    return {
      policy: 'xml-json',
      name:   `JSON to XML (migrated from: ${node.name})`,
      configuration: { scope: 'REQUEST' },
    };
  },

  // ── XSLTransform → xslt ─────────────────────────────────────────────────────
  XSLTransform(node) {
    const c = node.config || {};
    return {
      policy: 'xslt',
      name:   `XSLT (migrated from: ${node.name})`,
      configuration: {
        scope:       'RESPONSE',
        stylesheet:  `<!-- XSLT resource: ${c.resourceUrl || 'unknown'} — embed content here -->`,
        parameters:  [],
      },
      _needsReview: true,
    };
  },

  // ── FlowCallout → sharedPolicyGroupRef (Gravitee shared policy group) ───────
  FlowCallout(node) {
    const c = node.config || {};
    // Gravitee doesn't have a direct inline FlowCallout equivalent in flow steps.
    // The closest is a sharedPolicyGroupRef — but that's a separate Gravitee resource.
    // We emit a groovy stub that logs the intent and flag for manual review.
    return {
      policy: 'groovy',
      name:   `Shared Flow Stub (migrated from FlowCallout: ${node.name}) [REVIEW]`,
      configuration: {
        scope:  'REQUEST',
        script: `// TODO: Replace with Gravitee Shared Policy Group reference\n// Original Apigee Shared Flow: ${c.sharedFlowBundle || 'unknown'}\n// See: https://docs.gravitee.io → Shared Policy Groups`,
      },
      _needsReview: true,
    };
  },

  // ── Javascript → groovy (nearest runnable equivalent) ───────────────────────
  Javascript(node) {
    const c = node.config || {};
    return {
      policy: 'groovy',
      name:   `Groovy Script (migrated from Javascript: ${node.name}) [LLM REVIEW]`,
      configuration: {
        scope:  'REQUEST',
        script: `// Auto-translated from Apigee JavaScript policy: ${node.name}\n// Resource: ${c.resourceUrl || 'inline'}\n// TODO: Verify this translation\n\n// Original resource URL: ${c.resourceUrl || '(inline)'}`,
      },
      _needsReview: true,
      _tier:        'llm',
    };
  },
};

/**
 * Map a PolicyAST node to its Gravitee flow step representation.
 *
 * Returns a Gravitee step object:
 * {
 *   policy:        string,
 *   name:          string,
 *   description:   string,
 *   enabled:       boolean,
 *   configuration: object,
 *   condition:     string,   // Gravitee EL condition or ''
 *   _needsReview:  boolean,  // true if human review required
 *   _tier:         string,   // 'auto' | 'llm' | 'manual' | 'security' | 'stub'
 *   _originalName: string,   // Apigee policy name
 * }
 *
 * @param {object} stepAst    StepAST from proxy-ast.js
 * @param {string} [phase]    'request' | 'response' (for scope-sensitive handlers)
 * @returns {object}          Gravitee step
 */
function mapPolicyStep(stepAst, phase = 'request', options = {}) {
  const policy = stepAst.policy;
  const condition = stepAst.condition?.el || '';

  if (!policy) {
    // Missing policy reference — emit a descriptive stub
    return {
      policy:        'groovy',
      name:          `[MISSING] ${stepAst.name}`,
      description:   `Policy '${stepAst.name}' was referenced in a flow but not found in the bundle`,
      enabled:       false,
      configuration: { scope: 'REQUEST', script: `// Policy '${stepAst.name}' not found in bundle` },
      condition,
      _needsReview:  true,
      _tier:         'stub',
      _originalName: stepAst.name,
    };
  }

  if (!policy.enabled) {
    // Disabled policies — emit as disabled stub
    return {
      policy:        'groovy',
      name:          `[DISABLED] ${policy.name}`,
      description:   `Disabled Apigee policy: ${policy.policyType}`,
      enabled:       false,
      configuration: { scope: 'REQUEST', script: `// Disabled: ${policy.name}` },
      condition,
      _needsReview:  false,
      _tier:         'stub',
      _originalName: policy.name,
    };
  }

  // Security-tier policies are handled at Plan level, not as flow steps.
  // We emit them as commented stubs so the flow structure is visible but they
  // don't execute as duplicate policies.
  if (policy.tier === 'security') {
    return {
      policy:        'groovy',
      name:          `[SECURITY - handled at Plan level] ${policy.name}`,
      description:   `${policy.policyType} is implemented as Plan security in Gravitee`,
      enabled:       false,
      configuration: { scope: 'REQUEST', script: `// ${policy.policyType} → Gravitee Plan security scheme` },
      condition,
      _needsReview:  false,
      _tier:         'security',
      _originalName: policy.name,
    };
  }

  // Manual-tier policies — emit descriptive stub, flag prominently
  if (policy.tier === 'manual') {
    return {
      policy:        'groovy',
      name:          `[MANUAL REQUIRED] ${policy.name} (${policy.policyType})`,
      description:   `No Gravitee equivalent exists for ${policy.policyType}. Manual redesign required.`,
      enabled:       false,
      configuration: {
        scope:  'REQUEST',
        script: `// MANUAL MIGRATION REQUIRED\n// Apigee policy: ${policy.policyType} (${policy.name})\n// No direct Gravitee equivalent. See gap report for guidance.`,
      },
      condition,
      _needsReview:  true,
      _tier:         'manual',
      _originalName: policy.name,
    };
  }

  // LLM-tier policies without a handler — emit stub with raw XML for LLM processing
  if (policy.tier === 'llm' && !HANDLERS[policy.policyType]) {
    return {
      policy:        'groovy',
      name:          `[LLM REVIEW] ${policy.name} (${policy.policyType})`,
      description:   `Requires LLM-assisted translation. Raw XML preserved in _rawXml field.`,
      enabled:       false,
      configuration: {
        scope:  'REQUEST',
        script: `// LLM TRANSLATION REQUIRED\n// Apigee policy: ${policy.policyType} (${policy.name})\n// Submit to LLM fallback module for translation.`,
      },
      condition,
      _needsReview:  true,
      _tier:         'llm',
      _originalName: policy.name,
      _rawXml:       policy.rawXml,
    };
  }

  // Auto-tier and llm-tier with handler — invoke handler
  const handler = HANDLERS[policy.policyType];
  if (!handler) {
    return {
      policy:        'groovy',
      name:          `[UNKNOWN] ${policy.name} (${policy.policyType})`,
      description:   `Policy type '${policy.policyType}' not in registry`,
      enabled:       false,
      configuration: { scope: 'REQUEST', script: `// Unknown policy type: ${policy.policyType}` },
      condition,
      _needsReview:  true,
      _tier:         'unknown',
      _originalName: policy.name,
    };
  }

  const result = handler(policy, options);

  return {
    policy:        result.policy,
    name:          result.name,
    description:   `Migrated from Apigee ${policy.policyType}: ${policy.name}`,
    enabled:       true,
    configuration: result.configuration,
    condition,
    _needsReview:  result._needsReview || false,
    _tier:         result._tier || policy.tier,
    _originalName: policy.name,
  };
}

module.exports = { HANDLERS, mapPolicyStep };
