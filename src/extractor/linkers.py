"""
Relationship builders for Tool 1 reference outputs.
"""

from __future__ import annotations

from collections import defaultdict

from .paths import credential_identity


def build_relationships(developers, apps, credentials, products, proxies, sharedflows, targetservers):
    product_names = {product.name for product in products}
    proxy_names = {proxy.name for proxy in proxies}
    sharedflow_names = {sharedflow.name for sharedflow in sharedflows}
    targetserver_names = {server.name for server in targetservers}

    app_developer_map = {
        'items': sorted([
            {
                'appId': f'{app.developer_email}/{app.name}',
                'appName': app.name,
                'developerEmail': app.developer_email,
            }
            for app in apps
        ], key=lambda item: item['appId'])
    }

    credential_app_map = {
        'items': sorted([
            {
                'credentialId': credential_identity(c.developer_email, c.app_name, c.consumer_key),
                'appId': f'{c.developer_email}/{c.app_name}',
                'developerEmail': c.developer_email,
                'appName': c.app_name,
                'consumerKey': c.consumer_key,
            }
            for c in credentials
        ], key=lambda item: item['credentialId'])
    }

    credential_product_map = {
        'items': sorted([
            {
                'credentialId': credential_identity(c.developer_email, c.app_name, c.consumer_key),
                'products': [p.name for p in c.api_products],
            }
            for c in credentials
        ], key=lambda item: item['credentialId'])
    }

    product_proxy_map = {
        'items': sorted([
            {
                'productName': product.name,
                'referencedProxies': sorted(product.proxies),
            }
            for product in products
        ], key=lambda item: item['productName'])
    }

    proxy_sharedflow_map = {'items': []}
    sharedflow_usage = defaultdict(list)
    for proxy in proxies:
        items = []
        for ref in sorted(proxy.shared_flow_refs):
            items.append({'sharedFlowName': ref, 'resolved': ref in sharedflow_names})
            sharedflow_usage[ref].append(proxy.name)
        proxy_sharedflow_map['items'].append({'proxyName': proxy.name, 'sharedFlows': items})
    proxy_sharedflow_map['items'].sort(key=lambda item: item['proxyName'])

    sharedflow_usage_payload = {
        'items': sorted([
            {'sharedFlowName': name, 'proxies': sorted(proxies_using)}
            for name, proxies_using in sharedflow_usage.items()
        ], key=lambda item: item['sharedFlowName'])
    }

    proxy_targetserver_map = {'items': []}
    targetserver_usage = defaultdict(list)
    for proxy in proxies:
        items = []
        for ref in sorted(proxy.target_server_refs):
            items.append({'targetServerName': ref, 'resolved': ref in targetserver_names})
            targetserver_usage[ref].append(proxy.name)
        proxy_targetserver_map['items'].append({'proxyName': proxy.name, 'targetServers': items})
    proxy_targetserver_map['items'].sort(key=lambda item: item['proxyName'])

    targetserver_usage_payload = {
        'items': sorted([
            {'targetServerName': name, 'proxies': sorted(proxies_using)}
            for name, proxies_using in targetserver_usage.items()
        ], key=lambda item: item['targetServerName'])
    }

    ownership_index = {
        'developers': sorted([
            {
                'developerEmail': developer.email,
                'apps': sorted([
                    {
                        'appName': app.name,
                        'credentials': sorted([
                            credential_identity(c.developer_email, c.app_name, c.consumer_key)
                            for c in credentials
                            if c.developer_email == developer.email and c.app_name == app.name
                        ]),
                    }
                    for app in apps if app.developer_email == developer.email
                ], key=lambda item: item['appName']),
            }
            for developer in developers
        ], key=lambda item: item['developerEmail'])
    }

    dangling = []
    developer_emails = {developer.email for developer in developers}
    for app in apps:
        if app.developer_email not in developer_emails:
            dangling.append({
                'sourceArtifactType': 'app',
                'sourceArtifactId': f'{app.developer_email}/{app.name}',
                'referenceType': 'APP_OWNER',
                'referencedId': app.developer_email,
                'severity': 'warning',
                'message': f'App owner {app.developer_email} was not found.',
            })
    for credential in credentials:
        for product in credential.api_products:
            if product.name not in product_names:
                dangling.append({
                    'sourceArtifactType': 'credential',
                    'sourceArtifactId': credential_identity(
                        credential.developer_email, credential.app_name, credential.consumer_key
                    ),
                    'referenceType': 'CREDENTIAL_PRODUCT',
                    'referencedId': product.name,
                    'severity': 'warning',
                    'message': f'Credential references missing product {product.name}.',
                })
    for product in products:
        for proxy_name in product.proxies:
            if proxy_name not in proxy_names:
                dangling.append({
                    'sourceArtifactType': 'product',
                    'sourceArtifactId': product.name,
                    'referenceType': 'PRODUCT_PROXY',
                    'referencedId': proxy_name,
                    'severity': 'blocker',
                    'message': f'Product references missing proxy {proxy_name}.',
                })
    for proxy in proxies:
        for sharedflow_name in proxy.shared_flow_refs:
            if sharedflow_name not in sharedflow_names:
                dangling.append({
                    'sourceArtifactType': 'proxy',
                    'sourceArtifactId': proxy.name,
                    'referenceType': 'PROXY_SHAREDFLOW',
                    'referencedId': sharedflow_name,
                    'severity': 'blocker',
                    'message': f'Proxy references missing shared flow {sharedflow_name}.',
                })
        for server_name in proxy.target_server_refs:
            if server_name not in targetserver_names:
                dangling.append({
                    'sourceArtifactType': 'proxy',
                    'sourceArtifactId': proxy.name,
                    'referenceType': 'PROXY_TARGETSERVER',
                    'referencedId': server_name,
                    'severity': 'blocker',
                    'message': f'Proxy references missing target server {server_name}.',
                })

    dangling_payload = {'references': sorted(dangling, key=lambda item: (
        item['sourceArtifactType'], item['sourceArtifactId'], item['referenceType'], item['referencedId']
    ))}

    return {
        'app-developer-map': app_developer_map,
        'credential-app-map': credential_app_map,
        'credential-product-map': credential_product_map,
        'ownership-index': ownership_index,
        'product-proxy-map': product_proxy_map,
        'proxy-sharedflow-map': proxy_sharedflow_map,
        'sharedflow-usage': sharedflow_usage_payload,
        'proxy-targetserver-map': proxy_targetserver_map,
        'targetserver-usage': targetserver_usage_payload,
        'dangling-references': dangling_payload,
    }
