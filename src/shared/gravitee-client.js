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
}

module.exports = { GraviteeClient, GraviteeApiError };
