'use strict';

const path = require('path');

const { IrLoader } = require('../shared/ir-loader');

function indexBy(items, keyFn) {
  const index = new Map();
  for (const item of items) {
    index.set(keyFn(item), item);
  }
  return index;
}

function normalizeAttributes(attributes = []) {
  return attributes.map((attr) => ({
    name: attr.name,
    value: attr.value ?? '',
  }));
}

const RESERVED_APPLICATION_METADATA_KEYS = new Set(['sourceId', 'developerEmail']);

function buildApplicationMetadata(attributes = []) {
  const metadata = {};
  const warnings = [];
  const seen = new Set();

  for (const attr of normalizeAttributes(attributes)) {
    if (!attr.name) continue;
    if (RESERVED_APPLICATION_METADATA_KEYS.has(attr.name)) {
      warnings.push(`APPLICATION_METADATA_RESERVED_KEY:${attr.name}`);
      continue;
    }
    if (seen.has(attr.name)) {
      warnings.push(`DUPLICATE_APPLICATION_METADATA_KEY:${attr.name}`);
    }
    seen.add(attr.name);
    metadata[attr.name] = String(attr.value ?? '');
  }

  return { metadata, warnings };
}

function filterByRules(items, includeSet, excludeSet, keyFn) {
  return items.filter((item) => {
    const key = keyFn(item);
    if (includeSet.size > 0 && !includeSet.has(key)) return false;
    if (excludeSet.has(key)) return false;
    return true;
  });
}

function normalizePlanTargets(productName, mapping) {
  if (!mapping) return [];
  const entries = Array.isArray(mapping) ? mapping : [mapping];
  return entries.map((entry, index) => ({
    productName,
    targetApi: entry.targetApi,
    targetApiId: entry.targetApiId || null,
    targetPlan: entry.targetPlan,
    targetPlanId: entry.targetPlanId || null,
    targetIndex: index,
    targetKey: `${entry.targetApi}::${entry.targetPlan}`,
  }));
}

function inferOAuthContinuityRelevant(credential) {
  const authHints = Array.isArray(credential.auth_hints) ? credential.auth_hints : [];
  const normalizedHints = authHints.map((hint) => String(hint || '').toUpperCase());
  return normalizedHints.some((hint) => (
    hint.includes('OAUTH') || hint.includes('JWT') || hint.includes('CLIENT')
  ));
}

function inferProtectedSecretMaterial(secretMeta, secretValue, secretRef) {
  return {
    protectedSecretMetaPresent: !!secretMeta,
    protectedSecretValuePresent: typeof secretValue === 'string' && secretValue.length > 0,
    protectedSecretMaterialPresent: !!secretMeta || (typeof secretValue === 'string' && secretValue.length > 0),
    protectedSecretRef: secretRef || null,
  };
}

