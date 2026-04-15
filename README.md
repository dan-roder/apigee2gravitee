# apigee2gravitee

Automated migration pipeline for moving from **Apigee Edge OPDK** to **Gravitee API Management**.

Consumes the export produced by [apigee-migrate-tool](https://github.com/apigeecs/apigee-migrate-tool) and produces Gravitee v4 API definition JSON files ready to import via the Gravitee Management API.

---

## Project Status

| Tool | Status | Description |
|------|--------|-------------|
| **Tool 1 — Extractor** | ✅ Complete | Reads apigee-migrate-tool `data/` output → writes IR to `ir/` |
| **Tool 2 — Parser + Mapper** | ✅ Complete | Reads IR → parses proxy AST → emits Gravitee v4 API definition JSON |
| Developers Migration Tool | ✅ Validated locally | Migrates Apigee developers, apps, and product approvals into Gravitee users, applications, and subscriptions |
| Tool 3 — LLM Fallback | 🔲 Planned | Translates JavaScript/JavaCallout policies via Claude API |
| API Migration Tool | 🟡 In active implementation | Analyzes, imports, and reconciles Gravitee APIs/plans from proxy IR |
| Tool 5 — Gap Reporter | 🔲 Planned | Generates HTML report of all migration gaps and review items |

---

## Prerequisites

| Requirement | Version | Used by |
|-------------|---------|---------|
| Python | 3.9+ | Tool 1 (extractor) |
| Node.js | 18+ | Tools 2–5 |
| npm | 8+ | Dependency install |
| apigee-migrate-tool | latest | Must be run first to produce `data/` |

---

## Installation

```bash
git clone <this-repo>
cd apigee2gravitee
npm install
```

`npm install` installs the single Node.js dependency: `sax` (the XML parser used by the mapper).

The Python extractor has **no third-party dependencies** — it uses only Python stdlib (`zipfile`, `xml.etree.ElementTree`, `json`, `os`, `pathlib`).

---

## Tool 1 — Extractor

Reads the `data/` directory produced by `apigee-migrate-tool exportAll` and writes a structured Intermediate Representation (IR) to `./ir/`.

### Run

```bash
# Via Node CLI wrapper (recommended — pretty-prints progress)
node bin/migrator.js extract \
  --data-dir ./data \
  --ir-dir   ./ir \
  --org      your-org-name \
  --env      dev

# Via Python directly (each stdout line is a JSON status object)
python3 -m src.extractor.extractor \
  --data-dir ./data \
  --ir-dir   ./ir \
  --org      your-org-name \
  --env      dev \
  -v
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--data-dir` | Yes | Path to apigee-migrate-tool `data/` directory |
| `--ir-dir` | Yes | Output directory for IR JSON files (created if absent) |
| `--org` | No | Apigee org name — recorded in manifest for traceability |
| `--env` | No | Apigee environment name — recorded in manifest |
| `-v` / `--verbose` | No | Enable debug logging and full Python tracebacks |

### Output

```
ir/
  manifest.json               ← summary: counts, warnings, errors, encrypted KVM list
  proxies/{name}.json         ← one file per API proxy bundle
  sharedflows/{name}.json     ← one file per shared flow bundle
  kvms/org/{name}.json        ← org-scoped KVMs
  kvms/env/{env}/{name}.json  ← environment-scoped KVMs
  kvms/proxy/{proxy}/{name}.json ← proxy-scoped KVMs
  targetservers/{name}.json   ← Apigee TargetServer definitions
  flowhooks/{name}.json       ← PreProxy / PostProxy / PreTarget / PostTarget hooks
  developers/{email}.json     ← developer entities
  apps/{email}/{name}.json    ← developer app entities (with credentials)
  products/{name}.json        ← API product entities
```

### Key facts

- **Encrypted KVM entries** — Apigee's management API does not expose encrypted values. These are written with `value: null` and listed in `manifest.json` under `encrypted_kvm_names`. They must be entered manually in Gravitee after bootstrap.
- **KVM write operations** — Any `KeyValueMapOperations` policy with a `Put` or `Delete` operation is flagged in `manifest.json` under `warnings`. These must be mapped to Gravitee's Data Cache policy.
- **Proxy-scoped KVMs** — Written to `ir/kvms/proxy/{proxyName}/`. These become API Properties in Gravitee (accessible via `{#api.properties['key']}`), not Dictionaries.

---

## Tool 2 — Parser + Mapper

Reads a proxy IR JSON from `./ir/proxies/`, parses it into a fully annotated AST, and maps it to a Gravitee v4 API definition JSON.

### Architecture

```
ir/proxies/{name}.json
        │
        ▼
src/parser/proxy-ast.js          ← builds ProxyAST
  ├── src/parser/policy-registry.js   ← classifies policy types, extracts structured config
  └── src/parser/condition-translator.js  ← converts Apigee conditions → Gravitee EL
        │
        ▼
src/mapper/policy-mapper.js      ← walks AST flowGraph → Gravitee v4 API definition JSON
  └── src/mapper/policy-handlers.js   ← per-policy-type translation handlers
```

### Run (programmatic — CLI command coming in Tool 4)

```javascript
const { parseProxyFile } = require('./src/parser/proxy-ast');
const { mapProxyToGraviteeApi } = require('./src/mapper/policy-mapper');
const fs = require('fs');

// Parse the IR into an AST
const ast = parseProxyFile('./ir/proxies/orders-api.json');

// Optionally load resolved target server URLs from bootstrap state
const bootstrapState = JSON.parse(fs.readFileSync('./ir/bootstrap-state.json', 'utf8'));
const resolvedServers = {};
for (const [name, ts] of Object.entries(bootstrapState.targetServers)) {
  resolvedServers[name] = { url: ts.url };
}

// Map to Gravitee v4 API definition
const apiDefinition = mapProxyToGraviteeApi(ast, { resolvedServers });

// Write to disk
fs.writeFileSync(
  `./ir/gravitee-apis/${ast.name}.json`,
  JSON.stringify(apiDefinition, null, 2)
);

console.log('Security scheme:', apiDefinition._migrationMeta.securityScheme);
console.log('LLM review needed:', apiDefinition._migrationMeta.llmSteps.map(s => s.name));
console.log('Manual redesign needed:', apiDefinition._migrationMeta.manualSteps);
```

### What the mapper produces

A complete Gravitee v4 API definition ready for `POST /management/v2/organizations/{org}/environments/{env}/apis`:

```json
{
  "definitionVersion": "V4",
  "type": "PROXY",
  "name": "Orders API",
  "apiVersion": "1.0.0",
  "description": "Migrated from Apigee proxy: orders-api",
  "listeners": [
    {
      "type": "HTTP",
      "paths": [{ "path": "/v1/orders" }],
      "entrypoints": [{ "type": "http-proxy" }]
    }
  ],
  "endpointGroups": [
    {
      "name": "default-group",
      "type": "http-proxy",
      "endpoints": [
        {
          "name": "orders-backend-primary",
          "type": "http-proxy",
          "weight": 2,
          "configuration": { "target": "https://primary.orders.internal:8443" }
        }
      ]
    }
  ],
  "flows": [
    {
      "name": "Common Flow",
      "enabled": true,
      "selectors": [{ "type": "HTTP", "path": "/v1/orders", "pathOperator": "STARTS_WITH" }],
      "request": [
        {
          "policy": "rate-limit",
          "name": "Rate Limit (migrated from SpikeArrest: spike-arrest)",
          "enabled": true,
          "configuration": { "rate": { "limit": 100, "periodTimeUnit": "SECONDS" } }
        }
      ],
      "response": []
    },
    {
      "name": "GetOrders",
      "enabled": true,
      "selectors": [{ "type": "HTTP", "path": "/v1/orders", "pathOperator": "STARTS_WITH", "methods": ["GET"] }],
      "request": [...],
      "response": [...]
    }
  ],
  "plans": {
    "API_KEY": {
      "name": "API Key Plan",
      "security": { "type": "API_KEY" },
      "status": "STAGING"
    }
  },
  "properties": [],
  "flowExecution": { "mode": "DEFAULT", "matchRequired": false },
  "_migrationMeta": {
    "securityScheme": "API_KEY",
    "llmSteps": [{ "name": "validate-order-payload", "rawXml": "..." }],
    "manualSteps": ["log-response"],
    "kvmWriteOps": ["order-cache"]
  }
}
```

### Policy mapping reference

| Apigee Policy | Gravitee Policy Slug | Notes |
|---|---|---|
| `VerifyAPIKey` | Plan security (API_KEY) | Not a flow step — becomes the Plan security scheme |
| `OAuthV2 VerifyAccessToken` | Plan security (OAUTH2) | Not a flow step |
| `VerifyJWT` | Plan security (JWT) | Not a flow step |
| `SpikeArrest` | `rate-limit` | Rate/interval parsed from e.g. `100ps` |
| `Quota` | `quota` | Count/interval/timeUnit mapped |
| `AssignMessage` (headers) | `transform-headers` | Set/add/remove headers |
| `AssignMessage` (variable) | `assign-attributes` | AssignVariable elements |
| `AssignMessage` (status) | `interrupt` | When setting statusCode |
| `AssignMessage` (verb) | `override-http-method` | When setting Verb |
| `AssignMessage` (payload) | `assign-content` | When setting Payload only |
| `RaiseFault` | `interrupt` | Status + payload preserved |
| `ServiceCallout` | `http-callout` | URL + response variable |
| `KeyValueMapOperations` (Get) | `assign-attributes` | EL: `#dictionaries[...]` or `#api.properties[...]` |
| `KeyValueMapOperations` (Put/Delete) | `cache` | ⚠️ Semantic shift — flagged `_needsReview` |
| `ResponseCache` / `LookupCache` / `PopulateCache` | `cache` | |
| `AccessControl` | `ip-filtering` | Allow/deny lists |
| `CORS` | `cors` | All CORS fields mapped |
| `ExtractVariables` | `assign-attributes` | JSONPath/XPath → EL |
| `XMLToJSON` / `JSONToXML` | `xml-json` | |
| `XSLTransform` | `xslt` | ⚠️ Stylesheet must be embedded manually |
| `FlowCallout` | Disabled groovy stub | ⚠️ Map to Gravitee Shared Policy Group manually |
| `Javascript` | Groovy stub | 🤖 LLM review required |
| `JavaCallout` | Disabled groovy stub | 🤖 LLM review required |
| `MessageLogging` | Disabled groovy stub | ❌ No equivalent — manual redesign |
| `ExtensionCallout` | Disabled groovy stub | ❌ No equivalent — manual redesign |

### The `_migrationMeta` block

Every API definition output includes a `_migrationMeta` block. **Strip this before posting to the Gravitee Management API** — it is for tooling use only:

---

## API Migration Tool

Creates or updates Gravitee APIs and plans from extracted Apigee proxy IR. This is the missing upstream stage that should run before the developers migration tool, because developers migration expects the target APIs and plans to already exist.

### Config

Start from [`config/apis.config.example.json`](/Users/danielroder/Sites/apigee2gravitee/config/apis.config.example.json):

```json
{
  "gravitee": {
    "url": "http://localhost:8083",
    "orgId": "DEFAULT",
    "envId": "DEFAULT"
  },
  "filters": {
    "includeProxies": [],
    "excludeProxies": []
  },
  "compatibility": {
    "fallbackPlugins": []
  },
  "reporting": {
    "reportDir": "./report",
    "stateFile": "./state/apis-import-state.json"
  }
}
```

If your local Gravitee does not have certain policy plugins installed, you can degrade those mapped steps into reviewable Groovy stubs instead of blocking API import:

```json
"compatibility": {
  "fallbackPlugins": ["assign-attributes", "http-callout", "assign-content"]
}
```

This is useful for APIs that otherwise fail on missing plugins during `apis import`. The API will still import, but the affected steps will be marked for review instead of behaving as a full one-to-one translation.

`filters.includeProxies` is the safest way to run a small pilot. Start with one or two proxy names from `ir/proxies/`.

### Commands

```bash
node bin/migrator.js apis analyze --ir-dir ./ir --config ./config/apis.config.example.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js apis plan --ir-dir ./ir --config ./config/apis.config.example.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js apis import --ir-dir ./ir --config ./config/apis.config.example.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js apis reconcile --ir-dir ./ir --config ./config/apis.config.example.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js apis delete-imported --ir-dir ./ir --config ./config/apis.config.example.json --gravitee-token "$GRAVITEE_TOKEN"
```

### Recommended first run

Run the API track before the developers track:

```bash
node bin/migrator.js extract --data-dir ./data --ir-dir ./ir --org your-org --env dev

node bin/migrator.js apis analyze \
  --ir-dir ./ir \
  --config ./config/apis.config.example.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js apis plan \
  --ir-dir ./ir \
  --config ./config/apis.config.example.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js apis import \
  --ir-dir ./ir \
  --config ./config/apis.config.example.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js apis reconcile \
  --ir-dir ./ir \
  --config ./config/apis.config.example.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

After the APIs and plans exist in Gravitee, move to the developers flow:

```bash
node bin/migrator.js developers resolve-config-ids --config ./config/developers.config.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers validate-config-targets --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers analyze --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
```

### What the API commands do

`apis analyze` will:

- validate API migration config
- load proxy IR and mapped Gravitee API definitions
- probe live Gravitee API import compatibility
- write `report/apis-plan.json`, `report/apis-gap-report.json`, `state/apis-import-state.json`, `state/apis-id-map.json`, and `logs/apis.ndjson`

`apis plan` will:

- persist the executable API migration manifest
- classify APIs as create or update based on live Gravitee lookups

`apis import` will:

- create or update APIs in Gravitee
- persist a source-to-target API id map for resume and reconcile
- verify that expected plan names exist after import

`apis reconcile` will:

- check that each expected API exists in Gravitee
- verify the expected plan names are present
- compare live targets with the saved API id map

`apis delete-imported` will:

- delete APIs that this tool can positively identify as imported
- prefer the saved `state/apis-id-map.json`
- fall back to live source markers like `definitionContext.origin.sourceId` when available
- leave unrelated Gravitee APIs untouched
- write `report/apis-cleanup-report.json` with cleanup counts, targets, and failures

### Expected outputs

```text
report/apis-plan.json
report/apis-gap-report.json
report/apis-reconcile-report.json
report/apis-cleanup-report.json
state/apis-import-state.json
state/apis-id-map.json
logs/apis.ndjson
```

---

## Developers Migration Tool

This repo now includes an **active developers migration workflow** for migrating:

- Apigee developers → Gravitee users
- Apigee developer apps → Gravitee applications
- Apigee product approvals on credentials → Gravitee subscriptions

### Current state

- The migration context and config/schema are defined.
- Shared IR loading support for developers/apps/credentials/references is in place.
- `developers analyze`, `developers plan`, `developers import`, and `developers reconcile` are implemented as a manifest-driven workflow.
- The current implementation now performs live compatibility probes during preflight and produces resumable state, id maps, reports, and reconciliation output.
- The remaining production risk is deployment-specific Gravitee behavior, so a non-production smoke run is strongly recommended before any broad import.

Use this section to prepare inputs and run the current command surface.

### Prerequisites

Before running this part of the migration:

1. Run Tool 1 and generate `./ir`.
2. Ensure target Gravitee APIs and plans already exist.
3. Create a config file from [`config/developers.config.example.json`](/Users/danielroder/Sites/apigee2gravitee/config/developers.config.example.json).
4. Fill in `productPlanMap` for every Apigee product that should become a Gravitee subscription.
5. Set Gravitee URL, org, env, roles, and policies in that config.
6. Set capability attestations for silent user creation, application ownership, and credential preservation.

### Required IR inputs

The developers migration flow expects these IR inputs under `./ir`:

```text
ir/
  developers/
  apps/
  credentials/
  products/
  references/subscription-intent.json
  references/credential-continuity-index.json
  references/inactive-impact.json
  _protected/credentials/...    (when continuity review needs secret presence metadata)
  manifest.json
```

### Config setup

Start with:

```bash
cp ./config/developers.config.example.json ./config/developers.config.json
```

Then update at minimum:

- `gravitee.url`
- `gravitee.orgId`
- `gravitee.envId`
- `roles.organization`
- `roles.environment`
- `policies.userProvisioning`
- `capabilities.silentUserCreation`
- `capabilities.applicationOwnership`
- `capabilities.apiKeyValuePreservation`
- `capabilities.oauthClientValuePreservation`
- `productPlanMap`

Example `productPlanMap` entry:

```json
{
  "capabilities": {
    "silentUserCreation": "supported",
    "apiKeyValuePreservation": "unknown",
    "oauthClientValuePreservation": "unknown",
    "applicationOwnership": "metadata-only"
  },
  "productPlanMap": {
    "orders-product": {
      "targetApi": "orders-api",
      "targetApiId": "api_orders_123",
      "targetPlan": "Orders API Key",
      "targetPlanId": "plan_orders_key_123"
    },
    "misc-product": [
      {
        "targetApi": "hello-api",
        "targetApiId": "api_hello_123",
        "targetPlan": "Hello API Key",
        "targetPlanId": "plan_hello_key_123"
      },
      {
        "targetApi": "facts-api",
        "targetApiId": "api_facts_123",
        "targetPlan": "Facts API Key",
        "targetPlanId": "plan_facts_key_123"
      }
    ]
  }
}
```

`productPlanMap.<product>` may be either:
- one target object when an Apigee product maps to one Gravitee API/plan
- an array of target objects when one Apigee product must fan out to multiple Gravitee APIs/plans

Each target entry becomes its own planned subscription during developers migration.

If a source product is missing from `productPlanMap`, `developers analyze` should fail preflight.

For the current sample Apigee export in [`data/`](/Users/danielroder/Sites/apigee2gravitee/data), a starter mapping stub is available at [`config/developers.product-plan-map.from-data.example.json`](/Users/danielroder/Sites/apigee2gravitee/config/developers.product-plan-map.from-data.example.json), and a full local starter config is available at [`config/developers.config.json`](/Users/danielroder/Sites/apigee2gravitee/config/developers.config.json). Both mirror the extracted Apigee product-to-proxy relationships and use placeholder Gravitee API and plan ids to fill in.

In that sample, `misc-api-product` fronts three Apigee proxies. The config now supports that directly by allowing one source product to map to an array of Gravitee API/plan targets.

### Commands

```bash
node bin/migrator.js developers configure-roles --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers resolve-config-ids --config ./config/developers.config.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers validate-config-targets --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers analyze   --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers plan      --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers import    --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers reconcile --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
```

Use `developers configure-roles` before a real run to fetch live Gravitee role choices, pick the default organization and environment role for this deployment, and write both the scoped role names and role IDs back into the config.

Use `developers sync-api-targets` after an API import or reimport cycle to refresh `productPlanMap` API and plan ids from `state/apis-id-map.json` before validating or analyzing the developers workflow again.

Use `developers resolve-config-ids` before `developers analyze` when your config still contains placeholder `targetApiId` and `targetPlanId` values. It resolves Gravitee API ids by `targetApi` name and plan ids by `targetPlan` name, then writes a sibling file such as `config/developers.config.resolved.json`.

Use `developers validate-config-targets` after that to confirm every `productPlanMap` target matches a live Gravitee API and plan exactly. It writes `report/developers-config-targets-report.json` by default and treats missing or ambiguous API/plan matches as blockers.

`developers analyze` now fails fast when any `productPlanMap` target still has placeholder or missing `targetApiId` or `targetPlanId` values. The intended operator sequence is:

```bash
node bin/migrator.js developers resolve-config-ids --config ./config/developers.config.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers validate-config-targets --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers analyze --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
```

Validated execution sequence:

```bash
node bin/migrator.js developers configure-roles \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers sync-api-targets \
  --config ./config/developers.config.resolved.json

node bin/migrator.js developers validate-config-targets \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers analyze \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --users-only

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --apps-only

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers reconcile \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers delete-imported \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

`developers import` also supports scoped execution flags:

- `--users-only`
- `--apps-only`
- `--subscriptions-only`
- `--resume`
- `--force`
- `--max-errors <n>`

### What the commands do

`developers analyze` will:

- validate the config against `config/developers.config.schema.json`
- verify IR readability
- confirm target connectivity and auth
- probe the live Gravitee user, application, plan, subscription, and API key surfaces used by the migration workflow
- fail if any required product-to-plan mappings are missing
- fail if `reuse-or-create-silently` is configured but `capabilities.silentUserCreation` is not `supported`
- fail when live capability probes contradict required one-to-one behaviors
- read credential-level subscription intent from `ir/references/subscription-intent.json`
- produce a gap/risk report, executable manifest, state ledger, id map, and structured log without writing to Gravitee

`developers plan` will:

- resolve target lookups into an executable action manifest
- classify actions as ready, blocked, skipped, or manual review
- refresh report/state artifacts without mutating Gravitee

`developers import` will:

- execute user, application, plan-resolution, subscription, and verification actions in dependency order
- skip Apigee developers that do not own any imported applications
- persist action status after each step for resume support
- persist deterministic source markers on migrated applications so reruns do not depend only on name matching
- stop on continuity-critical failures and continue through non-critical failures until `--max-errors` is reached

`developers reconcile` will:

- compare expected users, apps, subscriptions, source markers, and continuity-sensitive fields against live Gravitee state
- write a structured mismatch report
- exit non-zero when blocking mismatches remain

`developers delete-imported` will:

- remove subscriptions, then applications, then users for resources this tool can positively identify as imported
- prefer the saved `state/developers-id-map.json`
- fall back to conservative source-marker and email lookups when ids are missing
- leave unrelated Gravitee users and applications untouched
- write `report/developers-cleanup-report.json` with cleanup counts, targets, and failures

### Recommended smoke test

Run the first live pass in a non-production Gravitee environment with a small filtered dataset:

```bash
node bin/migrator.js developers configure-roles \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers validate-config-targets \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers analyze \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --users-only

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --apps-only

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers reconcile \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

This workflow has now been validated against a local Gravitee instance with:

- `2` imported users
- `4` imported applications
- `4` imported subscriptions
- `0` reconcile blockers
- `0` reconcile warnings
- successful `developers delete-imported` cleanup for subscriptions, applications, and users

For a full step-by-step controlled pilot, see [`docs/developers-pilot-runbook.md`](/Users/danielroder/Sites/apigee2gravitee/docs/developers-pilot-runbook.md).

### Recommended production sequence

For a production run, treat `configure-roles`, `validate-config-targets`, and `analyze` as required pre-import gates.

```bash
node bin/migrator.js developers configure-roles \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers validate-config-targets \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers analyze \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --users-only

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --apps-only

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers reconcile \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

### Production hardening checklist

- Run the full developers workflow against a non-production Gravitee environment first.
- Re-run `developers configure-roles` against the target deployment instead of copying local role ids between environments.
- Re-run `developers sync-api-targets` after API cleanup/reimport cycles so `productPlanMap` ids stay aligned with `state/apis-id-map.json`.
- Re-run `developers validate-config-targets` after any API re-import, because API and plan ids can change across cleanup/recreate cycles.
- Re-run `developers analyze` immediately before import so the manifest and state reflect the current target.
- Use `developers delete-imported` to reset a pilot environment between test runs.
- Treat API-key continuity as verified only when the target deployment and policy require it.
- Use `policies.oauthClientContinuity` only when the extracted credentials actually imply OAuth continuity requirements; API-key-only datasets should no longer emit generic OAuth continuity warnings.

### Expected outputs

```text
report/developers-plan.json
report/developers-gap-report.json
report/developers-cleanup-report.json
state/developers-import-state.json
state/developers-id-map.json
logs/developers.ndjson
```

For the detailed design and policy rules, see [`docs/developers-migration-context.md`](/Users/danielroder/Sites/apigee2gravitee/docs/developers-migration-context.md).
For the first non-production pilot workflow, see [`docs/developers-pilot-runbook.md`](/Users/danielroder/Sites/apigee2gravitee/docs/developers-pilot-runbook.md).

| Field | Description |
|---|---|
| `securityScheme` | `API_KEY` / `OAUTH2` / `JWT` / `KEYLESS` |
| `llmSteps` | Steps needing LLM translation — each has `name` and `rawXml` |
| `manualSteps` | Step names with no programmatic equivalent |
| `needsReviewSteps` | Steps flagged with `_needsReview` (e.g. KVM writes → cache) |
| `unmappedConditions` | Condition strings the translator couldn't handle |
| `kvmWriteOps` | KVM identifiers used in write operations |
| `encryptedProperties` | API property keys where the value is `ENCRYPTED_VALUE_REQUIRED` |
| `sharedFlowRefs` | Shared flow names referenced by this proxy |
| `targetServerRefs` | TargetServer names referenced by this proxy |

### Condition translation

Apigee conditions are translated to Gravitee EL (SpEL-based). Common patterns:

| Apigee | Gravitee EL |
|---|---|
| `request.verb = "GET"` | `{#request.method == 'GET'}` |
| `request.verb != "OPTIONS"` | `{#request.method != 'OPTIONS'}` |
| `request.path MatchesPath "/api/v1/*"` | `{#request.path matches '^/api/v1/[^/]*(/.*)?$'}` |
| `request.header.x-api-key != null` | `{#request.headers['x-api-key'] != null}` |
| `request.queryparam.debug = "true"` | `{#request.params['debug'][0] == 'true'}` |
| `response.status.code >= 400` | `{#response.status >= 400}` |

Conditions that cannot be fully translated are emitted as-is with `needsReview: true` and listed in `_migrationMeta.unmappedConditions`.

---

## Running the Tests

```bash
# All suites
npm test

# Individual suites
npm run test:extractor    # 91 Python tests — extractor (Tool 1)
npm run test:translator   # 168 Node tests  — parser + mapper (Tool 2)
npm run test:parser       # 93 Node tests   — proxy-ast, condition-translator, policy-registry
npm run test:mapper       # 75 Node tests   — policy-handlers, policy-mapper
```

The translator test suites are fully self-contained — they invoke the Python extractor
against the local fixtures, write a temporary IR cache, and clean it up on exit.

---

## No Extractor Changes Required

The Python extractor was **not changed** to support Tool 2. The fix applied was entirely
on the Node.js side:

- `_el_to_dict()` in `bundle.py` intentionally writes only one level of `raw_dict`
  children (documented: *"Downstream Node modules receive the raw_xml string for full fidelity"*)
- `policy-registry.js` was updated to accept and prefer `raw_xml` over `raw_dict`,
  re-parsing it with `sax` for full depth traversal
- The IR you already have from Tool 1 is fully compatible with Tool 2 — no re-extraction needed

---

## File Reference

```
apigee2gravitee/
│
├── package.json                        Node.js manifest (single dep: sax)
├── README.md
├── bin/
│   └── migrator.js                     Node CLI entry point
│
├── src/
│   ├── extractor/                      Tool 1 — Python extractor
│   │   ├── extractor.py                Main CLI + orchestrator
│   │   ├── schema.py                   IR dataclass definitions
│   │   ├── writer.py                   Writes IR to ./ir/
│   │   └── readers/
│   │       ├── bundle.py               Parses proxy/sharedflow ZIPs
│   │       └── data_dir.py             Reads KVMs, devs, apps, products etc.
│   │
│   ├── translator/                     Tool 2 — Proxy AST parser + Gravitee mapper
│   │   ├── parser/
│   │   │   ├── proxy-ast.js            Builds annotated ProxyAST from IR
│   │   │   ├── policy-registry.js      Policy classifier + config extractor
│   │   │   └── condition-translator.js Apigee condition syntax → Gravitee EL
│   │   └── mapper/
│   │       ├── policy-mapper.js        Walks AST → Gravitee v4 API definition JSON
│   │       └── policy-handlers.js      Per-policy-type translation handlers
│   │
│   ├── bootstrap/                      Tool 3 (in progress) — Gravitee env setup
│   │   ├── dictionaries.js
│   │   ├── target-servers.js
│   │   └── state.js
│   │
│   └── shared/                         Shared utilities (all tools)
│       ├── gravitee-client.js          HTTP client for Gravitee Management API
│       └── ir-loader.js                Reads IR directory into memory
│
└── test/
    ├── extractor/                      Tests for Tool 1
    │   ├── test_extractor.py           91 Python tests
    │   └── fixtures/data/              Fixture data (proxy ZIPs, KVMs, devs, apps...)
    └── translator/                     Tests for Tool 2
        ├── test-parser.js              93 Node tests (proxy-ast, registry, translator)
        └── test-mapper.js              75 Node tests (policy-handlers, policy-mapper)
```

---

## Known Limitations

- **Shared Flows** — FlowCallout references emit a disabled groovy stub. Gravitee's Shared Policy Group feature requires creating the shared group separately then updating each API to reference it. This will be handled in a future tool step.
- **JavaScript / JavaCallout** — Translated to Groovy stubs. The LLM fallback module (Tool 3) will submit the `rawXml` to the Claude API for a suggested translation requiring human review.
- **MessageLogging / StatisticsCollector** — No Gravitee equivalent. Emitted as disabled stubs; monitoring must be reconfigured using Gravitee's analytics and alert capabilities.
- **XSLTransform** — The policy is created but the XSLT stylesheet content must be manually embedded, as resource files are not automatically uploaded to Gravitee.
- **KVM write operations** — Mapped to Gravitee's Data Cache policy as a best-effort translation. The cache resource (Redis) must be pre-configured in the Gravitee environment, and the cache key logic should be reviewed.
- **Encrypted API Properties** — Written as `ENCRYPTED_VALUE_REQUIRED` placeholders. Must be overwritten via the Gravitee console after import.
