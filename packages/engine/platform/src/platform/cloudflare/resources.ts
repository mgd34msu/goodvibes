import type { ConfigKey } from '../config/schema.js';
import { summarizeError } from '../utils/error-display.js';
import {
  CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY,
  CLOUDFLARE_TUNNEL_TOKEN_KEY,
} from './constants.js';
import type {
  CloudflareAccessApplicationLike,
  CloudflareAccessServiceTokenLike,
  CloudflareApiClient,
  CloudflareConsumerLike,
  CloudflareControlPlaneConfig,
  CloudflareDnsRecordLike,
  CloudflareDurableObjectNamespaceLike,
  CloudflareKvNamespaceLike,
  CloudflareProvisionStep,
  CloudflareQueueLike,
  CloudflareR2BucketLike,
  CloudflareSecretsStoreLike,
  CloudflareSecretsStoreSecretLike,
  CloudflareTunnelLike,
  CloudflareZoneLike,
} from './types.js';
import { CloudflareControlPlaneError } from './types.js';
import { clean, collectAsync, hostnameBelongsToZone, hostnameFromUrl, isPlaceholderHostname } from './utils.js';

export interface CloudflareProvisioningContext {
  readonly readConfig: () => CloudflareControlPlaneConfig;
  readonly setConfig: (key: ConfigKey, value: unknown, persist: boolean) => void;
  readonly storeSecret: (key: string, value: string) => Promise<void>;
}

export async function ensureQueue(
  client: CloudflareApiClient,
  accountId: string,
  queueName: string,
  steps: CloudflareProvisionStep[],
  stepName: string,
): Promise<CloudflareQueueLike> {
  const existing = await findQueueByName(client, accountId, queueName);
  if (existing) {
    steps.push({ name: stepName, status: 'ok', message: `Using existing Cloudflare Queue ${queueName}.`, resourceId: existing.queue_id });
    return existing;
  }
  try {
    const created = await client.queues.create({ account_id: accountId, queue_name: queueName });
    steps.push({ name: stepName, status: 'ok', message: `Created Cloudflare Queue ${queueName}.`, resourceId: created.queue_id });
    return created;
  } catch (error: unknown) {
    const recovered = await findQueueByName(client, accountId, queueName);
    if (recovered) {
      steps.push({ name: stepName, status: 'ok', message: `Using existing Cloudflare Queue ${queueName} after create retry: ${summarizeError(error)}`, resourceId: recovered.queue_id });
      return recovered;
    }
    throw error;
  }
}

export async function ensureKvNamespace(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  namespaceName: string,
  configuredNamespaceId: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareKvNamespaceLike> {
  if (!client.kv) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose KV namespace APIs.', 'CLOUDFLARE_KV_API_UNAVAILABLE', 500);
  }
  const existing = await findKvNamespace(client, accountId, namespaceName, configuredNamespaceId);
  if (existing) {
    persistKvNamespace(context, existing, namespaceName, persist);
    steps.push({ name: 'kv-namespace', status: 'ok', message: `Using existing KV namespace ${namespaceName}.`, resourceId: existing.id });
    return existing;
  }
  if (configuredNamespaceId) {
    const configured = { id: configuredNamespaceId, title: namespaceName };
    persistKvNamespace(context, configured, namespaceName, persist);
    steps.push({ name: 'kv-namespace', status: 'warning', message: `Using configured KV namespace id ${configuredNamespaceId}; it was not visible in this account, so the Worker binding may point at nothing. Clear cloudflare.kvNamespaceId to create a namespace instead.`, resourceId: configuredNamespaceId });
    return configured;
  }
  try {
    const created = await client.kv.namespaces.create({ account_id: accountId, title: namespaceName });
    persistKvNamespace(context, created, namespaceName, persist);
    steps.push({ name: 'kv-namespace', status: 'ok', message: `Created KV namespace ${namespaceName}.`, resourceId: created.id });
    return created;
  } catch (error: unknown) {
    const recovered = await findKvNamespace(client, accountId, namespaceName, configuredNamespaceId);
    if (recovered) {
      persistKvNamespace(context, recovered, namespaceName, persist);
      steps.push({ name: 'kv-namespace', status: 'ok', message: `Using existing KV namespace ${namespaceName} after create retry: ${summarizeError(error)}`, resourceId: recovered.id });
      return recovered;
    }
    throw error;
  }
}

