/**
 * Verification of the token Azure Bot Service sends with every Teams activity.
 *
 * The Bot Framework signs a JWT (RS256) and puts it in `Authorization: Bearer`.
 * It is accepted when its key is one the Bot Framework publishes, its issuer is
 * the Bot Framework, its audience is this bot's app id, it is within its
 * lifetime, and (checked by the caller once the body is read) its `serviceurl`
 * claim names the activity's `serviceUrl` and the key is endorsed for the
 * activity's channel.
 *
 * Cost: one RSA signature check per request. The published keys are fetched
 * once a day, and again (at most every five minutes) only when a token names a
 * key that is not in the cached set, which is how a rotation is picked up.
 */
import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';

const OPENID_METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const KEY_CACHE_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_KEY_REFRESH_FLOOR_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 5 * 60;
const FETCH_TIMEOUT_MS = 10_000;

export type BotFrameworkFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

interface SigningKey {
  readonly key: KeyObject;
  /** Channels this key is endorsed for; absent when the key carries no list. */
  readonly endorsements: readonly string[] | undefined;
}

interface KeyCache {
  keys: ReadonlyMap<string, SigningKey>;
  fetchedAt: number;
  inflight: Promise<ReadonlyMap<string, SigningKey>> | undefined;
}

const defaultFetch: BotFrameworkFetch = (url, init) => fetch(url, init);
const caches = new WeakMap<BotFrameworkFetch, KeyCache>();

export interface BotFrameworkClaims {
  readonly serviceUrl: string | undefined;
  /** The signing key's channel endorsements, when it lists any. */
  readonly endorsements: readonly string[] | undefined;
}

export type BotFrameworkVerification =
  | { readonly ok: true; readonly claims: BotFrameworkClaims }
  | { readonly ok: false; readonly reason: string };

/** True when `token` has the three-part shape of a JWT (not whether it is valid). */
export function looksLikeJwt(token: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function fetchJson(fetcher: BotFrameworkFetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${url} did not return a JSON object`);
  return body as Record<string, unknown>;
}

async function loadSigningKeys(fetcher: BotFrameworkFetch): Promise<ReadonlyMap<string, SigningKey>> {
  const metadata = await fetchJson(fetcher, OPENID_METADATA_URL);
  const jwksUri = typeof metadata['jwks_uri'] === 'string' ? metadata['jwks_uri'] : '';
  if (!jwksUri.startsWith('https://')) throw new Error('the Bot Framework OpenID metadata names no https key set');
  const jwks = await fetchJson(fetcher, jwksUri);
  const keys = new Map<string, SigningKey>();
  for (const entry of Array.isArray(jwks['keys']) ? jwks['keys'] : []) {
    if (!entry || typeof entry !== 'object') continue;
    const jwk = entry as JsonWebKey & { kid?: unknown; endorsements?: unknown };
    if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    try {
      const material: JsonWebKey = { kty: 'RSA', n: jwk.n, e: jwk.e };
      keys.set(jwk.kid, {
        key: createPublicKey({ key: material, format: 'jwk' }),
        endorsements: Array.isArray(jwk.endorsements)
          ? jwk.endorsements.filter((value): value is string => typeof value === 'string')
          : undefined,
      });
    } catch {
      // A key this runtime cannot import is skipped; the others still verify.
    }
  }
  if (keys.size === 0) throw new Error('the Bot Framework key set held no usable keys');
  return keys;
}

async function signingKey(fetcher: BotFrameworkFetch, kid: string, now: number): Promise<SigningKey | undefined> {
  let cache = caches.get(fetcher);
  if (!cache) {
    cache = { keys: new Map(), fetchedAt: 0, inflight: undefined };
    caches.set(fetcher, cache);
  }
  const stale = now - cache.fetchedAt > KEY_CACHE_MS;
  const unknown = !cache.keys.has(kid) && now - cache.fetchedAt > UNKNOWN_KEY_REFRESH_FLOOR_MS;
  if (stale || unknown) {
    const current = cache;
    current.inflight ??= loadSigningKeys(fetcher).then((keys) => {
      current.keys = keys;
      current.fetchedAt = now;
      return keys;
    }).finally(() => { current.inflight = undefined; });
    try {
      await current.inflight;
    } catch (error) {
      // A cached set that is merely old still verifies while the fetch fails.
      if (current.keys.size === 0) throw error;
    }
  }
  return cache.keys.get(kid);
}

/**
 * Verify a Bot Framework bearer token for `appId`. Never throws: a failure is
 * a reason the caller logs and answers with 401.
 */
export async function verifyBotFrameworkToken(
  token: string,
  options: { readonly appId: string; readonly fetch?: BotFrameworkFetch | undefined; readonly now?: (() => number) | undefined },
): Promise<BotFrameworkVerification> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeSegment(headerPart);
  const payload = decodeSegment(payloadPart);
  if (!header || !payload) return { ok: false, reason: 'unreadable token' };
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return { ok: false, reason: 'unsupported token algorithm or no key id' };
  const now = (options.now ?? Date.now)();
  let key: SigningKey | undefined;
  try {
    key = await signingKey(options.fetch ?? defaultFetch, header['kid'], now);
  } catch (error) {
    return { ok: false, reason: `the Bot Framework signing keys could not be fetched (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!key) return { ok: false, reason: 'signed with a key the Bot Framework does not publish' };
  const signed = verifySignature('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'), key.key, Buffer.from(signaturePart, 'base64url'));
  if (!signed) return { ok: false, reason: 'bad signature' };
  if (payload['iss'] !== BOT_FRAMEWORK_ISSUER) return { ok: false, reason: 'wrong issuer' };
  const audience = payload['aud'];
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(options.appId)) return { ok: false, reason: 'issued for another app id' };
  const seconds = Math.floor(now / 1000);
  const exp = payload['exp'];
  const nbf = payload['nbf'];
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < seconds) return { ok: false, reason: 'expired' };
  if (typeof nbf === 'number' && nbf - CLOCK_SKEW_SECONDS > seconds) return { ok: false, reason: 'not yet valid' };
  const serviceUrl = payload['serviceurl'] ?? payload['serviceUrl'];
  return {
    ok: true,
    claims: { serviceUrl: typeof serviceUrl === 'string' ? serviceUrl : undefined, endorsements: key.endorsements },
  };
}

/** Whether two service URLs name the same endpoint (case and a trailing slash aside). */
export function sameServiceUrl(a: string, b: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}
