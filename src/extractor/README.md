# apigee-gravitee-migrator — Extractor

**Phase 1 of the migration pipeline.** Reads the `./data/` directory produced by
[apigee-migrate-tool](https://github.com/apigeecs/apigee-migrate-tool) and writes a
structured **Intermediate Representation (IR)** to `./ir/` as plain JSON files.

The IR is the single handoff point between the Python extractor and every downstream
Node.js module (parser, mapper, importer, gap reporter).

---

## Architecture

```
apigee-migrate-tool
  └── data/               ← input: Apigee OPDK export

bin/migrator.js           ← Node.js CLI (spawns Python extractor, streams progress)
src/extractor/
  extractor.py            ← orchestrator: walks data/, calls readers, writes IR
  schema.py               ← dataclass definitions (single source of truth for IR shape)
  writer.py               ← serialises IR objects to ./ir/ directory tree
  readers/
    bundle.py             ← parses proxy/sharedflow ZIP bundles
    data_dir.py           ← reads KVMs, target servers, flow hooks, devs, apps, products

ir/                       ← output: Intermediate Representation
  manifest.json
  proxies/{name}.json
  sharedflows/{name}.json
  kvms/org/{name}.json
  kvms/env/{env}/{name}.json
  kvms/proxy/{proxy}/{name}.json
  targetservers/{name}.json
  flowhooks/{name}.json
  developers/{email}.json
  apps/{email}/{name}.json
  products/{name}.json
```

### Why Python for the extractor?

The extractor is purely I/O and parsing work — walking ZIP files, parsing XML,
reading JSON. Python's stdlib covers all of it (`zipfile`, `xml.etree.ElementTree`,
`json`, `os.walk`) with no dependencies. The rest of the pipeline (policy mapping,
API definition building, Gravitee Management API calls) stays in Node.js.

The two halves communicate via the IR on disk; the Node CLI wrapper streams the
extractor's JSON progress lines and pretty-prints them to the terminal.

---

## Usage

### Prerequisites

- Python 3.9+
- Node.js 18+ (for the CLI wrapper; not required to run the extractor directly)
- `apigee-migrate-tool` export already run — `./data/` directory present

### Run via Node CLI

```bash
node bin/migrator.js extract \
  --data-dir ./data \
  --ir-dir   ./ir \
  --org      advana \
  --env      dev

# With verbose output (Python logging + full tracebacks on errors)
node bin/migrator.js extract --data-dir ./data --ir-dir ./ir -v
```

### Run the Python extractor directly

```bash
python3 -m src.extractor.extractor \
  --data-dir ./data \
  --ir-dir   ./ir \
  --org      advana \
  --env      dev

# Each stdout line is a JSON progress/status object:
# {"type": "progress", "label": "proxies", "current": 3, "total": 12, "pct": 25}
# {"type": "warn",     "msg": "KVM 'org-secrets' is encrypted ..."}
# {"type": "done",     "proxies": 12, "kvms": 8, "encryptedKvms": 1, ...}
```

---

## IR Schema

All IR files are UTF-8 JSON. `null` fields are omitted.

### `ir/manifest.json`
```json
{
  "source_data_dir": "/path/to/data",
  "extracted_at": "2026-03-18T14:00:00Z",
  "org": "advana",
  "environment": "dev",
  "proxy_count": 12,
  "sharedflow_count": 3,
  "kvm_count": 8,
  "developer_count": 47,
  "app_count": 63,
  "product_count": 9,
  "target_server_count": 4,
  "flow_hook_count": 2,
  "proxy_names": ["orders-api", "payments-api", ...],
  "sharedflow_names": ["security-common", ...],
  "encrypted_kvm_names": ["org:org-secrets", "env:prod-credentials"],
  "warnings": ["KVM 'org-secrets' is encrypted ...", "write-order-cache performs Put ..."],
  "errors": []
}
```

### `ir/proxies/{name}.json`
```json
{
  "type": "proxy",
  "name": "orders-api",
  "revision": "3",
  "display_name": "Orders API",
  "description": "Handles order management",
  "base_path": "/v1/orders",
  "policies": {
    "verify-api-key": {
      "name": "verify-api-key",
      "policy_type": "VerifyAPIKey",
      "enabled": true,
      "raw_xml": "<VerifyAPIKey ...>...</VerifyAPIKey>",
      "raw_dict": { "_tag": "VerifyAPIKey", "_attrs": {...}, "_children": [...] },
      "resource_urls": []
    }
  },
  "proxy_endpoints": [{
    "name": "default",
    "connection": { "base_path": "/v1/orders", "virtual_hosts": ["secure"] },
    "pre_flow": {
      "request": [{ "name": "verify-api-key", "condition": "" }],
      "response": []
    },
    "flows": [{
      "name": "GetOrders",
      "condition": "request.verb = \"GET\"",
      "request": [{ "name": "lookup-env-config", "condition": "" }],
      "response": []
    }],
    "post_flow": { "request": [], "response": [] },
    "route_rules": [{ "name": "default", "condition": "", "target": "default" }]
  }],
  "target_endpoints": [{
    "name": "default",
    "connection": {
      "url": "",
      "load_balancer": {
        "algorithm": "RoundRobin",
        "servers": [{ "name": "orders-backend-primary", "weight": 2, "is_enabled": true }]
      },
      "ssl_info": { "enabled": true, "trust_store": "truststore1" }
    }
  }],
  "resources": { "jsc/validate-order.js": "var body = ..." },
  "kvm_refs": [{
    "policy_name": "write-order-cache",
    "map_identifier": "order-cache",
    "scope": "apiproxy",
    "operations": ["Put"],
    "flagged": true
  }],
  "shared_flow_refs": [],
  "target_server_refs": ["orders-backend-primary", "orders-backend-secondary"]
}
```

### `ir/kvms/org/{name}.json`
```json
{
  "name": "org-secrets",
  "scope": "org",
  "encrypted": true,
  "entries": [
    { "name": "internal-api-key", "value": null },
    { "name": "signing-secret",   "value": null }
  ]
}
```
> ⚠️ Encrypted KVM entries always have `value: null` — Apigee's management API does
> not expose encrypted values. These must be re-entered manually in Gravitee.

---

## Tests

```bash
python3 -m unittest test.test_extractor -v
```

91 tests covering:
- Bundle ZIP parsing (proxy and sharedflow)
- All policy types, enabled flag, resource URLs, raw XML preservation
- ProxyEndpoint: connection, pre/named/post flows, step conditions, route rules
- TargetEndpoint: URL, load balancer (algorithm, servers, weights), SSL info
- Cross-cutting refs: KVM flagging (write ops), shared flow refs, target server refs
- Data directory readers: all three KVM scope patterns, both env layout variants
- IR writer: correct output paths for all IR types, valid JSON output
- End-to-end: `run_extraction()` against fixture data, manifest correctness
- Edge cases: bad ZIP, malformed XML, missing directories, None exclusion in JSON

---

## What the extractor does NOT do

These are intentional — handled by downstream modules:

- **No Gravitee API calls** — the extractor is read-only against the Apigee export
- **No policy translation** — `raw_xml` and `raw_dict` are preserved verbatim for the Node mapper
- **No gap analysis** — warnings are recorded in the manifest; the gap reporter generates the full HTML report
- **No encrypted KVM value recovery** — values are `null`; the manifest lists them for manual follow-up