export async function ensureR2Bucket(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  bucketName: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareR2BucketLike> {
  if (!client.r2) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose R2 bucket APIs.', 'CLOUDFLARE_R2_API_UNAVAILABLE', 500);
  }
  const existing = await findR2BucketByName(client, accountId, bucketName);
  if (existing) {
    context.setConfig('cloudflare.r2BucketName', bucketName, persist);
    steps.push({ name: 'r2-bucket', status: 'ok', message: `Using existing R2 Standard bucket ${bucketName}.`, resourceId: bucketName });
    return existing;
  }
  try {
    const created = await client.r2.buckets.create({ account_id: accountId, name: bucketName, storageClass: 'Standard' });
    context.setConfig('cloudflare.r2BucketName', bucketName, persist);
    steps.push({ name: 'r2-bucket', status: 'ok', message: `Created R2 Standard bucket ${bucketName}.`, resourceId: bucketName });
    return created.name ? created : { ...created, name: bucketName, storage_class: 'Standard' };
  } catch (error: unknown) {
    const recovered = await findR2BucketByName(client, accountId, bucketName);
    if (recovered) {
      context.setConfig('cloudflare.r2BucketName', bucketName, persist);
      steps.push({ name: 'r2-bucket', status: 'ok', message: `Using existing R2 bucket ${bucketName} after create retry: ${summarizeError(error)}`, resourceId: bucketName });
      return recovered;
    }
    throw error;
  }
}

export async function ensureSecretsStore(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  storeName: string,
  configuredStoreId: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareSecretsStoreLike> {
  if (!client.secretsStore) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Secrets Store APIs.', 'CLOUDFLARE_SECRETS_STORE_API_UNAVAILABLE', 500);
  }
  const existing = await findSecretsStore(client, accountId, storeName, configuredStoreId);
  if (existing) {
    persistSecretsStore(context, existing, persist);
    steps.push({ name: 'secrets-store', status: 'ok', message: `Using existing Cloudflare Secrets Store ${existing.name}.`, resourceId: existing.id });
    return existing;
  }
  if (configuredStoreId) {
    const configured = { id: configuredStoreId, name: storeName };
    persistSecretsStore(context, configured, persist);
    steps.push({ name: 'secrets-store', status: 'warning', message: `Using configured Cloudflare Secrets Store id ${configuredStoreId}; it was not visible during discovery.`, resourceId: configuredStoreId });
    return configured;
  }
  try {
    for await (const created of client.secretsStore.stores.create({ account_id: accountId, body: [{ name: storeName }] })) {
      persistSecretsStore(context, created, persist);
      steps.push({ name: 'secrets-store', status: 'ok', message: `Created Cloudflare Secrets Store ${storeName}.`, resourceId: created.id });
      return created;
    }
  } catch (error: unknown) {
    const recovered = await findRecoverableSecretsStore(client, accountId, storeName, configuredStoreId, error);
    if (recovered) {
      persistSecretsStore(context, recovered, persist);
      steps.push({ name: 'secrets-store', status: recovered.name === storeName ? 'ok' : 'warning', message: `Using existing Cloudflare Secrets Store ${recovered.name} after create retry: ${summarizeError(error)}`, resourceId: recovered.id });
      return recovered;
    }
    throw error;
  }
  throw new CloudflareControlPlaneError(`Cloudflare Secrets Store '${storeName}' did not return a created store.`, 'CLOUDFLARE_SECRETS_STORE_CREATE_FAILED', 502);
}

/**
 * Write one secret into the Secrets Store, replacing the value of a secret of
 * the same name. Scoped to Workers, which is the only reader.
 */
export async function ensureSecretsStoreSecret(
  client: CloudflareApiClient,
  input: { readonly accountId: string; readonly storeId: string; readonly name: string; readonly value: string },
): Promise<CloudflareSecretsStoreSecretLike> {
  const api = client.secretsStore?.stores.secrets;
  if (!api) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Secrets Store secret APIs.', 'CLOUDFLARE_SECRETS_STORE_API_UNAVAILABLE', 500);
  }
  for await (const existing of api.list(input.storeId, { account_id: input.accountId, search: input.name })) {
    if (existing.name === input.name) {
      await api.edit(input.storeId, existing.id, { account_id: input.accountId, value: input.value, scopes: ['workers'] });
      return existing;
    }
  }
  for await (const created of api.create(input.storeId, {
    account_id: input.accountId,
    body: [{ name: input.name, value: input.value, scopes: ['workers'], comment: 'Managed by GoodVibes Cloudflare provisioning' }],
  })) {
    return created;
  }
  throw new CloudflareControlPlaneError(`The Secrets Store did not return the created secret ${input.name}.`, 'CLOUDFLARE_SECRETS_STORE_SECRET_FAILED', 502);
}

