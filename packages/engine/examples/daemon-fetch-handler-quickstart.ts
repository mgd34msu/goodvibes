/**
 * Compose a minimal fetch handler from daemon route-handler factories.
 *
 * The route handlers authenticate every request through the host's
 * `resolveAuthenticatedPrincipal`, which returns the request's principal: who
 * the caller is, which credential it presented, what it may do, and the actor
 * its effects are recorded under. Here one bearer token,
 * `GOODVIBES_DAEMON_TOKEN`, is the operator's shared token and resolves to the
 * owner; while the variable is unset the status route answers 401. Replace it
 * with real principal resolution (user sessions, scoped tokens) before
 * exposing a host built from this file.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
  jsonErrorResponse,
} from '@goodvibes/engine/platform/daemon';
import { NO_OWNER_USER, actorFromPrincipal } from '@goodvibes/engine/daemon-api';
import type { AuthenticatedPrincipal, RequestPrincipal } from '@goodvibes/engine/daemon-api';
import { getOperatorContract } from '@goodvibes/engine/platform/contracts';
import enginePackage from '@goodvibes/engine/package.json' with { type: 'json' };

/** The bearer token on the request, or '' when there is none. */
function extractAuthToken(request: Request): string {
  return /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
}

/** Who the token's holder is: the operator, with every scope. */
const operator: AuthenticatedPrincipal = { principalId: 'shared-token', principalKind: 'token', admin: true, scopes: ['*'] };

/**
 * The request principal the operator token authenticates as. The actor is
 * derived from the principal and its credential by the engine's own rule
 * (`actorFromPrincipal`): the shared operator token is the owner. This host
 * has no sign-in users, so no user is the owner (`NO_OWNER_USER`), and its one
 * credential never changes, so its authentication revision stays 0.
 */
const operatorPrincipal: RequestPrincipal = Object.freeze({
  ...operator,
  credentialKind: 'shared-token',
  scopeSet: new Set(operator.scopes),
  roles: [],
  authRevision: 0,
  actor: actorFromPrincipal({ ...operator, credentialKind: 'shared-token' }, NO_OWNER_USER),
});

/** The quickstart's one principal, for a request that carries `GOODVIBES_DAEMON_TOKEN`; null otherwise. */
function resolveAuthenticatedPrincipal(request: Request): RequestPrincipal | null {
  const expected = process.env.GOODVIBES_DAEMON_TOKEN;
  if (!expected) return null;
  const supplied = Buffer.from(extractAuthToken(request));
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return null;
  return operatorPrincipal;
}

const controlHandlers = createDaemonControlRouteHandlers({
  authToken: null,
  version: enginePackage.version,
  sessionCookieName: 'goodvibes_session',
  controlPlaneGateway: {
    getSnapshot: () => ({ ok: true }),
    renderWebUi: () => new Response('<html><body>GoodVibes</body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    listRecentEvents: () => [],
    listSurfaceMessages: () => [],
    listClients: () => [],
    // The quickstart returns one SSE event; daemon hosts can keep this stream open.
    createEventStream: () => new Response('event: ready\ndata: {"ok":true}\n\n', {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
  },
  login: async () => Response.json({
    error: 'This quickstart does not implement username/password login',
  }, { status: 404 }),
  extractAuthToken,
  resolveAuthenticatedPrincipal,
  gatewayMethods: {
    list: () => [],
    listEvents: () => [],
    get: () => null,
    findByHttpBinding: () => null,
    hasHandler: () => false,
  },
  getOperatorContract,
  invokeGatewayMethodCall: async () => ({
    status: 404,
    ok: false,
    // Gateway method response shape, not a GoodVibesError envelope.
    body: { error: 'No gateway methods are registered in this quickstart' },
  }),
  parseOptionalJsonBody: async (request) => {
    // Parse request JSON in your daemon host; this quickstart keeps the body optional.
    const text = await request.text();
    return text.trim() ? JSON.parse(text) as Record<string, unknown> : null;
  },
  requireAdmin: (request) => resolveAuthenticatedPrincipal(request)?.admin
    ? null
    : jsonErrorResponse('Admin access required; send GOODVIBES_DAEMON_TOKEN as Authorization: Bearer <token>', {
      status: 403,
      source: 'permission',
    }),
  requireAuthenticatedSession: () => null,
});

const telemetryHandlers = createDaemonTelemetryRouteHandlers({
  telemetryApi: null,
  ingestSink: null,
  resolveAuthenticatedPrincipal,
});

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/control-plane/status') {
    return await controlHandlers.getStatus(request);
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/telemetry') {
    return await telemetryHandlers.getTelemetrySnapshot(request);
  }
  return jsonErrorResponse(`Route not found: ${url.pathname}`, {
    status: 404,
    source: 'runtime',
  });
}
