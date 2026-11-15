/**
 * HTTP and SSE transport behaviour at the edges: a 2xx that is not JSON, how a
 * connection failure is classified for retry, header spelling, which replies a
 * retry policy may repeat, base paths, the SSE reconnect budget, and the turn
 * gate's memory of finished turns.
 */
import { describe, expect, test } from 'bun:test';
import { createHttpJsonTransport, requestJsonRaw } from '../transport-http/src/http-core.ts';
import { buildUrl } from '../transport-http/src/paths.ts';
import { openRawServerSentEventStream } from '../transport-http/src/sse-stream.ts';
import { createTurnLifecycleGate } from '../transport-realtime/src/turn-lifecycle-gate.ts';

type Handler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

function capture(handler: Handler): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(input, init);
  }) as unknown as typeof fetch;
  return { fetch: stub, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('a successful reply that is not JSON', () => {
  test('requestJson rejects with a protocol error instead of returning the text as the result', async () => {
    const { fetch } = capture(() => new Response('<html>Sign in to the network</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const transport = createHttpJsonTransport({ baseUrl: 'http://127.0.0.1:3210', fetch });

    const failure = await transport.requestJson('/status').then(() => undefined, (error: unknown) => error);

    expect((failure as { category?: string }).category).toBe('protocol');
    expect((failure as Error).message).toContain('not JSON');
  });

  test('the one-shot helper rejects the same way, and an empty 2xx body is still null', async () => {
    const html = capture(() => new Response('<html></html>', { status: 200 }));
    await expect(requestJsonRaw(html.fetch, 'http://127.0.0.1:3210/status')).rejects.toThrow('not JSON');

    const empty = capture(() => new Response(null, { status: 204 }));
    expect(await requestJsonRaw(empty.fetch, 'http://127.0.0.1:3210/status')).toBeNull();
  });

  test('an error status with a text body still reports the status', async () => {
    const { fetch } = capture(() => new Response('bad gateway', { status: 502 }));
    const transport = createHttpJsonTransport({ baseUrl: 'http://127.0.0.1:3210', fetch });

    const failure = await transport.requestJson('/status').then(() => undefined, (error: unknown) => error);

    expect((failure as { status?: number }).status).toBe(502);
  });
});

describe('connection failures are retried whatever runtime reports them', () => {
  test('a plain Error carrying Bun\'s ConnectionRefused code is recoverable and retried', async () => {
    const { fetch, calls } = capture(() => { throw Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' }); });
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch,
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const failure = await transport.requestJson('/status').then(() => undefined, (error: unknown) => error);

    expect(calls).toHaveLength(2);
    expect((failure as { recoverable?: boolean }).recoverable).toBe(true);
  });

  test('a deliberate abort is neither recoverable nor retried', async () => {
    const { fetch, calls } = capture(() => { throw new DOMException('aborted', 'AbortError'); });
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const failure = await transport.requestJson('/status').then(() => undefined, (error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect((failure as { recoverable?: boolean }).recoverable).toBe(false);
  });
});

describe('request headers', () => {
  test('a caller-supplied lower-case authorization header does not become a second Authorization value', async () => {
    const { fetch, calls } = capture(() => json({}));
    const transport = createHttpJsonTransport({ baseUrl: 'http://127.0.0.1:3210', fetch, authToken: 'real-token' });

    await transport.requestJson('/x', { headers: { authorization: 'Bearer caller', 'content-type': 'text/plain' }, body: { a: 1 } });

    const sent = new Headers(calls[0]!.init!.headers);
    expect(sent.get('authorization')).toBe('Bearer real-token');
    expect(sent.get('content-type')).toBe('application/json');
  });
});

describe('which replies a retry policy repeats', () => {
  test('a billing limit that says it is final is not retried even though 429 normally is', async () => {
    const { fetch, calls } = capture(() => json({ error: 'Credit exhausted', category: 'billing', recoverable: false }, 429));
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(transport.requestJson('/x')).rejects.toThrow();

    expect(calls).toHaveLength(1);
  });

  test('a plain 503 on a safe method is retried', async () => {
    const { fetch, calls } = capture(() => json({ error: 'down' }, 503));
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(transport.requestJson('/x')).rejects.toThrow();

    expect(calls).toHaveLength(3);
  });

  test('a mutation with a perMethodPolicy entry is retried only once its verb is in retryOnMethods', async () => {
    const run = async (retryOnMethods?: string[]): Promise<number> => {
      const { fetch, calls } = capture(() => json({ error: 'down' }, 503));
      const transport = createHttpJsonTransport({
        baseUrl: 'http://127.0.0.1:3210',
        fetch,
        retry: {
          maxAttempts: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          perMethodPolicy: { 'things.create': {} },
          ...(retryOnMethods ? { retryOnMethods } : {}),
        },
      });
      await expect(transport.requestJson('/things', { method: 'POST', body: {}, methodId: 'things.create' })).rejects.toThrow();
      return calls.length;
    };

    expect(await run()).toBe(1);
    expect(await run(['GET', 'POST'])).toBe(2);
  });
});

describe('base URL with a path prefix', () => {
  test('requests stay under the prefix', () => {
    expect(buildUrl('https://host.example/goodvibes', '/api/status')).toBe('https://host.example/goodvibes/api/status');
    expect(buildUrl('https://host.example', '/api/status')).toBe('https://host.example/api/status');
  });

  test('a path that looks protocol-relative cannot leave the base', () => {
    expect(buildUrl('https://host.example/p', '//other.example/x')).toBe('https://host.example/p/other.example/x');
  });
});

describe('SSE stream open and reconnect', () => {
  const encoder = new TextEncoder();
  const frameThenClose = (): Response => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('id: 1\nevent: turn\ndata: {"a":1}\n\n'));
      controller.close();
    },
  }), { status: 200 });
  const closedAtOnce = (): Response => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 });
  const stays = (): Response => new Response(new ReadableStream({ start() {} }), { status: 200 });

  test('a long-lived stream that keeps dropping and recovering is not killed by its tenth drop', async () => {
    let opened = 0;
    let terminated = 0;
    const { fetch } = capture(() => { opened += 1; return opened <= 12 ? frameThenClose() : stays(); });
    const close = await openRawServerSentEventStream(fetch, 'http://127.0.0.1:3210/events', {
      onTerminate: () => { terminated += 1; },
      onError: () => {},
    }, { reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } });

    for (let i = 0; i < 40 && opened < 13; i += 1) await flush();
    close();

    expect(opened).toBe(13);
    expect(terminated).toBe(0);
  });

  test('a stream the server accepts and closes at once still runs out of attempts', async () => {
    let opened = 0;
    let terminated = 0;
    const { fetch } = capture(() => { opened += 1; return closedAtOnce(); });
    await openRawServerSentEventStream(fetch, 'http://127.0.0.1:3210/events', {
      onTerminate: () => { terminated += 1; },
      onError: () => {},
    }, { reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } });

    for (let i = 0; i < 40 && terminated === 0; i += 1) await flush();

    expect(terminated).toBe(1);
    expect(opened).toBe(4);
  });

  test('a first connect that fails rejects open() without announcing a close that never was', async () => {
    let closed = 0;
    const { fetch } = capture(() => json({ error: 'nope' }, 401));

    await expect(openRawServerSentEventStream(fetch, 'http://127.0.0.1:3210/events', { onClose: () => { closed += 1; } })).rejects.toThrow();
    await flush();

    expect(closed).toBe(0);
  });

  test('a refused open carries the server\'s Retry-After', async () => {
    const { fetch } = capture(() => json({ error: 'slow down' }, 429, { 'Retry-After': '7' }));

    const failure = await openRawServerSentEventStream(fetch, 'http://127.0.0.1:3210/events', {}).then(() => undefined, (error: unknown) => error);

    expect((failure as { retryAfterMs?: number }).retryAfterMs).toBe(7000);
  });

  test('a 5xx on open is recoverable only when a retry can clear it', async () => {
    const outcome = async (status: number): Promise<boolean | undefined> => {
      const { fetch } = capture(() => json({ error: 'x' }, status));
      const failure = await openRawServerSentEventStream(fetch, 'http://127.0.0.1:3210/events', {}).then(() => undefined, (error: unknown) => error);
      return (failure as { recoverable?: boolean }).recoverable;
    };

    expect(await outcome(503)).toBe(true);
    expect(await outcome(501)).toBe(false);
  });
});

