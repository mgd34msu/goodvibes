import { WebSocketOutbox } from './websocket-outbox.js';
import { WebSocketMessageAssembler } from '@goodvibes-jev/engine/transport-core';
import type { AgentManager } from '../tools/agent/index.js';
import { startTurnForOwnerRequest } from '../security/turn-boundary.js';
import { withUntrustedContentScope } from '../security/untrusted-content.js';
import type { UserAuthManager, SettingsSessionAuthority } from '../security/user-auth.js';
import type { SettingsPairingAuthority } from '../pairing/pairing-token-store.js';
import { PairingStoreFaultedError, SettingsAuthorityUnavailableError, runSynchronousSettingsOperation } from '../security/settings-authority.js';
import { LOCAL_OWNER_CREDENTIAL, isPairingTokenShape, pairingPrincipalId, type NativeCredential } from '../pairing/pairing-token-store.js';
import {
  authenticateOperatorToken,
  credentialKindOf,
  extractOperatorAuthToken,
  matchesSharedToken,
  type AuthenticatedOperatorRequest,
  type PairingTokenAuthenticator,
  type NativeExecutionAuthority,
  type NativePairedSnapshot,
} from '../security/http-auth.js';
import { bindRequestContext, createRequestContext, isPrincipalCurrent, requestContextOf } from './request-context.js';
import type { ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../control-plane/index.js';
import type { GatewayMethodInvocationContext } from '../control-plane/method-catalog-shared.js';
import type { RuntimeEventDomain } from '../runtime/events/index.js';
import { isRuntimeEventDomain } from '../runtime/events/index.js';
import type { DistributedRuntimeManager } from '../runtime/remote/index.js';
import { extractForwardedClientIp } from '../runtime/network/index.js';
import { clientAddressOf, isLocalOrigin, resolveClientAddress } from './client-address.js';
import { resolveGatewayPathTemplate } from './helpers.js';
import { catalogGrantedScopes, narrowGatewayGrant, pairingTokenCaller, refuseGatewayInvocation } from './http/gateway-binding-gate.js';
import { createAuthFailureAudit, type AuthFailureAudit } from './auth-failure-audit.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { summarizeError } from '../utils/error-display.js';
import { redactDiagnosticText } from '../utils/redaction.js';
import { validateInvocationInput } from '../control-plane/invoke-input-validation.js';
import { readGatewayVerbRefusal } from '../control-plane/routes/gateway-verb-error.js';
import { authenticationRequiredResponse, buildErrorResponseBody, jsonErrorResponse } from './http/error-response.js';
import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';
import {
  type AuthenticatedPrincipal,
  type CredentialKind,
  type RequestContext,
  type RequestPrincipal,
} from './http-policy.js';

/** What a socket closed for a revoked credential is told last. */
/**
 * The text frame of a delivered event, kept per payload object: the gateway
 * hands every socket the same payload object for one event, so the event is
 * serialised once, not once per connected client.
 */
const socketEventFrames = new WeakMap<object, { readonly event: string; readonly frame: string }>();
function socketEventFrame(event: string, payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return JSON.stringify({ type: 'event', event, payload });
  const kept = socketEventFrames.get(payload);
  if (kept && kept.event === event) return kept.frame;
  const frame = JSON.stringify({ type: 'event', event, payload });
  socketEventFrames.set(payload, { event, frame });
  return frame;
}

const SOCKET_REVOKED_FRAME = JSON.stringify({
  type: 'closed', reason: 'credential-revoked', next: 'Sign in again or pair this device again, then reconnect.',
});

export interface ControlPlaneWebSocketData {
  readonly channel: 'control-plane';
  authToken: string;
  principalId: string | null;
  principalKind: 'user' | 'bot' | 'service' | 'token' | null;
  /** Which credential the socket authenticated with; null before in-band auth. */
  credentialKind?: CredentialKind | null | undefined;
  admin: boolean;
  scopes: readonly string[];
  readonly domains: readonly RuntimeEventDomain[];
  readonly clientKind:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'telephony'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly remoteAddress?: string | undefined;
  /** The listener established the upgrade request as coming from the daemon's own machine (see client-address.ts). */
  readonly localOrigin?: boolean | undefined;
  clientId?: string | undefined;
  authenticated: boolean;
  /** The daemon's authentication revision the socket's principal was read under; absent: re-read before each event. */
  authRevision?: number | undefined;
  /** When the socket's login session ends by time. */
  expiresAt?: number | undefined;
}

export interface DaemonControlPlaneContext {
  readonly authToken: () => string | null;
  /** Actual facade's private serving lifetime/token epoch. Missing means hold. */
  readonly settingsLifetime?: (() => object | null) | undefined;
  /**
   * Per-pairing token authenticator. When present, a named per-device token is
   * checked (and its revocation honored) before the legacy shared token; absent
   * ⇒ only the shared token / user sessions authenticate.
   */
  readonly pairingTokens?: PairingTokenAuthenticator | undefined;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly host: string;
  readonly port: number;
  readonly trustProxyEnabled: () => boolean;
  /** Receives AUTH_FAILED for refused operator, peer and WebSocket credentials; absent = not reported. */
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly allowedBrowserOrigins?: (() => readonly string[]) | undefined;
  readonly dispatchApiRoutes: (req: Request) => Promise<Response | null>;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
}

interface UpgradeCapableServer {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
}

/**
 * Gateway calls (WS call frames and the HTTP invoke routes) in flight, counted
 * for the FULL lifetime of each call, from Request synthesis through
 * response-body buffering. Each in-flight call retains its credential and
 * frame body (the shape found ~206k times in the 2026-07-14 OOM core), so the
 * backlog is bounded. One caller (a connection; over HTTP, a principal) may
 * hold {@link CALLS_IN_FLIGHT_PER_CALLER}, so one client with many slow calls
 * does not refuse everyone else's; the daemon-wide ceiling bounds memory
 * across callers. Beyond either a call is refused with a 503 naming which
 * limit and when to retry, never retained.
 */
const CALLS_IN_FLIGHT_PER_CALLER = 256;
const CALLS_IN_FLIGHT_TOTAL = 1024;
const CALLS_RETRY_AFTER_MS = 1_000;

/** Who a gateway call's in-flight budget belongs to: the connection it arrived on, else its principal. */
function callerKey(connectionId: string | undefined, principalId: string | undefined): string {
  if (connectionId !== undefined) return `connection:${connectionId}`;
  return principalId !== undefined ? `principal:${principalId}` : 'unauthenticated';
}
/** Largest response body a call frame reads back into a string. */
export const RESPONSE_TEXT_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Read a finite response body as text in memory, refusing one over `maxBytes`
 * while it streams, before it can fill the heap.
 */
export async function readResponseTextBounded(response: Response, signal?: AbortSignal, maxBytes = RESPONSE_TEXT_MAX_BYTES): Promise<string> {
  signal?.throwIfAborted();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > maxBytes) throw new Error(`Response body is larger than the ${maxBytes} byte limit`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The one envelope every refusal this dispatcher mints is written in. */
function refusalBody(message: string, code: string, status: number): ReturnType<typeof buildErrorResponseBody> {
  return buildErrorResponseBody({ message, code, status });
}

declare const settingsAdminAuthorityBrand: unique symbol;
/** Opaque current HTTP-admin precondition; not a Jev/execution grant. */
export interface SettingsAdminAuthority {
  readonly kind: 'shared-token' | 'pairing-token' | 'session';
  readonly [settingsAdminAuthorityBrand]: true;
}
interface SettingsAdminAuthorityRecord {
  readonly token: string;
  readonly transport: 'header' | 'cookie';
  readonly lifetime: object;
  readonly pairingOwner: PairingTokenAuthenticator | undefined;
  readonly userOwner: UserAuthManager;
  readonly paired?: SettingsPairingAuthority;
  readonly session?: SettingsSessionAuthority;
}

interface GatewayMethodCallInput {
  readonly authToken: string;
  readonly methodId: string;
  readonly signal?: AbortSignal | undefined;
  readonly query?: Record<string, unknown> | undefined;
  readonly body?: unknown | undefined;
  readonly context?: {
    readonly principalId?: string | undefined;
    readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
    readonly admin?: boolean | undefined;
    readonly scopes?: readonly string[] | undefined;
    readonly clientKind?: string | undefined;
    /** The daemon-assigned id of the connection the call arrived on; separates one client's untrusted-content window from another's under the same principal. */
    readonly connectionId?: string | undefined;
    /**
     * True when a person asked for this, now. Set ONLY by transports that
     * can honestly claim it; scheduled work and triggers leave it unset
     * because they cannot. It gates the explicit-user-request refusal and
     * starts a new untrusted-content turn, see
     * control-plane/routes/explicit-user-request.ts and
     * security/turn-boundary.ts.
     */
    readonly explicitUserRequest?: boolean | undefined;
  };
  /**
   * The principal the caller already verified for this credential on this
   * call (a socket compares its authentication revision first). Absent: the
   * call authenticates the token once itself.
   */
  readonly principal?: (AuthenticatedPrincipal & { readonly credentialKind?: CredentialKind | null | undefined }) | undefined;
}

export class DaemonControlPlaneHelper {
  /** Live gateway calls (full lifetime incl. response buffering), in all and per caller. */
  private callsInFlight = 0;
  private readonly callsInFlightByCaller = new Map<string, number>();
  /** Calls refused at an in-flight limit (cumulative, for ops visibility). */
  private callsRefused = 0;
  /** Events dropped to stalled WS consumers (cumulative). */
  private wsEventsDropped = 0;
  private readonly socketLifetimes = new WeakMap<object, AbortController>();
  private socketSignal(ws: object): AbortSignal {
    let lifetime = this.socketLifetimes.get(ws);
    if (!lifetime) { lifetime = new AbortController(); this.socketLifetimes.set(ws, lifetime); }
    return lifetime.signal;
  }
  private readonly messageAssemblers = new WeakMap<object, WebSocketMessageAssembler>();
  private readonly outboxes = new WeakMap<object, WebSocketOutbox>();
  private sendFrame(ws: { data: ControlPlaneWebSocketData; send(message: string): void; getBufferedAmount?(): number }, message: string): void {
    if (this.socketSignal(ws).aborted) return;
    let outbox = this.outboxes.get(ws);
    if (!outbox) { outbox = new WebSocketOutbox(ws, undefined, (count) => { this.wsEventsDropped += count; }); this.outboxes.set(ws, outbox); }
    outbox.send(message);
  }

  private readonly settingsLifetime: (() => object | null) | undefined;
  private readonly settingsAuthorities = new WeakMap<SettingsAdminAuthority, SettingsAdminAuthorityRecord>();

  private readonly authFailures: AuthFailureAudit;

  constructor(private readonly context: DaemonControlPlaneContext) {
    this.authFailures = createAuthFailureAudit(context.runtimeBus);
    // Capture the construction-owned accessor, never a request-provided callback.
    this.settingsLifetime = context.settingsLifetime;
  }

  /** Retained-context footprint of the gateway call path, for tests and ops output. */
  wsCallStats(): { inFlight: number; refused: number; eventsDropped: number } {
    return { inFlight: this.callsInFlight, refused: this.callsRefused, eventsDropped: this.wsEventsDropped };
  }

  /** Takes one in-flight slot for `caller`, or answers the refusal naming the limit it hit. Pair with {@link releaseCall}. */
  private admitCall(caller: string): { status: number; ok: false; body: unknown } | null {
    const held = this.callsInFlightByCaller.get(caller) ?? 0;
    const callerFull = held >= CALLS_IN_FLIGHT_PER_CALLER;
    if (!callerFull && this.callsInFlight < CALLS_IN_FLIGHT_TOTAL) {
      this.callsInFlightByCaller.set(caller, held + 1);
      this.callsInFlight += 1;
      return null;
    }
    this.callsRefused += 1;
    return {
      status: 503,
      ok: false,
      body: buildErrorResponseBody({
        error: callerFull
          ? `This client already has ${CALLS_IN_FLIGHT_PER_CALLER} calls in flight`
          : `The daemon already has ${CALLS_IN_FLIGHT_TOTAL} calls in flight`,
        code: callerFull ? 'CALLER_CALLS_IN_FLIGHT_LIMIT' : 'DAEMON_CALLS_IN_FLIGHT_LIMIT',
        status: 503,
        state: callerFull ? 'this connection (or, over HTTP, this principal) is at its in-flight call limit' : 'the daemon is at its total in-flight call limit',
        next: [callerFull ? 'Wait for an earlier call to finish, then retry' : 'Retry in a second'],
        retryAfterMs: CALLS_RETRY_AFTER_MS,
      }),
    };
  }

  private releaseCall(caller: string): void {
    const held = this.callsInFlightByCaller.get(caller) ?? 0;
    if (held <= 1) this.callsInFlightByCaller.delete(caller);
    else this.callsInFlightByCaller.set(caller, held - 1);
    this.callsInFlight -= 1;
  }

  private trustProxyEnabled(): boolean {
    return this.context.trustProxyEnabled();
  }

  /** The address the listener resolved for this request (see client-address.ts). */
  private clientAddress(req: Request): string {
    return clientAddressOf(req) ?? resolveClientAddress(req, undefined, { trustProxy: this.trustProxyEnabled() });
  }

  /** A presented credential that did not authenticate; a request with none is a probe and is not audited. */
  private recordRefusedCredential(req: Request): void {
    if (this.extractAuthToken(req)) this.authFailures.record(this.clientAddress(req), 'control-plane');
  }

  extractAuthToken(req: Request): string {
    return extractOperatorAuthToken(req);
  }

  /** The shared operator-auth context: shared token + per-pairing tokens + user sessions. */
  private authContext(): {
    readonly sharedToken: string | null;
    readonly userAuth: UserAuthManager;
    readonly pairingTokens: PairingTokenAuthenticator | undefined;
  } {
    return {
      sharedToken: this.context.authToken(),
      userAuth: this.context.userAuth,
      pairingTokens: this.context.pairingTokens,
    };
  }

  #lastSharedToken: string | null | undefined;
  #sharedTokenEpoch = 0;

  /**
   * The daemon's authentication revision: local accounts and sessions, device
   * pairings and the shared operator token. It moves whenever any credential
   * changes, so a principal read under the current value is still the
   * principal. An owner without a revision source makes it NaN, which never
   * compares equal: every check then authenticates again.
   */
  authRevision(): number {
    const shared = this.context.authToken();
    if (shared !== this.#lastSharedToken) { this.#lastSharedToken = shared; this.#sharedTokenEpoch++; }
    const users = this.context.userAuth.revisionSource?.revision() ?? Number.NaN;
    const pairing = this.context.pairingTokens;
    const paired = pairing ? pairing.revisionSource?.revision() ?? Number.NaN : 0;
    return users + paired + this.#sharedTokenEpoch;
  }

  /**
   * The request's context: authenticated once where the request entered, then
   * read back. While the authentication revision has not moved this is one
   * integer compare; otherwise the request is authenticated again (one `stat`
   * of the pairing file at most) and the new context replaces the old one.
   * Null when the request carries no valid operator credential.
   */
  authenticateRequest(req: Request): RequestContext | null {
    const bound = requestContextOf(req);
    if (bound && isPrincipalCurrent(bound.principal, this.authRevision())) return bound;
    const token = extractOperatorAuthToken(req);
    const principal = token ? this.describeRequestPrincipal(token, isLocalOrigin(req)) : null;
    if (!principal) return null;
    const gateway = this.context.controlPlaneGateway;
    const context = createRequestContext(principal, req.signal,
      typeof gateway?.principalSignal === 'function' ? () => gateway.principalSignal(principal.principalId) : undefined);
    bindRequestContext(req, context);
    return context;
  }

  /** True while a context read earlier still names the current principal. */
  isRequestContextCurrent(context: RequestContext): boolean {
    return isPrincipalCurrent(context.principal, this.authRevision());
  }

  checkAuth(req: Request): boolean {
    return this.authenticateRequest(req) !== null;
  }

  requireAuthenticatedSession(req: Request): { username: string; roles: readonly string[] } | null {
    const principal = this.authenticateRequest(req)?.principal;
    if (!principal || principal.credentialKind !== 'user-session') return null;
    return {
      username: principal.principalId,
      roles: principal.roles,
    };
  }

  requireAdmin(req: Request): Response | null {
    const principal = this.authenticateRequest(req)?.principal;
    if (!principal) {
      this.recordRefusedCredential(req);
      return authenticationRequiredResponse();
    }
    if (!principal.admin) {
      return jsonErrorResponse({ error: 'Admin role required', code: 'ADMIN_REQUIRED',
        state: 'this credential is not an admin', next: ['Sign in with an admin account or use the operator token'] }, { status: 403 });
    }
    return null;
  }

  /**
   * Close every connection and abort every request of a principal whose
   * credential its owner reports revoked (a pairing, the legacy shared token,
   * all sessions of a local user), whether the change was made here or by
   * another process the owner read. Returns the unsubscribe.
   */
  watchRevocations(): void {
    if (this.#stopRevocationWatch) return;
    const gateway = this.context.controlPlaneGateway;
    const close = (principalIds: readonly string[]): void => {
      for (const principalId of principalIds) gateway.closeClientsOf(principalId);
    };
    const stops = [this.context.pairingTokens?.onRevoked?.(close), this.context.userAuth.onRevoked?.(close)];
    this.#stopRevocationWatch = () => { for (const stop of stops) stop?.(); };
  }

  #stopRevocationWatch: (() => void) | undefined;

  /** Stop following credential revocations; the daemon is stopping. */
  dispose(): void {
    this.#stopRevocationWatch?.();
    this.#stopRevocationWatch = undefined;
  }

  /**
   * Capture after request-body awaits, using only actual auth owners.
   * @throws {PairingStoreFaultedError} when a paired or shared-token capture
   *   failed because the pairing store is faulted, not because it is stale.
   */
  captureSettingsAdminAuthority(req: Request): SettingsAdminAuthority | null {
    const lifetime = this.settingsLifetime?.();
    if (!lifetime) return null;
    const token = extractOperatorAuthToken(req);
    if (!token) return null;
    const pairingOwner = this.context.pairingTokens;
    const userOwner = this.context.userAuth;
    let paired: SettingsPairingAuthority | null = null;
    let session: SettingsSessionAuthority | null = null;
    let kind: SettingsAdminAuthority['kind'];
    try {
      // Preserve the operator credential precedence, without ordinary auth's
      // cached shared fallback or last-seen persistence side effects.
      paired = pairingOwner?.captureSettingsAuthority?.({ kind: 'pairing-token', token }) ?? null;
      // An empty capture from a faulted store is not stale; say so instead of inviting a retry.
      if (!paired && isPairingTokenShape(token) && pairingOwner?.settingsAuthorityFaulted === true) throw new PairingStoreFaultedError();
      if (paired) {
        if (!pairingOwner?.withSettingsAuthority) return null;
        kind = 'pairing-token';
      } else {
        const shared = this.context.authToken();
        if (shared && matchesSharedToken(token, shared)) {
          paired = pairingOwner?.captureSettingsAuthority?.({ kind: 'shared-token', token }) ?? null;
          if (!paired && pairingOwner?.settingsAuthorityFaulted === true) throw new PairingStoreFaultedError();
          if (!paired || !pairingOwner?.withSettingsAuthority) return null;
          kind = 'shared-token';
        } else {
          session = userOwner.captureSettingsAuthority(token);
          if (!session?.roles.includes('admin')) return null;
          kind = 'session';
        }
      }
      if (this.settingsLifetime?.() !== lifetime || this.context.pairingTokens !== pairingOwner
        || this.context.userAuth !== userOwner) return null;
      const handle = Object.freeze({ kind }) as SettingsAdminAuthority;
      this.settingsAuthorities.set(handle, { token, lifetime, pairingOwner, userOwner,
        transport: req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ? 'header' : 'cookie',
        ...(paired ? { paired } : {}), ...(session ? { session } : {}) });
      return handle;
    } catch (error) {
      if (error instanceof PairingStoreFaultedError) throw error;
      return null;
    }
  }

  /**
   * Consume one captured request authority. The owner callback is synchronous
   * and must assertCurrent AFTER reentrant config preparation and immediately
   * BEFORE its effect. It is deterministic auth protection, never a Jev grant.
   * No check runs after the effect, so a truthful receipt remains truthful.
   */
  withSettingsAdminAuthority<T>(req: Request, authority: SettingsAdminAuthority,
    operation: (assertCurrent: () => void) => T): T {
    const expected = this.settingsAuthorities.get(authority);
    this.settingsAuthorities.delete(authority);
    if (!expected) throw new SettingsAuthorityUnavailableError();
    let active = true;
    const assertOwner = () => {
      const transport = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ? 'header' : 'cookie';
      if (!active || transport !== expected.transport
        || !matchesSharedToken(extractOperatorAuthToken(req), expected.token)
        || this.settingsLifetime?.() !== expected.lifetime
        || this.context.pairingTokens !== expected.pairingOwner || this.context.userAuth !== expected.userOwner) {
        throw new SettingsAuthorityUnavailableError();
      }
      if (authority.kind === 'shared-token') {
        const shared = this.context.authToken();
        if (!shared || !matchesSharedToken(expected.token, shared)) throw new SettingsAuthorityUnavailableError();
      }
    };
    try {
      assertOwner();
      if (expected.paired) {
        if (!expected.pairingOwner?.withSettingsAuthority) throw new SettingsAuthorityUnavailableError();
        return expected.pairingOwner.withSettingsAuthority(expected.paired, assertPaired => {
          const assertCurrent = () => { assertOwner(); assertPaired(); };
          assertCurrent();
          return runSynchronousSettingsOperation(operation, assertCurrent);
        });
      }
      if (!expected.session) throw new SettingsAuthorityUnavailableError();
      const assertCurrent = () => {
        assertOwner();
        expected.userOwner.assertSettingsAuthorityCurrent(expected.session!);
      };
      assertCurrent();
      return runSynchronousSettingsOperation(operation, assertCurrent);
    } finally { active = false; }
  }

  async requireRemotePeer(req: Request, scope?: string): Promise<import('../runtime/remote/index.js').DistributedPeerAuth | Response> {
    const token = this.extractAuthToken(req);
    const auth = await this.context.distributedRuntime.authenticatePeerToken(
      token,
      extractForwardedClientIp(req, this.trustProxyEnabled()),
    );
    if (!auth) {
      this.recordRefusedCredential(req);
      return Response.json({ error: 'Unauthorized remote peer' }, { status: 401 });
    }
    if (scope && !auth.token.scopes.includes(scope)) {
      return jsonErrorResponse({ error: `Remote peer token missing required scope: ${scope}`, code: 'MISSING_SCOPE',
        state: `this peer token does not carry ${scope}`, next: [`Issue the peer a token with ${scope}`] }, { status: 403 });
    }
    return auth;
  }

  describeAuthenticatedPrincipal(token: string): AuthenticatedPrincipal | null {
    const authenticated = authenticateOperatorToken(token, this.authContext());
    return authenticated ? this.principalFor(authenticated) : null;
  }

  /**
   * Authenticate a credential once into the principal a request or a socket
   * carries: who, with which credential, which scopes, and the authentication
   * revision it was read under. `loopback`: the listener established that the
   * credential arrived straight from the daemon's own machine (not through a
   * proxy or tunnel), which makes the operator token the `local` credential.
   */
  describeRequestPrincipal(token: string, loopback = false): RequestPrincipal | null {
    const authenticated = authenticateOperatorToken(token, this.authContext());
    if (!authenticated) return null;
    const base = this.principalFor(authenticated);
    // Read after the credential stores were consulted: this is the state the principal was checked against.
    const authRevision = this.authRevision();
    return Object.freeze({
      ...base,
      credentialKind: credentialKindOf(authenticated, loopback),
      scopeSet: new Set(base.scopes),
      roles: authenticated.kind === 'session' ? authenticated.roles : [],
      authRevision,
      ...(authenticated.kind === 'session' ? { expiresAt: authenticated.expiresAt } : {}),
    });
  }

  /**
   * The grant is decided here, once, when the credential is authenticated, and
   * carried on the request or socket. The default sets come from the catalog
   * and are rebuilt only when a method or event is registered or removed. A
   * pairing token or a user that stores its own scope list is granted that
   * list, never more than the default set for its role.
   */
  private principalFor(authenticated: AuthenticatedOperatorRequest): AuthenticatedPrincipal {
    if (authenticated.kind === 'shared-token') {
      return {
        principalId: 'shared-token',
        principalKind: 'token',
        admin: true,
        scopes: this.getGrantedGatewayScopes(true),
      };
    }
    const stored = storedScopesOf(authenticated);
    if (authenticated.kind === 'pairing-token') {
      // A paired device is a distinct, per-token principal (`pairing:<id>`) with
      // full operator authority unless its pairing stores a narrower list, so
      // step-up credentials key per token and a revoked device drops out cleanly.
      return { principalId: pairingPrincipalId(authenticated.tokenId), ...pairingTokenCaller(this.context.gatewayMethods, stored) };
    }
    const admin = authenticated.roles.includes('admin');
    return {
      principalId: authenticated.username,
      principalKind: 'user',
      admin,
      scopes: narrowGatewayGrant(this.getGrantedGatewayScopes(admin), stored),
    };
  }

  /**
   * Resolve persisted native authority: a pairing token's, or the owner's own
   * machine's for {@link LOCAL_OWNER_CREDENTIAL}, which only a caller that
   * established the local credential passes. A session named `pairing:...`
   * never qualifies. This path must not call ordinary authentication and its
   * last-seen writer.
   */
  describeNativeExecutionAuthority(credential: NativeCredential): NativePairedSnapshot | null {
    const owner = this.context.pairingTokens;
    const local = credential === LOCAL_OWNER_CREDENTIAL;
    const native = local ? owner?.ensureLocalNativeOwner?.() : owner?.authenticateNative?.(credential);
    if (!native || native.kind !== (local ? 'local' : 'pairing-token')) return null;
    return Object.freeze({ ...native, scopes: Object.freeze([...this.getGrantedGatewayScopes(true)]) });
  }

  /**
   * Only the transport constructs this capability. The credential stays in its
   * closure, outside native state, durable records and returned identities.
   * Cached transport scopes are a ceiling; a later catalog cannot widen them.
   *
   * `credentialKind` is what the transport established for this request. The
   * `local` credential (the operator token from this machine) gets the owner's
   * own machine's authority while that token is still the operator token; it
   * is looked up on first use, so a call that never reaches native work pays
   * nothing for it. Any other credential is native only as a pairing token.
   * While the native identity holds and the catalog's scopes do not move,
   * `current()` answers the snapshot it already built: one `lstat` per call.
   */
  createNativeExecutionAuthority(token: string, capturedScopes?: readonly string[], credentialKind?: CredentialKind | null): NativeExecutionAuthority | null {
    const owner = this.context.pairingTokens;
    if (!owner?.authenticateNative || !owner.withNativeAuthority) return null;
    const local = credentialKind === 'local';
    const credential: NativeCredential = local ? LOCAL_OWNER_CREDENTIAL : token;
    const stillLocal = (): boolean => {
      const shared = this.context.authToken();
      return typeof shared === 'string' && shared.length > 0 && matchesSharedToken(token, shared);
    };
    let initial: NativePairedSnapshot | null | undefined;
    if (!local) {
      initial = this.describeNativeExecutionAuthority(token);
      if (!initial) return null;
    }
    const base = (): NativePairedSnapshot | null => {
      if (initial === undefined) initial = stillLocal() ? this.describeNativeExecutionAuthority(LOCAL_OWNER_CREDENTIAL) : null;
      return initial;
    };
    let built: { readonly granted: readonly string[]; readonly snapshot: NativePairedSnapshot } | undefined;
    const current = (): NativePairedSnapshot | null => {
      if (this.context.pairingTokens !== owner || (local && !stillLocal())) return null;
      const expected = base();
      const fresh = expected ? owner.authenticateNative!(credential) : null;
      if (!expected || !fresh || fresh.kind !== expected.kind || fresh.tokenId !== expected.tokenId
        || fresh.authorityRevision !== expected.authorityRevision) return null;
      const granted = this.getGrantedGatewayScopes(true);
      if (built?.granted === granted) return built.snapshot;
      const ceiling = new Set(capturedScopes ?? expected.scopes);
      const scopes = ceiling.has('*') ? granted : granted.includes('*') ? [...ceiling] : granted.filter(scope => ceiling.has(scope));
      const snapshot: NativePairedSnapshot = Object.freeze({ ...fresh, scopes: Object.freeze([...scopes].sort()) });
      built = { granted, snapshot };
      return snapshot;
    };
    return Object.freeze({
      current,
      ...(owner.revokeNativeContinuation ? { revokeContinuation: owner.revokeNativeContinuation.bind(owner) } : {}),
      ...(owner.issueNativeContinuation ? { issueContinuation: (binding: string, assertSource: () => void, sourceBinding?: string) => {
        const expected = current(); if (!expected) throw new Error('Native continuation owner is unavailable');
        return owner.issueNativeContinuation!(credential, expected, binding, () => {
          assertSource(); const fresh = current();
          if (!fresh || JSON.stringify(fresh) !== JSON.stringify(expected)) throw new Error('Native continuation owner scopes changed');
        }, sourceBinding);
      } } : {}),
      withCurrent: <T>(expected: NativePairedSnapshot,
        operation: (assertCurrent: () => NativePairedSnapshot) => T | Promise<T>): Promise<T> =>
        owner.withNativeAuthority!(credential, expected, (assertPaired) => {
          const assertCurrent = (): NativePairedSnapshot => {
            assertPaired();
            const fresh = current();
            if (!fresh || fresh.scopes.length !== expected.scopes.length
              || fresh.scopes.some((scope, index) => scope !== expected.scopes[index])) {
              throw new Error('Native authority scopes are no longer current');
            }
            return fresh;
          };
          assertCurrent();
          return operation(assertCurrent);
        }),
    });
  }

  getGrantedGatewayScopes(includeWrite: boolean): readonly string[] {
    return catalogGrantedScopes(this.context.gatewayMethods, includeWrite);
  }

  validateGatewayInvocation(
    descriptor: GatewayMethodDescriptor,
    context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly scopes?: readonly string[] | undefined;
      readonly admin?: boolean | undefined;
    },
  ): { status: number; ok: false; body: Record<string, unknown> } | null {
    return refuseGatewayInvocation(descriptor, context);
  }

  tryUpgradeControlPlaneWebSocket(
    req: Request,
    server: UpgradeCapableServer,
  ): Response | 'upgraded' | null {
    const url = new URL(req.url);
    if (url.pathname !== '/api/control-plane/ws' || req.method !== 'GET') {
      return null;
    }
    const token = this.extractAuthToken(req);
    const principal = this.authenticateRequest(req)?.principal;
    if (!principal) {
      this.recordRefusedCredential(req);
      const error = 'Unauthorized: the WebSocket upgrade request itself must authenticate. Send an '
        + 'Authorization: Bearer token header on the upgrade (React Native and server runtimes support '
        + 'WebSocket constructor headers) or present an operator session cookie (same-origin browser '
        + 'session login). The in-band auth frame is only read after an authenticated upgrade.';
      return Response.json({ error }, { status: 401 });
    }
    const origin = req.headers.get('origin');
    const bearer = /^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '');
    const originAllowed = origin === null
      ? bearer
      : origin === url.origin || (origin !== 'null' && (this.context.allowedBrowserOrigins?.() ?? []).includes(origin));
    if (!originAllowed) {
      return jsonErrorResponse({ error: 'This browser origin is not allowed to connect', code: 'ORIGIN_NOT_ALLOWED',
        state: `the origin ${origin ?? '(none)'} is not on the allowed list`, next: ['Open the web UI from the daemon address, or add this origin to controlPlane.cors.allowedOrigins'] }, { status: 403 });
    }
    const rawDomains = url.searchParams.get('domains');
    const domains = parseRuntimeDomains(rawDomains);
    if (domains instanceof Response) return domains;
    const requestedKind = url.searchParams.get('clientKind');
    const clientKind = requestedKind === 'tui'
      || requestedKind === 'web'
      || requestedKind === 'slack'
      || requestedKind === 'discord'
      || requestedKind === 'ntfy'
      || requestedKind === 'daemon'
      || requestedKind === 'webhook'
      ? requestedKind
      : 'web';
    const upgraded = server.upgrade(req, {
      data: {
        channel: 'control-plane',
        authToken: token,
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        credentialKind: principal.credentialKind,
        scopes: principal.scopes,
        admin: principal.admin,
        domains,
        clientKind,
        remoteAddress: this.clientAddress(req),
        localOrigin: isLocalOrigin(req),
        authenticated: true,
        authRevision: principal.authRevision,
        expiresAt: principal.expiresAt,
      } satisfies ControlPlaneWebSocketData,
    });
    return upgraded ? 'upgraded' : Response.json({ error: 'WebSocket upgrade failed' }, { status: 400 });
  }

  handleControlPlaneWebSocketOpen(ws: {
    data: ControlPlaneWebSocketData;
    send(message: string): void;
    getBufferedAmount?(): number;
  }): void {
    this.socketSignal(ws);
    const connection = this.context.controlPlaneGateway.openWebSocketClient({
      clientKind: ws.data.clientKind,
      transport: 'ws',
      domains: ws.data.authenticated ? ws.data.domains : [],
      ...(ws.data.principalId ? { principalId: ws.data.principalId } : {}),
      ...(ws.data.principalKind ? { principalKind: ws.data.principalKind } : {}),
      scopes: ws.data.scopes,
      admin: ws.data.admin,
      remoteAddress: ws.data.remoteAddress,
    }, (event, payload) => {
      // Nothing is delivered before the socket authenticates, and a revoked socket is served nothing.
      if (!ws.data.authenticated || this.socketSignal(ws).aborted) return;
      if (!this.socketPrincipalCurrent(ws)) {
        this.closeRevokedSocket(ws);
        return;
      }
      // What the socket may receive was decided by the gateway when it subscribed.
      this.sendFrame(ws, socketEventFrame(event, payload));
    }, () => this.closeRevokedSocket(ws));
    ws.data.clientId = connection.clientId;
  }

  /**
   * One integer compare per event while the authentication revision has not
   * moved. When it moved, the socket's credential is authenticated once more:
   * the same principal keeps the socket (its scopes narrowed to what both the
   * socket and the credential now hold) under the new revision; anything else
   * ends it.
   */
  private socketPrincipalCurrent(ws: { data: ControlPlaneWebSocketData }): boolean {
    const data = ws.data;
    if (data.authRevision !== undefined && isPrincipalCurrent({ authRevision: data.authRevision, ...(data.expiresAt === undefined ? {} : { expiresAt: data.expiresAt }) }, this.authRevision())) return true;
    const fresh = this.describeRequestPrincipal(data.authToken, data.localOrigin === true);
    if (!fresh || fresh.principalId !== data.principalId || fresh.principalKind !== data.principalKind) return false;
    const held = new Set(data.scopes);
    const wasAdmin = data.admin;
    const heldCount = data.scopes.length;
    data.scopes = held.has('*') ? fresh.scopes : fresh.scopeSet.has('*') ? [...held] : fresh.scopes.filter(scope => held.has(scope));
    data.admin = data.admin && fresh.admin;
    data.authRevision = fresh.authRevision;
    data.expiresAt = fresh.expiresAt;
    // Narrower rights narrow what the socket is sent from now on.
    if (data.clientId && (data.admin !== wasAdmin || data.scopes.length !== heldCount)) {
      this.context.controlPlaneGateway.regrantClient(data.clientId, { admin: data.admin, scopes: data.scopes });
    }
    return true;
  }

  /**
   * Tell the client its credential was revoked and stop serving the socket:
   * its in-flight calls are aborted, no further frame is sent, it leaves the
   * event fan-out, and any frame it still sends is answered with the same
   * refusal. The client closes the socket (the shared realtime client does on
   * this frame). The daemon does not close it itself: Bun 1.3 keeps a socket
   * the server closed counted, after which `server.stop()` never settles.
   */
  private closeRevokedSocket(ws: { data: ControlPlaneWebSocketData; send(message: string): void }): void {
    const lifetime = this.socketLifetimes.get(ws);
    if (lifetime?.signal.aborted) return;
    this.sendFrame(ws, SOCKET_REVOKED_FRAME);
    lifetime?.abort();
    if (ws.data.clientId) this.context.controlPlaneGateway.closeWebSocketClient(ws.data.clientId, 'credential-revoked');
  }

  /** A socket that has not authenticated and was refused cannot do anything else; close it with the reason so the client sees why instead of an idle open socket. */
  private closeRefusedAuth(ws: { data: ControlPlaneWebSocketData; close?(code?: number, reason?: string): void }, reason: string): void {
    if (ws.data.authenticated) return;
    ws.close?.(1008, reason);
  }

  async handleControlPlaneWebSocketMessage(
    ws: {
      data: ControlPlaneWebSocketData;
      send(message: string): void;
      close?(code?: number, reason?: string): void;
    },
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    const clientId = ws.data.clientId;
    if (!clientId) return;
    // A socket whose credential was revoked is served nothing more; every frame gets the same answer.
    if (this.socketSignal(ws).aborted) {
      try { ws.send(SOCKET_REVOKED_FRAME); } catch { /* the client already went */ }
      return;
    }
    const text = typeof message === 'string'
      ? message
      : message instanceof Uint8Array
        ? new TextDecoder().decode(message)
        : message instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(message))
          : Buffer.from(message).toString('utf8');
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed?.type === 'chunk' && !ws.data.authenticated) throw new Error('Authenticate before sending chunks');
      let assembler = this.messageAssemblers.get(ws);
      if (!assembler) { assembler = new WebSocketMessageAssembler(); this.messageAssemblers.set(ws, assembler); }
      const decoded = assembler.accept(parsed);
      if (decoded === undefined) return;
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid frame');
      frame = decoded as Record<string, unknown>;
    } catch {
      this.sendFrame(ws, JSON.stringify({ type: 'error', error: 'Invalid JSON frame' }));
      return;
    }

    this.context.controlPlaneGateway.touchWebSocketClient(clientId, {
      lastFrameType: typeof frame.type === 'string' ? frame.type : 'unknown',
    });

    if (frame.type === 'ping') {
      this.sendFrame(ws, JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    if (frame.type === 'auth') {
      const token = typeof frame.token === 'string' ? frame.token : ws.data.authToken;
      const principal = this.describeRequestPrincipal(token, ws.data.localOrigin === true);
      if (!principal) {
        this.authFailures.record(ws.data.remoteAddress ?? 'unknown', 'control-plane');
        this.sendFrame(ws, JSON.stringify({ type: 'auth', ok: false, error: 'Unauthorized' }));
        this.closeRefusedAuth(ws, 'Unauthorized');
        return;
      }
      const domains = Array.isArray(frame.domains) ? normalizeFrameDomains(frame.domains) : undefined;
      if (domains instanceof Response) {
        this.sendFrame(ws, JSON.stringify({ type: 'auth', ok: false, error: 'Invalid runtime event domain' }));
        this.closeRefusedAuth(ws, 'Invalid runtime event domain');
        return;
      }
      ws.data.authToken = token;
      ws.data.principalId = principal.principalId;
      ws.data.principalKind = principal.principalKind;
      ws.data.credentialKind = principal.credentialKind;
      ws.data.scopes = principal.scopes;
      ws.data.admin = principal.admin;
      ws.data.authRevision = principal.authRevision;
      ws.data.expiresAt = principal.expiresAt;
      ws.data.authenticated = true;
      this.context.controlPlaneGateway.authenticateClient(clientId, {
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        scopes: principal.scopes,
        admin: principal.admin,
        ...(typeof frame.label === 'string' ? { label: frame.label } : {}),
        ...(Array.isArray(frame.capabilities) ? { capabilities: frame.capabilities.filter((value): value is string => typeof value === 'string') } : {}),
      });
      if (domains) {
        this.context.controlPlaneGateway.subscribeWebSocketClient(
          clientId,
          domains,
        );
      }
      this.sendFrame(ws, JSON.stringify({ type: 'auth', ok: true, clientId, principalId: principal.principalId }));
      return;
    }

    if (frame.type === 'subscribe') {
      if (!ws.data.authenticated) {
        this.sendFrame(ws, JSON.stringify({ type: 'error', error: 'Authenticate before subscribing' }));
        return;
      }
      const domains = Array.isArray(frame.domains)
        ? normalizeFrameDomains(frame.domains)
        : [];
      if (domains instanceof Response) {
        this.sendFrame(ws, JSON.stringify({ type: 'error', error: 'Invalid runtime event domain' }));
        return;
      }
      this.context.controlPlaneGateway.subscribeWebSocketClient(clientId, domains);
      this.sendFrame(ws, JSON.stringify({ type: 'subscribed', clientId, domains }));
      return;
    }

    if (frame.type === 'unsubscribe') {
      const domains = Array.isArray(frame.domains)
        ? normalizeFrameDomains(frame.domains)
        : undefined;
      if (domains instanceof Response) {
        this.sendFrame(ws, JSON.stringify({ type: 'error', error: 'Invalid runtime event domain' }));
        return;
      }
      this.context.controlPlaneGateway.unsubscribeWebSocketClient(clientId, domains);
      this.sendFrame(ws, JSON.stringify({ type: 'unsubscribed', clientId, domains: domains ?? [] }));
      return;
    }

    if (frame.type === 'call') {
      if (!ws.data.authenticated || !ws.data.principalId || !ws.data.principalKind) {
        this.sendFrame(ws, JSON.stringify({ type: 'error', error: 'Authenticate before invoking methods' }));
        return;
      }
      const id = typeof frame.id === 'string' ? frame.id : `call-${Date.now()}`;
      // The socket's principal stands while the authentication revision has
      // not moved: one integer compare, no second authentication per call.
      // A credential that no longer authenticates gets the call refused.
      if (!this.socketPrincipalCurrent(ws)) {
        this.sendFrame(ws, JSON.stringify({ type: 'response', id, ok: false, status: 401,
          body: refusalBody('Operator authentication is no longer valid', 'AUTH_REQUIRED', 401) }));
        return;
      }
      const methodId = typeof frame.methodId === 'string' ? frame.methodId : undefined;
      const response = methodId
        ? await this.invokeGatewayMethodCall({
            authToken: ws.data.authToken,
            principal: { principalId: ws.data.principalId, principalKind: ws.data.principalKind, credentialKind: ws.data.credentialKind, admin: ws.data.admin, scopes: ws.data.scopes },
            signal: this.socketSignal(ws),
            methodId,
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalId: ws.data.principalId,
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
              clientKind: ws.data.clientKind,
              ...(ws.data.clientId === undefined ? {} : { connectionId: ws.data.clientId }),
              // The client says whether a person asked for this right now. Only
              // a literal `true` counts: an absent or malformed field means
              // "cannot claim it", which is the honest default for scheduled
              // work, triggers and channel-driven calls.
              ...(frame.explicitUserRequest === true ? { explicitUserRequest: true } : {}),
            },
          })
        : await this.invokeWebSocketControlPlaneCall({
            authToken: ws.data.authToken,
            signal: this.socketSignal(ws),
            method: typeof frame.method === 'string' ? frame.method.toUpperCase() : 'GET',
            path: typeof frame.path === 'string' ? frame.path : '/api/control-plane',
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
            },
            caller: callerKey(ws.data.clientId, ws.data.principalId ?? undefined),
          });
      this.sendFrame(ws, JSON.stringify({
        type: 'response',
        id,
        ok: response.ok,
        status: response.status,
        body: response.body,
      }));
      return;
    }

    this.sendFrame(ws, JSON.stringify({ type: 'error', error: 'Unsupported frame type' }));
  }

  handleControlPlaneWebSocketClose(ws: {
    data: ControlPlaneWebSocketData;
  }): void {
    this.socketLifetimes.get(ws)?.abort();
    this.outboxes.get(ws)?.close();
    this.messageAssemblers.get(ws)?.reset();
    this.outboxes.delete(ws);
    if (!ws.data.clientId) return;
    this.context.controlPlaneGateway.closeWebSocketClient(ws.data.clientId, 'socket-closed');
  }

  async invokeWebSocketControlPlaneCall(input: {
    readonly authToken: string;
    readonly signal?: AbortSignal | undefined;
    readonly method: string;
    readonly path: string;
    readonly query?: Record<string, unknown> | undefined;
    readonly body?: unknown | undefined;
    readonly context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly admin?: boolean | undefined;
      readonly scopes?: readonly string[] | undefined;
    };
    /** Whose in-flight budget the call uses (see {@link callerKey}); a caller that names none shares one budget. */
    readonly caller?: string | undefined;
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    // The router sees the normalised path, so the descriptor and its scope are looked up by that one,
    // never by the raw text a client typed (`/api/x/../admin`, `/api/x?y`).
    if (hasDotSegment(input.path)) {
      return { status: 400, ok: false, body: refusalBody('The path contains a "." or ".." segment; send the final path.', 'INVALID_ARGUMENT', 400) };
    }
    const url = new URL(`http://${this.context.host}:${this.context.port}${input.path.startsWith('/') ? input.path : `/${input.path}`}`);
    const matchedDescriptor = this.context.gatewayMethods.findByHttpBinding(input.method, url.pathname);
    if (matchedDescriptor) {
      const denied = this.validateGatewayInvocation(matchedDescriptor, input.context);
      if (denied) return denied;
      // Same input gate for the method+path WS call path (no bypass of the HTTP
      // methodId gate). Only POST/PATCH carry a validatable body here.
      if (input.method === 'POST' || input.method === 'PATCH') {
        const invalid = validateInvocationInput(matchedDescriptor, input.body);
        if (invalid) {
          return { status: 400, ok: false, body: { error: invalid.detail, code: invalid.code } };
        }
      }
    }
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    // In-flight limit over the FULL call lifetime (dispatch + response buffering):
    // beyond it, refuse instead of retaining another operator-token Request context.
    const caller = input.caller ?? callerKey(undefined, undefined);
    const refused = this.admitCall(caller);
    if (refused) return refused;
    // Abortable request: streaming endpoints (SSE event sources) tear down on
    // request.signal abort, without this, a stream reached as a plain call
    // would pin the Request + Response + a growing buffer forever.
    const abort = new AbortController();
    const signal = input.signal ? AbortSignal.any([abort.signal, input.signal]) : abort.signal;
    try {
      const request = new Request(url.toString(), {
        method: input.method,
        headers: {
          Authorization: `Bearer ${input.authToken}`,
          ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal,
      });
      const response = await this.context.dispatchApiRoutes(request) ?? Response.json({ error: 'Not found' }, { status: 404 });
      // A streaming response cannot be delivered over the request/response call
      // frame, refuse honestly (and tear the producer down) instead of
      // buffering an endless body via text().
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        abort.abort();
        await response.body?.cancel().catch(() => {});
        return {
          status: 501,
          ok: false,
          body: { error: 'streaming-not-supported', message: 'This path serves an event stream; it cannot be invoked as a WS call. Subscribe via the events channel instead.' },
        };
      }
      const raw = await readResponseTextBounded(response, signal);
      let body: unknown = raw;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      } else {
        body = null;
      }
      return {
        status: response.status,
        ok: response.ok,
        body,
      };
    } finally {
      this.releaseCall(caller);
    }
  }

  /** Separate construction scope: a retained handler authorization must not
   * retain or reread its request body, query, abort signal or mutable authToken
   * field. The original credential/principal/scopes and actual catalog/auth
   * owners remain restrictions after a handler returns or its socket closes. */
  private retainGatewayAuthorization(token: string, descriptor: GatewayMethodDescriptor,
    context: GatewayMethodInvocationContext | undefined): (requiredScopes?: readonly string[]) => boolean {
    const catalog = this.context.gatewayMethods, pairing = this.context.pairingTokens, users = this.context.userAuth;
    const captured = Object.freeze({ principalId: context?.principalId, principalKind: context?.principalKind,
      admin: context?.admin === true, scopes: Object.freeze([...(context?.scopes ?? [])]) });
    // Authenticated again only when the credential owners' revision moved.
    let known: RequestPrincipal | null | undefined;
    return (requiredScopes = []) => {
      if (this.context.gatewayMethods !== catalog || catalog.get(descriptor.id) !== descriptor
        || this.context.pairingTokens !== pairing || this.context.userAuth !== users) return false;
      if (descriptor.access === 'public' || descriptor.access === 'remote-peer') return true;
      if (!known || !isPrincipalCurrent(known, this.authRevision())) known = this.describeRequestPrincipal(token);
      const fresh = known;
      return fresh !== null && fresh.principalId === captured.principalId && fresh.principalKind === captured.principalKind
        && refuseGatewayInvocation(descriptor, fresh, requiredScopes) === null
        && refuseGatewayInvocation(descriptor, captured, requiredScopes) === null;
    };
  }

  /**
   * One gateway call. Its untrusted-content turn and ingests are scoped to the
   * calling principal, so one owner's fresh request cannot move the watermark
   * past what another principal's session just read.
   */
  async invokeGatewayMethodCall(input: GatewayMethodCallInput): Promise<{ status: number; ok: boolean; body: unknown }> {
    // Only a principal this daemon verified names a scope. A call it did not authenticate (a public
    // method, a peer) shares one scope of its own, so what it claims about itself cannot reach another
    // principal's window.
    const descriptor = this.context.gatewayMethods.get(input.methodId);
    const authenticates = !!descriptor && descriptor.access !== 'public' && descriptor.access !== 'remote-peer';
    // One authentication per call, handed to the dispatch below.
    const principal = authenticates ? input.principal ?? this.describeRequestPrincipal(input.authToken) : null;
    const principalId = principal?.principalId;
    // Clients of one principal (every shared-token client, every login of one user) each get their own
    // window: a fresh request on one connection must not end what another connection just read.
    const connectionId = principalId === undefined ? undefined : input.context?.connectionId;
    const scope = principalId === undefined ? 'unauthenticated'
      : connectionId === undefined ? `principal:${principalId}` : `principal:${principalId}:connection:${connectionId}`;
    return withUntrustedContentScope(scope,
      () => this.dispatchGatewayMethodCall(input, principal));
  }

  private async dispatchGatewayMethodCall(input: GatewayMethodCallInput, authenticated: GatewayMethodCallInput['principal'] | null): Promise<{ status: number; ok: boolean; body: unknown }> {
    const descriptor = this.context.gatewayMethods.get(input.methodId);
    if (!descriptor) {
      return {
        status: 404,
        ok: false,
        // Machine-readable, mirroring the NOT_INVOKABLE convention just below
        // (validateGatewayInvocation), the uncataloged-id 404 gets its own code so
        // no consumer has to string-match "Unknown gateway method".
        body: refusalBody(`Unknown gateway method: ${input.methodId}`, EngineErrorCodes.METHOD_NOT_FOUND, 404),
      };
    }
    // Open connections do not preserve revoked credentials or old roles.
    // Remote peers have a separate credential verifier on their HTTP routes.
    let context = input.context;
    if (descriptor.access !== 'public' && descriptor.access !== 'remote-peer') {
      const principal = authenticated;
      if (!principal || (context?.principalId !== undefined && context.principalId !== principal.principalId)
        || (context?.principalKind !== undefined && context.principalKind !== principal.principalKind)) {
        return { status: 401, ok: false, body: refusalBody('Operator authentication is no longer valid', 'AUTH_REQUIRED', 401) };
      }
      const cachedScopes = new Set(context?.scopes ?? principal.scopes);
      const scopes = cachedScopes.has('*') ? principal.scopes
        : principal.scopes.includes('*') ? [...cachedScopes]
        : principal.scopes.filter(scope => cachedScopes.has(scope));
      context = {
        ...context, principalId: principal.principalId, principalKind: principal.principalKind,
        admin: (context === undefined || context.admin === true) && principal.admin, scopes,
      };
    }
    const denied = this.validateGatewayInvocation(descriptor, context);
    if (denied) return denied;
    // The client frame asserts that a person asked for this call. Only a principal
    // the transport itself established as a person's (a login session, a paired
    // device, or an app on the daemon's own machine) can make that claim; the
    // operator token from elsewhere, the Agent's credential for the calls it
    // makes on the owner's behalf, a bot, service or peer cannot, so their claim
    // is dropped before any handler reads it. A literal false stays: it only restricts.
    const credential = authenticated?.credentialKind;
    if (context?.explicitUserRequest === true && credential !== 'user-session' && credential !== 'device-token' && credential !== 'local') {
      context = { ...context, explicitUserRequest: undefined };
    }
    // Input validation gate: reject a wrong-typed / missing-required body against
    // the verb's typed inputSchema before the handler runs (honest 400, not silent
    // coercion). Only body-carrying invocations are checked, a handler method
    // (no http binding) or a POST/PATCH verb receives its params in the body;
    // GET/DELETE params arrive as query strings that cannot be soundly type-checked.
    const carriesBody = !descriptor.http || descriptor.http.method === 'POST' || descriptor.http.method === 'PATCH';
    if (carriesBody) {
      const invalid = validateInvocationInput(descriptor, input.body);
      if (invalid) {
        return {
          status: 400,
          ok: false,
          body: refusalBody(invalid.detail, invalid.code, 400),
        };
      }
    }
    // A fresh owner request resets the untrusted-content window; automated
    // work deliberately does not. It runs only once the call is known, the
    // principal is current and its scopes allow it, so a refused or malformed
    // frame cannot clear what strangers' content left behind. See security/turn-boundary.ts.
    startTurnForOwnerRequest(context?.explicitUserRequest);
    const caller = callerKey(input.context?.connectionId, context?.principalId ?? authenticated?.principalId);

    if (this.context.gatewayMethods.hasHandler(input.methodId)) {
      // ONE contract: no call arm is unbounded. The registered-handler branch
      // shares the in-flight budget of the direct http-dispatch path: each
      // in-flight invocation retains its auth token + client-controlled frame
      // body for the handler's full latency (probed: 5,000 concurrent handler
      // invocations, invisible to wsCallStats, before this guard).
      const refused = this.admitCall(caller);
      if (refused) return refused;
      try {
        const body = await this.context.gatewayMethods.invoke(input.methodId, {
          body: input.body,
          query: input.query,
          signal: input.signal,
          // A plain field, not built on first read: handlers refuse invocation
          // fields that are accessors. For anything but a paired device's token
          // or the local credential it is a prefix test and null.
          nativeExecutionAuthority: this.createNativeExecutionAuthority(input.authToken, context?.scopes ?? [], authenticated?.credentialKind) ?? undefined,
          isAuthorized: this.retainGatewayAuthorization(input.authToken, descriptor, context),
          context: {
            authToken: input.authToken,
            principalId: context?.principalId,
            principalKind: context?.principalKind,
            admin: context?.admin,
            scopes: context?.scopes,
            clientKind: context?.clientKind,
            ...(authenticated?.credentialKind ? { credentialKind: authenticated.credentialKind } : {}),
            ...(context?.explicitUserRequest === undefined
              ? {}
              : { metadata: { explicitUserRequest: context.explicitUserRequest } }),
          },
        });
        if (body instanceof Response) {
          if ((body.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
            await body.body?.cancel().catch(() => {});
            return {
              status: 501,
              ok: false,
              body: { error: 'streaming-not-supported', message: 'This method serves an event stream; it cannot be invoked as a WS call. Subscribe via the events channel instead.' },
            };
          }
          const text = await readResponseTextBounded(body, input.signal);
          let responseBody: unknown = text || null;
          if (text.length > 0) {
            try {
              responseBody = JSON.parse(text);
            } catch {
              responseBody = text;
            }
          }
          return { status: body.status, ok: body.ok, body: responseBody };
        }
        return { status: 200, ok: true, body };
      } catch (error) {
        // A handler-registered verb (fleet.*, checkpoints.*,
        // sessions.search, see CHANGELOG 1.0.0) reports an honest caller-error
        // status (400/403/404) instead of the blanket 500 below by throwing a
        // refusal, read by shape, so a consuming runtime's own error class
        // counts too. See routes/gateway-verb-error.ts.
        const refusal = readGatewayVerbRefusal(error);
        if (refusal) {
          return {
            status: refusal.status,
            ok: false,
            body: refusalBody(refusal.message, refusal.code, refusal.status),
          };
        }
        // redactSensitiveData outside classic mode answers only markers on its first call; local masking keeps the message readable.
        const message = redactDiagnosticText(summarizeError(error));
        return {
          status: 500,
          ok: false,
          body: buildErrorResponseBody(message, { status: 500 }),
        };
      } finally {
        this.releaseCall(caller);
      }
    }
    if (!descriptor.http) {
      // Cataloged, no handler registered here, and no route to synthesize a
      // request against. The code is the same one `validateGatewayInvocation`
      // uses for a declared-uninvokable method: from a caller's side both are
      // "this id exists and this daemon will not dispatch it".
      return {
        status: 501,
        ok: false,
        body: refusalBody(`Gateway method is not invokable: ${input.methodId}`, EngineErrorCodes.NOT_INVOKABLE, 501),
      };
    }
    // No handler here: the advertised path is served by its route module, if
    // any. The gateway REST arm serves only verbs with a handler, so this
    // request cannot come back to this method; a path nothing serves answers
    // the fixed 501 NOT_INVOKABLE.
    const resolvedPath = resolveGatewayPathTemplate(descriptor.http.path, input.query, input.body);
    if (!resolvedPath.path) {
      return {
        status: 400,
        ok: false,
        body: {
          ...refusalBody(`Missing path parameter${resolvedPath.missing.length === 1 ? '' : 's'} for ${input.methodId}: ${resolvedPath.missing.join(', ')}`, 'INVALID_ARGUMENT', 400),
          missing: [...resolvedPath.missing],
        },
      };
    }
    return this.invokeWebSocketControlPlaneCall({
      authToken: input.authToken,
      signal: input.signal,
      method: descriptor.http.method,
      path: resolvedPath.path,
      query: input.query,
      caller,
      body: descriptor.http.method === 'GET' || descriptor.http.method === 'DELETE' ? undefined : input.body,
      context: {
        principalKind: context?.principalKind,
        admin: context?.admin,
        scopes: context?.scopes,
      },
    });
  }
}

