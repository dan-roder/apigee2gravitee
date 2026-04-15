# TODOs

## 1. Production-like Gravitee Validation

- Validate the full `apis` and `developers` workflow against a non-local Gravitee environment.
- Confirm role selection, API/plan resolution, import, reconcile, and cleanup behavior on that deployment.
- Capture any endpoint or payload differences from local Gravitee and fold them back into the compatibility layer.

## 2. OAuth And Secret Continuity Hardening

- Done: only raise OAuth continuity warnings when the extracted credentials actually suggest OAuth continuity matters.
- Done: added separate `oauthClientContinuity` policy handling so OAuth continuity can warn or block independently from API-key continuity.
- Done: expanded operator-facing continuity reporting with consumer-secret counts, protected-secret-material counts, and missing-secret counts in the developers gap report.
- Done: added preflight handling for OAuth-relevant credentials whose protected secret material is missing from the IR.
- Done: OAuth-relevant credentials with protected secret material now surface explicit manual-review findings, and they become blockers when exact OAuth continuity is required.
- Done: gap reporting now distinguishes API-key continuity risks from OAuth client continuity risks in mixed datasets.

## 3. Edge-case Migration Coverage

- Done: added fixture-backed tests for:
  - inactive developers that still own apps under `import-disabled`
  - reuse of pre-existing Gravitee users/apps/subscriptions
  - multi-target product mappings during live-style plan/import/reconcile flows
  - ambiguous ownership/source-marker reuse scenarios
  - repeated cleanup/import/reconcile cycles
- Keep expanding coverage for additional production-like edge cases:
  - inactive developers under revoke-style target behavior
  - ambiguous ownership or membership scenarios across multiple candidate applications
  - reuse against partially drifted target resources
  - mixed API-key and OAuth credential datasets

## 4. API-to-Developers Config Sync Automation

- Done: added `developers sync-api-targets` to refresh `productPlanMap` from `state/apis-id-map.json`.
- Reduce manual developers config drift after API cleanup/recreate operations further, especially around resolved outputs and operator guidance.
- Prefer deterministic refresh commands over hand-editing resolved config files.