describe('turn lifecycle gate: a turn it saw complete stays complete', () => {
  const frame = (type: string, turnId: string) => ({ sessionId: 's1', type, turnId });

  test('a replayed start frame for a finished turn does not rebind, and its replayed completion is dropped', () => {
    const gate = createTurnLifecycleGate();
    expect(gate.accepts(frame('TURN_SUBMITTED', 't1'))).toBe(true);
    expect(gate.accepts(frame('TURN_COMPLETED', 't1'))).toBe(true);

    // The next stream replays the tail.
    expect(gate.accepts(frame('TURN_SUBMITTED', 't1'))).toBe(false);
    expect(gate.accepts(frame('TURN_COMPLETED', 't1'))).toBe(false);
    // The turn really running is unaffected.
    expect(gate.accepts(frame('TURN_SUBMITTED', 't2'))).toBe(true);
    expect(gate.accepts(frame('TURN_COMPLETED', 't2'))).toBe(true);
  });

  test('a turn that errored may be submitted again under the same id', () => {
    const gate = createTurnLifecycleGate();
    expect(gate.accepts(frame('TURN_SUBMITTED', 't1'))).toBe(true);
    expect(gate.accepts(frame('TURN_ERROR', 't1'))).toBe(true);
    expect(gate.accepts(frame('TURN_SUBMITTED', 't1'))).toBe(true);
    expect(gate.accepts(frame('TURN_COMPLETED', 't1'))).toBe(true);
  });

  test('reset forgets finished turns along with bindings', () => {
    const gate = createTurnLifecycleGate();
    gate.accepts(frame('TURN_SUBMITTED', 't1'));
    gate.accepts(frame('TURN_COMPLETED', 't1'));
    gate.reset();
    expect(gate.accepts(frame('TURN_SUBMITTED', 't1'))).toBe(true);
  });
});
