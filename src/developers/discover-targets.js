'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

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

async function withPrompt(flags, handler) {
  if (typeof flags.__prompt === 'function') {
    return handler(flags.__prompt);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await handler((question) => rl.question(question));
  } finally {
    rl.close();
  }
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

function buildCandidateTarget(candidate) {
  return {
    targetApi: candidate.targetApi,
    targetApiId: candidate.targetApiId,
    targetPlan: candidate.targetPlan,
    targetPlanId: candidate.targetPlanId,
    matchMode: 'exact',
  };
}

function buildManualApiChoices(liveApis, sourceProxyNames) {
  const scored = liveApis.map((api) => ({
    api,
    score: scoreApiCandidate(api, sourceProxyNames),
  }));
  scored.sort((a, b) => b.score - a.score || String(a.api?.name || '').localeCompare(String(b.api?.name || '')));
  return scored.map((entry, index) => ({
    index: index + 1,
    api: entry.api,
    score: entry.score,
  }));
}

function buildManualPlanChoices(plans, credentialProfile) {
  return plans
    .map((plan, index) => {
      const suitability = evaluatePlanSuitability(plan, credentialProfile);
      return {
        index: index + 1,
        plan,
        suitability,
        securityType: classifyPlanSecurity(plan),
        suitable: suitability.suitable && isPlanStatusSuitable(plan),
      };
    })
    .sort((a, b) => Number(b.suitable) - Number(a.suitable) || String(a.plan?.name || '').localeCompare(String(b.plan?.name || '')));
}

function findChoiceByAnswer(choices, answer, valueGetter) {
  const normalized = String(answer || '').trim();
  if (!normalized) return null;
  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= choices.length) {
    return choices[asNumber - 1];
  }
  const lowered = normalized.toLowerCase();
  return choices.find((choice) => String(valueGetter(choice) || '').toLowerCase() === lowered) || null;
}

async function promptToSelectTarget(productName, sourceProxyNames, credentialProfile, liveApis, plansByApiId, promptImpl) {
  const apiChoices = buildManualApiChoices(liveApis, sourceProxyNames);
  if (apiChoices.length === 0) return null;

  const apiLines = [
    `${productName} source proxies: ${sourceProxyNames.join(', ') || '(none)'}`,
    `${productName} credential type: ${credentialProfile.primaryCredentialType}`,
    'Select the target API:',
    ...apiChoices.map((choice) => `  ${choice.index}. ${choice.api.name} (${choice.api.id})${choice.score > 0 ? ` [score ${choice.score}]` : ''}`),
    '  s. Skip this product for now',
  ];
  const apiAnswer = await promptImpl(`${apiLines.join('\n')}\nChoose API by number or exact name: `);
  if (String(apiAnswer || '').trim().toLowerCase() === 's') return null;
  const selectedApiChoice = findChoiceByAnswer(apiChoices, apiAnswer, (choice) => choice.api.name);
  if (!selectedApiChoice) {
    throw new Error(`Invalid API selection for ${productName}: ${apiAnswer}`);
  }

  const plans = plansByApiId.get(selectedApiChoice.api.id) || [];
  const planChoices = buildManualPlanChoices(plans, credentialProfile);
  if (planChoices.length === 0) {
    throw new Error(`API ${selectedApiChoice.api.name} has no plans to choose from for ${productName}`);
  }

  const planLines = [
    `Plans for ${selectedApiChoice.api.name}:`,
    ...planChoices.map((choice) => {
      const status = choice.plan.status || choice.plan.state || 'UNKNOWN';
      const suitability = choice.suitable ? '[suitable]' : `[${choice.suitability.advisoryCode || 'unsuitable'}]`;
      return `  ${choice.index}. ${choice.plan.name} (${choice.plan.id}) [${choice.securityType}] [${status}] ${suitability}`;
    }),
    '  s. Skip this product for now',
  ];
  const planAnswer = await promptImpl(`${planLines.join('\n')}\nChoose plan by number or exact name: `);
  if (String(planAnswer || '').trim().toLowerCase() === 's') return null;
  const selectedPlanChoice = findChoiceByAnswer(planChoices, planAnswer, (choice) => choice.plan.name);
  if (!selectedPlanChoice) {
    throw new Error(`Invalid plan selection for ${productName}: ${planAnswer}`);
  }

  return {
    targetApi: selectedApiChoice.api.name,
    targetApiId: selectedApiChoice.api.id,
    targetPlan: selectedPlanChoice.plan.name,
    targetPlanId: selectedPlanChoice.plan.id,
    matchMode: 'exact',
  };
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
  const promptedSelections = [];

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
      const resolved = buildCandidateTarget(exactCandidates[0]);
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

  const shouldPrompt = Boolean(flags['prompt-matches'] || flags['interactive']);
  if (shouldPrompt) {
    await withPrompt(flags, async (promptImpl) => {
      for (const entry of entries) {
        if (entry.status === 'EXACT_MATCH') continue;
        const selected = await promptToSelectTarget(
          entry.productName,
          entry.sourceProxyNames,
          entry.credentialProfile,
          liveApis,
          plansByApiId,
          promptImpl,
        );
        if (!selected) continue;
        proposedConfig.productPlanMap[entry.productName] = denormalizeTargets(
          [selected],
          proposedConfig.productPlanMap[entry.productName] || selected,
        );
        promptedSelections.push({
          productName: entry.productName,
          selected,
        });
      }
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
    promptedSelections,
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
