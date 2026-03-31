'use strict';

/**
 * src/parser/condition-translator.js
 *
 * Converts Apigee condition strings to Gravitee Expression Language (EL).
 *
 * Apigee condition syntax is a custom expression language. Gravitee EL
 * is based on Spring Expression Language (SpEL), accessed via {# ... }.
 *
 * Translation approach:
 *   - Rule-based regex substitution covering the most common patterns
 *   - Unknown / complex conditions are returned as-is with a NEEDS_REVIEW flag
 *   - Empty conditions translate to empty string (always-execute)
 *
 * Supported Apigee condition patterns → Gravitee EL:
 *
 *   request.verb = "GET"                     → {#request.method == 'GET'}
 *   request.verb != "POST"                   → {#request.method != 'POST'}
 *   request.path MatchesPath "/api/v1/*"     → {#request.pathInfos[0] matches '/api/v1/.*'}
 *   request.path Matches "/api/v1/.*"        → {#request.path matches '/api/v1/.*'}
 *   request.header.x-api-key != null         → {#request.headers['x-api-key'] != null}
 *   request.header.Content-Type = "app/json" → {#request.headers['Content-Type'][0] == 'app/json'}
 *   request.queryparam.debug = "true"        → {#request.params['debug'][0] == 'true'}
 *   request.queryparam.version != null       → {#request.params['version'] != null}
 *   response.status.code = 200               → {#response.status == 200}
 *   response.status.code >= 400              → {#response.status >= 400}
 *   context.variable = "my-val"              → {#context.attributes['context.variable'] == 'my-val'}
 *   (A) and (B)                              → {(A_translated) && (B_translated)}
 *   (A) or  (B)                              → {(A_translated) || (B_translated)}
 *   !(A)                                     → {!(A_translated)}
 *   true  / false                            → (pass-through with wrapping)
 */

// ─── Token-level substitutions ────────────────────────────────────────────────

// Operators: Apigee uses Java-style infix, Gravitee uses == and !=
const OP_MAP = {
  '=':   '==',
  '!=':  '!=',
  '>':   '>',
  '>=':  '>=',
  '<':   '<',
  '<=':  '<=',
};

// Boolean logical operators
const LOGICAL_MAP = {
  ' and ':  ' && ',
  ' AND ':  ' && ',
  ' or ':   ' || ',
  ' OR ':   ' || ',
};

// ─── Variable translators ─────────────────────────────────────────────────────

/**
 * Translate a single Apigee variable reference to its Gravitee EL equivalent.
 * Returns null if the variable is unrecognised (triggers NEEDS_REVIEW).
 *
 * @param {string} variable  e.g. 'request.verb', 'request.header.x-api-key'
 * @returns {string|null}
 */
function translateVariable(variable) {
  const v = variable.trim();

  // request.verb
  if (v === 'request.verb') return '#request.method';

  // request.path / proxy.pathsuffix
  if (v === 'request.path' || v === 'proxy.pathsuffix') return '#request.path';
  if (v === 'request.uri')  return '#request.uri';

  // request.header.{name}
  const headerMatch = v.match(/^request\.header\.(.+)$/);
  if (headerMatch) {
    const name = headerMatch[1];
    return `#request.headers['${name}'][0]`;
  }

  // request.queryparam.{name}
  const qpMatch = v.match(/^request\.queryparam\.(.+)$/);
  if (qpMatch) {
    const name = qpMatch[1];
    return `#request.params['${name}'][0]`;
  }

  // response.status.code
  if (v === 'response.status.code') return '#response.status';

  // response.header.{name}
  const resHeaderMatch = v.match(/^response\.header\.(.+)$/);
  if (resHeaderMatch) {
    return `#response.headers['${resHeaderMatch[1]}'][0]`;
  }

  // request.content / request.body
  if (v === 'request.content' || v === 'request.body') return '#request.content';

  // context.variable (Apigee flow variable)
  // No direct EL equivalent — maps to context attributes
  const ctxMatch = v.match(/^([a-zA-Z_][a-zA-Z0-9_\-.]+)$/);
  if (ctxMatch) {
    return `#context.attributes['${v}']`;
  }

  return null;
}

/**
 * Translate a value literal from Apigee to Gravitee EL syntax.
 * Apigee uses double-quoted strings; EL uses single-quoted.
 *
 * @param {string} value  e.g. '"GET"' or 'null' or '200'
 * @returns {string}
 */
function translateValue(value) {
  const v = value.trim();
  // Double-quoted string → single-quoted
  if (v.startsWith('"') && v.endsWith('"')) {
    return `'${v.slice(1, -1)}'`;
  }
  // null, true, false, numbers — pass through
  return v;
}

// ─── Pattern handlers ─────────────────────────────────────────────────────────

/**
 * Handle `MatchesPath` and `Matches` operators.
 * MatchesPath uses Apigee ant-style glob; Matches uses Java regex.
 * Both map to Gravitee's `matches` operator in EL.
 *
 * @param {string} variable
 * @param {string} pattern  The path/regex string (double-quoted)
 * @param {boolean} isAntStyle  true for MatchesPath, false for Matches
 * @returns {string}
 */
