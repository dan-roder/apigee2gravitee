# Tool 1 — Extractor Specification

## 1. Purpose

Tool 1 reads the Apigee export directory produced by `apigee-migrate-tool exportAll` and writes a deterministic Intermediate Representation (IR) to disk.

This rebuilt version intentionally differs from the current repo extractor by making the IR:

* more relationship-aware
* more migration-aware
* more audit-friendly
* more useful to downstream tools beyond Tool 2

It remains source-centric and best-effort.

## 2. Comparative position vs. existing repo

### Existing extractor baseline

The current repo extractor:

* reads `data/`
* writes `ir/`
* emits `manifest.json`
* writes per-artifact JSON files for proxies, shared flows, KVMs, target servers, flow hooks, developers, apps, and products
* flags encrypted KVM values
* flags KVM write operations
* keeps compatibility with Tool 2 without changing Tool 1

### Comparative extractor goals

This rebuilt extractor will additionally:

* generate first-class relationship indexes
* treat credentials as first-class entities
* preserve malformed artifacts under `_failed-artifacts`
* split secrets into protected sidecars
* classify blockers vs warnings
* compute derived migration hints for continuity, status, and dependency handling
* generate inventory and reference reports that later tools can consume directly

## 3. Design principles

### 3.1 Best-effort extraction

The extractor continues processing even when some artifacts fail.

A local artifact may be marked with blockers, but the overall extraction run still succeeds unless a future strict mode is added.

### 3.2 Deterministic outputs

The same input export should produce the same IR layout and object identities.

### 3.3 No silent loss

If a value cannot be extracted, translated, or trusted, it must be represented explicitly as:

* a blocker
* a warning
* a null placeholder
* a failed-artifact record
* a review hint

### 3.4 Source-first, migration-aware

Tool 1 does not perform full Gravitee mapping, but it may derive migration-relevant metadata and relationship structures from source exports.

### 3.5 Advisory, not enforcing

Tool 1 may compute recommended actions and target hints, but it does not enforce migration policy. Later tools remain free to override.

## 4. Inputs

### 4.1 Runtime inputs

* `--data-dir` (required)
* `--ir-dir` (required)
* `--org` (optional)
* `--env` (optional)
* `-v` / `--verbose` (optional)

### 4.2 Expected source contents

The input is the `data/` directory from `apigee-migrate-tool exportAll`, including where present:

* API proxy bundles
* shared flow bundles
* KVM exports
* TargetServer exports
* flow hook exports
* developer exports
* app exports
* API product exports

## 5. Outputs

### 5.1 Core IR layout

```text
ir/
  manifest.json
  extraction-report.json

  proxies/{name}.json
  sharedflows/{name}.json
  flowhooks/{name}.json

  kvms/
    org/{name}.json
    env/{env}/{name}.json
    proxy/{proxy}/{name}.json

  targetservers/{name}.json
  developers/{email}.json
  apps/{email}/{name}.json
  credentials/{email}/{appName}/{consumerKey}.json
  products/{name}.json

  inventories/
    proxies.json
    sharedflows.json
    targetservers.json
    developers.json
    apps.json
    credentials.json
    products.json
    developer-attributes.json
    app-attributes.json

  references/
    app-developer-map.json
    credential-app-map.json
    credential-product-map.json
    credential-continuity-index.json
    ownership-index.json
    inactive-impact.json
    subscription-intent.json
    product-proxy-map.json
    product-resolution.json
    proxy-sharedflow-map.json
    sharedflow-usage.json
    sharedflow-resolution.json
    proxy-targetserver-map.json
    targetserver-usage.json
    targetserver-resolution.json
    dangling-references.json

  _protected/
    credentials/{email}/{appName}/{consumerKey}/
      consumer-secret.txt
      secret-meta.json

  _failed-artifacts/
    proxies/{name}/
      source.zip
      error.json
    sharedflows/{name}/
      source.zip
      error.json
    kvms/.../
      source.json
      error.json
    developers/{email}/
      source.json
      error.json
    apps/{email}/{name}/
      source.json
      error.json
    products/{name}/
      source.json
      error.json
```

### 5.2 Comparative notes

Compared with the current repo extractor, these are new first-class outputs:

* `extraction-report.json`
* `credentials/`
* `inventories/`
* `references/`
* `_protected/`
* `_failed-artifacts/`

## 6. Artifact schemas

### 6.1 Common `_meta` block

Every extracted entity should include `_meta`.

```json
{
  "_meta": {
    "artifactType": "proxy",
    "artifactId": "orders-api",
    "sourcePath": "data/apiproxies/orders-api.zip",
    "extractedAt": "2026-03-30T20:00:00Z",
    "warnings": [],
    "blockers": [],
    "riskFlags": []
  }
}
```

### 6.2 Manifest

`manifest.json` remains the lightweight summary and traceability record.

Suggested fields:

* `sourceOrg`
* `sourceEnv`
* `extractedAt`
* `counts`
* `warnings`
* `errors`
* `encrypted_kvm_names`
* `failedArtifactCount`

### 6.3 Extraction report

