'use strict';

const { prepareApisWorkflow, persistPlanningArtifacts } = require('./workflow');

async function runApisAnalyze(flags, deps = {}) {
  const result = await prepareApisWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result);
  return { ...result, plan: result.manifest };
}

module.exports = { runApisAnalyze };
