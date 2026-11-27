import type { DaemonControlRouteHandlers, GatewayRestVerbInvocation } from './context.js';
import type { RuntimeEventDomain } from '@goodvibes/engine/contracts';
import { EngineErrorCodes, isOperationKey, OPERATION_KEY_RULE } from '@goodvibes/engine/errors';
import { authenticationRequiredResponse, jsonErrorResponse } from './error-response.js';
import { GATEWAY_METHOD_INVOKE_PATH } from './operator.js';
import type { AuthenticatedPrincipal, CredentialKind, RequestPrincipal } from './http-policy.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  serializableJsonResponse,
  type JsonRecord,
} from './route-helpers.js';

interface GatewayMethodDescriptorLike {
  readonly id: string;
  readonly access?: 'public' | 'authenticated' | 'admin' | 'remote-peer' | undefined;
  readonly http?: { readonly method: string; readonly path: string } | undefined;
}

interface GatewayMethodCatalogLike {
  list(options?: Record<string, unknown>): unknown;
  listEvents(options?: Record<string, unknown>): unknown;
  get(methodId: string): GatewayMethodDescriptorLike | null | undefined;
  /** The method whose `http` binding serves this method and path, the most specific one when several do. */
  findByHttpBinding(method: string, pathname: string): GatewayMethodDescriptorLike | null | undefined;
  hasHandler(methodId: string): boolean;
}

/** Who reads the gateway's kept events, as a stream names its caller (platform control-plane/event-reach.ts). */
interface EventReaderLike {
  readonly credentialKind?: RequestPrincipal['credentialKind'] | undefined;
  readonly principalId?: string | undefined;
  readonly actor?: RequestPrincipal['actor'] | undefined;
  readonly call?: CallContextHeaders | undefined;
}

interface ControlPlaneGatewayLike {
  getSnapshot(reader?: EventReaderLike): unknown;
  renderWebUi(): Response;
  listRecentEvents(limit: number, reader?: EventReaderLike): unknown;
  listSurfaceMessages(limit?: number, reader?: EventReaderLike): unknown;
  listClients(): unknown;
  createEventStream(
    req: Request,
    input: Record<string, unknown>,
  ): Response | Promise<Response>;
}