function translateMatchesPattern(variable, pattern, isAntStyle) {
  const translatedVar = translateVariable(variable);
  if (!translatedVar) return null;

  // Strip surrounding quotes
  let p = pattern.trim().replace(/^"/, '').replace(/"$/, '');

  if (isAntStyle) {
    // Convert Apigee ant-style glob to Java regex:
    //   **  →  .*
    //   *   →  [^/]*
    p = p.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*');
    // Anchor if not already anchored
    if (!p.startsWith('^')) p = '^' + p;
    if (!p.endsWith('$') && !p.endsWith('.*')) p = p + '(/.*)?$';
  }

  return `${translatedVar} matches '${p}'`;
}

/**
 * Handle null checks: `variable != null` / `variable = null`
 */
function translateNullCheck(variable, op) {
  const translatedVar = translateVariable(variable);
  if (!translatedVar) return null;

  // For header/param null checks, we check the collection not the first element
  // e.g. request.headers['x-api-key'] != null (not [0])
  const nullCheckVar = translatedVar.replace(/\[0\]$/, '');
  return `${nullCheckVar} ${op === '=' ? '==' : '!='} null`;
}

// ─── Main translator ──────────────────────────────────────────────────────────

/**
 * Translate a single atomic condition clause (no logical operators).
 * Returns { el: string, needsReview: boolean }
 */
function translateAtomicCondition(condition) {
  const c = condition.trim();

  if (!c || c === 'true' || c === 'false') {
    return { el: c, needsReview: false };
  }

  // MatchesPath pattern: variable MatchesPath "pattern"
  const matchesPathRe = /^(\S+)\s+MatchesPath\s+"([^"]+)"/i;
  const matchesPathM  = c.match(matchesPathRe);
  if (matchesPathM) {
    const translated = translateMatchesPattern(matchesPathM[1], `"${matchesPathM[2]}"`, true);
    if (translated) return { el: translated, needsReview: false };
  }

  // Matches pattern: variable Matches "regex"
  const matchesRe = /^(\S+)\s+Matches\s+"([^"]+)"/i;
  const matchesM  = c.match(matchesRe);
  if (matchesM) {
    const translated = translateMatchesPattern(matchesM[1], `"${matchesM[2]}"`, false);
    if (translated) return { el: translated, needsReview: false };
  }

  // Null check: variable (=|!=) null
  const nullRe = /^(\S+)\s*(=|!=)\s*null$/i;
  const nullM  = c.match(nullRe);
  if (nullM) {
    const translated = translateNullCheck(nullM[1], nullM[2]);
    if (translated) return { el: translated, needsReview: false };
  }

  // Standard comparison: variable op "value" | variable op number
  const compRe = /^(\S+)\s*(=|!=|>=|<=|>|<)\s*(".+?"|null|true|false|\d+)$/;
  const compM  = c.match(compRe);
  if (compM) {
    const translatedVar = translateVariable(compM[1]);
    const op            = OP_MAP[compM[2]] || compM[2];
    const value         = translateValue(compM[3]);
    if (translatedVar) {
      return { el: `${translatedVar} ${op} ${value}`, needsReview: false };
    }
  }

  // Unrecognised — return as-is with review flag
  return { el: c, needsReview: true };
}

/**
 * Translate a full Apigee condition string (may contain logical operators
 * and nested parentheses) to a Gravitee EL expression string.
 *
 * @param {string} condition  Raw Apigee condition, e.g. 'request.verb = "GET" and ...'
 * @returns {{ el: string, needsReview: boolean, original: string }}
 */
function translateCondition(condition) {
  const original = condition;

  if (!condition || !condition.trim()) {
    return { el: '', needsReview: false, original };
  }

  let expr = condition.trim();

  // Normalise logical operators
  for (const [from, to] of Object.entries(LOGICAL_MAP)) {
    expr = expr.split(from).join(to);
  }

  // Split on top-level && / || while preserving parens
  // Strategy: translate leaf conditions, reconstruct with logical operators
  // For now: translate the whole expression after operator normalisation
  // by applying atomic translator to each clause

  let needsReview = false;

  // Split on &&  and  ||  boundaries (simple top-level, not nested paren-aware)
  // Replace atomic conditions with their translations
  const translated = expr.replace(
    /([^&|()]+)/g,
    (clause) => {
      const trimmed = clause.trim();
      if (!trimmed || trimmed === '&&' || trimmed === '||' || trimmed === '!' || trimmed === '(' || trimmed === ')') {
        return clause;
      }
      const result = translateAtomicCondition(trimmed);
      if (result.needsReview) needsReview = true;
      return result.el;
    }
  );

  // Wrap in {# ... } for Gravitee EL
  const el = `{${translated}}`;

  return { el, needsReview, original };
}

module.exports = { translateCondition, translateVariable, translateAtomicCondition };