`extraction-report.json` is the richer audit report.

Suggested sections:

* summary counts
* blockers by artifact type
* warnings by artifact type
* failed artifact list
* encrypted value list
* continuity risk summary
* inactive impact summary
* dependency resolution summary
* dangling references summary

## 7. Per-artifact expectations

### 7.1 Proxies

Each proxy IR should preserve the existing current-repo-compatible raw structure needed by Tool 2, including raw XML where available.

Additional comparative enrichment:

* `_meta` warnings/blockers/riskFlags
* extracted shared flow references
* extracted TargetServer references
* KVM write detection hints
* encrypted property hints

### 7.2 Shared flows

Each shared flow IR should preserve raw parsed content and identify:

* name
* steps
* policies
* callable reference identity

### 7.3 KVMs

KVM files preserve scope and entries exactly where possible.

Encrypted entries must be represented as:

* `value: null`
* plus a warning and manifest/report inclusion

### 7.4 TargetServers

Preserve all extracted TargetServer config fields where present:

* name
* host
* port
* SSL/TLS flags
* protocol hints
* optional derived URL if safe to compute

### 7.5 Developers

Preserve all exported developer fields exactly, including:

* email
* firstName
* lastName
* userName
* status
* attributes

Additional comparative enrichment:

* `_meta` flags such as `INACTIVE_DEVELOPER`
* attribute inventory participation

### 7.6 Apps

Preserve all exported app fields exactly, including:

* app name
* owner/developer identity
* attributes
* credentials

Additional comparative enrichment:

* `_meta`
* ownership reference links
* attribute inventory participation

### 7.7 Credentials

Credentials become first-class IR entities.

Fields should include:

* `developerEmail`
* `appName`
* `consumerKey`
* `consumerSecretPresent`
* `consumerSecretRef`
* `status`
* `apiProducts[]`
* timestamps if present
* `_meta`

### 7.8 Products

Preserve exported product fields exactly.

Additional comparative enrichment:

* proxy resolution results
* multi-proxy classification
* plan modeling hint
* blockers for missing proxy references

## 8. Relationship outputs

### 8.1 `app-developer-map.json`

Maps application identities to owning developer email.

### 8.2 `credential-app-map.json`

Maps credential identities to app identities.

### 8.3 `credential-product-map.json`

Maps each credential to source product associations.

### 8.4 `ownership-index.json`

Aggregated source access graph:

* developer
* owned apps
* credentials
* approved products
* reachable proxies

### 8.5 `dangling-references.json`

Contains unresolved references such as:

* app → missing developer
* credential → missing product
* product → missing proxy
* proxy → missing shared flow
* proxy → missing TargetServer

## 9. Failure handling

### 9.1 Failed artifacts

If an artifact cannot be parsed or normalized, Tool 1 must:

* record the error in `extraction-report.json`
* preserve the raw source under `_failed-artifacts/`
* write `error.json`
* continue processing the rest of the run

### 9.2 Local blockers vs global run status

A local blocker makes that artifact not safely auto-migratable.

It does not fail the entire extraction run.

## 10. Secret handling

Consumer secrets must not be written into normal IR files.

### Main IR

Store:

* `consumerSecretPresent`
* `consumerSecretRef`

### Protected sidecar

Write the actual secret into:

* `ir/_protected/credentials/.../consumer-secret.txt`
* `ir/_protected/credentials/.../secret-meta.json`

This keeps the main IR reviewable while preserving fidelity where needed.

## 11. Inactive developer analysis

Tool 1 must not only flag inactive developers, but also compute impact.

### Artifact-level flags

On developer:

* `INACTIVE_DEVELOPER`

On dependent apps/credentials:

* `OWNED_BY_INACTIVE_DEVELOPER`
* `CREDENTIAL_OF_INACTIVE_DEVELOPER`

### Derived output

`references/inactive-impact.json` should include:

* developer email
* apps
* credentials
* products
* reachable proxies
* impact counts
* recommended follow-up hints

Tool 1 remains advisory and does not decide final importer behavior.

## 12. Attribute inventories

### 12.1 Developer attributes

Generate `inventories/developer-attributes.json` with:

* distinct attribute names
* occurrence counts
* developer usage
* sample values
* empty vs non-empty counts
* heuristic classification
* recommended action

Possible classifications:

* `LIKELY_REQUIRED`
* `LIKELY_OPTIONAL`
* `EMPTY_ONLY`
* `HIGH_CARDINALITY`
* `POSSIBLE_SENSITIVE`

### 12.2 App attributes

Generate `inventories/app-attributes.json` with:

* distinct names
* usage counts
* apps using them
* sample values
* empty vs non-empty counts
* normalization hints
* recommended action

## 13. Credential continuity modeling

The credential is the continuity-critical unit.

Generate `references/credential-continuity-index.json` with fields such as:

* developer email
* app name
* consumer key
* secret presence
* approved products
* auth hints
* continuity risk flags

Recommended risk flags may include:

* `API_KEY_CONTINUITY_RISK`
* `OAUTH_CLIENT_CONTINUITY_RISK`
* `MULTI_PRODUCT_CREDENTIAL`

