"""
writer.py

Serialises all IR objects to the ./ir/ directory tree.

Output layout:
  ir/
    manifest.json
    proxies/
      {name}.json
    sharedflows/
      {name}.json
    kvms/
      org/
        {name}.json
      env/
        {environment}/
          {name}.json
      proxy/
        {proxy_name}/
          {name}.json
    targetservers/
      {name}.json
    flowhooks/
      {hook_name}.json          (or {env}__{hook_name}.json for env-scoped)
    developers/
      {email}.json
    apps/
      {developer_email}/
        {app_name}.json
    products/
      {name}.json

All files are UTF-8 JSON with 2-space indentation.
"""

from __future__ import annotations

import json
import os
import shutil
from typing import Any

from .schema import (
    BundleIR, KvmIR, TargetServerIR, FlowHookIR,
    DeveloperIR, AppIR, ProductIR, ExtractorManifest, CredentialIR, to_json,
)
from .paths import (
    safe_filename, join_safe, credential_file_path, protected_secret_dir, failed_artifact_dir,
)


def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(content)


class IrWriter:
    MANAGED_OUTPUTS = (
        '_failed-artifacts',
        '_protected',
        'apps',
        'credentials',
        'developers',
        'flowhooks',
        'inventories',
        'kvms',
        'products',
        'proxies',
        'references',
        'sharedflows',
        'targetservers',
        'extraction-report.json',
        'manifest.json',
    )

    def __init__(self, ir_dir: str):
        self.ir_dir = os.path.abspath(ir_dir)

    def _path(self, *parts: str) -> str:
        return join_safe(self.ir_dir, *parts)

    def clean_managed_outputs(self) -> None:
        os.makedirs(self.ir_dir, exist_ok=True)
        for relative_path in self.MANAGED_OUTPUTS:
            target = self._path(relative_path)
            if os.path.isdir(target):
                shutil.rmtree(target)
            elif os.path.exists(target):
                os.remove(target)

    # ── Bundles ───────────────────────────────────────────────────────────────

    def write_bundle(self, bundle: BundleIR) -> str:
        subdir = 'proxies' if bundle.type == 'proxy' else 'sharedflows'
        dest = self._path(subdir, f'{bundle.name}.json')
        _write(dest, to_json(bundle))
        return dest

    # ── KVMs ─────────────────────────────────────────────────────────────────

    def write_kvm(self, kvm: KvmIR) -> str:
        if kvm.scope == 'org':
            dest = self._path('kvms', 'org', f'{kvm.name}.json')
        elif kvm.scope == 'env':
            env = kvm.environment or 'unknown'
            dest = self._path('kvms', 'env', env, f'{kvm.name}.json')
        elif kvm.scope == 'proxy':
            proxy = kvm.proxy_name or 'unknown'
            dest = self._path('kvms', 'proxy', proxy, f'{kvm.name}.json')
        else:
            dest = self._path('kvms', 'other', f'{kvm.name}.json')
        _write(dest, to_json(kvm))
        return dest

    # ── Target Servers ────────────────────────────────────────────────────────

    def write_target_server(self, ts: TargetServerIR) -> str:
        dest = self._path('targetservers', f'{ts.name}.json')
        _write(dest, to_json(ts))
        return dest

    # ── Flow Hooks ────────────────────────────────────────────────────────────

    def write_flow_hook(self, fh: FlowHookIR) -> str:
        fname = (
            f'{fh.environment}__{fh.hook_name}.json'
            if fh.environment
            else f'{fh.hook_name}.json'
        )
        dest = self._path('flowhooks', fname)
        _write(dest, to_json(fh))
        return dest

    # ── Developers ────────────────────────────────────────────────────────────

    def write_developer(self, dev: DeveloperIR) -> str:
        dest = self._path('developers', f'{dev.email}.json')
        _write(dest, to_json(dev))
        return dest

    # ── Apps ──────────────────────────────────────────────────────────────────

    def write_app(self, app: AppIR) -> str:
        dest = self._path('apps', app.developer_email, f'{app.name}.json')
        app_payload = json.loads(to_json(app))
        for credential in app_payload.get('credentials', []):
            secret = credential.pop('consumer_secret', '')
            credential['consumer_secret_present'] = bool(secret)
            if secret and not credential.get('consumer_secret_ref'):
                credential['consumer_secret_ref'] = None
        _write(dest, json.dumps(app_payload, indent=2, sort_keys=True))
        return dest

    def write_credential(self, credential: CredentialIR) -> str:
        dest = credential_file_path(
            self.ir_dir, credential.developer_email, credential.app_name, credential.consumer_key
        )
        _write(dest, to_json(credential))
        return dest

    # ── Products ──────────────────────────────────────────────────────────────

    def write_product(self, product: ProductIR) -> str:
        dest = self._path('products', f'{product.name}.json')
        _write(dest, to_json(product))
        return dest

    # ── Manifest ──────────────────────────────────────────────────────────────

    def write_manifest(self, manifest: ExtractorManifest) -> str:
        dest = os.path.join(self.ir_dir, 'manifest.json')
        _write(dest, to_json(manifest))
        return dest

    def write_extraction_report(self, report: dict) -> str:
        dest = os.path.join(self.ir_dir, 'extraction-report.json')
        _write(dest, json.dumps(report, indent=2, sort_keys=True))
        return dest

    def write_inventory(self, name: str, payload: dict) -> str:
        dest = self._path('inventories', f'{name}.json')
        _write(dest, json.dumps(payload, indent=2, sort_keys=True))
        return dest

    def write_reference(self, name: str, payload: dict) -> str:
        dest = self._path('references', f'{name}.json')
        _write(dest, json.dumps(payload, indent=2, sort_keys=True))
        return dest

    def write_secret_sidecar(
        self,
        developer_email: str,
        app_name: str,
        consumer_key: str,
        consumer_secret: str,
        meta: dict,
    ) -> str:
        secret_dir = protected_secret_dir(self.ir_dir, developer_email, app_name, consumer_key)
        os.makedirs(secret_dir, exist_ok=True)
        secret_path = os.path.join(secret_dir, 'consumer-secret.txt')
        meta_path = os.path.join(secret_dir, 'secret-meta.json')
        _write(secret_path, consumer_secret)
        _write(meta_path, json.dumps(meta, indent=2, sort_keys=True))
        return secret_dir

    def write_failed_artifact(self, artifact_type: str, artifact_id: str, source_path: str, error_payload: dict) -> str:
        dest_dir = failed_artifact_dir(self.ir_dir, artifact_type, artifact_id)
        os.makedirs(dest_dir, exist_ok=True)
        source_basename = safe_filename(os.path.basename(source_path))
        source_dest = os.path.join(dest_dir, source_basename)
        with open(source_path, 'rb') as src, open(source_dest, 'wb') as dst:
            dst.write(src.read())
        _write(os.path.join(dest_dir, 'error.json'), json.dumps(error_payload, indent=2, sort_keys=True))
        return dest_dir
