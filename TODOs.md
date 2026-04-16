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
  - partially drifted target resources detected during reconcile
  - mixed API-key and OAuth credential datasets in analyze/gap reporting
- Keep expanding coverage for additional production-like edge cases:
  - inactive developers under revoke-style target behavior
  - ambiguous ownership or membership scenarios across multiple candidate applications
  - reuse against partially drifted target resources
  - mixed API-key and OAuth credential datasets during import/reconcile, not just analyze

## 4. API-to-Developers Config Sync Automation

- Done: added `developers sync-api-targets` to refresh `productPlanMap` from `state/apis-id-map.json`.
- Done: added sync reporting and CLI guidance so stale API/plan ids now point operators back to `developers sync-api-targets`.
- Done: made `developers sync-api-targets` refresh the stable resolved-config path by default, so operators can keep using `developers.config.resolved.json` instead of hand-editing or chasing extra synced files.
