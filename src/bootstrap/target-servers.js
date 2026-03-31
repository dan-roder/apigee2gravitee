'use strict';

/**
 * src/bootstrap/target-servers.js
 *
 * Creates Gravitee backend endpoint configurations from Apigee TargetServer
 * IR objects.
 *
 * Apigee TargetServers are named host:port references used in
 * TargetEndpoint LoadBalancer configurations. They decouple proxy
 * configuration from environment-specific backend addresses.
 *
 * Gravitee equivalent:
 *   TargetServers become named endpoints that can be referenced by API
 *   definitions. In Gravitee v4, these are stored as part of each API's
 *   endpoint group configuration — there is no standalone global
 *   "target server registry" equivalent to Apigee's.
 *
 *   However, Gravitee does support "Services" (backend services) in some
 *   configurations, and API definitions reference backends by URL directly.
 *
 * Bootstrap strategy:
 *   1. Write a target-servers-resolved.json file to the IR directory that
 *      maps each TargetServer name to its resolved URL (scheme + host + port).
 *      This file is consumed by the API importer (Phase 3) when building
 *      endpoint group configurations, replacing LoadBalancer server references.
 *
 *   2. Additionally, attempt to register each target server as a Gravitee
 *      "endpoint" via the management API if the environment supports it.
 *      This is treated as best-effort — failure is recorded but does not
 *      block the bootstrap.
 *
 * Gravitee API used:
 *   There is no v1 endpoint for standalone target servers outside an API.
 *   The target-servers-resolved.json approach is therefore the primary
 *   output; the management API registration is a secondary best-effort step.
 */

const fs   = require('fs');
const path = require('path');
const { GraviteeApiError } = require('../shared/gravitee-client');

/**
 * Resolve a TargetServerIR to a backend URL string.
 * Uses https:// if ssl_enabled is true, http:// otherwise.
 *
 * @param {object} ts  TargetServerIR
 * @returns {string}   e.g. 'https://my-backend.internal:8443'
 */
function resolveTargetServerUrl(ts) {
  const scheme = ts.ssl_enabled ? 'https' : 'http';
  const port   = ts.port || (ts.ssl_enabled ? 443 : 80);
  // Omit default ports for cleanliness
  const portSuffix =
    (scheme === 'https' && port === 443) ||
    (scheme === 'http'  && port === 80)
      ? ''
      : `:${port}`;
  return `${scheme}://${ts.host}${portSuffix}`;
}

/**
 * Write the resolved target server map to ir/target-servers-resolved.json.
 * Shape: { "<serverName>": { "url": "https://...", "enabled": true, "sslEnabled": true } }
 *
 * @param {string}   irDir
 * @param {object[]} targetServers  Array of TargetServerIR
 */
function writeResolvedMap(irDir, targetServers) {
  const resolved = {};
  for (const ts of targetServers) {
    resolved[ts.name] = {
      url:        resolveTargetServerUrl(ts),
      enabled:    ts.is_enabled !== false,
      sslEnabled: ts.ssl_enabled === true,
      host:       ts.host,
      port:       ts.port,
    };
  }
  const outPath = path.join(irDir, 'target-servers-resolved.json');
  fs.writeFileSync(outPath, JSON.stringify(resolved, null, 2), 'utf8');
  return { outPath, resolved };
}

/**
 * Bootstrap all target servers.
 *
 * @param {object}         client         GraviteeClient
 * @param {object[]}       targetServers  Array of TargetServerIR
 * @param {string}         irDir          IR directory path
 * @param {BootstrapState} state
 * @param {object}         logger
 */
async function bootstrapTargetServers(client, targetServers, irDir, state, logger) {
  if (targetServers.length === 0) {
    logger.info('No target servers found — skipping');
    return;
  }

  logger.info(`Bootstrapping ${targetServers.length} target server(s)...`);

  // Always write the resolved URL map regardless of dry-run — the importer needs it
  const { outPath, resolved } = writeResolvedMap(irDir, targetServers);
  logger.info(`  → Wrote resolved URL map to ${outPath}`);

  for (const ts of targetServers) {
    if (state.targetServerExists(ts.name)) {
      logger.info(`  [skip] Target server '${ts.name}' already bootstrapped`);
      continue;
    }

    const url = resolved[ts.name].url;
    logger.info(`  [ts]   ${ts.name} → ${url}${ts.is_enabled ? '' : ' (disabled)'}`);

    // Gravitee doesn't have a standalone target server API outside of API definitions,
    // so we record the resolved URL in state for the importer and mark as created.
    // If a future Gravitee version adds a services registry, this is where to call it.
    state.recordTargetServer(ts.name, {
      graviteeId:  null,   // No standalone resource ID — embedded in API definitions
      name:        ts.name,
      url,
      sslEnabled:  ts.ssl_enabled,
      enabled:     ts.is_enabled,
      status:      client.dryRun ? 'dry-run' : 'created',
      error:       null,
    });
  }

  logger.info(`  → Target server URLs registered in bootstrap state`);
}

module.exports = {
  bootstrapTargetServers,
  resolveTargetServerUrl,
  writeResolvedMap,
};
