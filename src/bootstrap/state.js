'use strict';

/**
 * src/bootstrap/state.js
 *
 * Bootstrap state store.
 *
 * Tracks every resource created during the bootstrap phase so that:
 *   1. Reruns are idempotent — already-created resources are skipped
 *   2. Downstream modules (importer, mapper) can look up Gravitee IDs
 *      by their Apigee source name
 *   3. A human-readable receipt is written to disk after each run
 *
 * State is persisted to <irDir>/bootstrap-state.json.
 *
 * Shape of bootstrap-state.json:
 * {
 *   "bootstrappedAt": "2026-03-19T...",
 *   "dryRun": false,
 *   "org":  "DEFAULT",
 *   "env":  "DEFAULT",
 *   "dictionaries": {
 *     "<apigee-kvm-name>": {
 *       "graviteeId": "abc-123",
 *       "name": "env-config",
 *       "scope": "env",
 *       "environment": "dev",
 *       "status": "created" | "skipped" | "dry-run" | "error",
 *       "encryptedEntries": ["key-a", "key-b"],
 *       "error": null
 *     }
 *   },
 *   "targetServers": {
 *     "<name>": { "graviteeId": "...", "status": "...", "error": null }
 *   },
 *   "groups": {
 *     "<name>": { "graviteeId": "...", "status": "...", "error": null }
 *   },
 *   "summary": {
 *     "dictionaries": { "created": 3, "skipped": 1, "errors": 0 },
 *     "targetServers": { "created": 2, "skipped": 0, "errors": 0 },
 *     "groups":        { "created": 1, "skipped": 0, "errors": 0 }
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');

const FILENAME = 'bootstrap-state.json';

class BootstrapState {
  constructor(irDir) {
    this.filePath = path.join(irDir, FILENAME);
    this._state   = this._load();
  }

  // ── Persistence ───────────────────────────────────────────────────────────────

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch {
        // Corrupted state file — start fresh
      }
    }
    return {
      bootstrappedAt: null,
      dryRun:         false,
      org:            '',
      env:            '',
      dictionaries:   {},
      targetServers:  {},
      groups:         {},
      summary:        {
        dictionaries:  { created: 0, skipped: 0, errors: 0 },
        targetServers: { created: 0, skipped: 0, errors: 0 },
        groups:        { created: 0, skipped: 0, errors: 0 },
      },
    };
  }

  save() {
    this._state.bootstrappedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this._state, null, 2), 'utf8');
  }

  // ── Metadata ──────────────────────────────────────────────────────────────────

  setMeta(org, env, dryRun) {
    this._state.org    = org;
    this._state.env    = env;
    this._state.dryRun = dryRun;
  }

  // ── Dictionaries ──────────────────────────────────────────────────────────────

  /**
   * Check whether a dictionary was already successfully created in a prior run.
   * Key is `<scope>:<name>` (e.g. 'env:env-config' or 'org:org-config').
   */
  dictionaryExists(key) {
    const entry = this._state.dictionaries[key];
    return entry && (entry.status === 'created' || entry.status === 'dry-run');
  }

  getDictionaryId(key) {
    return this._state.dictionaries[key]?.graviteeId || null;
  }

  recordDictionary(key, result) {
    this._state.dictionaries[key] = result;
    const cat = this._state.summary.dictionaries;
    if (result.status === 'created' || result.status === 'dry-run') cat.created++;
    else if (result.status === 'skipped') cat.skipped++;
    else cat.errors++;
  }

  // ── Target servers ────────────────────────────────────────────────────────────

  targetServerExists(name) {
    const entry = this._state.targetServers[name];
    return entry && (entry.status === 'created' || entry.status === 'dry-run');
  }

  getTargetServerId(name) {
    return this._state.targetServers[name]?.graviteeId || null;
  }

  recordTargetServer(name, result) {
    this._state.targetServers[name] = result;
    const cat = this._state.summary.targetServers;
    if (result.status === 'created' || result.status === 'dry-run') cat.created++;
    else if (result.status === 'skipped') cat.skipped++;
    else cat.errors++;
  }

  // ── Groups ────────────────────────────────────────────────────────────────────

  groupExists(name) {
    const entry = this._state.groups[name];
    return entry && (entry.status === 'created' || entry.status === 'dry-run');
  }

  getGroupId(name) {
    return this._state.groups[name]?.graviteeId || null;
  }

  recordGroup(name, result) {
    this._state.groups[name] = result;
    const cat = this._state.summary.groups;
    if (result.status === 'created' || result.status === 'dry-run') cat.created++;
    else if (result.status === 'skipped') cat.skipped++;
    else cat.errors++;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────

  get summary() { return this._state.summary; }
  get raw()     { return this._state; }

  /**
   * Returns a flat list of all encrypted KVM entry names that were skipped
   * during dictionary population, for inclusion in post-bootstrap output.
   */
  encryptedEntryReport() {
    const lines = [];
    for (const [key, entry] of Object.entries(this._state.dictionaries)) {
      if (entry.encryptedEntries && entry.encryptedEntries.length > 0) {
        lines.push({ key, name: entry.name, scope: entry.scope, entries: entry.encryptedEntries });
      }
    }
    return lines;
  }
}

module.exports = { BootstrapState };
