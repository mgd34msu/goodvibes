import type { DaemonControlRouteHandlers, GatewayRestVerbInvocation } from './context.js';
import type { RuntimeEventDomain } from '@goodvibes-jev/engine/contracts';
import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';
import { authenticationRequiredResponse, jsonErrorResponse } from './error-response.js';
import { GATEWAY_METHOD_INVOKE_PATH } from './operator.js';
import type { AuthenticatedPrincipal, CredentialKind } from './http-policy.js';
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

interface ControlPlaneGatewayLike {
  getSnapshot(): unknown;
  renderWebUi(): Response;
  listRecentEvents(limit: number): unknown;
  listSurfaceMessages(): unknown;
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
  readonly resolveAuthenticatedPrincipal: (req: Request) => (AuthenticatedPrincipal & { readonly expiresAt?: number | undefined }) | null;
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
    };
    /**
     * The principal the request was authenticated as where it entered,
     * credential kind included, so the dispatch does not authenticate the
     * token again and handlers read who called from it.
     */
    readonly principal?: (AuthenticatedPrincipal & { readonly credentialKind?: CredentialKind | null | undefined }) | undefined;
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly login?: ((req: Request) => Promise<Response> | Response) | undefined;
  /**
   * Undelivered daemon receipts ("updated from X to Y at HH:MM",
   * "restarted after a crash at HH:MM"). Invoked ONLY when a /status reader
   * explicitly opts in with `?receipts=consume`; the provider marks the
   * returned receipts delivered, so consumption stays exactly-once across
   * consuming readers. A plain /status read (identity probe, keepalive,
   * version poll) neither receives nor consumes receipts.
   */
  readonly collectReceipts?: (() => readonly { id: string; text: string; at: number }[]) | undefined;
  /**
   * The same receipts, left undelivered. `?receipts=peek` returns them so a
   * reader whose response is lost can ask again; the reader then names what it
   * received with `?receipts=ack&ids=<id>,<id>` ({@link acknowledgeReceipts}).
   */
  readonly peekReceipts?: (() => readonly { id: string; text: string; at: number }[]) | undefined;
  readonly acknowledgeReceipts?: ((ids: readonly string[]) => void) | undefined;
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

/**
 * The credential a resolved principal was authenticated with. The daemon's
 * resolver hands back the request principal, which carries it; a resolver
 * that does not (an embedding host's own) reports none rather than a guess.
 */
function credentialOf(principal: AuthenticatedPrincipal): CredentialKind | null {
  const kind = (principal as { readonly credentialKind?: unknown }).credentialKind;
  return kind === 'local' || kind === 'shared-token' || kind === 'device-token' || kind === 'agent' || kind === 'user-session' ? kind : null;
}

function readExplicitUserRequest(req: Request): boolean | undefined {
  const raw = req.headers.get(EXPLICIT_USER_REQUEST_HEADER);
  if (raw === null) return undefined;
  return raw.trim().toLowerCase() === 'true' ? true : false;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
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
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return jsonErrorResponse({ error: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { ...record, idempotencyKey: key };
}

/** A gateway call's answer; a contracts.start that returned an earlier call's contract says so in a header. */
function gatewayCallResponse(methodId: string, response: { readonly status: number; readonly body: unknown }): Response {
  const record = response.body !== null && typeof response.body === 'object' ? response.body as { readonly replayed?: unknown; readonly retryAfterMs?: unknown } : undefined;
  const replayed = methodId === 'contracts.start' && record?.replayed === true;
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
  return {
    postLogin: (req) => context.login
      ? context.login(req)
      : jsonErrorResponse({ error: 'Login is not configured for this daemon host.' }, { status: 404 }),
    getStatus: (req) => {
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (!principal) return authenticationRequiredResponse();
      // Receipt consumption is explicit: only a reader that passes
      // ?receipts=consume receives undelivered receipts (and marks them
      // delivered, exactly once). Every other /status read is
      // receipt-neutral, so an identity probe or keepalive that parses only
      // status/version can never eat a receipt before a rendering surface.
      const searchParams = new URL(req.url).searchParams;
      const receiptsMode = searchParams.get('receipts');
      const consumeReceipts = receiptsMode === 'consume';
      const peekReceipts = receiptsMode === 'peek' && context.peekReceipts !== undefined;
      if (receiptsMode === 'ack' && context.acknowledgeReceipts) {
        // A reader confirms what it received; only then are those receipts
        // delivered, so a response lost in transit is offered again.
        const ids = searchParams.getAll('ids')
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .slice(0, MAX_ACKNOWLEDGED_RECEIPTS);
        if (ids.length > 0) context.acknowledgeReceipts(ids);
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
        ...(consumeReceipts && context.collectReceipts ? { receipts: context.collectReceipts() } : {}),
        ...(peekReceipts && context.peekReceipts ? { receipts: context.peekReceipts() } : {}),
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
      };

      return Response.json(snapshot);
    },
    getControlPlaneSnapshot: () => Response.json(context.controlPlaneGateway.getSnapshot()),
    getOperatorContract: () => serializableJsonResponse({ contract: context.getOperatorContract() }),
    getControlPlaneWeb: () => context.controlPlaneGateway.renderWebUi(),
    getControlPlaneRecentEvents: (limit) => Response.json({ events: context.controlPlaneGateway.listRecentEvents(limit) }),
    getControlPlaneMessages: () => Response.json({ messages: context.controlPlaneGateway.listSurfaceMessages() }),
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
      const access = descriptor.access ?? 'admin';
      if (access === 'admin' || access === 'remote-peer') {
        const admin = context.requireAdmin(req);
        if (admin) return admin;
      }
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (access === 'authenticated' && !principal) {
        return authenticationRequiredResponse();
      }
      const parsedBody = await context.parseOptionalJsonBody(req);
      if (parsedBody instanceof Response) return parsedBody;
      const payload = controlBodySchemas.gatewayInvoke.parse(parsedBody ?? {});
      if (payload instanceof Response) return payload;
      const invokeBody = withContractRetryKey(methodId, req, payload.body);
      if (invokeBody instanceof Response) return invokeBody;
      const response = await context.invokeGatewayMethodCall({
        authToken: context.extractAuthToken(req),
        signal: req.signal,
        methodId,
        query: payload.query,
        body: invokeBody,
        ...(principal ? { principal } : {}),
        context: {
          principalId: principal?.principalId,
          principalKind: principal?.principalKind,
          admin: principal?.admin,
          scopes: principal?.scopes,
          clientKind: 'web',
          ...(readExplicitUserRequest(req) === undefined
            ? {}
            : { explicitUserRequest: readExplicitUserRequest(req) }),
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
      const access = descriptor?.access ?? 'admin';
      if (access === 'admin' || access === 'remote-peer') {
        const admin = context.requireAdmin(req);
        if (admin) return admin;
      }
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (access === 'authenticated' && !principal) {
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
          clientKind: 'web',
          ...(readExplicitUserRequest(req) === undefined
            ? {}
            : { explicitUserRequest: readExplicitUserRequest(req) }),
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
