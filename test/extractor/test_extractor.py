"""
test/test_extractor.py

Test suite for the extractor phase.
Run with: python3 -m pytest test/test_extractor.py -v
       or: python3 -m unittest test.test_extractor (no pytest needed)

Covers:
  - Bundle ZIP parsing (proxy and sharedflow)
  - Policy extraction (types, enabled flag, resource URLs, raw_xml)
  - ProxyEndpoint parsing (connection, pre/flow/post flows, route rules)
  - TargetEndpoint parsing (URL, load balancer, SSL, properties)
  - Cross-cutting ref extraction (KVM refs with flags, shared flow refs, target server refs)
  - Data directory readers (KVMs all scopes, target servers, flow hooks, devs, apps, products)
  - IR writer (correct paths, JSON validity)
  - End-to-end extraction (extractor.run_extraction against fixtures)
  - Manifest correctness (counts, encrypted KVM flags, warnings)
  - Edge cases (missing dirs, malformed ZIP, bad JSON)
"""

import json
import os
import sys
import tempfile
import unittest
import zipfile
import shutil

# Ensure the project root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.extractor.readers.bundle import parse_bundle
from src.extractor.readers.data_dir import (
    find_proxy_zips, find_sharedflow_zips,
    read_org_kvms, read_env_kvms, read_proxy_kvms,
    read_target_servers, read_flow_hooks,
    read_developers, read_apps, read_products,
)
from src.extractor.writer import IrWriter
from src.extractor.schema import BundleIR, KvmIR, to_json
from src.extractor.extractor import run_extraction
from src.extractor.paths import credential_file_path, protected_secret_dir
from src.extractor.enums import WARNING_CODES, BLOCKER_CODES, RISK_FLAG_CODES

FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures', 'data')
PROJECT_DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'data'))
PROXY_ZIP = os.path.join(FIXTURES, 'proxies', 'orders-api.zip')
SF_ZIP    = os.path.join(FIXTURES, 'sharedflows', 'security-common.zip')


# ─── Bundle parsing ────────────────────────────────────────────────────────────

