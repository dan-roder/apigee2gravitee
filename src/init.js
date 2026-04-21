'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildPaths(cwd, flags = {}) {
  return {
    apisExample: path.resolve(cwd, 'config', 'apis.config.example.json'),
    developersExample: path.resolve(cwd, 'config', 'developers.config.example.json'),
    apisConfig: path.resolve(cwd, flags['apis-config'] || './config/apis.config.json'),
    developersConfig: path.resolve(cwd, flags['developers-config'] || './config/developers.config.json'),
    developersResolvedConfig: path.resolve(
      cwd,
      flags['developers-resolved-config'] || './config/developers.config.resolved.json',
    ),
  };
}

function resolveDefaults(flags, paths) {
  const existingApis = readJsonIfExists(paths.apisConfig);
  const existingDevelopers = readJsonIfExists(paths.developersConfig);
  const existingResolved = readJsonIfExists(paths.developersResolvedConfig);
  const apisExample = readJson(paths.apisExample);
  const developersExample = readJson(paths.developersExample);

  const url = normalizeUrl(
    flags['gravitee-url']
    || existingApis?.gravitee?.url
    || existingResolved?.gravitee?.url
    || existingDevelopers?.gravitee?.url
    || apisExample?.gravitee?.url
    || developersExample?.gravitee?.url
    || 'http://localhost:8083',
  );

  const orgId = String(
    flags.org
    || existingApis?.gravitee?.orgId
    || existingResolved?.gravitee?.orgId
    || existingDevelopers?.gravitee?.orgId
    || apisExample?.gravitee?.orgId
    || developersExample?.gravitee?.orgId
    || 'DEFAULT',
  ).trim();

  const envId = String(
    flags.env
    || existingApis?.gravitee?.envId
    || existingResolved?.gravitee?.envId
    || existingDevelopers?.gravitee?.envId
    || apisExample?.gravitee?.envId
    || developersExample?.gravitee?.envId
    || 'DEFAULT',
  ).trim();

  return { url, orgId, envId };
}

function applySharedGraviteeConfig(config, gravitee) {
  const next = clone(config);
  next.gravitee = next.gravitee || {};
  next.gravitee.url = gravitee.url;
  next.gravitee.orgId = gravitee.orgId;
  next.gravitee.envId = gravitee.envId;
  return next;
}

function createPrompter(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output });

  return {
    async ask(prompt, defaultValue) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = await rl.question(`${prompt}${suffix}: `);
      const trimmed = answer.trim();
      return trimmed || defaultValue || '';
    },
    async confirm(prompt, defaultValue = false) {
      const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
      const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      return answer === 'y' || answer === 'yes';
    },
    close() {
      rl.close();
    },
  };
}

async function writeTarget(filePath, payload, options = {}) {
  const { force = false, prompter, label = 'file' } = options;
  if (fs.existsSync(filePath) && !force) {
    const overwrite = await prompter.confirm(`Overwrite existing ${label} at ${filePath}?`, false);
    if (!overwrite) {
      return { path: filePath, status: 'skipped' };
    }
  }
  writeJson(filePath, payload);
  return { path: filePath, status: 'written' };
}

async function runInitCommand(flags = {}, fmt = null, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const paths = buildPaths(cwd, flags);

  if (!fs.existsSync(paths.apisExample)) {
    throw new Error(`API config example not found: ${paths.apisExample}`);
  }
  if (!fs.existsSync(paths.developersExample)) {
    throw new Error(`Developers config example not found: ${paths.developersExample}`);
  }

  const defaults = resolveDefaults(flags, paths);
  const nonInteractiveValuesProvided = !!(
    flags['gravitee-url']
    && flags.org
    && flags.env
  );

  let ownsPrompter = false;
  const prompter = deps.prompter || (() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      if (!nonInteractiveValuesProvided) {
        throw new Error('init requires an interactive terminal, or pass --gravitee-url, --org, and --env');
      }
      if (!flags.force) {
        throw new Error('non-interactive init with existing files requires --force');
      }
      return {
        async ask(_prompt, defaultValue) { return defaultValue || ''; },
        async confirm() { return true; },
        close() {},
      };
    }
    ownsPrompter = true;
    return createPrompter(deps.input, deps.output);
  })();

  try {
    const url = normalizeUrl(await prompter.ask('Gravitee base URL', defaults.url));
    const orgId = String(await prompter.ask('Gravitee organization ID', defaults.orgId)).trim();
    const envId = String(await prompter.ask('Gravitee environment ID', defaults.envId)).trim();

    if (!url) throw new Error('Gravitee base URL is required');
    if (!orgId) throw new Error('Gravitee organization ID is required');
    if (!envId) throw new Error('Gravitee environment ID is required');

    const gravitee = { url, orgId, envId };
    const apisConfig = applySharedGraviteeConfig(readJson(paths.apisExample), gravitee);
    const developersConfig = applySharedGraviteeConfig(readJson(paths.developersExample), gravitee);
    const developersResolvedConfig = clone(developersConfig);

    const force = !!flags.force;
    const writes = [];
    writes.push(await writeTarget(paths.apisConfig, apisConfig, {
      force,
      prompter,
      label: 'API config',
    }));
    writes.push(await writeTarget(paths.developersConfig, developersConfig, {
      force,
      prompter,
      label: 'developers config',
    }));
    writes.push(await writeTarget(paths.developersResolvedConfig, developersResolvedConfig, {
      force,
      prompter,
      label: 'resolved developers config',
    }));

    return {
      exitCode: 0,
      gravitee,
      paths,
      writes,
      hints: [
        'Set GRAVITEE_TOKEN in your shell before running live API or developers commands.',
        'Review productPlanMap, roles, and capability settings in the developers config before developers analyze/import.',
        'Run extract first to populate ./ir, then use apis analyze/plan/import/reconcile.',
      ],
      fmt,
    };
  } finally {
    if (ownsPrompter) prompter.close();
  }
}

module.exports = {
  runInitCommand,
  buildPaths,
  applySharedGraviteeConfig,
  createPrompter,
};
