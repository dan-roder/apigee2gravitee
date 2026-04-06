'use strict';

function issue(severity, code, message, details = {}) {
  return { severity, code, message, details };
}

function checkCompleteness(domain) {
  const findings = [];
  if (!domain.completeness.manifestPresent) {
    findings.push(issue('blocker', 'IR_MANIFEST_MISSING', 'manifest.json is missing'));
  }
  if (!domain.completeness.extractionReportPresent) {
    findings.push(issue('blocker', 'IR_EXTRACTION_REPORT_MISSING', 'extraction-report.json is missing'));
  }
  if (domain.proxies.length === 0) {
    findings.push(issue('blocker', 'IR_PROXIES_MISSING', 'No proxy IR files were found'));
  }
  return findings;
}

function checkProxyGaps(domain) {
  const findings = [];
  for (const proxy of domain.proxies) {
    const meta = proxy.definition?._migrationMeta || {};
    if ((meta.manualSteps || []).length > 0) {
      findings.push(issue('warning', 'PROXY_MANUAL_POLICIES_PRESENT', `Proxy ${proxy.proxyName} contains manual migration policy steps`, {
        proxyName: proxy.proxyName,
        manualSteps: meta.manualSteps,
      }));
    }
    if ((meta.llmSteps || []).length > 0) {
      findings.push(issue('warning', 'PROXY_LLM_POLICIES_PRESENT', `Proxy ${proxy.proxyName} contains LLM-review policy steps`, {
        proxyName: proxy.proxyName,
        llmSteps: meta.llmSteps.map((item) => item.name),
      }));
    }
    if ((meta.sharedFlowRefs || []).length > 0) {
      findings.push(issue('warning', 'PROXY_SHARED_FLOW_REFS_PRESENT', `Proxy ${proxy.proxyName} references shared flows`, {
        proxyName: proxy.proxyName,
        sharedFlowRefs: meta.sharedFlowRefs,
      }));
    }
  }
  return findings;
}

async function checkTargetAccess(client) {
  const findings = [];
  if (!client) {
    findings.push(issue('blocker', 'GRAVITEE_CLIENT_UNAVAILABLE', 'Unable to create Gravitee client'));
    return findings;
  }
  const health = await client.healthCheck();
  if (!health.ok) {
    findings.push(issue('blocker', 'GRAVITEE_AUTH_FAILED', `Gravitee health check failed: ${health.error || 'unknown error'}`, { status: health.status || null }));
    return findings;
  }
  const envCheck = await client.verifyEnvironmentAccess();
  if (!envCheck.ok) {
    findings.push(issue('blocker', 'GRAVITEE_ENV_ACCESS_FAILED', envCheck.error || 'Unable to verify organization/environment access'));
  }
  if (typeof client.verifyApiImportCapabilities === 'function') {
    const probe = await client.verifyApiImportCapabilities();
    for (const [name, check] of Object.entries(probe.checks || {})) {
      if (!check.supported) {
        findings.push(issue('blocker', `API_IMPORT_${name.toUpperCase()}_UNSUPPORTED`, `API import probe failed for ${name}`, check));
      } else if (!check.ok) {
        findings.push(issue('warning', `API_IMPORT_${name.toUpperCase()}_UNVERIFIED`, `API import probe could not fully verify ${name}`, check));
      }
    }
  }
  return findings;
}

async function validateApisPreflight({ domain, client }) {
  const findings = [
    ...checkCompleteness(domain),
    ...checkProxyGaps(domain),
    ...await checkTargetAccess(client),
  ];
  return {
    findings,
    blockers: findings.filter((item) => item.severity === 'blocker'),
    warnings: findings.filter((item) => item.severity === 'warning'),
  };
}

module.exports = { validateApisPreflight };
