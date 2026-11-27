import { randomBytes, timingSafeEqual } from 'node:crypto';
import { actorFromPrincipal, type Actor, type OwnerIdentity } from '@goodvibes/engine/daemon-api/http-policy';
import type { UserAuthManager } from './user-auth.js';
import type { AuthenticatedNativePairingToken, SettingsPairingAuthority, NativeContinuationGrant, NativeContinuationAuthority, NativeCredential } from '../pairing/pairing-token-store.js';
import { LOCAL_OWNER_PRINCIPAL, pairingPrincipalId } from '../pairing/principal-ids.js';
import type { RevisionSource } from '../utils/revision.js';

export const OPERATOR_SESSION_COOKIE_NAME = 'goodvibes_session';
/**
 * The browser's readable sign-in marker, set beside the HttpOnly credential cookie and
 * cleared with it: `<generation>.<principal, base64url>`. It names who is signed in and
 * changes with every sign-in, so a page can tell an identity change without ever seeing
 * the credential. It authenticates nothing.
 */
export const IDENTITY_MARKER_COOKIE_NAME = 'goodvibes_identity';
/**
 * The web UI's phone-as-device-node credential (a remote peer token): HttpOnly and
 * SameSite=Strict like the sign-in cookie, but its own cookie with Path=/api/remote, so
 * it is sent only to the peer routes and is read only as a peer token
 * ({@link extractRemotePeerToken}), never as an operator credential.
 */
export const REMOTE_NODE_COOKIE_NAME = 'goodvibes_node';
const REMOTE_NODE_COOKIE_PATH = '/api/remote';
/** How long a browser keeps a credential that does not expire by itself (a device or operator token): the longest a browser keeps a cookie. */
export const NON_EXPIRING_BROWSER_CREDENTIAL_MS = 400 * 24 * 60 * 60 * 1_000;

export type AuthenticatedOperatorRequest =
  | {
      readonly kind: 'shared-token';
      readonly token: string;
    }
  | {
      readonly kind: 'pairing-token';
      readonly token: string;
      /** The per-pairing token's id (for `pairing:<id>` principal derivation). */
      readonly tokenId: string;
      /** The user-visible device name for this token. */
      readonly name: string;
      /** Set when the pairing is the Agent's credential for the calls it makes on the owner's behalf. */
      readonly client?: 'agent' | undefined;
      /** The scope list the pairing stores, when narrower than full operator authority. */
      readonly scopes?: readonly string[] | undefined;
      /** A device the owner paired himself through his pairing flow, recorded when it was minted. */
      readonly ownerDevice?: true | undefined;
      /** For an owner's device: the principal ids of the credentials made from it (pairing-token-store `madeFromIt`). */
      readonly madeFromIt?: readonly string[] | undefined;
    }
  | {
      readonly kind: 'session';
      readonly token: string;
      readonly username: string;
      readonly roles: readonly string[];
      /** The scope list the user stores, when narrower than its role's default set. */
      readonly scopes?: readonly string[] | undefined;
      /** When the login session ends by time. */
      readonly expiresAt: number;
    };

/**
 * The credential kind a request context reports for an authenticated operator
 * request. The operator token presented straight from the daemon's own
 * machine (`loopback`: the listener ruled out a proxy, a tunnel and a published
 * address) is `local`: the credential the apps there already hold.
 */
export function credentialKindOf(authenticated: AuthenticatedOperatorRequest, loopback = false): 'local' | 'shared-token' | 'device-token' | 'agent' | 'user-session' {
  if (authenticated.kind === 'pairing-token') return authenticated.client === 'agent' ? 'agent' : 'device-token';
  if (authenticated.kind === 'session') return 'user-session';
  return loopback ? 'local' : 'shared-token';
}

/** Why a credential the daemon knows is refused, in the refusal shape: what holds, why, and what to do. */
export interface CredentialRefusal {
  readonly code: string;
  readonly state: string;
  readonly reason: string;
  readonly next: readonly string[];
}

/** Construction-only transport capability, never accepted from a wire payload. */
export interface NativePairedSnapshot extends AuthenticatedNativePairingToken {
  readonly scopes: readonly string[];
}

