# Codex Context: Apigee → Gravitee Users/Developers Migration Tool

## Purpose

Build a new **Users/Developers migration tool** for an Apigee → Gravitee migration project.

This tool is specifically for migrating the **developer ecosystem**, not proxies or shared flows.

It should migrate:

- **Apigee Developers** → **Gravitee Users**
- **Apigee Developer Apps** → **Gravitee Applications**
- **Apigee Product approvals on app credentials** → **Gravitee Subscriptions**
- **Relevant credential continuity data** → Gravitee app/subscription configuration where possible

Assume the **current repo does not already contain a scaffold** for this tool. Build from scratch in a way that cleanly fits into the repo.

---

## Critical domain assumption

This is **not** a simple one-to-one field mapping problem.

The most important conceptual mismatch is:

- In **Apigee**, a developer is mostly a passive ownership record.
- In **Gravitee**, the equivalent is a real **User** with roles, lifecycle behavior, and side effects.

That means the tool must explicitly deal with:

- role assignment
- possible registration / invitation email behavior
- ownership preservation between user and application
- custom field mapping
- inactive developer handling
- idempotency and safe re-runs

---

## What this tool is responsible for

### In scope

- Read extracted IR for developers, apps, and products
- Analyze migration readiness
- Build a migration plan
- Import users into Gravitee
- Import applications into Gravitee
- Create subscriptions for application/product relationships
- Preserve ownership linkage using developer email
- Preserve OAuth client ID continuity where required
- Evaluate API key continuity risk
- Produce reports, state, and reconciliation output
- Support dry-run / analysis / plan / import / reconcile workflows

### Out of scope

- Proxy translation
- API definition translation
- Shared flow / policy migration
- Identity provider or Gravitee AM implementation
- Password migration
- Full OAuth token migration
- General Gravitee bootstrap beyond what this tool must validate

---

## Dependency position in the overall migration

This tool is expected to run **after** the target APIs and plans exist, or at minimum after there is enough target metadata to resolve plan targets.

Recommended overall ordering:

1. Extract Apigee data to IR
2. Bootstrap / validate Gravitee target environment
3. Create APIs / plans in Gravitee
4. Run this developer ecosystem migration tool
5. Reconcile and verify

For this tool specifically, the internal import order must be:

1. User
2. Application
3. Plan resolution
4. Subscription
5. Post-import verification

---

## Main design recommendation

Build this as a **manifest-driven importer**, not a thin direct API script.

That means:

- first analyze and normalize source records
- then generate explicit actions
- then execute those actions in dependency order
- always persist state as actions complete
- always emit reports for what was created, skipped, failed, or needs manual review

This makes the tool safer for bulk migrations and easier to resume after partial failure.

---

## Assumed source inputs

The tool should read IR produced by earlier extraction steps.

Assume an input structure like:

```text
ir/
  developers/
    {email}.json
  apps/
    {email}/
      {appName}.json
  products/
    {productName}.json
  manifest.json
```

The implementation should not hardcode too many assumptions beyond that. Keep the loaders modular so field mapping can be adjusted once the actual extractor output is confirmed.

---

## Required outputs

The tool should produce both machine-readable and human-readable outputs.

### Machine-readable

- migration plan JSON
- gap / risk report JSON
- import state JSON
- id mapping JSON
- structured log stream (NDJSON preferred)

### Human-readable

- summary text report
- readable gap / risk report (Markdown or HTML)

Suggested directories:

```text
report/
state/
logs/
```

---

## Core execution modes

The tool should support four main modes:

### `analyze`
Read source IR, validate readiness, classify risks, write reports, no writes to Gravitee.

### `plan`
Produce explicit intended actions and payload previews, no writes.

### `import`
Execute the migration with state persistence and idempotent behavior.

### `reconcile`
Compare target Gravitee state against source IR and recorded state.

---

## CLI contract

Use a command surface shaped like this:

```bash
node bin/migrator.js developers analyze [options]
node bin/migrator.js developers plan [options]
node bin/migrator.js developers import [options]
node bin/migrator.js developers reconcile [options]
```

### Global flags

```text
--ir-dir <path>
--config <path>
--gravitee-url <url>
--gravitee-token <token>
--org <orgId>
--env <envId>
--state-file <path>
--report-dir <path>
--include <csv|glob>
--exclude <csv|glob>
--strict
--resume
--force
-v, --verbose
--json
```

### Policy flags

```text
--inactive-policy skip|import-disabled|import-and-revoke
--smtp-policy acknowledged|suppressed|live
--default-app-policy must-be-disabled|allowed
--api-key-policy preserve-if-supported|accept-regenerated|fail-if-not-preservable
--existing-user-policy match-and-reuse|match-and-update|fail-on-existing
--existing-app-policy match-and-reuse|match-and-update|fail-on-existing
```

### Scope flags