## 14. Subscription intent modeling

Tool 1 should convert raw credential-product associations into an advisory subscription plan.

Generate `references/subscription-intent.json` with:

* one record per credential
* approved products
* revoked products
* pending products
* one planned subscription intent per product
* `apiKeyModeHint`
* action hints

### Default hints

* single-product credential → `EXCLUSIVE`
* multi-product credential with same key → `SHARED`

### Default status/action hints

* `approved` → `CREATE_ACTIVE_SUBSCRIPTION`
* `revoked` → `SKIP_SUBSCRIPTION`
* `pending` → `CREATE_PENDING_SUBSCRIPTION`
* unknown → `REVIEW_REQUIRED`

These remain advisory.

## 15. Product resolution modeling

Generate:

* `references/product-proxy-map.json`
* `references/product-resolution.json`

For each product, compute:

* referenced proxies
* resolved proxies
* missing proxies
* resolution type
* recommended plan model
* warnings/blockers

### Resolution types

* `SINGLE_API`
* `MULTI_API`
* `MULTI_API_PARTIAL`
* `UNRESOLVED`

### Recommended plan model hints

* `ONE_PLAN_ON_ONE_API`
* `PLAN_SPLIT_REQUIRED`
* `REVIEW_REQUIRED`

### Multi-proxy product flags

* `MULTI_API_PRODUCT`
* `PLAN_SPLIT_REQUIRED`
* `REVIEW_REQUIRED`

### Missing proxy rule

A missing referenced proxy is a blocker on that product:

* `MISSING_REFERENCED_PROXY`

## 16. Shared flow dependency modeling

Generate:

* `references/proxy-sharedflow-map.json`
* `references/sharedflow-usage.json`
* `references/sharedflow-resolution.json`

For each proxy → shared flow reference, compute:

* shared flow name
* resolved or not
* exact reference points
* condition if present
* migration flags
* recommended follow-up

### Shared flow flags

* `SHAREDFLOW_REFERENCE`
* `MANUAL_SHARED_POLICY_GROUP_MAPPING_REQUIRED`
* `CONDITIONAL_SHAREDFLOW_REFERENCE`
* `MULTIPLE_SHAREDFLOW_INVOCATIONS`

### Missing shared flow rule

A missing referenced shared flow is a blocker on that proxy reference:

* `MISSING_REFERENCED_SHAREDFLOW`

## 17. TargetServer dependency modeling

Generate:

* `references/proxy-targetserver-map.json`
* `references/targetserver-usage.json`
* `references/targetserver-resolution.json`

For each proxy → TargetServer reference, compute:

* TargetServer name
* resolved or not
* reference points
* condition if present
* resolved config details
* bootstrap hint
* warnings/blockers

### TargetServer flags

* `TARGETSERVER_REFERENCE`
* `CONDITIONAL_TARGETSERVER_REFERENCE`
* `MULTIPLE_TARGETSERVER_REFERENCES`
* `INCOMPLETE_TARGETSERVER_CONFIGURATION`

### Missing TargetServer rule

A missing referenced TargetServer is a blocker on that proxy reference:

* `MISSING_REFERENCED_TARGETSERVER`

## 18. KVM handling

### 18.1 KVM extraction

Tool 1 preserves KVMs by scope:

* org
* environment
* proxy

### 18.2 Encrypted KVM values

Encrypted values are not recoverable from the export.

They must be represented as:

* `value: null`
* warning flags
* manifest/report inclusion
* migration hint for manual entry later

### 18.3 KVM write operations

If a `KeyValueMapOperations` policy includes `Put` or `Delete`, Tool 1 must carry forward the warning model and enrich it with review/action hints.

Recommended flags:

* `KVM_WRITE_OPERATION`
* `SEMANTIC_SHIFT_REVIEW_REQUIRED`

## 19. Warnings, blockers, and risk flags

### 19.1 Warning

A non-fatal issue that still allows extraction and may still allow migration.

Examples:

* `MULTI_API_PRODUCT`
* `SHAREDFLOW_REFERENCE`
* `TARGETSERVER_REFERENCE`
* `CONDITIONAL_SHAREDFLOW_REFERENCE`
* `KVM_WRITE_OPERATION`

### 19.2 Blocker

A local artifact condition that means the artifact is not safely auto-migratable without review.

Examples:

* `MISSING_REFERENCED_PROXY`
* `MISSING_REFERENCED_SHAREDFLOW`
* `MISSING_REFERENCED_TARGETSERVER`
* malformed or unreadable artifact

### 19.3 Risk flag

A migration-relevant classification that may or may not also be a warning/blocker.

Examples:

* `API_KEY_CONTINUITY_RISK`
* `OAUTH_CLIENT_CONTINUITY_RISK`
* `INACTIVE_DEVELOPER`
* `MULTI_PRODUCT_CREDENTIAL`
* `PLAN_SPLIT_REQUIRED`

## 20. Processing flow

### 20.1 Phase 1 — Scan source data

* discover all available artifact types
* create deterministic identity keys

### 20.2 Phase 2 — Extract raw artifacts