export interface NativeExecutionAuthority {
  issueContinuation?(binding: string, assertCurrent: () => void, sourceBinding?: string): NativeContinuationGrant;
  /** Retires only a grant issued by this original private pairing owner. */
  revokeContinuation?(grant: NativeContinuationGrant): void;
  current(): NativePairedSnapshot | null;
  withCurrent<T>(expected: NativePairedSnapshot,
    operation: (assertCurrent: () => NativePairedSnapshot) => T | Promise<T>): Promise<T>;
}

/**
 * The synchronous per-pairing token authenticator the operator-auth path
 * consults BEFORE the legacy shared token. A revoked token misses here, so
 * revocation is honored on the very next request. Absent ⇒ no per-pairing
 * tokens are configured (only the shared token / user sessions authenticate).
 */
export interface PairingTokenAuthenticator {
  issueNativeContinuation?(credential: NativeCredential, expected: NativeContinuationAuthority, binding: string, assertCurrent: () => void, sourceBinding?: string): NativeContinuationGrant;
  revokeNativeContinuation?(grant: NativeContinuationGrant): void;
  /** Additive strict SETTINGS path; never substituted with native authority. */
  captureSettingsAuthority?(input: { readonly kind: 'shared-token'; readonly token: string }
    | { readonly kind: 'pairing-token'; readonly token: string }): SettingsPairingAuthority | null;
  withSettingsAuthority?<T>(authority: SettingsPairingAuthority,
    operation: (assertCurrent: () => void) => T): T;
  /** True while settings authority is held by a store read or owner-write fault. */
  readonly settingsAuthorityFaulted?: boolean;
  /** Optional for legacy authenticators; absence explicitly refuses native execution. */
  authenticateNative?(credential: NativeCredential): AuthenticatedNativePairingToken | null;
  /**
   * The native authority of the owner's own machine, made once and kept: the
   * transport asks for it only after it established the local credential.
   * Absent: the local credential has no native authority.
   */
  ensureLocalNativeOwner?(): AuthenticatedNativePairingToken | null;
  withNativeAuthority?<T>(credential: NativeCredential, expected: AuthenticatedNativePairingToken,
    operation: (assertCurrent: () => AuthenticatedNativePairingToken) => T | Promise<T>): Promise<T>;
  authenticate(token: string): { readonly id: string; readonly name: string; readonly client?: 'agent' | undefined; readonly scopes?: readonly string[] | undefined; readonly ownerDevice?: true | undefined; readonly madeFromIt?: readonly string[] | undefined } | null;
  /** Whether the shared operator token has been revoked (and, in the serving daemon, replaced). */
  isLegacyRevoked(): boolean;
  /**
   * Whether this shared token value is refused: the shared token was revoked
   * and `token` is not the replacement this machine's apps hold. Absent: every
   * shared value is refused once {@link isLegacyRevoked} is true.
   */
  refusesSharedToken?(token: string): boolean;
  /**
   * Why a token this store knows does not authenticate (over its rotation age,
   * or an offer that expired unused), or null. Asked only after a refusal.
   */
  describeRefusal?(token: string): CredentialRefusal | null;
  /** Moves whenever a pairing, a grant or the legacy revocation changes. Absent: every check re-authenticates. */
  readonly revisionSource?: RevisionSource;
  /**
   * Called with the principal ids whose credential stopped being valid (a
   * revoked or replaced pairing, `shared-token` for the legacy revocation),
   * whether this process or another one made the change. Returns the unsubscribe.
   */
  onRevoked?(listener: (principalIds: readonly string[]) => void): () => void;
}

interface SessionCookieOptions {
  readonly req: Request;
  readonly expiresAt: number;
  readonly trustProxy?: boolean | undefined;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const segment of header.split(';')) {
    const [rawName, ...rawValueParts] = segment.split('=');
    const name = rawName?.trim();
    if (!name) continue;
    const rawValue = rawValueParts.join('=').trim();
    if (!rawValue) continue;
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }
  return cookies;
}