async function readTunnelIngress(
  api: NonNullable<NonNullable<CloudflareApiClient['zeroTrust']>['tunnels']>['cloudflared'],
  tunnelId: string,
  accountId: string,
): Promise<Record<string, unknown>[] | undefined> {
  if (!api.configurations.get) return undefined;
  try {
    const current = await api.configurations.get(tunnelId, { account_id: accountId });
    return [...(current.config?.ingress ?? [])];
  } catch {
    return undefined;
  }
}

export async function ensureTunnel(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly tunnelName: string;
    readonly tunnelId: string;
    readonly daemonHostname: string;
    readonly tunnelServiceUrl: string;
    /** A reference the caller keeps the token under; provisioning then stores no copy. */
    readonly tokenRef?: string | undefined;
    readonly persist: boolean;
    readonly returnGeneratedSecrets: boolean;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<{ readonly id: string; readonly name: string; readonly token?: string; readonly tokenRef?: string }> {
  const api = client.zeroTrust?.tunnels?.cloudflared;
  if (!api) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Zero Trust Tunnel APIs.', 'CLOUDFLARE_TUNNEL_API_UNAVAILABLE', 500);
  }
  let tunnel: CloudflareTunnelLike | undefined;
  let createdTunnel = false;
  if (input.tunnelId) {
    tunnel = { id: input.tunnelId, name: input.tunnelName };
  } else {
    for await (const existing of api.list({ account_id: input.accountId, name: input.tunnelName, is_deleted: false })) {
      if (existing.name === input.tunnelName) {
        tunnel = existing;
        break;
      }
    }
    if (!tunnel) {
      try {
        tunnel = await api.create({ account_id: input.accountId, name: input.tunnelName, config_src: 'cloudflare' });
        createdTunnel = true;
        input.steps.push({ name: 'zero-trust-tunnel', status: 'ok', message: `Created Zero Trust Tunnel ${input.tunnelName}.`, resourceId: tunnel.id });
      } catch (error: unknown) {
        tunnel = await findTunnelByName(client, input.accountId, input.tunnelName);
        if (!tunnel) throw error;
        input.steps.push({ name: 'zero-trust-tunnel', status: 'ok', message: `Using existing Zero Trust Tunnel ${input.tunnelName} after create retry: ${summarizeError(error)}`, resourceId: tunnel.id });
      }
    } else {
      input.steps.push({ name: 'zero-trust-tunnel', status: 'ok', message: `Using existing Zero Trust Tunnel ${input.tunnelName}.`, resourceId: tunnel.id });
    }
  }
  if (!tunnel.id) {
    throw new CloudflareControlPlaneError(`Zero Trust Tunnel '${input.tunnelName}' did not include an id.`, 'CLOUDFLARE_TUNNEL_ID_MISSING', 502);
  }
  if (input.daemonHostname && input.tunnelServiceUrl) {
    const rule = { hostname: input.daemonHostname, service: input.tunnelServiceUrl };
    const catchAll = { service: 'http_status:404' };
    let ingress: Record<string, unknown>[] | undefined = [rule, catchAll];
    if (!createdTunnel) {
      // An existing tunnel may serve other hostnames: keep their rules, replace
      // only the one for this daemon, and leave the tunnel alone when its
      // current rules cannot be read rather than overwrite them blind.
      const current = await readTunnelIngress(api, tunnel.id, input.accountId);
      if (current === undefined) {
        ingress = undefined;
      } else {
        // Cloudflare requires exactly one catch-all (no hostname, no path), last.
        const isCatchAll = (entry: Record<string, unknown>): boolean => entry.hostname === undefined && entry.path === undefined;
        const others = current.filter((entry) => !isCatchAll(entry) && entry.hostname !== input.daemonHostname);
        const fallback = current.find(isCatchAll) ?? catchAll;
        ingress = [...others, rule, fallback];
      }
    }
    if (ingress) {
      await api.configurations.update(tunnel.id, { account_id: input.accountId, config: { ingress } });
      input.steps.push({ name: 'zero-trust-tunnel-config', status: 'ok', message: `Configured Tunnel ingress for ${input.daemonHostname}.` });
    } else {
      input.steps.push({
        name: 'zero-trust-tunnel-config',
        status: 'warning',
        message: `The existing Tunnel's ingress rules could not be read, so they were left unchanged. Add a rule for ${input.daemonHostname} pointing at ${input.tunnelServiceUrl} in Cloudflare.`,
      });
    }
  } else {
    input.steps.push({ name: 'zero-trust-tunnel-config', status: 'warning', message: 'Tunnel was created but no daemonHostname/tunnelServiceUrl was available for ingress configuration.' });
  }
  const token = await api.token.get(tunnel.id, { account_id: input.accountId });
  context.setConfig('cloudflare.tunnelName', input.tunnelName, input.persist);
  context.setConfig('cloudflare.tunnelId', tunnel.id, input.persist);
  // The token can be read from Cloudflare again at any time, so a run that
  // keeps nothing locally has nothing to lose by not storing it.
  let tokenRef: string | undefined;
  if (input.tokenRef) {
    tokenRef = input.tokenRef;
    context.setConfig('cloudflare.tunnelTokenRef', tokenRef, input.persist);
    input.steps.push({ name: 'zero-trust-tunnel-token', status: 'ok', message: `The tunnel connector reads its token from ${tokenRef}; no copy was stored.` });
  } else if (input.persist) {
    await context.storeSecret(CLOUDFLARE_TUNNEL_TOKEN_KEY, token);
    tokenRef = `goodvibes://secrets/goodvibes/${CLOUDFLARE_TUNNEL_TOKEN_KEY}`;
    context.setConfig('cloudflare.tunnelTokenRef', tokenRef, input.persist);
    input.steps.push({ name: 'zero-trust-tunnel-token', status: 'ok', message: 'Stored Tunnel token in the GoodVibes secret store.' });
  } else {
    input.steps.push({ name: 'zero-trust-tunnel-token', status: 'skipped', message: 'persistConfig is false, so the Tunnel token was not stored.' });
  }
  return { id: tunnel.id, name: tunnel.name ?? input.tunnelName, ...(input.returnGeneratedSecrets ? { token } : {}), ...(tokenRef ? { tokenRef } : {}) };
}

