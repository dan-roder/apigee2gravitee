"""
Derived output builders for Tool 1.
"""

from __future__ import annotations

from collections import Counter, defaultdict

from .enums import WARNING_CODES
from .paths import credential_identity


def _inventory_items(entities, id_fn, name_fn, source_path_fn):
    return {
        'items': sorted([
            {
                'id': id_fn(entity),
                'name': name_fn(entity),
                'sourcePath': source_path_fn(entity),
                'warnings': sorted(entity._meta.warnings),
                'blockers': sorted(entity._meta.blockers),
                'riskFlags': sorted(entity._meta.risk_flags),
            }
            for entity in entities
        ], key=lambda item: item['id'])
    }


def build_inventories(proxies, sharedflows, targetservers, developers, apps, credentials, products):
    return {
        'proxies': _inventory_items(
            proxies, lambda item: item.name, lambda item: item.name, lambda item: item._meta.source_path
        ),
        'sharedflows': _inventory_items(
            sharedflows, lambda item: item.name, lambda item: item.name, lambda item: item._meta.source_path
        ),
        'targetservers': _inventory_items(
            targetservers, lambda item: item.name, lambda item: item.name, lambda item: item._meta.source_path
        ),
        'developers': _inventory_items(
            developers, lambda item: item.email, lambda item: item.email, lambda item: item._meta.source_path
        ),
        'apps': _inventory_items(
            apps,
            lambda item: f'{item.developer_email}/{item.name}',
            lambda item: item.name,
            lambda item: item._meta.source_path,
        ),
        'credentials': _inventory_items(
            credentials,
            lambda item: credential_identity(item.developer_email, item.app_name, item.consumer_key),
            lambda item: item.consumer_key,
            lambda item: item._meta.source_path,
        ),
        'products': _inventory_items(
            products, lambda item: item.name, lambda item: item.name, lambda item: item._meta.source_path
        ),
        'developer-attributes': build_attribute_inventory(
            [
                (developer.email, attr.name, attr.value)
                for developer in developers
                for attr in developer.attributes
            ],
            subject_label='developers',
            subject_count_label='developerCount',
            recommended_nonempty='CREATE_CUSTOM_FIELD',
            recommended_empty='IGNORE_EMPTY',
        ),
        'app-attributes': build_attribute_inventory(
            [
                (f'{app.developer_email}/{app.name}', attr.name, attr.value)
                for app in apps
                for attr in app.attributes
            ],
            subject_label='apps',
            subject_count_label='appCount',
            recommended_nonempty='MAP_VERBATIM',
            recommended_empty='REVIEW_REQUIRED',
        ),
    }


def build_attribute_inventory(items, subject_label, subject_count_label, recommended_nonempty, recommended_empty):
    groups = defaultdict(list)
    for subject_id, attr_name, attr_value in items:
        groups[attr_name].append((subject_id, attr_value))

    attributes = []
    for attr_name, values in sorted(groups.items()):
        subjects = sorted({subject_id for subject_id, _ in values})
        sample_values = sorted({value for _, value in values if value})[:5]
        empty_count = sum(1 for _, value in values if not value)
        non_empty_count = sum(1 for _, value in values if value)
        risk_flags = []
        if empty_count and not non_empty_count:
            risk_flags.append('EMPTY_ONLY')
        if len(sample_values) > 3:
            risk_flags.append('HIGH_CARDINALITY')
        if any(token in attr_name.lower() for token in ('secret', 'token', 'key', 'password')):
            risk_flags.append('POSSIBLE_SENSITIVE')
        attributes.append({
            'name': attr_name,
            subject_count_label: len(subjects),
            'occurrenceCount': len(values),
            subject_label: subjects,
            'sampleValues': sample_values,
            'emptyValueCount': empty_count,
            'nonEmptyValueCount': non_empty_count,
            'recommendedAction': recommended_nonempty if non_empty_count else recommended_empty,
            'riskFlags': risk_flags,
        })
    return {'attributes': attributes}


