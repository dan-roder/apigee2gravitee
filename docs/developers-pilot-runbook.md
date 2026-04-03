# Developers Migration Pilot Runbook

Use this runbook for the first controlled non-production pilot of the developers migration tool.

## Goal

Prove that the target Gravitee deployment supports:

- user provisioning and role assignment
- application creation or reuse with source markers
- subscription creation or reuse against the intended API/plan
- reconciliation with zero blocking mismatches for the pilot set

## Prerequisites

- Tool 1 extraction has produced `./ir`
- target Gravitee APIs and plans already exist
- `productPlanMap` is complete for the pilot products
- a non-production Gravitee token is available in `GRAVITEE_TOKEN`
- `config/developers.config.json` points to the non-production organization and environment

## Build A Pilot Dataset

Start with the smallest realistic slice:

- 1 existing developer that should be reused if possible
- 1 new developer that should be created
- 1 application with a single product approval
- 1 application with multiple product approvals if available
- 1 inactive developer if inactive-policy handling is in scope for the pilot

Use `filters.includeDevelopers` and `filters.includeApps` in `config/developers.config.json` to limit the run.

## Run Sequence

### 1. Analyze

```bash
node bin/migrator.js developers analyze \
  --ir-dir ./ir \
  --config ./config/developers.config.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

Expected result:

- no blocking probe failures
- no missing product-plan mappings
- warnings or manual-review items understood and accepted before moving on

Check:

- `report/developers-gap-report.json`
- `report/developers-plan.json`

### 2. Plan

```bash
node bin/migrator.js developers plan \
  --ir-dir ./ir \
  --config ./config/developers.config.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

Expected result:

- the manifest shows the expected mix of `CREATE`, `REUSE`, `UPDATE`, `SKIP`, or `BLOCK`
- the next suggested scope is `--users-only` for the first import pass

### 3. Import Users

```bash
node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --users-only \
  --resume
```

Expected result:

- users are created or reused deterministically
- organization and environment roles are present after import

### 4. Import Applications

```bash
node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --apps-only \
  --resume
```

Expected result:

- applications are created or reused deterministically
- source markers are present on migrated applications
- ownership behavior matches `applicationOwnership`

### 5. Import Subscriptions

```bash
node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --subscriptions-only \
  --resume
```

Expected result:

- subscriptions resolve to the intended API and plan
- continuity policy behavior matches expectations

### 6. Reconcile

```bash
node bin/migrator.js developers reconcile \
  --ir-dir ./ir \
  --config ./config/developers.config.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

Expected result:

- zero blocking mismatches for the pilot set

## How To Read The Artifacts

### `report/developers-gap-report.json`

Focus on:

- `summary.blockers`
- `summary.manualReview`
- `operatorGuidance.nextSuggestedScope`
- `operatorGuidance.blockerCategories`
- `manualReviewFindings`

Do not begin import until blockers are zero and every manual-review item has an explicit operator decision.

### `report/developers-reconcile-report.json`

Focus on:

- `summary.blockers`
- each mismatch `code`
- each mismatch `sourceId`

Treat any mismatch in user roles, source markers, API/plan binding, or continuity as a stop condition for widening the pilot.

## Go / No-Go Checklist

Broader rollout is allowed only when all of the following are true:

- all required product-plan mappings are present
- live probes are clean for required behaviors
- user-only import succeeds
- app-only import succeeds
- subscription-only import succeeds
- reconcile returns zero blocking mismatches for the pilot set

If any check fails, keep the pilot narrow and fix the mismatch before expanding filters.