const ACCESS_APP_NAME = 'GoodVibes Daemon';
const DNS_RECORD_COMMENT = 'Managed by GoodVibes platform Cloudflare provisioning';

/**
 * An Access application on the daemon's hostname that GoodVibes did not create
 * carries someone else's login policy. Replacing it would lock out the people
 * it was written for, so it is left alone and the operator is told.
 */
function skipForeignAccessApp(
  input: { readonly daemonHostname: string; readonly steps: CloudflareProvisionStep[] },
  app: CloudflareAccessApplicationLike,
  serviceToken: CloudflareAccessServiceTokenLike,
  serviceTokenRef: string | undefined,
): CloudflareAccessOutcome {
  input.steps.push({
    name: 'zero-trust-access-app',
    status: 'warning',
    message: `An Access application named "${app.name ?? 'unnamed'}" already protects ${input.daemonHostname} and was not created by GoodVibes, so it was left unchanged. Rename or delete it in Cloudflare, or set cloudflare.accessAppId to let GoodVibes manage it.`,
    ...(app.id ? { resourceId: app.id } : {}),
  });
  return accessOutcome(undefined, serviceToken, serviceTokenRef);
}

export interface CloudflareAccessOutcome {
  /** Set only when the Access application now protects the daemon hostname. */
  readonly appId?: string | undefined;
  readonly serviceTokenId?: string | undefined;
  readonly serviceTokenRef?: string | undefined;
  /** The service token's credentials when Cloudflare returned them in this run (it does so once, at creation). */
  readonly credentials?: { readonly clientId: string; readonly clientSecret: string } | undefined;
}

function accessOutcome(
  appId: string | undefined,
  serviceToken: CloudflareAccessServiceTokenLike,
  serviceTokenRef: string | undefined,
): CloudflareAccessOutcome {
  return {
    ...(appId ? { appId } : {}),
    ...(serviceToken.id ? { serviceTokenId: serviceToken.id } : {}),
    ...(serviceTokenRef ? { serviceTokenRef } : {}),
    ...(serviceToken.client_id && serviceToken.client_secret
      ? { credentials: { clientId: serviceToken.client_id, clientSecret: serviceToken.client_secret } }
      : {}),
  };
}