* proxy bundles
* shared flow bundles
* KVMs
* TargetServers
* flow hooks
* developers
* apps
* products

### 20.3 Phase 3 — Write core IR

* write raw entity files
* attach `_meta`
* preserve failures
* split secrets into protected sidecars

### 20.4 Phase 4 — Build relationship indexes

* app ownership
* credential relationships
* product links
* proxy dependency links
* dangling references

### 20.5 Phase 5 — Build inventories and derived views

* developer attribute inventory
* app attribute inventory
* inactive impact
* continuity index
* subscription intent
* product resolution
* shared flow resolution
* TargetServer resolution

### 20.6 Phase 6 — Emit reports

* manifest
* extraction report

## 21. Stable identity rules

To keep output deterministic, use these keys:

* developer: `email`
* app: `developerEmail + appName`
* credential: `developerEmail + appName + consumerKey`
* product: `productName`
* proxy: `proxyName`
* shared flow: `sharedFlowName`
* TargetServer: `targetServerName`

## 22. CLI behavior

### Exit behavior

The extractor should exit successfully if extraction completed, even when local blockers exist.

A future strict mode may fail the process when blockers are present, but that is out of scope for this first version.

### Logging

The CLI should emit structured progress and counts.

### Verbose mode

Verbose mode should include stack traces and per-artifact diagnostics.

## 23. Compatibility expectations with Tool 2

This rebuilt extractor should preserve enough of the current proxy IR shape for Tool 2 compatibility, including raw policy XML where required.

Where we intentionally diverge from the current repo, we should add data rather than remove or rename Tool 2-critical fields.

The general compatibility rule is:

* preserve existing parser-required fields
* add comparative enrichment in parallel

## 24. Out of scope for Tool 1

Tool 1 does not:

* generate final Gravitee API definitions
* create Gravitee resources
* enforce import policy
* publish plans
* create subscriptions
* validate target environment readiness
* perform LLM-assisted code translation

It may only emit advisory metadata for later tools.

## 25. Acceptance criteria

Tool 1 is complete when it can:

* read the exported `data/` structure
* write deterministic IR for all supported artifact types
* preserve malformed inputs in `_failed-artifacts`
* preserve secrets in protected sidecars only
* classify warnings/blockers/risk flags
* generate relationship indexes
* generate developer and app attribute inventories
* generate inactive impact and continuity indexes
* generate subscription-intent and product-resolution views
* generate shared flow and TargetServer resolution views
* produce `manifest.json` and `extraction-report.json`
* remain compatible with current Tool 2 parser expectations for proxy IR

## 26. Recommended implementation modules

```text
src/extractor/
  extractor.(py|js)
  schema/
    common
    proxy
    sharedflow
    kvm
    targetserver
    developer
    app
    credential
    product
  readers/
    bundle-reader
    data-dir-reader
  normalizers/
    normalize-proxy
    normalize-sharedflow
    normalize-kvm
    normalize-targetserver
    normalize-developer
    normalize-app
    normalize-credential
    normalize-product
  analyzers/
    classify-risk-flags
    detect-encrypted-values
    detect-kvm-write-ops
    analyze-inactive-impact
    analyze-product-resolution
    analyze-sharedflow-resolution
    analyze-targetserver-resolution
    build-subscription-intent
    build-continuity-index
    build-attribute-inventories
  linkers/
    build-ownership-index
    build-dangling-references
  writers/
    write-ir
    write-manifest
    write-extraction-report
    write-failed-artifact
    write-protected-secret
```

## 27. JSON schema contract for new outputs

This section defines the initial JSON contract for the new Tool 1 comparative outputs.

### 27.1 Schema conventions

All schema examples below are contract-first shapes, not full JSON Schema documents yet.

Common conventions:

* arrays default to `[]`
* optional fields may be omitted or set to `null`
* all extracted entities should include `_meta`
* warning/blocker/risk flag strings should come from centralized enums
* identity fields must use deterministic keys described in Section 21

### 27.2 Common metadata contract

```json
{
  "_meta": {
    "artifactType": "string",
    "artifactId": "string",
    "sourcePath": "string",
    "extractedAt": "ISO-8601 string",
    "warnings": ["string"],
    "blockers": ["string"],
    "riskFlags": ["string"]
  }
}
```

### 27.3 `extraction-report.json`

