'use strict';

const { runApisAnalyze } = require('./analyze');
const { runApisPlan } = require('./plan');
const { runApisImport } = require('./import');
const { runApisReconcile } = require('./reconcile');
const { runApisDeleteImported } = require('./delete-imported');

async function runApisCommand(subcommand, flags, fmt) {
  if (subcommand === 'analyze') {
    const result = await runApisAnalyze(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Apis config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Apis analyze'));
    console.log('');
    console.log(`[preflight] ${result.domain.proxies.length} proxies discovered`);
    console.log(`[preflight] ${result.preflight.blockers.length} blocker(s), ${result.preflight.warnings.length} warning(s)`);
    console.log('');
    console.log(`  Plan:       ${fmt.dim(result.outputPaths.plan)}`);
    console.log(`  Gap report: ${fmt.dim(result.outputPaths.gapReport)}`);
    return result.exitCode;
  }

  if (subcommand === 'plan') {
    const result = await runApisPlan(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Apis config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Apis plan'));
    console.log('');
    console.log(`[plan] ${result.manifest.actions.length} actions generated`);
    console.log(`  Plan:       ${fmt.dim(result.outputPaths.plan)}`);
    console.log(`  Gap report: ${fmt.dim(result.outputPaths.gapReport)}`);
    return result.exitCode;
  }

  if (subcommand === 'import') {
    const result = await runApisImport(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Apis config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Apis import'));
    console.log('');
    const statuses = Object.values(result.state.actions).reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    console.log(`[import] ${statuses.SUCCEEDED || 0} succeeded, ${statuses.FAILED || 0} failed, ${statuses.BLOCKED || 0} blocked, ${statuses.MANUAL_REVIEW || 0} manual review`);
    console.log(`  State:      ${fmt.dim(result.outputPaths.state)}`);
    console.log(`  Id map:     ${fmt.dim(result.outputPaths.idMap)}`);
    return result.exitCode;
  }

  if (subcommand === 'reconcile') {
    const result = await runApisReconcile(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Apis config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Apis reconcile'));
    console.log('');
    console.log(`[reconcile] ${result.report.summary.checkedApis} apis checked`);
    console.log(`[reconcile] ${result.report.summary.blockers} blocker(s), ${result.report.summary.warnings} warning(s)`);
    console.log(`  Report:     ${fmt.dim(result.outputPaths.reconcileReport)}`);
    return result.exitCode;
  }

  if (subcommand === 'delete-imported') {
    const result = await runApisDeleteImported(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Apis config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Apis delete-imported'));
    console.log('');
    console.log(`[cleanup] ${result.cleanup.summary.deleted} deleted, ${result.cleanup.summary.skipped} skipped, ${result.cleanup.summary.failed} failed`);
    if (result.cleanup.failures.length > 0) {
      console.log('');
      console.log('  Failures:');
      for (const failure of result.cleanup.failures.slice(0, 10)) {
        console.log(`   - ${failure.proxyName}: ${failure.error}`);
      }
    }
    console.log(`  Id map:     ${fmt.dim(result.outputPaths.idMap)}`);
    console.log(`  Report:     ${fmt.dim(result.outputPaths.cleanupReport)}`);
    console.log(`  Log:        ${fmt.dim(result.outputPaths.log)}`);
    return result.exitCode;
  }

  console.log(fmt.err(`Unknown apis subcommand: ${subcommand || '<none>'}`));
  return 1;
}

module.exports = { runApisCommand };
