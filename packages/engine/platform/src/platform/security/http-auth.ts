import { timingSafeEqual } from 'node:crypto';
import type { UserAuthManager } from './user-auth.js';
import type { AuthenticatedNativePairingToken, SettingsPairingAuthority, NativeContinuationGrant, NativeContinuationAuthority, NativeCredential } from '../pairing/pairing-token-store.js';
import type { RevisionSource } from '../utils/revision.js';

export const OPERATOR_SESSION_COOKIE_NAME = 'goodvibes_session';

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
    }
  | {
      readonly kind: 'session';
      readonly token: string;
      readonly username: string;
      readonly roles: readonly string[];
      /** When the login session ends by time. */
      readonly expiresAt: number;
    };

/**
 * The credential kind a request context reports for an authenticated operator
 * request. The operator token presented from the daemon's own machine
 * (`loopback`) is `local`: the credential the apps there already hold.
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
  authenticate(token: string): { readonly id: string; readonly name: string; readonly client?: 'agent' | undefined } | null;
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
      ...(pairing.client === 'agent' ? { client: 'agent' as const } : {}) };
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
  // A paired device holds the same operator authority as the shared token.
  if (authenticated.kind === 'shared-token' || authenticated.kind === 'pairing-token') return true;
  return authenticated.roles.includes('admin');
}

export function buildOperatorSessionCookie(token: string, options: SessionCookieOptions): string {
  const maxAgeSeconds = Math.max(0, Math.floor((options.expiresAt - Date.now()) / 1_000));
  const secure = isSecureRequest(options.req, options.trustProxy);
  const parts = [
    `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(options.expiresAt).toUTCString()}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildExpiredOperatorSessionCookie(req: Request, trustProxy = false): string {
  const parts = [
    `${OPERATOR_SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (isSecureRequest(req, trustProxy)) parts.push('Secure');
  return parts.join('; ');
}