class TestBundleParser(unittest.TestCase):

    def setUp(self):
        self.proxy = parse_bundle(PROXY_ZIP)
        self.sf    = parse_bundle(SF_ZIP)

    # ── Descriptor fields ────────────────────────────────────────────────────

    def test_proxy_type_and_name(self):
        self.assertEqual(self.proxy.type, 'proxy')
        self.assertEqual(self.proxy.name, 'orders-api')

    def test_proxy_display_name_and_description(self):
        self.assertEqual(self.proxy.display_name, 'Orders API')
        self.assertIn('order', self.proxy.description.lower())

    def test_proxy_revision(self):
        self.assertEqual(self.proxy.revision, '3')

    def test_proxy_base_path(self):
        self.assertEqual(self.proxy.base_path, '/v1/orders')

    def test_sharedflow_type(self):
        self.assertEqual(self.sf.type, 'sharedflow')
        self.assertEqual(self.sf.name, 'security-common')

    def test_sharedflow_has_no_proxy_endpoints(self):
        self.assertEqual(self.sf.proxy_endpoints, [])
        self.assertEqual(self.sf.target_endpoints, [])

    # ── Policy extraction ────────────────────────────────────────────────────

    def test_policy_count(self):
        # orders-api has 7 policies
        self.assertEqual(len(self.proxy.policies), 7)

    def test_policy_types(self):
        types = {p.policy_type for p in self.proxy.policies.values()}
        self.assertIn('VerifyAPIKey', types)
        self.assertIn('SpikeArrest', types)
        self.assertIn('AssignMessage', types)
        self.assertIn('Javascript', types)
        self.assertIn('MessageLogging', types)
        self.assertIn('KeyValueMapOperations', types)

    def test_policy_enabled_default(self):
        policy = self.proxy.policies['verify-api-key']
        self.assertTrue(policy.enabled)

    def test_policy_raw_xml_preserved(self):
        policy = self.proxy.policies['verify-api-key']
        self.assertIn('<VerifyAPIKey', policy.raw_xml)
        self.assertIn('x-api-key', policy.raw_xml)

    def test_policy_raw_dict_has_tag(self):
        policy = self.proxy.policies['spike-arrest']
        self.assertEqual(policy.raw_dict['_tag'], 'SpikeArrest')

    def test_javascript_resource_url_extracted(self):
        policy = self.proxy.policies['validate-order-payload']
        self.assertEqual(policy.resource_urls, ['jsc/validate-order.js'])

    def test_non_resource_policy_has_empty_resource_urls(self):
        policy = self.proxy.policies['verify-api-key']
        self.assertEqual(policy.resource_urls, [])

    def test_sharedflow_policies(self):
        self.assertIn('oauth-verify', self.sf.policies)
        self.assertIn('quota-check', self.sf.policies)
        self.assertEqual(self.sf.policies['oauth-verify'].policy_type, 'OAuthV2')

    # ── ProxyEndpoint ────────────────────────────────────────────────────────

    def test_has_one_proxy_endpoint(self):
        self.assertEqual(len(self.proxy.proxy_endpoints), 1)

    def test_proxy_endpoint_name(self):
        ep = self.proxy.proxy_endpoints[0]
        self.assertEqual(ep.name, 'default')

    def test_proxy_endpoint_base_path(self):
        ep = self.proxy.proxy_endpoints[0]
        self.assertEqual(ep.connection.base_path, '/v1/orders')

    def test_proxy_endpoint_virtual_hosts(self):
        ep = self.proxy.proxy_endpoints[0]
        self.assertIn('secure', ep.connection.virtual_hosts)
        self.assertIn('default', ep.connection.virtual_hosts)

    def test_preflow_request_steps(self):
        ep = self.proxy.proxy_endpoints[0]
        step_names = [s.name for s in ep.pre_flow.request]
        self.assertIn('verify-api-key', step_names)
        self.assertIn('spike-arrest', step_names)

    def test_preflow_step_condition(self):
        ep = self.proxy.proxy_endpoints[0]
        spike = next(s for s in ep.pre_flow.request if s.name == 'spike-arrest')
        self.assertIn('OPTIONS', spike.condition)

    def test_named_flows_count(self):
        ep = self.proxy.proxy_endpoints[0]
        self.assertEqual(len(ep.flows), 2)

    def test_named_flow_names(self):
        ep = self.proxy.proxy_endpoints[0]
        names = [f.name for f in ep.flows]
        self.assertIn('GetOrders', names)
        self.assertIn('CreateOrder', names)

    def test_named_flow_condition(self):
        ep = self.proxy.proxy_endpoints[0]
        get_flow = next(f for f in ep.flows if f.name == 'GetOrders')
        self.assertIn('GET', get_flow.condition)

    def test_named_flow_request_steps(self):
        ep = self.proxy.proxy_endpoints[0]
        create_flow = next(f for f in ep.flows if f.name == 'CreateOrder')
        step_names = [s.name for s in create_flow.request]
        self.assertIn('validate-order-payload', step_names)
        self.assertIn('write-order-cache', step_names)

    def test_postflow_response_step(self):
        ep = self.proxy.proxy_endpoints[0]
        step_names = [s.name for s in ep.post_flow.response]
        self.assertIn('log-response', step_names)

    def test_route_rule(self):
        ep = self.proxy.proxy_endpoints[0]
        self.assertEqual(len(ep.route_rules), 1)
        self.assertEqual(ep.route_rules[0].target, 'default')

    # ── TargetEndpoint ───────────────────────────────────────────────────────

    def test_has_one_target_endpoint(self):
        self.assertEqual(len(self.proxy.target_endpoints), 1)

    def test_target_endpoint_name(self):
        te = self.proxy.target_endpoints[0]
        self.assertEqual(te.name, 'default')

    def test_target_endpoint_load_balancer(self):
        te = self.proxy.target_endpoints[0]
        lb = te.connection.load_balancer
        self.assertIsNotNone(lb)
        self.assertEqual(lb.algorithm, 'RoundRobin')
        self.assertEqual(len(lb.servers), 2)

    def test_target_endpoint_lb_server_names(self):
        te = self.proxy.target_endpoints[0]
        server_names = [s.name for s in te.connection.load_balancer.servers]
        self.assertIn('orders-backend-primary', server_names)
        self.assertIn('orders-backend-secondary', server_names)

    def test_target_endpoint_lb_server_weight(self):
        te = self.proxy.target_endpoints[0]
        primary = next(s for s in te.connection.load_balancer.servers
                       if s.name == 'orders-backend-primary')
        self.assertEqual(primary.weight, 2)

    def test_target_endpoint_ssl(self):
        te = self.proxy.target_endpoints[0]
        ssl = te.connection.ssl_info
        self.assertIsNotNone(ssl)
        self.assertTrue(ssl.enabled)
        self.assertEqual(ssl.trust_store, 'truststore1')

    # ── Cross-cutting refs ───────────────────────────────────────────────────

    def test_kvm_refs_extracted(self):
        self.assertEqual(len(self.proxy.kvm_refs), 2)

    def test_kvm_ref_env_scoped_not_flagged(self):
        env_ref = next(r for r in self.proxy.kvm_refs if r.map_identifier == 'env-config')
        self.assertEqual(env_ref.scope, 'environment')
        self.assertIn('Get', env_ref.operations)
        self.assertFalse(env_ref.flagged)

    def test_kvm_ref_write_flagged(self):
        write_ref = next(r for r in self.proxy.kvm_refs if r.map_identifier == 'order-cache')
        self.assertIn('Put', write_ref.operations)
        self.assertTrue(write_ref.flagged)

    def test_shared_flow_refs_empty_for_proxy_without_flowcallout(self):
        # orders-api has no FlowCallout
        self.assertEqual(self.proxy.shared_flow_refs, [])

    def test_target_server_refs(self):
        refs = self.proxy.target_server_refs
        self.assertIn('orders-backend-primary', refs)
        self.assertIn('orders-backend-secondary', refs)

    # ── Resources ────────────────────────────────────────────────────────────

    def test_js_resource_extracted(self):
        self.assertIn('jsc/validate-order.js', self.proxy.resources)

    def test_js_resource_content(self):
        content = self.proxy.resources['jsc/validate-order.js']
        self.assertIn('orderId', content)

    # ── Meta ─────────────────────────────────────────────────────────────────

    def test_meta_source_zip(self):
        self.assertIn('orders-api.zip', self.proxy.meta['source_zip'])

    def test_meta_parsed_at(self):
        self.assertIn('T', self.proxy.meta['parsed_at'])  # ISO timestamp


