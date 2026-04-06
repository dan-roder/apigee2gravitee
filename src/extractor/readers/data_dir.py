"""
readers/data_dir.py

Walks the ./data/ directory produced by apigee-migrate-tool and normalises
all non-bundle assets (KVMs, developers, apps, products, target servers,
flow hooks) into IR dataclasses.

apigee-migrate-tool output layout (canonical):
  data/
    proxies/          {ProxyName}.zip
    sharedflows/      {SFName}.zip
    devs/
      {email}/
        {email}.json
    apps/
      {email}/
        {AppName}.json
    products/
      {ProductName}.json
    kvms/             (org-scoped KVMs live here)
      {KVMName}.json
      org/            (alternate: nested under 'org/')
        {KVMName}.json
      env/
        {envName}/
          {KVMName}.json
      proxy/
        {proxyName}/
          {KVMName}.json
    {env}-kvms/       (alternate env-kvm layout)
      {KVMName}.json
    envs/             (alternate env layout)
      {envName}/
        kvms/
          {KVMName}.json
        targetservers/
          {TSName}.json
        flowhooks/
          {HookName}.json
    targetservers/    (top-level fallback)
      {TSName}.json
    flowhooks/
      {HookName}.json

Because OPDK deployments and different tool versions produce slightly
different layouts, the reader tries all known patterns and deduplicates.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Optional

from ..schema import (
    KvmIR, KvmEntry,
    TargetServerIR, SslInfo,
    FlowHookIR,
    DeveloperIR, DeveloperAttribute,
    AppIR, AppCredential,
    ProductIR, ProductQuota,
    ExtractorManifest,
)

logger = logging.getLogger(__name__)

# ─── Filesystem helpers ───────────────────────────────────────────────────────

def _read_json(path: str) -> Optional[dict]:
    """Read and parse a JSON file; returns None and logs a warning on failure."""
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except Exception as exc:
        logger.warning("Could not read JSON at %s: %s", path, exc)
        return None


def _list_dir(path: str) -> list[str]:
    """Return absolute paths of all entries in a directory (empty list if missing)."""
    if not os.path.isdir(path):
        return []
    return [os.path.join(path, e) for e in os.listdir(path)]


def _find_files(root: str, ext: str) -> list[str]:
    """Recursively collect all files with the given extension under root."""
    results = []
    if not os.path.isdir(root):
        return results
    for dirpath, _, files in os.walk(root):
        for fname in files:
            if fname.endswith(ext):
                results.append(os.path.join(dirpath, fname))
    return results


def _find_json_documents(root: str) -> list[str]:
    """
    Recursively collect JSON documents under root.

    Supports both:
      - conventional *.json files
      - extensionless files that still contain JSON payloads
    """
    results = []
    if not os.path.isdir(root):
        return results
    for dirpath, _, files in os.walk(root):
        for fname in files:
            path = os.path.join(dirpath, fname)
            if fname.endswith('.json'):
                results.append(path)
                continue
            raw = _read_json(path)
            if raw is not None:
                results.append(path)
    return sorted(results)


# ─── ZIP discovery ────────────────────────────────────────────────────────────

def find_proxy_zips(data_dir: str) -> list[str]:
    return sorted(_find_files(os.path.join(data_dir, 'proxies'), '.zip'))


def find_sharedflow_zips(data_dir: str) -> list[str]:
    return sorted(_find_files(os.path.join(data_dir, 'sharedflows'), '.zip'))


# ─── KVM reading ──────────────────────────────────────────────────────────────

def _normalise_kvm(raw: dict, path: str, scope: str,
                   environment: Optional[str] = None,
                   proxy_name: Optional[str] = None) -> KvmIR:
    """Convert a raw apigee-migrate-tool KVM dict into KvmIR."""
    encrypted = raw.get('encrypted') in (True, 'true', 'True')
    entries = []
    for e in raw.get('entry', []):
        # Apigee omits values for encrypted entries — normalise to None
        value = None if encrypted else e.get('value')
        entries.append(KvmEntry(name=e.get('name', ''), value=value))

    return KvmIR(
        name=raw.get('name') or os.path.splitext(os.path.basename(path))[0],
        scope=scope,
        environment=environment,
        proxy_name=proxy_name,
        encrypted=encrypted,
        entries=entries,
        meta={'source_path': path},
    )


def read_org_kvms(data_dir: str) -> list[KvmIR]:
    """Collect org-scoped KVMs. Handles both flat and nested org/ layouts."""
    results = []
    seen = set()
    for kvms_dir in [os.path.join(data_dir, 'kvms'), os.path.join(data_dir, 'kvm')]:
        # Try nested org/ first, fall back to scanning top-level directory directly
        org_dir = os.path.join(kvms_dir, 'org')
        search_dir = org_dir if os.path.isdir(org_dir) else kvms_dir

        for f in _find_json_documents(search_dir):
            raw = _read_json(f)
            if raw:
                key = raw.get('name') or os.path.splitext(os.path.basename(f))[0]
                if key in seen:
                    continue
                seen.add(key)
                results.append(_normalise_kvm(raw, f, scope='org'))
    return results


def read_env_kvms(data_dir: str) -> list[KvmIR]:
    """
    Collect environment-scoped KVMs.
    Handles three layout variants produced by different tool versions.
    """
    seen: set[str] = set()
    results: list[KvmIR] = []

    def _add(kvm: KvmIR):
        key = f"{kvm.scope}/{kvm.environment}/{kvm.name}"
        if key not in seen:
            seen.add(key)
            results.append(kvm)

    # Pattern 1: data/{env}-kvms/{KVMName}.json
    for entry in _list_dir(data_dir):
        base = os.path.basename(entry)
        if base.endswith('-kvms') and os.path.isdir(entry):
            env = base[:-len('-kvms')]
            for f in _find_files(entry, '.json'):
                raw = _read_json(f)
                if raw:
                    _add(_normalise_kvm(raw, f, scope='env', environment=env))

    # Pattern 2: data/envs/{env}/kvms/{KVMName}.json
    envs_dir = os.path.join(data_dir, 'envs')
    for env_entry in _list_dir(envs_dir):
        if not os.path.isdir(env_entry):
            continue
        env = os.path.basename(env_entry)
        for f in _find_files(os.path.join(env_entry, 'kvms'), '.json'):
            raw = _read_json(f)
            if raw:
                _add(_normalise_kvm(raw, f, scope='env', environment=env))

    # Pattern 3: data/kvms/env/{env}/{KVMName}.json
    for kvms_root in [os.path.join(data_dir, 'kvms'), os.path.join(data_dir, 'kvm')]:
        kvms_env_dir = os.path.join(kvms_root, 'env')
        for env_entry in _list_dir(kvms_env_dir):
            if not os.path.isdir(env_entry):
                continue
            env = os.path.basename(env_entry)
            for f in _find_json_documents(env_entry):
                raw = _read_json(f)
                if raw:
                    _add(_normalise_kvm(raw, f, scope='env', environment=env))

    return results


def read_proxy_kvms(data_dir: str) -> list[KvmIR]:
    """Collect proxy-scoped KVMs from data/kvms/proxy/{proxyName}/ or data/kvm/proxy/{proxyName}/."""
    results = []
    seen = set()
    for proxy_kvm_dir in [os.path.join(data_dir, 'kvms', 'proxy'), os.path.join(data_dir, 'kvm', 'proxy')]:
        for proxy_entry in _list_dir(proxy_kvm_dir):
            if not os.path.isdir(proxy_entry):
                continue
            proxy_name = os.path.basename(proxy_entry)
            for f in _find_json_documents(proxy_entry):
                raw = _read_json(f)
                if raw:
                    key = f'{proxy_name}/{raw.get("name") or os.path.splitext(os.path.basename(f))[0]}'
                    if key in seen:
                        continue
                    seen.add(key)
                    results.append(_normalise_kvm(raw, f, scope='proxy', proxy_name=proxy_name))
    return results


# ─── Target Server reading ────────────────────────────────────────────────────

def _normalise_target_server(raw: dict, path: str) -> TargetServerIR:
    ssl_raw = raw.get('sSLInfo') or raw.get('sslInfo') or {}
    ssl_enabled = ssl_raw.get('enabled') in (True, 'true', 'True')
    ssl_info = None
    if ssl_raw:
        ssl_info = SslInfo(
            enabled=ssl_enabled,
            trust_store=ssl_raw.get('trustStore', ''),
            client_auth_enabled=ssl_raw.get('clientAuthEnabled') in (True, 'true'),
            key_store=ssl_raw.get('keyStore', ''),
            key_alias=ssl_raw.get('keyAlias', ''),
        )
    return TargetServerIR(
        name=raw.get('name') or os.path.splitext(os.path.basename(path))[0],
        host=raw.get('host', ''),
        port=int(raw.get('port', 443)),
        is_enabled=raw.get('isEnabled', True) not in (False, 'false', 'False'),
        ssl_enabled=ssl_enabled,
        ssl_info=ssl_info,
        meta={'source_path': path},
    )


def read_target_servers(data_dir: str) -> list[TargetServerIR]:
    """
    Collect target servers. Checks both top-level data/targetservers/
    and per-env data/envs/{env}/targetservers/.
    """
    seen: set[str] = set()
    results: list[TargetServerIR] = []

    def _add(ts: TargetServerIR):
        if ts.name not in seen:
            seen.add(ts.name)
            results.append(ts)

    # Top-level
    for f in _find_json_documents(os.path.join(data_dir, 'targetservers')):
        raw = _read_json(f)
        if raw:
            _add(_normalise_target_server(raw, f))

    # Per-env
    for env_entry in _list_dir(os.path.join(data_dir, 'envs')):
        if not os.path.isdir(env_entry):
            continue
        for f in _find_json_documents(os.path.join(env_entry, 'targetservers')):
            raw = _read_json(f)
            if raw:
                _add(_normalise_target_server(raw, f))

    return results


# ─── Flow Hook reading ────────────────────────────────────────────────────────

def _normalise_flow_hook(raw: dict, path: str, environment: str = '') -> FlowHookIR:
    # apigee-migrate-tool uses the filename as the hook name
    hook_name = os.path.splitext(os.path.basename(path))[0]
    return FlowHookIR(
        hook_name=hook_name,
        environment=environment,
        shared_flow=raw.get('sharedFlow', ''),
        continue_on_error=raw.get('continueOnError', True) not in (False, 'false', 'False'),
        description=raw.get('description', ''),
        meta={'source_path': path},
    )


def _normalise_flow_hook_config(raw: dict, path: str, environment: str = '') -> list[FlowHookIR]:
    hooks = []
    for hook_name in ('PreProxyFlowHook', 'PostProxyFlowHook', 'PreTargetFlowHook', 'PostTargetFlowHook'):
        shared_flow = raw.get(hook_name, '')
        if not shared_flow:
            continue
        hooks.append(FlowHookIR(
            hook_name=hook_name,
            environment=environment,
            shared_flow=shared_flow,
            continue_on_error=True,
            description='',
            meta={'source_path': path},
        ))
    return hooks


def read_flow_hooks(data_dir: str) -> list[FlowHookIR]:
    """Collect flow hooks from top-level and per-env directories."""
    seen: set[str] = set()
    results: list[FlowHookIR] = []

    def _add(fh: FlowHookIR):
        key = f"{fh.environment}/{fh.hook_name}"
        if key not in seen:
            seen.add(key)
            results.append(fh)

    # Top-level data/flowhooks/
    for f in _find_json_documents(os.path.join(data_dir, 'flowhooks')):
        raw = _read_json(f)
        if raw:
            if any(key in raw for key in ('PreProxyFlowHook', 'PostProxyFlowHook', 'PreTargetFlowHook', 'PostTargetFlowHook')):
                for hook in _normalise_flow_hook_config(raw, f):
                    _add(hook)
            else:
                _add(_normalise_flow_hook(raw, f))

    # Per-env data/envs/{env}/flowhooks/
    for env_entry in _list_dir(os.path.join(data_dir, 'envs')):
        if not os.path.isdir(env_entry):
            continue
        env = os.path.basename(env_entry)
        for f in _find_json_documents(os.path.join(env_entry, 'flowhooks')):
            raw = _read_json(f)
            if raw:
                if any(key in raw for key in ('PreProxyFlowHook', 'PostProxyFlowHook', 'PreTargetFlowHook', 'PostTargetFlowHook')):
                    for hook in _normalise_flow_hook_config(raw, f, environment=env):
                        _add(hook)
                else:
                    _add(_normalise_flow_hook(raw, f, environment=env))

    return results


# ─── Developer reading ────────────────────────────────────────────────────────

def _normalise_developer(raw: dict, path: str) -> DeveloperIR:
    attrs = [
        DeveloperAttribute(name=a.get('name', ''), value=a.get('value', ''))
        for a in raw.get('attributes', [])
    ]
    return DeveloperIR(
        email=raw.get('email', ''),
        first_name=raw.get('firstName', ''),
        last_name=raw.get('lastName', ''),
        user_name=raw.get('userName') or raw.get('email', ''),
        status=raw.get('status', 'active').lower(),
        attributes=attrs,
        apps=raw.get('apps', []),
        meta={'source_path': path},
    )


def read_developers(data_dir: str) -> list[DeveloperIR]:
    results = []
    for f in _find_json_documents(os.path.join(data_dir, 'devs')):
        raw = _read_json(f)
        if raw:
            results.append(_normalise_developer(raw, f))
    return results


# ─── App reading ──────────────────────────────────────────────────────────────

def _normalise_app(raw: dict, path: str, developer_email: str) -> AppIR:
    attrs = [
        DeveloperAttribute(name=a.get('name', ''), value=a.get('value', ''))
        for a in raw.get('attributes', [])
    ]
    credentials = []
    for cred in raw.get('credentials', []):
        credentials.append(AppCredential(
            consumer_key=cred.get('consumerKey', ''),
            consumer_secret=cred.get('consumerSecret', ''),
            status=cred.get('status', 'approved').lower(),
            expires_at=int(cred.get('expiresAt', -1)),
            scopes=cred.get('scopes', []),
            api_products=[
                {'apiproduct': p.get('apiproduct', ''), 'status': p.get('status', 'approved')}
                for p in cred.get('apiProducts', [])
            ],
        ))
    return AppIR(
        name=raw.get('name') or os.path.splitext(os.path.basename(path))[0],
        app_id=raw.get('appId', ''),
        developer_email=developer_email,
        status=raw.get('status', 'approved').lower(),
        callback_url=raw.get('callbackUrl', ''),
        attributes=attrs,
        credentials=credentials,
        meta={'source_path': path},
    )


def read_apps(data_dir: str) -> list[AppIR]:
    results = []
    apps_dir = os.path.join(data_dir, 'apps')
    for dev_dir in _list_dir(apps_dir):
        if not os.path.isdir(dev_dir):
            continue
        developer_email = os.path.basename(dev_dir)
        for f in _find_json_documents(dev_dir):
            raw = _read_json(f)
            if raw:
                results.append(_normalise_app(raw, f, developer_email))
    return results


# ─── Product reading ──────────────────────────────────────────────────────────

def _normalise_product(raw: dict, path: str) -> ProductIR:
    quota: Optional[ProductQuota] = None
    if raw.get('quota'):
        quota = ProductQuota(
            limit=str(raw.get('quota', '')),
            interval=str(raw.get('quotaInterval', '')),
            time_unit=raw.get('quotaTimeUnit', ''),
        )

    attrs = [
        DeveloperAttribute(name=a.get('name', ''), value=a.get('value', ''))
        for a in raw.get('attributes', [])
    ]

    return ProductIR(
        name=raw.get('name') or os.path.splitext(os.path.basename(path))[0],
        display_name=raw.get('displayName', ''),
        description=raw.get('description', ''),
        approval_type=raw.get('approvalType', 'auto').lower(),
        quota=quota,
        scopes=[scope for scope in raw.get('scopes', []) if scope],
        environments=raw.get('environments', []),
        proxies=raw.get('proxies', []),
        attributes=attrs,
        meta={'source_path': path},
    )


def read_products(data_dir: str) -> list[ProductIR]:
    results = []
    for f in _find_json_documents(os.path.join(data_dir, 'products')):
        raw = _read_json(f)
        if raw:
            results.append(_normalise_product(raw, f))
    return results
