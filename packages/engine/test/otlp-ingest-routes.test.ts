/**
 * otlp-ingest-routes.test.ts
 *
 * Tests for OTLP POST ingest endpoints.
 *
 * Routes under test:
 *   POST /api/v1/telemetry/otlp/v1/logs
 *   POST /api/v1/telemetry/otlp/v1/traces
 *   POST /api/v1/telemetry/otlp/v1/metrics
 *
 * Coverage:
 *   - Happy path: application/json body for each signal type
 *   - Happy path: application/x-protobuf body for each signal type
 *   - 401 when no authenticated principal
 *   - 415 when wrong Content-Type
 *   - 400 when malformed JSON
 *   - Ingest sink forwarding (spy verifies payload routed to sink)
 *   - Router dispatch wiring via dispatchDaemonApiRoutes
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonTelemetryRouteHandlers } from '../daemon-api/src/telemetry-routes.js';
import { dispatchOperatorRoutes } from '../daemon-api/src/operator.js';
import type { AuthenticatedPrincipal } from '../daemon-api/src/http-policy.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const ADMIN_PRINCIPAL: AuthenticatedPrincipal = {
  principalId: 'test-user',
  principalKind: 'user',
  admin: true,
  scopes: ['read:telemetry'],
};

interface IngestSink {
  ingestLogs: (p: Record<string, unknown>) => void;
  ingestTraces: (p: Record<string, unknown>) => void;
  ingestMetrics: (p: Record<string, unknown>) => void;
}

const NOOP_SINK: IngestSink = { ingestLogs: () => {}, ingestTraces: () => {}, ingestMetrics: () => {} };

function makeHandlers(opts: {
  authenticated?: boolean;
  principal?: AuthenticatedPrincipal;
  ingestSink?: IngestSink | null;
}) {
  return createDaemonTelemetryRouteHandlers({
    telemetryApi: null,
    resolveAuthenticatedPrincipal: () =>
      opts.authenticated !== false ? (opts.principal ?? ADMIN_PRINCIPAL) : null,
    // `null` means no sink is wired; the default is a sink that accepts and drops.
    ingestSink: opts.ingestSink === undefined ? NOOP_SINK : opts.ingestSink,
  });
}

function scopedPrincipal(scopes: readonly string[]): AuthenticatedPrincipal {
  return { principalId: 'scoped-user', principalKind: 'user', admin: false, scopes: [...scopes] };
}

function countingSink() {
  const calls = { logs: 0, traces: 0, metrics: 0 };
  const sink: IngestSink = {
    ingestLogs: () => { calls.logs++; },
    ingestTraces: () => { calls.traces++; },
    ingestMetrics: () => { calls.metrics++; },
  };
  return { calls, sink };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function protobufRequest(url: string, bytes: Uint8Array<ArrayBuffer> = new Uint8Array([0x0a, 0x00])): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: bytes,
  });
}

const encoder = new TextEncoder();

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function varint(value: number | bigint): Uint8Array<ArrayBuffer> {
  let next = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(next & 0x7fn);
    next >>= 7n;
    if (next !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (next !== 0n);
  return new Uint8Array(bytes);
}

function fieldTag(fieldNumber: number, wireType: number): Uint8Array<ArrayBuffer> {
  return varint((fieldNumber << 3) | wireType);
}

function lengthDelimited(fieldNumber: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(fieldTag(fieldNumber, 2), varint(body.length), body);
}

function stringField(fieldNumber: number, value: string): Uint8Array<ArrayBuffer> {
  return lengthDelimited(fieldNumber, encoder.encode(value));
}

function bytesField(fieldNumber: number, value: Uint8Array): Uint8Array<ArrayBuffer> {
  return lengthDelimited(fieldNumber, value);
}

function protobufLogsPayload(): Uint8Array<ArrayBuffer> {
  const anyBody = stringField(1, 'hello from protobuf');
  const logRecord = lengthDelimited(5, anyBody);
  const scopeLogs = lengthDelimited(2, logRecord);
  const resourceLogs = lengthDelimited(2, scopeLogs);
  return lengthDelimited(1, resourceLogs);
}

function protobufTracesPayload(): Uint8Array<ArrayBuffer> {
  const traceId = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const spanId = new Uint8Array([16, 17, 18, 19, 20, 21, 22, 23]);
  const span = concatBytes(
    bytesField(1, traceId),
    bytesField(2, spanId),
    stringField(5, 'protobuf-span'),
  );
  const scopeSpans = lengthDelimited(2, span);
  const resourceSpans = lengthDelimited(2, scopeSpans);
  return lengthDelimited(1, resourceSpans);
}

function protobufMetricsPayload(): Uint8Array<ArrayBuffer> {
  const gauge = lengthDelimited(1, new Uint8Array());
  const metric = concatBytes(
    stringField(1, 'protobuf.metric'),
    lengthDelimited(5, gauge),
  );
  const scopeMetrics = lengthDelimited(2, metric);
  const resourceMetrics = lengthDelimited(2, scopeMetrics);
  return lengthDelimited(1, resourceMetrics);
}

// ---------------------------------------------------------------------------
// Happy path, JSON
// ---------------------------------------------------------------------------

describe('OTLP POST ingest: happy path (application/json)', () => {
  test('POST logs with JSON body → 200 with partialSuccess', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
  });

  test('POST traces with JSON body → 200 with partialSuccess', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] });
    const res = await h.postTelemetryOtlpTraces(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
  });

  test('POST metrics with JSON body → 200 with partialSuccess', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] });
    const res = await h.postTelemetryOtlpMetrics(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
  });
});

// ---------------------------------------------------------------------------
// Happy path, Protobuf
// ---------------------------------------------------------------------------

describe('OTLP POST ingest: happy path (application/x-protobuf)', () => {
  test('POST logs with protobuf body → 200 and decoded payload forwarded', async () => {
    const received: Record<string, unknown>[] = [];
    const h = makeHandlers({
      authenticated: true,
      ingestSink: {
        ingestLogs: (p) => { received.push(p); },
        ingestTraces: () => {},
        ingestMetrics: () => {},
      },
    });
    const res = await h.postTelemetryOtlpLogs(
      protobufRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', protobufLogsPayload()),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
    expect(received[0]).toMatchObject({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'hello from protobuf' } }] }] }],
    });
  });

  test('POST traces with protobuf body → 200 and decoded payload forwarded', async () => {
    const received: Record<string, unknown>[] = [];
    const h = makeHandlers({
      authenticated: true,
      ingestSink: {
        ingestLogs: () => {},
        ingestTraces: (p) => { received.push(p); },
        ingestMetrics: () => {},
      },
    });
    const res = await h.postTelemetryOtlpTraces(
      protobufRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', protobufTracesPayload()),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
    expect(received[0]).toMatchObject({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'protobuf-span' }] }] }],
    });
  });

  test('POST metrics with protobuf body → 200 and decoded payload forwarded', async () => {
    const received: Record<string, unknown>[] = [];
    const h = makeHandlers({
      authenticated: true,
      ingestSink: {
        ingestLogs: () => {},
        ingestTraces: () => {},
        ingestMetrics: (p) => { received.push(p); },
      },
    });
    const res = await h.postTelemetryOtlpMetrics(
      protobufRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', protobufMetricsPayload()),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
    expect(received[0]).toMatchObject({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'protobuf.metric', gauge: { dataPoints: [{}] } }] }] }],
    });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('OTLP POST ingest: error paths', () => {
  test('401 when no authenticated principal (logs)', async () => {
    const h = makeHandlers({ authenticated: false });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('AUTH_REQUIRED');
  });

  test('401 when no authenticated principal (traces)', async () => {
    const h = makeHandlers({ authenticated: false });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] });
    const res = await h.postTelemetryOtlpTraces(req);
    expect(res.status).toBe(401);
  });

  test('401 when no authenticated principal (metrics)', async () => {
    const h = makeHandlers({ authenticated: false });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] });
    const res = await h.postTelemetryOtlpMetrics(req);
    expect(res.status).toBe(401);
  });

  test('415 when wrong Content-Type (text/plain)', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = new Request('http://localhost/api/v1/telemetry/otlp/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"resourceLogs":[]}',
    });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(415);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('400 when body is malformed JSON', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = new Request('http://localhost/api/v1/telemetry/otlp/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json!!!',
    });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('INVALID_PAYLOAD');
  });

  test('400 when JSON body is a non-object (array)', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = new Request('http://localhost/api/v1/telemetry/otlp/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1, 2, 3]',
    });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Ingest sink forwarding
// ---------------------------------------------------------------------------

describe('OTLP POST ingest: sink forwarding', () => {
  test('JSON logs payload is forwarded to ingestSink.ingestLogs', async () => {
    const received: Record<string, unknown>[] = [];
    const h = makeHandlers({
      authenticated: true,
      ingestSink: {
        ingestLogs: (p) => { received.push(p); },
        ingestTraces: () => {},
        ingestMetrics: () => {},
      },
    });
    const payload = { resourceLogs: [{ scopeLogs: [] }] };
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', payload);
    await h.postTelemetryOtlpLogs(req);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ resourceLogs: [{ scopeLogs: [] }] });
  });

  test('a missing ingestSink answers 503 TELEMETRY_UNAVAILABLE instead of acknowledging dropped data', async () => {
    const h = makeHandlers({ authenticated: true, ingestSink: null });
    for (const [post, path, body] of [
      [h.postTelemetryOtlpLogs, 'logs', { resourceLogs: [] }],
      [h.postTelemetryOtlpTraces, 'traces', { resourceSpans: [] }],
      [h.postTelemetryOtlpMetrics, 'metrics', { resourceMetrics: [] }],
    ] as const) {
      const res = await post(jsonRequest(`http://localhost/api/v1/telemetry/otlp/v1/${path}`, body));
      expect(res.status).toBe(503);
      expect((await res.json() as Record<string, unknown>)['code']).toBe('TELEMETRY_UNAVAILABLE');
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization and size gates (non-admin principals)
// ---------------------------------------------------------------------------

describe('OTLP POST ingest: scope and size gates', () => {
  const logsUrl = 'http://localhost/api/v1/telemetry/otlp/v1/logs';

  test('a read-only telemetry principal gets 403 MISSING_SCOPE and nothing reaches the sink', async () => {
    const { calls, sink } = countingSink();
    const h = makeHandlers({ principal: scopedPrincipal(['read:telemetry']), ingestSink: sink });
    const requests: Array<[(req: Request) => Response | Promise<Response>, string, unknown]> = [
      [h.postTelemetryOtlpLogs, 'logs', { resourceLogs: [] }],
      [h.postTelemetryOtlpTraces, 'traces', { resourceSpans: [] }],
      [h.postTelemetryOtlpMetrics, 'metrics', { resourceMetrics: [] }],
    ];
    for (const [post, path, body] of requests) {
      const res = await post(jsonRequest(`http://localhost/api/v1/telemetry/otlp/v1/${path}`, body));
      expect(res.status).toBe(403);
      expect((await res.json() as Record<string, unknown>)['code']).toBe('MISSING_SCOPE');
    }
    expect(calls).toEqual({ logs: 0, traces: 0, metrics: 0 });
  });

  test.each([['ingest:telemetry'], ['write:telemetry']])('a non-admin principal holding %s may ingest', async (scope) => {
    const { calls, sink } = countingSink();
    const h = makeHandlers({ principal: scopedPrincipal([scope]), ingestSink: sink });
    const res = await h.postTelemetryOtlpLogs(jsonRequest(logsUrl, { resourceLogs: [] }));
    expect(res.status).toBe(200);
    expect(calls.logs).toBe(1);
  });

  test('a body one byte over 4 MiB is 413 and is not ingested', async () => {
    const { calls, sink } = countingSink();
    const h = makeHandlers({ ingestSink: sink });
    const limit = 4 * 1024 * 1024;
    const res = await h.postTelemetryOtlpLogs(new Request(logsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(limit + 1),
    }));
    expect(res.status).toBe(413);
    expect((await res.json() as Record<string, unknown>)['code']).toBe('PAYLOAD_TOO_LARGE');
    expect(calls.logs).toBe(0);
  });

  test('a declared Content-Length over 4 MiB is refused before the body is read', async () => {
    const { calls, sink } = countingSink();
    const h = makeHandlers({ ingestSink: sink });
    let bodyRead = false;
    const req = new Request(logsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024 + 1) },
      body: '{}',
    });
    const original = req.arrayBuffer.bind(req);
    Object.defineProperty(req, 'arrayBuffer', { value: () => { bodyRead = true; return original(); } });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(413);
    expect(bodyRead).toBe(false);
    expect(calls.logs).toBe(0);
  });

  test('a body of exactly 4 MiB is not rejected for size', async () => {
    const { sink } = countingSink();
    const h = makeHandlers({ ingestSink: sink });
    const res = await h.postTelemetryOtlpLogs(new Request(logsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(4 * 1024 * 1024),
    }));
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>)['code']).toBe('INVALID_PAYLOAD');
  });

  test('a protobuf body that does not decode is 400 INVALID_PAYLOAD and is not ingested', async () => {
    const { calls, sink } = countingSink();
    const h = makeHandlers({ ingestSink: sink });
    // Field 1, length-delimited, declares 255 bytes and supplies none.
    const res = await h.postTelemetryOtlpLogs(protobufRequest(logsUrl, new Uint8Array([0x0a, 0xff, 0x01])));
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('INVALID_PAYLOAD');
    expect(String(body['error'])).toContain('protobuf');
    expect(calls.logs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Router dispatch wiring, E2E via dispatchDaemonApiRoutes
// ---------------------------------------------------------------------------

describe('OTLP POST ingest: router dispatch wiring', () => {
  function makeFullHandlers() {
    const handlers = makeHandlers({ authenticated: true });
    // Provide a minimal stub that satisfies all other required handler fields.
    // dispatchDaemonApiRoutes returns null for unknown routes, so we only need
    // the POST telemetry handlers to be real.
    return handlers;
  }

  test('POST /api/v1/telemetry/otlp/v1/logs is dispatched by dispatchOperatorRoutes', async () => {
    const handlers = makeFullHandlers();
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await dispatchOperatorRoutes(req, handlers as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('POST /api/v1/telemetry/otlp/v1/traces is dispatched by dispatchOperatorRoutes', async () => {
    const handlers = makeFullHandlers();
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] });
    const res = await dispatchOperatorRoutes(req, handlers as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('POST /api/v1/telemetry/otlp/v1/metrics is dispatched by dispatchOperatorRoutes', async () => {
    const handlers = makeFullHandlers();
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] });
    const res = await dispatchOperatorRoutes(req, handlers as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

});
