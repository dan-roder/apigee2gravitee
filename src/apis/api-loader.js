'use strict';

const path = require('path');

const { IrLoader } = require('../shared/ir-loader');
const { parseProxyIr } = require('../translator/parser/proxy-ast');
const { mapProxyToGraviteeApi } = require('../translator/mapper/policy-mapper');

function filterByRules(items, includeSet, excludeSet, keyFn) {
  return items.filter((item) => {
    const key = keyFn(item);
    if (includeSet.size > 0 && !includeSet.has(key)) return false;
    if (excludeSet.has(key)) return false;
    return true;
  });
}

function buildResolvedServers(loader) {
  const file = loader.inventory('target-servers-resolved');
  if (file && typeof file === 'object') return file;
  const servers = {};
  for (const target of loader.targetServers()) {
    const scheme = target.ssl_enabled ? 'https' : 'http';
    const port = target.port || (target.ssl_enabled ? 443 : 80);
    const defaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
    const suffix = defaultPort ? '' : `:${port}`;
    servers[target.name] = { url: `${scheme}://${target.host}${suffix}` };
  }
  return servers;
}

function loadApiDomain(irDir, config) {
  const loader = new IrLoader(irDir);
  const manifest = loader.manifest();
  const extractionReport = loader.extractionReport();
  const include = new Set(config.filters?.includeProxies || []);
  const exclude = new Set(config.filters?.excludeProxies || []);
  const resolvedServers = buildResolvedServers(loader);
  const proxyKvms = loader.proxyKvms();
  const fallbackPlugins = new Set(config.compatibility?.fallbackPlugins || []);

  const proxies = filterByRules(loader.proxies(), include, exclude, (proxy) => proxy.name).map((proxy) => {
    const ast = parseProxyIr(proxy);
    const definition = mapProxyToGraviteeApi(ast, {
      resolvedServers,
      proxyKvms: proxyKvms.filter((kvm) => kvm.proxy_name === proxy.name || kvm.proxy === proxy.name),
      policyOptions: { fallbackPlugins },
    });
    return {
      sourceId: proxy.name,
      proxyName: proxy.name,
      displayName: ast.displayName || ast.name,
      ast,
      definition,
      blockers: [],
      warnings: [],
      manualReviewReasons: [
        ...new Set([
          ...(definition._migrationMeta?.manualSteps || []).map((name) => `MANUAL_POLICY:${name}`),
          ...(definition._migrationMeta?.llmSteps || []).map((item) => `LLM_POLICY:${item.name}`),
          ...((definition._migrationMeta?.sharedFlowRefs || []).length > 0 ? ['SHARED_FLOW_REFS_PRESENT'] : []),
        ]),
      ],
    };
  });

  return {
    irDir: path.resolve(irDir),
    manifest,
    extractionReport,
    proxies,
    resolvedServers,
    completeness: {
      manifestPresent: !!manifest,
      extractionReportPresent: !!extractionReport,
      proxyCount: proxies.length,
    },
  };
}

module.exports = { loadApiDomain };