def build_derived_outputs(developers, apps, credentials, products, proxies, sharedflows, targetservers):
    product_names = {product.name for product in products}
    proxy_names = {proxy.name for proxy in proxies}
    sharedflow_names = {sharedflow.name for sharedflow in sharedflows}
    targetserver_by_name = {server.name: server for server in targetservers}

    product_resolution = {'products': []}
    for product in sorted(products, key=lambda item: item.name):
        resolved = sorted([name for name in product.proxies if name in proxy_names])
        missing = sorted([name for name in product.proxies if name not in proxy_names])
        warnings = sorted(set(product._meta.warnings))
        blockers = sorted(set(product._meta.blockers))
        risk_flags = sorted(set(product._meta.risk_flags))
        if len(product.proxies) > 1:
            warnings = sorted(set(warnings + ['MULTI_API_PRODUCT', 'PLAN_SPLIT_REQUIRED']))
        if missing:
            blockers = sorted(set(blockers + ['MISSING_REFERENCED_PROXY']))
        if not product.proxies or missing == sorted(product.proxies):
            resolution_type = 'UNRESOLVED'
            recommended_plan_model = 'REVIEW_REQUIRED'
        elif len(resolved) == 1 and not missing:
            resolution_type = 'SINGLE_API'
            recommended_plan_model = 'ONE_PLAN_ON_ONE_API'
        elif missing:
            resolution_type = 'MULTI_API_PARTIAL'
            recommended_plan_model = 'REVIEW_REQUIRED'
        else:
            resolution_type = 'MULTI_API'
            recommended_plan_model = 'PLAN_SPLIT_REQUIRED'
        product_resolution['products'].append({
            'productName': product.name,
            'referencedProxies': sorted(product.proxies),
            'resolvedProxies': resolved,
            'missingProxies': missing,
            'resolutionType': resolution_type,
            'recommendedPlanModel': recommended_plan_model,
            '_meta': {'warnings': warnings, 'blockers': blockers, 'riskFlags': risk_flags},
        })

    sharedflow_resolution = {'references': []}
    for proxy in sorted(proxies, key=lambda item: item.name):
        for sharedflow_name in sorted(proxy.shared_flow_refs):
            warnings = ['SHAREDFLOW_REFERENCE', 'MANUAL_SHARED_POLICY_GROUP_MAPPING_REQUIRED']
            blockers = []
            if sharedflow_name not in sharedflow_names:
                blockers.append('MISSING_REFERENCED_SHAREDFLOW')
            sharedflow_resolution['references'].append({
                'proxyName': proxy.name,
                'sharedFlowName': sharedflow_name,
                'resolved': sharedflow_name in sharedflow_names,
                'referencePoints': [],
                'recommendedFollowUp': 'MANUAL_SHARED_POLICY_GROUP_MAPPING_REQUIRED',
                '_meta': {'warnings': warnings, 'blockers': blockers, 'riskFlags': []},
            })

    targetserver_resolution = {'references': []}
    for proxy in sorted(proxies, key=lambda item: item.name):
        for server_name in sorted(proxy.target_server_refs):
            target = targetserver_by_name.get(server_name)
            warnings = ['TARGETSERVER_REFERENCE']
            blockers = []
            derived_url = None
            target_config = {
                'host': None,
                'port': 0,
                'isSsl': False,
                'protocolHint': None,
                'derivedUrl': None,
            }
            if target is None:
                blockers.append('MISSING_REFERENCED_TARGETSERVER')
            else:
                protocol = 'https' if target.ssl_enabled else 'http'
                derived_url = f'{protocol}://{target.host}:{target.port}' if target.host else None
                target_config = {
                    'host': target.host or None,
                    'port': target.port,
                    'isSsl': target.ssl_enabled,
                    'protocolHint': protocol,
                    'derivedUrl': derived_url,
                }
                if not target.host:
                    warnings.append('INCOMPLETE_TARGETSERVER_CONFIGURATION')
            targetserver_resolution['references'].append({
                'proxyName': proxy.name,
                'targetServerName': server_name,
                'resolved': target is not None,
                'referencePoints': [],
                'targetConfig': target_config,
                'bootstrapHint': {
                    'action': 'CREATE_OR_RESOLVE_TARGET_SERVER' if target is not None else 'REVIEW_REQUIRED',
                    'recommendedKey': server_name if target is not None else None,
                },
                '_meta': {'warnings': sorted(set(warnings)), 'blockers': blockers, 'riskFlags': []},
            })

    continuity = {'credentials': []}
    subscription_intent = {'credentials': []}
    inactive_impact = {'inactiveDevelopers': []}

    product_to_proxies = {product.name: sorted(product.proxies) for product in products}
    inactive_developers = {developer.email for developer in developers if developer.status != 'active'}

    for credential in sorted(credentials, key=lambda item: (
        item.developer_email, item.app_name, item.consumer_key
    )):
        credential_id = credential_identity(credential.developer_email, credential.app_name, credential.consumer_key)
        approved_products = sorted([
            product.name for product in credential.api_products
            if (product.status or '').lower() == 'approved'
        ])
        continuity['credentials'].append({
            'credentialId': credential_id,
            'developerEmail': credential.developer_email,
            'appName': credential.app_name,
            'consumerKey': credential.consumer_key,
            'consumerSecretPresent': credential.consumer_secret_present,
            'approvedProducts': approved_products,
            'authHints': sorted(credential.auth_hints),
            'riskFlags': sorted(credential._meta.risk_flags),
        })

        associations = []
        for product in credential.api_products:
            status = (product.status or '').lower() or None
            if status == 'approved':
                action = 'CREATE_ACTIVE_SUBSCRIPTION'
                target_status = 'ACCEPTED'
            elif status == 'pending':
                action = 'CREATE_PENDING_SUBSCRIPTION'
                target_status = 'PENDING'
            elif status == 'revoked':
                action = 'SKIP_SUBSCRIPTION'
                target_status = 'CLOSED'
            else:
                action = 'REVIEW_REQUIRED'
                target_status = 'REVIEW_REQUIRED'
            associations.append({
                'productName': product.name,
                'sourceStatus': status,
                'recommendedAction': action,
                'targetStatusHint': target_status,
            })
        subscription_intent['credentials'].append({
            'credentialId': credential_id,
            'developerEmail': credential.developer_email,
            'appName': credential.app_name,
            'consumerKey': credential.consumer_key,
            'apiKeyModeHint': 'SHARED' if len(credential.api_products) > 1 else 'EXCLUSIVE',
            'productAssociations': sorted(associations, key=lambda item: item['productName']),
            '_meta': {
                'warnings': sorted(credential._meta.warnings),
                'blockers': sorted(credential._meta.blockers),
                'riskFlags': sorted(credential._meta.risk_flags),
            },
        })

    for developer in sorted(developers, key=lambda item: item.email):
        if developer.email not in inactive_developers:
            continue
        dev_apps = [app for app in apps if app.developer_email == developer.email]
        dev_credentials = [cred for cred in credentials if cred.developer_email == developer.email]
        credential_items = []
        all_products = set()
        all_proxies = set()
        for credential in dev_credentials:
            credential_products = sorted([product.name for product in credential.api_products])
            for product_name in credential_products:
                all_products.add(product_name)
                all_proxies.update(product_to_proxies.get(product_name, []))
            credential_items.append({
                'credentialId': credential_identity(
                    credential.developer_email, credential.app_name, credential.consumer_key
                ),
                'consumerKey': credential.consumer_key,
                'products': credential_products,
                'proxies': sorted(set(
                    proxy for product_name in credential_products for proxy in product_to_proxies.get(product_name, [])
                )),
            })
        inactive_impact['inactiveDevelopers'].append({
            'developerEmail': developer.email,
            'apps': sorted([app.name for app in dev_apps]),
            'credentials': sorted(credential_items, key=lambda item: item['credentialId']),
            'impactSummary': {
                'applicationCount': len(dev_apps),
                'credentialCount': len(dev_credentials),
                'productCount': len(all_products),
                'proxyCount': len(all_proxies),
            },
            'recommendedActions': ['REVIEW_IDENTITY_STATUS', 'CONFIRM_SUBSCRIPTION_OWNERSHIP'],
        })

    return {
        'credential-continuity-index': continuity,
        'subscription-intent': subscription_intent,
        'product-resolution': product_resolution,
        'sharedflow-resolution': sharedflow_resolution,
        'targetserver-resolution': targetserver_resolution,
        'inactive-impact': inactive_impact,
    }


