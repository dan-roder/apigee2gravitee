'use strict';

/**
 * src/bootstrap/dictionaries.js
 *
 * Creates Gravitee Dictionaries from env-scoped and org-scoped Apigee KVMs
 * and populates their key-value entries.
 *
 * Mapping:
 *   KVM scope 'env'   → Manual Dictionary in the target environment
 *   KVM scope 'org'   → Manual Dictionary in the target environment
 *                        (Gravitee doesn't have a true org-level dictionary;
 *                         org KVMs are created in every target environment)
 *   KVM scope 'proxy' → NOT handled here; proxy KVMs become API Properties
 *                        and are handled by the API importer in Phase 3
 *
 * Encrypted KVM entries:
 *   Entries with value === null are skipped and recorded in the state for
 *   the gap report. A human must enter these manually via the Gravitee
 *   console after bootstrap.
 *
 * Gravitee Dictionary API (v1):
 *   POST   /management/organizations/{org}/environments/{env}/configuration/dictionaries
 *   PUT    /management/organizations/{org}/environments/{env}/configuration/dictionaries/{id}/properties
 *   POST   /management/organizations/{org}/environments/{env}/configuration/dictionaries/{id}/_deploy
 */

const { GraviteeApiError } = require('../shared/gravitee-client');

// Gravitee dictionary type for static manually-managed key-value pairs
const DICTIONARY_TYPE = 'MANUAL';

/**
 * Build the POST body for creating a Gravitee Dictionary.
 * @param {object} kvm  KvmIR object from the IR
 * @returns {object}
 */
function buildDictionaryPayload(kvm) {
  return {
    name:        kvm.name,
    description: `Migrated from Apigee KVM '${kvm.name}' (scope: ${kvm.scope})`,
    type:        DICTIONARY_TYPE,
  };
}

/**
 * Build the properties object for PUT .../properties.
 * Skips null-valued (encrypted) entries entirely.
 *
 * @param {object} kvm  KvmIR
 * @returns {{ properties: object, skippedEncrypted: string[] }}
 */
function buildPropertiesPayload(kvm) {
  const properties        = {};
  const skippedEncrypted  = [];

  for (const entry of (kvm.entries || [])) {
    if (entry.value === null || entry.value === undefined) {
      skippedEncrypted.push(entry.name);
    } else {
      properties[entry.name] = entry.value;
    }
  }

  return { properties, skippedEncrypted };
}

/**
 * Check whether a dictionary with the given name already exists.
 * Returns the dictionary object if found, null if not.
 *
 * @param {object} client  GraviteeClient
 * @returns {object|null}
 */
async function findExistingDictionary(client, name) {
  try {
    const list = await client.get(
      client.envUrl('/configuration/dictionaries')
    );
    const all = Array.isArray(list) ? list : (list.data || []);
    return all.find(d => d.name === name) || null;
  } catch (err) {
    // If the endpoint returns 404 (no dictionaries yet) treat as empty
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Bootstrap all dictionaries from env- and org-scoped KVMs.
 *
 * @param {object}         client   GraviteeClient
 * @param {object[]}       kvms     Array of KvmIR objects (any scope; proxy-scoped are skipped)
 * @param {BootstrapState} state    State store
 * @param {object}         logger   Logger with .info(), .warn(), .error()
 */
async function bootstrapDictionaries(client, kvms, state, logger) {
  const relevant = kvms.filter(k => k.scope === 'env' || k.scope === 'org');

  if (relevant.length === 0) {
    logger.info('No env/org-scoped KVMs found — skipping dictionary bootstrap');
    return;
  }

  logger.info(`Bootstrapping ${relevant.length} dictionar${relevant.length === 1 ? 'y' : 'ies'}...`);

  for (const kvm of relevant) {
    const stateKey = `${kvm.scope}:${kvm.name}`;

    // ── Idempotency check ──────────────────────────────────────────────────────
    if (state.dictionaryExists(stateKey)) {
      logger.info(`  [skip] Dictionary '${kvm.name}' already bootstrapped`);
      continue;
    }

    logger.info(`  [dict] ${kvm.name} (scope: ${kvm.scope}, entries: ${(kvm.entries || []).length})`);

    try {
      // ── Check if already exists in Gravitee ─────────────────────────────────
      let dict = null;
      if (!client.dryRun) {
        dict = await findExistingDictionary(client, kvm.name);
      }

      let graviteeId;

      if (dict) {
        graviteeId = dict.id;
        logger.info(`    → already exists in Gravitee (id: ${graviteeId}), updating properties`);
      } else {
        // ── Create dictionary ──────────────────────────────────────────────────
        const created = await client.post(
          client.envUrl('/configuration/dictionaries'),
          buildDictionaryPayload(kvm)
        );
        graviteeId = created?.id || `dry-run-${kvm.name}`;
        logger.info(`    → created (id: ${graviteeId})`);
      }

      // ── Populate properties ────────────────────────────────────────────────
      const { properties, skippedEncrypted } = buildPropertiesPayload(kvm);
      const entryCount = Object.keys(properties).length;

      if (entryCount > 0) {
        await client.put(
          client.envUrl(`/configuration/dictionaries/${graviteeId}/properties`),
          properties
        );
        logger.info(`    → populated ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`);
      }

      if (skippedEncrypted.length > 0) {
        logger.warn(`    → skipped ${skippedEncrypted.length} encrypted entr${skippedEncrypted.length === 1 ? 'y' : 'ies'}: [${skippedEncrypted.join(', ')}] — manual entry required`);
      }

      // ── Deploy dictionary to gateway ───────────────────────────────────────
      await client.post(
        client.envUrl(`/configuration/dictionaries/${graviteeId}/_deploy`),
        {}
      );
      logger.info(`    → deployed to gateway`);

      state.recordDictionary(stateKey, {
        graviteeId,
        name:             kvm.name,
        scope:            kvm.scope,
        environment:      kvm.environment || null,
        status:           client.dryRun ? 'dry-run' : (dict ? 'updated' : 'created'),
        entryCount,
        encryptedEntries: skippedEncrypted,
        error:            null,
      });

    } catch (err) {
      const msg = err instanceof GraviteeApiError
        ? `HTTP ${err.status}: ${JSON.stringify(err.body)}`
        : err.message;
      logger.error(`    ✗ Failed to bootstrap dictionary '${kvm.name}': ${msg}`);
      state.recordDictionary(stateKey, {
        graviteeId:       null,
        name:             kvm.name,
        scope:            kvm.scope,
        status:           'error',
        encryptedEntries: [],
        error:            msg,
      });
    }
  }
}

module.exports = { bootstrapDictionaries, buildDictionaryPayload, buildPropertiesPayload };
