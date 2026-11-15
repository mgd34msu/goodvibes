/**
 * router-e2e-telemetry.test.ts
 *
 * Router-level E2E tests for the telemetry route family.
 * Exercises createDaemonTelemetryRouteHandlers, which is then composed
 * with dispatchOperatorRoutes (the production wiring) to test:
 *   GET /api/v1/telemetry          (getTelemetrySnapshot)
 *   GET /api/v1/telemetry/events   (getTelemetryEvents)
 *   GET /api/v1/telemetry       (alias path)
 *
 * Two key scenarios:
 *   - Happy path: telemetryApi present → 200 JSON response
 *   - Failure path: telemetryApi null → 503 unavailable
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonTelemetryRouteHandlers } from '../daemon-api/src/telemetry-routes.js';
import { dispatchOperatorRoutes } from '../daemon-api/src/operator.js';
import type { DaemonApiRouteHandlers } from '../daemon-api/src/context.js';
import { makeDefaultDaemonHandlerStub } from './_helpers/daemon-stub-handlers.js';
import { makeRequest } from './_helpers/router-requests.js';

interface TelemetryApiStubSnapshot {
  generatedAt: number;
  view: string;
  rawAccessible: boolean;
  runtime: Record<string, unknown>;
  sessionMetrics: Record<string, unknown>;
  aggregates: Record<string, unknown>;
  events?: unknown[];
  errors?: unknown[];
  spans?: unknown[];
}

/**
 * Minimal TelemetryApiLike stub.
 */
function makeTelemetryApi(): {
  isRawEnabled: () => boolean;
  getSnapshot: (filter: unknown, view: string, rawAccessible: boolean) => TelemetryApiStubSnapshot;
  listEventPage: (filter: unknown, view: string, rawAccessible: boolean) => unknown;
  listErrorPage: (filter: unknown, view: string, rawAccessible: boolean) => unknown;
  listSpanPage: (filter: unknown, view: string, rawAccessible: boolean) => unknown;
  createStream: () => Response;
  buildOtlpTraceDocument: () => unknown;
  buildOtlpLogDocument: () => unknown;
  buildOtlpMetricDocument: () => unknown;
  ingestLogs: () => void;
  ingestTraces: () => void;
  ingestMetrics: () => void;
} {
  const snapshot: TelemetryApiStubSnapshot = {
    generatedAt: Date.now(),
    view: 'safe',
    rawAccessible: false,
    runtime: {},
    sessionMetrics: {},
    aggregates: {},
    events: [],
    errors: [],
    spans: [],
  };
  return {
    isRawEnabled: () => false,
    getSnapshot: (_filter, _view, _rawAccessible) => snapshot,
    listEventPage: (_filter, _view, _rawAccessible) => ({ items: [], cursor: null }),
    listErrorPage: (_filter, _view, _rawAccessible) => ({ items: [], cursor: null }),
    listSpanPage: (_filter, _view, _rawAccessible) => ({ items: [], cursor: null }),
    createStream: () => new Response('', { status: 200 }),
    buildOtlpTraceDocument: () => ({}),
    buildOtlpLogDocument: () => ({}),
    buildOtlpMetricDocument: () => ({}),
    ingestLogs: () => {},
    ingestTraces: () => {},
    ingestMetrics: () => {},
  };
}

/**
 * Build a full DaemonApiRouteHandlers stub using createDaemonTelemetryRouteHandlers
 * for the telemetry slice and makeDefaultDaemonHandlerStub for everything else.
 */
interface StubPrincipal {
  principalId: string;
  principalKind: 'token';
  admin: boolean;
  scopes: readonly string[];
}

function makeTelemetryHandlers(
  opts: { telemetryApiPresent: boolean; principal?: StubPrincipal | null } = { telemetryApiPresent: true },
): DaemonApiRouteHandlers {
  const api = opts.telemetryApiPresent ? makeTelemetryApi() : null;

  // Provide a stub principal with read:telemetry scope so the auth guard passes.
  // The telemetry routes always require an authenticated principal, null returns 401.
  const stubPrincipal: StubPrincipal | null = opts.principal === undefined
    ? {
        principalId: 'test-principal',
        principalKind: 'token',
        admin: false,
        scopes: ['read:telemetry'],
      }
    : opts.principal;

  const telemetryHandlers = createDaemonTelemetryRouteHandlers({
    telemetryApi: api as never,
    resolveAuthenticatedPrincipal: () => stubPrincipal,
    ingestSink: api as never,
  });

  return makeDefaultDaemonHandlerStub({
    getControlPlaneWeb: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    getControlPlaneRecentEvents: (_limit) => Response.json({ events: [] }),
    ...telemetryHandlers,
  });
}

// ---------------------------------------------------------------------------
// describe: telemetry routes, happy paths
// ---------------------------------------------------------------------------