# ─── Data directory readers ────────────────────────────────────────────────────

class TestDataDirReaders(unittest.TestCase):

    def test_extensionless_json_documents_are_discovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            dev_dir = os.path.join(tmp, 'devs')
            product_dir = os.path.join(tmp, 'products')
            os.makedirs(dev_dir, exist_ok=True)
            os.makedirs(product_dir, exist_ok=True)

            with open(os.path.join(dev_dir, 'dev@example.com'), 'w') as f:
                json.dump({
                    'email': 'dev@example.com',
                    'firstName': 'Dev',
                    'lastName': 'Example',
                    'userName': 'dev@example.com',
                    'status': 'active',
                    'apps': [],
                    'attributes': [],
                }, f)
            with open(os.path.join(product_dir, 'sample-product'), 'w') as f:
                json.dump({
                    'name': 'sample-product',
                    'displayName': 'Sample Product',
                    'approvalType': 'auto',
                    'proxies': ['sample-api'],
                    'scopes': [''],
                }, f)

            devs = read_developers(tmp)
            products = read_products(tmp)

            self.assertEqual(len(devs), 1)
            self.assertEqual(devs[0].email, 'dev@example.com')
            self.assertEqual(len(products), 1)
            self.assertEqual(products[0].name, 'sample-product')
            self.assertEqual(products[0].scopes, [])

    # ── ZIP discovery ─────────────────────────────────────────────────────────

    def test_find_proxy_zips(self):
        zips = find_proxy_zips(FIXTURES)
        self.assertEqual(len(zips), 1)
        self.assertTrue(zips[0].endswith('orders-api.zip'))

    def test_find_sharedflow_zips(self):
        zips = find_sharedflow_zips(FIXTURES)
        self.assertEqual(len(zips), 1)
        self.assertTrue(zips[0].endswith('security-common.zip'))

    def test_find_proxy_zips_missing_dir(self):
        self.assertEqual(find_proxy_zips('/nonexistent/path'), [])

    # ── KVMs ─────────────────────────────────────────────────────────────────

    def test_org_kvms(self):
        kvms = read_org_kvms(FIXTURES)
        self.assertEqual(len(kvms), 2)
        names = {k.name for k in kvms}
        self.assertIn('org-config', names)
        self.assertIn('org-secrets', names)

    def test_org_kvm_scope(self):
        kvms = read_org_kvms(FIXTURES)
        for kvm in kvms:
            self.assertEqual(kvm.scope, 'org')

    def test_org_kvm_entries(self):
        kvms = read_org_kvms(FIXTURES)
        config = next(k for k in kvms if k.name == 'org-config')
        entry_names = {e.name for e in config.entries}
        self.assertIn('support-email', entry_names)
        self.assertIn('max-retry-count', entry_names)

    def test_org_kvm_entry_values(self):
        kvms = read_org_kvms(FIXTURES)
        config = next(k for k in kvms if k.name == 'org-config')
        email_entry = next(e for e in config.entries if e.name == 'support-email')
        self.assertEqual(email_entry.value, 'support@example.com')

    def test_encrypted_kvm_entries_have_null_values(self):
        kvms = read_org_kvms(FIXTURES)
        secrets = next(k for k in kvms if k.name == 'org-secrets')
        self.assertTrue(secrets.encrypted)
        for entry in secrets.entries:
            self.assertIsNone(entry.value)

    def test_env_kvms(self):
        kvms = read_env_kvms(FIXTURES)
        self.assertGreaterEqual(len(kvms), 1)
        env_kvm = next((k for k in kvms if k.name == 'env-config'), None)
        self.assertIsNotNone(env_kvm)
        self.assertEqual(env_kvm.scope, 'env')
        self.assertEqual(env_kvm.environment, 'dev')

    def test_proxy_kvms(self):
        kvms = read_proxy_kvms(FIXTURES)
        self.assertEqual(len(kvms), 1)
        self.assertEqual(kvms[0].name, 'order-cache')
        self.assertEqual(kvms[0].scope, 'proxy')
        self.assertEqual(kvms[0].proxy_name, 'orders-api')

    def test_singular_kvm_layout_is_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            org_dir = os.path.join(tmp, 'kvm', 'org')
            env_dir = os.path.join(tmp, 'kvm', 'env', 'dev')
            os.makedirs(org_dir, exist_ok=True)
            os.makedirs(env_dir, exist_ok=True)

            with open(os.path.join(org_dir, 'org-kvm'), 'w') as f:
                json.dump({
                    'name': 'org-kvm',
                    'encrypted': False,
                    'entry': [{'name': 'key', 'value': 'value'}],
                }, f)
            with open(os.path.join(env_dir, 'env-kvm'), 'w') as f:
                json.dump({
                    'name': 'env-kvm',
                    'encrypted': False,
                    'entry': [{'name': 'key', 'value': 'value'}],
                }, f)

            org_kvms = read_org_kvms(tmp)
            env_kvms = read_env_kvms(tmp)

            self.assertEqual(len(org_kvms), 1)
            self.assertEqual(org_kvms[0].name, 'org-kvm')
            self.assertEqual(len(env_kvms), 1)
            self.assertEqual(env_kvms[0].name, 'env-kvm')
            self.assertEqual(env_kvms[0].environment, 'dev')

    # ── Target Servers ────────────────────────────────────────────────────────

    def test_target_servers(self):
        ts_list = read_target_servers(FIXTURES)
        self.assertEqual(len(ts_list), 2)
        names = {ts.name for ts in ts_list}
        self.assertIn('orders-backend-primary', names)
        self.assertIn('orders-backend-secondary', names)

    def test_target_server_fields(self):
        ts_list = read_target_servers(FIXTURES)
        primary = next(ts for ts in ts_list if ts.name == 'orders-backend-primary')
        self.assertEqual(primary.host, 'primary.orders.internal')
        self.assertEqual(primary.port, 8443)
        self.assertTrue(primary.is_enabled)
        self.assertTrue(primary.ssl_enabled)

    # ── Flow Hooks ────────────────────────────────────────────────────────────

    def test_flow_hooks(self):
        hooks = read_flow_hooks(FIXTURES)
        self.assertGreaterEqual(len(hooks), 1)
        hook = next(h for h in hooks if h.hook_name == 'PreProxyFlowHook')
        self.assertEqual(hook.shared_flow, 'security-common')
        self.assertTrue(hook.continue_on_error)

    def test_flow_hook_config_object_emits_populated_hooks_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            hooks_dir = os.path.join(tmp, 'flowhooks')
            os.makedirs(hooks_dir, exist_ok=True)
            with open(os.path.join(hooks_dir, 'flow_hook_config'), 'w') as f:
                json.dump({
                    'PreProxyFlowHook': 'sf-pre-proxy',
                    'PostProxyFlowHook': '',
                    'PreTargetFlowHook': 'sf-pre-target',
                    'PostTargetFlowHook': '',
                }, f)

            hooks = read_flow_hooks(tmp)
            names = {hook.hook_name for hook in hooks}

            self.assertEqual(len(hooks), 2)
            self.assertIn('PreProxyFlowHook', names)
            self.assertIn('PreTargetFlowHook', names)
            self.assertNotIn('PostProxyFlowHook', names)

    # ── Developers ───────────────────────────────────────────────────────────

    def test_developers(self):
        devs = read_developers(FIXTURES)
        self.assertEqual(len(devs), 1)
        dev = devs[0]
        self.assertEqual(dev.email, 'alice@example.com')
        self.assertEqual(dev.first_name, 'Alice')
        self.assertEqual(dev.last_name, 'Smith')
        self.assertEqual(dev.status, 'active')

    def test_developer_attributes(self):
        devs = read_developers(FIXTURES)
        dev = devs[0]
        team_attr = next((a for a in dev.attributes if a.name == 'team'), None)
        self.assertIsNotNone(team_attr)
        self.assertEqual(team_attr.value, 'platform')

    def test_developer_apps_list(self):
        devs = read_developers(FIXTURES)
        self.assertIn('orders-consumer', devs[0].apps)

    # ── Apps ─────────────────────────────────────────────────────────────────

    def test_apps(self):
        apps = read_apps(FIXTURES)
        self.assertEqual(len(apps), 1)
        app = apps[0]
        self.assertEqual(app.name, 'orders-consumer')
        self.assertEqual(app.developer_email, 'alice@example.com')
        self.assertEqual(app.status, 'approved')

    def test_app_credentials(self):
        apps = read_apps(FIXTURES)
        app = apps[0]
        self.assertEqual(len(app.credentials), 1)
        cred = app.credentials[0]
        self.assertEqual(cred.consumer_key, 'abc123def456')
        self.assertEqual(cred.status, 'approved')
        self.assertEqual(cred.expires_at, -1)

    def test_app_credential_api_products(self):
        apps = read_apps(FIXTURES)
        cred = apps[0].credentials[0]
        self.assertEqual(len(cred.api_products), 1)
        self.assertEqual(cred.api_products[0]['apiproduct'], 'orders-product')

    # ── Products ─────────────────────────────────────────────────────────────

    def test_products(self):
        products = read_products(FIXTURES)
        self.assertEqual(len(products), 1)
        p = products[0]
        self.assertEqual(p.name, 'orders-product')
        self.assertEqual(p.display_name, 'Orders Product')
        self.assertEqual(p.approval_type, 'auto')

    def test_product_quota(self):
        products = read_products(FIXTURES)
        p = products[0]
        self.assertIsNotNone(p.quota)
        self.assertEqual(p.quota.limit, '1000')
        self.assertEqual(p.quota.time_unit, 'hour')

    def test_product_scopes(self):
        products = read_products(FIXTURES)
        self.assertIn('read', products[0].scopes)
        self.assertIn('write', products[0].scopes)

    def test_product_proxies(self):
        products = read_products(FIXTURES)
        self.assertIn('orders-api', products[0].proxies)


