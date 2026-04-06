'use strict';

const fs = require('fs');
const path = require('path');

const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { GraviteeClient } = require('../shared/gravitee-client');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTargets(entry) {
  return Array.isArray(entry) ? entry : [entry];
}

function denormalizeTargets(targets, originalEntry) {
  return Array.isArray(originalEntry) ? targets : targets[0];
}

function isPlaceholder(value) {
  return !value || String(value).startsWith('REPLACE_WITH_');
}

function defaultOutputPath(configPath) {
  const absolutePath = path.resolve(configPath);
  if (absolutePath.endsWith('.json')) {
    return absolutePath.replace(/\.json$/, '.resolved.json');
  }
  return `${absolutePath}.resolved.json`;
}

async function resolveTargetIds(target, client) {
  const resolved = { ...target };
  const issues = [];

  let api = null;
  if (!isPlaceholder(target.targetApiId)) {
    try {
      api = await client.getApi(target.targetApiId);
    } catch (err) {
      issues.push(`API id lookup failed for ${target.targetApiId}: ${err.message}`);
    }
  } else {
    try {
      api = await client.findApiByName(target.targetApi);
      if (!api) {
        issues.push(`No Gravitee API found with name ${target.targetApi}`);
      } else {
        resolved.targetApiId = api.id;
      }
    } catch (err) {
      issues.push(`API lookup failed for ${target.targetApi}: ${err.message}`);
    }
  }

  if (!api && !isPlaceholder(resolved.targetApiId)) {
    api = { id: resolved.targetApiId };
  }

  if (api?.id && isPlaceholder(target.targetPlanId)) {
    try {
      const plan = await client.findPlan({
        targetApi: target.targetApi,
        targetApiId: api.id,
        targetPlan: target.targetPlan,
      });
      if (!plan) {
        issues.push(`No Gravitee plan found for API ${target.targetApi} and plan ${target.targetPlan}`);
      } else {
        resolved.targetPlanId = plan.id;
      }
    } catch (err) {
      issues.push(`Plan lookup failed for ${target.targetPlan}: ${err.message}`);
    }
  }

  return { resolved, issues };
}

async function runResolveDevelopersConfigIds(flags, deps = {}) {
  const configPath = flags.config;
  if (!configPath) {
    return { exitCode: 1, error: '--config is required' };
  }

  const config = deps.config || loadDevelopersConfig(configPath, flags);
  const validation = validateDevelopersConfig(config);
  if (!validation.valid) {
    return {
      exitCode: 1,
      validationErrors: validation.errors,
    };
  }

  const client = deps.client || new GraviteeClient({
    baseUrl: config.gravitee.url,
    orgId: config.gravitee.orgId,
    envId: config.gravitee.envId,
    token: flags['gravitee-token'] || process.env.GRAVITEE_TOKEN,
    dryRun: false,
  });

  const resolvedConfig = clone(config);
  delete resolvedConfig._meta;

  const summary = {
    products: 0,
    targets: 0,
    apiIdsResolved: 0,
    planIdsResolved: 0,
    unresolved: 0,
  };
  const findings = [];

  for (const [productName, entry] of Object.entries(resolvedConfig.productPlanMap || {})) {
    summary.products += 1;
    const targets = normalizeTargets(entry);
    const resolvedTargets = [];

    for (let index = 0; index < targets.length; index += 1) {
      summary.targets += 1;
      const original = targets[index];
      const hadApiId = !isPlaceholder(original.targetApiId);
      const hadPlanId = !isPlaceholder(original.targetPlanId);
      const { resolved, issues } = await resolveTargetIds(original, client);

      if (!hadApiId && !isPlaceholder(resolved.targetApiId)) summary.apiIdsResolved += 1;
      if (!hadPlanId && !isPlaceholder(resolved.targetPlanId)) summary.planIdsResolved += 1;
      if (issues.length > 0) {
        summary.unresolved += 1;
        findings.push({
          severity: 'warning',
          productName,
          targetIndex: index,
          targetApi: original.targetApi,
          targetPlan: original.targetPlan,
          issues,
        });
      }

      resolvedTargets.push(resolved);
    }

    resolvedConfig.productPlanMap[productName] = denormalizeTargets(resolvedTargets, entry);
  }

  const outputPath = flags['in-place']
    ? path.resolve(configPath)
    : path.resolve(flags['output-config'] || defaultOutputPath(configPath));
  fs.writeFileSync(outputPath, `${JSON.stringify(resolvedConfig, null, 2)}\n`);

  return {
    exitCode: findings.length > 0 ? 2 : 0,
    outputPath,
    summary,
    findings,
    config: resolvedConfig,
  };
}

module.exports = {
  runResolveDevelopersConfigIds,
};