export interface ControlRouteContext {
  readonly authToken: string | null;
  /**
   * The PLATFORM build this daemon is composed from, the platform's own version.
   *
   * It is not the version of the product a person installed, and it used to be
   * the only thing /status reported. A daemon shipped from its own repository
   * on its own release line answered every version read with the platform version
   * it happened to be built against, so an updater comparing release tags and a
   * client checking whether the daemon was new enough were both reading a
   * number about a different artifact. See {@link buildVersion}.
   */
  readonly version: string;
  /**
   * The RUNNING ARTIFACT's own release version, when the host stated one
   * (`updateArtifact.version`, the same value the auto-update loop compares
   * against release tags). Absent on an embedded daemon that ships no artifact
   * of its own, where the platform build is the only version there is.
   */
  readonly buildVersion?: (() => string | null) | undefined;
  readonly sessionCookieName: string;
  readonly controlPlaneGateway: ControlPlaneGatewayLike;
  readonly extractAuthToken: (req: Request) => string;
  /** `expiresAt`: when a sign-in session ends unless it is used again (the daemon extends it on use). */
  readonly resolveAuthenticatedPrincipal: (req: Request) => RequestPrincipal | null;
  /** Whether the request is the owner himself (the one definition: platform daemon/method-owner-decision.ts `ownerHimself`). */
  readonly ownerHimself?: ((req: Request) => boolean) | undefined;
  readonly gatewayMethods: GatewayMethodCatalogLike;
  readonly getOperatorContract: () => unknown;
  readonly invokeGatewayMethodCall: (input: {
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
      /** Self-asserted by the caller through {@link EXPLICIT_USER_REQUEST_HEADER}; a consumer that acts on it must not treat it as proof a person asked. */
      readonly explicitUserRequest?: boolean | undefined;
      /**
       * Self-asserted through {@link DECIDED_IN_RUN_HEADER}: the sending run's own answerer (its script) decided this
       * natively admitted call. The dispatch keeps it only for the Agent's credential, the credential whose calls the
       * daemon already takes as decided by the program's gate.
       */
      readonly decidedInRun?: boolean | undefined;
      /**
       * Self-asserted through {@link CAPABILITY_GATE_DECIDED_HEADER}: the program's capability gate (`capability_run`)
       * decided this `capabilities.run` call by the capability's own risk. The dispatch keeps it only for the Agent's
       * credential; without it, a call with that credential is decided by the daemon as any outside caller's.
       */
      readonly decidedByCapabilityGate?: boolean | undefined;
      /**
       * The call context the calling program set once and sends with every request (`x-goodvibes-project`,
       * `x-goodvibes-session`; the program is `clientKind`): the project folder the call acts in and the conversation it
       * came from. Self-asserted like the program: it names where a call acts, never who may make it.
       */
      readonly call?: CallContextHeaders | undefined;
    };
    /**
     * The principal the request was authenticated as where it entered,
     * credential kind included, so the dispatch does not authenticate the
     * token again and handlers read who called from it.
     */
    readonly principal?: RequestPrincipal | undefined;
    /** The caller's retry key, for a method that takes the shared Idempotency-Key. */
    readonly idempotencyKey?: string | undefined;
  }) => Promise<{ status: number; ok: boolean; body: unknown; readonly replayed?: boolean }>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly login?: ((req: Request) => Promise<Response> | Response) | undefined;
  /**
   * Undelivered daemon receipts ("updated from X to Y at 2026-11-15 03:12",
   * "restarted after a crash at ..."), left undelivered. Returned only to a
   * /status reader that opts in with `?receipts=peek`, so a reader whose
   * response is lost can ask again; the reader names what it showed with
   * `?receipts=ack&ids=<id>,<id>` ({@link acknowledgeReceipts}). A plain
   * /status read (identity probe, keepalive, version poll) never touches them.
   * `owner` says whether the reader is the owner (actor class `owner`): a
   * receipt kept for the owner alone is neither shown to nor taken by anyone else.
   */
  readonly peekReceipts?: ((owner: boolean) => readonly { id: string; text: string; at: number }[]) | undefined;
  readonly acknowledgeReceipts?: ((ids: readonly string[], owner: boolean) => void) | undefined;
  /**
   * Which node on the local network currently consumes inbound channel
   * messages, and how it got there.
   *
   * Inspection ONLY, and unconditional on every /status read (unlike receipts,
   * reading it consumes nothing). Leader election is otherwise invisible by
   * design: it produces no notification, no transcript line and no message on
   * any surface, so a `/status` read is the one place an operator can see who
   * holds the role. Absent on a host with no coordinator.
   */
  readonly collectClusterStatus?: (() => unknown) | undefined;
  /**
   * The minimum CLIENT build this daemon accepts as a full participant,
   * announced on /status as a response header (the body has a closed schema,
   * and a header is additive and ignorable by older clients).
   *
   * A daemon update does not restart the clients attached to it, so without
   * this a process started days ago keeps executing shared-session work under
   * whatever rules its build shipped with. Supplying it lets every client
   * check itself on the liveness probe it already performs.
   */
  readonly clientCompatibilityFloor?: string | undefined;
  /** Header name carrying {@link clientCompatibilityFloor}. */
  readonly clientCompatibilityFloorHeader?: string | undefined;
}

type GatewayInvokeBody = {
  readonly query?: Record<string, unknown> | undefined;
  readonly body?: unknown | undefined;
};

const controlBodySchemas = createRouteBodySchemaRegistry({
  gatewayInvoke: createRouteBodySchema<GatewayInvokeBody>(`POST ${GATEWAY_METHOD_INVOKE_PATH}`, (body) => {
    const query = body.query && typeof body.query === 'object' && !Array.isArray(body.query)
      ? body.query as Record<string, unknown>
      : undefined;
    if (!Object.hasOwn(body, 'body')) {
      return jsonErrorResponse(
        { error: 'Missing required field: body. Expected envelope shape: { query?, body }' },
        { status: 400 },
      );
    }
    return {
      ...(query ? { query } : {}),
      body: body.body,
    };
  }),
});


/**
 * The HTTP form of "a person asked for this right now".
 *
 * A header rather than a body field, so it applies uniformly to the
 * GET-shaped REST verbs and the POST invoke envelope without either schema
 * having to carry it. Only the literal `true` counts: absent, malformed, or
 * anything else means the caller cannot claim it, which is the honest default
 * for scheduled work, triggers and channel-driven calls.
 */