function isSecureRequest(req: Request, trustProxy = false): boolean {
  try {
    const url = new URL(req.url);
    if (url.protocol === 'https:') return true;
  } catch {
    // Ignore malformed URLs; Bun always provides a valid request URL.
  }
  // A page served over https (a tunnel or proxy in front of this daemon, such as tailscale
  // serve) gets a Secure cookie even when the hop to the daemon is plain http. This only
  // ever adds Secure; which pages may use the cookie at all is the Origin rule's decision.
  const page = req.headers.get('origin') ?? req.headers.get('referer') ?? '';
  if (/^https:\/\//i.test(page)) return true;
  if (!trustProxy) return false;
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? '';
  return forwardedProto
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .some((value) => value === 'https');
}

export function extractOperatorAuthToken(
  req: Request,
): string {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const sessionCookie = parseCookies(req.headers.get('cookie')).get(OPERATOR_SESSION_COOKIE_NAME)?.trim();
  if (sessionCookie) return sessionCookie;

  return '';
}

/**
 * Check the token's byte length, then compare its contents in constant time.
 * Shared tokens are compared directly; no derived verifier is persisted here.
 */
export function matchesSharedToken(token: string, sharedToken: string): boolean {
  const supplied = Buffer.from(token, 'utf8');
  const expected = Buffer.from(sharedToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sharedTokenRefused(pairingTokens: PairingTokenAuthenticator | undefined, token: string): boolean {
  if (!pairingTokens) return false;
  return pairingTokens.refusesSharedToken ? pairingTokens.refusesSharedToken(token) : pairingTokens.isLegacyRevoked();
}

export function authenticateOperatorToken(
  token: string,
  context: {
    readonly sharedToken?: string | null | undefined;
    readonly userAuth: Pick<UserAuthManager, 'validateSession' | 'getUser'>;
    readonly pairingTokens?: PairingTokenAuthenticator | undefined;
  },
): AuthenticatedOperatorRequest | null {
  const normalized = token.trim();
  if (!normalized) return null;

  // Try per-pairing tokens first. A named, individually-revocable device token
  // matches here; a revoked one misses (revocation honored on the next request).
  const pairing = context.pairingTokens?.authenticate(normalized);
  if (pairing) {
    return { kind: 'pairing-token', token: normalized, tokenId: pairing.id, name: pairing.name,
      ...(pairing.client === 'agent' ? { client: 'agent' as const } : {}),
      ...(pairing.scopes !== undefined ? { scopes: pairing.scopes } : {}),
      ...(pairing.ownerDevice === true ? { ownerDevice: true as const, madeFromIt: pairing.madeFromIt ?? [] } : {}) };
  }

  // Then the shared token, unless this value was revoked. The revocation is
  // asked only for a token that is the shared token, so a session request never
  // pays for it. A non-match must still be checked as a user session so session
  // cookies remain valid when operator tooling also uses a bearer token.
  if (context.sharedToken && matchesSharedToken(normalized, context.sharedToken) && !sharedTokenRefused(context.pairingTokens, normalized)) {
    return { kind: 'shared-token', token: normalized };
  }

  const session = context.userAuth.validateSession(normalized);
  if (!session) return null;
  const user = context.userAuth.getUser(session.username);
  if (!user) return null;
  return {
    kind: 'session',
    token: normalized,
    username: user.username,
    roles: user.roles,
    ...(user.scopes !== undefined ? { scopes: user.scopes } : {}),
    expiresAt: session.expiresAt,
  };
}

export function authenticateOperatorRequest(
  req: Request,
  context: {
    readonly sharedToken?: string | null | undefined;
    readonly userAuth: Pick<UserAuthManager, 'validateSession' | 'getUser'>;
    readonly pairingTokens?: PairingTokenAuthenticator | undefined;
  },
): AuthenticatedOperatorRequest | null {
  return authenticateOperatorToken(extractOperatorAuthToken(req), context);
}

export function isOperatorAdmin(authenticated: AuthenticatedOperatorRequest | null): boolean {
  if (!authenticated) return false;
  if (authenticated.kind === 'shared-token') return true;
  // A credential given a narrower scope list holds that list, not admin authority.
  if (authenticated.scopes !== undefined && !authenticated.scopes.includes('*')) return false;
  // A paired device holds the same operator authority as the shared token.
  if (authenticated.kind === 'pairing-token') return true;
  return authenticated.roles.includes('admin');
}

/** The default grant, narrowed to a stored list. A stored list never widens it. */
export function narrowGatewayGrant(defaults: readonly string[], stored: readonly string[] | undefined): readonly string[] {
  if (stored === undefined || stored.includes('*')) return defaults;
  const allowed = new Set(stored);
  return Object.freeze(defaults.filter(scope => allowed.has(scope)));
}

/**
 * What a paired device holds: full operator authority (admin, and the whole
 * default grant) unless its pairing stores a narrower list.
 */
export function pairingGrant(defaults: readonly string[], stored: readonly string[] | undefined): { readonly principalKind: 'token'; readonly admin: boolean; readonly scopes: readonly string[] } {
  return { principalKind: 'token', admin: stored === undefined || stored.includes('*'), scopes: narrowGatewayGrant(defaults, stored) };
}

/** Who an authenticated operator credential is, and what it holds. */
export interface OperatorPrincipalGrant {
  readonly principalId: string;
  readonly principalKind: 'token' | 'user';
  readonly admin: boolean;
  readonly scopes: readonly string[];
  /**
   * A device the owner paired himself (no client named). It is never the owner himself: it answers a question another
   * caller raised (never its own, nor one of a credential made from it) and does his native work.
   */
  readonly ownerDevice?: true | undefined;
  /** For an owner's device: the principal ids of the credentials made from it. */
  readonly madeFromIt?: readonly string[] | undefined;
}

/**
 * The one decision of who a credential is and what it holds, for every
 * listener: the operator token is the owner with the whole grant; a paired
 * device holds the whole grant unless its pairing stores a narrower list, and
 * is the owner's own device when the owner paired it for no named client; a
 * sign-in holds its role's default set (`grantedScopes(true)` for an admin,
 * `grantedScopes(false)` otherwise), narrowed to its stored list. The caller
 * passes its catalog's default sets, so the control plane and the webhook
 * listener judge one credential the same way.
 */
export function operatorPrincipalGrant(
  authenticated: AuthenticatedOperatorRequest,
  grantedScopes: (includeWrite: boolean) => readonly string[],
): OperatorPrincipalGrant {
  if (authenticated.kind === 'shared-token') {
    return { principalId: LOCAL_OWNER_PRINCIPAL, principalKind: 'token', admin: true, scopes: grantedScopes(true) };
  }
  const stored = authenticated.scopes;
  if (authenticated.kind === 'pairing-token') {
    const ownerDevice = authenticated.ownerDevice === true && authenticated.client === undefined;
    return { principalId: pairingPrincipalId(authenticated.tokenId), ...pairingGrant(grantedScopes(true), stored),
      ...(ownerDevice ? { ownerDevice: true as const, madeFromIt: authenticated.madeFromIt ?? [] } : {}) };
  }
  const adminRole = authenticated.roles.includes('admin');
  return {
    principalId: authenticated.username,
    principalKind: 'user',
    // A narrowed list is the whole grant: admin-only routes would bypass it.
    admin: adminRole && (stored === undefined || stored.includes('*')),
    scopes: narrowGatewayGrant(grantedScopes(adminRole), stored),
  };
}

/**
 * The actor an authenticated operator request is (daemon-api/src/actor.ts), for
 * a listener that has no method catalog of its own (the webhook listener),
 * judged by {@link operatorPrincipalGrant} with the default sets the caller
 * passes (the http listener passes the catalog grant). What it may cause is
 * then the effect table's answer.
 */
export function operatorRequestActor(
  authenticated: AuthenticatedOperatorRequest,
  owner: OwnerIdentity,
  grantedScopes: (includeWrite: boolean) => readonly string[],
  loopback = false,
): Actor {
  const grant = operatorPrincipalGrant(authenticated, grantedScopes);
  return actorFromPrincipal({
    ...grant,
    credentialKind: credentialKindOf(authenticated, loopback),
    ownerDevice: grant.ownerDevice === true,
    ...(grant.madeFromIt !== undefined ? { madeFromIt: grant.madeFromIt } : {}),
  }, owner);
}

/**
 * The credential cookie: HttpOnly (no page script reads it) and SameSite=Strict (no
 * other site's page or link carries it); Secure when the request came over TLS. A page
 * on the same host at another port is the same site, so a state-changing request on
 * this cookie is also held to the page's Origin (http/browser-origin.ts).
 */
export function buildOperatorSessionCookie(token: string, options: SessionCookieOptions): string {
  return browserCookie(OPERATOR_SESSION_COOKIE_NAME, encodeURIComponent(token), options, true);
}

export function buildExpiredOperatorSessionCookie(req: Request, trustProxy = false): string {
  return expiredBrowserCookie(OPERATOR_SESSION_COOKIE_NAME, req, trustProxy, true);
}

/** The readable marker beside the credential cookie, with the same end. */
export function buildIdentityMarkerCookie(marker: string, options: SessionCookieOptions): string {
  return browserCookie(IDENTITY_MARKER_COOKIE_NAME, marker, options, false);
}

export function buildExpiredIdentityMarkerCookie(req: Request, trustProxy = false): string {
  return expiredBrowserCookie(IDENTITY_MARKER_COOKIE_NAME, req, trustProxy, false);
}

/** A new marker for a sign-in of `principal`: a fresh generation, so every sign-in is a change a page can see. */
export function mintIdentityMarker(principal: string): string {
  const generation = randomBytes(12).toString('base64url');
  return `${generation}.${Buffer.from(principal, 'utf8').toString('base64url')}`;
}

/** The marker the request carries, when it has the marker's shape. */
export function readIdentityMarker(req: Request): string | null {
  const marker = parseCookies(req.headers.get('cookie')).get(IDENTITY_MARKER_COOKIE_NAME)?.trim();
  return marker && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(marker) ? marker : null;
}

/** The phone node's peer-token cookie, scoped to the peer routes. */
export function buildRemoteNodeCookie(token: string, options: SessionCookieOptions): string {
  return browserCookie(REMOTE_NODE_COOKIE_NAME, encodeURIComponent(token), options, true, REMOTE_NODE_COOKIE_PATH);
}

export function buildExpiredRemoteNodeCookie(req: Request, trustProxy = false): string {
  return expiredBrowserCookie(REMOTE_NODE_COOKIE_NAME, req, trustProxy, true, REMOTE_NODE_COOKIE_PATH);
}

/**
 * The credential a remote peer request presents: its bearer, else the phone node's
 * cookie, else the sign-in cookie (an operator credential, which no peer route accepts,
 * kept so a refusal is audited as before). `viaCookie` says the node cookie carried it.
 */
export function extractRemotePeerToken(req: Request): { readonly token: string; readonly viaNodeCookie: boolean } {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return { token: bearer, viaNodeCookie: false };
  const node = parseCookies(req.headers.get('cookie')).get(REMOTE_NODE_COOKIE_NAME)?.trim();
  if (node) return { token: node, viaNodeCookie: true };
  return { token: extractOperatorAuthToken(req), viaNodeCookie: false };
}

function browserCookie(name: string, value: string, options: SessionCookieOptions, httpOnly: boolean, path = '/'): string {
  const maxAgeSeconds = Math.max(0, Math.floor((options.expiresAt - Date.now()) / 1_000));
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    ...(httpOnly ? ['HttpOnly'] : []),
    'SameSite=Strict',
    `Expires=${new Date(options.expiresAt).toUTCString()}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(options.req, options.trustProxy)) parts.push('Secure');
  return parts.join('; ');
}

function expiredBrowserCookie(name: string, req: Request, trustProxy: boolean, httpOnly: boolean, path = '/'): string {
  const parts = [
    `${name}=`,
    `Path=${path}`,
    ...(httpOnly ? ['HttpOnly'] : []),
    'SameSite=Strict',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (isSecureRequest(req, trustProxy)) parts.push('Secure');
  return parts.join('; ');
}