export async function ensureAccess(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly daemonHostname: string;
    readonly accessAppId: string;
    readonly accessServiceTokenId: string;
    readonly accessServiceTokenRef: string;
    readonly zone?: CloudflareZoneLike | undefined;
    readonly persist: boolean;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<CloudflareAccessOutcome> {
  const api = client.zeroTrust?.access;
  if (!api) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Zero Trust Access APIs.', 'CLOUDFLARE_ACCESS_API_UNAVAILABLE', 500);
  }
  let serviceToken: CloudflareAccessServiceTokenLike | undefined = input.accessServiceTokenId ? { id: input.accessServiceTokenId } : undefined;
  if (!serviceToken) {
    for await (const existing of api.serviceTokens.list({ account_id: input.accountId, name: 'GoodVibes Daemon' })) {
      if (existing.name === 'GoodVibes Daemon') {
        serviceToken = existing;
        break;
      }
    }
  }
  if (!serviceToken) {
    try {
      serviceToken = await api.serviceTokens.create({ account_id: input.accountId, name: 'GoodVibes Daemon', duration: '8760h' });
      input.steps.push({ name: 'zero-trust-access-service-token', status: 'ok', message: 'Created Zero Trust Access service token.', resourceId: serviceToken.id });
    } catch (error: unknown) {
      serviceToken = await findAccessServiceTokenByName(api, input.accountId, 'GoodVibes Daemon');
      if (!serviceToken) throw error;
      input.steps.push({ name: 'zero-trust-access-service-token', status: 'ok', message: `Using existing Zero Trust Access service token after create retry: ${summarizeError(error)}`, resourceId: serviceToken.id });
    }
  } else {
    input.steps.push({ name: 'zero-trust-access-service-token', status: 'ok', message: 'Using existing Zero Trust Access service token.', resourceId: serviceToken.id });
  }
  let serviceTokenRef: string | undefined = input.accessServiceTokenRef || undefined;
  if (serviceToken.client_id && serviceToken.client_secret && !input.persist) {
    // Cloudflare shows this secret once, so a run that stores nothing must hand
    // it back (the caller passes returnGeneratedSecrets for that case).
    input.steps.push({ name: 'zero-trust-access-service-token-secret', status: 'skipped', message: 'persistConfig is false, so the Access service token credentials were not stored; they are returned in the result and Cloudflare will not show them again.' });
  } else if (serviceToken.client_id && serviceToken.client_secret) {
    await context.storeSecret(CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY, JSON.stringify({
      clientId: serviceToken.client_id,
      clientSecret: serviceToken.client_secret,
    }));
    serviceTokenRef = `goodvibes://secrets/goodvibes/${CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY}`;
    context.setConfig('cloudflare.accessServiceTokenRef', serviceTokenRef, input.persist);
    input.steps.push({ name: 'zero-trust-access-service-token-secret', status: 'ok', message: 'Stored Access service token credentials in the GoodVibes secret store.' });
  } else if (serviceTokenRef) {
    context.setConfig('cloudflare.accessServiceTokenRef', serviceTokenRef, input.persist);
    input.steps.push({ name: 'zero-trust-access-service-token-secret', status: 'ok', message: 'Using configured Access service token secret reference.' });
  } else {
    // Cloudflare returns a service token's secret only when it is created.
    input.steps.push({ name: 'zero-trust-access-service-token-secret', status: 'warning', message: 'The existing Access service token has no secret on record, so the daemon has no credential for it. Set cloudflare.accessServiceTokenRef, or delete the token in Cloudflare and provision again to mint a new one.' });
  }
  if (serviceToken.id) context.setConfig('cloudflare.accessServiceTokenId', serviceToken.id, input.persist);

  if (!input.daemonHostname || !serviceToken.id) {
    input.steps.push({ name: 'zero-trust-access-app', status: 'warning', message: 'Access application was skipped because daemonHostname or service token id is missing.' });
    return accessOutcome(undefined, serviceToken, serviceTokenRef);
  }
  if (!input.zone && isPlaceholderHostname(input.daemonHostname)) {
    input.steps.push({ name: 'zero-trust-access-app', status: 'warning', message: `Access application was skipped because daemonHostname ${input.daemonHostname} is a placeholder hostname.` });
    return accessOutcome(undefined, serviceToken, serviceTokenRef);
  }
  if (input.zone && !hostnameBelongsToZone(input.daemonHostname, input.zone.name)) {
    input.steps.push({ name: 'zero-trust-access-app', status: 'warning', message: `Access application was skipped because daemonHostname ${input.daemonHostname} does not belong to selected zone ${input.zone.name}.` });
    return accessOutcome(undefined, serviceToken, serviceTokenRef);
  }

  let app: CloudflareAccessApplicationLike | undefined = input.accessAppId ? { id: input.accessAppId } : undefined;
  if (!app) {
    for await (const existing of api.applications.list({ account_id: input.accountId, domain: input.daemonHostname, exact: true })) {
      if (existing.domain === input.daemonHostname) {
        app = existing;
        break;
      }
    }
    if (app && app.name !== ACCESS_APP_NAME) return skipForeignAccessApp(input, app, serviceToken, serviceTokenRef);
  }
  const accessAppParams = {
    account_id: input.accountId,
    domain: input.daemonHostname,
    type: 'self_hosted',
    name: ACCESS_APP_NAME,
    session_duration: '24h',
    service_auth_401_redirect: true,
    policies: [
      {
        name: 'GoodVibes service token',
        decision: 'non_identity',
        include: [{ service_token: { token_id: serviceToken.id } }],
      },
    ],
  };
  if (app?.id) {
    app = await api.applications.update(app.id, accessAppParams);
  } else {
    try {
      app = await api.applications.create(accessAppParams);
    } catch (error: unknown) {
      const recovered = await findAccessApplicationByDomain(api, input.accountId, input.daemonHostname);
      if (!recovered?.id) throw error;
      if (recovered.name !== ACCESS_APP_NAME) return skipForeignAccessApp(input, recovered, serviceToken, serviceTokenRef);
      app = await api.applications.update(recovered.id, accessAppParams);
    }
  }
  if (app.id) context.setConfig('cloudflare.accessAppId', app.id, input.persist);
  input.steps.push({ name: 'zero-trust-access-app', status: 'ok', message: `Configured Zero Trust Access application for ${input.daemonHostname}.`, resourceId: app.id });
  return accessOutcome(app.id, serviceToken, serviceTokenRef);
}

