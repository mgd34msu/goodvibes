import { IdempotentReplayStore, takesIdempotencyKey } from '../control-plane/idempotent-replay.js';
import { WebSocketOutbox } from './websocket-outbox.js';
import { WebSocketMessageAssembler } from '@goodvibes/engine/transport-core';
import type { AgentManager } from '../tools/agent/index.js';
import { startTurnForOwnerRequest } from '../security/turn-boundary.js';
import { withUntrustedContentScope } from '../security/untrusted-content.js';
import { clearExposure, decodeCarriedExposure, withCarriedExposure } from '../security/conversation-exposure.js';
import { randomUUID } from 'node:crypto';
import type { UserAuthManager, SettingsSessionAuthority } from '../security/user-auth.js';
import type { SettingsPairingAuthority } from '../pairing/pairing-token-store.js';
import { PairingStoreFaultedError, SettingsAuthorityUnavailableError, runSynchronousSettingsOperation } from '../security/settings-authority.js';
import { LOCAL_OWNER_CREDENTIAL, isPairingTokenShape, type NativeCredential } from '../pairing/pairing-token-store.js';
import {
  authenticateOperatorToken,
  credentialKindOf,
  extractOperatorAuthToken,
  extractRemotePeerToken,
  matchesSharedToken,
  operatorPrincipalGrant,
  type AuthenticatedOperatorRequest,
  type PairingTokenAuthenticator,
  type NativeExecutionAuthority,
  type NativePairedSnapshot,
} from '../security/http-auth.js';
import { bindRequestContext, createRequestContext, isPrincipalCurrent, requestContextOf } from './request-context.js';
import type { ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../control-plane/index.js';
import type { CallContext, GatewayMethodInvocationContext } from '../control-plane/method-catalog-shared.js';
import { CALLER_RULES_ABSENT, callerPathRefusal, pathNamerOf } from '../control-plane/caller-paths.js';
import { hasArtifactMaker, withArtifactMaker, type ArtifactTurnMaker } from '../artifacts/turn-maker.js';
import { callerReachRefusal, reachableAnswer, reachFilterOf } from '../control-plane/caller-reach.js';
import { SHARED_KIND_NOT_GIVEN, type SharedKind, type SharedKindCaller } from '../control-plane/shared-kinds.js';
import { callReachesKnowledge } from '../knowledge/knowledge-reach.js';
import { daemonSharedKindRule, sharedKindAdmission, type SharedKindAnswer } from './shared-kind-gifts.js';
import { withRecordReach } from '@goodvibes/engine/daemon-api';
import { RECORD_NOT_YOURS } from '../control-plane/method-catalog.js';
import type { RuntimeEventDomain } from '../runtime/events/index.js';
import { RUNTIME_EVENT_DOMAINS } from '../runtime/events/index.js';
import { readRequestedDomains } from '../control-plane/gateway-utils.js';
import type { DistributedRuntimeManager } from '../runtime/remote/index.js';
import { projectNamerOf, type CallerProjectVerdict, type ProjectNamer } from '../workspace/caller-project.js';
import { PROJECT_FOLDER_NOT_REACHABLE, unreachableFolderWords } from '../workspace/unreachable-folder-words.js';
import { extractForwardedClientIp } from '../runtime/network/index.js';
import { clientAddressOf, isLocalOrigin, resolveClientAddress } from './client-address.js';
import { requestTransport } from '../runtime/network/request-transport.js';
import { describeCardTransportRefusal, mayCrossWithCardDetails } from '../payments/entry-policy.js';
import { resolveGatewayPathTemplate } from './helpers.js';
import { catalogGrantedScopes, refuseGatewayInvocation } from './http/gateway-binding-gate.js';
import { browserOriginAllowed, originNotAllowedResponse } from './http/browser-origin.js';
import { markForAdmission } from './http/request-router.js';
import { createAuthFailureAudit, type AuthFailureAudit } from './auth-failure-audit.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { redactDiagnosticText } from '../utils/redaction.js';
import { validateInvocationInput } from '../control-plane/invoke-input-validation.js';
import { readGatewayVerbRefusal } from '../control-plane/routes/gateway-verb-error.js';
import { decidedMarkAct, decidedMarkCovers, ownerApprovalCovers, spendCapabilityDecidedMark, spendOwnerApprovalGrant, type OwnerApprovedCallGrant } from '../control-plane/owner-approved-call.js';

/** The settings writes that keep who made them and how it was decided (daemon-api control-routes.ts `SettingAct`). */
const SETTING_WRITE_METHOD_IDS: ReadonlySet<string> = new Set(['config.set', 'config.setMany', 'config.reset', 'credentials.set', 'credentials.delete']);
import { methodCallRisk, OWNER_ONLY_WHERE, ownerOnlyMethodArea, riskOfDescriptor, VALUE_DECIDED_METHOD_IDS, type MethodRisk } from '../control-plane/method-risk.js';
import { modelNeverMakes } from '../security/effect-authority.js';
import { AGENT_CREDENTIAL_OWNER_ONLY_WORDS, ANSWER_METHOD_IDS, callerAdmitted, methodCallPutToOwner, mintsAgentCredential, nestedAnswerAdmitted, OWNER_ANSWERS_ONLY, OWNER_ANSWERS_ONLY_WORDS, OWNER_DECISION_NEEDED, OWNER_DEVICE_ANSWER_METHOD_IDS, ownerAnswers, ownerHimself, ownersAgentProgram, ownersDevice, ownersOwnSession, partyOfCaller, wellFormedActor,
  makesOwnerOnlyAct, MODEL_NEVER, modelNeverWords, OWNER_ONLY_ACT, ownerOnlyActWords } from './method-owner-decision.js';
import { asCallOutsideTurn, turnInputParty } from '../security/turn-input-party.js';
import { decideInProject } from '../permissions/call-project.js';
import { withFirstUseCall, type FirstUseCall } from './capability-owner-gate.js';
import { bindOwnerAdmitted, bindProgramRegistration, bindSettingAct, type SettingAct } from '@goodvibes/engine/daemon-api/control-routes';

/** The `{param}` values of a path template in a path, decoded; undefined when the path does not fit the template. */
function pathParamsOf(template: string, pathname: string): Record<string, string> | undefined {
  const want = (template.replace(/\/+$/, '') || '/').split('/');
  const have = (pathname.replace(/\/+$/, '') || '/').split('/');
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index += 1) {
    const part = want[index]!;
    if (!part.startsWith('{') || !part.endsWith('}')) continue;
    try { params[part.slice(1, -1)] = decodeURIComponent(have[index]!); } catch { return undefined; }
  }
  return params;
}

/** The method every call put to the owner goes through (control-plane/routes/capabilities.ts). */
const CAPABILITY_RUN_METHOD = 'capabilities.run';

/** A risk class in words, for a refusal that names why the owner decides a call. */
/** The methods that make a credential: each records who made it (`credentialMakerOf`). */
const CREDENTIAL_MINT_METHOD_IDS: ReadonlySet<string> = new Set(['pairing.tokens.create', 'pairing.tokens.migrate', 'pairing.outsideAgent.issue']);

/**
 * Who makes a credential: the user from any credential (their sign-in, a device, the operator token, a command line), or the
 * caller it was put to the owner for, on the owner's yes; undefined for anyone else (such a mint is held for the owner
 * first). A yes gives that caller what its card said.
 */
function credentialMakerOf(authenticated: { readonly principalId: string; readonly credentialKind?: CredentialKind | null | undefined; readonly actor?: Actor | undefined } | null | undefined,
  caller: { readonly actor: Actor | undefined; readonly registration: string | undefined }, ownerApproved: boolean): { readonly owner: true } | { readonly caller: string; readonly ownersYes: true } | undefined {
  // The daemon's own in-process act is not the owner being there: it records no maker (never the owner's device).
  if (caller.actor?.class === 'system') return undefined;
  // The user from any credential (method-owner-decision.ts `makesOwnerOnlyAct`, the one test).
  if (authenticated && makesOwnerOnlyAct({ actor: authenticated.actor, credentialKind: authenticated.credentialKind ?? undefined, registration: caller.registration })) return { owner: true };
  if (ownerApproved) return { caller: authenticated?.principalId ?? 'a caller the daemon could not name', ownersYes: true };
  return undefined;
}

const METHOD_RISK_WORDS: Readonly<Record<Exclude<MethodRisk, 'none'>, string>> = {
  'loosens-a-protection': 'loosens a protection', 'runs-later': 'sets something to run by itself later',
  'steers-a-model': 'writes what steers a model in the owner\'s turns',
  'cannot-be-undone': 'cannot be undone', 'spends-money': 'spends money',
  'writes-a-secret': 'writes a secret', 'owner-act': 'is an act only the owner makes',
  'answers-the-owner': 'answers something addressed to the owner',
};
import { AUTHENTICATION_REQUIRED_GUIDANCE, authenticationRequiredResponse, buildErrorResponseBody, jsonErrorResponse } from './http/error-response.js';
import { EngineErrorCodes, isRefusal, refusalErrorBody } from '@goodvibes/engine/errors';
import { startsWork, type DaemonWorkAdmission } from './work-admission.js';
import {
  actorFromPrincipal,
  NO_OWNER_USER,
  type Actor,
  type AuthenticatedPrincipal,
  type CredentialKind,
  type OwnerIdentity,
  type RequestContext,
  type RequestPrincipal,
} from './http-policy.js';

/** What a socket closed for a revoked credential is told last. */
/**
 * The text frame of a delivered event, kept per payload object: the gateway
 * hands every socket the same payload object for one event, so the event is
 * serialised once, not once per connected client.
 */
const socketEventFrames = new WeakMap<object, { readonly event: string; readonly id: string | undefined; readonly frame: string }>();
/**
 * An event frame carries the record's id, the position a client presents as
 * `lastEventId` when it connects again, so the gateway replays what it missed.
 */
