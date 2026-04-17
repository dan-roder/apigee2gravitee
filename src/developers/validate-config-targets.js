'use strict';

const fs = require('fs');
const path = require('path');

const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { loadDeveloperDomain } = require('./developer-loader');
const { GraviteeClient } = require('../shared/gravitee-client');
const { writeJson, resolveOutputPaths } = require('./state-store');
const {
  summarizeProductCredentialType,
  resolveApiCandidates,
  resolvePlanCandidates,
  evaluatePlanSuitability,
  isPlanStatusSuitable,
  classifyPlanSecurity,
} = require('./target-matching');

function normalizeTargets(entry) {
  return Array.isArray(entry) ? entry : [entry];
}

function isPlaceholder(value) {
  return !value || String(value).startsWith('REPLACE_WITH_');
}

function makeFinding(severity, code, productName, targetIndex, message, details = {}) {
  return {
    severity,
    code,
    productName,
    targetIndex,
    message,
    details,
  };
}

function defaultApisIdMapPath(config) {
  const reportDir = path.resolve(config.reporting.reportDir);
  return path.resolve(path.join(path.dirname(reportDir), 'state', 'apis-id-map.json'));
}

function isProductActive(domain, productName) {
  if (!domain) return true;
  return Array.isArray(domain.subscriptions)
    ? domain.subscriptions.some((subscription) => subscription.productName === productName)
    : true;
}

async function resolveApiTarget(target, client, productName, targetIndex) {
  const liveApis = await client.listApis();
  const candidates = resolveApiCandidates(target, liveApis);

  if (!isPlaceholder(target.targetApiId)) {
    if (candidates.length === 0) {
      return {
        api: null,
        findings: [
          makeFinding('blocker', 'TARGET_API_ID_NOT_FOUND', productName, targetIndex, `Configured targetApiId ${target.targetApiId} could not be loaded`, {
            targetApiId: target.targetApiId,
          }),
        ],
        candidates,
      };
    }
    return { api: candidates[0].api, findings: [], candidates };
  }

  if (candidates.length === 0) {
    return {
      api: null,
      findings: [
        makeFinding('blocker', 'TARGET_API_NAME_NOT_FOUND', productName, targetIndex, `No Gravitee API found for ${target.targetApi}`, {
          targetApi: target.targetApi,
          targetApiAliases: target.targetApiAliases || [],
          matchMode: target.matchMode || 'exact',
        }),
      ],
      candidates,
    };
  }

  if (candidates.length > 1) {
    return {
      api: null,
      findings: [
        makeFinding('blocker', 'TARGET_API_NAME_AMBIGUOUS', productName, targetIndex, `API lookup for ${target.targetApi} was ambiguous`, {
          targetApi: target.targetApi,
          matches: candidates.map((candidate) => ({ apiId: candidate.api.id, apiName: candidate.api.name, matchMode: candidate.matchMode })),
        }),
      ],
      candidates,
    };
  }

  return { api: candidates[0].api, findings: [], candidates };
}

async function resolvePlanTarget(target, api, client, productName, targetIndex, credentialProfile) {
  const plans = await client.listApiPlans(api.id);
  const candidates = resolvePlanCandidates(target, plans);
  const findings = [];

  if (!isPlaceholder(target.targetPlanId)) {
    if (candidates.length === 0) {
      return {
        plan: null,
        findings: [
          makeFinding('blocker', 'TARGET_PLAN_ID_NOT_FOUND', productName, targetIndex, `Configured targetPlanId ${target.targetPlanId} was not found under API ${api.id}`, {
            targetPlanId: target.targetPlanId,
            apiId: api.id,
          }),
        ],
        candidates,
      };
    }

    const plan = candidates[0].plan;
    if (target.targetPlan && plan.name !== target.targetPlan) {
      findings.push(makeFinding('blocker', 'TARGET_PLAN_NAME_MISMATCH', productName, targetIndex, `Configured targetPlan ${target.targetPlan} does not match plan id ${target.targetPlanId} name ${plan.name}`, {
        targetPlan: target.targetPlan,
        targetPlanId: target.targetPlanId,
        actualPlanName: plan.name,
        apiId: api.id,
      }));
    }
    return { plan, findings, candidates };
  }

  if (candidates.length === 0) {
    return {
      plan: null,
      findings: [
        makeFinding('blocker', 'TARGET_PLAN_NAME_NOT_FOUND', productName, targetIndex, `No Gravitee plan found for ${target.targetPlan} under API ${api.id}`, {
          targetPlan: target.targetPlan,
          targetPlanAliases: target.targetPlanAliases || [],
          matchMode: target.matchMode || 'exact',
          apiId: api.id,
        }),
      ],
      candidates,
    };
  }

  if (candidates.length > 1) {
    return {
      plan: null,
      findings: [
        makeFinding('blocker', 'TARGET_PLAN_NAME_AMBIGUOUS', productName, targetIndex, `Plan lookup for ${target.targetPlan} under API ${api.id} was ambiguous`, {
          targetPlan: target.targetPlan,
          apiId: api.id,
          matches: candidates.map((candidate) => ({ planId: candidate.plan.id, planName: candidate.plan.name, matchMode: candidate.matchMode })),
        }),
      ],
      candidates,
    };
  }

  const plan = candidates[0].plan;
  if (!isPlanStatusSuitable(plan)) {
    findings.push(makeFinding('blocker', 'TARGET_PLAN_STATUS_UNSUITABLE', productName, targetIndex, `Plan ${plan.name} is not in a usable status for subscriptions`, {
      planId: plan.id,
      planName: plan.name,
      status: plan.status || plan.state || null,
      apiId: api.id,
    }));
  }

  const suitability = evaluatePlanSuitability(plan, credentialProfile);
  if (!suitability.suitable) {
    findings.push(makeFinding('warning', 'TARGET_PLAN_SECURITY_MISMATCH', productName, targetIndex, `Plan ${plan.name} security ${classifyPlanSecurity(plan)} is not suitable for ${credentialProfile.primaryCredentialType} credentials`, {
      planId: plan.id,
      planName: plan.name,
      planSecurityType: classifyPlanSecurity(plan),
      credentialType: credentialProfile.primaryCredentialType,
      sourceCredentials: credentialProfile.sourceCredentials,
      apiId: api.id,
    }));
  }

  return { plan, findings, candidates };
}

