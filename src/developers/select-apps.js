'use strict';

const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { IrLoader } = require('../shared/ir-loader');
const { loadDevelopersConfig, validateDevelopersConfig } = require('./config');
const { resolveOutputPaths, writeJson } = require('./state-store');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function appSourceId(app) {
  return `${app.developer_email}/${app.name}`;
}

function normalizeProducts(products) {
  return Array.from(new Set((products || [])
    .map((product) => (typeof product === 'string' ? product : product?.name))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function credentialProductNames(credential) {
  return normalizeProducts(credential.api_products || credential.apiProducts || credential.products || []);
}

function buildApplicationCatalog(irDir, config, deps = {}) {
  const loader = deps.loader || new IrLoader(irDir);
  const developers = loader.developers();
  const apps = loader.apps();
  const credentials = loader.credentials();
  const developerByEmail = new Map(developers.map((developer) => [developer.email, developer]));
  const credentialsByApp = new Map();

  for (const credential of credentials) {
    const key = `${credential.developer_email}/${credential.app_name}`;
    const existing = credentialsByApp.get(key) || [];
    existing.push(credential);
    credentialsByApp.set(key, existing);
  }

  const includeApps = new Set(config.filters?.includeApps || []);

  return apps
    .map((app) => {
      const sourceId = appSourceId(app);
      const appCredentials = credentialsByApp.get(sourceId) || [];
      const products = normalizeProducts(appCredentials.flatMap((credential) => credentialProductNames(credential)));
      const developer = developerByEmail.get(app.developer_email);
      return {
        sourceId,
        developerEmail: app.developer_email,
        appName: app.name,
        appStatus: app.status || 'unknown',
        developerStatus: developer?.status || 'unknown',
        credentialCount: appCredentials.length,
        products,
        preselected: includeApps.has(sourceId),
      };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function parseSelectionAnswer(answer, appCount, currentSelection = []) {
  const normalized = String(answer || '').trim().toLowerCase();
  const current = Array.from(new Set(currentSelection)).sort((a, b) => a - b);

  if (!normalized) return { kind: 'selection', indexes: current };
  if (normalized === 's' || normalized === 'skip') return { kind: 'skip', indexes: current };
  if (normalized === 'a' || normalized === 'all') return { kind: 'selection', indexes: range(1, appCount) };
  if (normalized === 'n' || normalized === 'none') return { kind: 'selection', indexes: [] };

  const selected = new Set();
  for (const token of normalized.split(',').map((part) => part.trim()).filter(Boolean)) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < 1 || end > appCount || start > end) {
        throw new Error(`invalid selection range: ${token}`);
      }
      for (const index of range(start, end)) selected.add(index);
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new Error(`invalid selection token: ${token}`);
    }
    const index = Number(token);
    if (index < 1 || index > appCount) {
      throw new Error(`selection out of range: ${token}`);
    }
    selected.add(index);
  }

  return { kind: 'selection', indexes: Array.from(selected).sort((a, b) => a - b) };
}

function defaultOutputPath(configPath) {
  const absolutePath = path.resolve(configPath);
  if (absolutePath.endsWith('.resolved.json')) return absolutePath;
  if (absolutePath.endsWith('.json')) return absolutePath.replace(/\.json$/, '.resolved.json');
  return `${absolutePath}.resolved.json`;
}

function currentSelectionIndexes(catalog, config) {
  const includeApps = config.filters?.includeApps || [];
  if (includeApps.length === 0) return catalog.map((_, index) => index + 1);

  const selected = new Set(includeApps);
  return catalog
    .map((item, index) => (selected.has(item.sourceId) ? index + 1 : null))
    .filter((index) => index !== null);
}

function formatAppChoice(item, index) {
  const products = item.products.length > 0 ? item.products.join(', ') : 'none';
  const credentialLabel = item.credentialCount === 1 ? 'credential' : 'credentials';
  return `${String(index + 1).padStart(3, ' ')}. ${item.sourceId} [app=${item.appStatus}, developer=${item.developerStatus}, ${item.credentialCount} ${credentialLabel}, products=${products}]`;
}

async function promptForSelection(catalog, config, deps = {}) {
  const existing = config.filters?.includeApps || [];
  const defaultIndexes = currentSelectionIndexes(catalog, config);
  const prompt = deps.prompt || (async (message) => {
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  });

  const lines = [
    'Select Apigee developer applications to import into Gravitee.',
    '',
    ...catalog.map(formatAppChoice),
    '',
    existing.length > 0
      ? `Current filters.includeApps has ${existing.length} app(s) preselected. Press Enter to keep that selection.`
      : 'Current filters.includeApps is empty, so all apps are currently included by default. Press Enter to keep all apps selected.',
    'Enter numbers/ranges (example: 1,3-5), a=all, n=none, s=skip writing changes: ',
  ];

  while (true) {
    const answer = await prompt(lines.join('\n'));
    try {
      return parseSelectionAnswer(answer, catalog.length, defaultIndexes);
    } catch (err) {
      if (deps.prompt) throw err;
      console.log(`Invalid selection: ${err.message}`);
    }
  }
}

function summarizeSelection(catalog, selectedIds, config) {
  const selected = new Set(selectedIds);
  const selectedApps = catalog.filter((item) => selected.has(item.sourceId));
  const excludedApps = catalog.filter((item) => !selected.has(item.sourceId));
  const selectedDevelopers = Array.from(new Set(selectedApps.map((item) => item.developerEmail))).sort((a, b) => a.localeCompare(b));
  const productsCovered = Array.from(new Set(selectedApps.flatMap((item) => item.products))).sort((a, b) => a.localeCompare(b));
  const configuredProducts = new Set(Object.keys(config.productPlanMap || {}));
  const missingProductPlanMappings = productsCovered.filter((productName) => !configuredProducts.has(productName));

  return {
    totalAppsDiscovered: catalog.length,
    selectedAppCount: selectedApps.length,
    excludedAppCount: excludedApps.length,
    selectedDeveloperCount: selectedDevelopers.length,
    selectedApps,
    excludedApps,
    selectedDevelopers,
    productsCovered,
    missingProductPlanMappings,
  };
}

async function runSelectDevelopersApps(flags, deps = {}) {
  const irDir = path.resolve(flags['ir-dir'] || './ir');
  const configPath = flags.config;
  let config;
  try {
    config = deps.config || loadDevelopersConfig(configPath, flags);
  } catch (err) {
    return { exitCode: 1, error: err.message };
  }

  const validation = validateDevelopersConfig(config, { allowEmpty: true });
  if (!validation.valid) {
    return { exitCode: 1, validationErrors: validation.errors };
  }

  const outputPaths = resolveOutputPaths(config);
  const catalog = buildApplicationCatalog(irDir, config, deps);
  const clearSelection = !!flags['clear-selection'];
  let skipped = false;
  let selectedIndexes = [];

  if (clearSelection) {
    selectedIndexes = [];
  } else {
    const selection = await promptForSelection(catalog, config, deps);
    skipped = selection.kind === 'skip';
    selectedIndexes = selection.indexes;
  }

  const selectedIds = selectedIndexes
    .map((index) => catalog[index - 1]?.sourceId)
    .filter(Boolean);
  const summary = summarizeSelection(catalog, selectedIds, config);
  const report = {
    generatedAt: new Date().toISOString(),
    command: 'developers select-apps',
    irDir,
    configPath: path.resolve(configPath),
    cleared: clearSelection,
    skipped,
    existingIncludeApps: config.filters?.includeApps || [],
    summary: {
      totalAppsDiscovered: summary.totalAppsDiscovered,
      selectedApps: summary.selectedAppCount,
      excludedApps: summary.excludedAppCount,
      selectedDevelopers: summary.selectedDeveloperCount,
      productsCovered: summary.productsCovered.length,
      missingProductPlanMappings: summary.missingProductPlanMappings.length,
    },
    selectedApps: summary.selectedApps,
    excludedApps: summary.excludedApps,
    selectedDevelopers: summary.selectedDevelopers,
    productsCovered: summary.productsCovered,
    missingProductPlanMappings: summary.missingProductPlanMappings,
  };

  const reportPath = path.resolve(flags['output-report'] || outputPaths.appSelectionReport);
  writeJson(reportPath, report);

  const shouldWriteConfig = !skipped && (flags['write-config'] || flags['output-config'] || clearSelection);
  let outputPath = null;
  let outputConfig = null;
  if (shouldWriteConfig) {
    outputConfig = clone(config);
    delete outputConfig._meta;
    outputConfig.filters = outputConfig.filters || {};
    outputConfig.filters.includeApps = selectedIds;
    outputPath = path.resolve(flags['output-config'] || defaultOutputPath(configPath));
    writeJson(outputPath, outputConfig);
  }

  return {
    exitCode: 0,
    catalog,
    report,
    reportPath,
    outputPath,
    outputConfig,
    skipped,
  };
}

module.exports = {
  buildApplicationCatalog,
  parseSelectionAnswer,
  runSelectDevelopersApps,
  summarizeSelection,
};
