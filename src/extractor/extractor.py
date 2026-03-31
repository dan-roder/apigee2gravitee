"""
extractor.py

Main entry point for the extractor phase of apigee2gravitee.

Usage (called by the Node.js CLI wrapper):
  python3 -m src.extractor.extractor --data-dir ./data --ir-dir ./ir [--org advana] [--env dev]

Or directly:
  python3 src/extractor/extractor.py --data-dir ./data --ir-dir ./ir

Reads everything from the apigee-migrate-tool ./data/ directory and writes
the full Intermediate Representation to ./ir/.

Exit codes:
  0  — success (warnings may exist, check manifest.json)
  1  — one or more bundles failed to parse (errors logged; other assets written)
  2  — fatal error (data-dir not found, permission error, etc.)
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import os
import sys
import traceback
from typing import Optional

# Allow running as a script or as a module
if __package__ is None:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
    from src.extractor.readers.bundle import parse_bundle
    from src.extractor.readers.data_dir import (
        find_proxy_zips, find_sharedflow_zips,
        read_org_kvms, read_env_kvms, read_proxy_kvms,
        read_target_servers, read_flow_hooks,
        read_developers, read_apps, read_products,
    )
    from src.extractor.writer import IrWriter
    from src.extractor.schema import (
        ExtractorManifest, MetaBlock, CredentialIR, CredentialProduct, FailedArtifactRecord,
    )
    from src.extractor.context import RunConfig, RunContext
    from src.extractor.paths import credential_identity
    from src.extractor.linkers import build_relationships
    from src.extractor.analyzers import build_inventories, build_derived_outputs, build_extraction_report
else:
    from .readers.bundle import parse_bundle
    from .readers.data_dir import (
        find_proxy_zips, find_sharedflow_zips,
        read_org_kvms, read_env_kvms, read_proxy_kvms,
        read_target_servers, read_flow_hooks,
        read_developers, read_apps, read_products,
    )
    from .writer import IrWriter
    from .schema import (
        ExtractorManifest, MetaBlock, CredentialIR, CredentialProduct, FailedArtifactRecord,
    )
    from .context import RunConfig, RunContext
    from .paths import credential_identity
    from .linkers import build_relationships
    from .analyzers import build_inventories, build_derived_outputs, build_extraction_report


# ─── Logging ─────────────────────────────────────────────────────────────────

def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter('[%(levelname)s] %(message)s'))
    logging.root.setLevel(level)
    logging.root.handlers = [handler]


log = logging.getLogger(__name__)


def _meta_for(artifact_type: str, artifact_id: str, source_path: str, extracted_at: str) -> MetaBlock:
    return MetaBlock(
        artifact_type=artifact_type,
        artifact_id=artifact_id,
        source_path=os.path.abspath(source_path),
        extracted_at=extracted_at,
    )


def _mark_unique(entities, key_fn):
    seen = set()
    for entity in entities:
        key = key_fn(entity)
        if key in seen and entity._meta:
            entity._meta.blockers.append('DUPLICATE_IDENTITY_COLLISION')
        else:
            seen.add(key)


def _attach_standard_metadata(manifest, extracted_at, bundles, sharedflows, kvms, targetservers, flowhooks, developers, apps, products):
    for bundle in bundles:
        bundle._meta = _meta_for('proxy', bundle.name, bundle.meta.get('source_zip', bundle.name), extracted_at)
        if bundle.shared_flow_refs:
            bundle._meta.warnings.extend(['SHAREDFLOW_REFERENCE', 'MANUAL_SHARED_POLICY_GROUP_MAPPING_REQUIRED'])
        if bundle.target_server_refs:
            bundle._meta.warnings.append('TARGETSERVER_REFERENCE')
        if len(bundle.target_server_refs) > 1:
            bundle._meta.warnings.append('MULTIPLE_TARGETSERVER_REFERENCES')
        if any(ref.flagged for ref in bundle.kvm_refs):
            bundle._meta.warnings.extend(['KVM_WRITE_OPERATION', 'SEMANTIC_SHIFT_REVIEW_REQUIRED'])
            for ref in bundle.kvm_refs:
                if ref.flagged:
                    manifest.warnings.append(
                        f"proxy:{bundle.name} — KeyValueMapOperations policy "
                        f"'{ref.policy_name}' performs write operations on "
                        f"KVM '{ref.map_identifier}' (scope: {ref.scope}). "
                        f"Map to Data Cache policy in Gravitee."
                    )

    for bundle in sharedflows:
        bundle._meta = _meta_for('sharedflow', bundle.name, bundle.meta.get('source_zip', bundle.name), extracted_at)

    for kvm in kvms:
        kvm._meta = _meta_for('kvm', f'{kvm.scope}:{kvm.name}', kvm.meta.get('source_path', kvm.name), extracted_at)
        if kvm.encrypted:
            kvm._meta.warnings.append('REVIEW_REQUIRED')
            manifest.encrypted_kvm_names.append(f"{kvm.scope}:{kvm.name}")
            manifest.warnings.append(
                f"KVM '{kvm.name}' (scope: {kvm.scope}) is encrypted. "
                f"Values are not accessible via the Apigee management API and "
                f"must be re-entered manually in Gravitee."
            )

    for server in targetservers:
        server._meta = _meta_for('targetserver', server.name, server.meta.get('source_path', server.name), extracted_at)
        if not server.host:
            server._meta.warnings.append('INCOMPLETE_TARGETSERVER_CONFIGURATION')

    for hook in flowhooks:
        hook_id = f'{hook.environment}/{hook.hook_name}' if hook.environment else hook.hook_name
        hook._meta = _meta_for('flowhook', hook_id, hook.meta.get('source_path', hook_id), extracted_at)

    for developer in developers:
        developer._meta = _meta_for('developer', developer.email, developer.meta.get('source_path', developer.email), extracted_at)
        if developer.status != 'active':
            developer._meta.risk_flags.append('INACTIVE_DEVELOPER')

    for app in apps:
        app_id = f'{app.developer_email}/{app.name}'
        app._meta = _meta_for('app', app_id, app.meta.get('source_path', app_id), extracted_at)

    for product in products:
        product._meta = _meta_for('product', product.name, product.meta.get('source_path', product.name), extracted_at)
        if len(product.proxies) > 1:
            product._meta.warnings.extend(['MULTI_API_PRODUCT', 'PLAN_SPLIT_REQUIRED'])

    _mark_unique(developers, lambda item: item.email)
    _mark_unique(apps, lambda item: f'{item.developer_email}/{item.name}')
    _mark_unique(products, lambda item: item.name)


def _build_credentials(apps, extracted_at):
    credentials = []
    for app in apps:
        for cred in app.credentials:
            secret_ref = os.path.join(
                '_protected', 'credentials', app.developer_email, app.name, cred.consumer_key, 'consumer-secret.txt'
            )
            cred.consumer_secret_present = bool(cred.consumer_secret)
            cred.consumer_secret_ref = secret_ref if cred.consumer_secret else None
            api_products = [
                CredentialProduct(name=product.get('apiproduct', ''), status=product.get('status'))
                for product in cred.api_products
            ]
            auth_hints = ['API_KEY']
            risk_flags = ['API_KEY_CONTINUITY_RISK']
            if len(api_products) > 1:
                risk_flags.append('MULTI_PRODUCT_CREDENTIAL')
            credential = CredentialIR(
                developer_email=app.developer_email,
                app_name=app.name,
                consumer_key=cred.consumer_key,
                consumer_secret_present=bool(cred.consumer_secret),
                consumer_secret_ref=secret_ref if cred.consumer_secret else None,
                status=cred.status,
                api_products=api_products,
                auth_hints=auth_hints,
                meta={'source_path': app.meta.get('source_path', '')},
                _meta=_meta_for(
                    'credential',
                    credential_identity(app.developer_email, app.name, cred.consumer_key),
                    app.meta.get('source_path', ''),
                    extracted_at,
                ),
            )
            credential._meta.risk_flags.extend(risk_flags)
            credentials.append(credential)
    _mark_unique(credentials, lambda item: credential_identity(item.developer_email, item.app_name, item.consumer_key))
    return credentials


def _propagate_inactive_flags(developers, apps, credentials):
    inactive = {developer.email for developer in developers if developer.status != 'active'}
    for app in apps:
        if app.developer_email in inactive and app._meta:
            app._meta.warnings.append('OWNED_BY_INACTIVE_DEVELOPER')
    for credential in credentials:
        if credential.developer_email in inactive and credential._meta:
            credential._meta.warnings.append('CREDENTIAL_OF_INACTIVE_DEVELOPER')


# ─── Progress reporter ────────────────────────────────────────────────────────

class Progress:
    """Simple stdout progress reporter that the Node CLI can parse."""

    def step(self, label: str, current: int, total: int) -> None:
        pct = int(100 * current / total) if total else 100
        print(json.dumps({
            'type': 'progress',
            'label': label,
            'current': current,
            'total': total,
            'pct': pct,
        }), flush=True)

    def info(self, msg: str, **kwargs) -> None:
        print(json.dumps({'type': 'info', 'msg': msg, **kwargs}), flush=True)

    def warn(self, msg: str, **kwargs) -> None:
        print(json.dumps({'type': 'warn', 'msg': msg, **kwargs}), flush=True)
        log.warning(msg)

    def error(self, msg: str, **kwargs) -> None:
        print(json.dumps({'type': 'error', 'msg': msg, **kwargs}), flush=True)
        log.error(msg)

    def done(self, manifest_path: str, stats: dict) -> None:
        print(json.dumps({'type': 'done', 'manifest': manifest_path, **stats}), flush=True)


# ─── Core extraction logic ────────────────────────────────────────────────────

def run_extraction(
    data_dir: str,
    ir_dir: str,
    org: str = '',
    environment: str = '',
    verbose: bool = False,
) -> int:
    """
    Main extraction logic.
    Returns exit code: 0=success, 1=partial failure, 2=fatal.
    """
    _setup_logging(verbose)
    progress = Progress()

    if not os.path.isdir(data_dir):
        progress.error(f"data-dir not found: {data_dir}")
        return 2

    writer = IrWriter(ir_dir)
    extracted_at = datetime.datetime.utcnow().isoformat() + 'Z'
    run_context = RunContext(
        config=RunConfig(data_dir=data_dir, ir_dir=ir_dir, org=org, environment=environment, verbose=verbose),
        extracted_at=extracted_at,
    )
    manifest = ExtractorManifest(
        source_data_dir=os.path.abspath(data_dir),
        extracted_at=extracted_at,
        org=org,
        environment=environment,
    )
    manifest._proxy_entities = []
    manifest._sharedflow_entities = []
    manifest._kvm_entities = []
    manifest._targetserver_entities = []
    manifest._developer_entities = []
    manifest._app_entities = []
    manifest._product_entities = []

    # ── 1. Proxy bundles ──────────────────────────────────────────────────────
    proxy_zips = find_proxy_zips(data_dir)
    manifest.proxy_count = len(proxy_zips)
    progress.info(f"Found {len(proxy_zips)} proxy bundle(s)")
    proxies = []

    for i, zip_path in enumerate(proxy_zips, 1):
        proxy_name = os.path.splitext(os.path.basename(zip_path))[0]
        progress.step('proxies', i, len(proxy_zips))
        try:
            bundle = parse_bundle(zip_path)
            manifest.proxy_names.append(bundle.name)
            proxies.append(bundle)
        except Exception as exc:
            msg = f"Failed to parse proxy bundle {proxy_name}: {exc}"
            manifest.errors.append(msg)
            progress.error(msg, proxy=proxy_name)
            failure = FailedArtifactRecord(
                artifact_type='proxies',
                artifact_id=proxy_name,
                source_path=os.path.abspath(zip_path),
                stage='parse-bundle',
                message=msg,
                exception_type=type(exc).__name__,
            )
            failure.failed_artifact_path = writer.write_failed_artifact(
                'proxies',
                proxy_name,
                zip_path,
                failure.to_dict(),
            )
            run_context.failures.append(failure)
            if verbose:
                traceback.print_exc(file=sys.stderr)

    # ── 2. Shared flow bundles ────────────────────────────────────────────────
    sf_zips = find_sharedflow_zips(data_dir)
    manifest.sharedflow_count = len(sf_zips)
    progress.info(f"Found {len(sf_zips)} shared flow bundle(s)")
    sharedflows = []

    for i, zip_path in enumerate(sf_zips, 1):
        sf_name = os.path.splitext(os.path.basename(zip_path))[0]
        progress.step('sharedflows', i, len(sf_zips))
        try:
            bundle = parse_bundle(zip_path)
            manifest.sharedflow_names.append(bundle.name)
            sharedflows.append(bundle)
        except Exception as exc:
            msg = f"Failed to parse shared flow bundle {sf_name}: {exc}"
            manifest.errors.append(msg)
            progress.error(msg, sharedflow=sf_name)
            failure = FailedArtifactRecord(
                artifact_type='sharedflows',
                artifact_id=sf_name,
                source_path=os.path.abspath(zip_path),
                stage='parse-bundle',
                message=msg,
                exception_type=type(exc).__name__,
            )
            failure.failed_artifact_path = writer.write_failed_artifact(
                'sharedflows',
                sf_name,
                zip_path,
                failure.to_dict(),
            )
            run_context.failures.append(failure)
            if verbose:
                traceback.print_exc(file=sys.stderr)

    # ── 3. KVMs ───────────────────────────────────────────────────────────────
    all_kvms = read_org_kvms(data_dir) + read_env_kvms(data_dir) + read_proxy_kvms(data_dir)
    manifest.kvm_count = len(all_kvms)
    progress.info(f"Found {len(all_kvms)} KVM(s)")
    kvms = all_kvms

    # ── 4. Target Servers ─────────────────────────────────────────────────────
    target_servers = read_target_servers(data_dir)
    manifest.target_server_count = len(target_servers)
    progress.info(f"Found {len(target_servers)} target server(s)")

    # ── 5. Flow Hooks ─────────────────────────────────────────────────────────
    flow_hooks = read_flow_hooks(data_dir)
    manifest.flow_hook_count = len(flow_hooks)
    progress.info(f"Found {len(flow_hooks)} flow hook(s)")

    # ── 6. Developers ─────────────────────────────────────────────────────────
    developers = read_developers(data_dir)
    manifest.developer_count = len(developers)
    progress.info(f"Found {len(developers)} developer(s)")

    # ── 7. Apps ───────────────────────────────────────────────────────────────
    apps = read_apps(data_dir)
    manifest.app_count = len(apps)
    progress.info(f"Found {len(apps)} app(s)")

    # ── 8. Products ───────────────────────────────────────────────────────────
    products = read_products(data_dir)
    manifest.product_count = len(products)
    progress.info(f"Found {len(products)} product(s)")
    _attach_standard_metadata(
        manifest, extracted_at, proxies, sharedflows, kvms, target_servers, flow_hooks, developers, apps, products
    )
    credentials = _build_credentials(apps, extracted_at)
    _propagate_inactive_flags(developers, apps, credentials)
    manifest.credential_count = len(credentials)
    manifest.failed_artifact_count = len(run_context.failures)
    manifest._proxy_entities = proxies
    manifest._sharedflow_entities = sharedflows
    manifest._kvm_entities = kvms
    manifest._targetserver_entities = target_servers
    manifest._developer_entities = developers
    manifest._app_entities = apps
    manifest._product_entities = products

    for collection, write_fn, name_fn in (
        (proxies, writer.write_bundle, lambda item: item.name),
        (sharedflows, writer.write_bundle, lambda item: item.name),
        (kvms, writer.write_kvm, lambda item: f'{item.scope}/{item.name}'),
        (target_servers, writer.write_target_server, lambda item: item.name),
        (flow_hooks, writer.write_flow_hook, lambda item: item.hook_name),
        (developers, writer.write_developer, lambda item: item.email),
        (apps, writer.write_app, lambda item: item.name),
        (products, writer.write_product, lambda item: item.name),
    ):
        for entity in collection:
            try:
                write_fn(entity)
            except Exception as exc:
                msg = f"Failed to write {entity.__class__.__name__} {name_fn(entity)}: {exc}"
                manifest.errors.append(msg)
                progress.error(msg)

    for credential in credentials:
        try:
            writer.write_credential(credential)
            for app in apps:
                if app.developer_email == credential.developer_email and app.name == credential.app_name:
                    for nested in app.credentials:
                        if nested.consumer_key == credential.consumer_key and nested.consumer_secret:
                            writer.write_secret_sidecar(
                                credential.developer_email,
                                credential.app_name,
                                credential.consumer_key,
                                nested.consumer_secret,
                                {
                                    'developerEmail': credential.developer_email,
                                    'appName': credential.app_name,
                                    'consumerKey': credential.consumer_key,
                                },
                            )
        except Exception as exc:
            msg = f"Failed to write credential {credential.consumer_key}: {exc}"
            manifest.errors.append(msg)
            progress.error(msg)

    linkers = build_relationships(
        developers, apps, credentials, products, proxies, sharedflows, target_servers
    )
    inventories = build_inventories(
        proxies, sharedflows, target_servers, developers, apps, credentials, products
    )
    derived_outputs = build_derived_outputs(
        developers, apps, credentials, products, proxies, sharedflows, target_servers
    )

    for name, payload in inventories.items():
        writer.write_inventory(name, payload)
    for name, payload in {**linkers, **derived_outputs}.items():
        writer.write_reference(name, payload)

    extraction_report = build_extraction_report(
        manifest, credentials, run_context.failures, linkers, derived_outputs
    )
    writer.write_extraction_report(extraction_report)

    # ── 9. Manifest ───────────────────────────────────────────────────────────
    manifest_path = writer.write_manifest(manifest)

    # Summary to stdout for Node CLI to capture
    progress.done(manifest_path, {
        'proxies': manifest.proxy_count,
        'sharedflows': manifest.sharedflow_count,
        'kvms': manifest.kvm_count,
        'targetServers': manifest.target_server_count,
        'flowHooks': manifest.flow_hook_count,
        'developers': manifest.developer_count,
        'apps': manifest.app_count,
        'credentials': manifest.credential_count,
        'products': manifest.product_count,
        'encryptedKvms': len(manifest.encrypted_kvm_names),
        'warnings': len(manifest.warnings),
        'errors': len(manifest.errors),
    })

    return 0


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Extract Apigee OPDK data/ export into the migrator Intermediate Representation (IR).',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 -m src.extractor.extractor --data-dir ./data --ir-dir ./ir
  python3 -m src.extractor.extractor --data-dir ./data --ir-dir ./ir --org advana --env dev -v

Output:
  All IR JSON files are written to --ir-dir.
  Each line of stdout is a JSON progress/status object consumed by the Node CLI.
  Warnings and errors are also recorded in ir/manifest.json.
        """,
    )
    parser.add_argument('--data-dir', required=True,
                        help='Path to the apigee-migrate-tool data/ directory')
    parser.add_argument('--ir-dir', required=True,
                        help='Output directory for IR JSON files')
    parser.add_argument('--org', default='',
                        help='Apigee org name (informational, recorded in manifest)')
    parser.add_argument('--env', default='',
                        help='Apigee environment name (informational)')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='Enable debug logging and full tracebacks')

    args = parser.parse_args()

    exit_code = run_extraction(
        data_dir=args.data_dir,
        ir_dir=args.ir_dir,
        org=args.org,
        environment=args.env,
        verbose=args.verbose,
    )
    sys.exit(exit_code)


if __name__ == '__main__':
    main()