def build_extraction_report(manifest, credentials, failures, linkers, derived_outputs):
    dangling = linkers['dangling-references']['references']
    product_resolution = derived_outputs['product-resolution']['products']
    sharedflow_resolution = derived_outputs['sharedflow-resolution']['references']
    targetserver_resolution = derived_outputs['targetserver-resolution']['references']
    continuity = derived_outputs['credential-continuity-index']['credentials']
    inactive = derived_outputs['inactive-impact']['inactiveDevelopers']

    blockers_by_type = {key: [] for key in (
        'proxy', 'sharedflow', 'kvm', 'targetserver', 'developer', 'app', 'credential', 'product'
    )}
    warnings_by_type = {key: [] for key in blockers_by_type}

    for entity_type, entities in (
        ('proxy', getattr(manifest, '_proxy_entities', [])),
        ('sharedflow', getattr(manifest, '_sharedflow_entities', [])),
        ('kvm', getattr(manifest, '_kvm_entities', [])),
        ('targetserver', getattr(manifest, '_targetserver_entities', [])),
        ('developer', getattr(manifest, '_developer_entities', [])),
        ('app', getattr(manifest, '_app_entities', [])),
        ('credential', credentials),
        ('product', getattr(manifest, '_product_entities', [])),
    ):
        for entity in entities:
            if entity._meta.warnings:
                warnings_by_type[entity_type].append(entity._meta.artifact_id)
            if entity._meta.blockers:
                blockers_by_type[entity_type].append(entity._meta.artifact_id)
        warnings_by_type[entity_type].sort()
        blockers_by_type[entity_type].sort()

    return {
        'summary': {
            'sourceOrg': manifest.org or None,
            'sourceEnv': manifest.environment or None,
            'extractedAt': manifest.extracted_at,
            'artifactCounts': {
                'proxies': manifest.proxy_count,
                'sharedflows': manifest.sharedflow_count,
                'flowhooks': manifest.flow_hook_count,
                'kvms': manifest.kvm_count,
                'targetservers': manifest.target_server_count,
                'developers': manifest.developer_count,
                'apps': manifest.app_count,
                'credentials': manifest.credential_count,
                'products': manifest.product_count,
                'failedArtifacts': manifest.failed_artifact_count,
            },
        },
        'blockersByArtifactType': blockers_by_type,
        'warningsByArtifactType': warnings_by_type,
        'failedArtifacts': [failure.to_dict() for failure in failures],
        'encryptedValueSummary': {
            'encryptedKvmEntryCount': len(manifest.encrypted_kvm_names),
            'artifacts': sorted(manifest.encrypted_kvm_names),
        },
        'continuityRiskSummary': {
            'apiKeyRiskCredentialCount': sum(
                1 for item in continuity if 'API_KEY_CONTINUITY_RISK' in item['riskFlags']
            ),
            'oauthClientRiskCredentialCount': sum(
                1 for item in continuity if 'OAUTH_CLIENT_CONTINUITY_RISK' in item['riskFlags']
            ),
            'credentials': sorted([
                item['credentialId'] for item in continuity if item['riskFlags']
            ]),
        },
        'inactiveImpactSummary': {
            'inactiveDeveloperCount': len(inactive),
            'affectedAppCount': sum(item['impactSummary']['applicationCount'] for item in inactive),
            'affectedCredentialCount': sum(item['impactSummary']['credentialCount'] for item in inactive),
        },
        'dependencyResolutionSummary': {
            'missingProxyReferenceCount': sum(1 for item in product_resolution if item['missingProxies']),
            'missingSharedflowReferenceCount': sum(1 for item in sharedflow_resolution if not item['resolved']),
            'missingTargetserverReferenceCount': sum(1 for item in targetserver_resolution if not item['resolved']),
        },
        'danglingReferenceSummary': {
            'count': len(dangling),
            'references': dangling,
        },
    }
