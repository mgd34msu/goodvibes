import { revealOrNull } from '../security/secret.js';
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
  return parseAccessCredentials(revealOrNull(await secretsManager?.get(CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY), 'dispatch'));
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

function requestHostname(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A fetch that presents the Access service token to the protected daemon
 * hostname, read from the settings on every request, so a client that turns
 * Access on, or is pointed at the daemon's Cloudflare hostname, presents it
 * with no restart. Per request: three in-memory setting reads, and a URL parse
 * only while Access is on. The token is looked up once per setting change; a
 * missing one is looked up again on the next request to that host.
 */
export function createCloudflareAccessFetch(
  configManager: Pick<ConfigManager, 'get'>,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'> | null | undefined,
  base: typeof fetch = fetch,
): typeof fetch {
  let cached: { readonly key: string; readonly credentials: Promise<CloudflareAccessCredentials | null> } | null = null;
  const credentialsFor = (key: string): Promise<CloudflareAccessCredentials | null> => {
    if (cached?.key === key) return cached.credentials;
    const credentials = resolveAccessCredentials(configManager, secretsManager).catch(() => null);
    const entry = { key, credentials };
    cached = entry;
    void credentials.then((value) => {
      if (value === null && cached === entry) cached = null;
    });
    return credentials;
  };
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const appId = configManager.get('cloudflare.accessAppId');
    const hostname = appId ? normalizeHostname(configManager.get('cloudflare.daemonHostname')) : '';
    if (!hostname || requestHostname(input) !== hostname) return base(input, init);
    const credentials = await credentialsFor(`${hostname}\u0000${appId}\u0000${configManager.get('cloudflare.accessServiceTokenRef')}`);
    return credentials ? withCloudflareAccess(base, hostname, credentials)(input, init) : base(input, init);
  };
  return Object.assign(wrapped, base) as typeof fetch;
}

let installedAccessFetch: { readonly base: typeof fetch; readonly wrapper: typeof fetch } | null = null;

/**
 * Makes this process's `fetch` present the Access service token to the
 * protected daemon hostname, so every client path that reaches the daemon by
 * that hostname (JSON calls, event streams, pairing, receipts) is let through
 * by Access. Requests to any other host are untouched. A terminal app calls it
 * once at start; calling it again replaces the settings it reads instead of
 * wrapping twice. Returns the undo.
 */
export function installCloudflareAccessFetch(
  configManager: Pick<ConfigManager, 'get'>,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'> | null | undefined,
): () => void {
  const base = installedAccessFetch && globalThis.fetch === installedAccessFetch.wrapper ? installedAccessFetch.base : globalThis.fetch;
  const wrapper = createCloudflareAccessFetch(configManager, secretsManager, base);
  globalThis.fetch = wrapper;
  installedAccessFetch = { base, wrapper };
  return () => {
    if (globalThis.fetch !== wrapper) return;
    globalThis.fetch = base;
    installedAccessFetch = null;
  };
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
