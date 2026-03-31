"""
schema.py

Dataclass definitions for the Intermediate Representation (IR).

These are the authoritative shapes written to ./ir/ by the extractor
and consumed by every downstream Node.js module (parser, mapper, importer).

The IR is intentionally verbose — it preserves everything from the Apigee
export so that downstream modules can make informed decisions without
re-parsing the source files.

JSON serialisation: call ir_to_dict(obj) or dataclasses.asdict(obj).
"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any, Optional
import json


@dataclass
class MetaBlock:
    artifact_type: str
    artifact_id: str
    source_path: str
    extracted_at: str
    warnings: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    risk_flags: list[str] = field(default_factory=list)


# ─── Primitives ───────────────────────────────────────────────────────────────

@dataclass
class Step:
    """A single step inside a flow pipeline (request or response side)."""
    name: str
    condition: str = ""


@dataclass
class FlowPipeline:
    """One side (request or response) of a PreFlow, Flow, or PostFlow."""
    request: list[Step] = field(default_factory=list)
    response: list[Step] = field(default_factory=list)


@dataclass
class NamedFlow:
    """A conditional named flow inside an endpoint."""
    name: str
    condition: str = ""
    request: list[Step] = field(default_factory=list)
    response: list[Step] = field(default_factory=list)


@dataclass
class RouteRule:
    name: str
    condition: str = ""
    target: str = ""          # TargetEndpoint name


# ─── Endpoints ────────────────────────────────────────────────────────────────

@dataclass
class ProxyConnection:
    base_path: str = "/"
    virtual_hosts: list[str] = field(default_factory=list)


@dataclass
class LoadBalancerServer:
    name: str                 # TargetServer name reference
    weight: int = 1
    is_enabled: bool = True


@dataclass
class LoadBalancer:
    algorithm: str = "RoundRobin"
    servers: list[LoadBalancerServer] = field(default_factory=list)
    max_failures: int = 0
    retry_enabled: bool = True


@dataclass
class SslInfo:
    enabled: bool = False
    trust_store: str = ""
    client_auth_enabled: bool = False
    key_store: str = ""
    key_alias: str = ""


@dataclass
class TargetConnection:
    url: str = ""
    load_balancer: Optional[LoadBalancer] = None
    ssl_info: Optional[SslInfo] = None
    properties: dict[str, str] = field(default_factory=dict)


@dataclass
class ProxyEndpoint:
    name: str
    connection: ProxyConnection = field(default_factory=ProxyConnection)
    pre_flow: FlowPipeline = field(default_factory=FlowPipeline)
    flows: list[NamedFlow] = field(default_factory=list)
    post_flow: FlowPipeline = field(default_factory=FlowPipeline)
    route_rules: list[RouteRule] = field(default_factory=list)


@dataclass
class TargetEndpoint:
    name: str
    connection: TargetConnection = field(default_factory=TargetConnection)
    pre_flow: FlowPipeline = field(default_factory=FlowPipeline)
    flows: list[NamedFlow] = field(default_factory=list)
    post_flow: FlowPipeline = field(default_factory=FlowPipeline)


# ─── Policies ─────────────────────────────────────────────────────────────────

@dataclass
class Policy:
    """
    Single Apigee policy extracted from a bundle.

    `raw_xml` is the full policy XML as a string — passed to the Node.js
    mapper verbatim so it can extract any policy-type-specific fields it needs
    without us having to anticipate every policy attribute here.

    `raw_dict` is the parsed XML as a plain dict (via ET) for quick access
    to top-level attributes without re-parsing in Node.
    """
    name: str
    policy_type: str          # e.g. 'AssignMessage', 'OAuthV2', 'JavaScript'
    enabled: bool = True
    raw_xml: str = ""
    raw_dict: dict = field(default_factory=dict)
    resource_urls: list[str] = field(default_factory=list)   # e.g. ['jsc/my-script.js']


# ─── Cross-cutting references ─────────────────────────────────────────────────

@dataclass
class KvmRef:
    """KVM referenced by a KeyValueMapOperations policy in a bundle."""
    policy_name: str
    map_identifier: str
    scope: str                # 'apiproxy' | 'environment' | 'organization'
    operations: list[str]     # subset of ['Get', 'Put', 'Delete']
    flagged: bool = False     # True if any write (Put/Delete) operation present


# ─── Bundle IR ────────────────────────────────────────────────────────────────

@dataclass
class BundleIR:
    """
    Complete IR for a single proxy or sharedflow bundle.
    Written to ir/proxies/{name}.json or ir/sharedflows/{name}.json.
    """
    type: str                 # 'proxy' | 'sharedflow'
    name: str
    revision: str = ""
    display_name: str = ""
    description: str = ""
    base_path: str = ""       # from descriptor BasePaths element

    policies: dict[str, Policy] = field(default_factory=dict)
    proxy_endpoints: list[ProxyEndpoint] = field(default_factory=list)
    target_endpoints: list[TargetEndpoint] = field(default_factory=list)
    resources: dict[str, str] = field(default_factory=dict)   # path → content / '<binary>'

    # Cross-cutting refs (derived, for quick access by downstream modules)
    kvm_refs: list[KvmRef] = field(default_factory=list)
    shared_flow_refs: list[str] = field(default_factory=list)  # FlowCallout targets
    target_server_refs: list[str] = field(default_factory=list)

    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


# ─── KVM IR ───────────────────────────────────────────────────────────────────

@dataclass
class KvmEntry:
    name: str
    value: Optional[str]       # None for encrypted entries


@dataclass
class KvmIR:
    """
    Complete IR for a single KVM (any scope).
    Written to ir/kvms/{scope}/{name}.json.
    """
    name: str
    scope: str                 # 'org' | 'env' | 'proxy'
    environment: Optional[str] = None
    proxy_name: Optional[str] = None
    encrypted: bool = False
    entries: list[KvmEntry] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


# ─── Target Server IR ─────────────────────────────────────────────────────────

@dataclass
class TargetServerIR:
    """
    Written to ir/targetservers/{name}.json.
    """
    name: str
    host: str = ""
    port: int = 443
    is_enabled: bool = True
    ssl_enabled: bool = False
    ssl_info: Optional[SslInfo] = None
    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


# ─── Flow Hook IR ─────────────────────────────────────────────────────────────

@dataclass
class FlowHookIR:
    """
    Written to ir/flowhooks/{hook_name}.json.
    Hook names: PreProxyFlowHook | PostProxyFlowHook |
                PreTargetFlowHook | PostTargetFlowHook
    """
    hook_name: str
    environment: str = ""
    shared_flow: str = ""
    continue_on_error: bool = True
    description: str = ""
    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


# ─── Developer / App / Product IR ─────────────────────────────────────────────

@dataclass
class DeveloperAttribute:
    name: str
    value: str = ""


@dataclass
class DeveloperIR:
    """Written to ir/developers/{email}.json."""
    email: str
    first_name: str = ""
    last_name: str = ""
    user_name: str = ""
    status: str = "active"
    attributes: list[DeveloperAttribute] = field(default_factory=list)
    apps: list[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


@dataclass
class AppCredential:
    consumer_key: str
    consumer_secret: str
    consumer_secret_present: bool = False
    consumer_secret_ref: Optional[str] = None
    status: str = "approved"
    expires_at: int = -1      # -1 = never
    scopes: list[str] = field(default_factory=list)
    api_products: list[dict] = field(default_factory=list)  # [{apiproduct, status}]


@dataclass
class AppIR:
    """Written to ir/apps/{developer_email}/{app_name}.json."""
    name: str
    app_id: str = ""
    developer_email: str = ""
    status: str = "approved"
    callback_url: str = ""
    attributes: list[DeveloperAttribute] = field(default_factory=list)
    credentials: list[AppCredential] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


@dataclass
class ProductQuota:
    limit: str = ""
    interval: str = ""
    time_unit: str = ""       # minute | hour | day | month


@dataclass
class ProductIR:
    """Written to ir/products/{name}.json."""
    name: str
    display_name: str = ""
    description: str = ""
    approval_type: str = "auto"   # auto | manual
    quota: Optional[ProductQuota] = None
    scopes: list[str] = field(default_factory=list)
    environments: list[str] = field(default_factory=list)
    proxies: list[str] = field(default_factory=list)      # proxy names
    attributes: list[DeveloperAttribute] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


@dataclass
class CredentialProduct:
    name: str
    status: Optional[str] = None


@dataclass
class CredentialIR:
    developer_email: str
    app_name: str
    consumer_key: str
    consumer_secret_present: bool = False
    consumer_secret_ref: Optional[str] = None
    status: Optional[str] = None
    api_products: list[CredentialProduct] = field(default_factory=list)
    created_at: Optional[str] = None
    last_modified_at: Optional[str] = None
    auth_hints: list[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    _meta: Optional[MetaBlock] = None


@dataclass
class FailedArtifactRecord:
    artifact_type: str
    artifact_id: str
    source_path: str
    stage: str
    message: str
    exception_type: Optional[str] = None
    failed_artifact_path: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            'artifactType': self.artifact_type,
            'artifactId': self.artifact_id,
            'sourcePath': self.source_path,
            'stage': self.stage,
            'message': self.message,
            'exceptionType': self.exception_type,
            'failedArtifactPath': self.failed_artifact_path,
        }


# ─── Top-level IR manifest ────────────────────────────────────────────────────

@dataclass
class ExtractorManifest:
    """
    Written to ir/manifest.json.
    Describes what was extracted and flags any issues found.
    """
    source_data_dir: str
    extracted_at: str
    org: str = ""
    environment: str = ""

    # Counts
    proxy_count: int = 0
    sharedflow_count: int = 0
    kvm_count: int = 0
    developer_count: int = 0
    app_count: int = 0
    credential_count: int = 0
    product_count: int = 0
    target_server_count: int = 0
    flow_hook_count: int = 0
    failed_artifact_count: int = 0

    # Issues for the gap reporter
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    # Quick-access lists for downstream tools
    proxy_names: list[str] = field(default_factory=list)
    sharedflow_names: list[str] = field(default_factory=list)
    encrypted_kvm_names: list[str] = field(default_factory=list)


# ─── Serialisation helpers ────────────────────────────────────────────────────

def _clean(obj):
    """
    Recursively convert dataclass instances to plain dicts,
    dropping keys whose value is None (keeps JSON output clean).
    """
    if hasattr(obj, '__dataclass_fields__'):
        data = {}
        for k, v in asdict(obj).items():
            if v is None:
                continue
            if k == '_meta':
                data['_meta'] = {
                    'artifactType': v['artifact_type'],
                    'artifactId': v['artifact_id'],
                    'sourcePath': v['source_path'],
                    'extractedAt': v['extracted_at'],
                    'warnings': v['warnings'],
                    'blockers': v['blockers'],
                    'riskFlags': v['risk_flags'],
                }
            else:
                data[k] = _clean(v)
        return data
    if isinstance(obj, list):
        return [_clean(i) for i in obj]
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if v is not None}
    return obj


def to_json(obj, indent: int = 2) -> str:
    """Serialise any IR dataclass (or dict/list) to a JSON string."""
    return json.dumps(_clean(obj), indent=indent, default=str, sort_keys=True)
