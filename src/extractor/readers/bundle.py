"""
readers/bundle.py

Parses a single Apigee proxy or sharedflow ZIP into a BundleIR.

Bundle ZIP structure:
  apiproxy/                        (or sharedflowbundle/ for shared flows)
    {ProxyName}.xml                ← descriptor: name, revision, description, base paths
    proxies/
      default.xml                  ← ProxyEndpoint(s)
    targets/
      default.xml                  ← TargetEndpoint(s)
    policies/
      {PolicyName}.xml             ← one file per policy
    resources/
      jsc/{script}.js
      java/{jar}.jar
      xsl/{transform}.xsl
      py/{script}.py
"""

from __future__ import annotations

import os
import re
import zipfile
from pathlib import PurePosixPath
from typing import Optional
import xml.etree.ElementTree as ET

from ..schema import (
    BundleIR, Policy, ProxyEndpoint, TargetEndpoint,
    ProxyConnection, TargetConnection, LoadBalancer, LoadBalancerServer,
    SslInfo, FlowPipeline, NamedFlow, RouteRule, Step, KvmRef,
)

# Resource file extensions we store as text; everything else → '<binary>'
_TEXT_EXTS = {'.js', '.py', '.xsl', '.xslt', '.xml', '.json', '.txt', '.properties', '.wsdl'}


# ─── XML helpers ──────────────────────────────────────────────────────────────

def _text(el: Optional[ET.Element], tag: str, fallback: str = '') -> str:
    """Get stripped text of the first child matching tag, or fallback."""
    if el is None:
        return fallback
    child = el.find(tag)
    return (child.text or '').strip() if child is not None else fallback


def _attr(el: Optional[ET.Element], name: str, fallback: str = '') -> str:
    if el is None:
        return fallback
    return (el.get(name) or fallback).strip()


def _children(el: Optional[ET.Element], tag: str) -> list[ET.Element]:
    if el is None:
        return []
    return el.findall(tag)


def _el_to_dict(el: ET.Element) -> dict:
    """
    Shallow-convert an XML element into a plain dict suitable for embedding
    in the IR JSON.  Captures tag, attributes, text, and one level of children.
    Downstream Node modules receive the raw_xml string for full fidelity;
    this dict is just for quick attribute access without re-parsing.
    """
    return {
        '_tag': el.tag,
        '_attrs': dict(el.attrib),
        '_text': (el.text or '').strip(),
        '_children': [
            {'_tag': c.tag, '_attrs': dict(c.attrib), '_text': (c.text or '').strip()}
            for c in el
        ],
    }


# ─── Step / Flow parsing ──────────────────────────────────────────────────────

def _parse_steps(pipeline_el: Optional[ET.Element]) -> list[Step]:
    if pipeline_el is None:
        return []
    steps = []
    for step_el in pipeline_el.findall('Step'):
        name = _text(step_el, 'Name').strip()
        if not name:
            continue
        condition = _text(step_el, 'Condition').strip()
        steps.append(Step(name=name, condition=condition))
    return steps


def _parse_pipeline(endpoint_el: ET.Element, container_tag: str) -> FlowPipeline:
    """Parse a PreFlow / PostFlow element into a FlowPipeline."""
    container = endpoint_el.find(container_tag)
    if container is None:
        return FlowPipeline()
    return FlowPipeline(
        request=_parse_steps(container.find('Request')),
        response=_parse_steps(container.find('Response')),
    )


def _parse_flows(endpoint_el: ET.Element) -> list[NamedFlow]:
    flows_el = endpoint_el.find('Flows')
    if flows_el is None:
        return []
    result = []
    for flow_el in flows_el.findall('Flow'):
        result.append(NamedFlow(
            name=_attr(flow_el, 'name'),
            condition=_text(flow_el, 'Condition').strip(),
            request=_parse_steps(flow_el.find('Request')),
            response=_parse_steps(flow_el.find('Response')),
        ))
    return result


# ─── Endpoint parsing ─────────────────────────────────────────────────────────

def _parse_proxy_endpoint(xml_str: str, file_name: str) -> ProxyEndpoint:
    root = ET.fromstring(xml_str)
    name = root.get('name') or os.path.splitext(file_name)[0]

    conn_el = root.find('HTTPProxyConnection')
    connection = ProxyConnection(
        base_path=_text(conn_el, 'BasePath', '/'),
        virtual_hosts=[vh.text.strip() for vh in _children(conn_el, 'VirtualHost') if vh.text],
    )

    route_rules = []
    for rr in root.findall('RouteRule'):
        route_rules.append(RouteRule(
            name=rr.get('name', ''),
            condition=_text(rr, 'Condition', '').strip(),
            target=_text(rr, 'TargetEndpoint', '').strip(),
        ))

    return ProxyEndpoint(
        name=name,
        connection=connection,
        pre_flow=_parse_pipeline(root, 'PreFlow'),
        flows=_parse_flows(root),
        post_flow=_parse_pipeline(root, 'PostFlow'),
        route_rules=route_rules,
    )


