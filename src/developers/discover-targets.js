'use strict';

const fs = require('fs');
const path = require('path');

const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { loadDeveloperDomain } = require('./developer-loader');
const { resolveOutputPaths, writeJson } = require('./state-store');
const { GraviteeClient } = require('../shared/gravitee-client');
const {
  normalizeName,
  classifyPlanSecurity,
  summarizeProductCredentialType,
  evaluatePlanSuitability,
  isPlanStatusSuitable,
} = require('./target-matching');

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
  if (absolutePath.endsWith('.resolved.json')) return absolutePath;
  if (absolutePath.endsWith('.json')) return absolutePath.replace(/\.json$/, '.resolved.json');
  return `${absolutePath}.resolved.json`;
}

function summarizeProductProxies(domain, productName) {
  const product = (domain.products || []).find((item) => item.name === productName);
  return Array.isArray(product?.proxies) ? product.proxies : [];
}

function scoreApiCandidate(api, sourceProxyNames) {
  const apiName = String(api?.name || '');
  for (const sourceProxyName of sourceProxyNames) {
    if (apiName === sourceProxyName) return 100;
    if (normalizeName(apiName) === normalizeName(sourceProxyName)) return 80;
  }
  return 0;
}

function scorePlanCandidate(plan, credentialProfile, apiScore) {
  const suitability = evaluatePlanSuitability(plan, credentialProfile);
  if (!suitability.suitable) return { score: apiScore - 100, suitability };
  const security = classifyPlanSecurity(plan);
  let score = apiScore;
  if (security === credentialProfile.primaryCredentialType) score += 20;
  if (isPlanStatusSuitable(plan)) score += 5;
  return { score, suitability };
}

async function runDiscoverDevelopersTargets(flags, deps = {}) {
  const configPath = flags.config;
  if (!configPath) return { exitCode: 1, error: '--config is required' };
  const irDir = path.resolve(flags['ir-dir'] || './ir');

  const config = deps.config || loadDevelopersConfig(configPath, flags);
  const validation = validateDevelopersConfig(config, { allowEmpty: true });
  if (!validation.valid) return { exitCode: 1, validationErrors: validation.errors };

  const domain = deps.domain || loadDeveloperDomain(irDir, config);
  const client = deps.client || new GraviteeClient({
    baseUrl: config.gravitee.url,
    orgId: config.gravitee.orgId,
    envId: config.gravitee.envId,
    token: flags['gravitee-token'] || process.env.GRAVITEE_TOKEN,
    dryRun: false,
  });
  const outputPaths = resolveOutputPaths(config);

  const liveApis = deps.liveApis || await client.listApis();
  const plansByApiId = new Map();
  for (const api of liveApis) {
    plansByApiId.set(api.id, deps.plansByApiId?.get(api.id) || await client.listApiPlans(api.id).catch(() => []));
  }

  const uniqueProducts = Array.from(new Set(domain.subscriptions.map((subscription) => subscription.productName))).sort();
  const entries = [];
  const findings = [];
  const proposedConfig = clone(config);
  proposedConfig.productPlanMap = proposedConfig.productPlanMap || {};

  for (const productName of uniqueProducts) {
    const credentialProfile = summarizeProductCredentialType(domain, productName);
    const sourceProxyNames = summarizeProductProxies(domain, productName);
    const candidates = [];

    for (const api of liveApis) {
      const apiScore = scoreApiCandidate(api, sourceProxyNames);
      if (apiScore <= 0) continue;

      const apiPlans = plansByApiId.get(api.id) || [];
      for (const plan of apiPlans) {
        const scored = scorePlanCandidate(plan, credentialProfile, apiScore);
        candidates.push({
          targetApi: api.name,
          targetApiId: api.id,
          targetPlan: plan.name,
          targetPlanId: plan.id,
          matchMode: 'exact',
          score: scored.score,
          securityType: classifyPlanSecurity(plan),
          planStatus: plan.status || plan.state || null,
          suitable: scored.suitability.suitable && isPlanStatusSuitable(plan),
          suitabilityCode: !isPlanStatusSuitable(plan)
            ? 'TARGET_PLAN_STATUS_UNSUITABLE'
            : scored.suitability.advisoryCode,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.targetApi.localeCompare(b.targetApi) || a.targetPlan.localeCompare(b.targetPlan));
    const suitableCandidates = candidates.filter((candidate) => candidate.suitable);
    const topScore = suitableCandidates[0]?.score ?? null;
    const exactCandidates = topScore === null
      ? []
      : suitableCandidates.filter((candidate) => candidate.score === topScore);

    const status = exactCandidates.length === 1
      ? 'EXACT_MATCH'
      : exactCandidates.length > 1
        ? 'AMBIGUOUS'
        : 'BLOCKED';

    if (status === 'AMBIGUOUS') {
      findings.push({
        severity: 'warning',
        code: 'DISCOVER_TARGET_AMBIGUOUS',
        productName,
        message: `Multiple suitable API/plan candidates were found for ${productName}`,
        details: { candidates: exactCandidates.map((candidate) => `${candidate.targetApi} / ${candidate.targetPlan}`) },
      });
    }
    if (status === 'BLOCKED') {
      findings.push({
        severity: 'blocker',
        code: 'DISCOVER_TARGET_NO_SUITABLE_PLAN',
        productName,
        message: `No suitable API/plan candidate was found for ${productName}`,
        details: {
          credentialType: credentialProfile.primaryCredentialType,
          sourceProxyNames,
        },
      });
    }

    if (flags['write-config'] && exactCandidates.length === 1) {
      const resolved = {
        targetApi: exactCandidates[0].targetApi,
        targetApiId: exactCandidates[0].targetApiId,
        targetPlan: exactCandidates[0].targetPlan,
        targetPlanId: exactCandidates[0].targetPlanId,
        matchMode: 'exact',
      };
      proposedConfig.productPlanMap[productName] = denormalizeTargets(
        [resolved],
        proposedConfig.productPlanMap[productName] || resolved,
      );
    }

    entries.push({
      productName,
      sourceProxyNames,
      credentialProfile,
      status,
      exactCandidates,
      candidates,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    configPath: path.resolve(configPath),
    summary: {
      products: entries.length,
      productsWithSingleValidTarget: entries.filter((entry) => entry.status === 'EXACT_MATCH').map((entry) => entry.productName),
      productsNeedingSelection: entries.filter((entry) => entry.status === 'AMBIGUOUS').map((entry) => entry.productName),
      blockedProducts: entries.filter((entry) => entry.status === 'BLOCKED').map((entry) => entry.productName),
      blockers: findings.filter((item) => item.severity === 'blocker').length,
      warnings: findings.filter((item) => item.severity === 'warning').length,
    },
    entries,
    findings,
  };

  const reportPath = path.resolve(flags['output-report'] || outputPaths.targetCatalog);
  writeJson(reportPath, report);

  let outputPath = null;
  if (flags['write-config']) {
    outputPath = path.resolve(flags['output-config'] || defaultOutputPath(configPath));
    fs.writeFileSync(outputPath, `${JSON.stringify(proposedConfig, null, 2)}\n`);
  }

  return {
    exitCode: report.summary.blockers > 0 ? 2 : 0,
    report,
    reportPath,
    outputPath,
    config: proposedConfig,
  };
}

module.exports = { runDiscoverDevelopersTargets };