/** True when the path part holds a "." or ".." segment, written plainly, percent-encoded or with a backslash. */
function hasDotSegment(path: string): boolean {
  const pathOnly = path.split(/[?#]/, 1)[0] ?? '';
  return pathOnly.split(/[/\\]/).some((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* an undecodable segment cannot be a dot segment */ }
    return decoded === '.' || decoded === '..';
  });
}

function parseRuntimeDomains(rawDomains: string | null): RuntimeEventDomain[] | Response {
  if (!rawDomains) return [];
  return normalizeFrameDomains(rawDomains.split(',').map((value) => value.trim()).filter(Boolean));
}

function normalizeFrameDomains(values: readonly unknown[]): RuntimeEventDomain[] | Response {
  const domains: RuntimeEventDomain[] = [];
  const invalid: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      invalid.push(String(value));
      continue;
    }
    const trimmed = value.trim();
    if (!isRuntimeEventDomain(trimmed)) {
      invalid.push(trimmed);
      continue;
    }
    domains.push(trimmed);
  }
  if (invalid.length > 0) {
    return Response.json({
      error: 'Invalid runtime event domain',
      invalid,
    }, { status: 400 });
  }
  return [...new Set(domains)];
}

/** A scope list the credential stores for itself, when it carries one. */
function storedScopesOf(authenticated: AuthenticatedOperatorRequest): readonly string[] | undefined {
  // The credential owners add `scopes` to a pairing token or a user that was
  // issued a narrower list; without one the role's default set applies.
  const stored = (authenticated as AuthenticatedOperatorRequest & { readonly scopes?: readonly string[] | undefined }).scopes;
  return Array.isArray(stored) ? stored : undefined;
}

