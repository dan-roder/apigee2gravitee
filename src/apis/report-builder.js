'use strict';

function addSummaryCount(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function action(actionId, kind, sourceId, payload = {}) {
  return {
    actionId,
    kind,
    sourceId,
    dependencies: [],
    plannedStatus: 'READY',
    operation: 'NOOP',
    lookup: {},
    payload: {},
    blockers: [],
    warnings: [],
    manualReviewReasons: [],
    ...payload,
  };
}

function resolveApiOperation(proxy, targetState) {
  const existing = targetState.apisBySourceId.get(proxy.sourceId) || targetState.apisByName.get(proxy.definition.name);
  if (!existing) {
    return { plannedStatus: 'READY', operation: 'CREATE', targetId: null };
  }
  return { plannedStatus: 'READY', operation: 'UPDATE', targetId: existing.id };
}

function buildPlan(domain, preflight, targetState = {
  apisBySourceId: new Map(),
  apisByName: new Map(),
  plansByApiSourceId: new Map(),
}) {
  const actions = [];

  for (const proxy of domain.proxies) {
    const resolution = resolveApiOperation(proxy, targetState);
    const upsert = action(`UPSERT_API:${proxy.sourceId}`, 'UPSERT_API', proxy.sourceId, {
      plannedStatus: resolution.plannedStatus,
      operation: resolution.operation,
      lookup: { sourceId: proxy.sourceId, name: proxy.definition.name },
      payload: {
        definition: proxy.definition,
      },
      blockers: [...proxy.blockers],
      warnings: [...proxy.warnings],
      manualReviewReasons: [...proxy.manualReviewReasons],
      targetHint: resolution.targetId ? { apiId: resolution.targetId } : {},
    });
    actions.push(upsert);

    const verify = action(`VERIFY_API:${proxy.sourceId}`, 'VERIFY_API', proxy.sourceId, {
      dependencies: [upsert.actionId],
      plannedStatus: upsert.plannedStatus,
      operation: 'VERIFY',
      lookup: upsert.lookup,
      payload: {
        expectedName: proxy.definition.name,
        expectedPlans: Object.values(proxy.definition.plans || {}).map((plan) => plan.name),
      },
      blockers: [...upsert.blockers],
      warnings: [...upsert.warnings],
      manualReviewReasons: [...upsert.manualReviewReasons],
    });
    actions.push(verify);
  }

  const actionsByKind = {};
  const actionsByStatus = {};
  for (const item of actions) {
    addSummaryCount(actionsByKind, item.kind);
    addSummaryCount(actionsByStatus, item.plannedStatus);
  }

  return {
    generatedAt: new Date().toISOString(),
    kind: 'ApisMigrationManifest',
    source: {
      irDir: domain.irDir,
      manifestExtractedAt: domain.manifest?.extracted_at || null,
    },
    summary: {
      proxies: domain.proxies.length,
      blockers: preflight.blockers.length,
      warnings: preflight.warnings.length,
      actions: actions.length,
      actionsByKind,
      actionsByStatus,
    },
    records: {
      proxies: domain.proxies.map((item) => ({
        sourceId: item.sourceId,
        proxyName: item.proxyName,
        definition: item.definition,
        manualReviewReasons: item.manualReviewReasons,
      })),
    },
    findings: preflight.findings,
    actions,
  };
}

function buildGapReport(domain, preflight, manifest) {
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      proxies: domain.proxies.length,
      blockers: preflight.blockers.length,
      warnings: preflight.warnings.length,
      actions: manifest.actions.length,
      manualReview: domain.proxies.reduce((count, proxy) => count + proxy.manualReviewReasons.length, 0),
    },
    findings: preflight.findings,
    proxies: domain.proxies.map((proxy) => ({
      proxyName: proxy.proxyName,
      manualReviewReasons: proxy.manualReviewReasons,
      migrationMeta: proxy.definition._migrationMeta,
    })),
  };
}

function buildReconcileReport(summary, mismatches) {
  return {
    generatedAt: new Date().toISOString(),
    summary,
    mismatches,
  };
}

module.exports = {
  buildPlan,
  buildGapReport,
  buildReconcileReport,
};
