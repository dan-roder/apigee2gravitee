'use strict';

/**
 * src/shared/ir-loader.js
 *
 * Reads the IR directory produced by the extractor and returns typed
 * collections for use by the bootstrap and later pipeline steps.
 *
 * All returned objects are plain JS objects parsed from JSON — no
 * transformation is applied; the IR schema from schema.py is the source
 * of truth for field names (snake_case).
 */

const fs   = require('fs');
const path = require('path');

/**
 * Read and parse a JSON file. Returns null if the file doesn't exist.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Recursively collect all .json files under a directory.
 * Returns [] if the directory doesn't exist.
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function findJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...findJsonFiles(full));
    } else if (entry.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

class IrLoader {
  constructor(irDir) {
    this.irDir = path.resolve(irDir);
  }

  // ── Manifest ─────────────────────────────────────────────────────────────────

  manifest() {
    return readJson(path.join(this.irDir, 'manifest.json'));
  }

  extractionReport() {
    return readJson(path.join(this.irDir, 'extraction-report.json'));
  }

  // ── Bundles ──────────────────────────────────────────────────────────────────

  proxies() {
    return findJsonFiles(path.join(this.irDir, 'proxies')).map(readJson).filter(Boolean);
  }

  sharedFlows() {
    return findJsonFiles(path.join(this.irDir, 'sharedflows')).map(readJson).filter(Boolean);
  }

  // ── KVMs ─────────────────────────────────────────────────────────────────────

  /** All KVMs regardless of scope */
  allKvms() {
    return findJsonFiles(path.join(this.irDir, 'kvms')).map(readJson).filter(Boolean);
  }

  orgKvms() {
    return findJsonFiles(path.join(this.irDir, 'kvms', 'org')).map(readJson).filter(Boolean);
  }

  envKvms() {
    return findJsonFiles(path.join(this.irDir, 'kvms', 'env')).map(readJson).filter(Boolean);
  }

  proxyKvms() {
    return findJsonFiles(path.join(this.irDir, 'kvms', 'proxy')).map(readJson).filter(Boolean);
  }

  // ── Target servers ────────────────────────────────────────────────────────────

  targetServers() {
    return findJsonFiles(path.join(this.irDir, 'targetservers')).map(readJson).filter(Boolean);
  }

  // ── Flow hooks ────────────────────────────────────────────────────────────────

  flowHooks() {
    return findJsonFiles(path.join(this.irDir, 'flowhooks')).map(readJson).filter(Boolean);
  }

  // ── Developers / Apps / Products ─────────────────────────────────────────────

  developers() {
    return findJsonFiles(path.join(this.irDir, 'developers')).map(readJson).filter(Boolean);
  }

  apps() {
    return findJsonFiles(path.join(this.irDir, 'apps')).map(readJson).filter(Boolean);
  }

  credentials() {
    return findJsonFiles(path.join(this.irDir, 'credentials')).map(readJson).filter(Boolean);
  }

  products() {
    return findJsonFiles(path.join(this.irDir, 'products')).map(readJson).filter(Boolean);
  }

  // ── Inventories / references ────────────────────────────────────────────────

  inventories() {
    return findJsonFiles(path.join(this.irDir, 'inventories'))
      .sort()
      .reduce((acc, filePath) => {
        acc[path.basename(filePath, '.json')] = readJson(filePath);
        return acc;
      }, {});
  }

  inventory(name) {
    return readJson(path.join(this.irDir, 'inventories', `${name}.json`));
  }

  references() {
    return findJsonFiles(path.join(this.irDir, 'references'))
      .sort()
      .reduce((acc, filePath) => {
        acc[path.basename(filePath, '.json')] = readJson(filePath);
        return acc;
      }, {});
  }

  reference(name) {
    return readJson(path.join(this.irDir, 'references', `${name}.json`));
  }

  // ── Protected credential material ───────────────────────────────────────────

  credentialSecretMeta(developerEmail, appName, consumerKey) {
    return readJson(path.join(
      this.irDir,
      '_protected',
      'credentials',
      developerEmail,
      appName,
      consumerKey,
      'secret-meta.json',
    ));
  }

  credentialSecret(developerEmail, appName, consumerKey) {
    return readText(path.join(
      this.irDir,
      '_protected',
      'credentials',
      developerEmail,
      appName,
      consumerKey,
      'consumer-secret.txt',
    ));
  }

  // ── Derived: group names from app attributes ──────────────────────────────────

  /**
   * Collect distinct group names referenced across all apps.
   * Apigee apps can carry group membership in attributes. The convention
   * used by apigee-migrate-tool is an attribute named 'group' or 'groups'.
   * @returns {Set<string>}
   */
  deriveGroupNames() {
    const groups = new Set();
    for (const app of this.apps()) {
      for (const attr of (app.attributes || [])) {
        if (attr.name === 'group' || attr.name === 'groups') {
          // Support comma-separated list
          for (const g of attr.value.split(',')) {
            const trimmed = g.trim();
            if (trimmed) groups.add(trimmed);
          }
        }
      }
    }
    return groups;
  }
}

module.exports = { IrLoader };