def _parse_ssl_info(ssl_el: Optional[ET.Element]) -> Optional[SslInfo]:
    if ssl_el is None:
        return None
    return SslInfo(
        enabled=_text(ssl_el, 'Enabled', 'false').lower() == 'true',
        trust_store=_text(ssl_el, 'TrustStore', ''),
        client_auth_enabled=_text(ssl_el, 'ClientAuthEnabled', 'false').lower() == 'true',
        key_store=_text(ssl_el, 'KeyStore', ''),
        key_alias=_text(ssl_el, 'KeyAlias', ''),
    )


def _parse_load_balancer(lb_el: Optional[ET.Element]) -> Optional[LoadBalancer]:
    if lb_el is None:
        return None
    servers = []
    for s in lb_el.findall('Server'):
        servers.append(LoadBalancerServer(
            name=s.get('name', ''),
            weight=int(_text(s, 'Weight', '1') or 1),
            is_enabled=_text(s, 'IsEnabled', 'true').lower() != 'false',
        ))
    return LoadBalancer(
        algorithm=_text(lb_el, 'Algorithm', 'RoundRobin'),
        servers=servers,
        max_failures=int(_text(lb_el, 'MaxFailures', '0') or 0),
        retry_enabled=_text(lb_el, 'RetryEnabled', 'true').lower() != 'false',
    )


def _parse_target_endpoint(xml_str: str, file_name: str) -> TargetEndpoint:
    root = ET.fromstring(xml_str)
    name = root.get('name') or os.path.splitext(file_name)[0]

    conn_el = root.find('HTTPTargetConnection')
    connection = TargetConnection()
    if conn_el is not None:
        props = {}
        props_el = conn_el.find('Properties')
        if props_el is not None:
            for p in props_el.findall('Property'):
                pname = p.get('name', '')
                if pname:
                    props[pname] = (p.text or '').strip()

        connection = TargetConnection(
            url=_text(conn_el, 'URL', '').strip(),
            load_balancer=_parse_load_balancer(conn_el.find('LoadBalancer')),
            ssl_info=_parse_ssl_info(conn_el.find('SSLInfo')),
            properties=props,
        )

    return TargetEndpoint(
        name=name,
        connection=connection,
        pre_flow=_parse_pipeline(root, 'PreFlow'),
        flows=_parse_flows(root),
        post_flow=_parse_pipeline(root, 'PostFlow'),
    )


# ─── Policy parsing ───────────────────────────────────────────────────────────

def _parse_policy(xml_str: str, file_name: str) -> Policy:
    root = ET.fromstring(xml_str)
    policy_type = root.tag          # The root element IS the policy type
    name = root.get('name') or os.path.splitext(file_name)[0]
    enabled = root.get('enabled', 'true').lower() != 'false'

    # Collect ResourceURL references (JavaScript, JavaCallout, XSL, etc.)
    resource_urls = []
    for el in root.iter('ResourceURL'):
        if el.text:
            # Normalise 'jsc://my-script.js' → 'jsc/my-script.js'
            ref = re.sub(r'://', '/', el.text.strip())
            if ref:
                resource_urls.append(ref)

    return Policy(
        name=name,
        policy_type=policy_type,
        enabled=enabled,
        raw_xml=xml_str,
        raw_dict=_el_to_dict(root),
        resource_urls=resource_urls,
    )


# ─── Cross-cutting reference extraction ──────────────────────────────────────

def _extract_kvm_refs(policies: dict[str, Policy]) -> list[KvmRef]:
    refs = []
    for policy in policies.values():
        if policy.policy_type != 'KeyValueMapOperations':
            continue
        root = ET.fromstring(policy.raw_xml)
        map_identifier = (
            root.get('mapIdentifier')
            or _text(root, 'MapName', '')
            or ''
        ).strip()
        scope = (root.get('scope') or 'apiproxy').strip()
        operations = []
        if root.find('Get') is not None:
            operations.append('Get')
        if root.find('Put') is not None:
            operations.append('Put')
        if root.find('Delete') is not None:
            operations.append('Delete')

        refs.append(KvmRef(
            policy_name=policy.name,
            map_identifier=map_identifier,
            scope=scope,
            operations=operations,
            flagged=any(op in operations for op in ('Put', 'Delete')),
        ))
    return refs


def _extract_shared_flow_refs(policies: dict[str, Policy]) -> list[str]:
    refs = set()
    for policy in policies.values():
        if policy.policy_type != 'FlowCallout':
            continue
        root = ET.fromstring(policy.raw_xml)
        sf_name = _text(root, 'SharedFlowBundle', '').strip()
        if sf_name:
            refs.add(sf_name)
    return sorted(refs)