```json
{
  "summary": {
    "sourceOrg": "string|null",
    "sourceEnv": "string|null",
    "extractedAt": "ISO-8601 string",
    "artifactCounts": {
      "proxies": 0,
      "sharedflows": 0,
      "flowhooks": 0,
      "kvms": 0,
      "targetservers": 0,
      "developers": 0,
      "apps": 0,
      "credentials": 0,
      "products": 0,
      "failedArtifacts": 0
    }
  },
  "blockersByArtifactType": {
    "proxy": [],
    "sharedflow": [],
    "kvm": [],
    "targetserver": [],
    "developer": [],
    "app": [],
    "credential": [],
    "product": []
  },
  "warningsByArtifactType": {
    "proxy": [],
    "sharedflow": [],
    "kvm": [],
    "targetserver": [],
    "developer": [],
    "app": [],
    "credential": [],
    "product": []
  },
  "failedArtifacts": [
    {
      "artifactType": "string",
      "artifactId": "string",
      "sourcePath": "string",
      "stage": "string",
      "message": "string",
      "exceptionType": "string|null",
      "failedArtifactPath": "string"
    }
  ],
  "encryptedValueSummary": {
    "encryptedKvmEntryCount": 0,
    "artifacts": ["string"]
  },
  "continuityRiskSummary": {
    "apiKeyRiskCredentialCount": 0,
    "oauthClientRiskCredentialCount": 0,
    "credentials": ["string"]
  },
  "inactiveImpactSummary": {
    "inactiveDeveloperCount": 0,
    "affectedAppCount": 0,
    "affectedCredentialCount": 0
  },
  "dependencyResolutionSummary": {
    "missingProxyReferenceCount": 0,
    "missingSharedflowReferenceCount": 0,
    "missingTargetserverReferenceCount": 0
  },
  "danglingReferenceSummary": {
    "count": 0,
    "references": []
  }
}
```

### 27.4 Credential entity contract

Path:
`credentials/{email}/{appName}/{consumerKey}.json`

```json
{
  "developerEmail": "string",
  "appName": "string",
  "consumerKey": "string",
  "consumerSecretPresent": true,
  "consumerSecretRef": "string|null",
  "status": "string|null",
  "apiProducts": [
    {
      "name": "string",
      "status": "string|null"
    }
  ],
  "createdAt": "ISO-8601 string|null",
  "lastModifiedAt": "ISO-8601 string|null",
  "authHints": ["string"],
  "_meta": {
    "artifactType": "credential",
    "artifactId": "string",
    "sourcePath": "string",
    "extractedAt": "ISO-8601 string",
    "warnings": ["string"],
    "blockers": ["string"],
    "riskFlags": ["string"]
  }
}
```

### 27.5 `credential-continuity-index.json`

```json
{
  "credentials": [
    {
      "credentialId": "string",
      "developerEmail": "string",
      "appName": "string",
      "consumerKey": "string",
      "consumerSecretPresent": true,
      "approvedProducts": ["string"],
      "authHints": ["string"],
      "riskFlags": [
        "API_KEY_CONTINUITY_RISK",
        "OAUTH_CLIENT_CONTINUITY_RISK"
      ]
    }
  ]
}
```

### 27.6 `subscription-intent.json`

```json
{
  "credentials": [
    {
      "credentialId": "string",
      "developerEmail": "string",
      "appName": "string",
      "consumerKey": "string",
      "apiKeyModeHint": "EXCLUSIVE|SHARED|REVIEW_REQUIRED",
      "productAssociations": [
        {
          "productName": "string",
          "sourceStatus": "approved|revoked|pending|string|null",
          "recommendedAction": "CREATE_ACTIVE_SUBSCRIPTION|SKIP_SUBSCRIPTION|CREATE_PENDING_SUBSCRIPTION|CREATE_THEN_CANCEL_SUBSCRIPTION|REVIEW_REQUIRED",
          "targetStatusHint": "ACCEPTED|CLOSED|PENDING|REVIEW_REQUIRED"
        }
      ],
      "_meta": {
        "warnings": ["string"],
        "blockers": ["string"],
        "riskFlags": ["string"]
      }
    }
  ]
}
```

### 27.7 `product-resolution.json`

```json
{
  "products": [
    {
      "productName": "string",
      "referencedProxies": ["string"],
      "resolvedProxies": ["string"],
      "missingProxies": ["string"],
      "resolutionType": "SINGLE_API|MULTI_API|MULTI_API_PARTIAL|UNRESOLVED",
      "recommendedPlanModel": "ONE_PLAN_ON_ONE_API|PLAN_SPLIT_REQUIRED|REVIEW_REQUIRED",
      "_meta": {
        "warnings": ["string"],
        "blockers": ["string"],
        "riskFlags": ["string"]
      }
    }
  ]
}
```

### 27.8 `inactive-impact.json`

```json
{
  "inactiveDevelopers": [
    {
      "developerEmail": "string",
      "apps": ["string"],
      "credentials": [
        {
          "credentialId": "string",
          "consumerKey": "string",
          "products": ["string"],
          "proxies": ["string"]
        }
      ],
      "impactSummary": {
        "applicationCount": 0,
        "credentialCount": 0,
        "productCount": 0,
        "proxyCount": 0
      },
      "recommendedActions": ["string"]
    }
  ]
}
```

### 27.9 `developer-attributes.json`

```json
{
  "attributes": [
    {
      "name": "string",
      "developerCount": 0,
      "occurrenceCount": 0,
      "developers": ["string"],
      "sampleValues": ["string"],
      "emptyValueCount": 0,
      "nonEmptyValueCount": 0,
      "recommendedAction": "CREATE_CUSTOM_FIELD|REVIEW_OPTIONAL|IGNORE_EMPTY|REVIEW_REQUIRED",
      "riskFlags": ["string"]
    }
  ]
}
```

