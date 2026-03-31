'use strict';

const { prepareDevelopersWorkflow, persistPlanningArtifacts } = require('./workflow');

async function runDevelopersPlan(flags, deps = {}) {
  const result = await prepareDevelopersWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result);
  return result;
}

module.exports = { runDevelopersPlan };
