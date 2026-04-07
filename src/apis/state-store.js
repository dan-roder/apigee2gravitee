'use strict';

const path = require('path');
const {
  ensureDir,
  readJsonIfExists,
  writeJson,
  writeNdjson,
  initializeStateFromManifest,
  mergeSavedActionState,
  markActionStarted,
  markActionCompleted,
} = require('../developers/state-store');

function resolveOutputPaths(config) {
  const reportDir = path.resolve(config.reporting.reportDir);
  const stateFile = path.resolve(config.reporting.stateFile);
  return {
    plan: path.join(reportDir, 'apis-plan.json'),
    gapReport: path.join(reportDir, 'apis-gap-report.json'),
    reconcileReport: path.join(reportDir, 'apis-reconcile-report.json'),
    state: stateFile,
    idMap: path.join(path.dirname(stateFile), 'apis-id-map.json'),
    log: path.resolve(path.join(path.dirname(reportDir), 'logs', 'apis.ndjson')),
  };
}

function initializeIdMap(domain) {
  return {
    generatedAt: new Date().toISOString(),
    apis: Object.fromEntries(domain.proxies.map((item) => [item.sourceId, null])),
    plans: Object.fromEntries(domain.proxies.map((item) => [item.sourceId, {}])),
  };
}

function setIdMapValue(idMap, kind, sourceId, value) {
  if (kind === 'UPSERT_API' || kind === 'VERIFY_API') {
    idMap.apis[sourceId] = value;
  }
  if (kind === 'UPSERT_PLAN' || kind === 'VERIFY_PLAN') {
    const bucket = idMap.plans[sourceId] || {};
    idMap.plans[sourceId] = bucket;
    if (value?.planKey) {
      bucket[value.planKey] = value.planId || null;
    }
  }
}

module.exports = {
  ensureDir,
  readJsonIfExists,
  writeJson,
  writeNdjson,
  initializeStateFromManifest,
  mergeSavedActionState,
  markActionStarted,
  markActionCompleted,
  resolveOutputPaths,
  initializeIdMap,
  setIdMapValue,
};
