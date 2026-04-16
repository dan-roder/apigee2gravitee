'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
}

function writeNdjson(filePath, events) {
  ensureDir(path.dirname(filePath));
  const lines = events.map((event) => JSON.stringify(event)).join('\n');
  fs.writeFileSync(filePath, lines ? `${lines}\n` : '');
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveOutputPaths(config) {
  const reportDir = path.resolve(config.reporting.reportDir);
  const stateFile = path.resolve(config.reporting.stateFile);
  return {
    plan: path.join(reportDir, 'developers-plan.json'),
    gapReport: path.join(reportDir, 'developers-gap-report.json'),
    syncReport: path.join(reportDir, 'developers-sync-api-targets-report.json'),
    reconcileReport: path.join(reportDir, 'developers-reconcile-report.json'),
    cleanupReport: path.join(reportDir, 'developers-cleanup-report.json'),
    state: stateFile,
    idMap: path.join(path.dirname(stateFile), 'developers-id-map.json'),
    log: path.resolve(path.join(path.dirname(reportDir), 'logs', 'developers.ndjson')),
  };
}

function initializeStateFromManifest(manifest, mode = 'plan') {
  const actions = {};
  for (const item of manifest.actions) {
    actions[item.actionId] = {
      actionId: item.actionId,
      kind: item.kind,
      sourceId: item.sourceId,
      plannedStatus: item.plannedStatus,
      status: item.plannedStatus === 'READY' ? 'PENDING' : item.plannedStatus,
      dependencies: item.dependencies || [],
      targetIds: {},
      reconcileHints: {},
      lastError: null,
      startedAt: null,
      completedAt: null,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mode,
    summary: manifest.summary,
    actions,
  };
}

function initializeIdMap(domain) {
  return {
    generatedAt: new Date().toISOString(),
    users: Object.fromEntries(domain.users.map((item) => [item.sourceId, null])),
    applications: Object.fromEntries(domain.applications.map((item) => [item.sourceId, null])),
    subscriptions: Object.fromEntries(domain.subscriptions.map((item) => [item.sourceId, null])),
  };
}

function mergeSavedActionState(initialState, savedState) {
  if (!savedState?.actions) return initialState;
  const merged = JSON.parse(JSON.stringify(initialState));
  for (const [actionId, saved] of Object.entries(savedState.actions)) {
    if (merged.actions[actionId]) {
      merged.actions[actionId] = {
        ...merged.actions[actionId],
        ...saved,
      };
    }
  }
  merged.updatedAt = new Date().toISOString();
  return merged;
}

function markActionStarted(state, actionId) {
  state.actions[actionId].status = 'RUNNING';
  state.actions[actionId].startedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();
}

function markActionCompleted(state, actionId, status, patch = {}) {
  state.actions[actionId] = {
    ...state.actions[actionId],
    ...patch,
    status,
    completedAt: new Date().toISOString(),
  };
  state.updatedAt = new Date().toISOString();
}

function setIdMapValue(idMap, kind, sourceId, value) {
  if (kind === 'UPSERT_USER' || kind === 'VERIFY_USER') {
    idMap.users[sourceId] = value;
  } else if (kind === 'UPSERT_APPLICATION' || kind === 'VERIFY_APPLICATION') {
    idMap.applications[sourceId] = value;
  } else if (kind === 'UPSERT_SUBSCRIPTION' || kind === 'VERIFY_SUBSCRIPTION') {
    idMap.subscriptions[sourceId] = value;
  }
}

module.exports = {
  ensureDir,
  readJsonIfExists,
  resolveOutputPaths,
  writeJson,
  writeNdjson,
  initializeStateFromManifest,
  initializeIdMap,
  mergeSavedActionState,
  markActionStarted,
  markActionCompleted,
  setIdMapValue,
};