export const EXPLICIT_USER_REQUEST_HEADER = 'x-goodvibes-explicit-user-request';

/** A run whose script answers every question decided this natively admitted call itself (terminal-shell run-answerer). */
export const DECIDED_IN_RUN_HEADER = 'x-goodvibes-decided-in-run';

/**
 * Whether a request's "already decided" headers are read at all: only from a verified registered program (the daemon
 * checked the registration it sent, `bindProgramRegistration`) or a request the daemon served to itself in process
 * (`bindDaemonHosted`). From anyone else (a script with the operator token, the Agent's credential without its program,
 * another machine, a device) they are not read: what such a caller says decided its call decides nothing.
 */
function decisionClaimsHeard(req: Request): boolean {
  return checkedRegistrations.has(req) || daemonHostedRequests.has(req);
}

function readDecidedInRun(req: Request): boolean {
  return decisionClaimsHeard(req) && req.headers.get(DECIDED_IN_RUN_HEADER)?.trim().toLowerCase() === 'true';
}

/** The program's capability gate (`capability_run`) decided this `capabilities.run` call (terminal-shell capability-tools.ts). */
export const CAPABILITY_GATE_DECIDED_HEADER = 'x-goodvibes-decided-by-capability-gate';

function readCapabilityGateDecided(req: Request): boolean {
  return decisionClaimsHeard(req) && req.headers.get(CAPABILITY_GATE_DECIDED_HEADER)?.trim().toLowerCase() === 'true';
}

/**
 * What a request itself says decided it, for a route module that decides by the one rule without going through the
 * dispatch (the settings write's precondition lane): the person's claim, and the program's gate's mark. Each counts
 * only with the credential and checked registration the rule asks for (daemon/method-owner-decision.ts).
 */
export function readRequestClaims(req: Request): { readonly personAsked: boolean; readonly decidedByProgramGate: boolean } {
  return { personAsked: req.headers.get(EXPLICIT_USER_REQUEST_HEADER)?.trim().toLowerCase() === 'true', decidedByProgramGate: readCapabilityGateDecided(req) };
}

/**
 * The credential a resolved principal was authenticated with. The daemon's
 * resolver hands back the request principal, which carries it; a resolver
 * that does not (an embedding host's own) reports none rather than a guess.
 */
function credentialOf(principal: AuthenticatedPrincipal): CredentialKind | null {
  const kind = (principal as { readonly credentialKind?: unknown }).credentialKind;
  return kind === 'local' || kind === 'shared-token' || kind === 'device-token' || kind === 'agent' || kind === 'user-session' ? kind : null;
}

/**
 * The header a terminal app names itself in, so what it does is attributed to
 * it (an inbox answer given in the TUI says tui). A label only: it grants
 * nothing, and anything else, or nothing, reads as the web.
 */
const CLIENT_SURFACE_HEADER = 'x-goodvibes-client';
// `cli`: `do` and `find` on a program's command line (capabilities/command-line-hold.ts): a label that only takes
// authority away (a call that weakens a protection is held for the owner), never gives any.
const NAMED_CLIENT_SURFACES: ReadonlySet<string> = new Set(['tui', 'agent', 'cli']);

function readClientSurface(req: Request): string {
  const raw = req.headers.get(CLIENT_SURFACE_HEADER)?.trim().toLowerCase();
  return raw !== undefined && NAMED_CLIENT_SURFACES.has(raw) ? raw : 'web';
}

/** The project folder a program's call acts in (URI-encoded), set once by the program (runtime/client/call-context.ts). */
export const CALL_PROJECT_HEADER = 'x-goodvibes-project';
/** The conversation a program's call came from (URI-encoded). */
export const CALL_SESSION_HEADER = 'x-goodvibes-session';

/**
 * The header a terminal program sends the registration the daemon issued it in (`programs.register`,
 * platform daemon/program-registrations.ts): a secret, sent as proof, checked by the daemon's router against the
 * request's own principal and credential kind. Never logged, never read back into anything a caller sees.
 */
export const CALL_PROGRAM_KEY_HEADER = 'x-goodvibes-program-key';

