'use strict';

const fs = require('fs');
const path = require('path');

const { GraviteeClient } = require('./shared/gravitee-client');

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function classifyFailure(result) {
  const status = result?.status || null;
  const error = String(result?.error || '');
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'not-found';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/i.test(error)) {
    return 'network';
  }
  return 'api-error';
}

async function runTestConnectionCommand(flags = {}, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const configPath = path.resolve(cwd, flags.config || './config/apis.config.json');
  const config = deps.config || readConfig(configPath);
  const gravitee = {
    url: String(flags['gravitee-url'] || config.gravitee?.url || '').trim().replace(/\/+$/, ''),
    orgId: String(flags.org || config.gravitee?.orgId || 'DEFAULT').trim(),
    envId: String(flags.env || config.gravitee?.envId || 'DEFAULT').trim(),
  };
  const flagToken = typeof flags['gravitee-token'] === 'string' ? flags['gravitee-token'].trim() : '';
  const token = flagToken || process.env.GRAVITEE_TOKEN;

  if (!gravitee.url) throw new Error('Gravitee URL is missing from config and --gravitee-url was not provided');
  if (!token && !deps.client) {
    throw new Error('Gravitee token is required; pass --gravitee-token or set GRAVITEE_TOKEN');
  }

  const client = deps.client || new GraviteeClient({
    baseUrl: gravitee.url,
    orgId: gravitee.orgId,
    envId: gravitee.envId,
    token,
    timeout: Number(flags['timeout-ms'] || 10000),
    maxRetries: 0,
  });

  const organization = await client.healthCheck();
  const environment = organization.ok
    ? await client.verifyEnvironmentAccess()
    : { ok: false, skipped: true, error: 'Organization check did not succeed' };
  const ok = organization.ok && environment.ok;

  return {
    exitCode: ok ? 0 : 2,
    configPath,
    gravitee,
    checks: {
      organization: {
        ...organization,
        classification: organization.ok ? null : classifyFailure(organization),
      },
      environment: {
        ...environment,
        classification: environment.ok || environment.skipped ? null : classifyFailure(environment),
      },
    },
  };
}

module.exports = {
  runTestConnectionCommand,
  classifyFailure,
};