describe('router-e2e telemetry: GET /api/v1/telemetry (happy path)', () => {
  test('returns 200 with snapshot shape when telemetryApi is present', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: true });
    const req = makeRequest('GET', 'http://localhost/api/v1/telemetry');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe('number');
  });

  test('GET /api/v1/telemetry/events returns event page', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: true });
    const req = makeRequest('GET', 'http://localhost/api/v1/telemetry/events');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body).toHaveProperty('items');
    expect(body.items).toBeInstanceOf(Array);
  });

  test('GET /api/v1/telemetry/events bounds since, until, and limit filters', async () => {
    const capturedFilters: Record<string, unknown>[] = [];
    const api = {
      ...makeTelemetryApi(),
      listEventPage: (filter: unknown) => {
        capturedFilters.push(filter as Record<string, unknown>);
        return { items: [], cursor: null };
      },
    };
    const telemetryHandlers = createDaemonTelemetryRouteHandlers({
      telemetryApi: api as never,
      resolveAuthenticatedPrincipal: () => ({
        principalId: 'test-principal',
        principalKind: 'token' as const,
        admin: false,
        scopes: ['read:telemetry'] as readonly string[],
      }),
      ingestSink: api as never,
    });
    const handlers = makeDefaultDaemonHandlerStub({
      getControlPlaneWeb: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      getControlPlaneRecentEvents: (_limit) => Response.json({ events: [] }),
      ...telemetryHandlers,
    });
    const req = makeRequest('GET', 'http://localhost/api/v1/telemetry/events?limit=999999&since=-12.8&until=410244480000000');
    const res = await dispatchOperatorRoutes(req, handlers);

    expect(res?.status).toBe(200);
    expect(capturedFilters).toHaveLength(1);
    const capturedFilter = capturedFilters[0]!;
    expect(capturedFilter.limit).toBe(1000);
    expect(capturedFilter.since).toBe(0);
    expect(capturedFilter.until).toBe(Date.UTC(2100, 0, 1));
  });

  test('GET /api/v1/telemetry/events omits non-finite timestamp filters', async () => {
    let capturedFilter: Record<string, unknown> | null = null;
    const api = {
      ...makeTelemetryApi(),
      listEventPage: (filter: unknown) => {
        capturedFilter = filter as Record<string, unknown>;
        return { items: [], cursor: null };
      },
    };
    const telemetryHandlers = createDaemonTelemetryRouteHandlers({
      telemetryApi: api as never,
      resolveAuthenticatedPrincipal: () => ({
        principalId: 'test-principal',
        principalKind: 'token' as const,
        admin: false,
        scopes: ['read:telemetry'] as readonly string[],
      }),
      ingestSink: api as never,
    });
    const handlers = makeDefaultDaemonHandlerStub({
      getControlPlaneWeb: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      getControlPlaneRecentEvents: (_limit) => Response.json({ events: [] }),
      ...telemetryHandlers,
    });
    const req = makeRequest('GET', 'http://localhost/api/v1/telemetry/events?since=Infinity&until=not-a-date');
    const res = await dispatchOperatorRoutes(req, handlers);

    expect(res?.status).toBe(200);
    if (!capturedFilter) throw new Error('Telemetry filter was not captured');
    expect(capturedFilter).not.toHaveProperty('since');
    expect(capturedFilter).not.toHaveProperty('until');
  });
});

// ---------------------------------------------------------------------------
// describe: telemetry routes, failure paths (telemetryApi absent)
// ---------------------------------------------------------------------------

describe('router-e2e telemetry: failure paths (telemetryApi null)', () => {
  test('returns 503 when telemetryApi is null', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: false });
    const req = makeRequest('GET', 'http://localhost/api/v1/telemetry');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    // The unavailable() helper returns 503
    expect(res!.status).toBe(503);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.error).toBe('string'); // error is a string message
  });

  test('GET /api/v1/telemetry/events returns 503 when telemetryApi is null', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: false });
    const req = makeRequest('GET', 'http://localhost/api/v1/telemetry/events');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// describe: telemetry routes, authentication and scope
// ---------------------------------------------------------------------------

describe('router-e2e telemetry: authentication and scope', () => {
  const paths = ['/api/v1/telemetry', '/api/v1/telemetry/events'];

  for (const path of paths) {
    test(`GET ${path} without a principal is 401 AUTH_REQUIRED`, async () => {
      const handlers = makeTelemetryHandlers({ telemetryApiPresent: true, principal: null });
      const res = await dispatchOperatorRoutes(makeRequest('GET', `http://localhost${path}`), handlers);
      expect(res?.status).toBe(401);
      expect((await res!.json() as { code: string }).code).toBe('AUTH_REQUIRED');
    });

    test(`GET ${path} with a principal lacking read:telemetry is 403 MISSING_SCOPE`, async () => {
      const handlers = makeTelemetryHandlers({
        telemetryApiPresent: true,
        principal: { principalId: 'p', principalKind: 'token', admin: false, scopes: ['read:other'] },
      });
      const res = await dispatchOperatorRoutes(makeRequest('GET', `http://localhost${path}`), handlers);
      expect(res?.status).toBe(403);
      expect((await res!.json() as { code: string }).code).toBe('MISSING_SCOPE');
    });
  }

  test('an admin asking for the raw view passes the scope check and is refused only because raw telemetry is disabled', async () => {
    const handlers = makeTelemetryHandlers({
      telemetryApiPresent: true,
      principal: { principalId: 'a', principalKind: 'token', admin: true, scopes: ['read:telemetry'] },
    });
    const res = await dispatchOperatorRoutes(makeRequest('GET', 'http://localhost/api/v1/telemetry?view=raw'), handlers);
    expect(res?.status).toBe(403);
    expect((await res!.json() as { code: string }).code).toBe('TELEMETRY_RAW_DISABLED');
  });

  test('the raw view without read:telemetry-sensitive is refused with 403 even for a read:telemetry principal', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: true });
    const res = await dispatchOperatorRoutes(makeRequest('GET', 'http://localhost/api/v1/telemetry?view=raw'), handlers);
    expect(res?.status).toBe(403);
    expect((await res!.json() as { code: string }).code).toBe('MISSING_SCOPE');
  });

  test('an unavailable telemetry API is reported as 503 before any credential is examined', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: false, principal: null });
    const res = await dispatchOperatorRoutes(makeRequest('GET', 'http://localhost/api/v1/telemetry'), handlers);
    expect(res?.status).toBe(503);
  });
});