/** The call context a request names in its headers: its project folder and its session, each only when given. */
export interface CallContextHeaders {
  readonly project?: string | undefined;
  readonly sessionId?: string | undefined;
  /**
   * Which program of the principal asks (`tui` or `agent`), only when the daemon checked the registration it sent
   * (`bindProgramRegistration`), so the terminal app, the Agent, a command line and a script holding one operator token
   * are told apart. Undefined: none, or one that is not this caller's.
   */
  readonly registration?: string | undefined;
  /**
   * The registered program's process on this machine (`<pid>:<start>`), as the daemon read it when it issued the
   * registration; bound with it in process, never from a header. A question the program raises is held while it runs.
   */
  readonly process?: string | undefined;
  /**
   * The daemon served this request to itself, in process (a turn it hosts calling its own request path), as its router
   * bound it (`bindDaemonHosted`); never from a header.
   */
  readonly daemonHosted?: true | undefined;
  /**
   * What the calling program's own conversation read from outside, as it says (`x-goodvibes-read-outside`, encoded
   * `<surface>=<origin>` pairs, platform security/conversation-exposure.ts `decodeCarriedExposure`). Self-asserted, and
   * it only tightens: the daemon decides the call as for its own turn after such a read; absent, nothing is cleared.
   */
  readonly readOutside?: string | undefined;
}

/** The header a program's call says its conversation read text from outside with (see CallContextHeaders.readOutside). */
export const CALL_READ_OUTSIDE_HEADER = 'x-goodvibes-read-outside';

/** The checked registration of each request, bound in process by the daemon (its router, or a route it synthesizes). */
const checkedRegistrations = new WeakMap<Request, string>();

/** Requests the daemon served to itself in process, bound by its router. */
const daemonHostedRequests = new WeakSet<Request>();

/** Bind that the daemon serves this request to itself, in process (the daemon's router only). */
export function bindDaemonHosted(req: Request): void {
  daemonHostedRequests.add(req);
}

/** Whether the daemon's router bound this request as one the daemon serves to itself in process. */
export function readDaemonHosted(req: Request): boolean {
  return daemonHostedRequests.has(req);
}

/** The process of each request's checked registration, bound in process by the daemon's router. */
const checkedProcesses = new WeakMap<Request, string>();

/** Bind the process the request's checked registration was issued to (the daemon's router only). */
export function bindProgramProcess(req: Request, process: string | undefined): void {
  if (process) checkedProcesses.set(req, process);
}

/**
 * Bind the program a request's registration names, as the daemon checked it (the router for a request from the
 * network, the dispatch for a route it synthesizes): in process only; no header carries it.
 */
export function bindProgramRegistration(req: Request, registration: string | undefined): void {
  if (registration) checkedRegistrations.set(req, registration);
}

/** Requests the daemon's dispatch made for a caller the one owner rule admits at once (bound in process). */
const ownerAdmittedRequests = new WeakSet<Request>();

/** Mark a request the dispatch synthesized for a caller the one owner rule admits at once (platform method-owner-decision.ts). */
export function bindOwnerAdmitted(req: Request): void {
  ownerAdmittedRequests.add(req);
}

/**
 * Whether the one owner rule admits this request's caller at once, for a route whose class depends on the value it
 * carries (a settings write that loosens). Only the daemon's dispatch marks a request; every other is not admitted.
 */
export function readOwnerAdmitted(req: Request): boolean {
  return ownerAdmittedRequests.has(req);
}

/** Who made a settings write and how it was decided, bound per request by the dispatch (setting-act.ts). */
export { bindSettingAct, readSettingAct, type SettingAct } from './setting-act.js';

/**
 * The program a request's checked registration names, or undefined. Only what the daemon bound counts: a header naming
 * a program or a fingerprint is never read. It tells holders of one credential apart; it never grants anything itself.
 */
export function readProgramRegistration(req: Request): string | undefined {
  return checkedRegistrations.get(req);
}

/**
 * Who registered or asks, as a session and a question keep it: the principal, and the program of that principal when
 * it sent its registration (`<principal>#<registration>`).
 */
export function registrantKeyOf(principalId: string, registration: string | undefined): string {
  return registration ? `${principalId}#${registration}` : principalId;
}