def _extract_target_server_refs(target_endpoints: list[TargetEndpoint]) -> list[str]:
    refs = set()
    for te in target_endpoints:
        if te.connection.load_balancer:
            for server in te.connection.load_balancer.servers:
                if server.name:
                    refs.add(server.name)
    return sorted(refs)


# ─── Top-level bundle parser ──────────────────────────────────────────────────

def parse_bundle(zip_path: str) -> BundleIR:
    """
    Parse a single proxy or sharedflow ZIP into a BundleIR.

    Raises:
        ValueError  — unrecognised bundle structure
        ET.ParseError — malformed XML inside the bundle
    """
    import datetime

    with zipfile.ZipFile(zip_path, 'r') as zf:
        names = zf.namelist()

        # Determine bundle type and root prefix
        if any(n.startswith('apiproxy/') for n in names):
            bundle_type = 'proxy'
            root_prefix = 'apiproxy'
        elif any(n.startswith('sharedflowbundle/') for n in names):
            bundle_type = 'sharedflow'
            root_prefix = 'sharedflowbundle'
        else:
            raise ValueError(
                f"{zip_path}: unrecognised bundle structure "
                f"(no apiproxy/ or sharedflowbundle/ top-level directory)"
            )

        def read(path: str) -> str:
            return zf.read(path).decode('utf-8', errors='replace')

        def read_dir(prefix: str) -> dict[str, str]:
            """Return {relative_name: content} for all files under prefix/."""
            p = prefix.rstrip('/') + '/'
            result = {}
            for name in names:
                if name.startswith(p) and not name.endswith('/'):
                    rel = name[len(p):]
                    if rel:
                        result[rel] = read(name)
            return result

        # ── Descriptor ──────────────────────────────────────────────────────
        # Descriptor is the single .xml directly under root_prefix/
        descriptor_path = next(
            (n for n in names
             if n.startswith(root_prefix + '/')
             and n.count('/') == 1
             and n.endswith('.xml')),
            None
        )
        if not descriptor_path:
            raise ValueError(f"{zip_path}: no descriptor XML found under {root_prefix}/")

        desc_xml = read(descriptor_path)
        desc_root = ET.fromstring(desc_xml)
        bundle_name = os.path.splitext(os.path.basename(descriptor_path))[0]
        revision = desc_root.get('revision', '')
        display_name = _text(desc_root, 'DisplayName', bundle_name)
        description = _text(desc_root, 'Description', '')
        base_path = _text(desc_root, 'BasePaths', '')

        # ── Policies ────────────────────────────────────────────────────────
        policy_files = read_dir(f'{root_prefix}/policies')
        policies: dict[str, Policy] = {}
        for fname, xml_str in policy_files.items():
            if not fname.endswith('.xml'):
                continue
            policy = _parse_policy(xml_str, fname)
            policies[policy.name] = policy

        # ── ProxyEndpoints (proxy only) ──────────────────────────────────
        proxy_endpoints: list[ProxyEndpoint] = []
        if bundle_type == 'proxy':
            for fname, xml_str in read_dir(f'{root_prefix}/proxies').items():
                if fname.endswith('.xml'):
                    proxy_endpoints.append(_parse_proxy_endpoint(xml_str, fname))

        # ── TargetEndpoints (proxy only) ─────────────────────────────────
        target_endpoints: list[TargetEndpoint] = []
        if bundle_type == 'proxy':
            for fname, xml_str in read_dir(f'{root_prefix}/targets').items():
                if fname.endswith('.xml'):
                    target_endpoints.append(_parse_target_endpoint(xml_str, fname))

        # ── Resources ───────────────────────────────────────────────────
        resources: dict[str, str] = {}
        for fpath, content in read_dir(f'{root_prefix}/resources').items():
            ext = os.path.splitext(fpath)[1].lower()
            resources[fpath] = content if ext in _TEXT_EXTS else '<binary>'

        # ── Cross-cutting refs ───────────────────────────────────────────
        kvm_refs = _extract_kvm_refs(policies)
        shared_flow_refs = _extract_shared_flow_refs(policies)
        target_server_refs = _extract_target_server_refs(target_endpoints)

    return BundleIR(
        type=bundle_type,
        name=bundle_name,
        revision=revision,
        display_name=display_name,
        description=description,
        base_path=base_path,
        policies=policies,
        proxy_endpoints=proxy_endpoints,
        target_endpoints=target_endpoints,
        resources=resources,
        kvm_refs=kvm_refs,
        shared_flow_refs=shared_flow_refs,
        target_server_refs=target_server_refs,
        meta={
            'source_zip': os.path.abspath(zip_path),
            'parsed_at': datetime.datetime.utcnow().isoformat() + 'Z',
        },
    )