### 27.10 `app-attributes.json`

```json
{
  "attributes": [
    {
      "name": "string",
      "appCount": 0,
      "occurrenceCount": 0,
      "apps": ["string"],
      "sampleValues": ["string"],
      "emptyValueCount": 0,
      "nonEmptyValueCount": 0,
      "recommendedAction": "MAP_TO_APPLICATION_METADATA|MAP_VERBATIM|NORMALIZE_VALUE|REVIEW_REQUIRED",
      "riskFlags": ["string"]
    }
  ]
}
```

### 27.11 `sharedflow-resolution.json`

```json
{
  "references": [
    {
      "proxyName": "string",
      "sharedFlowName": "string",
      "resolved": true,
      "referencePoints": [
        {
          "flow": "string",
          "stepName": "string",
          "condition": "string|null",
          "isConditional": true
        }
      ],
      "recommendedFollowUp": "MANUAL_SHARED_POLICY_GROUP_MAPPING_REQUIRED|REVIEW_REQUIRED",
      "_meta": {
        "warnings": ["string"],
        "blockers": ["string"],
        "riskFlags": ["string"]
      }
    }
  ]
}
```

### 27.12 `targetserver-resolution.json`

```json
{
  "references": [
    {
      "proxyName": "string",
      "targetServerName": "string",
      "resolved": true,
      "referencePoints": [
        {
          "flow": "string",
          "stepName": "string",
          "condition": "string|null",
          "isConditional": false
        }
      ],
      "targetConfig": {
        "host": "string|null",
        "port": 0,
        "isSsl": true,
        "protocolHint": "http|https|string|null",
        "derivedUrl": "string|null"
      },
      "bootstrapHint": {
        "action": "CREATE_OR_RESOLVE_TARGET_SERVER|REVIEW_REQUIRED",
        "recommendedKey": "string|null"
      },
      "_meta": {
        "warnings": ["string"],
        "blockers": ["string"],
        "riskFlags": ["string"]
      }
    }
  ]
}
```

### 27.13 `dangling-references.json`

```json
{
  "references": [
    {
      "sourceArtifactType": "string",
      "sourceArtifactId": "string",
      "referenceType": "APP_OWNER|CREDENTIAL_PRODUCT|PRODUCT_PROXY|PROXY_SHAREDFLOW|PROXY_TARGETSERVER",
      "referencedId": "string",
      "severity": "warning|blocker",
      "message": "string"
    }
  ]
}
```

### 27.14 Inventory contracts

For `inventories/proxies.json`, `inventories/sharedflows.json`, `inventories/targetservers.json`, `inventories/developers.json`, `inventories/apps.json`, `inventories/credentials.json`, and `inventories/products.json`, use the same minimal shape:

```json
{
  "items": [
    {
      "id": "string",
      "name": "string",
      "sourcePath": "string",
      "warnings": ["string"],
      "blockers": ["string"],
      "riskFlags": ["string"]
    }
  ]
}
```

## 28. Enum starter set

### 28.1 Warning enum starter set

* `MULTI_API_PRODUCT`
* `PLAN_SPLIT_REQUIRED`
* `REVIEW_REQUIRED`
* `SHAREDFLOW_REFERENCE`
* `MANUAL_SHARED_POLICY_GROUP_MAPPING_REQUIRED`
* `CONDITIONAL_SHAREDFLOW_REFERENCE`
* `MULTIPLE_SHAREDFLOW_INVOCATIONS`
* `TARGETSERVER_REFERENCE`
* `CONDITIONAL_TARGETSERVER_REFERENCE`
* `MULTIPLE_TARGETSERVER_REFERENCES`
* `INCOMPLETE_TARGETSERVER_CONFIGURATION`
* `KVM_WRITE_OPERATION`
* `SEMANTIC_SHIFT_REVIEW_REQUIRED`
* `OWNED_BY_INACTIVE_DEVELOPER`
* `CREDENTIAL_OF_INACTIVE_DEVELOPER`

### 28.2 Blocker enum starter set

* `MISSING_REFERENCED_PROXY`
* `MISSING_REFERENCED_SHAREDFLOW`
* `MISSING_REFERENCED_TARGETSERVER`
* `MALFORMED_ARTIFACT`
* `UNREADABLE_ARTIFACT`
* `DUPLICATE_IDENTITY_COLLISION`

### 28.3 Risk flag enum starter set

* `API_KEY_CONTINUITY_RISK`
* `OAUTH_CLIENT_CONTINUITY_RISK`
* `INACTIVE_DEVELOPER`
* `MULTI_PRODUCT_CREDENTIAL`
* `POSSIBLE_SENSITIVE`
* `HIGH_CARDINALITY`
* `EMPTY_ONLY`

## 29. Implementation skeleton

This section translates the spec and schema contract into the first implementation layout for Tool 1.

### 29.1 Top-level package layout

