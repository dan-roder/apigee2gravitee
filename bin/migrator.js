#!/usr/bin/env node
'use strict';

/**
 * bin/migrator.js
 *
 * CLI entry point for apigee2gravitee.
 *
 * Commands:
 *   migrator extract  --data-dir <path> --ir-dir <path> [--org <name>] [--env <name>] [-v]
 *
 * The extract command spawns the Python extractor as a subprocess.
 * Every line of stdout from the extractor is a JSON progress/status object
 * which this wrapper pretty-prints to the terminal.
 *
 * Future commands (parser, mapper, importer) will be pure Node.js modules
 * called directly from this file.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Colours (no dependencies) ───────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
};

const fmt = {
  ok:      (s) => `${c.green}✓${c.reset} ${s}`,
  warn:    (s) => `${c.yellow}⚠ ${s}${c.reset}`,
  err:     (s) => `${c.red}✗ ${s}${c.reset}`,
  info:    (s) => `${c.cyan}ℹ${c.reset} ${s}`,
  bold:    (s) => `${c.bold}${s}${c.reset}`,
  dim:     (s) => `${c.dim}${s}${c.reset}`,
  header:  (s) => `\n${c.bold}${c.blue}${s}${c.reset}`,
};

// ─── Argument parser (no commander dependency) ───────────────────────────────

function parseArgs(argv) {
  const args = { flags: {}, positional: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args.flags[key] = next;
        i += 2;
      } else {
        args.flags[key] = true;
        i++;
      }
    } else if (arg === '-v' || arg === '--verbose') {
      args.flags['verbose'] = true;
      i++;
    } else {
      args.positional.push(arg);
      i++;
    }
  }
  return args;
}

// ─── Progress bar renderer ────────────────────────────────────────────────────

function renderBar(current, total, width = 30) {
  const pct = total > 0 ? Math.floor((current / total) * width) : width;
  const filled = '█'.repeat(pct);
  const empty  = '░'.repeat(width - pct);
  return `[${filled}${empty}] ${current}/${total}`;
}

// ─── JSON line parser for extractor stdout ───────────────────────────────────

function handleExtractorLine(line, verbose) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // Raw text line (shouldn't happen but be safe)
    if (verbose) process.stdout.write(fmt.dim(line) + '\n');
    return;
  }

  switch (msg.type) {
    case 'progress':
      process.stdout.write(
        `\r  ${fmt.dim(msg.label.padEnd(12))} ${renderBar(msg.current, msg.total)}  `
      );
      if (msg.current === msg.total) process.stdout.write('\n');
      break;

    case 'info':
      console.log(fmt.info(msg.msg));
      break;

    case 'warn':
      console.log(fmt.warn(msg.msg));
      break;

    case 'error':
      console.log(fmt.err(msg.msg));
      break;

    case 'done':
      console.log(fmt.header('Extraction complete'));
      console.log('');
      const rows = [
        ['Proxies',        msg.proxies],
        ['Shared Flows',   msg.sharedflows],
        ['KVMs',           msg.kvms],
        ['Target Servers', msg.targetServers],
        ['Flow Hooks',     msg.flowHooks],
        ['Developers',     msg.developers],
        ['Apps',           msg.apps],
        ['Products',       msg.products],
      ];
      for (const [label, count] of rows) {
        console.log(`  ${label.padEnd(16)} ${c.bold}${count}${c.reset}`);
      }
      console.log('');

      if (msg.encryptedKvms > 0) {
        console.log(fmt.warn(
          `${msg.encryptedKvms} encrypted KVM(s) detected — values require manual re-entry in Gravitee`
        ));
      }
      if (msg.warnings > 0) {
        console.log(fmt.warn(`${msg.warnings} warning(s) — see manifest.json for details`));
      }
      if (msg.errors > 0) {
        console.log(fmt.err(`${msg.errors} error(s) — see manifest.json for details`));
      } else {
        console.log(fmt.ok('No errors'));
      }
      console.log('');
      console.log(`  Manifest: ${fmt.dim(msg.manifest)}`);
      break;

    default:
      if (verbose) console.log(fmt.dim(JSON.stringify(msg)));
  }
}

// ─── extract command ──────────────────────────────────────────────────────────

function cmdExtract(flags) {
  const dataDir = flags['data-dir'];
  const irDir   = flags['ir-dir'] || './ir';
  const org     = flags['org'] || '';
  const env     = flags['env'] || '';
  const verbose = !!(flags['verbose'] || flags['v']);

  if (!dataDir) {
    console.error(fmt.err('--data-dir is required'));
    process.exit(1);
  }
  if (!fs.existsSync(dataDir)) {
    console.error(fmt.err(`data-dir not found: ${dataDir}`));
    process.exit(2);
  }

  // Locate the Python extractor relative to this file
  const extractorPath = path.join(__dirname, '..', 'src', 'extractor', 'extractor.py');
  if (!fs.existsSync(extractorPath)) {
    console.error(fmt.err(`Extractor not found at: ${extractorPath}`));
    process.exit(2);
  }

  const pyArgs = [
    extractorPath,
    '--data-dir', dataDir,
    '--ir-dir',   irDir,
  ];
  if (org)     pyArgs.push('--org', org);
  if (env)     pyArgs.push('--env', env);
  if (verbose) pyArgs.push('-v');

  console.log(fmt.header('apigee2gravitee — extract'));
  console.log('');
  console.log(`  ${fmt.bold('data-dir')}  ${dataDir}`);
  console.log(`  ${fmt.bold('ir-dir')}    ${irDir}`);
  if (org) console.log(`  ${fmt.bold('org')}       ${org}`);
  if (env) console.log(`  ${fmt.bold('env')}       ${env}`);
  console.log('');

  const python = process.env.PYTHON || 'python3';
  const child = spawn(python, pyArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Buffer stdout lines — extractor emits one JSON object per line
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (line.trim()) handleExtractorLine(line.trim(), verbose);
    }
  });

  // Stderr goes straight through (Python logging output)
  child.stderr.on('data', (chunk) => {
    if (verbose) process.stderr.write(fmt.dim(chunk.toString()));
  });

  child.on('close', (code) => {
    // Flush any remaining buffered line
    if (stdoutBuf.trim()) handleExtractorLine(stdoutBuf.trim(), verbose);

    if (code === 0) {
      // success — nothing extra to print, done handler above covered it
    } else if (code === 1) {
      console.log(fmt.warn('Extraction completed with errors. Review manifest.json before proceeding.'));
    } else {
      console.log(fmt.err(`Extractor exited with code ${code}`));
    }
    process.exit(code);
  });

  child.on('error', (err) => {
    console.error(fmt.err(`Failed to start Python extractor: ${err.message}`));
    console.error(fmt.dim('Ensure python3 is available, or set the PYTHON env variable.'));
    process.exit(2);
  });
}

// ─── help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${fmt.bold('apigee2gravitee')}

${fmt.bold('Usage:')}
  migrator <command> [options]

${fmt.bold('Commands:')}
  extract    Parse apigee-migrate-tool data/ output into the IR

${fmt.bold('extract options:')}
  --data-dir <path>   Path to apigee-migrate-tool data/ directory  (required)
  --ir-dir   <path>   Output directory for IR JSON files           (default: ./ir)
  --org      <name>   Apigee org name (recorded in manifest)
  --env      <name>   Apigee environment name (recorded in manifest)
  -v, --verbose       Enable debug output

${fmt.bold('Examples:')}
  migrator extract --data-dir ./data --ir-dir ./ir
  migrator extract --data-dir ./data --ir-dir ./ir --org advana --env dev -v
`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);
const command = positional[0];

switch (command) {
  case 'extract':
    cmdExtract(flags);
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    console.error(fmt.err(`Unknown command: ${command}`));
    printHelp();
    process.exit(1);
}
