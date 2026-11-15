/**
 * Compose a minimal fetch handler from daemon route-handler factories.
 *
 * The route handlers below are configured with no authentication of their own:
 * every request they see is treated as an admin. `handleRequest` therefore
 * checks a bearer token before delegating. Do not remove that check, and
 * replace `resolveAuthenticatedPrincipal` and `requireAdmin` with real
 * principal resolution before exposing a host built from this file.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
  jsonErrorResponse,
} from '@goodvibes-jev/engine/platform/daemon';
import { getOperatorContract } from '@goodvibes-jev/engine/platform/contracts';
import enginePackage from '@goodvibes-jev/engine/package.json' with { type: 'json' };

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
  extractAuthToken: () => '',
  resolveAuthenticatedPrincipal: () => ({
    principalId: 'quickstart-admin',
    principalKind: 'user',
    admin: true,
    scopes: ['*'],
  }),
  gatewayMethods: {
    list: () => [],
    listEvents: () => [],
    get: () => null,
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
  requireAdmin: () => null,
  requireAuthenticatedSession: () => null,
});

const telemetryHandlers = createDaemonTelemetryRouteHandlers({
  telemetryApi: null,
  ingestSink: null,
  resolveAuthenticatedPrincipal: () => null,
});

/** True when the request carries `Authorization: Bearer <GOODVIBES_DAEMON_TOKEN>`; false when the variable is unset. */
function isAuthorized(request: Request): boolean {
  const expected = process.env.GOODVIBES_DAEMON_TOKEN;
  if (!expected) return false;
  const supplied = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleRequest(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return jsonErrorResponse('Missing or invalid bearer token; set GOODVIBES_DAEMON_TOKEN and send it as Authorization: Bearer <token>', {
      status: 401,
      source: 'runtime',
    });
  }
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