function decodedHeader(req: Request, name: string): string | undefined {
  const raw = req.headers.get(name)?.trim();
  if (!raw) return undefined;
  try {
    const value = decodeURIComponent(raw).trim();
    return value.length > 0 && value.length <= 4096 && !value.includes('\0') ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The call context of a request: the project only as an absolute folder, the session as given. */
export function readCallContext(req: Request): CallContextHeaders | undefined {
  const project = decodedHeader(req, CALL_PROJECT_HEADER);
  const sessionId = decodedHeader(req, CALL_SESSION_HEADER);
  const registration = readProgramRegistration(req);
  const process = registration ? checkedProcesses.get(req) : undefined;
  const absolute = project !== undefined && (project.startsWith('/') || /^[A-Za-z]:[\\/]/.test(project)) ? project : undefined;
  const daemonHosted = daemonHostedRequests.has(req);
  const rawRead = req.headers.get(CALL_READ_OUTSIDE_HEADER)?.trim();
  const readOutside = rawRead && rawRead.length <= 8192 && !rawRead.includes('\0') ? rawRead : undefined;
  if (!absolute && !sessionId && !registration && !daemonHosted && !readOutside) return undefined;
  return { ...(absolute ? { project: absolute } : {}), ...(sessionId ? { sessionId } : {}), ...(registration ? { registration } : {}),
    ...(process ? { process } : {}), ...(daemonHosted ? { daemonHosted: true as const } : {}), ...(readOutside ? { readOutside } : {}) };
}

function readExplicitUserRequest(req: Request): boolean | undefined {
  const raw = req.headers.get(EXPLICIT_USER_REQUEST_HEADER);
  if (raw === null) return undefined;
  return raw.trim().toLowerCase() === 'true' ? true : false;
}

const MAX_ACKNOWLEDGED_RECEIPTS = 200;

/**
 * contracts.start takes a caller's retry key in the Idempotency-Key header.
 * It goes to the handler as `idempotencyKey`, where the contract runner keeps
 * it with the contract store, so a retry on either path, also after a daemon
 * restart, returns the first contract. The header wins over a body field.
 */
function withContractRetryKey(methodId: string, req: Request, body: unknown): unknown {
  if (methodId !== 'contracts.start') return body;
  const key = req.headers.get('idempotency-key')?.trim();
  if (!key) return body;
  if (!isOperationKey(key)) {
    return jsonErrorResponse({ error: `Idempotency-Key must be ${OPERATION_KEY_RULE}`, code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { ...record, idempotencyKey: key };
}

/** A gateway call's answer; a contracts.start that returned an earlier call's contract says so in a header. */
function gatewayCallResponse(methodId: string, response: { readonly status: number; readonly body: unknown; readonly replayed?: boolean }): Response {
  const record = response.body !== null && typeof response.body === 'object' ? response.body as { readonly replayed?: unknown; readonly retryAfterMs?: unknown } : undefined;
  const replayed = response.replayed === true || (methodId === 'contracts.start' && record?.replayed === true);
  // A refusal that says when to come back (an in-flight call limit) says it in the header HTTP clients read too.
  const statedRetry = record?.retryAfterMs;
  const retryAfterMs = (response.status === 429 || response.status === 503) && typeof statedRetry === 'number' && Number.isFinite(statedRetry)
    ? statedRetry : undefined;
  const headers: Record<string, string> = {
    ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}),
    ...(retryAfterMs !== undefined ? { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {}),
  };
  return Response.json(response.body, { status: response.status, headers });
}

export function createDaemonControlRouteHandlers(
  context: ControlRouteContext,
): DaemonControlRouteHandlers {
  // A request's reader of kept events; with no principal (a host that never authenticated the read), a caller of no
  // credential, who is given only what every caller may reach.
  const readerOf = (req: Request | undefined): EventReaderLike | undefined => {
    if (!req) return undefined;
    const principal = context.resolveAuthenticatedPrincipal(req);
    if (!principal) return {};
    return { credentialKind: principal.credentialKind, principalId: principal.principalId, actor: principal.actor, ...(readCallContext(req) ? { call: readCallContext(req) } : {}) };
  };
  return {
    postLogin: (req) => context.login
      ? context.login(req)
      : jsonErrorResponse({ error: 'Login is not configured for this daemon host.' }, { status: 404 }),
    getStatus: (req) => {
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (!principal) return authenticationRequiredResponse();
      // Receipts reach only a reader that passes ?receipts=peek, and are
      // delivered only when it acknowledges what it showed (?receipts=ack).
      // Every other /status read is receipt-neutral, so an identity probe or
      // keepalive can never take a receipt from a rendering surface.
      const searchParams = new URL(req.url).searchParams;
      const receiptsMode = searchParams.get('receipts');
      const peekReceipts = receiptsMode === 'peek' && context.peekReceipts !== undefined;
      // An owner alert kept as a receipt is the owner's alone: only an owner-class reader sees or takes it.
      const ownerReader = principal.actor.class === 'owner';
      if (receiptsMode === 'ack' && context.acknowledgeReceipts) {
        // A reader confirms what it received; only then are those receipts
        // delivered, so a response lost in transit is offered again.
        const ids = searchParams.getAll('ids')
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .slice(0, MAX_ACKNOWLEDGED_RECEIPTS);
        if (ids.length > 0) context.acknowledgeReceipts(ids, ownerReader);
      }
      const floorHeader = context.clientCompatibilityFloor && context.clientCompatibilityFloorHeader
        ? { [context.clientCompatibilityFloorHeader]: context.clientCompatibilityFloor }
        : undefined;
      // Two versions, both named. `version` keeps the meaning every existing
      // reader already assumes it has, which build of this product is running
      //, and that is the artifact's own version whenever the host stated one.
      // `platformVersion` is the platform composition underneath it, which nothing
      // could previously ask for separately because it was occupying the only
      // field there was.
      const buildVersion = context.buildVersion?.() ?? null;
      return Response.json({
        status: 'running',
        version: buildVersion ?? context.version,
        buildVersion: buildVersion ?? context.version,
        platformVersion: context.version,
        ...(peekReceipts && context.peekReceipts ? { receipts: context.peekReceipts(ownerReader) } : {}),
        ...(context.collectClusterStatus ? { cluster: context.collectClusterStatus() } : {}),
      }, floorHeader ? { headers: floorHeader } : undefined);
    },
    getCurrentAuth: (req) => {
      const token = context.extractAuthToken(req).trim();
      const principal = context.resolveAuthenticatedPrincipal(req);
      const session = principal?.principalKind === 'user'
        ? context.requireAuthenticatedSession(req)
        : null;
      const authorizationHeaderPresent = Boolean(req.headers.get('authorization')?.trim());
      const sessionCookiePresent = (req.headers.get('cookie') ?? '')
        .split(';')
        .some((segment) => segment.trim().startsWith(`${context.sessionCookieName}=`));
      // The authenticator states which credential this is; nothing is inferred from a principal's name.
      const credential = principal ? credentialOf(principal) : null;
      const authMode = principal
        ? (credential === 'shared-token' || credential === 'local' ? 'shared-token' : 'session')
        : token.length > 0
          ? 'invalid'
          : 'anonymous';
      const snapshot = {
        authenticated: principal !== null,
        authMode,
        tokenPresent: token.length > 0,
        authorizationHeaderPresent,
        sessionCookiePresent,
        principalId: principal?.principalId ?? null,
        principalKind: principal?.principalKind ?? null,
        credential,
        admin: principal?.admin ?? false,
        scopes: principal?.scopes ?? [],
        // A token credential has no login roles; its role is what its grant makes it.
        roles: session?.roles ?? (principal ? (principal.admin ? ['admin'] : []) : []),
        // The session's current end, moved forward each time it is used; a client keeps this
        // instead of the end it was given at sign-in. Null for a credential that does not expire.
        expiresAt: session ? principal?.expiresAt ?? null : null,
        // Asked of the daemon's one test of who the owner is, never inferred here from the credential.
        ownerHimself: principal !== null && context.ownerHimself?.(req) === true,
      };

      return Response.json(snapshot);
    },
    // The kept events and messages a reader is given are only those about records it may reach, as its stream's
    // (platform control-plane/event-reach.ts): the reader named as a stream names its caller.
    getControlPlaneSnapshot: (req) => Response.json(context.controlPlaneGateway.getSnapshot(readerOf(req))),
    getOperatorContract: () => serializableJsonResponse({ contract: context.getOperatorContract() }),
    getControlPlaneWeb: () => context.controlPlaneGateway.renderWebUi(),
    getControlPlaneRecentEvents: (limit, req) => Response.json({ events: context.controlPlaneGateway.listRecentEvents(limit, readerOf(req)) }),
    getControlPlaneMessages: (req) => Response.json({ messages: context.controlPlaneGateway.listSurfaceMessages(50, readerOf(req)) }),
    getControlPlaneClients: () => Response.json({ clients: context.controlPlaneGateway.listClients() }),
    getGatewayMethods: (url) => {
      const category = url.searchParams.get('category') ?? undefined;
      const source = url.searchParams.get('source');
      return serializableJsonResponse({
        methods: context.gatewayMethods.list({
          ...(category ? { category } : {}),
          ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
        }),
      });
    },
    getGatewayEvents: (url) => {
      const category = url.searchParams.get('category') ?? undefined;
      const source = url.searchParams.get('source');
      const domain = url.searchParams.get('domain') ?? undefined;
      return serializableJsonResponse({
        events: context.gatewayMethods.listEvents({
          ...(category ? { category } : {}),
          ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
          ...(domain ? { domain: domain as RuntimeEventDomain } : {}),
        }),
      });
    },
    getGatewayMethod: (methodId) => {
      const method = context.gatewayMethods.get(methodId);
      return method
        ? serializableJsonResponse({ method })
        // Machine-readable: METHOD_NOT_FOUND distinguishes "this id isn't cataloged at
        // all" from NOT_INVOKABLE ("cataloged but refuses dispatch") so a capability
        // probe (e.g. webui's isMethodUnavailableError) never has to string-match
        // "Unknown gateway method".
        : jsonErrorResponse({ error: 'Unknown gateway method', code: EngineErrorCodes.METHOD_NOT_FOUND }, { status: 404 });
    },
    invokeGatewayMethod: async (methodId, req) => {
      const descriptor = context.gatewayMethods.get(methodId);
      if (!descriptor) {
        return jsonErrorResponse({ error: 'Unknown gateway method', code: EngineErrorCodes.METHOD_NOT_FOUND }, { status: 404 });
      }
      // Who may call it is decided once, in dispatch, from the method's effects for the
      // request's actor (the same check the REST route and the WebSocket call get).
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (descriptor.access !== 'public' && descriptor.access !== 'remote-peer' && !principal) {
        return authenticationRequiredResponse();
      }
      const parsedBody = await context.parseOptionalJsonBody(req);
      if (parsedBody instanceof Response) return parsedBody;
      const payload = controlBodySchemas.gatewayInvoke.parse(parsedBody ?? {});
      if (payload instanceof Response) return payload;
      const invokeBody = withContractRetryKey(methodId, req, payload.body);
      if (invokeBody instanceof Response) return invokeBody;
      // A method that takes the shared retry key reads it from the header, or beside `body` in the envelope.
      const envelopeKey = parsedBody && typeof parsedBody.idempotencyKey === 'string' ? parsedBody.idempotencyKey : undefined;
      const idempotencyKey = methodId === 'contracts.start' ? undefined : req.headers.get('idempotency-key') ?? envelopeKey;
      const response = await context.invokeGatewayMethodCall({
        authToken: context.extractAuthToken(req),
        signal: req.signal,
        methodId,
        ...(idempotencyKey !== undefined && idempotencyKey !== null ? { idempotencyKey } : {}),
        query: payload.query,
        body: invokeBody,
        ...(principal ? { principal } : {}),
        context: {
          principalId: principal?.principalId,
          principalKind: principal?.principalKind,
          admin: principal?.admin,
          scopes: principal?.scopes,
          clientKind: readClientSurface(req),
          ...(readExplicitUserRequest(req) === undefined
            ? {}
            : { explicitUserRequest: readExplicitUserRequest(req) }),
          ...(readDecidedInRun(req) ? { decidedInRun: true } : {}),
          ...(readCapabilityGateDecided(req) ? { decidedByCapabilityGate: true } : {}),
          ...(readCallContext(req) ? { call: readCallContext(req) } : {}),
        },
      });
      return gatewayCallResponse(methodId, response);
    },
    resolveGatewayRestVerb: (method, pathname) => {
      // Only a verb with a handler is served here; any other falls through to the route modules.
      const descriptor = context.gatewayMethods.findByHttpBinding(method, pathname);
      if (!descriptor?.http || !context.gatewayMethods.hasHandler(descriptor.id)) return null;
      return { methodId: descriptor.id, path: descriptor.http.path };
    },
    refuseUnservedGatewayRestVerb: (method, pathname) => {
      const descriptor = context.gatewayMethods.findByHttpBinding(method, pathname);
      if (!descriptor) return null;
      return jsonErrorResponse({
        error: `Gateway method is not invokable: ${descriptor.id}. Its path is advertised, but this daemon has no handler or route for it, so the capability is not set up in this composition.`,
        code: EngineErrorCodes.NOT_INVOKABLE,
        state: 'nothing was run',
        next: ['This is a fixed answer for this daemon; retrying will not change it. Read the method catalog for what this daemon serves.'],
      }, { status: 501 });
    },
    invokeGatewayRestVerb: async (invocation: GatewayRestVerbInvocation) => {
      // REST parity for a handler-backed gateway verb reached by its advertised
      // path (gateway-rest-routes.ts). Not a second implementation: resolve the
      // principal, fold the path params into BOTH query and body (so query-reading
      // GET/DELETE verbs and body-schema-validated POST verbs both see them), and
      // delegate to the same invokeGatewayMethodCall the methodId-invoke endpoint
      // above uses, identical access gate, identical in-process handler.
      const { methodId, req, params } = invocation;
      const descriptor = context.gatewayMethods.get(methodId);
      // Admission is dispatch's, from the method's effects for the request's actor.
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (descriptor?.access !== 'public' && descriptor?.access !== 'remote-peer' && !principal) {
        return authenticationRequiredResponse();
      }
      const parsedBody = await context.parseOptionalJsonBody(req);
      if (parsedBody instanceof Response) return parsedBody;
      const bodyRecord = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
        ? parsedBody
        : {};
      // The URL names the target. A body field or query parameter that repeats a
      // path parameter with a different value would retarget the call while the
      // access log, proxy rules and audit trail name the URL's resource, so
      // refuse it for every verb and let the path value win.
      const searchParams = new URL(req.url).searchParams;
      for (const [key, expected] of Object.entries(params)) {
        const inBody = bodyRecord[key];
        const inQuery = searchParams.getAll(key);
        if ((inBody !== undefined && inBody !== expected) || inQuery.some((value) => value !== expected)) {
          return jsonErrorResponse({ error: `${key} must match the route target`, code: 'INVALID_ARGUMENT' }, { status: 400 });
        }
      }
      const query: Record<string, unknown> = {};
      for (const [key, value] of searchParams) query[key] = value;
      Object.assign(query, params);
      const restBody = withContractRetryKey(methodId, req, { ...bodyRecord, ...params });
      if (restBody instanceof Response) return restBody;
      const response = await context.invokeGatewayMethodCall({
        authToken: context.extractAuthToken(req),
        signal: req.signal,
        methodId,
        query,
        body: restBody,
        ...(principal ? { principal } : {}),
        context: {
          principalId: principal?.principalId,
          principalKind: principal?.principalKind,
          admin: principal?.admin,
          scopes: principal?.scopes,
          clientKind: readClientSurface(req),
          ...(readExplicitUserRequest(req) === undefined
            ? {}
            : { explicitUserRequest: readExplicitUserRequest(req) }),
          ...(readDecidedInRun(req) ? { decidedInRun: true } : {}),
          ...(readCapabilityGateDecided(req) ? { decidedByCapabilityGate: true } : {}),
          ...(readCallContext(req) ? { call: readCallContext(req) } : {}),
        },
      });
      return gatewayCallResponse(methodId, response);
    },
    createControlPlaneEventStream: (req) => {
      const url = new URL(req.url);
      const rawDomains = url.searchParams.get('domains');
      // The gateway owns which names are domains: it subscribes the known ones
      // and names the rest back in the ready frame.
      const requestedDomains = rawDomains ? rawDomains.split(',').map((v) => v.trim()).filter(Boolean) : [];
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (!principal) return authenticationRequiredResponse();
      return context.controlPlaneGateway.createEventStream(req, {
        clientKind: 'web',
        transport: 'sse',
        requestedDomains,
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        scopes: principal.scopes,
        // Carry admin so the per-channel scope filter (e.g. read:sessions on
        // session-update) honors the single-admin-token collapse.
        admin: principal.admin,
        // Who follows: only events about records this caller may reach (control-plane/event-reach.ts).
        reachContext: {
          credentialKind: principal.credentialKind,
          principalId: principal.principalId,
          actor: principal.actor,
          ...(readCallContext(req) ? { call: readCallContext(req) } : {}),
        },
        // Asked before each frame; the request's principal is bound, so this is an integer compare until a credential changes.
        // A principal that lost admin is closed so it reconnects under the narrower grant.
        isAuthorized: () => {
          const current = context.resolveAuthenticatedPrincipal(req);
          return current?.principalId === principal.principalId && (current.admin || !principal.admin);
        },
      });
    },
  };
}
