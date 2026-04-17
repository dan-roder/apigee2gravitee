'use strict';

const { runDevelopersAnalyze } = require('./analyze');
const { runDevelopersPlan } = require('./plan');
const { runDevelopersImport } = require('./import');
const { runDevelopersReconcile } = require('./reconcile');
const { runDevelopersDeleteImported } = require('./delete-imported');
const { runResolveDevelopersConfigIds } = require('./resolve-config-ids');
const { runValidateDevelopersConfigTargets } = require('./validate-config-targets');
const { runConfigureDevelopersRoles } = require('./configure-roles');
const { runSyncDevelopersApiTargets } = require('./sync-api-targets');
const { runDiscoverDevelopersTargets } = require('./discover-targets');

function printFindings(findings, fmt, label) {
  if (findings.length === 0) return;
  for (const finding of findings) {
    const printer = finding.severity === 'blocker' ? fmt.err : fmt.warn;
    console.log(printer(`${label} ${finding.code}: ${finding.message}`));
  }
}

function printObjectCounts(counts, fmt, prefix) {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) return;
  for (const [key, value] of entries) {
    console.log(`${prefix} ${key}: ${fmt.dim(String(value))}`);
  }
}

function hasFinding(findings, code) {
  return (findings || []).some((item) => item.code === code);
}

function printOperatorHints(preflight, fmt) {
  if (!preflight) return;

  if (hasFinding(preflight.blockers, 'PRODUCT_PLAN_TARGET_IDS_UNRESOLVED')) {
    console.log('');
    console.log(fmt.info('Resolve placeholder target ids before retrying this command:'));
    console.log(`  ${fmt.dim('1. node bin/migrator.js developers resolve-config-ids --config ./config/developers.config.json --gravitee-token "$GRAVITEE_TOKEN"')}`);
    console.log(`  ${fmt.dim('2. node bin/migrator.js developers validate-config-targets --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"')}`);
    console.log(`  ${fmt.dim('3. rerun this command with --config ./config/developers.config.resolved.json')}`);
  }
}

function printValidateTargetHints(report, fmt) {
  if (!report?.findings?.length) return;
  if (report.apisIdMapPresent === false) {
    console.log('');
    console.log(fmt.info('No apis-id-map.json was found for this developers config; use manual target discovery first:'));
    console.log(`  ${fmt.dim('1. node bin/migrator.js developers discover-targets --ir-dir ./ir --config ./config/developers.config.resolved.json')}`);
    console.log(`  ${fmt.dim('2. node bin/migrator.js developers validate-config-targets --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"')}`);
    console.log(`  ${fmt.dim('3. rerun analyze/import after target validation is clean')}`);
    return;
  }
  const hasStaleIds = report.findings.some((item) => (
    item.code === 'TARGET_API_ID_NOT_FOUND'
    || item.code === 'TARGET_PLAN_ID_NOT_FOUND'
    || item.code === 'TARGET_PLAN_NAME_MISMATCH'
  ));
  if (!hasStaleIds) return;

  console.log('');
  console.log(fmt.info('Target ids may be stale after an API cleanup/reimport cycle:'));
  console.log(`  ${fmt.dim('1. node bin/migrator.js developers sync-api-targets --config ./config/developers.config.resolved.json')}`);
  console.log(`  ${fmt.dim('2. node bin/migrator.js developers validate-config-targets --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"')}`);
  console.log(`  ${fmt.dim('3. rerun analyze/import with the refreshed resolved config')}`);
}

