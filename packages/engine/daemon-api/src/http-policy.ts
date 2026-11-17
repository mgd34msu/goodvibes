import { jsonErrorResponse } from './error-response.js';
import { scopeMatches } from './route-helpers.js';

/** The kind of authenticated principal making a daemon request. */
export type AuthenticatedPrincipalKind = 'user' | 'bot' | 'service' | 'token';

/** Describes an authenticated caller resolved from a daemon request token. */
export interface AuthenticatedPrincipal {
  /** Opaque identifier for this principal. */
  readonly principalId: string;
  /** The category of this principal. */
  readonly principalKind: AuthenticatedPrincipalKind;
  /** Whether this principal has administrative privileges. */
  readonly admin: boolean;
  /** The permission scopes granted to this principal. */
  readonly scopes: readonly string[];
}

/**
 * Which credential a request presented. `local` is the daemon's operator token
 * presented from the daemon's own machine (the credential the apps there
 * already hold); `shared-token` is the same token from anywhere else;
 * `device-token` is a named pairing; `agent` is the pairing the GoodVibes
 * Agent presents for the calls it makes on the owner's behalf;
 * `user-session` is a login session.
 */
export type CredentialKind = 'local' | 'shared-token' | 'device-token' | 'agent' | 'user-session';

/** The caller of one request, authenticated once where the request entered. */
export interface RequestPrincipal extends AuthenticatedPrincipal {
  readonly credentialKind: CredentialKind;
  /** The same scopes as `scopes`, for membership tests. */
  readonly scopeSet: ReadonlySet<string>;
  /** Login roles; empty for token credentials. */
  readonly roles: readonly string[];
  /**
   * The daemon's authentication revision when this principal was read. While
   * the daemon still reports it (and `expiresAt` has not passed), the
   * principal is current; no store is read again.
   */
  readonly authRevision: number;
  /** When a login session ends by time. Absent for credentials without an expiry. */
  readonly expiresAt?: number;
}

/**
 * What every daemon route handler receives: the authenticated principal and a
 * signal that aborts when the request ends or its credential is revoked.
 */
export interface RequestContext {
  readonly principal: RequestPrincipal;
  readonly signal: AbortSignal;
}

/** The two ways a route context can name who made a request. */
export interface RequestActorSource {
  /** The principal the daemon's gate authenticated for the request. */
  readonly resolveAuthenticatedPrincipal?: ((req: Request) => Pick<AuthenticatedPrincipal, 'principalId'> | null) | undefined;
  readonly requireAuthenticatedSession?: ((req: Request) => { readonly username: string } | null) | undefined;
}

/**
 * Who made a request, as history and audit records name them: the principal
 * the gate resolved (a user name, `pairing:<id>` for a paired device,
 * `shared-token` for the operator token). A context without the gate's
 * principal falls back to the login session, then to `operator`.
 */
export function requestActor(context: RequestActorSource, req: Request): string {
  return context.resolveAuthenticatedPrincipal?.(req)?.principalId
    ?? context.requireAuthenticatedSession?.(req)?.username
    ?? 'operator';
}

/**
 * True when the principal holds `scope`; an admin holds every scope. A grant
 * covers a scope by the one rule of `scopeMatches` (exact, `*`, or `prefix:*`).
 */
export function principalHasScope(principal: Pick<RequestPrincipal, 'admin' | 'scopeSet'>, scope: string): boolean {
  if (principal.admin || principal.scopeSet.has(scope)) return true;
  for (const granted of principal.scopeSet) if (scopeMatches(granted, scope)) return true;
  return false;
}

/** Strategy object for extracting and resolving a daemon auth token to a principal. */
export interface AuthenticatedPrincipalResolver {
  /** Extract the raw auth token from the incoming request. */
  readonly extractAuthToken: (req: Request) => string;
  /** Resolve a token string to an `AuthenticatedPrincipal`, or `null` if invalid. */
  readonly describeAuthenticatedPrincipal: (token: string) => AuthenticatedPrincipal | null;
}

/** Config context required to evaluate whether private-host fetches are permitted. */
export interface PrivateHostFetchConfig {
  readonly configManager: {
    get(key: string): unknown;
  };
}

/**
 * Extended config for private-host fetch evaluation that also enforces an
 * elevated-access gate on the originating request.
 */
export interface ElevatedPrivateHostFetchConfig extends PrivateHostFetchConfig {
  /** The originating request to check for elevated access. */
  readonly req: Request;
  /** Returns a `Response` to deny access, or `null` to allow. */
  readonly requireElevatedAccess: (req: Request) => Response | null;
}

/**
 * Extract and resolve the auth token from a request to an `AuthenticatedPrincipal`.
 *
 * @param req - The incoming HTTP request.
 * @param resolver - Strategy for extracting the token and resolving it to a principal.
 * @returns The resolved principal, or `null` if no valid token is present.
 */
export function resolveAuthenticatedPrincipal(
  req: Request,
  resolver: AuthenticatedPrincipalResolver,
): AuthenticatedPrincipal | null {
  const token = resolver.extractAuthToken(req);
  return token ? resolver.describeAuthenticatedPrincipal(token) : null;
}

/**
 * Resolve fetch options for a private-host request, enforcing config and access gates.
 *
 * @param requested - The caller-supplied flag; must be `true` to attempt private-host access.
 * @param context - Config context (and optionally an elevated-access gate).
 * @returns Options object to merge into the fetch call, an empty object if not requested,
 *   or a `Response` to short-circuit with a 403 if access is denied.
 */
export function resolvePrivateHostFetchOptions(
  requested: unknown,
  context: PrivateHostFetchConfig | ElevatedPrivateHostFetchConfig,
): { allowPrivateHosts: true; fetchMode: 'allow-private-hosts' } | Record<string, never> | Response {
  if (requested !== true) return {};
  if (!Boolean(context.configManager.get('network.remoteFetch.allowPrivateHosts'))) {
    return jsonErrorResponse({ error: 'Private-host remote fetches are disabled by config.' }, { status: 403 });
  }
  if ('requireElevatedAccess' in context) {
    const denied = context.requireElevatedAccess(context.req);
    if (denied) return denied;
  }
  return { allowPrivateHosts: true, fetchMode: 'allow-private-hosts' };
}
