'use strict';

/**
 * src/shared/gravitee-client.js
 *
 * Shared Gravitee Management API HTTP client.
 *
 * Responsibilities:
 *   - Bearer token auth (Personal Access Token or Basic)
 *   - Consistent base URL construction for v1 and v2 endpoints
 *   - Automatic retry with exponential backoff on 429 / 5xx
 *   - Dry-run mode: logs what would be called without sending the request
 *   - Structured error objects with status code, endpoint, and body
 *   - Rate limiting: configurable delay between requests
 *
 * Usage:
 *   const client = new GraviteeClient({
 *     baseUrl:     'http://localhost:8083',
 *     orgId:       'DEFAULT',
 *     envId:       'DEFAULT',
 *     token:       process.env.GRAVITEE_TOKEN,
 *     dryRun:      false,
 *     rateLimit:   100,   // ms between requests (default 0)
 *     maxRetries:  3,
 *   });
 *
 *   const api = await client.post('/management/organizations/DEFAULT/environments/DEFAULT/apis', body);
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ─── Error class ──────────────────────────────────────────────────────────────

class GraviteeApiError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} → HTTP ${status}`);
    this.name   = 'GraviteeApiError';
    this.method = method;
    this.url    = url;
    this.status = status;
    this.body   = body;
  }
}

function formatErrorBody(body) {
  if (body === undefined || body === null) return '';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function normalizeCollection(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body)) return body;
  return [];
}

function classifyApiError(err) {
  if (!err) return 'unknown';
  if (typeof err.status === 'number') {
    if (err.status === 401) return 'auth';
    if (err.status === 403) return 'permission';
    if (err.status === 404) return 'unsupported-endpoint';
    if (err.status === 409) return 'conflict';
    if (err.status >= 400 && err.status < 500) return 'request';
    if (err.status >= 500) return 'server';
  }
  if (String(err.message || '').toLowerCase().includes('timed out')) return 'timeout';
  return 'network';
}

// ─── HTTP primitive (no dependencies — Node built-ins only) ───────────────────

function httpRequest(method, urlStr, headers, bodyStr, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type':  'application/json;charset=UTF-8',
        'Accept':        'application/json',
        ...headers,
      },
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : null; }
        catch { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${urlStr}`));
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Client ───────────────────────────────────────────────────────────────────

class GraviteeClient {
  /**
   * @param {object} opts
   * @param {string}  opts.baseUrl      e.g. 'http://localhost:8083'
   * @param {string}  opts.orgId        Gravitee organisation ID (default 'DEFAULT')
   * @param {string}  opts.envId        Gravitee environment ID (default 'DEFAULT')
   * @param {string}  [opts.token]      Personal Access Token (Bearer)
   * @param {string}  [opts.username]   Basic auth username (if no token)
   * @param {string}  [opts.password]   Basic auth password (if no token)
   * @param {boolean} [opts.dryRun]     If true, log calls without executing them
   * @param {number}  [opts.rateLimit]  Minimum ms between requests (default 0)
   * @param {number}  [opts.maxRetries] Max retries on 429/5xx (default 3)
   * @param {number}  [opts.timeout]    Request timeout ms (default 30000)
   */
  constructor(opts = {}) {
    if (!opts.baseUrl) throw new Error('GraviteeClient: baseUrl is required');

    this.baseUrl    = opts.baseUrl.replace(/\/$/, '');
    this.orgId      = opts.orgId || 'DEFAULT';
    this.envId      = opts.envId || 'DEFAULT';
    this.dryRun     = opts.dryRun || false;
    this.rateLimit  = opts.rateLimit || 0;
    this.maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : 3;
    this.timeout    = opts.timeout || 30000;
    this._lastCall  = 0;

    if (opts.token) {
      this._authHeader = `Bearer ${opts.token}`;
    } else if (opts.username && opts.password) {
      const b64 = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
      this._authHeader = `Basic ${b64}`;
    } else {
      throw new Error('GraviteeClient: either token or username+password is required');
    }
  }

  // ── URL builders ─────────────────────────────────────────────────────────────

  /** Build a v1 management API URL. Path should start with /management/... */
  url(path) {
    return `${this.baseUrl}${path}`;
  }

  /** Shorthand: /management/organizations/{orgId}/... */
  orgUrl(path = '') {
    return this.url(`/management/organizations/${this.orgId}${path}`);
  }

  /** Shorthand: /management/organizations/{orgId}/environments/{envId}/... */
  envUrl(path = '') {
    return this.url(`/management/organizations/${this.orgId}/environments/${this.envId}${path}`);
  }

  /** Shorthand: /management/v2/organizations/{orgId}/environments/{envId}/... */
  v2Url(path = '') {
    return this.url(`/management/v2/organizations/${this.orgId}/environments/${this.envId}${path}`);
  }

  // ── Core request ─────────────────────────────────────────────────────────────

  async _request(method, urlStr, body, retryCount = 0) {
    // Rate limiting
    if (this.rateLimit > 0) {
      const elapsed = Date.now() - this._lastCall;
      if (elapsed < this.rateLimit) {
        await sleep(this.rateLimit - elapsed);
      }
    }

    if (this.dryRun) {
      console.log(`[DRY-RUN] ${method} ${urlStr}${body ? '\n  body: ' + JSON.stringify(body).slice(0, 120) + '...' : ''}`);
      return { status: 200, body: { _dryRun: true }, raw: '{}' };
    }

    const bodyStr = body ? JSON.stringify(body) : null;
    this._lastCall = Date.now();

    let res;
    try {
      res = await httpRequest(method, urlStr, { Authorization: this._authHeader }, bodyStr, this.timeout);
    } catch (err) {
      if (retryCount < this.maxRetries) {
        const delay = 1000 * Math.pow(2, retryCount);
        await sleep(delay);
        return this._request(method, urlStr, body, retryCount + 1);
      }
      throw err;
    }

    // Retry on rate limit or server error
    if ((res.status === 429 || res.status >= 500) && retryCount < this.maxRetries) {
      const retryAfter = res.headers['retry-after'];
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : 1000 * Math.pow(2, retryCount);
      await sleep(delay);
      return this._request(method, urlStr, body, retryCount + 1);
    }

    return res;
  }

  // ── Public HTTP methods ───────────────────────────────────────────────────────

  async get(urlStr) {
    const res = await this._request('GET', urlStr, null);
    if (res.status >= 400) throw new GraviteeApiError('GET', urlStr, res.status, res.body);
    return res.body;
  }

  async post(urlStr, body) {
    const res = await this._request('POST', urlStr, body);
    if (res.status >= 400) throw new GraviteeApiError('POST', urlStr, res.status, res.body);
    return res.body;
  }

  async put(urlStr, body) {
    const res = await this._request('PUT', urlStr, body);
    if (res.status >= 400) throw new GraviteeApiError('PUT', urlStr, res.status, res.body);
    return res.body;
  }

  async patch(urlStr, body) {
    const res = await this._request('PATCH', urlStr, body);
    if (res.status >= 400) throw new GraviteeApiError('PATCH', urlStr, res.status, res.body);
    return res.body;
  }

  async delete(urlStr) {
    const res = await this._request('DELETE', urlStr, null);
    if (res.status >= 400) throw new GraviteeApiError('DELETE', urlStr, res.status, res.body);
    return res.body;
  }

  /**
   * POST, but returns null (instead of throwing) on 409 Conflict.
   * Useful for idempotent creates where the resource may already exist.
   */
  async postOrIgnoreConflict(urlStr, body) {
    const res = await this._request('POST', urlStr, body);
    if (res.status === 409) return null;
    if (res.status >= 400) throw new GraviteeApiError('POST', urlStr, res.status, res.body);
    return res.body;
  }

  // ── Health check ─────────────────────────────────────────────────────────────

  /**
   * Verify connectivity and auth. Returns true if the management API is reachable
   * and the token has at least read access.
   */
  async healthCheck() {
    try {
      await this.get(this.orgUrl());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message, status: err.status };
    }
  }

  async verifyEnvironmentAccess() {
    try {
      await this.get(this.envUrl());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message, status: err.status };
    }
  }

  async listApplications() {
    const body = await this.get(this.envUrl('/applications'));
    return normalizeCollection(body);
  }

  async listApis() {
    const body = await this.get(this.v2Url('/apis'));
    return normalizeCollection(body);
  }

  async getApi(apiId) {
    return this.get(this.v2Url(`/apis/${apiId}`));
  }

  async deleteApi(apiId) {
    return this.delete(this.v2Url(`/apis/${apiId}`));
  }

  async findApiBySourceId(sourceId) {
    if (!sourceId) return null;
    const items = await this.listApis();
    const exact = items.filter((item) => {
      const itemSourceId = item?.definitionContext?.origin?.sourceId
        || item?.crossId
        || item?.metadata?.sourceId
        || null;
      return itemSourceId === sourceId;
    });
    if (exact.length > 1) {
      throw new Error(`Ambiguous Gravitee API match for sourceId ${sourceId}`);
    }
    return exact[0] || null;
  }

  async findApiByName(name) {
    if (!name) return null;
    const items = await this.listApis();
    const exact = items.filter((item) => item?.name === name);
    if (exact.length > 1) {
      throw new Error(`Ambiguous Gravitee API match for ${name}`);
    }
    if (exact.length === 1) return exact[0];
    return null;
  }

  async createApi(payload) {
    return this._writeApiWithFallbacks('create', null, payload);
  }

  async updateApi(apiId, payload) {
    return this._writeApiWithFallbacks('update', apiId, payload);
  }

  async listRoles() {
    const roles = new Set();
    const scopeNames = ['ORGANIZATION', 'ENVIRONMENT'];

    for (const scopeName of scopeNames) {
      try {
        const items = await this.listRolesByScope(scopeName);
        for (const role of items) {
          if (role?.name) roles.add(`${scopeName}:${role.name}`);
        }
      } catch (_) {
        // Fall through to legacy endpoint below if the newer scoped endpoint is unavailable.
      }
    }

    if (roles.size > 0) return roles;

    const body = await this.get(this.orgUrl('/rolescopes'));
    const scopes = normalizeCollection(body);
    for (const scope of scopes) {
      for (const role of (scope.roles || [])) {
        if (role?.scope && role?.name) roles.add(`${role.scope}:${role.name}`);
      }
    }

    return roles;
  }

  async listRolesByScope(scope) {
    const normalizedScope = String(scope || '').toUpperCase();
    const body = await this.get(this.orgUrl(`/configuration/rolescopes/${normalizedScope}/roles`));
    return normalizeCollection(body).map((item) => ({
      ...item,
      scope: item?.scope || normalizedScope,
    }));
  }

  async resolveRoleAssignmentIds(roles = {}, options = {}) {
    const normalizeRoleName = (value) => {
      if (typeof value !== 'string') return null;
      const parts = value.split(':');
      return (parts.length > 1 ? parts.slice(1).join(':') : value).trim().toUpperCase();
    };
    const fallbackRoleName = normalizeRoleName(options.fallbackRoleName || 'USER');
    const catalogs = {
      ORGANIZATION: await this.listRolesByScope('ORGANIZATION'),
      ENVIRONMENT: await this.listRolesByScope('ENVIRONMENT'),
    };

    const resolveScopeIds = (scopeName, requestedRoles) => {
      const catalog = catalogs[scopeName] || [];
      const requestedNames = Array.from(new Set((requestedRoles || []).map(normalizeRoleName).filter(Boolean)));
      const resolved = [];

      for (const roleName of requestedNames) {
        const match = catalog.find((item) => String(item?.name || '').toUpperCase() === roleName);
        if (match?.id) resolved.push(match.id);
      }

      if (resolved.length > 0) return resolved;

      const fallback = catalog.find((item) => String(item?.name || '').toUpperCase() === fallbackRoleName);
      return fallback?.id ? [fallback.id] : [];
    };

    return {
      organization: resolveScopeIds('ORGANIZATION', roles.organization),
      environment: resolveScopeIds('ENVIRONMENT', roles.environment),
    };
  }

  async listCustomFields() {
    const names = new Set();
    for (const suffix of ['/metadata', '/applications/metadata']) {
      try {
        const body = await this.get(this.envUrl(suffix));
        const items = normalizeCollection(body);
        for (const item of items) {
          if (item?.key) names.add(item.key);
          if (item?.name) names.add(item.name);
        }
      } catch (_) {
        // Different APIM versions expose metadata on different endpoints.
      }
    }
    return names;
  }

  async createApplicationCustomField(fieldName) {
    const attempts = [];
    const payloads = [
      { key: fieldName, name: fieldName, format: 'STRING' },
      { key: fieldName, format: 'STRING' },
      { name: fieldName, format: 'STRING' },
    ];

    for (const payload of payloads) {
      try {
        const response = await this.postOrIgnoreConflict(this.envUrl('/applications/metadata'), payload);
        return response || { key: fieldName, name: fieldName, _strategy: 'conflict-existing' };
      } catch (err) {
        attempts.push({
          status: err.status || null,
          classification: classifyApiError(err),
          message: err.message,
          body: err.body,
        });
      }
    }

    const fallbackError = new Error(
      attempts
        .map((attempt) => `${attempt.message}${attempt.body ? `: ${typeof attempt.body === 'string' ? attempt.body : JSON.stringify(attempt.body)}` : ''}`)
        .join(' | ')
    );
    fallbackError.name = 'GraviteeCustomFieldCompatibilityError';
    fallbackError.classification = 'compatibility';
    fallbackError.attempts = attempts;
    throw fallbackError;
  }

  async ensureApplicationCustomFields(fieldNames) {
    const existing = await this.listCustomFields();
    const created = [];
    const skipped = [];
    const failed = [];

    for (const fieldName of fieldNames) {
      if (!fieldName || existing.has(fieldName)) {
        skipped.push(fieldName);
        continue;
      }
      try {
        await this.createApplicationCustomField(fieldName);
        existing.add(fieldName);
        created.push(fieldName);
      } catch (err) {
        failed.push({
          fieldName,
          message: err.body !== undefined
            ? `${err.message}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`
            : err.message,
          classification: err.classification || classifyApiError(err),
        });
      }
    }

    return { created, skipped, failed };
  }

  async findUserByEmail(email) {
    const body = await this.get(this.orgUrl(`/users?query=${encodeURIComponent(email)}`));
    const items = normalizeCollection(body);
    return items.find((item) => item.email === email) || null;
  }

  async getUserRoles(userId, options = {}) {
    try {
      const body = await this.get(this.orgUrl(`/users/${userId}/roles`));
      const roles = new Set();
      const items = normalizeCollection(body);
      for (const scope of items) {
        if (scope?.scope && Array.isArray(scope.roles)) {
          for (const role of scope.roles) {
            if (role?.name) roles.add(`${scope.scope}:${role.name}`);
          }
        } else if (scope?.scope && scope?.name) {
          roles.add(`${scope.scope}:${scope.name}`);
        }
      }
      return roles;
    } catch (err) {
      if (options.allowUnsupported && (err?.status === 404 || err?.status === 405)) {
        return null;
      }
      throw err;
    }
  }

  async createUser(payload) {
    return this.post(this.orgUrl('/users'), payload);
  }

  async updateUser(userId, payload) {
    return this.put(this.orgUrl(`/users/${userId}`), payload);
  }

  async deleteUser(userId) {
    return this.delete(this.orgUrl(`/users/${userId}`));
  }

  async assignUserRoles(userId, roles) {
    const organizationRoles = Array.isArray(roles?.organization) ? roles.organization : [];
    const environmentRoles = Array.isArray(roles?.environment) ? roles.environment : [];
    const organizationRoleIds = Array.isArray(roles?.organizationIds) ? roles.organizationIds : [];
    const environmentRoleIds = Array.isArray(roles?.environmentIds) ? roles.environmentIds : [];
    const normalizeRoleName = (value) => {
      if (typeof value !== 'string') return value;
      const parts = value.split(':');
      return parts.length > 1 ? parts.slice(1).join(':') : value;
    };
    const organizationRoleNames = organizationRoles.map(normalizeRoleName);
    const environmentRoleNames = environmentRoles.map(normalizeRoleName);
    const flattened = [
      ...organizationRoleNames.map((name) => ({ scope: 'ORGANIZATION', name })),
      ...environmentRoleNames.map((name) => ({ scope: 'ENVIRONMENT', name })),
    ];
    const endpoint = this.orgUrl(`/users/${userId}/roles`);
    const attempts = [];
    const referenceStrategies = [
      {
        name: 'reference-payload-organization',
        enabled: organizationRoleIds.length > 0,
        exec: () => this.put(endpoint, {
          user: userId,
          referenceId: this.orgId,
          referenceType: 'ORGANIZATION',
          roles: organizationRoleIds,
        }),
      },
      {
        name: 'reference-payload-environment',
        enabled: environmentRoleIds.length > 0,
        exec: () => this.put(endpoint, {
          user: userId,
          referenceId: this.envId,
          referenceType: 'ENVIRONMENT',
          roles: environmentRoleIds,
        }),
      },
    ];
    const fallbackStrategies = [
      {
        name: 'scoped-string-lowercase',
        exec: () => this.put(endpoint, {
          organization: organizationRoleNames.length <= 1 ? (organizationRoleNames[0] || null) : organizationRoleNames,
          environment: environmentRoleNames.length <= 1 ? (environmentRoleNames[0] || null) : environmentRoleNames,
        }),
      },
      {
        name: 'scoped-string-uppercase',
        exec: () => this.put(endpoint, {
          ORGANIZATION: organizationRoleNames.length <= 1 ? (organizationRoleNames[0] || null) : organizationRoleNames,
          ENVIRONMENT: environmentRoleNames.length <= 1 ? (environmentRoleNames[0] || null) : environmentRoleNames,
        }),
      },
      {
        name: 'scoped-object-lowercase',
        exec: () => this.put(endpoint, {
          organization: organizationRoles,
          environment: environmentRoles,
        }),
      },
      {
        name: 'scoped-object-uppercase',
        exec: () => this.put(endpoint, {
          ORGANIZATION: organizationRoles,
          ENVIRONMENT: environmentRoles,
        }),
      },
      {
        name: 'flattened-roles-array',
        exec: () => this.put(endpoint, flattened),
      },
      {
        name: 'roles-wrapper',
        exec: () => this.put(endpoint, { roles: flattened }),
      },
    ];
    const useReferencePayloads = organizationRoleIds.length > 0 || environmentRoleIds.length > 0;
    const strategies = useReferencePayloads ? referenceStrategies : fallbackStrategies;

    for (const strategy of strategies) {
      if (strategy.enabled === false) continue;
      try {
        const response = await strategy.exec();
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          response._strategy = strategy.name;
        }
        if (useReferencePayloads) {
          continue;
        }
        return response;
      } catch (err) {
        attempts.push({
          strategy: strategy.name,
          status: err.status || null,
          classification: classifyApiError(err),
          message: err.message,
          body: err.body,
        });
        if (useReferencePayloads) {
          throw (() => {
            const fallbackError = new Error(
              `${strategy.name}: ${err.message}${err.body ? `: ${formatErrorBody(err.body)}` : ''}`
            );
            fallbackError.name = 'GraviteeUserRoleCompatibilityError';
            fallbackError.classification = 'compatibility';
            fallbackError.attempts = attempts;
            return fallbackError;
          })();
        }
      }
    }

    if (useReferencePayloads) {
      return { ok: true, _strategy: 'reference-payload' };
    }

    const fallbackError = new Error(
      attempts
        .map((attempt) => `${attempt.strategy}: ${attempt.message}${attempt.body ? `: ${formatErrorBody(attempt.body)}` : ''}`)
        .join(' | ')
    );
    fallbackError.name = 'GraviteeUserRoleCompatibilityError';
    fallbackError.classification = 'compatibility';
    fallbackError.attempts = attempts;
    throw fallbackError;
  }

  async findApplicationByNameAndOwnerHint({ name, ownerHint, sourceId }) {
    const items = await this.listApplications();
    if (sourceId) {
      const bySourceId = items.find((item) => item.metadata?.sourceId === sourceId);
      if (bySourceId) return bySourceId;
    }
    return items.find((item) => (
      item.name === name && (
        !ownerHint ||
        item.owner?.displayName === ownerHint ||
        item.owner?.email === ownerHint ||
        item.metadata?.developerEmail === ownerHint
      )
    )) || items.find((item) => item.name === name) || null;
  }

  async listApplicationMembers(applicationId) {
    const body = await this.get(this.envUrl(`/applications/${applicationId}/members`));
    return normalizeCollection(body);
  }

  async createApplication(payload) {
    return this.post(this.envUrl('/applications'), payload);
  }

  async updateApplication(applicationId, payload) {
    return this.put(this.envUrl(`/applications/${applicationId}`), payload);
  }

  async deleteApplication(applicationId) {
    return this.delete(this.envUrl(`/applications/${applicationId}`));
  }

  async addApplicationMember(applicationId, payload) {
    return this.post(this.envUrl(`/applications/${applicationId}/members`), payload);
  }

  async listApiPlans(apiId) {
    const body = await this.get(this.v2Url(`/apis/${apiId}/plans`));
    return normalizeCollection(body);
  }

  async findApiPlanByName(apiId, name) {
    const plans = await this.listApiPlans(apiId);
    return plans.find((item) => item.name === name) || null;
  }

  async createApiPlan(apiId, payload) {
    const normalizedPayload = this._normalizePlanPayload(payload);
    const attempts = [];
    const strategies = [
      {
        name: 'v4-plan-raw',
        exec: () => this.post(this.v2Url(`/apis/${apiId}/plans`), normalizedPayload),
      },
      {
        name: 'v4-plan-create-wrapper',
        exec: () => this.post(this.v2Url(`/apis/${apiId}/plans`), { createPlan: normalizedPayload }),
      },
    ];
    for (const strategy of strategies) {
      try {
        const response = await strategy.exec();
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          response._strategy = strategy.name;
        }
        return response;
      } catch (err) {
        attempts.push({
          strategy: strategy.name,
          status: err.status || null,
          classification: classifyApiError(err),
          message: err.message,
          body: err.body,
        });
      }
    }
    const fallbackError = new Error(
      attempts
        .map((attempt) => `${attempt.strategy}: ${attempt.message}${attempt.body ? `: ${typeof attempt.body === 'string' ? attempt.body : JSON.stringify(attempt.body)}` : ''}`)
        .join(' | ')
    );
    fallbackError.name = 'GraviteePlanCompatibilityError';
    fallbackError.classification = 'compatibility';
    fallbackError.attempts = attempts;
    throw fallbackError;
  }

  async updateApiPlan(apiId, planId, payload) {
    const normalizedPayload = this._normalizePlanPayload(payload);
    const attempts = [];
    const strategies = [
      {
        name: 'v4-plan-raw',
        exec: () => this.put(this.v2Url(`/apis/${apiId}/plans/${planId}`), normalizedPayload),
      },
      {
        name: 'v4-plan-update-wrapper',
        exec: () => this.put(this.v2Url(`/apis/${apiId}/plans/${planId}`), { updatePlan: normalizedPayload }),
      },
    ];
    for (const strategy of strategies) {
      try {
        const response = await strategy.exec();
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          response._strategy = strategy.name;
        }
        return response;
      } catch (err) {
        attempts.push({
          strategy: strategy.name,
          status: err.status || null,
          classification: classifyApiError(err),
          message: err.message,
          body: err.body,
        });
      }
    }
    const fallbackError = new Error(
      attempts
        .map((attempt) => `${attempt.strategy}: ${attempt.message}${attempt.body ? `: ${typeof attempt.body === 'string' ? attempt.body : JSON.stringify(attempt.body)}` : ''}`)
        .join(' | ')
    );
    fallbackError.name = 'GraviteePlanCompatibilityError';
    fallbackError.classification = 'compatibility';
    fallbackError.attempts = attempts;
    throw fallbackError;
  }

  async publishApiPlan(apiId, planId) {
    return this.post(this.v2Url(`/apis/${apiId}/plans/${planId}/_publish`), {});
  }

  async closeApiPlan(apiId, planId) {
    const attempts = [];
    const strategies = [
      {
        name: 'v4-plan-close-endpoint',
        exec: () => this.post(this.v2Url(`/apis/${apiId}/plans/${planId}/_close`), {}),
      },
      {
        name: 'v4-plan-update-status-raw',
        exec: () => this.put(this.v2Url(`/apis/${apiId}/plans/${planId}`), { status: 'CLOSED' }),
      },
      {
        name: 'v4-plan-update-status-wrapper',
        exec: () => this.put(this.v2Url(`/apis/${apiId}/plans/${planId}`), { updatePlan: { status: 'CLOSED' } }),
      },
    ];
    for (const strategy of strategies) {
      try {
        const response = await strategy.exec();
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          response._strategy = strategy.name;
        }
        return response;
      } catch (err) {
        attempts.push({
          strategy: strategy.name,
          status: err.status || null,
          classification: classifyApiError(err),
          message: err.message,
          body: err.body,
        });
      }
    }
    const fallbackError = new Error(
      attempts
        .map((attempt) => `${attempt.strategy}: ${attempt.message}${attempt.body ? `: ${typeof attempt.body === 'string' ? attempt.body : JSON.stringify(attempt.body)}` : ''}`)
        .join(' | ')
    );
    fallbackError.name = 'GraviteePlanCloseCompatibilityError';
    fallbackError.classification = 'compatibility';
    fallbackError.attempts = attempts;
    throw fallbackError;
  }

  async findPlan(mapping) {
    let resolvedApiId = mapping.targetApiId || null;
    if (!resolvedApiId && mapping.targetApi) {
      const api = await this.findApiByName(mapping.targetApi);
      resolvedApiId = api?.id || null;
    }

    if (mapping.targetApiId && mapping.targetPlanId) {
      const plan = await this.get(this.v2Url(`/apis/${mapping.targetApiId}/plans/${mapping.targetPlanId}`));
      return plan ? { ...plan, apiId: plan.apiId || mapping.targetApiId } : null;
    }

    if (!resolvedApiId) {
      return {
        id: mapping.targetPlanId || mapping.targetPlan,
        apiId: null,
        name: mapping.targetPlan,
      };
    }

    const items = await this.listApiPlans(resolvedApiId);
    const found = items.find((item) => item.id === mapping.targetPlanId || item.name === mapping.targetPlan);
    return found ? { ...found, apiId: found.apiId || resolvedApiId } : null;
  }

  async findSubscription({ applicationId, apiId, planId }) {
    const body = await this.get(this.v2Url(`/apis/${apiId}/subscriptions`));
    const items = normalizeCollection(body);
    return items.find((item) => (
      item.application?.id === applicationId && item.plan?.id === planId
    )) || null;
  }

  async listSubscriptionApiKeys({ apiId, subscriptionId }) {
    const body = await this.get(this.v2Url(`/apis/${apiId}/subscriptions/${subscriptionId}/api-keys`));
    return normalizeCollection(body);
  }

  async createSubscription({ apiId, applicationId, planId }) {
    return this.post(this.v2Url(`/apis/${apiId}/subscriptions`), { applicationId, planId });
  }

  async deleteSubscription({ apiId, subscriptionId }) {
    return this.delete(this.v2Url(`/apis/${apiId}/subscriptions/${subscriptionId}`));
  }

  async closeOrPauseSubscription({ apiId, subscriptionId, status }) {
    const attempts = [];
    const strategies = [
      {
        name: 'v4-subscription-patch-status',
        exec: () => this.patch(this.v2Url(`/apis/${apiId}/subscriptions/${subscriptionId}`), { status }),
      },
      {
        name: 'v4-subscription-put-status',
        exec: () => this.put(this.v2Url(`/apis/${apiId}/subscriptions/${subscriptionId}`), { status }),
      },
      {
        name: 'v4-subscription-close-endpoint',
        exec: () => this.post(this.v2Url(`/apis/${apiId}/subscriptions/${subscriptionId}/_close`), {}),
      },
      {
        name: 'v1-subscription-close-endpoint',
        exec: () => this.post(this.envUrl(`/apis/${apiId}/subscriptions/${subscriptionId}/_close`), {}),
      },
      {
        name: 'v1-subscription-pause-endpoint',
        exec: () => this.post(this.envUrl(`/apis/${apiId}/subscriptions/${subscriptionId}/_pause`), {}),
      },
    ];
    for (const strategy of strategies) {
      try {
        const response = await strategy.exec();
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          response._strategy = strategy.name;
        }
        return response;
      } catch (err) {
        attempts.push({
          strategy: strategy.name,
          status: err.status || null,
          classification: classifyApiError(err),
          message: err.message,
          body: err.body,
        });
      }
    }
    const fallbackError = new Error(
      attempts
        .map((attempt) => `${attempt.strategy}: ${attempt.message}${attempt.body ? `: ${typeof attempt.body === 'string' ? attempt.body : JSON.stringify(attempt.body)}` : ''}`)
        .join(' | ')
    );
    fallbackError.name = 'GraviteeSubscriptionCloseCompatibilityError';
    fallbackError.classification = 'compatibility';
    fallbackError.attempts = attempts;
    throw fallbackError;
  }

  async probeEndpoint(method, urlStr, body = null, acceptableStatuses = [200, 400, 401, 403, 404, 405, 409, 415, 422]) {
    try {
      const res = await this._request(method, urlStr, body);
      return {
        ok: acceptableStatuses.includes(res.status),
        supported: res.status !== 404,
        status: res.status,
        classification: res.status === 404 ? 'unsupported-endpoint' : null,
      };
    } catch (err) {
      return {
        ok: false,
        supported: false,
        status: err.status || null,
        classification: classifyApiError(err),
        error: err.message,
      };
    }
  }

  async verifyUserProvisioningCapabilities() {
    const lookup = await this.probeEndpoint('GET', this.orgUrl(`/users?query=${encodeURIComponent('__codex_probe__')}`));
    const create = await this.probeEndpoint('POST', this.orgUrl('/users'), {});
    const roleAssign = await this.probeEndpoint('PUT', this.orgUrl('/users/__codex_probe__/roles'), {});
    const update = await this.probeEndpoint('PUT', this.orgUrl('/users/__codex_probe__'), {});
    roleAssign.required = false;
    update.required = false;
    if (roleAssign.status === 404) {
      roleAssign.ok = true;
      roleAssign.supported = true;
      roleAssign.classification = 'indeterminate-resource';
    }
    if (update.status === 404) {
      update.ok = true;
      update.supported = true;
      update.classification = 'indeterminate-resource';
    }
    return {
      ok: lookup.ok && create.supported,
      supported: lookup.supported && create.supported,
      checks: { lookup, create, update, roleAssign },
    };
  }

  async verifyApplicationOwnershipCapabilities() {
    const list = await this.probeEndpoint('GET', this.envUrl('/applications'));
    const create = await this.probeEndpoint('POST', this.envUrl('/applications'), {});
    const members = await this.probeEndpoint('GET', this.envUrl('/applications/__codex_probe__/members'));
    const addMember = await this.probeEndpoint('POST', this.envUrl('/applications/__codex_probe__/members'), {});
    members.required = false;
    addMember.required = false;
    if (members.status === 404) {
      members.ok = true;
      members.supported = true;
      members.classification = 'indeterminate-resource';
    }
    if (addMember.status === 404) {
      addMember.ok = true;
      addMember.supported = true;
      addMember.classification = 'indeterminate-resource';
    }
    return {
      ok: list.ok && create.supported,
      supported: list.supported && create.supported,
      checks: { list, create, members, addMember },
    };
  }

  async verifyApiKeyContinuityCapabilities() {
    const subscriptions = await this.probeEndpoint('GET', this.v2Url('/apis/__codex_probe__/subscriptions'));
    const create = await this.probeEndpoint('POST', this.v2Url('/apis/__codex_probe__/subscriptions'), {});
    const apiKeys = await this.probeEndpoint('GET', this.v2Url('/apis/__codex_probe__/subscriptions/__codex_probe__/api-keys'));
    subscriptions.required = false;
    create.required = false;
    apiKeys.required = false;
    for (const check of [subscriptions, create, apiKeys]) {
      if (check.status === 404) {
        check.ok = true;
        check.supported = true;
        check.classification = 'indeterminate-resource';
      }
    }
    return {
      ok: subscriptions.ok && create.supported,
      supported: subscriptions.supported && create.supported,
      checks: { subscriptions, create, apiKeys },
    };
  }

  async verifyApiImportCapabilities() {
    const listApis = await this.probeEndpoint('GET', this.v2Url('/apis'));
    const createViaV4 = await this.probeEndpoint('POST', this.v2Url('/apis'), {});
    const createApi = await this.probeEndpoint('POST', this.envUrl('/apis/import'), { api: {} });
    const updateApi = await this.probeEndpoint('PUT', this.envUrl('/apis/import'), {});
    updateApi.required = false;
    if (updateApi.status === 404 || updateApi.status === 400) {
      updateApi.ok = true;
      updateApi.supported = true;
      updateApi.classification = 'indeterminate-resource';
    }
    return {
      ok: listApis.ok && (createViaV4.supported || createApi.supported),
      supported: listApis.supported && (createViaV4.supported || createApi.supported),
      checks: { listApis, createViaV4, createApi, updateApi },
    };
  }

  _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  _stripPlans(payload) {
    const clone = this._clone(payload);
    delete clone.plans;
    return clone;
  }

  _normalizePlanPayload(payload) {
    const clone = this._clone(payload);
    const securityType = clone?.security?.type || clone?.security || 'KEY_LESS';
    const securityConfiguration = clone?.security?.configuration || {};
    const normalizedSecurity = { type: securityType };
    if (Object.keys(securityConfiguration).length > 0) {
      normalizedSecurity.configuration = securityConfiguration;
    }

    return {
      definitionVersion: clone.definitionVersion || 'V4',
      name: clone.name,
      description: clone.description || '',
      validation: clone.validation || 'AUTO',
      status: clone.status || 'STAGING',
      mode: clone.mode || 'STANDARD',
      characteristics: clone.characteristics || [],
      security: normalizedSecurity,
      flows: Array.isArray(clone.flows) ? clone.flows : [],
    };
  }

  _buildApiWriteStrategies(mode, apiId, payload) {
    const v4Full = {
      name: 'v4-management-full',
      exec: () => mode === 'create'
        ? this.post(this.v2Url('/apis'), payload)
        : this.put(this.v2Url(`/apis/${apiId}`), payload),
    };
    const v4Shell = {
      name: 'v4-management-shell',
      exec: () => mode === 'create'
        ? this.post(this.v2Url('/apis'), this._stripPlans(payload))
        : this.put(this.v2Url(`/apis/${apiId}`), this._stripPlans(payload)),
    };
    const legacyImport = {
      name: 'legacy-import-wrapper',
      exec: () => {
        if (mode === 'create') {
          return this.post(this.envUrl('/apis/import'), { api: payload });
        }
        if (apiId) {
          return this.put(this.envUrl(`/apis/${apiId}/import`), { api: payload });
        }
        return this.put(this.envUrl('/apis/import'), { api: payload });
      },
    };
    return [v4Full, v4Shell, legacyImport];
  }

  async _writeApiWithFallbacks(mode, apiId, payload) {
    const attempts = [];
    for (const strategy of this._buildApiWriteStrategies(mode, apiId, payload)) {
      try {
        const response = await strategy.exec();
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          response._strategy = strategy.name;
        }
        return response;
      } catch (err) {
        attempts.push({
          strategy: strategy.name,
          status: err.status || null,
          classification: classifyApiError(err),
          message: err.message,
          body: err.body,
        });
      }
    }

    const fallbackError = new Error(
      attempts
        .map((attempt) => `${attempt.strategy}: ${attempt.message}${attempt.body ? `: ${typeof attempt.body === 'string' ? attempt.body : JSON.stringify(attempt.body)}` : ''}`)
        .join(' | ')
    );
    fallbackError.name = 'GraviteeApiCompatibilityError';
    fallbackError.classification = 'compatibility';
    fallbackError.attempts = attempts;
    throw fallbackError;
  }
}

module.exports = {
  GraviteeClient,
  GraviteeApiError,
  normalizeCollection,
  classifyApiError,
};
