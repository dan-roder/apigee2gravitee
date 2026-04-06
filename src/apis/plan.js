'use strict';

const { prepareApisWorkflow, persistPlanningArtifacts } = require('./workflow');

async function runApisPlan(flags, deps = {}) {
  const result = await prepareApisWorkflow(flags, deps);
  if (result.validationErrors) return result;
  persistPlanningArtifacts(result);
  return result;
}

module.exports = { runApisPlan };
