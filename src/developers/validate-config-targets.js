'use strict';

const path = require('path');

const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { GraviteeClient } = require('../shared/gravitee-client');
const { writeJson } = require('./state-store');

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

async function resolveApiTarget(target, client) {
  if (!isPlaceholder(target.targetApiId)) {
    try {
      const api = await client.getApi(target.targetApiId);
      return { api, findings: [] };
    } catch (err) {
      return {
        api: null,
        findings: [
          makeFinding(
            'blocker',
            'TARGET_API_ID_NOT_FOUND',
            null,
            null,
            `Configured targetApiId ${target.targetApiId} could not be loaded`,
            { targetApiId: target.targetApiId, error: err.message },
          ),
        ],
      };
    }
  }

  try {
    const api = await client.findApiByName(target.targetApi);
    if (!api) {
      return {
        api: null,
        findings: [
          makeFinding(
            'blocker',
            'TARGET_API_NAME_NOT_FOUND',
            null,
            null,
            `No Gravitee API found with name ${target.targetApi}`,
            { targetApi: target.targetApi },
          ),
        ],
      };
    }
    return { api, findings: [] };
  } catch (err) {
    return {
      api: null,
      findings: [
        makeFinding(
          'blocker',
          'TARGET_API_NAME_AMBIGUOUS',
          null,
          null,
          `API lookup for ${target.targetApi} was ambiguous`,
          { targetApi: target.targetApi, error: err.message },
        ),
      ],
    };
  }
}

async function resolvePlanTarget(target, api, client) {
  try {
    const plans = await client.listApiPlans(api.id);
    const exactId = !isPlaceholder(target.targetPlanId)
      ? plans.filter((item) => item.id === target.targetPlanId)
      : [];
    const exactName = plans.filter((item) => item.name === target.targetPlan);

    if (!isPlaceholder(target.targetPlanId)) {
      if (exactId.length === 0) {
        return {
          plan: null,
          findings: [
            makeFinding(
              'blocker',
              'TARGET_PLAN_ID_NOT_FOUND',
              null,
              null,
              `Configured targetPlanId ${target.targetPlanId} was not found under API ${api.id}`,
              { targetPlanId: target.targetPlanId, apiId: api.id },
            ),
          ],
        };
      }
      const plan = exactId[0];
      if (target.targetPlan && plan.name !== target.targetPlan) {
        return {
          plan,
          findings: [
            makeFinding(
              'blocker',
              'TARGET_PLAN_NAME_MISMATCH',
              null,
              null,
              `Configured targetPlan ${target.targetPlan} does not match plan id ${target.targetPlanId} name ${plan.name}`,
              { targetPlan: target.targetPlan, targetPlanId: target.targetPlanId, actualPlanName: plan.name, apiId: api.id },
            ),
          ],
        };
      }
      return { plan, findings: [] };
    }

    if (exactName.length === 0) {
      return {
        plan: null,
        findings: [
          makeFinding(
            'blocker',
            'TARGET_PLAN_NAME_NOT_FOUND',
            null,
            null,
            `No Gravitee plan named ${target.targetPlan} was found under API ${api.id}`,
            { targetPlan: target.targetPlan, apiId: api.id },
          ),
        ],
      };
    }

    if (exactName.length > 1) {
      return {
        plan: null,
        findings: [
          makeFinding(
            'blocker',
            'TARGET_PLAN_NAME_AMBIGUOUS',
            null,
            null,
            `Plan lookup for ${target.targetPlan} under API ${api.id} was ambiguous`,
            { targetPlan: target.targetPlan, apiId: api.id, planIds: exactName.map((item) => item.id) },
          ),
        ],
      };
    }

    return { plan: exactName[0], findings: [] };
  } catch (err) {
    return {
      plan: null,
      findings: [
        makeFinding(
          'blocker',
          'TARGET_PLAN_LOOKUP_FAILED',
          null,
          null,
          `Plan lookup failed for ${target.targetPlan}`,
          { targetPlan: target.targetPlan, apiId: api.id, error: err.message },
        ),
      ],
    };
  }
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
    summary: {
      products: 0,
      targets: 0,
      validTargets: 0,
      blockers: 0,
      warnings: 0,
    },
    targets: [],
    findings: [],
  };

  for (const [productName, entry] of Object.entries(config.productPlanMap || {})) {
    report.summary.products += 1;
    const targets = normalizeTargets(entry);

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      report.summary.targets += 1;

      const apiResolution = await resolveApiTarget(target, client);
      const apiFindings = apiResolution.findings.map((finding) => ({
        ...finding,
        productName,
        targetIndex: index,
      }));

      let plan = null;
      let planFindings = [];
      if (apiResolution.api) {
        const planResolution = await resolvePlanTarget(target, apiResolution.api, client);
        plan = planResolution.plan;
        planFindings = planResolution.findings.map((finding) => ({
          ...finding,
          productName,
          targetIndex: index,
        }));
      }

      const findings = [...apiFindings, ...planFindings];
      report.findings.push(...findings);
      report.targets.push({
        productName,
        targetIndex: index,
        configured: target,
        resolved: {
          apiId: apiResolution.api?.id || null,
          apiName: apiResolution.api?.name || target.targetApi || null,
          planId: plan?.id || null,
          planName: plan?.name || target.targetPlan || null,
        },
        status: findings.length === 0 ? 'VALID' : 'BLOCKED',
        findings,
      });

      if (findings.length === 0) {
        report.summary.validTargets += 1;
      }
    }
  }

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