function socketEventFrame(event: string, payload: unknown, id?: string): string {
  const body = { type: 'event', event, ...(id ? { id } : {}), payload };
  if (payload === null || typeof payload !== 'object') return JSON.stringify(body);
  const kept = socketEventFrames.get(payload);
  if (kept && kept.event === event && kept.id === id) return kept.frame;
  const frame = JSON.stringify(body);
  socketEventFrames.set(payload, { event, id, frame });
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
  /** A device the owner paired in person; see RequestPrincipal.ownerDevice. */
  ownerDevice?: true | undefined;
  /** Who the socket's principal is as a cause of effects; null before in-band auth. */
  actor?: Actor | null | undefined;
  /** The principal the socket authenticated as, actor included: every call on the socket is admitted as it. */
  principal?: RequestPrincipal | undefined;
  admin: boolean;
  scopes: readonly string[];
  readonly domains: readonly RuntimeEventDomain[];
  /** `?domains=` names that are not runtime event domains; the `ready` frame names them back. */
  readonly unrecognisedDomains?: readonly string[] | undefined;
  /** `?lastEventId=`: the id of the last event the client holds; the gateway replays what came after it. */
  readonly lastEventId?: string | undefined;
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
  /** Answers repeats of a call to a method that takes the shared Idempotency-Key; absent, such a key is not honoured. */
  readonly idempotentReplay?: IdempotentReplayStore | undefined;
  /** Closed for a self-update's restart: a call that could start or change work is refused, as the HTTP router refuses it. */
  readonly workAdmission?: DaemonWorkAdmission | undefined;
  /**
   * The one check of the project a caller names (workspace/caller-project.ts `checkCallerProject`): every method call's
   * `workingDirectory` and call-context project go through it before any handler reads them, and the handler sees the
   * checked project only. Absent (a daemon composed without one): taken as given.
   */
  readonly callerProject?: ((raw: string, who: ProjectNamer) => CallerProjectVerdict) | undefined;
  /**
   * The inputs of a capability that name a folder a turn or process works in (capabilities/work-folders.ts): for a
   * `capabilities.run` call, each is checked as `inputs.<id>` with the method's own `workFolders`. Absent: none.
   */
  readonly capabilityWorkFolders?: ((capabilityId: string) => readonly string[]) | undefined;
  /**
   * Forget the projects the owner gave these principals (workspace/caller-projects-store.ts): a device unpaired or a
   * member removed keeps none, so a device paired again later, or a new member of the same name, starts with none.
   */
  readonly forgetCallerProjects?: ((principalIds: readonly string[]) => void) | undefined;
  /**
   * Run once as the daemon stops cleanly (`dispose`): it keeps which credentials exist then, so the next start tells one made
   * while this version did not run (facade-composition.ts, the carry from 3.5.0 after a rollback).
   */
  readonly onStop?: (() => void) | undefined;
  /**
   * The outside agent's projects (daemon/outside-agent.ts): for the folders a call of its own credential names, go on
   * (given, or given now on the owner's yes) or the refusal; undefined for any other caller. Absent: never asked.
   */
  readonly outsideAgentProject?: ((principalId: string, folders: readonly string[], signal?: AbortSignal) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string } | undefined>) | undefined;
  /**
   * Where this daemon cannot verify its programs (daemon/unverified-programs.ts): for the folders a call of the
   * operator token from this machine without a registration names, go on (given, or given now on the owner's yes) or
   * the question's id; undefined where verification works or for any other caller. Absent: never asked.
   */
  readonly unverifiedProgramProject?: ((caller: { readonly principalId: string; readonly credentialKind: string | undefined; readonly registration: string | undefined }, folders: readonly string[], signal?: AbortSignal) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string } | undefined>) | undefined;
  /**
   * The owner's shared things (control-plane/shared-kinds.ts, daemon/shared-kind-gifts.ts): whether this caller may
   * reach the shared kind a call acts on, or the refusal, or the one question's id. Absent: nobody but the owner in person,
   * their programs and their own turns reaches one (never "no rule, no check").
   */
  readonly sharedKind?: ((caller: SharedKindCaller, kind: SharedKind) => Promise<SharedKindAnswer>) | undefined;
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
  /**
   * The caller's retry key (the Idempotency-Key header of the invoke request,
   * or `idempotencyKey` beside `body`): a method that takes the shared key
   * answers a repeat under it with the first answer.
   */
  readonly idempotencyKey?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly query?: Record<string, unknown> | undefined;
  readonly body?: unknown | undefined;
  readonly context?: {
    readonly principalId?: string | undefined;
    readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
    readonly admin?: boolean | undefined;
    readonly scopes?: readonly string[] | undefined;
    readonly clientKind?: string | undefined;
    /** Which credential the call authenticated with, taken from the principal the daemon verified. */
    readonly credentialKind?: CredentialKind | undefined;
    /** The daemon-assigned id of the connection the call arrived on; separates one client's untrusted-content window from another's under the same principal. */
    readonly connectionId?: string | undefined;
    /** Who the call is admitted as; set by dispatch from the principal it verified, never by a caller. */
    readonly actor?: Actor | undefined;
    /**
     * True when a person asked for this, now. Set ONLY by transports that
     * can honestly claim it; scheduled work and triggers leave it unset
     * because they cannot. The confirmation gate reads it and it starts a
     * new untrusted-content turn, see control-plane/confirmation-gate.ts and
     * security/turn-boundary.ts.
     */
    readonly explicitUserRequest?: boolean | undefined;
    /**
     * The sending run's own answerer (its script) decided this natively admitted call (daemon-api control-routes.ts
     * `DECIDED_IN_RUN_HEADER`). Kept only for the Agent's credential, whose calls the daemon takes as decided by the
     * program's gate already (capabilities.run): the native admission then asks nobody again.
     */
    readonly decidedInRun?: boolean | undefined;
    /**
     * The program's capability gate decided this `capabilities.run` call by the capability's own risk (daemon-api
     * control-routes.ts `CAPABILITY_GATE_DECIDED_HEADER`). Kept only for the Agent's credential: without it, a call
     * with that credential is decided by the daemon's own gate (control-plane/routes/capabilities.ts).
     */
    readonly decidedByCapabilityGate?: boolean | undefined;
    /**
     * The call context the calling program sends with every request (daemon-api control-routes.ts `readCallContext`):
     * the project folder it acts in and its conversation. Given to the handler as `context.call`.
     */
    readonly call?: CallContext | undefined;
  };
  /**
   * The principal the caller already verified for this credential on this
   * call (a socket compares its authentication revision first). Absent: the
   * call authenticates the token once itself.
   */
  readonly principal?: RequestPrincipal | undefined;
  /**
   * In process only: the owner approved the outer call this one is nested in (control-plane/owner-approved-call.ts).
   * Spent on this call, it keeps the person's claim for a method that needs one (`owner-request`), whatever the credential.
   */
  readonly ownerApproved?: OwnerApprovedCallGrant | undefined;
  /**
   * In process only: the capability this call is nested in was decided already (owner-approved-call.ts
   * `capabilityDecidedMark`); spent here, the method's risk class is not decided a second time (method-owner-decision.ts).
   */
  readonly decidedUpstream?: object | undefined;
  /**
   * In process only: the method's own handler found the call's value is the owner's to decide for a caller the rule
   * does not admit (method-owner-decision.ts `OWNER_DECISION_NEEDED`): the same call is now put to the owner's gate.
   */
  readonly ownerDecisionNeeded?: true | undefined;
  /**
   * In process only: a call nested in one of the daemon's own turns (capability-wiring.ts `daemonTurn`), sent with the
   * daemon's own credential: it names exactly that turn's project (`context.call.project`), never another, and is not
   * the owner at large (control-plane/caller-paths.ts `daemonTurnProjectOf`).
   */
  readonly daemonTurn?: true | undefined;
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
    // The one check of the folders and files a call names, where every call reaches its handler: this daemon's
    // dispatch and its own turns' in-process calls alike (control-plane/caller-paths.ts).
    if (context.callerProject) {
      context.gatewayMethods.setCallerPathRules?.({ project: context.callerProject, ...(context.capabilityWorkFolders ? { capabilityWorkFolders: context.capabilityWorkFolders } : {}) });
    }
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
    if (bound && isPrincipalCurrent(bound.principal, this.authRevision())) return this.asWhoCalls(req, bound);
    const described = this.describeRequestContext(req);
    return described ? this.asWhoCalls(req, described) : null;
  }

  /**
   * The request's context as the credential established it. The operator token and the Agent's credential are the user's
   * whether or not the request carries a program's registration, so no actor is derived from the registration any more
   * (the `script` class is applied nowhere; daemon-api actor.ts `scriptActor`).
   */
  private asWhoCalls(_req: Request, context: RequestContext): RequestContext {
    return context;
  }

  private describeRequestContext(req: Request): RequestContext | null {
    const token = extractOperatorAuthToken(req);
    const described = token ? this.describeRequestPrincipal(token, isLocalOrigin(req)) : null;
    if (!described) return null;
    // How this request reached the listener, for an effect that may only cross some links (card entry).
    const principal: RequestPrincipal = Object.freeze({ ...described,
      transport: requestTransport(req, { tls: req.url.startsWith('https:'), trustProxy: this.trustProxyEnabled() }) });
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
    // The admin role of the credential alone, as released: no gift of one of the user's shared kinds opens a route.
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
    // A device unpaired keeps no project; a member keeps theirs while they are a member (all their sessions ended is not removal).
    const forget = this.context.forgetCallerProjects;
    const unpaired = (principalIds: readonly string[]): void => { close(principalIds); forget?.(principalIds); };
    const signedOut = (principalIds: readonly string[]): void => {
      close(principalIds);
      const members = new Set(this.context.userAuth.listUsers().map((user) => user.username));
      forget?.(principalIds.filter((principalId) => !members.has(principalId)));
    };
    const stops = [this.context.pairingTokens?.onRevoked?.(unpaired), this.context.userAuth.onRevoked?.(signedOut)];
    this.#stopRevocationWatch = () => { for (const stop of stops) stop?.(); };
  }

  #stopRevocationWatch: (() => void) | undefined;

  /** Stop following credential revocations; the daemon is stopping. */
  dispose(): void {
    this.#stopRevocationWatch?.();
    this.#stopRevocationWatch = undefined;
    const onStop = this.context.onStop;
    if (onStop && !this.#stopped) {
      this.#stopped = true;
      try { onStop(); } catch { /* not kept: the next start carries nothing it cannot tell, and takes nothing */ }
    }
  }

  #stopped = false;

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
    const { token, viaNodeCookie } = extractRemotePeerToken(req);
    // The web UI's phone node presents its peer token as an HttpOnly cookie; a page on
    // another origin (another port of the same host carries the cookie) may not use it.
    if (viaNodeCookie) {
      const origin = req.headers.get('origin');
      if (origin === null || !browserOriginAllowed(origin, this.context.allowedBrowserOrigins?.() ?? [])) {
        return originNotAllowedResponse(origin, 'act as this device node');
      }
    }
    const auth = await this.context.distributedRuntime.authenticatePeerToken(
      token,
      extractForwardedClientIp(req, this.trustProxyEnabled()),
    );
    if (!auth) {
      this.recordRefusedCredential(req);
      return authenticationRequiredResponse('Send this daemon a valid remote peer token (Authorization: Bearer) issued when the peer was paired; pair the peer again if its token was revoked or expired.');
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
    const { ownerDevice: baseOwnerDevice, ...base } = this.principalFor(authenticated);
    // Read after the credential stores were consulted: this is the state the principal was checked against.
    const authRevision = this.authRevision();
    const credentialKind = credentialKindOf(authenticated, loopback);
    const ownerDevice = baseOwnerDevice === true;
    return Object.freeze({
      ...base,
      credentialKind,
      scopeSet: new Set(base.scopes),
      roles: authenticated.kind === 'session' ? authenticated.roles : [],
      authRevision,
      ...(authenticated.kind === 'session' ? { expiresAt: authenticated.expiresAt } : {}),
      ...(ownerDevice ? { ownerDevice: true as const } : {}),
      actor: actorFromPrincipal({ ...base, credentialKind, ownerDevice }, this.ownerIdentity()),
    });
  }

  /**
   * Who the owner is among the sign-in users: the first user the store holds
   * (the one created at first start). Read from the store's memory; no I/O.
   */
  ownerIdentity(): OwnerIdentity {
    const ownerUser = this.context.userAuth.ownerUsername?.() ?? null;
    return ownerUser === null ? NO_OWNER_USER : { ownerUser };
  }

  /**
   * The actor a call is admitted as: the principal the daemon verified,
   * narrowed to the admin flag and scopes the call's context carries (a
   * context never widens it).
   */
  private callActor(principal: { readonly principalId: string; readonly principalKind: AuthenticatedPrincipal['principalKind'] | 'remote-peer'; readonly credentialKind?: CredentialKind | null | undefined; readonly ownerDevice?: true | undefined; readonly admin: boolean; readonly scopes: readonly string[]; readonly actor?: Actor | undefined },
    admin: boolean, scopes: readonly string[]): Actor {
    // The actor built when the credential was authenticated, unless the call's context narrowed it.
    if (principal.actor?.class === 'script') return principal.actor;
    if (principal.actor !== undefined && admin === principal.admin && scopes.length === principal.scopes.length) return principal.actor;
    return actorFromPrincipal({ ...principal, admin, scopes }, this.ownerIdentity());
  }

  /**
   * The grant is decided here, once, when the credential is authenticated, and
   * carried on the request or socket. The default sets come from the catalog
   * and are rebuilt only when a method or event is registered or removed. A
   * pairing token or a user that stores its own scope list is granted that
   * list, never more than the default set for its role.
   */
  private principalFor(authenticated: AuthenticatedOperatorRequest): AuthenticatedPrincipal & { readonly ownerDevice?: true | undefined } {
    // A paired device is a distinct, per-token principal (`pairing:<id>`), so
    // step-up credentials key per token and a revoked device drops out cleanly.
    // The rule is the one every listener uses (security/http-auth.ts).
    return operatorPrincipalGrant(authenticated, (includeWrite) => this.getGrantedGatewayScopes(includeWrite));
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
   * `credentialKind` is what the transport established for this request, and
   * authority goes by it, as released: the `local` credential (the operator token
   * from this machine) gets this machine's own authority while that token is
   * still the operator token; it is looked up on first use, so a call that never
   * reaches native work pays nothing for it. A signed-in user (`ownerSession`,
   * method-owner-decision.ts `ownersOwnSession`) holds the same authority as
   * this machine, the user's one native identity, while that session is still
   * current. Any pairing token is native as itself while it is still current.
   * While the native identity holds and the catalog's scopes do not move,
   * `current()` answers the snapshot it already built: one `lstat` per call.
   */
  createNativeExecutionAuthority(token: string, capturedScopes?: readonly string[], credentialKind?: CredentialKind | null, ownerSession = false, ownersProgram = false): NativeExecutionAuthority | null {
    const owner = this.context.pairingTokens;
    if (!owner?.authenticateNative || !owner.withNativeAuthority) return null;
    const signedIn = ownerSession && credentialKind === 'user-session';
    if (!signedIn && !ownersProgram) return null;
    const local = credentialKind === 'local' || signedIn;
    const credential: NativeCredential = local ? LOCAL_OWNER_CREDENTIAL : token;
    // The session read again only when the credential owners' revision moved (a sign-out or a removed user moves it).
    let session: RequestPrincipal | null | undefined;
    const stillLocal = (): boolean => {
      if (signedIn) {
        if (!session || !isPrincipalCurrent(session, this.authRevision())) session = this.describeRequestPrincipal(token);
        return session !== null && ownersOwnSession({ actor: session.actor, credentialKind: session.credentialKind });
      }
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
    context?: { readonly actor?: Actor | null | undefined },
  ): { status: number; ok: false; body: Record<string, unknown> } | null {
    return refuseGatewayInvocation(descriptor, context?.actor ?? undefined);
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
      return authenticationRequiredResponse('The WebSocket upgrade request itself must authenticate. Send an '
        + 'Authorization: Bearer token header on the upgrade (React Native and server runtimes support '
        + 'WebSocket constructor headers) or present an operator session cookie (same-origin browser '
        + 'session login). The in-band auth frame is only read after an authenticated upgrade.');
    }
    const origin = req.headers.get('origin');
    const bearer = /^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '');
    const originAllowed = origin === null
      ? bearer
      : browserOriginAllowed(origin, this.context.allowedBrowserOrigins?.() ?? []);
    if (!originAllowed) return originNotAllowedResponse(origin, 'connect');
    const rawDomains = url.searchParams.get('domains');
    const requested = parseRuntimeDomains(rawDomains);
    if (requested instanceof Response) return requested;
    const { domains, unrecognised } = requested;
    const lastEventId = url.searchParams.get('lastEventId')?.trim() || undefined;
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
        ...(principal.ownerDevice === true ? { ownerDevice: true as const } : {}),
        actor: principal.actor,
        principal,
        scopes: principal.scopes,
        admin: principal.admin,
        domains,
        ...(unrecognised.length > 0 ? { unrecognisedDomains: unrecognised } : {}),
        ...(lastEventId ? { lastEventId } : {}),
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
    close?(code?: number, reason?: string): void;
  }): void {
    this.socketSignal(ws);
    const connection = this.context.controlPlaneGateway.openWebSocketClient({
      clientKind: ws.data.clientKind,
      transport: 'ws',
      domains: ws.data.authenticated ? ws.data.domains : [],
      ...(ws.data.authenticated && ws.data.unrecognisedDomains ? { unrecognisedDomains: ws.data.unrecognisedDomains } : {}),
      ...(ws.data.authenticated && ws.data.lastEventId ? { lastEventId: ws.data.lastEventId } : {}),
      ...(ws.data.principalId ? { principalId: ws.data.principalId } : {}),
      ...(ws.data.principalKind ? { principalKind: ws.data.principalKind } : {}),
      scopes: ws.data.scopes,
      admin: ws.data.admin,
      remoteAddress: ws.data.remoteAddress,
      // Who follows: only events about records this caller may reach (control-plane/event-reach.ts).
      reachContext: {
        ...(ws.data.credentialKind ? { credentialKind: ws.data.credentialKind } : {}),
        ...(ws.data.principalId ? { principalId: ws.data.principalId } : {}),
        ...(ws.data.actor ? { actor: ws.data.actor } : {}),
      },
    }, (event, payload, id) => {
      // The gateway asked `current` (below) before filtering this frame with the grant in force now.
      if (!ws.data.authenticated || this.socketSignal(ws).aborted) return;
      this.sendFrame(ws, socketEventFrame(event, payload, id));
    }, () => this.closeRevokedSocket(ws), () => {
      // Nothing is delivered before the socket authenticates, and a revoked socket is served nothing.
      if (!ws.data.authenticated || this.socketSignal(ws).aborted) return false;
      // The authentication fence, checked at send time: a narrowed credential regrants the
      // socket here, before the gateway decides whether this frame is still covered.
      if (!this.socketPrincipalCurrent(ws)) {
        this.closeRevokedSocket(ws);
        return false;
      }
      return true;
    });
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
    // The socket keeps the fresh principal, and its actor unless the socket's own rights are narrower.
    data.principal = fresh;
    data.actor = data.admin === fresh.admin && data.scopes.length === fresh.scopes.length
      ? fresh.actor : actorFromPrincipal({ ...fresh, admin: data.admin, scopes: data.scopes }, this.ownerIdentity());
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
  private closeRevokedSocket(ws: { data: ControlPlaneWebSocketData; send(message: string): void; close?(code?: number, reason?: string): void }): void {
    const lifetime = this.socketLifetimes.get(ws);
    if (lifetime?.signal.aborted) return;
    this.sendFrame(ws, SOCKET_REVOKED_FRAME);
    lifetime?.abort();
    if (ws.data.clientId) this.context.controlPlaneGateway.closeWebSocketClient(ws.data.clientId, 'credential-revoked');
    // The socket ends after its `closed` frame, as an event stream does, instead of staying open serving nothing.
    try { ws.close?.(1008, 'credential-revoked'); } catch { /* the client already went */ }
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
        // The same refusal an HTTP route gives, as a frame.
        this.sendFrame(ws, JSON.stringify({
          type: 'auth', ok: false, error: 'Authentication required', code: 'AUTH_REQUIRED', category: 'authentication',
          guidance: AUTHENTICATION_REQUIRED_GUIDANCE,
        }));
        this.closeRefusedAuth(ws, 'Authentication required');
        return;
      }
      // The upgrade already subscribed its `?domains=`; names here are added. Known names are
      // subscribed and the others named back; only a list with no known name is refused.
      const asked = readFrameDomains(frame.domains);
      if (asked && asked.domains.length === 0 && asked.unrecognised.length > 0) {
        this.sendFrame(ws, JSON.stringify({ type: 'auth', ok: false, ...unknownDomainsRefusal(asked.unrecognised) }));
        this.closeRefusedAuth(ws, 'Unknown runtime event domain');
        return;
      }
      ws.data.authToken = token;
      ws.data.principalId = principal.principalId;
      ws.data.principalKind = principal.principalKind;
      ws.data.credentialKind = principal.credentialKind;
      ws.data.ownerDevice = principal.ownerDevice;
      ws.data.actor = principal.actor;
      ws.data.principal = principal;
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
        // The socket now follows as this principal: only events about records it may reach (control-plane/event-reach.ts).
        reachContext: { credentialKind: principal.credentialKind, principalId: principal.principalId, actor: principal.actor },
        ...(typeof frame.label === 'string' ? { label: frame.label } : {}),
        ...(Array.isArray(frame.capabilities) ? { capabilities: frame.capabilities.filter((value): value is string => typeof value === 'string') } : {}),
      });
      const added = asked && asked.domains.length > 0
        ? this.context.controlPlaneGateway.subscribeWebSocketClient(clientId, asked.domains)
        : undefined;
      this.sendFrame(ws, JSON.stringify({
        type: 'auth', ok: true, clientId, principalId: principal.principalId,
        ...(added && added.withheld.length > 0 ? { withheldDomains: added.withheld } : {}),
        ...(asked && asked.unrecognised.length > 0 ? { unrecognisedDomains: asked.unrecognised } : {}),
      }));
      return;
    }

    if (frame.type === 'subscribe') {
      if (!ws.data.authenticated) {
        this.sendFrame(ws, JSON.stringify({ type: 'error', error: 'Authenticate before subscribing' }));
        return;
      }
      const asked = readFrameDomains(frame.domains) ?? { domains: [], unrecognised: [] };
      if (asked.domains.length === 0 && asked.unrecognised.length > 0) {
        this.sendFrame(ws, JSON.stringify({ type: 'error', ...unknownDomainsRefusal(asked.unrecognised) }));
        return;
      }
      // Answered with what is actually delivered now: a domain the credential may not read is named as withheld.
      const result = this.context.controlPlaneGateway.subscribeWebSocketClient(clientId, asked.domains);
      this.sendFrame(ws, JSON.stringify({
        type: 'subscribed', clientId, domains: result?.subscribed ?? [],
        ...(result && result.withheld.length > 0 ? { withheldDomains: result.withheld } : {}),
        ...(asked.unrecognised.length > 0 ? { unrecognisedDomains: asked.unrecognised } : {}),
      }));
      return;
    }

    if (frame.type === 'unsubscribe') {
      const asked = readFrameDomains(frame.domains);
      // A list naming no known domain is refused: an empty selection here would end every domain.
      if (asked && asked.domains.length === 0 && asked.unrecognised.length > 0) {
        this.sendFrame(ws, JSON.stringify({ type: 'error', ...unknownDomainsRefusal(asked.unrecognised) }));
        return;
      }
      this.context.controlPlaneGateway.unsubscribeWebSocketClient(clientId, asked?.domains);
      this.sendFrame(ws, JSON.stringify({
        type: 'unsubscribed', clientId, domains: asked?.domains ?? [],
        ...(asked && asked.unrecognised.length > 0 ? { unrecognisedDomains: asked.unrecognised } : {}),
      }));
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
      let response: { readonly status: number; readonly ok: boolean; readonly body: unknown };
      // Every call frame is answered by its id: a call that throws gets a 500
      // answer rather than leaving the client waiting.
      try {
        response = methodId
        ? await this.invokeGatewayMethodCall({
            authToken: ws.data.authToken,
            ...(ws.data.principal ? { principal: ws.data.principal } : {}),
            signal: this.socketSignal(ws),
            methodId,
            ...(typeof frame.idempotencyKey === 'string' ? { idempotencyKey: frame.idempotencyKey } : {}),
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
              actor: ws.data.actor,
            },
            ...(ws.data.principal ? { principal: ws.data.principal } : {}),
            caller: callerKey(ws.data.clientId, ws.data.principalId ?? undefined),
          });
      } catch (error: unknown) {
        logger.error('[control-plane] websocket call failed', { id, ...(methodId ? { methodId } : { path: typeof frame.path === 'string' ? frame.path : undefined }), error: summarizeError(error) });
        response = {
          status: 500,
          ok: false,
          body: refusalBody('The daemon could not complete this call. The failure is in the daemon log; retrying the same call is unlikely to help.', 'INTERNAL_ERROR', 500),
        };
      }
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

  /**
   * Who made a settings write and how it was decided: what the capability it is nested in recorded (its run's act), else
   * the owner's yes to this call put to them, the owner's own press, or admitted under the owner's rules for the caller. A paired
   * device is named as the owner reads it, from its token; nothing else is looked up.
   */
  private settingActOf(authToken: string, context: { readonly actor?: Actor | undefined; readonly principalId?: string | undefined; readonly explicitUserRequest?: boolean | undefined } | undefined,
    upstream: SettingAct | undefined, ownerApproved: boolean, inPerson: boolean): SettingAct {
    const actor = context?.actor;
    const by = upstream?.by ?? context?.principalId ?? actor?.id ?? 'unknown';
    // The user from any credential (method-owner-decision.ts `ownerHimself`, `ownersCommandLine`): this record is what the
    // group's other machines read as the owner's own act (gate-review-6 G2).
    const owner = upstream?.owner ?? inPerson;
    const how = upstream?.how ?? (ownerApproved ? 'yes' : context?.explicitUserRequest === true && owner ? 'press' : 'rules');
    let name: string | undefined;
    try {
      const device = authToken ? this.context.pairingTokens?.authenticate(authToken) : null;
      if (device && (by === `pairing:${device.id}` || by.endsWith(device.id))) name = `the paired device "${device.name}"`;
    } catch { name = undefined; }
    return { by, owner, how, ...(name ? { name } : {}) };
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
      /** Who the call is admitted as (the socket's or the dispatched call's actor). */
      readonly actor?: Actor | null | undefined;
    };
    /**
     * The principal the call was authenticated as. The request this builds is
     * bound to it when the call's actor is the principal's own, so the route's
     * gate admits the very same actor instead of authenticating again.
     */
    readonly principal?: RequestPrincipal | undefined;
    /** Whose in-flight budget the call uses (see {@link callerKey}); a caller that names none shares one budget. */
    readonly caller?: string | undefined;
    /**
     * Facts of the dispatched call the route reads from its request's headers: the program's label and a person's
     * claim already kept by dispatch (only a person's credential keeps it), and the call context. Never a credential.
     */
    readonly headers?: Readonly<Record<string, string>> | undefined;
    /** Which program of the caller asked, as the router checked its registration: bound to the request in process. */
    readonly registration?: string | undefined;
    /** The dispatch made this call after deciding the method (method-owner-decision.ts): it is not decided again. */
    readonly decided?: true | undefined;
    /** The one rule admits this caller at once for a value-deciding route (bound to the request in process). */
    readonly ownerAdmitted?: true | undefined;
    /** Who made a settings write and how it was decided (bound to the request in process, control-routes.ts). */
    readonly settingAct?: SettingAct | undefined;
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    // The router sees the normalised path, so the descriptor and its scope are looked up by that one,
    // never by the raw text a client typed (`/api/x/../admin`, `/api/x?y`).
    if (hasDotSegment(input.path)) {
      return { status: 400, ok: false, body: refusalBody('The path contains a "." or ".." segment; send the final path.', 'INVALID_ARGUMENT', 400) };
    }
    const url = new URL(`http://${this.context.host}:${this.context.port}${input.path.startsWith('/') ? input.path : `/${input.path}`}`);
    const matchedDescriptor = this.context.gatewayMethods.findByHttpBinding(input.method, url.pathname);
    // A socket's method-and-path call of a method the owner decides (its risk class, method-owner-decision.ts) goes
    // through the dispatch as that method's call, as the REST door does: decided there, once, and served on a yes.
    if (matchedDescriptor && input.decided !== true && riskOfDescriptor(matchedDescriptor) !== 'none' && matchedDescriptor.http) {
      const params = pathParamsOf(matchedDescriptor.http.path, url.pathname);
      if (params) {
        const body = input.body !== null && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
        return this.invokeGatewayMethodCall({
          authToken: input.authToken, methodId: matchedDescriptor.id, ...(input.signal ? { signal: input.signal } : {}),
          query: { ...(input.query ?? {}), ...params }, body: { ...body, ...params },
          ...(input.principal ? { principal: input.principal } : {}),
          context: {
            ...(input.context?.principalKind ? { principalKind: input.context.principalKind } : {}),
            ...(input.context?.admin !== undefined ? { admin: input.context.admin } : {}),
            ...(input.context?.scopes ? { scopes: input.context.scopes } : {}),
            ...(input.headers?.['x-goodvibes-explicit-user-request'] === 'true' ? { explicitUserRequest: true } : {}),
          },
        });
      }
    }
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
    // The same admission the HTTP router applies: reads answer during a self-update's hold, anything else waits for the restart.
    const closed = this.context.workAdmission?.refusal();
    if (closed && startsWork(input.method)) return { status: 503, ok: false, body: closed };
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
      let request: Request;
      try {
        const sent = input.body !== undefined ? JSON.stringify(input.body) : undefined;
        request = new Request(url.toString(), {
          method: input.method,
          headers: {
            ...(input.headers ?? {}),
            Authorization: `Bearer ${input.authToken}`,
            // Its length declared, so the route reads it whole (utils/request-body.ts), not through a reader.
            ...(sent !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(sent)) } : {}),
          },
          ...(sent !== undefined ? { body: sent } : {}),
          signal,
        });
      } catch (error: unknown) {
        // An HTTP method that is not a token, or a body on GET or HEAD, cannot form a request.
        if (!(error instanceof TypeError)) throw error;
        return {
          status: 400,
          ok: false,
          body: refusalBody(`The call cannot be made as ${input.method} ${url.pathname}: the method must be an HTTP method name, and a GET or HEAD call carries no body (send its fields as query).`, 'INVALID_ARGUMENT', 400),
        };
      }
      // The caller's checked registration goes with the route this builds, in process only (control-routes.ts).
      bindProgramRegistration(request, input.registration);
      if (input.ownerAdmitted === true) bindOwnerAdmitted(request);
      bindSettingAct(request, input.settingAct);
      const bound = input.principal;
      if (bound && bound.actor === input.context?.actor && isPrincipalCurrent(bound, this.authRevision())) {
        const gateway = this.context.controlPlaneGateway;
        bindRequestContext(request, createRequestContext(bound, signal,
          typeof gateway?.principalSignal === 'function' ? () => gateway.principalSignal(bound.principalId) : undefined));
      }
      // A socket's own method-and-path call has passed none of the checks a request passes (the folder check, what its
      // caller may reach, the owner's shared things, the owner's decision, its list answers filtered): the router sends it
      // through every one, as it does a request over the wire. A call the dispatch decided and checked already is served.
      if (input.decided !== true) markForAdmission(request);
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
    context: GatewayMethodInvocationContext | undefined,
    /**
     * The call is made with the authority the owner's approval granted it (owner-approved-call.ts): its actor is the
     * owner (or the owner the model acts for), so the credential's own actor is not held to the method; the credential
     * must still be current, so a revoked one ends it.
     */
    ownerApproved = false): (requiredScopes?: readonly string[]) => boolean {
    const catalog = this.context.gatewayMethods, pairing = this.context.pairingTokens, users = this.context.userAuth;
    const captured = Object.freeze({ principalId: context?.principalId, principalKind: context?.principalKind, actor: context?.actor });
    // Authenticated again only when the credential owners' revision moved.
    let known: RequestPrincipal | null | undefined;
    return (requiredScopes = []) => {
      if (this.context.gatewayMethods !== catalog || catalog.get(descriptor.id) !== descriptor
        || this.context.pairingTokens !== pairing || this.context.userAuth !== users) return false;
      if (descriptor.access === 'public' || descriptor.access === 'remote-peer') return true;
      if (!known || !isPrincipalCurrent(known, this.authRevision())) known = this.describeRequestPrincipal(token);
      const fresh = known;
      return fresh !== null && fresh.principalId === captured.principalId && fresh.principalKind === captured.principalKind
        && (ownerApproved || refuseGatewayInvocation(descriptor, fresh.actor, requiredScopes) === null)
        && refuseGatewayInvocation(descriptor, captured.actor, requiredScopes) === null;
    };
  }

  /**
   * One gateway call. Its untrusted-content turn and ingests are scoped to the
   * calling principal, so one owner's fresh request cannot move the watermark
   * past what another principal's session just read.
   */
  async invokeGatewayMethodCall(input: GatewayMethodCallInput): Promise<{ status: number; ok: boolean; body: unknown; replayed?: boolean }> {
    const descriptor = this.context.gatewayMethods.get(input.methodId);
    // During a self-update's hold a method that could start or change work is refused with the HTTP router's code,
    // before the replay store, so the refusal is never kept as the answer to a key retried after the restart.
    const closed = descriptor ? this.context.workAdmission?.refusal() : null;
    if (closed && descriptor && startsWork(descriptor.http?.method, descriptor.effect)) return { status: 503, ok: false, body: closed };
    const store = this.context.idempotentReplay;
    if (input.idempotencyKey === undefined || !store || !takesIdempotencyKey(descriptor)) return this.invokeGatewayMethodCallOnce(input);
    const key = IdempotentReplayStore.readKey(input.idempotencyKey);
    if (key === undefined) return this.invokeGatewayMethodCallOnce(input);
    if (typeof key !== 'string') return { status: key.status, ok: false, body: key.body };
    const principalId = (input.principal ?? this.describeRequestPrincipal(input.authToken))?.principalId;
    // An unauthenticated call is refused by the call itself; a key is never kept for it.
    if (principalId === undefined) return this.invokeGatewayMethodCallOnce(input);
    const answer = await store.run({ principalId, methodId: input.methodId, key, request: { query: input.query ?? null, body: input.body ?? null } },
      async () => {
        const result = await this.invokeGatewayMethodCallOnce(input);
        return { status: result.status, body: result.body };
      });
    return { status: answer.status, ok: answer.status < 400, body: answer.body, ...(answer.replayed ? { replayed: true } : {}) };
  }

  private async invokeGatewayMethodCallOnce(input: GatewayMethodCallInput): Promise<{ status: number; ok: boolean; body: unknown }> {
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
    // A paged list a route or handler serves for this call keeps only what its caller may reach before it cuts its page
    // (control-plane/caller-reach.ts `reachFilterOf`, daemon-api `keepReachable`); none for the owner at large.
    const reachFilter = reachFilterOf({
      ...(principal?.credentialKind ? { credentialKind: principal.credentialKind } : {}), ...(principal ? { principalId: principal.principalId } : {}),
      ...(principal?.actor ? { actor: principal.actor } : {}), ...(input.context?.call ? { call: input.context.call } : {}),
      ...(input.context?.clientKind ? { clientKind: input.context.clientKind } : {}),
    }, this.context.gatewayMethods.reachRules?.(), input.body);
    // A program's call from its conversation (its session, as it names it) runs inside that conversation, marked with
    // what the program says its own turn read from outside (security/conversation-exposure.ts): the daemon decides it,
    // and every later call of that conversation, as for its own turn after such a read. It only tightens.
    // Only a conversation this caller may reach (the one reach rule: the owner at large, or a session it registered or
    // was given): naming another's session marks nothing of it, and the call is one call of its own.
    const namedSession = input.context?.call?.sessionId?.trim();
    const programSession = namedSession && (reachFilter === null || reachFilter('session', namedSession) || reachFilter('chat', namedSession))
      ? namedSession : undefined;
    const carried = decodeCarriedExposure(input.context?.call?.readOutside);
    const inConversation = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (input.daemonTurn === true) return fn();
      if (programSession) return withCarriedExposure(`conversation:${programSession}`, carried, fn);
      if (carried.length === 0) return fn();
      // No conversation named: this one call alone is exposed, and nothing is kept after it.
      const once = `conversation:call-${randomUUID()}`;
      try { return await withCarriedExposure(once, carried, fn); } finally { clearExposure(once); }
    };
    // A knowledge call adds as its caller, in the project it names (knowledge/knowledge-reach.ts): held by the one project
    // check (refused below by the dispatch when it may not name it), kept as checked. An outer call's maker stays.
    const knowledgeMaker = descriptor && callReachesKnowledge(descriptor.id) && !hasArtifactMaker()
      ? this.knowledgeMakerOf(input, principal) : undefined;
    return inConversation(() => withRecordReach(reachFilter, () => withArtifactMaker(knowledgeMaker, () => withUntrustedContentScope(scope, async () => {
      const result = await this.dispatchGatewayMethodCall(input, principal);
      // A value-deciding method's handler found the value is the owner's to decide for this caller (it changed nothing):
      // the same call goes to the owner's gate, the one decision every other held call gets.
      const code = result.body !== null && typeof result.body === 'object' ? (result.body as { readonly code?: unknown }).code : undefined;
      if (result.status === 409 && code === OWNER_DECISION_NEEDED && VALUE_DECIDED_METHOD_IDS.has(input.methodId) && input.ownerDecisionNeeded !== true) {
        // That value is the owner's own act (a setting loosened, a looser permission mode, access withdrawn that the
        // caller neither holds nor minted): anyone but the owner in person and their own model's turn is refused here, in
        // every mode, never put to the owner; their own program's call goes on to their gate.
        if (!makesOwnerOnlyAct({ actor: principal?.actor, credentialKind: principal?.credentialKind ?? undefined,
          registration: input.context?.call?.registration, ownersOwnTurn: this.ownersOwnTurnCall(input, principal) })) {
          const said = (result.body as { readonly error?: unknown }).error;
          const reason = typeof said === 'string' ? said.replace(/[\s:;,.]*the owner decides (that change|it)\.?\s*$/i, '').trim() : input.methodId;
          return { status: 403, ok: false, body: refusalBody(ownerOnlyActWords(`This change (${reason})`, OWNER_ONLY_WHERE[ownerOnlyMethodArea(input.methodId)]), OWNER_ONLY_ACT, 403) };
        }
        return this.dispatchGatewayMethodCall({ ...input, ownerDecisionNeeded: true }, principal);
      }
      return result;
    }))));
  }

  /**
   * A model is behind this call: a call nested in one of the daemon's own turns (its model's tool call), or one made
   * with the Agent's credential (the owner's model in their program, or a script holding that credential). Read from the
   * credential and the turn, never from the actor a grant put on the call.
   */
  private modelBehind(input: GatewayMethodCallInput, principal: GatewayMethodCallInput['principal'] | null): boolean {
    return input.daemonTurn === true || principal?.credentialKind === 'agent' || principal?.actor?.agentFor !== undefined;
  }

  /**
   * The owner's own model in their own turn (method-owner-decision.ts `makesOwnerOnlyAct`): a call nested in one of the
   * daemon's turns, or a turn it hosts, on the owner's own input (security/turn-input-party.ts); or their Agent program's
   * model (its credential with its program's checked registration) in a conversation on their own input.
   */
  private ownersOwnTurnCall(input: GatewayMethodCallInput, principal: GatewayMethodCallInput['principal'] | null): boolean {
    const call = input.context?.call;
    if (input.daemonTurn === true || (call?.daemonHosted === true && principal?.credentialKind === 'local')) return turnInputParty().party === 'owner';
    return ownersAgentProgram({ actor: principal?.actor, credentialKind: principal?.credentialKind ?? undefined, registration: call?.registration,
      daemonHosted: call?.daemonHosted === true }) && call?.othersInput !== true;
  }

  /** A settings write naming a permission setting (the mode, the rules): a model never makes it (`modelNeverWords`). */
  private namesPermissionSettings(methodId: string, body: unknown): boolean {
    if (methodId !== 'config.set' && methodId !== 'config.setMany' && methodId !== 'config.reset') return false;
    const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const keyOf = (change: unknown): unknown => change !== null && typeof change === 'object' ? (change as Record<string, unknown>)['key'] : undefined;
    // config.setMany names its keys in `entries` (method-catalog-admin.ts); `changes` and `keys` are read too.
    const keys = [record['key'], ...(Array.isArray(record['entries']) ? record['entries'].map(keyOf) : []),
      ...(Array.isArray(record['changes']) ? record['changes'].map(keyOf) : []),
      ...(Array.isArray(record['keys']) ? record['keys'] : [])];
    return keys.some((key) => typeof key === 'string' && (key === 'permissions' || key.startsWith('permissions.')));
  }

  /** A knowledge call's maker: its caller, and the project its call context, body or query names, as the one check reads it. */
  private knowledgeMakerOf(input: GatewayMethodCallInput, principal: GatewayMethodCallInput['principal'] | null): ArtifactTurnMaker | undefined {
    const field = (source: unknown): string | undefined => {
      const value = source !== null && typeof source === 'object' && !Array.isArray(source) ? (source as Record<string, unknown>)['workingDirectory'] : undefined;
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    const raw = input.context?.call?.project?.trim() || field(input.body) || field(input.query);
    let project: string | undefined;
    if (raw) {
      const namer = pathNamerOf({ ...(principal?.credentialKind ? { credentialKind: principal.credentialKind } : {}), ...(principal ? { principalId: principal.principalId } : {}),
        ...(principal?.actor ? { actor: principal.actor } : {}), ...(input.context?.call ? { call: input.context.call } : {}) } as Parameters<typeof pathNamerOf>[0]);
      const verdict = (this.context.gatewayMethods.pathRules?.() ?? CALLER_RULES_ABSENT).project(raw, namer);
      // Not a project this caller may name: the dispatch refuses the call before anything runs.
      project = verdict.ok ? verdict.project : undefined;
    }
    const createdBy = principal?.principalId;
    return createdBy || project ? { ...(createdBy ? { createdBy } : {}), ...(project ? { project } : {}) } : undefined;
  }

  /**
   * The projects a call names (its body's and query's `workingDirectory`, its call context's project), each checked by
   * `callerProject` for the credential that made the call and replaced by the checked project; or why one is refused.
   */
  /** A call nested in one of the daemon's own turns: the turn's project, which is all it names (`daemonTurn`). */
  private turnProjectOf(input: GatewayMethodCallInput): { readonly turnProject?: string } {
    if (input.daemonTurn !== true || input.context?.call?.daemonTurn !== true) return {};
    const project = input.context?.call?.project;
    return typeof project === 'string' && project.trim() ? { turnProject: project.trim() } : {};
  }

  private checkNamedProjects(input: GatewayMethodCallInput, authenticated: GatewayMethodCallInput['principal'] | null):
    { readonly ok: true; readonly input: GatewayMethodCallInput } | { readonly ok: false; readonly reason: string } {
    const check = this.context.callerProject;
    if (!check) return { ok: true, input };
    const who: ProjectNamer = projectNamerOf({ credentialKind: authenticated?.credentialKind, actor: authenticated?.actor,
      registration: input.context?.call?.registration, principalId: authenticated?.principalId,
      daemonHosted: input.context?.call?.daemonHosted === true, ...this.turnProjectOf(input) });
    const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    let next = input;
    const verdictOf = (raw: unknown): CallerProjectVerdict | undefined => typeof raw === 'string' && raw.trim() ? check(raw, who) : undefined;
    const body = record(input.body);
    const inBody = verdictOf(body?.['workingDirectory']);
    if (inBody && !inBody.ok) return inBody;
    if (inBody?.ok) next = { ...next, body: { ...body, workingDirectory: inBody.project } };
    const query = record(input.query);
    const inQuery = verdictOf(query?.['workingDirectory']);
    if (inQuery && !inQuery.ok) return inQuery;
    if (inQuery?.ok) next = { ...next, query: { ...query, workingDirectory: inQuery.project } as GatewayMethodCallInput['query'] };
    const inContext = verdictOf(input.context?.call?.project);
    if (inContext && !inContext.ok) return inContext;
    if (inContext?.ok && next.context?.call) next = { ...next, context: { ...next.context, call: { ...next.context.call, project: inContext.project } } };
    // Every other folder and file the call names is checked where every call reaches its handler (the method catalog's
    // `invoke`, control-plane/caller-paths.ts), and for a method served only by its route in the dispatch below.
    return { ok: true, input: next };
  }

  private async dispatchGatewayMethodCall(input: GatewayMethodCallInput, authenticated: GatewayMethodCallInput['principal'] | null): Promise<{ status: number; ok: boolean; body: unknown }> {
    // A call nested in one of the daemon's own turns is marked so, for every check after this one (it names its turn's
    // project only, control-plane/caller-paths.ts `daemonTurnProjectOf`); any other call carries no such mark.
    {
      const call = input.context?.call;
      if (input.daemonTurn === true) {
        input = { ...input, context: { ...input.context, clientKind: 'daemon-turn', ...(call ? { call: { ...call, daemonTurn: true } } : {}) } };
      } else if (call?.daemonTurn !== undefined) {
        const { daemonTurn: _forged, ...rest } = call;
        input = { ...input, context: { ...input.context, call: rest } };
      }
    }
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
      const admin = (context === undefined || context.admin === true) && principal.admin;
      context = {
        ...context, principalId: principal.principalId, principalKind: principal.principalKind,
        admin, scopes,
        ...(principal.credentialKind ? { credentialKind: principal.credentialKind } : {}),
        actor: this.callActor(principal, admin, scopes),
      };
    }
    // card.enter crosses only this machine, TLS or the tailnet: refused before any other check reads the body.
    if (descriptor.effects?.includes('card.enter') && !mayCrossWithCardDetails(authenticated?.transport)) {
      return { status: 403, ok: false, body: refusalBody(describeCardTransportRefusal(), 'CARD_ENTRY_TRANSPORT', 403) };
    }
    // A call the owner approved (in Waiting for you, or on the card their program put to them): the owner's approval is the
    // person's request for its own nested method that needs one, and that method's act is admitted as the owner's, for this
    // one call only (control-plane/owner-approved-call.ts). When the caller is not the owner and the act was the owner's, the
    // grant carries the owner's actor: this nested call is made with the owner's authority, never the caller's.
    const offered = input.ownerApproved;
    const granted = offered !== undefined && (offered.owner !== undefined || (context?.explicitUserRequest === true && ownerApprovalCovers(descriptor)))
      ? spendOwnerApprovalGrant(offered) : undefined;
    const ownerApproved = granted !== undefined;
    if (granted?.owner !== undefined) context = { ...context, actor: granted.owner, admin: true };
    else if (granted !== undefined && context?.actor?.agentFor !== undefined) context = { ...context, actor: context.actor.agentFor };
    const denied = this.validateGatewayInvocation(descriptor, context);
    if (denied) return denied;
    // The client frame asserts that a person asked for this call. Only a principal
    // the transport itself established as a person's (a login session, a paired
    // device, or an app on the daemon's own machine) can make that claim; the
    // operator token from elsewhere, the Agent's credential for the calls it
    // makes on the owner's behalf, a bot, service or peer cannot, so their claim
    // is dropped before any handler reads it. A literal false stays: it only restricts.
    // The operator token on this machine (`local`) is the user's whichever process holds it, with or without a program's
    // registration: its claim is kept as the released daemon kept it.
    const credential = authenticated?.credentialKind;
    if (context?.explicitUserRequest === true && !ownerApproved
      && (credential !== 'user-session' && credential !== 'device-token' && credential !== 'local')) {
      context = { ...context, explicitUserRequest: undefined };
    }
    // A model never makes what the effect table says no model causes (the acts v3.5.0 refused a model on this route:
    // granting or withdrawing access, a sign-in, a credential, a pairing, the permission rules, a card): refused for any
    // model in every mode, the user's own turn included, whatever its call was decided as or carries (a grant from the
    // user's yes included). Answers keep their own rule. Every other act a model asks for is decided by the permission mode.
    // Before anything else is decided (a first use, a project, the gate), so it is never put to anyone.
    if (!ANSWER_METHOD_IDS.has(descriptor.id) && this.modelBehind(input, authenticated)
      && ((descriptor.effects ?? []).some(modelNeverMakes) || this.namesPermissionSettings(descriptor.id, input.body))) {
      return { status: 403, ok: false, body: refusalBody(modelNeverWords(`${descriptor.title} (${descriptor.id})`), MODEL_NEVER, 403) };
    }
    // An act only the user makes (method-risk.ts `owner-act`; a write of the permission mode or rules): the user makes it from
    // any credential and the user's own model in the user's own turn under the mode; a guest, a peer and a model on someone
    // else's input are refused, in every mode, before anything is decided or put to anyone
    // (method-owner-decision.ts `makesOwnerOnlyAct`).
    if ((methodCallRisk(descriptor, input.body) === 'owner-act' || this.namesPermissionSettings(descriptor.id, input.body))
      && !makesOwnerOnlyAct({ actor: authenticated?.actor, credentialKind: credential ?? undefined,
        registration: input.context?.call?.registration, ownersOwnTurn: this.ownersOwnTurnCall(input, authenticated) })) {
      const area = methodCallRisk(descriptor, input.body) === 'owner-act' ? ownerOnlyMethodArea(descriptor.id) : 'permissions';
      return { status: 403, ok: false, body: refusalBody(ownerOnlyActWords(`${descriptor.title} (${descriptor.id})`, OWNER_ONLY_WHERE[area]), OWNER_ONLY_ACT, 403) };
    }
    // A first use this call needs (a project for the outside agent or an unverified program, one of the owner's shared
    // things) is decided together with the call, in one decision naming both (capability-owner-gate.ts `FirstUseCall`):
    // allowed, the call is not decided again below. One act, one decision.
    // A capability run is named by the capability it runs (its id), as the owner's card names it.
    const runsCapability = descriptor.id === CAPABILITY_RUN_METHOD && typeof (input.body as { id?: unknown } | null | undefined)?.id === 'string'
      ? String((input.body as { id: string }).id) : undefined;
    const firstUse: FirstUseCall = { label: runsCapability !== undefined ? `run ${runsCapability}` : `${descriptor.title} (${descriptor.id})`,
      risk: methodCallRisk(descriptor, input.body), covered: false };
    // The outside agent's own credential naming a project it was not given (daemon/outside-agent.ts): giving it that
    // project is decided under the owner's mode (under Ask me the call waits on the owner's answer); given, the call goes on.
    if (this.context.outsideAgentProject && authenticated?.principalId) {
      const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const folders = [record(input.body)?.['workingDirectory'], record(input.query)?.['workingDirectory'], input.context?.call?.project]
        .filter((folder): folder is string => typeof folder === 'string' && folder.trim() !== '').map((folder) => folder.trim());
      const outsideAgentProject = this.context.outsideAgentProject;
      const principalId = authenticated.principalId;
      const answer = folders.length > 0 ? await withFirstUseCall(firstUse, () => outsideAgentProject(principalId, [...new Set(folders)], input.signal)) : undefined;
      if (answer && !answer.ok) return { status: 403, ok: false, body: refusalBody(`Not done: ${answer.reason}. Nothing was read or changed.`, 'PROJECT_NOT_ALLOWED', 403) };
    }
    // A program this daemon cannot verify (another system, or no program socket) naming a folder it was not given: decided
    // the same way (daemon/unverified-programs.ts).
    if (this.context.unverifiedProgramProject && authenticated?.principalId) {
      const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const folders = [record(input.body)?.['workingDirectory'], record(input.query)?.['workingDirectory'], input.context?.call?.project]
        .filter((folder): folder is string => typeof folder === 'string' && folder.trim() !== '').map((folder) => folder.trim());
      const unverifiedProgramProject = this.context.unverifiedProgramProject;
      const asker = { principalId: authenticated.principalId, credentialKind: authenticated.credentialKind, registration: input.context?.call?.registration };
      const answer = folders.length > 0 ? await withFirstUseCall(firstUse, () => unverifiedProgramProject(asker, [...new Set(folders)], input.signal)) : undefined;
      if (answer && !answer.ok) return { status: 403, ok: false, body: refusalBody(`Not done: ${answer.reason}. Nothing was read or changed.`, 'PROJECT_NOT_ALLOWED', 403) };
    }
    // The project the caller named, checked once for every handler (workspace/caller-project.ts): refused before any
    // handler reads it; the handler sees only the checked project.
    const projectChecked = this.checkNamedProjects(input, authenticated);
    if (!projectChecked.ok) return { status: 403, ok: false, body: refusalBody(`Not done: ${projectChecked.reason}. Nothing was read or changed.`, 'PROJECT_NOT_ALLOWED', 403) };
    input = projectChecked.input;
    // Every other folder and file the call names, by the same rules the method catalog's `invoke` applies (it checks
    // again for a call that reaches a handler, and is what the daemon's own in-process calls pass): here before
    // anything else reads the call, so a call that will be refused is never put to the owner first, and a method served
    // only by its route is checked too (control-plane/caller-paths.ts).
    // No rules to read is never no check (caller-paths.ts `CALLER_RULES_ABSENT`): only the owner in person names a folder.
    const pathRules = this.context.gatewayMethods.pathRules?.() ?? CALLER_RULES_ABSENT;
    const pathRefusal = callerPathRefusal(descriptor, input.body, input.query,
      { ...(authenticated?.credentialKind ? { credentialKind: authenticated.credentialKind } : {}), ...(authenticated ? { principalId: authenticated.principalId } : {}),
        ...(authenticated?.actor ? { actor: authenticated.actor } : {}),
        ...(input.daemonTurn === true ? { clientKind: 'daemon-turn' } : {}),
        ...(input.context?.call ? { call: input.context.call } : {}) }, pathRules);
    if (pathRefusal !== undefined) return { status: 403, ok: false, body: refusalBody(`Not done: ${pathRefusal}. Nothing was read or changed.`, 'PROJECT_NOT_ALLOWED', 403) };
    // What the call names by id, by the one rule of what a caller may reach (control-plane/caller-reach.ts), here too
    // before anything is put to the owner, and for a method served only by its route; its list answers filtered below.
    const reachRules = this.context.gatewayMethods.reachRules?.() ?? CALLER_RULES_ABSENT;
    const reachContext = { ...(authenticated?.credentialKind ? { credentialKind: authenticated.credentialKind } : {}), ...(authenticated ? { principalId: authenticated.principalId } : {}),
      ...(authenticated?.actor ? { actor: authenticated.actor } : {}), ...(input.context?.call ? { call: input.context.call } : {}),
      ...(input.context?.clientKind ? { clientKind: input.context.clientKind } : {}) };
    const reachRefusal = await callerReachRefusal(descriptor.id, input.body, input.query, reachContext, reachRules);
    if (reachRefusal !== undefined) return { status: 403, ok: false, body: refusalBody(`Not done: ${reachRefusal}. Nothing was read or changed.`, RECORD_NOT_YOURS, 403) };
    const reachable = async (answer: unknown): Promise<unknown> => reachableAnswer(descriptor.id, answer, reachContext, reachRules, input.body);
    // The owner's shared things (their mail, calendar, channels, knowledge, money, profile, dates, home, notifications):
    // theirs, their programs' and their own turns'; anyone else's only with the owner's gift of that kind, its first use decided under
    // the owner's mode (control-plane/shared-kinds.ts). Before anything else is decided or run.
    // A public or peer method (an inbound webhook a provider signs, a peer's own call) is admitted by its own proof.
    const shared = descriptor.access === 'public' || descriptor.access === 'remote-peer' ? { ok: true as const }
      : await withFirstUseCall(firstUse, () => sharedKindAdmission(this.context.sharedKind ?? daemonSharedKindRule(), descriptor.id, input.body,
        { ...reachContext, ...(context?.actor ? { actor: context.actor } : {}), ...(input.daemonTurn === true ? { daemonTurn: true } : {}) }, input.signal));
    if (!shared.ok) return { status: 403, ok: false, body: refusalBody(`Not done: ${shared.reason}. Nothing was read or changed.`, SHARED_KIND_NOT_GIVEN, 403) };
    // The owner's own Agent program, by who it is: its credential with the registration the daemon issued the Agent
    // process it verified, or a turn the daemon hosts (method-owner-decision.ts `ownersAgentProgram`). The credential
    // alone is a script whoever minted it, and what it says decided its call decides nothing.
    const agentProgram = ownersAgentProgram({ actor: context?.actor, credentialKind: credential ?? undefined,
      registration: input.context?.call?.registration, daemonHosted: input.context?.call?.daemonHosted === true });
    // A run's own answerer decided this call: kept only from the owner's own Agent program (see GatewayMethodCallInput).
    const decidedInRun = input.context?.decidedInRun === true && agentProgram;
    // The program's capability gate decided this call: kept only from the owner's own Agent program.
    const decidedByCapabilityGate = input.context?.decidedByCapabilityGate === true && agentProgram;
    // The Agent's credential is made only for the owner in person (method-owner-decision.ts `mintsAgentCredential`):
    // anyone else asking is refused here, before anything is put to the owner, since no yes of the owner's makes it the asker's.
    const agentCredentialMint = descriptor.id === 'pairing.tokens.create' && input.body !== null && typeof input.body === 'object'
      && (input.body as Record<string, unknown>)['client'] === 'agent';
    if (agentCredentialMint && !mintsAgentCredential({ actor: context?.actor, credentialKind: credential ?? undefined,
      registration: input.context?.call?.registration, daemonHosted: input.context?.call?.daemonHosted === true })) {
      return { status: 403, ok: false, body: refusalBody(AGENT_CREDENTIAL_OWNER_ONLY_WORDS, 'OWNER_ONLY', 403) };
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
    // The method's risk class, decided as the capability that does the same act would be (method-owner-decision.ts):
    // anyone but the owner's own program with a person's press is handed to the daemon's gate, through `capabilities.run`,
    // which decides it under the owner's mode and runs the call as it came when allowed. Decided here only,
    // once: a call nested in a decided capability, one the owner approved, or one the program's gate decided is not.
    // Who made the capability's act this call is nested in, and how it was decided (read before the mark is spent).
    const upstreamAct = decidedMarkAct(input.decidedUpstream);
    const upstreamCovers = decidedMarkCovers(input.decidedUpstream);
    const spentUpstream = spendCapabilityDecidedMark(input.decidedUpstream);
    // The owner's own terminal program (its registration checked by the router, daemon/program-registrations.ts, on a
    // credential that is the owner's and keeps a person's claim) says its gate decided this call: one decision, the program's.
    const callerFacts = { actor: context?.actor, credentialKind: credential, registration: input.context?.call?.registration, personAsked: context?.explicitUserRequest === true,
      daemonHosted: input.context?.call?.daemonHosted === true };
    // (Any credential of the user: a registration decides nothing, so the program's mark counts with or without one.)
    const ownProgramGate = input.context?.decidedByCapabilityGate === true && ownerHimself(callerFacts);
    const callRisk = methodCallRisk(descriptor, input.body);
    // The capability's decision stands for its nested method only as far as it went: the owner's own press, their yes, or
    // a decision that covered this method's class. A stricter class it did not cover (a setting write admitted under the
    // rules that stores a credential through credentials.set) is decided here, by the method's own class.
    const decidedUpstream = spentUpstream && (callRisk === 'none' || upstreamCovers === undefined
      || upstreamAct?.how === 'press' || upstreamAct?.how === 'yes' || upstreamAct?.how === 'carried' || upstreamCovers.has(callRisk));
    // A call with no actor the daemon built (a method reached without a verified principal, or one whose actor is
    // malformed) is never admitted at once, never put to the owner as someone's ask, and never answers: refused.
    if ((callRisk !== 'none' || ANSWER_METHOD_IDS.has(descriptor.id)) && !ownerApproved && !decidedUpstream && !wellFormedActor(context?.actor)) {
      return { status: 403, ok: false, body: refusalBody(`${descriptor.id} was not run: the daemon could not name who is calling, and an act the owner decides is never made by nobody. Nothing was changed.`, 'OWNER_ONLY', 403) };
    }
    // Its first use, decided just now together with it (above), decided it: not decided again.
    const decidedWithFirstUse = firstUse.covered && firstUse.risk === callRisk;
    const putToOwner = methodCallPutToOwner({
      ...callerFacts, methodId: descriptor.id, risk: callRisk, ownerApproved, decidedUpstream: decidedUpstream || decidedWithFirstUse, decidedInRun,
      decidedByProgramGate: decidedByCapabilityGate || ownProgramGate, agentCredentialMint,
    });
    // A method whose class depends on its value is told whether the rule admits this caller at once; when its handler
    // finds the value is the owner's to decide for a caller it does not admit, the same call comes back here held.
    const ownerAdmitted = ownerApproved || decidedUpstream || decidedWithFirstUse || decidedInRun || decidedByCapabilityGate || ownProgramGate
      || callerAdmitted(callerFacts, callRisk === 'none' ? 'loosens-a-protection' : callRisk);
    // Answering a question addressed to the owner is never itself a question: the owner's own press or sign-in answers at
    // once, anyone else is refused outright (method-owner-decision.ts `ownerAnswers`).
    // Nested in a capability run, it answers only when that run's caller was admitted as the owner answering (or it ran
    // on the owner's own press or yes): a run decided any other way (under the mode, by a program's gate) answers nothing.
    const upstreamAnswered = spentUpstream && nestedAnswerAdmitted({ covers: upstreamCovers, how: upstreamAct?.how });
    // The owner's own device answers an approval some other caller raised: its answer goes on to the approval route,
    // whose viewer refuses a question it, or a credential made from it, raised (approval-actions.ts). Nothing else.
    const deviceAnswering = ownersDevice(callerFacts) && OWNER_DEVICE_ANSWER_METHOD_IDS.has(descriptor.id);
    if (ANSWER_METHOD_IDS.has(descriptor.id) && !ownerApproved && !deviceAnswering && !ownerAnswers(callerFacts, { decidedInRun, decidedUpstream: upstreamAnswered })) {
      return { status: 403, ok: false, body: refusalBody(OWNER_ANSWERS_ONLY_WORDS, OWNER_ANSWERS_ONLY, 403) };
    }
    const heldMethod =putToOwner === undefined && input.ownerDecisionNeeded !== true ? undefined : { id: descriptor.id, body: input.body ?? {}, query: input.query ?? {} };
    if (heldMethod && !this.context.gatewayMethods.hasHandler(CAPABILITY_RUN_METHOD)) {
      return { status: 403, ok: false, body: refusalBody(`${descriptor.id} was not run: it ${METHOD_RISK_WORDS[putToOwner ?? (callRisk === 'none' ? 'owner-act' : callRisk)]}, so it is the owner's to decide, and this daemon has no way to ask the owner. Nothing was changed.`, 'OWNER_ONLY', 403) };
    }
    // A fresh owner request resets the untrusted-content window; automated
    // work deliberately does not. It runs only once the call is known, the
    // principal is current and its scopes allow it, so a refused or malformed
    // frame cannot clear what strangers' content left behind. See security/turn-boundary.ts.
    // The approved call is still the caller's work: it does not start a new turn for the owner.
    startTurnForOwnerRequest(ownerApproved ? undefined : context?.explicitUserRequest);
    const caller = callerKey(input.context?.connectionId, context?.principalId ?? authenticated?.principalId);
    // Whose call this is, from the authenticated caller (never a field): what it makes that runs later (a schedule, a
    // trigger) keeps it, and those runs are that caller's turn (method-owner-decision.ts `partyOfCaller`). A turn's
    // nested call keeps its turn's party; `capabilities.run` marks its own run by who caused it (routes/capabilities.ts).
    const callParty = heldMethod || descriptor.id === CAPABILITY_RUN_METHOD || input.daemonTurn === true ? undefined
      : partyOfCaller({ actor: granted?.owner !== undefined ? authenticated?.actor : context?.actor, credentialKind: authenticated?.credentialKind ?? undefined,
        registration: input.context?.call?.registration, daemonHosted: input.context?.call?.daemonHosted === true,
        principalId: authenticated?.principalId, othersInput: input.context?.call?.othersInput === true });
    // And every step of it that reads the owner's mode or rules does so for the project the call names (checked above:
    // permissions/call-project.ts `decideInProject`; permissions/owner-is-asked.ts), never the daemon's own settings alone.
    const callProject = input.context?.call?.project;
    const asCaller = <T>(fn: () => T): T => decideInProject(callProject, () => callParty ? asCallOutsideTurn(fn, callParty) : fn());

    if (heldMethod || this.context.gatewayMethods.hasHandler(input.methodId)) {
      // ONE contract: no call arm is unbounded. The registered-handler branch
      // shares the in-flight budget of the direct http-dispatch path: each
      // in-flight invocation retains its auth token + client-controlled frame
      // body for the handler's full latency (probed: 5,000 concurrent handler
      // invocations, invisible to wsCallStats, before this guard).
      const refused = this.admitCall(caller);
      if (refused) return refused;
      try {
        // A call handed to the gate goes to `capabilities.run` as that method call (in process only: the handler reads
        // `methodCall` from metadata the dispatch builds, never from a body), which decides it once.
        const body = await asCaller(() => this.context.gatewayMethods.invoke(heldMethod ? CAPABILITY_RUN_METHOD : input.methodId, {
          body: heldMethod ? {} : input.body,
          query: heldMethod ? undefined : input.query,
          signal: input.signal,
          // A plain field, not built on first read: handlers refuse invocation
          // fields that are accessors. For anything but a paired device's token
          // or the local credential it is a prefix test and null.
          nativeExecutionAuthority: this.createNativeExecutionAuthority(input.authToken, context?.scopes ?? [], authenticated?.credentialKind,
            ownersOwnSession({ actor: authenticated?.actor, credentialKind: authenticated?.credentialKind ?? undefined }),
            // Native authority goes by the kind of credential, as released (the `local` credential: this machine's own; a
            // pairing token: its own, while still current; a sign-in: this machine's, as the user's own). It is not asked
            // who the caller is: every credential of the user holds what its kind holds.
            true) ?? undefined,
          isAuthorized: this.retainGatewayAuthorization(input.authToken, descriptor, context, ownerApproved),
          context: {
            authToken: input.authToken,
            principalId: context?.principalId,
            principalKind: context?.principalKind,
            admin: context?.admin,
            scopes: context?.scopes,
            clientKind: context?.clientKind,
            ...(authenticated?.credentialKind ? { credentialKind: authenticated.credentialKind } : {}),
            // How the request reached the listener, from the principal the listener authenticated; never from the caller.
            ...(authenticated?.transport ? { transport: authenticated.transport } : {}),
            ...(context?.actor ? { actor: context.actor } : {}),
            // The project and conversation the calling program named (call-context.ts), for the handler to act in.
            ...(input.context?.call ? { call: input.context.call } : {}),
            ...(context?.explicitUserRequest === undefined && !decidedInRun && !decidedByCapabilityGate && !heldMethod && !VALUE_DECIDED_METHOD_IDS.has(descriptor.id)
              && !SETTING_WRITE_METHOD_IDS.has(descriptor.id) && !CREDENTIAL_MINT_METHOD_IDS.has(descriptor.id) && !(runsCapability !== undefined && firstUse.covered)
              ? {}
              : { metadata: {
                // The capability run's first use was decided together with it, just now: one act, one decision; the
                // capability route does not decide it again (routes/capabilities.ts). In process only; never from a body.
                ...(runsCapability !== undefined && firstUse.covered && !heldMethod ? { decidedWithFirstUse: true } : {}),
                // Who makes a credential, recorded with it (pairing-token-store.ts `PairingMaker`): the owner in person, or
                // the caller it was put to the owner for, on the owner's yes. In process only; never from a body.
                ...(!heldMethod && CREDENTIAL_MINT_METHOD_IDS.has(descriptor.id) ? { credentialMaker: credentialMakerOf(authenticated, callerFacts, ownerApproved) } : {}),
                ...(context?.explicitUserRequest === undefined ? {} : { explicitUserRequest: context.explicitUserRequest }),
                ...(decidedInRun ? { decidedInRun: true } : {}),
                ...(decidedByCapabilityGate ? { decidedByCapabilityGate: true } : {}),
                ...(heldMethod ? { methodCall: heldMethod } : {}),
                // Whether the one rule admits this caller at once (method-owner-decision.ts `callerAdmitted`).
                ...(VALUE_DECIDED_METHOD_IDS.has(descriptor.id) ? { ownerAdmitted } : {}),
                // A credential write keeps who made it and how it was decided (in process only; never from a body).
                ...(!heldMethod && SETTING_WRITE_METHOD_IDS.has(descriptor.id) ? { settingAct: this.settingActOf(input.authToken, context, upstreamAct, ownerApproved, ownerHimself(callerFacts)) } : {}),
              } }),
          },
        }));
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
          return { status: body.status, ok: body.ok, body: body.ok ? await reachable(responseBody) : responseBody };
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
          // A refusal error carries its own state, next steps and, for a target
          // that changed since it was reviewed, the change list: all of it goes
          // on the wire, so an agent reads what changed without parsing prose.
          const own = (error as { readonly refusal?: unknown }).refusal;
          return {
            status: refusal.status,
            ok: false,
            body: isRefusal(own) ? refusalErrorBody(own) : refusalBody(refusal.message, refusal.code, refusal.status),
          };
        }
        // A read of a project whose folder cannot be reached now (a disk not mounted, a parent renamed) is not the daemon's
        // fault: a sentence a person understands and a 503, the same for every method that reads that project's records.
        const unreachable = unreachableFolderWords(error, (input.body as Record<string, unknown> | undefined)?.['workingDirectory']);
        if (unreachable !== undefined) return { status: 503, ok: false, body: refusalBody(unreachable, PROJECT_FOLDER_NOT_REACHABLE, 503) };
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
    // A GET or DELETE route reads its inputs from the query: a call by method id that sends them in its body (as every
    // method call does) has its plain fields carried there, the query's own winning, so nothing it named is dropped
    // (a planning read's project, checked above as the body's `workingDirectory`).
    const bodyless = descriptor.http.method === 'GET' || descriptor.http.method === 'DELETE';
    const bodyFields = bodyless && input.body !== null && typeof input.body === 'object' && !Array.isArray(input.body)
      ? Object.fromEntries(Object.entries(input.body as Record<string, unknown>).filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
      : {};
    const served = await asCaller(() => this.invokeWebSocketControlPlaneCall({
      authToken: input.authToken,
      signal: input.signal,
      method: descriptor.http.method,
      path: resolvedPath.path,
      query: { ...bodyFields, ...(input.query ?? {}) } as GatewayMethodCallInput['query'],
      caller,
      body: descriptor.http.method === 'GET' || descriptor.http.method === 'DELETE' ? undefined : input.body,
      context: {
        principalKind: context?.principalKind,
        admin: context?.admin,
        scopes: context?.scopes,
        // The route this synthesizes is admitted for the same actor the call was.
        actor: context?.actor,
      },
      ...(authenticated ? { principal: authenticated } : {}),
      // The route reads these from its request as it would from a direct one: the program's label, the claim dispatch
      // kept (dropped above for any credential that cannot make it), and the call context.
      headers: {
        ...(context?.clientKind === 'tui' || context?.clientKind === 'agent' ? { 'x-goodvibes-client': context.clientKind } : {}),
        ...(context?.explicitUserRequest === true ? { 'x-goodvibes-explicit-user-request': 'true' } : {}),
        ...(input.context?.call?.project ? { 'x-goodvibes-project': encodeURIComponent(input.context.call.project) } : {}),
        ...(input.context?.call?.sessionId ? { 'x-goodvibes-session': encodeURIComponent(input.context.call.sessionId) } : {}),
      },
      // Which program of the caller asked, as the router checked its registration: bound to the request in process, never
      // a header (a conversation it registers is its own).
      ...(input.context?.call?.registration ? { registration: input.context.call.registration } : {}),
      // A route whose class depends on its value is told whether the one rule admits this caller at once.
      ...(VALUE_DECIDED_METHOD_IDS.has(descriptor.id) && ownerAdmitted ? { ownerAdmitted: true as const } : {}),
      // A settings write keeps who made it and how it was decided (a machine group carries the record to every member).
      ...(SETTING_WRITE_METHOD_IDS.has(descriptor.id) ? { settingAct: this.settingActOf(input.authToken, context, upstreamAct, ownerApproved, ownerHimself(callerFacts)) } : {}),
      // Decided above (method-owner-decision.ts): the route serves it without deciding it again.
      decided: true,
    }));
    // A list or a search the route answered: what the caller may reach of it (control-plane/caller-reach.ts).
    return served.ok ? { ...served, body: await reachable(served.body) } : served;
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

/**
 * The `?domains=` list of an upgrade: the known domains, and the names that are
 * not domains (named back in the `ready` frame). A list naming no known domain
 * at all is refused, the same rule the SSE stream follows.
 */
function parseRuntimeDomains(rawDomains: string | null): { readonly domains: RuntimeEventDomain[]; readonly unrecognised: string[] } | Response {
  if (!rawDomains) return { domains: [], unrecognised: [] };
  const requested = readRequestedDomains(rawDomains.split(','));
  if (requested.unrecognised.length > 0 && requested.domains.length === 0) {
    return Response.json({
      error: `No runtime event domain is named ${requested.unrecognised.join(', ')}.`,
      code: 'UNKNOWN_EVENT_DOMAIN',
      invalid: requested.unrecognised,
      unrecognisedDomains: requested.unrecognised,
      next: [`Connect with domains from: ${RUNTIME_EVENT_DOMAINS.join(', ')}.`],
    }, { status: 400 });
  }
  return requested;
}

/**
 * A socket frame's `domains`, read by the same rule as the upgrade's
 * `?domains=` (a non-string entry is no domain name). Undefined when the frame
 * carries no list.
 */
function readFrameDomains(value: unknown): { readonly domains: RuntimeEventDomain[]; readonly unrecognised: string[] } | undefined {
  if (!Array.isArray(value)) return undefined;
  return readRequestedDomains(value.map((entry: unknown) => (typeof entry === 'string' ? entry : String(entry))));
}

/** The refusal of a domain list in which no name is a runtime event domain. */
function unknownDomainsRefusal(unrecognised: readonly string[]): Record<string, unknown> {
  return {
    error: `No runtime event domain is named ${unrecognised.join(', ')}.`,
    code: 'UNKNOWN_EVENT_DOMAIN',
    category: 'bad_request',
    unrecognisedDomains: unrecognised,
    next: [`Use domains from: ${RUNTIME_EVENT_DOMAINS.join(', ')}.`],
  };
}