```text
src/
  extractor/
    main.(py|js)
    config.(py|js)
    constants.(py|js)
    enums.(py|js)
    errors.(py|js)

    schema/
      common.(py|js)
      manifest.(py|js)
      extraction_report.(py|js)
      proxy.(py|js)
      sharedflow.(py|js)
      kvm.(py|js)
      targetserver.(py|js)
      developer.(py|js)
      app.(py|js)
      credential.(py|js)
      product.(py|js)
      inventory.(py|js)
      references.(py|js)

    readers/
      data_dir_reader.(py|js)
      proxy_reader.(py|js)
      sharedflow_reader.(py|js)
      kvm_reader.(py|js)
      targetserver_reader.(py|js)
      flowhook_reader.(py|js)
      developer_reader.(py|js)
      app_reader.(py|js)
      product_reader.(py|js)

    normalizers/
      proxy_normalizer.(py|js)
      sharedflow_normalizer.(py|js)
      kvm_normalizer.(py|js)
      targetserver_normalizer.(py|js)
      developer_normalizer.(py|js)
      app_normalizer.(py|js)
      credential_normalizer.(py|js)
      product_normalizer.(py|js)

    analyzers/
      metadata_classifier.(py|js)
      attribute_inventory_builder.(py|js)
      continuity_index_builder.(py|js)
      subscription_intent_builder.(py|js)
      inactive_impact_builder.(py|js)
      product_resolution_builder.(py|js)
      sharedflow_resolution_builder.(py|js)
      targetserver_resolution_builder.(py|js)
      dangling_reference_builder.(py|js)
      inventory_builder.(py|js)

    linkers/
      identity_builder.(py|js)
      ownership_linker.(py|js)
      credential_linker.(py|js)
      product_linker.(py|js)
      proxy_dependency_linker.(py|js)

    writers/
      json_writer.(py|js)
      manifest_writer.(py|js)
      extraction_report_writer.(py|js)
      failed_artifact_writer.(py|js)
      protected_secret_writer.(py|js)
      inventory_writer.(py|js)
      reference_writer.(py|js)

    utils/
      path_utils.(py|js)
      file_utils.(py|js)
      xml_utils.(py|js)
      zip_utils.(py|js)
      time_utils.(py|js)
      redact_utils.(py|js)
      hash_utils.(py|js)
      validation_utils.(py|js)

tests/
  extractor/
    fixtures/
    unit/
    integration/
```

### 29.2 Runtime orchestration flow

`main.(py|js)` should orchestrate the extractor in this order:

1. load config
2. scan source directories
3. initialize run context
4. read raw artifacts by type
5. normalize artifacts by type
6. write core IR entities
7. persist protected secrets
8. persist failed artifacts
9. build relationship links
10. run analyzers for inventories and derived references
11. write manifest and extraction report
12. exit with success unless a fatal runtime error occurred outside artifact handling

### 29.3 Core shared types

The implementation should define shared internal types for:

* `RunConfig`
* `RunContext`
* `ArtifactRecord`
* `FailedArtifactRecord`
* `MetaBlock`
* `WarningCode`
* `BlockerCode`
* `RiskFlagCode`

Suggested shape:

```json
{
  "RunConfig": {
    "dataDir": "string",
    "irDir": "string",
    "org": "string|null",
    "env": "string|null",
    "verbose": true
  }
}
```

### 29.4 Reader responsibilities

Readers should only:

* locate input files
* open source bundles/files
* return minimally parsed raw structures
* never apply migration policy

#### Reader contract

Each reader should expose a function shaped conceptually like:

* `readAll(config, context) -> { artifacts: [], failures: [] }`

Reader failures should not throw for artifact-local problems unless the source root itself is unreadable.

### 29.5 Normalizer responsibilities

Normalizers should:

* convert raw reader output into schema-aligned entity objects
* attach `_meta`
* derive stable IDs
* emit local warnings/blockers when source content is malformed or incomplete
* never write files directly

#### Normalizer contract

Each normalizer should expose:

* `normalize(rawArtifact, context) -> { entity, secrets?, failures? }`

### 29.6 Linker responsibilities

Linkers should build cross-entity relationships without adding target-side behavior.

Required outputs:

* app → developer
* credential → app
* credential → products
* product → proxies
* proxy → shared flows
* proxy → TargetServers

#### Linker contract

Each linker should expose:

* `link(entities, context) -> linkedOutputs`

### 29.7 Analyzer responsibilities

Analyzers should build migration-aware derived outputs from normalized entities and linked relationships.

They should not mutate the original raw entities except where adding non-destructive derived metadata is explicitly allowed.

Required analyzers:

* inventory builder
* developer attribute inventory
* app attribute inventory
* continuity index
* subscription intent
* inactive impact
* product resolution
* shared flow resolution
* TargetServer resolution
* dangling references

#### Analyzer contract

Each analyzer should expose:

* `analyze(inputs, context) -> derivedOutput`

### 29.8 Writer responsibilities

Writers should be the only layer that touches the output filesystem.

They should:

* create directories
* serialize JSON deterministically
* persist protected sidecars
* persist failed artifacts
* avoid embedding secrets in normal IR outputs

#### Writer contract

Each writer should expose:

* `write(output, context) -> void`

### 29.9 Validation utilities

Validation utilities should support:

