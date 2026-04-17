'use strict';

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeList(values = []) {
  return Array.isArray(values)
    ? values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
}

function getMatchMode(target = {}) {
  return target.matchMode || 'exact';
}

function collectConfiguredNames(target = {}, key, aliasKey) {
  const names = [];
  if (target[key]) names.push(String(target[key]).trim());
  if (getMatchMode(target) === 'alias') {
    for (const alias of normalizeList(target[aliasKey])) names.push(alias);
  }
  return Array.from(new Set(names.filter(Boolean)));
}

function classifyPlanSecurity(plan) {
  const raw = String(
    plan?.security?.type
      || plan?.security
      || plan?.type
      || plan?.securityType
      || ''
  ).trim().toUpperCase();

  if (!raw) return 'unknown';
  if (raw.includes('KEY') && !raw.includes('LESS')) return 'api-key';
  if (raw.includes('KEYLESS') || raw.includes('KEY_LESS')) return 'keyless';
  if (raw.includes('OAUTH') || raw.includes('JWT')) return 'oauth-client';
  return 'other';
}

function classifyCredentialType(credential) {
  if (credential?.oauthContinuityRelevant) return 'oauth-client';
  return 'api-key';
}

function summarizeProductCredentialType(domain, productName) {
  const credentials = (domain?.credentials || []).filter((credential) => (
    (credential.apiProducts || []).some((product) => product.productName === productName)
  ));
  const types = Array.from(new Set(credentials.map(classifyCredentialType)));
  return {
    productName,
    credentialTypes: types,
    primaryCredentialType: types.includes('oauth-client') ? 'oauth-client' : (types[0] || 'api-key'),
    hasMixedCredentialTypes: types.length > 1,
    sourceCredentials: credentials.map((credential) => credential.credentialId),
  };
}

function matchByNames(itemName, configuredNames) {
  const exact = configuredNames.filter((name) => itemName === name);
  if (exact.length > 0) return { matched: true, mode: 'exact-name', matchedName: exact[0] };

  const normalizedItemName = normalizeName(itemName);
  const normalized = configuredNames.find((name) => normalizeName(name) === normalizedItemName);
  if (normalized) return { matched: true, mode: 'normalized-name', matchedName: normalized };

  return { matched: false, mode: null, matchedName: null };
}

function resolveApiCandidates(target, apis) {
  if (!Array.isArray(apis)) return [];
  if (target.targetApiId) {
    return apis
      .filter((api) => api.id === target.targetApiId)
      .map((api) => ({ api, matchMode: 'id' }));
  }

  if (getMatchMode(target) === 'id-only') return [];

  const configuredNames = collectConfiguredNames(target, 'targetApi', 'targetApiAliases');
  return apis.flatMap((api) => {
    const match = matchByNames(api?.name || '', configuredNames);
    return match.matched ? [{ api, matchMode: match.mode, matchedName: match.matchedName }] : [];
  });
}

function resolvePlanCandidates(target, plans) {
  if (!Array.isArray(plans)) return [];
  if (target.targetPlanId) {
    return plans
      .filter((plan) => plan.id === target.targetPlanId)
      .map((plan) => ({ plan, matchMode: 'id' }));
  }

  if (getMatchMode(target) === 'id-only') return [];

  const configuredNames = collectConfiguredNames(target, 'targetPlan', 'targetPlanAliases');
  return plans.flatMap((plan) => {
    const match = matchByNames(plan?.name || '', configuredNames);
    return match.matched ? [{ plan, matchMode: match.mode, matchedName: match.matchedName }] : [];
  });
}

function evaluatePlanSuitability(plan, credentialProfile) {
  const security = classifyPlanSecurity(plan);
  const credentialType = credentialProfile?.primaryCredentialType || 'api-key';

  if (credentialType === 'oauth-client') {
    if (security === 'oauth-client') return { suitable: true, advisoryCode: null };
    return { suitable: false, advisoryCode: 'TARGET_PLAN_SECURITY_MISMATCH' };
  }

  if (credentialType === 'api-key') {
    if (security === 'api-key') return { suitable: true, advisoryCode: null };
    if (security === 'keyless') return { suitable: false, advisoryCode: 'TARGET_PLAN_SECURITY_MISMATCH' };
    if (security === 'oauth-client') return { suitable: false, advisoryCode: 'TARGET_PLAN_SECURITY_MISMATCH' };
  }

  return { suitable: false, advisoryCode: 'TARGET_PLAN_SECURITY_MISMATCH' };
}

function isPlanStatusSuitable(plan) {
  const status = String(plan?.status || plan?.state || '').trim().toUpperCase();
  if (!status) return true;
  return ['PUBLISHED', 'STAGING', 'PUBLISHED_DEFAULT'].includes(status);
}

module.exports = {
  normalizeName,
  classifyPlanSecurity,
  classifyCredentialType,
  summarizeProductCredentialType,
  resolveApiCandidates,
  resolvePlanCandidates,
  evaluatePlanSuitability,
  isPlanStatusSuitable,
  getMatchMode,
};