```text
--users-only
--apps-only
--subscriptions-only
--dry-run
--max-errors <n>
--fail-on-warning
```

---

## Recommended repo structure

Create a module layout like this:

```text
bin/
  migrator.js

src/
  developers/
    preflight-validator.js
    developer-loader.js
    user-mapper.js
    app-mapper.js
    subscription-mapper.js
    user-importer.js
    application-importer.js
    subscription-importer.js
    reconcile.js
    state-store.js
    report-builder.js

  shared/
    gravitee-client.js
    ir-loader.js
    logger.js
    errors.js

config/
  developers.config.example.json
  developers.config.schema.json

docs/
  developers-migration.md
```

Keep the Gravitee adapter isolated so the mapping and orchestration logic can be tested without making live API calls.

---

## High-level architecture

### 1. Loader layer

Responsibility:
- load IR files
- normalize file discovery
- return in-memory domain objects

Key design note:
- keep file loading separate from mapping logic
- support partial filters like include/exclude developer subsets

### 2. Mapper layer

Responsibility:
- convert source IR into normalized migration models
- identify risk flags and decisions
- avoid direct network calls

Suggested normalized models:

- `MigratedUser`
- `MigratedApplication`
- `MigratedSubscription`

### 3. Importer layer

Responsibility:
- execute create / match / update steps against Gravitee
- persist state after each successful action
- enforce dependency order

### 4. Reconciliation layer

Responsibility:
- verify target state after import
- check continuity constraints
- surface mismatches clearly

### 5. Reporting layer

Responsibility:
- summarize counts, skips, warnings, failures
- produce JSON and readable reports

---

## Mapping rules

### Developer → User

Expected source concepts:

- email
- firstName
- lastName
- userName or display name equivalent
- attributes[]
- status

Target expectations:

- `email` is the primary external identity key
- names map directly where possible
- developer attributes only become Gravitee custom fields if those fields already exist
- inactive status does **not** have a one-to-one target equivalent and must be handled by policy

### App → Application

Expected source concepts:

- app name
- owning developer email
- attributes / metadata
- one or more credentials

Target expectations:

- application name should be preserved
- ownership should be preserved by carrying `developer_email`
- metadata should be preserved where practical
- OAuth-oriented client IDs should be preserved exactly when required

### Approved product relationship → Subscription

Important rule:

A single Apigee app credential can be associated with **multiple products**.

That means one source credential can produce **multiple Gravitee subscriptions**.

Do **not** incorrectly treat a multi-product credential as one subscription.

---

## Policy decisions that must be configurable

These should not be buried in code. They need to be explicit.

### Inactive developer policy

Supported values:

- `skip`
- `import-disabled`
- `import-and-revoke`

### SMTP policy

Supported values:

- `acknowledged`
- `suppressed`
- `live`

### Default application policy

Supported values:

- `must-be-disabled`
- `allowed`

### API key continuity policy

Supported values:

- `preserve-if-supported`
- `accept-regenerated`
- `fail-if-not-preservable`

### Existing entity policy

Supported values:

- `match-and-reuse`
- `match-and-update`
- `fail-on-existing`

---

## Non-negotiable behaviors

These should be treated as hard requirements.

1. **Never create users without explicit role assignment.**
2. **Never silently drop unmapped custom attributes.** Log them.
3. **Never run live import without explicit SMTP/default-app policy acknowledgment.**
4. **Never allow OAuth client ID drift when continuity is required.**
5. **Never collapse multi-product credentials into a single subscription.**
6. **Never rely on one-shot import behavior.** Safe re-runs are required.

---

## Idempotency requirements

This tool must be resumable and safe to re-run.

### User matching
- match primarily by email

### Application matching
- match by owner + name where possible
- optionally attach a deterministic external marker if needed

### Subscription matching
- match by application + API + plan

### State persistence
- write to state file after every successful create/update
- support `--resume`
- support `--force` when intentional overwrite/replay is needed

Suggested state file path:

```text
state/developers-import-state.json
```

---

## Preflight requirements

Before live import, the tool should validate at least the following:

1. IR exists and is readable
2. Gravitee endpoint is reachable
3. authentication works
4. org and env are valid
5. target plans are resolvable for all needed subscriptions
6. required custom fields exist or gaps are reported
7. SMTP policy is explicitly set
8. default app behavior is explicitly acknowledged
9. role configuration exists

Preflight should be reusable across `analyze`, `plan`, and `import`.

---

## Failure model

### Hard failures
Should stop the run when configured or when critical:

- missing IR
- authentication failure
- invalid config
- unresolved required plan
- required role assignment failure
- client ID mismatch when continuity is required
- key continuity violation when policy says to fail

### Soft failures / warnings
Should be logged and included in reports:

- optional custom field missing
- skipped inactive developers
- metadata write issues
- subscription skipped due to source status

### Exit codes
Recommended:

```text
0  success
1  usage/config error
2  preflight failed
3  analyze found blocking issues
4  import partially succeeded
5  import failed
6  reconcile mismatch found
```

---

## Config file shape

Create a config file like:

```json
{
  "gravitee": {
    "url": "https://gravitee.example.com",
    "orgId": "DEFAULT",
    "envId": "DEFAULT"
  },
  "roles": {
    "organization": ["ORGANIZATION:USER"],
    "environment": ["ENVIRONMENT:API_CONSUMER"]
  },
  "policies": {
    "inactiveDeveloper": "import-and-revoke",
    "smtp": "acknowledged",
    "defaultApplication": "must-be-disabled",
    "apiKeyContinuity": "preserve-if-supported",
    "existingUser": "match-and-reuse",
    "existingApplication": "match-and-reuse"
  },
  "customFieldMap": {
    "team": "team",
    "department": "department",
    "contact": "contact"
  },
  "filters": {
    "includeDevelopers": [],
    "excludeDevelopers": [],
    "includeApps": [],
    "excludeApps": []
  },
  "reporting": {
    "reportDir": "./report",
    "stateFile": "./state/developers-import-state.json"
  }
}
```

Also add a JSON schema for validation.

---

## Gravitee client design guidance

Create a dedicated adapter like:

```text
src/shared/gravitee-client.js
```

Responsibilities:

- auth header construction
- GET/POST/PATCH wrappers
- user lookup/create/update
- application lookup/create/update
- plan lookup
- subscription lookup/create
- optional post-create verification helpers

Do not spread HTTP calls throughout the codebase.

The rest of the tool should depend on a client interface, not direct fetch calls.

---

## Recommended implementation sequence

Build in this order:

1. CLI skeleton
2. config loading + schema validation
3. IR loading
4. preflight validator
5. normalized models and mappers
6. `developers analyze`
7. `developers plan`
8. user importer
9. application importer
10. subscription importer
11. state persistence / resume logic
12. `developers reconcile`
13. improved reporting and structured logs

This sequence gets a safe vertical slice working before live import complexity grows.

---

## Suggested stdout contract

Human-readable mode should emit concise progress like:

```text
[preflight] 148 developers, 221 apps, 412 product associations discovered
[preflight] 6 inactive developers
[preflight] 14 custom attributes missing matching Gravitee custom fields
[preflight] 23 OAuth client_id continuity cases
[plan]      142 users to create, 6 users to skip
[plan]      221 applications to create
[plan]      399 subscriptions to create, 13 to skip
[import]    created user jane@example.com -> usr_123
[import]    created application jane@example.com/MobileApp -> app_456
[import]    created subscription MobileApp -> PaymentsPlan -> sub_789
[warn]      custom field dropped: department for jane@example.com
[error]     client_id mismatch for app MobileApp
```

If `--json` is supplied, emit structured JSON/NDJSON events instead.

---

## Reconciliation expectations

The reconcile mode should verify:

- every expected user exists
- required roles are present
- each application belongs to the expected developer
- each expected subscription exists
- subscription target plan/API mapping is correct
- OAuth client ID continuity is preserved where required
- inactive developer handling matches the chosen policy

Reconcile should return a non-zero exit code if mismatches are found.

---

## Practical risks to explicitly design around

### 1. Registration / invitation email side effects
Creating users may trigger user-facing emails. This must be acknowledged and controlled.

### 2. Inactive developer mismatch
Apigee inactive developers do not cleanly map to a Gravitee user lifecycle state.

### 3. Unmapped custom attributes
If Gravitee custom fields are not pre-created, source metadata can be lost.

### 4. API key continuity
Some migrations may require preserving exact key values; if Gravitee cannot support that in the target setup, the tool must surface the risk clearly.

### 5. OAuth client ID continuity
This should be treated as a high-importance validation case.

---

## What Codex should build first

If continuing from scratch, the best immediate next step is:

1. add the command parser in `bin/migrator.js`
2. add `developers analyze`
3. add config schema + runtime validation
4. add IR loading
5. add mapper stubs and normalized models
6. add preflight checks with report output

Only after that should live import calls be wired.

---

## Acceptance criteria for the first meaningful milestone

A good first milestone is complete when:

- `developers analyze` runs end-to-end
- it loads IR successfully
- it validates config
- it validates target connectivity
- it produces a gap/risk report
- it emits a machine-readable plan skeleton
- it does not require live import to prove progress

---

## Final instruction to Codex

Please implement this as a **clean, testable, modular addition** to the repo, assuming there is **no existing scaffold** for the developers migration tool.

Prefer:

- small focused modules
- explicit config and policies
- safe defaults
- resumable stateful import design
- separation of mapping logic from transport logic
- strong logging and reporting

Avoid:

- hardcoded business decisions
- hidden side effects
- direct HTTP calls scattered across modules
- one-shot import assumptions
- silent data loss
