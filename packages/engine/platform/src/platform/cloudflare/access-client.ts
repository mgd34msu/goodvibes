import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { readCloudflareConfig } from './config.js';
import { CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY } from './constants.js';
import { resolveSecretRef } from './cloudflare-token-resolvers.js';
import { normalizeHostname } from './utils.js';

export interface CloudflareAccessCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Parse the JSON provisioning stores for the Access service token. */
export function parseAccessCredentials(value: string | null | undefined): CloudflareAccessCredentials | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const clientId = typeof record['clientId'] === 'string' ? record['clientId'].trim() : '';
    const clientSecret = typeof record['clientSecret'] === 'string' ? record['clientSecret'].trim() : '';
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  } catch {
    return null;
  }
}

/** The stored Access service token: `cloudflare.accessServiceTokenRef`, else the key provisioning writes. */
export async function resolveAccessCredentials(
  configManager: Pick<ConfigManager, 'get'>,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'> | null | undefined,
): Promise<CloudflareAccessCredentials | null> {
  const ctx = { secretsManager, readConfig: () => readCloudflareConfig(configManager) };
  const ref = configManager.get('cloudflare.accessServiceTokenRef');
  if (ref) {
    const fromRef = parseAccessCredentials((await resolveSecretRef(ctx, ref)).value);
    if (fromRef) return fromRef;
  }
  return parseAccessCredentials(await secretsManager?.get(CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY) ?? null);
}

/**
 * A fetch that presents the Access service token to the protected daemon
 * hostname and to nothing else. Clients that reach the daemon through its
 * Cloudflare hostname pass this as their transport's fetch (JSON calls and
 * event streams share it). Cost: two headers on requests to that one host.
 */
export function withCloudflareAccess(
  base: typeof fetch,
  protectedHostname: string,
  credentials: CloudflareAccessCredentials,
): typeof fetch {
  const host = normalizeHostname(protectedHostname);
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let target = '';
    try {
      target = new URL(url).hostname.toLowerCase();
    } catch {
      return base(input, init);
    }
    if (!host || target !== host) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('CF-Access-Client-Id', credentials.clientId);
    headers.set('CF-Access-Client-Secret', credentials.clientSecret);
    return base(input, { ...init, headers });
  };
  return Object.assign(wrapped, base) as typeof fetch;
}

/**
 * The fetch a client should use for `baseUrl`: Access-wrapped when that URL is
 * the protected daemon hostname and credentials are stored, else `base`.
 */
export async function cloudflareAccessFetchFor(
  baseUrl: string,
  configManager: Pick<ConfigManager, 'get'>,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'> | null | undefined,
  base: typeof fetch = fetch,
): Promise<typeof fetch> {
  const hostname = normalizeHostname(configManager.get('cloudflare.daemonHostname'));
  if (!hostname || !configManager.get('cloudflare.accessAppId')) return base;
  let target = '';
  try {
    target = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return base;
  }
  if (target !== hostname) return base;
  const credentials = await resolveAccessCredentials(configManager, secretsManager);
  return credentials ? withCloudflareAccess(base, hostname, credentials) : base;
}
