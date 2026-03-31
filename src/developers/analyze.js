'use strict';

const { prepareDevelopersWorkflow, persistPlanningArtifacts } = require('./workflow');

async function runDevelopersAnalyze(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result);
  return {
    ...result,
    plan: result.manifest,
  };
}

module.exports = { runDevelopersAnalyze };