export async function configureDns(
  client: CloudflareApiClient,
  input: {
    readonly enabled: boolean;
    readonly zone?: CloudflareZoneLike | undefined;
    readonly daemonHostname: string;
    readonly tunnelId: string;
    /** Set when the daemon hostname must not be published; the text says why. */
    readonly withholdDaemonHostname?: string | undefined;
    readonly workerHostname: string;
    readonly workerBaseUrl: string;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<readonly CloudflareDnsRecordLike[]> {
  if (!input.enabled) return [];
  if (!client.dns) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose DNS record APIs.', 'CLOUDFLARE_DNS_API_UNAVAILABLE', 500);
  }
  if (!input.zone) {
    input.steps.push({ name: 'dns', status: 'warning', message: 'DNS automation skipped because no Cloudflare zone was selected.' });
    return [];
  }
  // Only records GoodVibes uses are returned: one left alone because it is someone else's is named in a warning step instead.
  const records: CloudflareDnsRecordLike[] = [];
  let attempted = 0;
  const keep = (record: CloudflareDnsRecordLike | null): void => {
    attempted += 1;
    if (record) records.push(record);
  };
  if (input.daemonHostname && input.tunnelId && input.withholdDaemonHostname) {
    input.steps.push({ name: 'dns-daemon-hostname', status: 'warning', message: `Did not publish ${input.daemonHostname}: ${input.withholdDaemonHostname}` });
  } else if (input.daemonHostname && input.tunnelId) {
    if (hostnameBelongsToZone(input.daemonHostname, input.zone.name)) {
      keep(await ensureCnameRecord(client, input.zone.id, input.daemonHostname, `${input.tunnelId}.cfargotunnel.com`, input.steps, 'dns-daemon-hostname'));
    } else {
      input.steps.push({ name: 'dns-daemon-hostname', status: 'warning', message: `Skipped daemon DNS record because ${input.daemonHostname} does not belong to selected zone ${input.zone.name}.` });
    }
  }
  const workerTarget = hostnameFromUrl(input.workerBaseUrl);
  if (input.workerHostname && workerTarget) {
    if (hostnameBelongsToZone(input.workerHostname, input.zone.name)) {
      keep(await ensureCnameRecord(client, input.zone.id, input.workerHostname, workerTarget, input.steps, 'dns-worker-hostname'));
    } else {
      input.steps.push({ name: 'dns-worker-hostname', status: 'warning', message: `Skipped Worker DNS record because ${input.workerHostname} does not belong to selected zone ${input.zone.name}.` });
    }
  }
  if (attempted === 0 && !input.withholdDaemonHostname) input.steps.push({ name: 'dns', status: 'skipped', message: 'No daemonHostname/tunnelId or workerHostname/workerBaseUrl pair was available for DNS automation.' });
  return records;
}

export async function findDurableObjectNamespace(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  namespaceName: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareDurableObjectNamespaceLike | undefined> {
  if (!client.durableObjects) {
    steps.push({ name: 'durable-object-namespace', status: 'warning', message: 'Durable Object namespace binding was installed on the Worker, but the client cannot list namespaces for confirmation.' });
    return { name: namespaceName };
  }
  for await (const namespace of client.durableObjects.namespaces.list({ account_id: accountId })) {
    if (namespace.name === namespaceName || namespace.class === namespaceName) {
      context.setConfig('cloudflare.durableObjectNamespaceName', namespaceName, persist);
      if (namespace.id) context.setConfig('cloudflare.durableObjectNamespaceId', namespace.id, persist);
      steps.push({ name: 'durable-object-namespace', status: 'ok', message: `Confirmed Durable Object namespace ${namespaceName}.`, resourceId: namespace.id });
      return namespace;
    }
  }
  steps.push({ name: 'durable-object-namespace', status: 'warning', message: 'Durable Object migration was included, but the namespace was not visible yet during confirmation.' });
  return { name: namespaceName };
}

export async function ensureQueueConsumer(
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly queueId: string;
    readonly workerName: string;
    readonly deadLetterQueueName: string;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<CloudflareConsumerLike> {
  const settings = {
    batch_size: 10,
    max_retries: 3,
    max_wait_time_ms: 5000,
    retry_delay: 60,
  };
  for await (const consumer of client.queues.consumers.list(input.queueId, { account_id: input.accountId })) {
    if (consumer.type === 'worker' && consumer.script === input.workerName && consumer.consumer_id) {
      const updated = await client.queues.consumers.update(input.queueId, consumer.consumer_id, {
        account_id: input.accountId,
        type: 'worker',
        script_name: input.workerName,
        dead_letter_queue: input.deadLetterQueueName,
        settings,
      });
      input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Updated Queue consumer for ${input.workerName}.`, resourceId: updated.consumer_id });
      return updated;
    }
  }
  try {
    const created = await client.queues.consumers.create(input.queueId, {
      account_id: input.accountId,
      type: 'worker',
      script_name: input.workerName,
      dead_letter_queue: input.deadLetterQueueName,
      settings,
    });
    input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Created Queue consumer for ${input.workerName}.`, resourceId: created.consumer_id });
    return created;
  } catch (error: unknown) {
    const recovered = await findQueueConsumer(client, input.accountId, input.queueId, input.workerName);
    if (!recovered?.consumer_id) throw error;
    const updated = await client.queues.consumers.update(input.queueId, recovered.consumer_id, {
      account_id: input.accountId,
      type: 'worker',
      script_name: input.workerName,
      dead_letter_queue: input.deadLetterQueueName,
      settings,
    });
    input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Updated existing Queue consumer for ${input.workerName} after create retry: ${summarizeError(error)}`, resourceId: updated.consumer_id });
    return updated;
  }
}

async function ensureCnameRecord(
  client: CloudflareApiClient,
  zoneId: string,
  hostname: string,
  target: string,
  steps: CloudflareProvisionStep[],
  stepName: string,
): Promise<CloudflareDnsRecordLike | null> {
  const existing = await collectAsync(client.dns!.records.list({ zone_id: zoneId, type: 'CNAME', name: { exact: hostname } }) ?? []);
  const match = existing.find((record) => record.name === hostname && record.type === 'CNAME');
  const params = {
    zone_id: zoneId,
    type: 'CNAME' as const,
    name: hostname,
    content: target,
    proxied: true,
    ttl: 1,
    comment: DNS_RECORD_COMMENT,
  };
  if (match?.id) {
    if (match.content === target && match.proxied !== false) {
      steps.push({ name: stepName, status: 'ok', message: `Using existing CNAME ${hostname} -> ${target}.`, resourceId: match.id });
      return match;
    }
    if (match.comment !== DNS_RECORD_COMMENT) {
      // Pointing someone else's record at the daemon would take their site down.
      steps.push({ name: stepName, status: 'warning', message: `A CNAME for ${hostname} already exists pointing at ${match.content} and was not created by GoodVibes, so it was left unchanged. Delete it in Cloudflare or choose another hostname.`, resourceId: match.id });
      return null;
    }
    const updated = await client.dns!.records.update(match.id, params);
    steps.push({ name: stepName, status: 'ok', message: `Updated CNAME ${hostname} -> ${target}.`, resourceId: updated.id });
    return updated;
  }
  try {
    const created = await client.dns!.records.create(params);
    steps.push({ name: stepName, status: 'ok', message: `Created CNAME ${hostname} -> ${target}.`, resourceId: created.id });
    return created;
  } catch (error: unknown) {
    const recovered = await findCnameRecord(client, zoneId, hostname);
    if (!recovered?.id) throw error;
    if (recovered.content !== target && recovered.comment !== DNS_RECORD_COMMENT) {
      steps.push({ name: stepName, status: 'warning', message: `A CNAME for ${hostname} already exists pointing at ${recovered.content} and was not created by GoodVibes, so it was left unchanged.`, resourceId: recovered.id });
      return null;
    }
    const updated = await client.dns!.records.update(recovered.id, params);
    steps.push({ name: stepName, status: 'ok', message: `Updated existing CNAME ${hostname} -> ${target} after create retry: ${summarizeError(error)}`, resourceId: updated.id });
    return updated;
  }
}

async function findQueueByName(
  client: CloudflareApiClient,
  accountId: string,
  queueName: string,
): Promise<CloudflareQueueLike | undefined> {
  for await (const queue of client.queues.list({ account_id: accountId })) {
    if (queue.queue_name === queueName) return queue;
  }
  return undefined;
}

async function findKvNamespace(
  client: CloudflareApiClient,
  accountId: string,
  namespaceName: string,
  namespaceId: string,
): Promise<CloudflareKvNamespaceLike | undefined> {
  for await (const namespace of (client.kv?.namespaces.list({ account_id: accountId }) ?? [])) {
    if (namespace.title === namespaceName || (namespaceId && namespace.id === namespaceId)) return namespace;
  }
  return undefined;
}

function persistKvNamespace(
  context: CloudflareProvisioningContext,
  namespace: CloudflareKvNamespaceLike,
  namespaceName: string,
  persist: boolean,
): void {
  context.setConfig('cloudflare.kvNamespaceName', namespace.title ?? namespaceName, persist);
  if (namespace.id) context.setConfig('cloudflare.kvNamespaceId', namespace.id, persist);
}

async function findR2BucketByName(
  client: CloudflareApiClient,
  accountId: string,
  bucketName: string,
): Promise<CloudflareR2BucketLike | undefined> {
  const listed = (await client.r2?.buckets.list({ account_id: accountId }))?.buckets?.find((bucket) => bucket.name === bucketName);
  if (listed) return listed;
  if (!client.r2?.buckets.get) return undefined;
  try {
    const bucket = await client.r2?.buckets.get?.(bucketName, { account_id: accountId });
    return bucket.name ? bucket : { ...bucket, name: bucketName };
  } catch {
    return undefined;
  }
}

async function findSecretsStore(
  client: CloudflareApiClient,
  accountId: string,
  storeName: string,
  storeId: string,
): Promise<CloudflareSecretsStoreLike | undefined> {
  for await (const store of (client.secretsStore?.stores.list({ account_id: accountId }) ?? [])) {
    if (store.name === storeName || (storeId && store.id === storeId)) return store;
  }
  return undefined;
}

async function findRecoverableSecretsStore(
  client: CloudflareApiClient,
  accountId: string,
  storeName: string,
  storeId: string,
  error: unknown,
): Promise<CloudflareSecretsStoreLike | undefined> {
  const stores = await collectAsync(client.secretsStore!.stores.list({ account_id: accountId }) ?? []);
  const exact = stores.find((store) => store.name === storeName || (storeId && store.id === storeId));
  if (exact) return exact;
  if (isMaximumStoresExceeded(error) && stores.length === 1) return stores[0];
  return undefined;
}

function persistSecretsStore(
  context: CloudflareProvisioningContext,
  store: CloudflareSecretsStoreLike,
  persist: boolean,
): void {
  context.setConfig('cloudflare.secretsStoreName', store.name, persist);
  context.setConfig('cloudflare.secretsStoreId', store.id, persist);
}

function isMaximumStoresExceeded(error: unknown): boolean {
  return summarizeError(error).toLowerCase().includes('maximum_stores_exceeded');
}

async function findTunnelByName(
  client: CloudflareApiClient,
  accountId: string,
  tunnelName: string,
): Promise<CloudflareTunnelLike | undefined> {
  const api = client.zeroTrust?.tunnels?.cloudflared;
  if (!api) return undefined;
  for await (const tunnel of api.list({ account_id: accountId, name: tunnelName, is_deleted: false })) {
    if (tunnel.name === tunnelName) return tunnel;
  }
  return undefined;
}

type CloudflareAccessApi = NonNullable<NonNullable<CloudflareApiClient['zeroTrust']>['access']>;

async function findAccessServiceTokenByName(
  api: CloudflareAccessApi,
  accountId: string,
  name: string,
): Promise<CloudflareAccessServiceTokenLike | undefined> {
  for await (const token of api.serviceTokens.list({ account_id: accountId, name })) {
    if (token.name === name) return token;
  }
  return undefined;
}

async function findAccessApplicationByDomain(
  api: CloudflareAccessApi,
  accountId: string,
  domain: string,
): Promise<CloudflareAccessApplicationLike | undefined> {
  for await (const app of api.applications.list({ account_id: accountId, domain, exact: true })) {
    if (app.domain === domain) return app;
  }
  return undefined;
}

async function findQueueConsumer(
  client: CloudflareApiClient,
  accountId: string,
  queueId: string,
  workerName: string,
): Promise<CloudflareConsumerLike | undefined> {
  for await (const consumer of client.queues.consumers.list(queueId, { account_id: accountId })) {
    if (consumer.type === 'worker' && consumer.script === workerName) return consumer;
  }
  return undefined;
}

async function findCnameRecord(
  client: CloudflareApiClient,
  zoneId: string,
  hostname: string,
): Promise<CloudflareDnsRecordLike | undefined> {
  const existing = await collectAsync(client.dns!.records.list({ zone_id: zoneId, type: 'CNAME', name: { exact: hostname } }) ?? []);
  return existing.find((record) => record.name === hostname && record.type === 'CNAME');
}
