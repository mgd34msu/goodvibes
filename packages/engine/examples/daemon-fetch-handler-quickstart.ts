/**
 * Compose a minimal fetch handler from daemon route-handler factories.
 *
 * The route handlers authenticate every request through the host's
 * `resolveAuthenticatedPrincipal`. Here it accepts one bearer token,
 * `GOODVIBES_DAEMON_TOKEN`, and resolves it to an admin; while the variable is
 * unset the status route answers 401. Replace it with real principal resolution
 * (user sessions, scoped tokens) before exposing a host built from this file.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
  jsonErrorResponse,
} from '@goodvibes-jev/engine/platform/daemon';
import type { AuthenticatedPrincipal } from '@goodvibes-jev/engine/daemon-api';
import { getOperatorContract } from '@goodvibes-jev/engine/platform/contracts';
import enginePackage from '@goodvibes-jev/engine/package.json' with { type: 'json' };

/** The bearer token on the request, or '' when there is none. */
function extractAuthToken(request: Request): string {
  return /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
}

/** The quickstart's one principal, for a request that carries `GOODVIBES_DAEMON_TOKEN`; null otherwise. */
function resolveAuthenticatedPrincipal(request: Request): AuthenticatedPrincipal | null {
  const expected = process.env.GOODVIBES_DAEMON_TOKEN;
  if (!expected) return null;
  const supplied = Buffer.from(extractAuthToken(request));
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return null;
  return { principalId: 'quickstart-admin', principalKind: 'token', admin: true, scopes: ['*'] };
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
