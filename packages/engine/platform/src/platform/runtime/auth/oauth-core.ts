import type { OAuthProviderConfig } from '../../config/subscriptions.js';
import { createSha256Hash, randomBytesBase64url } from './crypto-adapter.js';

import type { OAuthStartState, OAuthTokenPayload } from '../../../client-auth/oauth-types.js';
import { createTimeoutController, instrumentedFetch } from '../../utils/fetch-with-timeout.js';
export type { OAuthStartState, OAuthTokenPayload } from '../../../client-auth/oauth-types.js';

export function createOAuthState(bytes = 24): string {
  return randomBytesBase64url(bytes);
}

export function createPkceVerifier(bytes = 32): string {
  return randomBytesBase64url(bytes);
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  return createSha256Hash(verifier);
}

export function parseOAuthScopes(raw: unknown): readonly string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const scopes = raw.split(' ').map((value) => value.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

export async function buildOAuthAuthorizationStart(
  config: OAuthProviderConfig,
  input?: {
    readonly state?: string | undefined;
    readonly verifier?: string | undefined;
    readonly redirectUri?: string | undefined;
  },
): Promise<OAuthStartState> {
  const state = input?.state ?? createOAuthState();
  const verifier = input?.verifier ?? createPkceVerifier();
  const redirectUri = input?.redirectUri ?? config.redirectUri;
  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (config.scopes && config.scopes.length > 0) {
    url.searchParams.set('scope', config.scopes.join(' '));
  }
  if (config.audience) {
    url.searchParams.set('audience', config.audience);
  }
  if (config.usePkce ?? true) {
    url.searchParams.set('code_challenge', await createPkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(config.authParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return {
    authorizationUrl: url.toString(),
    state,
    verifier,
    redirectUri,
  };
}

/**
 * A token endpoint that ANSWERED, with a non-ok status. Distinguishable from
 * transport failures (which throw plain fetch errors) so a caller can tell
 * "the authorization server refused this grant" (4xx: the session is dead,
 * re-login) from "the authorization server is unreachable or broken" (5xx or
 * no answer: the session's state is unknown, do not tell the user to
 * re-login).
 */
export class OAuthTokenExchangeError extends Error {
  /** The `error` code of an RFC 6749 error answer (`invalid_grant`, ...), when the body carried one. */
  readonly oauthError: string | undefined;
  constructor(message: string, readonly status: number, oauthError?: string) {
    super(message);
    this.name = 'OAuthTokenExchangeError';
    this.oauthError = oauthError;
  }
}

/** The RFC 6749 `error` code in a token endpoint's error body, or undefined. */
function oauthErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** Bound on a token exchange: an authorization server that accepts the socket and hangs must not hang the caller's turn. */
const OAUTH_EXCHANGE_TIMEOUT_MS = 30_000;

async function exchangeOAuthRequest(
  url: string,
  encoding: 'form' | 'json',
  payload: Record<string, string | number | boolean>,
): Promise<OAuthTokenPayload> {
  const body = encoding === 'json'
    ? JSON.stringify(payload)
    : new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)])).toString();
  const timeout = createTimeoutController(OAUTH_EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await instrumentedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
      },
      body,
      signal: timeout.signal,
    });
  } finally {
    timeout.dispose();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OAuthTokenExchangeError(`OAuth token exchange failed (${response.status}): ${text}`, response.status, oauthErrorCode(text));
  }
  const json = await response.json() as {
    access_token?: unknown | undefined;
    refresh_token?: unknown | undefined;
    token_type?: unknown | undefined;
    expires_in?: unknown | undefined;
    scope?: unknown | undefined;
  };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('OAuth token exchange did not return an access token.');
  }
  const expiresIn = expiresInSeconds(json.expires_in);
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === 'string' && json.refresh_token.length > 0
      ? { refreshToken: json.refresh_token }
      : {}),
    tokenType: typeof json.token_type === 'string' && json.token_type.length > 0 ? json.token_type : 'Bearer',
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + (expiresIn * 1000) } : {}),
    ...(parseOAuthScopes(json.scope) ? { scopes: parseOAuthScopes(json.scope) } : {}),
  };
}

/** Some token endpoints return `expires_in` as a numeric string. */
function expiresInSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export async function exchangeOAuthAuthorizationCode(
  config: OAuthProviderConfig,
  input: {
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
    readonly state?: string | undefined;
  },
): Promise<OAuthTokenPayload> {
  const payload: Record<string, string | number | boolean> = {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
  };
  if (config.usePkce ?? true) payload.code_verifier = input.verifier;
  if (config.audience) payload.audience = config.audience;
  if (config.includeStateInTokenRequest && input.state) payload.state = input.state;
  for (const [key, value] of Object.entries(config.tokenRequestExtras ?? {})) {
    payload[key] = value;
  }
  return exchangeOAuthRequest(config.tokenUrl, config.tokenRequestEncoding ?? 'form', payload);
}

export async function refreshOAuthAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string,
): Promise<OAuthTokenPayload> {
  const payload: Record<string, string | number | boolean> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  if (config.refreshScopes && config.refreshScopes.length > 0) {
    payload.scope = config.refreshScopes.join(' ');
  }
  if (config.audience) payload.audience = config.audience;
  for (const [key, value] of Object.entries(config.refreshRequestExtras ?? {})) {
    payload[key] = value;
  }
  return exchangeOAuthRequest(config.tokenUrl, config.refreshRequestEncoding ?? config.tokenRequestEncoding ?? 'form', payload);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof atob !== 'function') {
    throw new Error('decodeJwtPayload requires a global atob(); available in browsers, RN Hermes, and Node >= 16');
  }
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    // atob is universally available (browsers, React Native, modern Node)
    const base64 = (parts[1]!).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