* required-field checks
* enum membership checks
* schema-shape assertions
* deterministic-path validation
* duplicate identity collision detection

Recommended utility entry points:

* `validateEntityShape(entity, schemaName)`
* `validateEnumValue(value, enumSet)`
* `assertDeterministicPath(path)`
* `detectDuplicateIdentity(existingMap, identityKey)`

### 29.10 Filesystem conventions

All output paths must be derived from centralized path helpers.

Required helpers:

* entity file path resolution
* inventory path resolution
* reference path resolution
* protected secret path resolution
* failed artifact path resolution

This prevents drift in directory layout as tools evolve.

### 29.11 Deterministic serialization rules

JSON writers should:

* sort object keys where practical
* write arrays in deterministic order
* normalize timestamps to ISO-8601 UTC
* avoid environment-specific path separators in persisted identifiers

### 29.12 Error-handling boundaries

#### Fatal runtime errors

These may fail the process:

* unreadable `dataDir`
* unwritable `irDir`
* invalid runtime config
* catastrophic serialization failure across the whole run

#### Local artifact errors

These must not fail the process:

* malformed proxy bundle
* malformed product JSON
* missing referenced shared flow
* missing referenced TargetServer
* malformed KVM entry

These should become failed-artifact records and/or local blockers.

### 29.13 Minimal interface map

```text
main
 ├─ config
 ├─ readers/*
 ├─ normalizers/*
 ├─ linkers/*
 ├─ analyzers/*
 └─ writers/*
```

Data flow should be:

```text
raw source
 → readers
 → normalizers
 → core entities
 → linkers
 → analyzers
 → writers
 → IR output
```

## 30. First implementation slices

### Slice 1 — Scaffolding

* config loader
* enum/constants module
* path helpers
* JSON writer
* manifest writer
* extraction report writer shell

### Slice 2 — Core entity extraction

* developer reader/normalizer
* app reader/normalizer
* credential normalizer
* product reader/normalizer

### Slice 3 — Proxy dependency extraction

* proxy reader/normalizer
* shared flow reader/normalizer
* TargetServer reader/normalizer
* KVM reader/normalizer

### Slice 4 — Relationship outputs

* ownership linker
* credential linker
* product linker
* proxy dependency linker
* dangling reference builder

### Slice 5 — Derived outputs

* attribute inventories
* continuity index
* subscription intent
* inactive impact
* product resolution
* shared flow resolution
* TargetServer resolution

### Slice 6 — Failure and secret persistence

* protected secret writer
* failed artifact writer
* duplicate identity handling
* deterministic ordering cleanup

## 31. First test matrix

### 31.1 Unit tests

#### Path and identity tests

* developer identity from email
* app identity from developerEmail + appName
* credential identity from developerEmail + appName + consumerKey
* deterministic output path generation

#### Metadata classification tests

* warning enum validation
* blocker enum validation
* risk flag enum validation
* `_meta` presence on all normalized entities

#### Secret handling tests

* secret omitted from normal credential JSON
* secret written to protected sidecar path
* `consumerSecretRef` populated correctly

#### Failure persistence tests

* malformed artifact produces `error.json`
* malformed artifact source is copied to `_failed-artifacts`
* run continues after local failure

### 31.2 Integration tests

#### Happy path fixture

Input fixture containing:

* 1 proxy
* 1 shared flow
* 1 TargetServer
* 1 KVM
* 1 developer
* 1 app
* 1 credential
* 1 product

Expected outputs:

* all entity files created
* no failed artifacts
* manifest and extraction report populated
* references and inventories created

#### Partial failure fixture

Input fixture containing:

* malformed proxy bundle
* product referencing missing proxy
* proxy referencing missing shared flow
* proxy referencing missing TargetServer

Expected outputs:

* extractor exits successfully
* failed artifact preserved
* blockers present on affected derived outputs
* extraction report counts correct

#### Inactive developer fixture

Input fixture containing:

* inactive developer
* one app
* one credential
* two approved products

Expected outputs:

* inactive flags applied
* inactive-impact report lists apps, credentials, products, proxies

#### Multi-product credential fixture

Input fixture containing:

* one app with one credential approved for multiple products

Expected outputs:

* `subscription-intent.json` created with one planned subscription per product
* `apiKeyModeHint` set to `SHARED`
* `MULTI_PRODUCT_CREDENTIAL` risk flag present

#### Encrypted KVM fixture

Input fixture containing:

* encrypted KVM entry

Expected outputs:

* entry value set to `null`
* warning present
* manifest/report include encrypted entry summary

### 31.3 Regression compatibility tests

Because Tool 2 already expects the current extractor’s proxy IR shape, add regression checks that:

* proxy entity still contains current parser-required raw sections
* raw policy XML fields expected by Tool 2 remain present
* newly added comparative enrichment does not replace existing fields

## 32. Recommended immediate next implementation task

Start with **Slice 1 + Slice 2**.

That gives us the fastest path to a runnable extractor skeleton with low-dependency entities first:

* config
* enums
* writers
* developer/app/credential/product extraction

Once that is stable, the proxy-side dependency work can layer on cleanly.
