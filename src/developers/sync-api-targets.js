'use strict';

const fs = require('fs');
const path = require('path');

const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { readJsonIfExists, resolveOutputPaths, writeJson } = require('./state-store');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTargets(entry) {
  return Array.isArray(entry) ? entry : [entry];
}

function denormalizeTargets(targets, originalEntry) {
  return Array.isArray(originalEntry) ? targets : targets[0];
}

function defaultOutputPath(configPath) {
  const absolutePath = path.resolve(configPath);
  if (absolutePath.endsWith('.resolved.json')) {
    return absolutePath;
  }
  if (absolutePath.endsWith('.json')) {
    return absolutePath.replace(/\.json$/, '.resolved.json');
  }
  return `${absolutePath}.resolved.json`;
}

function defaultApisIdMapPath(config) {
  const reportDir = path.resolve(config.reporting.reportDir);
  return path.resolve(path.join(path.dirname(reportDir), 'state', 'apis-id-map.json'));
}

function derivePlanKey(planName) {
  const normalized = String(planName || '')
    .trim()
    .toUpperCase()
    .replace(/\bPLAN\b/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || null;
}

function syncTargetIds(target, apisIdMap) {
  const updated = { ...target };
  const findings = [];
  const apiId = apisIdMap?.apis?.[target.targetApi] || null;
  if (!apiId) {
    findings.push(`No API id found in apis-id-map for targetApi ${target.targetApi}`);
  } else {
    updated.targetApiId = apiId;
  }

  const planBucket = apisIdMap?.plans?.[target.targetApi] || {};
  const planKey = derivePlanKey(target.targetPlan);
  if (planKey && planBucket[planKey]) {
    updated.targetPlanId = planBucket[planKey];
  } else {
    const availableKeys = Object.keys(planBucket);
    if (availableKeys.length === 1) {
      updated.targetPlanId = planBucket[availableKeys[0]];
      findings.push(`Plan name ${target.targetPlan} did not map cleanly; used sole available plan key ${availableKeys[0]}`);
    } else if (availableKeys.length === 0) {
      findings.push(`No plan ids found in apis-id-map for targetApi ${target.targetApi}`);
    } else {
      findings.push(`Plan name ${target.targetPlan} mapped to ${planKey || 'unknown'}, but available plan keys were ${availableKeys.join(', ')}`);
    }
  }

  return { updated, findings };
}

async function runSyncDevelopersApiTargets(flags, deps = {}) {
  const configPath = flags.config;
  if (!configPath) {
    return { exitCode: 1, error: '--config is required' };
  }

  const config = deps.config || loadDevelopersConfig(configPath, flags);
  const validation = validateDevelopersConfig(config);
  if (!validation.valid) {
    return { exitCode: 1, validationErrors: validation.errors };
  }

  const apisIdMapPath = path.resolve(flags['apis-id-map'] || defaultApisIdMapPath(config));
  const apisIdMap = deps.apisIdMap || readJsonIfExists(apisIdMapPath);
  if (!apisIdMap) {
    return { exitCode: 1, error: `apis id map not found: ${apisIdMapPath}` };
  }

  const syncedConfig = clone(config);
  delete syncedConfig._meta;

  const summary = {
    products: 0,
    targets: 0,
    apiIdsUpdated: 0,
    planIdsUpdated: 0,
    warnings: 0,
  };
  const findings = [];

  for (const [productName, entry] of Object.entries(syncedConfig.productPlanMap || {})) {
    summary.products += 1;
    const targets = normalizeTargets(entry);
    const syncedTargets = [];

    for (let index = 0; index < targets.length; index += 1) {
      summary.targets += 1;
      const original = targets[index];
      const { updated, findings: targetFindings } = syncTargetIds(original, apisIdMap);
      if (updated.targetApiId && updated.targetApiId !== original.targetApiId) summary.apiIdsUpdated += 1;
      if (updated.targetPlanId && updated.targetPlanId !== original.targetPlanId) summary.planIdsUpdated += 1;
      if (targetFindings.length > 0) {
        summary.warnings += 1;
        findings.push({
          severity: 'warning',
          productName,
          targetIndex: index,
          targetApi: original.targetApi,
          targetPlan: original.targetPlan,
          issues: targetFindings,
        });
      }
      syncedTargets.push(updated);
    }

    syncedConfig.productPlanMap[productName] = denormalizeTargets(syncedTargets, entry);
  }

  const outputPath = flags['in-place']
    ? path.resolve(configPath)
    : path.resolve(flags['output-config'] || defaultOutputPath(configPath));
  const outputPaths = resolveOutputPaths(config);
  const reportPath = path.resolve(flags['output-report'] || outputPaths.syncReport);

  syncedConfig._meta = {
    ...(config._meta || {}),
    syncApiTargets: {
      syncedAt: new Date().toISOString(),
      sourceConfigPath: path.resolve(configPath),
      apisIdMapPath,
      outputPath,
      summary,
      warnings: findings.length,
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(syncedConfig, null, 2)}\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    configPath: path.resolve(configPath),
    apisIdMapPath,
    outputPath,
    summary,
    findings,
    nextSteps: findings.length > 0
      ? [
        'Review unresolved API/plan target mappings in the sync report.',
        'Fix ambiguous target names or missing API/plan imports, then rerun developers sync-api-targets.',
        'Run developers validate-config-targets against the synced config before analyze/import.',
      ]
      : [
        'Run developers validate-config-targets against the synced config.',
        'Then run developers analyze to refresh the manifest and preflight output.',
      ],
  };
  writeJson(reportPath, report);

  return {
    exitCode: findings.length > 0 ? 2 : 0,
    outputPath,
    reportPath,
    apisIdMapPath,
    summary,
    findings,
    report,
    config: syncedConfig,
  };
}

module.exports = {
  runSyncDevelopersApiTargets,
  derivePlanKey,
};