function loadDeveloperDomain(irDir, config) {
  const loader = new IrLoader(irDir);
  const manifest = loader.manifest();
  const extractionReport = loader.extractionReport();
  const references = loader.references();
  const inventories = loader.inventories();

  const includeDevelopers = new Set(config.filters?.includeDevelopers || []);
  const excludeDevelopers = new Set(config.filters?.excludeDevelopers || []);
  const includeApps = new Set(config.filters?.includeApps || []);
  const excludeApps = new Set(config.filters?.excludeApps || []);

  const candidateDevelopers = filterByRules(loader.developers(), includeDevelopers, excludeDevelopers, (developer) => developer.email);
  const candidateDeveloperEmails = new Set(candidateDevelopers.map((developer) => developer.email));

  const apps = filterByRules(
    loader.apps().filter((app) => candidateDeveloperEmails.size === 0 || candidateDeveloperEmails.has(app.developer_email)),
    includeApps,
    excludeApps,
    (app) => `${app.developer_email}/${app.name}`,
  );

  const importedDeveloperEmails = new Set(apps.map((app) => app.developer_email));
  const developers = candidateDevelopers.filter((developer) => importedDeveloperEmails.has(developer.email));
  const developerByEmail = new Map(developers.map((developer) => [developer.email, developer]));
  const appNamesByDeveloper = new Map();
  for (const app of apps) {
    const names = appNamesByDeveloper.get(app.developer_email) || [];
    names.push(app.name);
    appNamesByDeveloper.set(app.developer_email, names);
  }

  const appIds = new Set(apps.map((app) => `${app.developer_email}/${app.name}`));

  const credentials = loader.credentials().filter((credential) => (
    appIds.has(`${credential.developer_email}/${credential.app_name}`)
  ));
  const products = loader.products();

  const subscriptionsByCredential = new Map(
    ((references['subscription-intent'] || {}).credentials || []).map((item) => [item.credentialId, item]),
  );
  const continuityByCredential = new Map(
    ((references['credential-continuity-index'] || {}).credentials || []).map((item) => [item.credentialId, item]),
  );
  const inactiveImpactByDeveloper = new Map(
    ((references['inactive-impact'] || {}).inactiveDevelopers || []).map((item) => [item.developerEmail, item]),
  );

  const users = developers.map((developer) => ({
    sourceId: developer.email,
    kind: 'MigratedUser',
    developerEmail: developer.email,
    email: developer.email,
    firstName: developer.first_name || '',
    lastName: developer.last_name || '',
    userName: developer.user_name || '',
    status: developer.status || 'active',
    attributes: normalizeAttributes(developer.attributes),
    customFields: [],
    appNames: (appNamesByDeveloper.get(developer.email) || []).sort(),
    inactiveImpact: inactiveImpactByDeveloper.get(developer.email) || null,
    customFieldCandidates: [],
    lookupHints: {
      email: developer.email,
    },
    blockers: [],
    warnings: [],
    manualReviewReasons: developer.status !== 'active' ? ['INACTIVE_DEVELOPER_POLICY_REQUIRED'] : [],
  }));

  const applications = apps.map((app) => {
    const sourceId = `${app.developer_email}/${app.name}`;
    const metadataMapping = buildApplicationMetadata(app.attributes);
    return {
      sourceId,
      kind: 'MigratedApplication',
      developerEmail: app.developer_email,
      developerStatus: developerByEmail.get(app.developer_email)?.status || 'active',
      appName: app.name,
      appId: app.app_id || '',
      status: app.status || 'approved',
      callbackUrl: app.callback_url || '',
      attributes: normalizeAttributes(app.attributes),
      metadata: metadataMapping.metadata,
      customFields: [],
      credentialIds: (app.credentials || []).map((credential) => `${app.developer_email}/${app.name}/${credential.consumer_key}`),
      customFieldCandidates: [],
      ownershipStrategy: config.capabilities?.applicationOwnership || 'unknown',
      lookupHints: {
        name: app.name,
        ownerHint: app.developer_email,
        sourceId,
      },
      blockers: [],
      warnings: metadataMapping.warnings,
      manualReviewReasons: [],
    };
  });

  const normalizedCredentials = credentials.map((credential) => {
    const credentialId = `${credential.developer_email}/${credential.app_name}/${credential.consumer_key}`;
    const subscriptionIntent = subscriptionsByCredential.get(credentialId) || null;
    const continuity = continuityByCredential.get(credentialId) || null;
    const secretMeta = loader.credentialSecretMeta(
      credential.developer_email,
      credential.app_name,
      credential.consumer_key,
    );
    const secretValue = loader.credentialSecret(
      credential.developer_email,
      credential.app_name,
      credential.consumer_key,
    );
    const protectedSecret = inferProtectedSecretMaterial(
      secretMeta,
      secretValue,
      credential.consumer_secret_ref
        ? path.join(irDir, credential.consumer_secret_ref)
        : null,
    );

    return {
      sourceId: credentialId,
      kind: 'MigratedCredential',
      credentialId,
      developerEmail: credential.developer_email,
      appName: credential.app_name,
      consumerKey: credential.consumer_key,
      consumerSecretPresent: !!credential.consumer_secret_present,
      consumerSecretRef: credential.consumer_secret_ref || null,
      status: credential.status || null,
      apiProducts: (credential.api_products || []).map((product) => ({
        productName: product.name,
        status: product.status || null,
      })),
      authHints: credential.auth_hints || [],
      oauthContinuityRelevant: inferOAuthContinuityRelevant(credential),
      continuity: continuity || null,
      subscriptionIntent: subscriptionIntent || null,
      protectedSecretMetaPresent: protectedSecret.protectedSecretMetaPresent,
      protectedSecretValuePresent: protectedSecret.protectedSecretValuePresent,
      protectedSecretMaterialPresent: protectedSecret.protectedSecretMaterialPresent,
      protectedSecretRef: protectedSecret.protectedSecretRef,
      continuityPolicy: config.policies?.apiKeyContinuity || 'preserve-if-supported',
      oauthContinuityPolicy: config.policies?.oauthClientContinuity || 'preserve-if-supported',
      blockers: [],
      warnings: [],
      manualReviewReasons: [],
    };
  });

  const subscriptions = [];
  for (const credential of normalizedCredentials) {
    const associations = credential.subscriptionIntent?.productAssociations || [];
    for (const association of associations) {
      const planTargets = normalizePlanTargets(
        association.productName,
        config.productPlanMap?.[association.productName] || null,
      );

      if (planTargets.length === 0) {
        subscriptions.push({
          sourceId: `${credential.credentialId}/${association.productName}`,
          baseSourceId: `${credential.credentialId}/${association.productName}`,
          kind: 'MigratedSubscription',
          credentialId: credential.credentialId,
          developerEmail: credential.developerEmail,
          developerStatus: developerByEmail.get(credential.developerEmail)?.status || 'active',
          appName: credential.appName,
          consumerKey: credential.consumerKey,
          productName: association.productName,
          sourceStatus: association.sourceStatus || null,
          recommendedAction: association.recommendedAction,
          targetStatusHint: association.targetStatusHint,
          desiredStatus: association.targetStatusHint,
          inactiveDeveloperPolicy: config.policies?.inactiveDeveloper || 'skip',
          planMapping: null,
          planTargets: [],
          lookupHints: {
            productName: association.productName,
            applicationSourceId: `${credential.developerEmail}/${credential.appName}`,
          },
          blockers: [],
          warnings: [],
          manualReviewReasons: [],
        });
        continue;
      }

      for (const planTarget of planTargets) {
        subscriptions.push({
          sourceId: `${credential.credentialId}/${association.productName}/${planTarget.targetKey}`,
          baseSourceId: `${credential.credentialId}/${association.productName}`,
          kind: 'MigratedSubscription',
          credentialId: credential.credentialId,
          developerEmail: credential.developerEmail,
          developerStatus: developerByEmail.get(credential.developerEmail)?.status || 'active',
          appName: credential.appName,
          consumerKey: credential.consumerKey,
          productName: association.productName,
          sourceStatus: association.sourceStatus || null,
          recommendedAction: association.recommendedAction,
          targetStatusHint: association.targetStatusHint,
          desiredStatus: association.targetStatusHint,
          inactiveDeveloperPolicy: config.policies?.inactiveDeveloper || 'skip',
          planMapping: planTarget,
          planTargets,
          lookupHints: {
            productName: association.productName,
            applicationSourceId: `${credential.developerEmail}/${credential.appName}`,
            targetApi: planTarget.targetApi,
            targetPlan: planTarget.targetPlan,
            targetKey: planTarget.targetKey,
          },
          blockers: [],
          warnings: [],
          manualReviewReasons: planTargets.length > 1 ? ['MULTI_TARGET_PRODUCT_MAPPING'] : [],
        });
      }
    }
  }

  return {
    irDir: path.resolve(irDir),
    manifest,
    extractionReport,
    references,
    inventories,
    products,
    users,
    applications,
    credentials: normalizedCredentials,
    subscriptions,
    indexes: {
      userByEmail: indexBy(users, (user) => user.email),
      appById: indexBy(applications, (app) => app.sourceId),
      credentialById: indexBy(normalizedCredentials, (credential) => credential.credentialId),
    },
    completeness: {
      manifestPresent: !!manifest,
      extractionReportPresent: !!extractionReport,
      subscriptionIntentPresent: !!references['subscription-intent'],
      credentialContinuityPresent: !!references['credential-continuity-index'],
      inactiveImpactPresent: !!references['inactive-impact'],
      developerCount: users.length,
      applicationCount: applications.length,
      credentialCount: normalizedCredentials.length,
      subscriptionCount: subscriptions.length,
    },
  };
}

module.exports = {
  RESERVED_APPLICATION_METADATA_KEYS,
  buildApplicationMetadata,
  loadDeveloperDomain,
};