# ─── IR Writer ────────────────────────────────────────────────────────────────

class TestIrWriter(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.writer = IrWriter(self.tmp)
        self.proxy = parse_bundle(PROXY_ZIP)

    def test_write_proxy_creates_file(self):
        dest = self.writer.write_bundle(self.proxy)
        self.assertTrue(os.path.isfile(dest))

    def test_write_proxy_path(self):
        dest = self.writer.write_bundle(self.proxy)
        self.assertIn('proxies', dest)
        self.assertIn('orders-api.json', dest)

    def test_write_proxy_valid_json(self):
        dest = self.writer.write_bundle(self.proxy)
        with open(dest) as f:
            data = json.load(f)
        self.assertEqual(data['name'], 'orders-api')
        self.assertEqual(data['type'], 'proxy')

    def test_write_proxy_policies_in_json(self):
        dest = self.writer.write_bundle(self.proxy)
        with open(dest) as f:
            data = json.load(f)
        self.assertIn('verify-api-key', data['policies'])

    def test_write_kvm_org_path(self):
        kvms = read_org_kvms(FIXTURES)
        config = next(k for k in kvms if k.name == 'org-config')
        dest = self.writer.write_kvm(config)
        self.assertIn('kvms', dest)
        self.assertIn('org', dest)
        self.assertIn('org-config.json', dest)

    def test_write_kvm_env_path(self):
        kvms = read_env_kvms(FIXTURES)
        env_kvm = next(k for k in kvms if k.name == 'env-config')
        dest = self.writer.write_kvm(env_kvm)
        self.assertIn('env', dest)
        self.assertIn('dev', dest)

    def test_write_kvm_valid_json(self):
        kvms = read_org_kvms(FIXTURES)
        config = next(k for k in kvms if k.name == 'org-config')
        dest = self.writer.write_kvm(config)
        with open(dest) as f:
            data = json.load(f)
        self.assertEqual(data['scope'], 'org')
        self.assertFalse(data['encrypted'])

    def test_write_sharedflow_path(self):
        sf = parse_bundle(SF_ZIP)
        dest = self.writer.write_bundle(sf)
        self.assertIn('sharedflows', dest)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


# ─── End-to-end extraction ────────────────────────────────────────────────────

class TestEndToEnd(unittest.TestCase):

    def setUp(self):
        self.ir_dir = tempfile.mkdtemp()

    def test_run_extraction_returns_zero(self):
        code = run_extraction(FIXTURES, self.ir_dir, org='advana', environment='dev')
        self.assertEqual(code, 0)

    def test_manifest_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        self.assertTrue(os.path.isfile(os.path.join(self.ir_dir, 'manifest.json')))

    def test_manifest_contents(self):
        run_extraction(FIXTURES, self.ir_dir, org='advana', environment='dev')
        with open(os.path.join(self.ir_dir, 'manifest.json')) as f:
            m = json.load(f)
        self.assertEqual(m['org'], 'advana')
        self.assertEqual(m['environment'], 'dev')
        self.assertEqual(m['proxy_count'], 1)
        self.assertEqual(m['sharedflow_count'], 1)
        self.assertEqual(m['credential_count'], 1)
        self.assertIn('orders-api', m['proxy_names'])
        self.assertIn('security-common', m['sharedflow_names'])

    def test_manifest_developer_count(self):
        run_extraction(FIXTURES, self.ir_dir)
        with open(os.path.join(self.ir_dir, 'manifest.json')) as f:
            m = json.load(f)
        self.assertEqual(m['developer_count'], 1)
        self.assertEqual(m['app_count'], 1)
        self.assertEqual(m['product_count'], 1)

    def test_manifest_encrypted_kvms_flagged(self):
        run_extraction(FIXTURES, self.ir_dir)
        with open(os.path.join(self.ir_dir, 'manifest.json')) as f:
            m = json.load(f)
        self.assertIn('org:org-secrets', m['encrypted_kvm_names'])

    def test_manifest_write_kvm_warning(self):
        run_extraction(FIXTURES, self.ir_dir)
        with open(os.path.join(self.ir_dir, 'manifest.json')) as f:
            m = json.load(f)
        write_warnings = [w for w in m['warnings'] if 'write-order-cache' in w or 'order-cache' in w]
        self.assertGreater(len(write_warnings), 0)

    def test_proxy_ir_file_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(self.ir_dir, 'proxies', 'orders-api.json')
        self.assertTrue(os.path.isfile(path))

    def test_developer_ir_file_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(self.ir_dir, 'developers', 'alice@example.com.json')
        self.assertTrue(os.path.isfile(path))

    def test_app_ir_file_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(self.ir_dir, 'apps', 'alice@example.com', 'orders-consumer.json')
        self.assertTrue(os.path.isfile(path))

    def test_product_ir_file_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(self.ir_dir, 'products', 'orders-product.json')
        self.assertTrue(os.path.isfile(path))

    def test_credential_ir_file_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(
            self.ir_dir, 'credentials', 'alice@example.com', 'orders-consumer', 'abc123def456.json'
        )
        self.assertTrue(os.path.isfile(path))

    def test_credential_ir_omits_secret_value(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(
            self.ir_dir, 'credentials', 'alice@example.com', 'orders-consumer', 'abc123def456.json'
        )
        with open(path) as f:
            data = json.load(f)
        self.assertTrue(data['consumer_secret_present'])
        self.assertIn('consumer_secret_ref', data)
        self.assertNotIn('consumer_secret', data)

    def test_app_ir_redacts_nested_secret(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(self.ir_dir, 'apps', 'alice@example.com', 'orders-consumer.json')
        with open(path) as f:
            data = json.load(f)
        credential = data['credentials'][0]
        self.assertTrue(credential['consumer_secret_present'])
        self.assertNotIn('consumer_secret', credential)

    def test_secret_sidecar_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(
            self.ir_dir, '_protected', 'credentials', 'alice@example.com', 'orders-consumer',
            'abc123def456', 'consumer-secret.txt'
        )
        self.assertTrue(os.path.isfile(path))
        with open(path) as f:
            self.assertEqual(f.read(), 'secret-value-here')

    def test_run_extraction_removes_stale_managed_outputs(self):
        stale_paths = [
            os.path.join(self.ir_dir, 'developers', 'old@example.com.json'),
            os.path.join(self.ir_dir, 'apps', 'old@example.com', 'old-app.json'),
            os.path.join(self.ir_dir, 'credentials', 'old@example.com', 'old-app', 'old-key.json'),
            os.path.join(
                self.ir_dir, '_protected', 'credentials', 'old@example.com', 'old-app',
                'old-key', 'consumer-secret.txt'
            ),
        ]
        for path in stale_paths:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w') as f:
                f.write('stale')

        run_extraction(FIXTURES, self.ir_dir)

        for path in stale_paths:
            self.assertFalse(os.path.exists(path), path)
        self.assertTrue(os.path.isfile(os.path.join(self.ir_dir, 'developers', 'alice@example.com.json')))

    def test_extraction_report_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        self.assertTrue(os.path.isfile(os.path.join(self.ir_dir, 'extraction-report.json')))

    def test_reference_outputs_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        self.assertTrue(os.path.isfile(os.path.join(self.ir_dir, 'references', 'subscription-intent.json')))
        self.assertTrue(os.path.isfile(os.path.join(self.ir_dir, 'references', 'product-resolution.json')))

    def test_inventory_outputs_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        self.assertTrue(os.path.isfile(os.path.join(self.ir_dir, 'inventories', 'credentials.json')))
        self.assertTrue(os.path.isfile(os.path.join(self.ir_dir, 'inventories', 'developer-attributes.json')))

    def test_proxy_ir_has_additive_meta(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(self.ir_dir, 'proxies', 'orders-api.json')
        with open(path) as f:
            data = json.load(f)
        self.assertIn('raw_xml', data['policies']['verify-api-key'])
        self.assertIn('_meta', data)
        self.assertEqual(data['_meta']['artifactType'], 'proxy')

    def test_target_server_ir_file_created(self):
        run_extraction(FIXTURES, self.ir_dir)
        path = os.path.join(self.ir_dir, 'targetservers', 'orders-backend-primary.json')
        self.assertTrue(os.path.isfile(path))

    def test_run_extraction_missing_data_dir(self):
        code = run_extraction('/no/such/dir', self.ir_dir)
        self.assertEqual(code, 2)

    def tearDown(self):
        shutil.rmtree(self.ir_dir, ignore_errors=True)


# ─── Edge cases ───────────────────────────────────────────────────────────────

class TestEdgeCases(unittest.TestCase):

    def test_bad_bundle_zip_raises(self):
        with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as f:
            # Write a valid ZIP but with no apiproxy/ structure
            with zipfile.ZipFile(f.name, 'w') as z:
                z.writestr('random/file.txt', 'hello')
            with self.assertRaises(ValueError):
                parse_bundle(f.name)
            os.unlink(f.name)

    def test_malformed_xml_in_policy_raises(self):
        with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as f:
            with zipfile.ZipFile(f.name, 'w') as z:
                z.writestr('apiproxy/orders.xml', '<APIProxy name="orders"/>')
                z.writestr('apiproxy/policies/bad.xml', '<NotClosed')
            with self.assertRaises(Exception):
                parse_bundle(f.name)
            os.unlink(f.name)

    def test_missing_devs_dir_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(read_developers(tmp), [])

    def test_missing_products_dir_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(read_products(tmp), [])

    def test_missing_apps_dir_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(read_apps(tmp), [])

    def test_schema_to_json_excludes_none(self):
        kvm = KvmIR(name='test', scope='org')
        j = json.loads(to_json(kvm))
        # environment and proxy_name are None → should be absent
        self.assertNotIn('environment', j)
        self.assertNotIn('proxy_name', j)

    def test_schema_to_json_preserves_false(self):
        kvm = KvmIR(name='test', scope='org', encrypted=False)
        j = json.loads(to_json(kvm))
        # False is not None — should be present
        self.assertIn('encrypted', j)
        self.assertFalse(j['encrypted'])


class TestExtendedOutputs(unittest.TestCase):

    def _copy_fixtures(self):
        tmp = tempfile.mkdtemp()
        shutil.copytree(FIXTURES, os.path.join(tmp, 'data'))
        return tmp, os.path.join(tmp, 'data')

    def test_failed_bundle_is_preserved_and_run_succeeds(self):
        tmp_root, data_dir = self._copy_fixtures()
        ir_dir = tempfile.mkdtemp()
        try:
            bad_zip = os.path.join(data_dir, 'proxies', 'broken-api.zip')
            with zipfile.ZipFile(bad_zip, 'w') as zf:
                zf.writestr('random/file.txt', 'hello')
            code = run_extraction(data_dir, ir_dir)
            self.assertEqual(code, 0)
            failed_dir = os.path.join(ir_dir, '_failed-artifacts', 'proxies', 'broken-api')
            self.assertTrue(os.path.isfile(os.path.join(failed_dir, 'broken-api.zip')))
            self.assertTrue(os.path.isfile(os.path.join(failed_dir, 'error.json')))
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)
            shutil.rmtree(ir_dir, ignore_errors=True)

    def test_inactive_developer_propagates_flags(self):
        tmp_root, data_dir = self._copy_fixtures()
        ir_dir = tempfile.mkdtemp()
        try:
            dev_path = os.path.join(data_dir, 'devs', 'alice@example.com', 'alice@example.com.json')
            with open(dev_path) as f:
                data = json.load(f)
            data['status'] = 'inactive'
            with open(dev_path, 'w') as f:
                json.dump(data, f)

            run_extraction(data_dir, ir_dir)
            with open(os.path.join(ir_dir, 'developers', 'alice@example.com.json')) as f:
                developer = json.load(f)
            with open(os.path.join(ir_dir, 'apps', 'alice@example.com', 'orders-consumer.json')) as f:
                app = json.load(f)
            with open(os.path.join(ir_dir, 'references', 'inactive-impact.json')) as f:
                report = json.load(f)

            self.assertIn('INACTIVE_DEVELOPER', developer['_meta']['riskFlags'])
            self.assertIn('OWNED_BY_INACTIVE_DEVELOPER', app['_meta']['warnings'])
            self.assertEqual(report['inactiveDevelopers'][0]['developerEmail'], 'alice@example.com')
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)
            shutil.rmtree(ir_dir, ignore_errors=True)

    def test_multi_product_credential_marks_shared_mode(self):
        tmp_root, data_dir = self._copy_fixtures()
        ir_dir = tempfile.mkdtemp()
        try:
            product_path = os.path.join(data_dir, 'products', 'orders-product-2.json')
            with open(product_path, 'w') as f:
                json.dump({
                    "name": "orders-product-2",
                    "displayName": "Orders Product 2",
                    "approvalType": "auto",
                    "proxies": ["orders-api"]
                }, f)
            app_path = os.path.join(data_dir, 'apps', 'alice@example.com', 'orders-consumer.json')
            with open(app_path) as f:
                app = json.load(f)
            app['credentials'][0]['apiProducts'].append({"apiproduct": "orders-product-2", "status": "approved"})
            with open(app_path, 'w') as f:
                json.dump(app, f)

            run_extraction(data_dir, ir_dir)
            with open(os.path.join(ir_dir, 'references', 'subscription-intent.json')) as f:
                data = json.load(f)
            with open(os.path.join(ir_dir, 'credentials', 'alice@example.com', 'orders-consumer', 'abc123def456.json')) as f:
                credential = json.load(f)
            self.assertEqual(data['credentials'][0]['apiKeyModeHint'], 'SHARED')
            self.assertIn('MULTI_PRODUCT_CREDENTIAL', credential['_meta']['riskFlags'])
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)
            shutil.rmtree(ir_dir, ignore_errors=True)

    def test_missing_proxy_reference_is_reported(self):
        tmp_root, data_dir = self._copy_fixtures()
        ir_dir = tempfile.mkdtemp()
        try:
            product_path = os.path.join(data_dir, 'products', 'orders-product.json')
            with open(product_path) as f:
                product = json.load(f)
            product['proxies'].append('missing-api')
            with open(product_path, 'w') as f:
                json.dump(product, f)

            run_extraction(data_dir, ir_dir)
            with open(os.path.join(ir_dir, 'references', 'product-resolution.json')) as f:
                data = json.load(f)
            with open(os.path.join(ir_dir, 'references', 'dangling-references.json')) as f:
                dangling = json.load(f)
            self.assertIn('missing-api', data['products'][0]['missingProxies'])
            self.assertEqual(dangling['references'][0]['referenceType'], 'PRODUCT_PROXY')
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)
            shutil.rmtree(ir_dir, ignore_errors=True)

    def test_new_export_shape_extracts_non_bundle_assets(self):
        if not os.path.isdir(PROJECT_DATA):
            self.skipTest('project data export is not present')

        ir_dir = tempfile.mkdtemp()
        try:
            code = run_extraction(PROJECT_DATA, ir_dir)
            self.assertEqual(code, 0)

            with open(os.path.join(ir_dir, 'manifest.json')) as f:
                manifest = json.load(f)

            self.assertEqual(manifest['developer_count'], 4)
            self.assertEqual(manifest['app_count'], 4)
            self.assertEqual(manifest['product_count'], 8)
            self.assertEqual(manifest['kvm_count'], 19)
            self.assertEqual(manifest['target_server_count'], 2)
            self.assertEqual(manifest['flow_hook_count'], 0)

            self.assertTrue(os.path.isfile(os.path.join(ir_dir, 'developers', 'dev1@example.com.json')))
            self.assertTrue(os.path.isfile(os.path.join(ir_dir, 'apps', 'dev1@example.com', 'kanye-dev-app.json')))
            self.assertTrue(os.path.isfile(os.path.join(ir_dir, 'products', 'kanye-api-product.json')))
            self.assertTrue(os.path.isfile(os.path.join(ir_dir, 'targetservers', 'lb1-mock.json')))
            self.assertTrue(os.path.isfile(os.path.join(ir_dir, 'kvms', 'env', 'dev', 'kvm-1-unencrypted.json')))

            with open(os.path.join(ir_dir, 'products', 'kanye-api-product.json')) as f:
                product = json.load(f)
            self.assertEqual(product['scopes'], [])
        finally:
            shutil.rmtree(ir_dir, ignore_errors=True)


class TestEnumContracts(unittest.TestCase):

    def test_warning_codes_present(self):
        self.assertIn('KVM_WRITE_OPERATION', WARNING_CODES)

    def test_blocker_codes_present(self):
        self.assertIn('MALFORMED_ARTIFACT', BLOCKER_CODES)

    def test_risk_codes_present(self):
        self.assertIn('API_KEY_CONTINUITY_RISK', RISK_FLAG_CODES)


if __name__ == '__main__':
    unittest.main(verbosity=2)