async function runValidateDevelopersConfigTargets(flags, deps = {}) {
  const configPath = flags.config;
  if (!configPath) {
    return { exitCode: 1, error: '--config is required' };
  }

  const config = deps.config || loadDevelopersConfig(configPath, flags);
  const validation = validateDevelopersConfig(config);
  if (!validation.valid) {
    return { exitCode: 1, validationErrors: validation.errors };
  }

  const irDir = flags['ir-dir'] ? path.resolve(flags['ir-dir']) : null;
  const domain = deps.domain || (irDir && fs.existsSync(irDir) ? loadDeveloperDomain(irDir, config) : null);
  const client = deps.client || new GraviteeClient({
    baseUrl: config.gravitee.url,
    orgId: config.gravitee.orgId,
    envId: config.gravitee.envId,
    token: flags['gravitee-token'] || process.env.GRAVITEE_TOKEN,
    dryRun: false,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    configPath: path.resolve(configPath),
    apisIdMapPresent: fs.existsSync(defaultApisIdMapPath(config)),
    summary: {
      products: 0,
      targets: 0,
      validTargets: 0,
      blockers: 0,
      warnings: 0,
      productsWithSingleValidTarget: [],
      productsNeedingSelection: [],
      blockedProducts: [],
    },
    targets: [],
    findings: [],
  };

  for (const [productName, entry] of Object.entries(config.productPlanMap || {})) {
    report.summary.products += 1;
    const activeProduct = isProductActive(domain, productName);
    const credentialProfile = domain ? summarizeProductCredentialType(domain, productName) : {
      productName,
      credentialTypes: [],
      primaryCredentialType: 'api-key',
      hasMixedCredentialTypes: false,
      sourceCredentials: [],
    };
    const targets = normalizeTargets(entry);
    let validTargetCount = 0;

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      report.summary.targets += 1;

      const apiResolution = await resolveApiTarget(target, client, productName, index);
      let findings = [...apiResolution.findings];
      let resolvedPlan = null;
      let planCandidates = [];

      if (apiResolution.api) {
        const planResolution = await resolvePlanTarget(target, apiResolution.api, client, productName, index, credentialProfile);
        findings = findings.concat(planResolution.findings);
        resolvedPlan = planResolution.plan;
        planCandidates = planResolution.candidates;
      }

      const effectiveFindings = activeProduct
        ? findings
        : findings.map((item) => (
          item.severity === 'blocker'
            ? {
              ...item,
              severity: 'warning',
              code: `${item.code}_INACTIVE_PRODUCT`,
              message: `${item.message} (product is not used by the current developer dataset)`,
            }
            : item
        ));
      const status = effectiveFindings.some((item) => item.severity === 'blocker')
        ? 'BLOCKED'
        : effectiveFindings.some((item) => item.severity === 'warning')
          ? 'VALID_WITH_WARNINGS'
          : 'VALID';

      if (!effectiveFindings.some((item) => item.severity === 'blocker')) validTargetCount += 1;

      report.findings.push(...effectiveFindings);
      report.targets.push({
        productName,
        targetIndex: index,
        activeProduct,
        configured: target,
        credentialProfile,
        resolved: {
          apiId: apiResolution.api?.id || null,
          apiName: apiResolution.api?.name || target.targetApi || null,
          planId: resolvedPlan?.id || null,
          planName: resolvedPlan?.name || target.targetPlan || null,
          planSecurityType: resolvedPlan ? classifyPlanSecurity(resolvedPlan) : null,
          planStatus: resolvedPlan?.status || resolvedPlan?.state || null,
        },
        candidates: {
          apis: apiResolution.candidates.map((candidate) => ({ id: candidate.api.id, name: candidate.api.name, matchMode: candidate.matchMode })),
          plans: planCandidates.map((candidate) => ({ id: candidate.plan.id, name: candidate.plan.name, matchMode: candidate.matchMode })),
        },
        status,
        findings: effectiveFindings,
      });
    }

    if (validTargetCount === 1) {
      report.summary.productsWithSingleValidTarget.push(productName);
    } else if (validTargetCount > 1) {
      report.summary.productsNeedingSelection.push(productName);
    } else {
      report.summary.blockedProducts.push(productName);
    }
  }

  report.summary.validTargets = report.targets.filter((item) => item.status !== 'BLOCKED').length;
  report.summary.blockers = report.findings.filter((item) => item.severity === 'blocker').length;
  report.summary.warnings = report.findings.filter((item) => item.severity === 'warning').length;

  const outputPath = path.resolve(
    flags['output-report'] || path.join(config.reporting.reportDir, 'developers-config-targets-report.json'),
  );
  writeJson(outputPath, report);

  return {
    exitCode: report.summary.blockers > 0 ? 2 : 0,
    report,
    outputPath,
  };
}

module.exports = {
  runValidateDevelopersConfigTargets,
};
