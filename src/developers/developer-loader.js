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
    value: attr.value,
  }));
}

function mapCustomFields(attributes, customFieldMap = {}) {
  return normalizeAttributes(attributes).map((attr) => ({
    sourceName: attr.name,
    targetName: customFieldMap[attr.name] || attr.name,
    value: attr.value,
  }));
}

function filterByRules(items, includeSet, excludeSet, keyFn) {
  return items.filter((item) => {
    const key = keyFn(item);
    if (includeSet.size > 0 && !includeSet.has(key)) return false;
    if (excludeSet.has(key)) return false;
    return true;
  });
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

  const developers = filterByRules(loader.developers(), includeDevelopers, excludeDevelopers, (developer) => developer.email);
  const developerEmails = new Set(developers.map((developer) => developer.email));

  const apps = filterByRules(
    loader.apps().filter((app) => developerEmails.size === 0 || developerEmails.has(app.developer_email)),
    includeApps,
    excludeApps,
    (app) => `${app.developer_email}/${app.name}`,
  );

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
    customFields: mapCustomFields(developer.attributes, config.customFieldMap),
    appNames: developer.apps || [],
    inactiveImpact: inactiveImpactByDeveloper.get(developer.email) || null,
    customFieldCandidates: normalizeAttributes(developer.attributes).map((attr) => attr.name),
    lookupHints: {
      email: developer.email,
    },
    blockers: [],
    warnings: [],
    manualReviewReasons: developer.status !== 'active' ? ['INACTIVE_DEVELOPER_POLICY_REQUIRED'] : [],
  }));

  const applications = apps.map((app) => {
    const sourceId = `${app.developer_email}/${app.name}`;
    return {
      sourceId,
      kind: 'MigratedApplication',
      developerEmail: app.developer_email,
      appName: app.name,
      appId: app.app_id || '',
      status: app.status || 'approved',
      callbackUrl: app.callback_url || '',
      attributes: normalizeAttributes(app.attributes),
      customFields: mapCustomFields(app.attributes, config.customFieldMap),
      credentialIds: (app.credentials || []).map((credential) => `${app.developer_email}/${app.name}/${credential.consumer_key}`),
      customFieldCandidates: normalizeAttributes(app.attributes).map((attr) => attr.name),
      ownershipStrategy: config.capabilities?.applicationOwnership || 'unknown',
      lookupHints: {
        name: app.name,
        ownerHint: app.developer_email,
        sourceId,
      },
      blockers: [],
      warnings: [],
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
      continuity: continuity || null,
      subscriptionIntent: subscriptionIntent || null,
      protectedSecretMetaPresent: !!secretMeta,
      protectedSecretRef: credential.consumer_secret_ref
        ? path.join(irDir, credential.consumer_secret_ref)
        : null,
      continuityPolicy: config.policies?.apiKeyContinuity || 'preserve-if-supported',
      blockers: [],
      warnings: [],
      manualReviewReasons: [],
    };
  });

  const subscriptions = [];
  for (const credential of normalizedCredentials) {
    const associations = credential.subscriptionIntent?.productAssociations || [];
    for (const association of associations) {
      subscriptions.push({
        sourceId: `${credential.credentialId}/${association.productName}`,
        kind: 'MigratedSubscription',
        credentialId: credential.credentialId,
        developerEmail: credential.developerEmail,
        appName: credential.appName,
        consumerKey: credential.consumerKey,
        productName: association.productName,
        sourceStatus: association.sourceStatus || null,
        recommendedAction: association.recommendedAction,
        targetStatusHint: association.targetStatusHint,
        desiredStatus: association.targetStatusHint,
        planMapping: config.productPlanMap?.[association.productName] || null,
        lookupHints: {
          productName: association.productName,
          applicationSourceId: `${credential.developerEmail}/${credential.appName}`,
        },
        blockers: [],
        warnings: [],
        manualReviewReasons: [],
      });
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

module.exports = { loadDeveloperDomain };
