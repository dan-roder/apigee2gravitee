# TODOs

## 1. Production-like Gravitee Validation

- Validate the full `apis` and `developers` workflow against a non-local Gravitee environment.
- Confirm role selection, API/plan resolution, import, reconcile, and cleanup behavior on that deployment.
- Capture any endpoint or payload differences from local Gravitee and fold them back into the compatibility layer.

## 2. OAuth And Secret Continuity Hardening

- Only raise OAuth continuity warnings when the extracted credentials actually suggest OAuth continuity matters.
- Expand continuity reporting to distinguish API-key continuity from OAuth client continuity.
- Add stronger handling for secret-presence and continuity review cases where extracted credentials include protected-secret metadata.

## 3. Edge-case Migration Coverage

- Add and keep expanding fixture-backed tests for:
  - inactive developers that still own apps
  - reuse of pre-existing Gravitee users/apps/subscriptions
  - multi-target product mappings during live-style plan/import/reconcile flows
  - ambiguous ownership or membership scenarios
  - repeated cleanup/import/reconcile cycles

## 4. API-to-Developers Config Sync Automation

- Keep `productPlanMap` synchronized with `state/apis-id-map.json` after API import or reimport cycles.
- Reduce manual developers config drift after API cleanup/recreate operations.
- Prefer deterministic refresh commands over hand-editing resolved config files.
