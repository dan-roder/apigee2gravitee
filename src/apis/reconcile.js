'use strict';

const { prepareApisWorkflow, persistPlanningArtifacts } = require('./workflow');
const { buildReconcileReport } = require('./report-builder');
const { readJsonIfExists, writeJson, writeNdjson } = require('./state-store');

async function runApisReconcile(flags, deps = {}) {
  const result = await prepareApisWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result, { preserveRuntimeState: true });

  const idMap = readJsonIfExists(result.outputPaths.idMap) || result.idMap;
  const mismatches = [];

  for (const proxy of result.domain.proxies) {
    const target = await result.client.findApiByName(proxy.definition.name);
    if (!target) {
      mismatches.push({ severity: 'blocker', code: 'API_MISSING', sourceId: proxy.sourceId, message: `API ${proxy.definition.name} is missing` });
      continue;
    }
    const expectedId = idMap.apis[proxy.sourceId];
    if (expectedId && target.id !== expectedId) {
      mismatches.push({ severity: 'blocker', code: 'API_ID_MAP_MISMATCH', sourceId: proxy.sourceId, message: `API ${proxy.definition.name} resolved to ${target.id} instead of ${expectedId}` });
    }
    const plans = await result.client.listApiPlans(target.id);
    const expectedPlanIds = idMap.plans?.[proxy.sourceId] || {};
    for (const [planKey, planDefinition] of Object.entries(proxy.definition.plans || {})) {
      const planName = planDefinition.name;
      if (!plans.some((item) => item.name === planName)) {
        mismatches.push({ severity: 'blocker', code: 'API_PLAN_MISSING', sourceId: proxy.sourceId, message: `API ${proxy.definition.name} is missing plan ${planName}` });
        continue;
      }
      const expectedPlanId = expectedPlanIds[planKey];
      const actualPlan = plans.find((item) => item.name === planName);
      if (expectedPlanId && actualPlan && actualPlan.id !== expectedPlanId) {
        mismatches.push({
          severity: 'blocker',
          code: 'API_PLAN_ID_MAP_MISMATCH',
          sourceId: proxy.sourceId,
          message: `API ${proxy.definition.name} plan ${planName} resolved to ${actualPlan.id} instead of ${expectedPlanId}`,
        });
      }
    }
  }

  const summary = {
    checkedApis: result.domain.proxies.length,
    blockers: mismatches.filter((item) => item.severity === 'blocker').length,
    warnings: mismatches.filter((item) => item.severity === 'warning').length,
  };
  const report = buildReconcileReport(summary, mismatches);
  const events = [
    { ts: new Date().toISOString(), type: 'reconcile.summary', ...summary },
    ...mismatches.map((item) => ({ ts: new Date().toISOString(), type: `reconcile.${item.severity}`, ...item })),
  ];

  writeJson(result.outputPaths.reconcileReport, report);
  writeNdjson(result.outputPaths.log, events);

  return { ...result, report, exitCode: summary.blockers > 0 ? 6 : 0 };
}

module.exports = { runApisReconcile };