async function runDevelopersCommand(subcommand, flags, fmt) {
  if (subcommand === 'configure-roles') {
    const result = await runConfigureDevelopersRoles(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return 1;
    }
    if (result.error) {
      console.log(fmt.err(result.error));
      return result.exitCode;
    }

    console.log(fmt.header('Developers configure-roles'));
    console.log('');
    console.log(`[roles] organization default: ${result.selections.organization.scopedName}`);
    console.log(`[roles] environment default: ${result.selections.environment.scopedName}`);
    console.log('');
    console.log(`  Output:     ${fmt.dim(result.outputPath)}`);
    return result.exitCode;
  }

  if (subcommand === 'resolve-config-ids') {
    const result = await runResolveDevelopersConfigIds(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return 1;
    }
    if (result.error) {
      console.log(fmt.err(result.error));
      return result.exitCode;
    }

    console.log(fmt.header('Developers resolve-config-ids'));
    console.log('');
    console.log(`[resolve] ${result.summary.products} products, ${result.summary.targets} target mapping(s) checked`);
    console.log(`[resolve] ${result.summary.apiIdsResolved} API id(s) resolved, ${result.summary.planIdsResolved} plan id(s) resolved, ${result.summary.unresolved} unresolved mapping(s)`);
    if (result.findings.length > 0) {
      console.log('');
      console.log('  Unresolved targets:');
      for (const finding of result.findings) {
        console.log(`   - ${finding.productName}[${finding.targetIndex}] ${finding.targetApi} / ${finding.targetPlan}`);
        for (const issue of finding.issues) {
          console.log(`     ${fmt.dim(issue)}`);
        }
      }
    }
    console.log('');
    console.log(`  Output:     ${fmt.dim(result.outputPath)}`);
    return result.exitCode;
  }

  if (subcommand === 'sync-api-targets') {
    const result = await runSyncDevelopersApiTargets(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return 1;
    }
    if (result.error) {
      console.log(fmt.err(result.error));
      return result.exitCode;
    }

    console.log(fmt.header('Developers sync-api-targets'));
    console.log('');
    console.log(`[sync] ${result.summary.products} products, ${result.summary.targets} target mapping(s) checked`);
    console.log(`[sync] ${result.summary.apiIdsUpdated} API id(s) updated, ${result.summary.planIdsUpdated} plan id(s) updated, ${result.summary.warnings} warning set(s)`);
    if (result.findings.length > 0) {
      console.log('');
      console.log('  Warnings:');
      for (const finding of result.findings) {
        console.log(`   - ${finding.productName}[${finding.targetIndex}] ${finding.targetApi} / ${finding.targetPlan}`);
        for (const issue of finding.issues) {
          console.log(`     ${fmt.dim(issue)}`);
        }
      }
    }
    console.log('');
    console.log(`  API id map:  ${fmt.dim(result.apisIdMapPath)}`);
    console.log(`  Output:      ${fmt.dim(result.outputPath)}`);
    console.log(`  Report:      ${fmt.dim(result.reportPath)}`);
    return result.exitCode;
  }

  if (subcommand === 'discover-targets') {
    const result = await runDiscoverDevelopersTargets(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return 1;
    }
    if (result.error) {
      console.log(fmt.err(result.error));
      return result.exitCode;
    }

    console.log(fmt.header('Developers discover-targets'));
    console.log('');
    console.log(`[discover] ${result.report.summary.products} products scanned`);
    console.log(`[discover] ${result.report.summary.productsWithSingleValidTarget.length} exact match, ${result.report.summary.productsNeedingSelection.length} need selection, ${result.report.summary.blockedProducts.length} blocked`);
    if (result.report.findings.length > 0) {
      console.log('');
      console.log('  Findings:');
      for (const finding of result.report.findings.slice(0, 10)) {
        const printer = finding.severity === 'blocker' ? fmt.err : fmt.warn;
        console.log(printer(`${finding.code}: ${finding.productName} ${finding.message}`));
      }
    }
    console.log('');
    console.log(`  Report:      ${fmt.dim(result.reportPath)}`);
    if (result.outputPath) {
      console.log(`  Output:      ${fmt.dim(result.outputPath)}`);
    }
    return result.exitCode;
  }

  if (subcommand === 'validate-config-targets') {
    const result = await runValidateDevelopersConfigTargets(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return 1;
    }
    if (result.error) {
      console.log(fmt.err(result.error));
      return result.exitCode;
    }

    console.log(fmt.header('Developers validate-config-targets'));
    console.log('');
    console.log(`[validate] ${result.report.summary.products} products, ${result.report.summary.targets} target mapping(s) checked`);
    console.log(`[validate] ${result.report.summary.validTargets} valid, ${result.report.summary.blockers} blocker(s), ${result.report.summary.warnings} warning(s)`);
    if (result.report.findings.length > 0) {
      console.log('');
      console.log('  Findings:');
      for (const finding of result.report.findings.slice(0, 10)) {
        const printer = finding.severity === 'blocker' ? fmt.err : fmt.warn;
        console.log(printer(`${finding.code}: ${finding.productName}[${finding.targetIndex}] ${finding.message}`));
      }
    }
    printValidateTargetHints(result.report, fmt);
    console.log('');
    console.log(`  Report:     ${fmt.dim(result.outputPath)}`);
    return result.exitCode;
  }

  if (subcommand === 'plan') {
    const result = await runDevelopersPlan(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }

    if (flags.json) {
      console.log(JSON.stringify(result.manifest, null, 2));
    } else {
      console.log(fmt.header('Developers plan'));
      console.log('');
      console.log(`[plan] ${result.manifest.actions.length} actions generated`);
      console.log(`[plan] ${result.manifest.summary.actionsByStatus.READY || 0} ready, ${result.manifest.summary.actionsByStatus.BLOCKED || 0} blocked, ${result.manifest.summary.actionsByStatus.SKIPPED || 0} skipped, ${result.manifest.summary.manualReview || 0} manual review`);
      const nextScope = result.gapReport?.operatorGuidance?.nextSuggestedScope;
      if (nextScope) console.log(`[plan] next suggested scope: ${nextScope}`);
      printOperatorHints(result.preflight, fmt);
      console.log('');
      console.log('  Action summary:');
      printObjectCounts(result.manifest.summary.operatorActions?.byOperation, fmt, '   -');
      console.log('');
      console.log(`  Plan:       ${fmt.dim(result.outputPaths.plan)}`);
      console.log(`  Gap report: ${fmt.dim(result.outputPaths.gapReport)}`);
      console.log(`  State:      ${fmt.dim(result.outputPaths.state)}`);
      console.log(`  Id map:     ${fmt.dim(result.outputPaths.idMap)}`);
      console.log(`  Log:        ${fmt.dim(result.outputPaths.log)}`);
    }
    return result.exitCode;
  }

  if (subcommand === 'analyze') {
    const result = await runDevelopersAnalyze(flags);

    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }

    console.log(fmt.header('Developers analyze'));
    console.log('');
    console.log(`[preflight] ${result.domain.users.length} developers, ${result.domain.applications.length} apps, ${result.domain.subscriptions.length} subscriptions discovered`);
    console.log(`[preflight] ${result.preflight.blockers.length} blocker(s), ${result.preflight.warnings.length} warning(s), ${result.gapReport.summary.manualReview || 0} manual review item(s)`);
    printFindings(result.preflight.blockers, fmt, '[blocker]');
    printFindings(result.preflight.warnings, fmt, '[warn]');
    const nextScope = result.gapReport?.operatorGuidance?.nextSuggestedScope;
    if (nextScope) console.log(fmt.info(`Next suggested pilot scope: ${nextScope}`));
    printOperatorHints(result.preflight, fmt);
    console.log(`  Resume safe: ${fmt.dim(result.gapReport?.operatorGuidance?.resumeSafe ? 'yes' : 'no')}`);
    console.log('');
    console.log(`  Plan:       ${fmt.dim(result.outputPaths.plan)}`);
    console.log(`  Gap report: ${fmt.dim(result.outputPaths.gapReport)}`);
    console.log(`  State:      ${fmt.dim(result.outputPaths.state)}`);
    console.log(`  Id map:     ${fmt.dim(result.outputPaths.idMap)}`);
    console.log(`  Log:        ${fmt.dim(result.outputPaths.log)}`);
    return result.exitCode;
  }

  if (subcommand === 'import') {
    const result = await runDevelopersImport(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Developers import'));
    console.log('');
    const statuses = Object.values(result.state.actions).reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    console.log(`[import] ${statuses.SUCCEEDED || 0} succeeded, ${statuses.FAILED || 0} failed, ${statuses.BLOCKED || 0} blocked, ${statuses.SKIPPED || 0} skipped, ${statuses.MANUAL_REVIEW || 0} manual review`);
    console.log('');
    console.log('  Planned operations:');
    printObjectCounts(result.manifest.summary.operatorActions?.byOperation, fmt, '   -');
    if ((result.preflight.blockers || []).length > 0) {
      console.log('');
      console.log('  Blocking categories:');
      printObjectCounts(result.gapReport?.operatorGuidance?.blockerCategories, fmt, '   -');
    }
    printOperatorHints(result.preflight, fmt);
    console.log('');
    console.log(`  Plan:       ${fmt.dim(result.outputPaths.plan)}`);
    console.log(`  State:      ${fmt.dim(result.outputPaths.state)}`);
    console.log(`  Id map:     ${fmt.dim(result.outputPaths.idMap)}`);
    console.log(`  Log:        ${fmt.dim(result.outputPaths.log)}`);
    return result.exitCode;
  }

  if (subcommand === 'reconcile') {
    const result = await runDevelopersReconcile(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Developers reconcile'));
    console.log('');
    console.log(`[reconcile] ${result.report.summary.checkedUsers} users, ${result.report.summary.checkedApplications} apps, ${result.report.summary.checkedSubscriptions} subscriptions checked`);
    console.log(`[reconcile] ${result.report.summary.blockers} blocker(s), ${result.report.summary.warnings} warning(s)`);
    if (result.report.mismatches.length > 0) {
      console.log('');
      console.log('  Top mismatches:');
      for (const mismatch of result.report.mismatches.slice(0, 5)) {
        console.log(`   - ${mismatch.code}: ${mismatch.sourceId}`);
      }
    }
    printOperatorHints(result.preflight, fmt);
    console.log('');
    console.log(`  Report:     ${fmt.dim(result.outputPaths.reconcileReport)}`);
    console.log(`  Log:        ${fmt.dim(result.outputPaths.log)}`);
    return result.exitCode;
  }

  if (subcommand === 'delete-imported') {
    const result = await runDevelopersDeleteImported(flags);
    if (result.validationErrors) {
      console.log(fmt.err('Developers config validation failed'));
      for (const err of result.validationErrors) console.log(`  - ${err}`);
      return result.exitCode;
    }
    console.log(fmt.header('Developers delete-imported'));
    console.log('');
    console.log(`[cleanup] ${result.cleanup.summary.deleted} deleted, ${result.cleanup.summary.skipped} skipped, ${result.cleanup.summary.failed} failed`);
    if (result.cleanup.failures.length > 0) {
      console.log('');
      console.log('  Failures:');
      for (const failure of result.cleanup.failures.slice(0, 5)) {
        console.log(fmt.err(`${failure.sourceId}: ${failure.error}`));
      }
    }
    console.log('');
    console.log(`  State:      ${fmt.dim(result.outputPaths.state)}`);
    console.log(`  Id map:     ${fmt.dim(result.outputPaths.idMap)}`);
    console.log(`  Report:     ${fmt.dim(result.outputPaths.cleanupReport)}`);
    console.log(`  Log:        ${fmt.dim(result.outputPaths.log)}`);
    return result.exitCode;
  }

  console.log(fmt.err(`Unknown developers subcommand: ${subcommand || '<none>'}`));
  return 1;
}

module.exports = { runDevelopersCommand, printOperatorHints };
