# apigee2gravitee

Automated migration pipeline for moving from **Apigee Edge OPDK** to **Gravitee API Management**.

Translates the export produced by [apigee-migrate-tool](https://github.com/apigeecs/apigee-migrate-tool) into Gravitee v4 API definition JSON files ready to import via the Gravitee Management API.

---

## Project Status

| Tool | Description |
|------|-------------|
| **Tool 1 — Extractor** | Reads apigee-migrate-tool `data/` output → writes IR to `ir/` |
| **Tool 2 — Parser + Mapper** | Internal translation layer used by the API migration workflow to map proxy IR into Gravitee API definitions |
| Developers Migration Tool | Validated manifest-driven workflow for migrating Apigee developers, apps, and product approvals into Gravitee users, applications, and subscriptions |
| API Migration Tool | Validated workflow for analyzing, importing, reconciling, and cleaning up Gravitee APIs/plans from proxy IR |
| Reporting Artifacts | Structured JSON and NDJSON gap, plan, reconcile, sync, target-catalog, and cleanup reports for both API and developers workflows |

---

## Prerequisites

| Requirement | Version | Used by |
|-------------|---------|---------|
| Python | 3.9+ | Tool 1 (extractor) |
| Node.js | 18+ | API and developers migration workflows (including the built-in translator) |
| npm | 8+ | Dependency install |
| apigee-migrate-tool | latest | Must be run first to produce `data/` |

---

## Installation

```bash
git clone <this-repo>
cd apigee2gravitee
npm install
node bin/migrator.js init
```

Verify the generated Gravitee URL, organization, environment, and token before
running migration commands:

```bash
npm run test:connection
```

The command reads `./config/apis.config.json` by default and uses
`GRAVITEE_TOKEN`. You can also run it directly with overrides:

```bash
node bin/migrator.js test-connection \
  --config ./config/apis.config.json \
  --gravitee-token "$GRAVITEE_TOKEN"
```

`npm install` installs the single Node.js dependency: `sax` (the XML parser used by the mapper).

The Python extractor has **no third-party dependencies** — it uses only Python stdlib (`zipfile`, `xml.etree.ElementTree`, `json`, `os`, `pathlib`).

`migrator init` prompts for the shared Gravitee endpoint settings and writes starter config files to:

- `config/apis.config.json`
- `config/developers.config.json`
- `config/developers.config.resolved.json`

---

## Tool 1 — Extractor

Reads the `data/` directory produced by `apigee-migrate-tool exportAll` and writes a structured Intermediate Representation (IR) to `./ir/`.

### Run

```bash
# Via Node CLI wrapper
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

### Note

- **Encrypted KVM entries** — Apigee's management API does not expose encrypted values. These are written with `value: null` and listed in `manifest.json` under `encrypted_kvm_names`. They must be entered manually in Gravitee after bootstrap.
- **KVM write operations** — Any `KeyValueMapOperations` policy with a `Put` or `Delete` operation is flagged in `manifest.json` under `warnings`. These must be mapped to Gravitee's Data Cache policy.
- **Proxy-scoped KVMs** — Written to `ir/kvms/proxy/{proxyName}/`. These become API Properties in Gravitee (accessible via `{#api.properties['key']}`), not Dictionaries.

---

## Tool 2 — Parser + Mapper

Reads a proxy IR JSON from `./ir/proxies/`, parses it into a fully annotated AST, and maps it to a Gravitee v4 API definition JSON.

This is an internal translation layer used by the `apis` workflow. You do not need to run Tool 2 as a separate prerequisite before `apis analyze`, `apis plan`, `apis import`, or `apis reconcile`.

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

### Programmatic example

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
console.log('Manual redesign needed:', apiDefinition._migrationMeta.manualSteps);
```

There is not currently a standalone CLI subcommand that writes these mapped definitions to `./ir/gravitee-apis/`. The existing `apis` commands call the parser/mapper internally during analyze, plan, import, and reconcile.

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
| `Javascript` | Groovy stub | Review required |
| `JavaCallout` | Disabled groovy stub | Review required |
| `MessageLogging` | Disabled groovy stub | ❌ No equivalent — manual redesign |
| `ExtensionCallout` | Disabled groovy stub | ❌ No equivalent — manual redesign |

### The `_migrationMeta` block

Every API definition output includes a `_migrationMeta` block. **Strip this before posting to the Gravitee Management API** — it is for tooling use only:

---

## API Migration Tool

Creates or updates Gravitee APIs and plans from extracted Apigee proxy IR. This workflow should run before the developers migration tool when the target APIs and plans do not already exist in Gravitee.

The API commands invoke the parser/mapper internally from `ir/proxies/*.json`; they do not require a separate Tool 2 output directory or a standalone Tool 2 run first.

### Config

Start from [`config/apis.config.example.json`](./config/apis.config.example.json):

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

Translates and migrates Apigee Developers and their applications into Gravitee Users and Applications.

- Apigee developers → Gravitee users
- Apigee developer apps → Gravitee applications
- Apigee product approvals on credentials → Gravitee subscriptions

### Prerequisites


1. Run Tool 1 (extractor) and generate `./ir`.
2. Ensure target Gravitee APIs and plans already exist or API migration has been run.
3. Run `init` command to write config file [`config/developers.config.example.json`](./config/developers.config.example.json).
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

Then review each config block:

| Config block | Required | Default/example value | Description |
|---|---|---|---|
| `gravitee.url` | Yes | `https://gravitee.example.com` | Base Gravitee URL such as `https://gravitee.example.com`. Do not append `/management`; the client adds management paths itself. |
| `gravitee.orgId` | Yes | `DEFAULT` | Gravitee organization id, usually `DEFAULT`. |
| `gravitee.envId` | Yes | `DEFAULT` | Gravitee environment id, usually `DEFAULT`. |
| `roles.organization` | Yes | `["ORGANIZATION:USER"]` | Default organization-scoped role names to assign to imported users, for example `["ORGANIZATION:USER"]`. |
| `roles.environment` | Yes | `["ENVIRONMENT:API_CONSUMER"]` in the example config, but use `developers configure-roles` to set this correctly for the target deployment | Default environment-scoped role names to assign to imported users, for example `["ENVIRONMENT:USER"]`. |
| `roleAssignmentIds` | Usually tool-managed | Not present by default; written by `developers configure-roles` | Concrete Gravitee role ids matching the selected default roles. These are normally written by `developers configure-roles` and should not usually be hand-edited. |
| `policies.inactiveDeveloper` | Yes | `import-and-revoke` | What to do with inactive Apigee developers and their apps/subscriptions: `skip`, `import-disabled`, or `import-and-revoke`. |
| `policies.smtp` | Yes | `acknowledged` | Declares how email/invite side effects are handled in the target deployment: `acknowledged`, `suppressed`, or `live`. This is a policy declaration, not an SMTP config block. |
| `policies.defaultApplication` | Yes | `must-be-disabled` | Whether the target deployment requires imported applications to be disabled by default: `must-be-disabled` or `allowed`. |
| `policies.apiKeyContinuity` | Yes | `preserve-if-supported` | How strict to be about preserving API key values: `preserve-if-supported`, `accept-regenerated`, or `fail-if-not-preservable`. |
| `policies.oauthClientContinuity` | Recommended | `preserve-if-supported` | Same continuity policy for OAuth-relevant credentials. Use this when the source dataset contains OAuth-like credentials or client-secret continuity matters. |
| `policies.existingUser` | Yes | `match-and-reuse` | How to handle a Gravitee user that already exists: `match-and-reuse`, `match-and-update`, or `fail-on-existing`. |
| `policies.existingApplication` | Yes | `match-and-reuse` | How to handle a Gravitee application that already exists: `match-and-reuse`, `match-and-update`, or `fail-on-existing`. |
| `policies.userProvisioning` | Yes | `reuse-or-create-silently` | Whether the tool may create users or only reuse existing ones: `reuse-only`, `reuse-or-create-silently`, or `allow-invites`. |
| `capabilities.silentUserCreation` | Yes | `supported` | Your attestation of whether this Gravitee environment supports silent user creation: `supported`, `unsupported`, or `unknown`. The preflight probes this and can block if the policy requires it. |
| `capabilities.apiKeyValuePreservation` | Yes | `unknown` | Your attestation of whether imported subscriptions can preserve existing API key values: `supported`, `unsupported`, or `unknown`. |
| `capabilities.oauthClientValuePreservation` | Yes | `unknown` | Your attestation of whether OAuth client values/secrets can be preserved: `supported`, `unsupported`, or `unknown`. |
| `capabilities.applicationOwnership` | Yes | `direct-member` | How the tool should represent app ownership: `direct-member`, `metadata-only`, or `unknown`. Current validated runs use `direct-member` so the developer actually owns the imported application. |
| `productPlanMap` | Optional for users/apps; required per subscription | Example entries for `orders-product` and `misc-product`; `{}` is valid | The source-product to target-API/plan mapping used to build subscriptions. Missing or unavailable targets defer only affected subscriptions and do not block users/applications. |
| `customFieldMap` | Optional | `{ "team": "team", "department": "department", "contact": "contact" }` | Reserved mapping for developer attributes. Apigee app attributes are discovered from the export and imported into Gravitee application metadata using their original attribute names. |
| `filters.includeDevelopers` | Optional | `[]` | Limit the run to specific developer emails. Useful for pilots and smoke tests. |
| `filters.excludeDevelopers` | Optional | `[]` | Exclude specific developer emails from the run. |
| `filters.includeApps` | Optional | `[]`; written by `developers select-apps --write-config` when using interactive app selection | Limit the run to specific applications using `developerEmail/appName` identifiers. An empty list means all apps allowed by the other filters are included. |
| `filters.excludeApps` | Optional | `[]` | Exclude specific applications using `developerEmail/appName` identifiers. |
| `reporting.reportDir` | Yes | `./report` | Directory where reports, logs, and auxiliary artifacts are written. |
| `reporting.stateFile` | Yes | `./state/developers-import-state.json` | Primary developers import state file. The tool derives the adjacent id-map and related artifacts from this reporting root. |

At minimum, you should set or confirm:

- `gravitee.url`
- `gravitee.orgId`
- `gravitee.envId`
- `policies.*`
- `capabilities.*`

Then run `developers configure-roles` against the target Gravitee deployment to fill in the right `roles.*` and `roleAssignmentIds.*` for that environment.

When target APIs and plans are available, run `developers discover-targets` to fill `productPlanMap`. This can happen before the first import or after users and applications have already been imported.

Example `productPlanMap` entry:

```json
{
  "capabilities": {
    "silentUserCreation": "supported",
    "apiKeyValuePreservation": "unknown",
    "oauthClientValuePreservation": "unknown",
    "applicationOwnership": "direct-member"
  },
  "productPlanMap": {
    "orders-product": {
      "targetApi": "orders-api",
      "targetApiId": "api_orders_123",
      "targetApiAliases": ["Orders API"],
      "targetPlan": "Orders API Key",
      "targetPlanId": "plan_orders_key_123",
      "targetPlanAliases": ["API Key Plan"],
      "matchMode": "alias"
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

Each target entry may also include:
- `targetApiAliases`
- `targetPlanAliases`
- `matchMode`

`matchMode` controls how `validate-config-targets` matches manually imported APIs and plans:
- `id-only` uses only configured ids
- `exact` uses ids plus primary names and normalized-name matching
- `alias` also allows the configured alias lists

Practical notes:

- `targetApiId` and `targetPlanId` may start as placeholders. Affected subscriptions remain `DEFERRED` until they resolve to suitable live Gravitee targets.
- Use `developers sync-api-targets` after this repo’s `apis import` workflow. Skip if APIs were manually created.
- Use `developers discover-targets --prompt-matches --write-config` when APIs/plans were imported manually or naming differs from the Apigee source.
- Use `developers select-apps --write-config` before validation/analyze/import when you want an auditable allow-list of exactly which Apigee applications should be migrated.
- Use array targets for products that grant access to multiple proxies; the tool will create one Gravitee subscription per target entry.
- Current validated runs use `capabilities.applicationOwnership: "direct-member"`, so imported applications are owned by the migrated developer rather than just carrying owner metadata.
- Apigee app custom attributes are imported into Gravitee application metadata with the same key names. The importer reserves `sourceId` and `developerEmail` for its own lookup markers, and `developers analyze` reports discovered app metadata under `applicationMetadata`.

If a source product is missing from `productPlanMap`, users and applications still import. The related subscription actions are recorded as `DEFERRED` with `PLAN_MAPPING_MISSING`, and a later normal import retries them automatically.

A starter mapping stub is available at [`config/developers.product-plan-map.from-data.example.json`](./config/developers.product-plan-map.from-data.example.json), and a full local starter config is available at [`config/developers.config.json`](./config/developers.config.json). Both mirror the extracted Apigee product-to-proxy relationships and use placeholder Gravitee API and plan ids to fill in.

In that sample, `misc-api-product` fronts three Apigee proxies. The config supports that directly by allowing one source product to map to an array of Gravitee API/plan targets.

### Commands

```bash
node bin/migrator.js developers configure-roles --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers discover-targets --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers select-apps --ir-dir ./ir --config ./config/developers.config.resolved.json --write-config
node bin/migrator.js developers resolve-config-ids --config ./config/developers.config.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers validate-config-targets --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers analyze   --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers plan      --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers import    --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers reconcile --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
```

### Command Descriptions

`developers configure-roles`: used before a real run to fetch live Gravitee role choices, pick the default organization and environment role for this deployment, and write both the scoped role names and role IDs back into the config.

`developers sync-api-targets`: used after an API import or reimport cycle to refresh `productPlanMap` API and plan ids from `state/apis-id-map.json` before validating or analyzing the developers workflow again. It writes `report/developers-sync-api-targets-report.json` by default so operators can review exactly which targets were updated and which still need manual attention. When you run it against `developers.config.resolved.json`, it now refreshes that same resolved config path by default instead of creating a growing chain of extra synced files.

`developers discover-targets`: used when APIs and plans were imported manually rather than by this repo's `apis` workflow. It inspects live Gravitee APIs and plans, generates `report/developers-target-catalog.json`, and can optionally write exact-match `productPlanMap` entries back into `developers.config.resolved.json`. If exact matching is not enough, add `--prompt-matches --write-config` to select an existing live API and plan interactively for each unresolved product.

`developers select-apps`: used when operators need to choose exactly which Apigee developer applications should be imported. It lists apps as `developerEmail/appName` with developer status, app status, credential count, and referenced API products, then writes the selected identifiers to `filters.includeApps` when `--write-config` is provided. Use `--output-config <path>` to write a separate selected config, or `--clear-selection` to empty `filters.includeApps` and return to importing all apps allowed by other filters.

`developers sync-live-ids`: used when Gravitee already has users, applications, or subscriptions and the local `state/developers-id-map.json` needs to be inspected or refreshed before update/delete commands. It writes `report/developers-live-id-sync-report.json` by default and is report-only unless `--write-id-map` is provided. Add `--clear-missing` with `--write-id-map` to null out saved IDs that no longer resolve in Gravitee.

`developers resolve-config-ids`: before `developers analyze` when your config still contains placeholder `targetApiId` and `targetPlanId` values. It resolves Gravitee API ids by `targetApi` name and plan ids by `targetPlan` name, then writes a sibling file such as `config/developers.config.resolved.json`.

`developers validate-config-targets`: confirms every configured `productPlanMap` target matches a live Gravitee API and plan exactly. It accepts id-based matches, exact/normalized name matches, and alias matches when `matchMode: "alias"` is configured. Its blockers indicate that those subscriptions are not ready; they do not prevent the default import from creating users and applications.

`developers analyze`: reports missing, unresolved, unavailable, or unsuitable subscription targets and marks their subscription actions `DEFERRED`. It still fails fast for global blockers such as connectivity, authentication, role, user-provisioning, or application-ownership failures.

```bash
node bin/migrator.js developers resolve-config-ids --config ./config/developers.config.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers validate-config-targets --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
node bin/migrator.js developers analyze --ir-dir ./ir --config ./config/developers.config.resolved.json --gravitee-token "$GRAVITEE_TOKEN"
```

### Explicit import workflows

Use the workflow that matches how the target APIs got into Gravitee.

Tool-imported API baseline:

```bash
node bin/migrator.js developers configure-roles \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers sync-api-targets \
  --config ./config/developers.config.resolved.json

node bin/migrator.js developers select-apps \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --write-config

node bin/migrator.js developers validate-config-targets \
  --ir-dir ./ir \
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

Manual-API baseline:

```bash
node bin/migrator.js developers configure-roles \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers discover-targets \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN" \
  --write-config \
  --prompt-matches

node bin/migrator.js developers select-apps \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --write-config

node bin/migrator.js developers validate-config-targets \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers analyze \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers import \
  --ir-dir ./ir \
  --config ./config/developers.config.resolved.json \
  --gravitee-token "$GRAVITEE_TOKEN"

node bin/migrator.js developers reconcile \
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

The default import is partial-safe: it creates all eligible users and applications, creates subscriptions with valid live targets, and defers only subscriptions whose APIs/plans are unavailable. `DEFERRED` actions do not make the import fail. Rerun the same import after adding mappings or APIs/plans to create the outstanding subscriptions.

### What the commands do

`developers analyze` will:

- validate the config against `config/developers.config.schema.json`
- verify IR readability
- confirm target connectivity and auth
- probe the live Gravitee user, application, plan, subscription, and API key surfaces used by the migration workflow
- warn and defer affected subscriptions when product-to-plan mappings or live targets are missing
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
- preserve Apigee app attributes as Gravitee application metadata using the original attribute names
- stop on continuity-critical failures and continue through non-critical failures until `--max-errors` is reached

`developers reconcile` will:

- compare expected users, apps, subscriptions, source markers, and continuity-sensitive fields against live Gravitee state
- write a structured mismatch report
- exit non-zero when blocking mismatches remain

`developers delete-imported` will:

- remove subscriptions, then applications, then users for resources this tool can positively identify as imported
- prefer the saved `state/developers-id-map.json`
- use `developers sync-live-ids --write-id-map` to refresh saved UUIDs from live Gravitee before deleting manually created or previously imported resources
- fall back to conservative source-marker and email lookups when ids are missing
- leave unrelated Gravitee users and applications untouched
- write `report/developers-cleanup-report.json` with cleanup counts, targets, and failures

For a full step-by-step controlled pilot, see [`docs/developers-pilot-runbook.md`](./docs/developers-pilot-runbook.md).

### Expected outputs

```text
report/developers-plan.json
report/developers-gap-report.json
report/developers-app-selection-report.json
report/developers-live-id-sync-report.json
report/developers-sync-api-targets-report.json
report/developers-target-catalog.json
report/developers-cleanup-report.json
state/developers-import-state.json
state/developers-id-map.json
logs/developers.ndjson
```

For the detailed design and policy rules, see [`docs/developers-migration-context.md`](./docs/developers-migration-context.md).
For the non-production pilot workflow, see [`docs/developers-pilot-runbook.md`](./docs/developers-pilot-runbook.md).

| Field | Description |
|---|---|
| `securityScheme` | `API_KEY` / `OAUTH2` / `JWT` / `KEYLESS` |
| `manualSteps` | Step names with no programmatic equivalent |
| `needsReviewSteps` | Steps flagged with `_needsReview` (e.g. KVM writes → cache) |
| `unmappedConditions` | Condition strings the translator couldn't handle |
| `kvmWriteOps` | KVM identifiers used in write operations |
| `encryptedProperties` | API property keys where the value is `ENCRYPTED_VALUE_REQUIRED` |
| `sharedFlowRefs` | Shared flow names referenced by this proxy |
| `targetServerRefs` | TargetServer names referenced by this proxy |

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
- **JavaScript / JavaCallout** — Translated to Groovy stubs.
- **MessageLogging / StatisticsCollector** — No Gravitee equivalent. Emitted as disabled stubs; monitoring must be reconfigured using Gravitee's analytics and alert capabilities.
- **XSLTransform** — The policy is created but the XSLT stylesheet content must be manually embedded, as resource files are not automatically uploaded to Gravitee.
- **KVM write operations** — Mapped to Gravitee's Data Cache policy as a best-effort translation. The cache resource (Redis) must be pre-configured in the Gravitee environment, and the cache key logic should be reviewed.
- **Encrypted API Properties** — Written as `ENCRYPTED_VALUE_REQUIRED` placeholders. Must be overwritten via the Gravitee console after import.
