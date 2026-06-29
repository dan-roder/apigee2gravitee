'use strict';

const assert = require('assert');

const { printOperatorHints, printDiscoverTargetHints } = require('../../src/developers');

function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function makeFmt() {
  return {
    info(value) { return value; },
    dim(value) { return value; },
  };
}

function testPrintOperatorHintsShowsResolvedConfigGuidance() {
  const lines = captureLogs(() => {
    printOperatorHints({
      blockers: [
        { code: 'PRODUCT_PLAN_TARGET_IDS_UNRESOLVED' },
      ],
    }, makeFmt());
  });

  assert.ok(lines.some((line) => line.includes('resolve-config-ids')));
  assert.ok(lines.some((line) => line.includes('validate-config-targets')));
  assert.ok(lines.some((line) => line.includes('developers.config.resolved.json')));
}

function testPrintOperatorHintsSkipsWhenNoRelevantBlocker() {
  const lines = captureLogs(() => {
    printOperatorHints({
      blockers: [
        { code: 'SOME_OTHER_BLOCKER' },
      ],
    }, makeFmt());
  });

  assert.deepStrictEqual(lines, []);
}

function testPrintDiscoverTargetHintsShowsValidationNextStep() {
  const lines = captureLogs(() => {
    printDiscoverTargetHints({
      summary: {
        blockers: 1,
      },
    }, makeFmt());
  });

  assert.ok(lines.some((line) => line.includes('validate-config-targets')));
  assert.ok(lines.some((line) => line.includes('Users and applications can still import')));
  assert.ok(lines.some((line) => line.includes('subscriptions will be deferred')));
}

function run() {
  testPrintOperatorHintsShowsResolvedConfigGuidance();
  testPrintOperatorHintsSkipsWhenNoRelevantBlocker();
  testPrintDiscoverTargetHintsShowsValidationNextStep();
  console.log('test-index.js passed');
}

run();
