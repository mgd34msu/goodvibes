import { describe, expect, test } from 'bun:test';
import { openServerSentEventStream } from './_helpers/runtime-seam.ts';
import { waitFor } from './_helpers/test-timeout.ts';

function createSseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

describe('openServerSentEventStream', () => {
  test('parses ready and event payloads from an SSE stream', async () => {
    const readyPayloads: unknown[] = [];
    const events: Array<{ eventName: string; payload: unknown }> = [];

    const stop = await openServerSentEventStream(
      createFetchStub(async () => createSseResponse([
        'event: ready\n',
        'data: {"ok":true}\n\n',
        'event: telemetry\n',
        'data: {"type":"tool","ok":true}\n\n',
      ])),
      'http://127.0.0.1:3210/api/v1/telemetry/stream',
      {
        onReady: (payload) => {
          readyPayloads.push(payload);
        },
        onEvent: (eventName, payload) => {
          events.push({ eventName, payload });
        },
      },
    );

    await waitFor(() => readyPayloads.length >= 1 && events.length >= 1);
    stop();

    expect(readyPayloads).toEqual([{ ok: true }]);
    expect(events).toEqual([{
      eventName: 'telemetry',
      payload: { type: 'tool', ok: true },
    }]);
  });

  test('attaches transport metadata when the stream cannot be opened', async () => {
    await expect(openServerSentEventStream(
      createFetchStub(async () => createSseResponse(['forbidden'], 403)),
      'http://127.0.0.1:3210/api/control-plane/events?domains=agents',
      {},
    )).rejects.toMatchObject({
      transport: {
        status: 403,
        url: 'http://127.0.0.1:3210/api/control-plane/events?domains=agents',
        method: 'GET',
        body: 'forbidden',
      },
    });
  });

  test('reconnects with the last received event id when configured', async () => {
    const seenLastEventIds: Array<string | null> = [];
    const reconnects: Array<{ attempt: number; delayMs: number }> = [];
    const events: Array<{ eventName: string; payload: unknown }> = [];
    let callCount = 0;

    const stop = await openServerSentEventStream(
      createFetchStub(async (_input, init) => {
        callCount += 1;
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        seenLastEventIds.push(headers.get('last-event-id'));
        if (callCount === 1) {
          return createSseResponse([
            'id: evt-1\n',
            'event: telemetry\n',
            'data: {"step":1}\n\n',
          ]);
        }
        return createSseResponse([
          'id: evt-2\n',
          'event: telemetry\n',
          'data: {"step":2}\n\n',
        ]);
      }),
      'http://127.0.0.1:3210/api/v1/telemetry/stream',
      {
        onEvent: (eventName, payload) => {
          events.push({ eventName, payload });
          if (events.length >= 2) {
            stop();
          }
        },
        onReconnect: (input) => {
          reconnects.push(input);
        },
      },
      {
        reconnect: {
          enabled: true,
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      },
    );

    await waitFor(() => events.length >= 2 && reconnects.length >= 1);

    expect(events).toEqual([
      { eventName: 'telemetry', payload: { step: 1 } },
      { eventName: 'telemetry', payload: { step: 2 } },
    ]);
    expect(seenLastEventIds).toEqual([null, 'evt-1']);
    expect(reconnects).toEqual([{ attempt: 1, delayMs: 0 }]);
  });
});

test('already cancelled SSE never resolves credentials or opens a request', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await expect(openServerSentEventStream(createFetchStub(async () => { calls++; return createSseResponse([]); }),
    'https://example.test/events', {}, { signal: controller.signal, getAuthToken: async () => { calls++; return 'token'; } })).rejects.toThrow();
  expect(calls).toBe(0);
});

test('credential resolver rejection settles initial SSE readiness', async () => {
  await expect(openServerSentEventStream(createFetchStub(async () => createSseResponse([])), 'https://example.test/events', {},
    { reconnect: { enabled: false }, getAuthToken: async () => { throw new Error('credential unavailable'); } })).rejects.toThrow('credential unavailable');
});

test('an incomplete SSE frame cannot advance the replay cursor', async () => {
  let calls = 0;
  const ids: (string | null)[] = [];
  const received: unknown[] = [];
  const close = await openServerSentEventStream(createFetchStub(async (_url, init) => {
    ids.push(new Headers(init?.headers).get('Last-Event-ID'));
    // After the replay the server keeps the stream open: a stream that delivers a frame on
    // every connect and then closes would, rightly, reconnect for as long as it keeps delivering.
    if (++calls > 2) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    return createSseResponse(calls === 1 ? ['id: 1\ndata: first\n\nid: 2\ndata: lost'] : ['id: 2\ndata: replayed\n\n']);
  }), 'https://example.test/events', { onEvent: (_name, data) => received.push(data) },
  { reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 } });
  await waitFor(() => received.length >= 2); close();
  expect(ids[1]).toBe('1'); expect(received).toEqual(['first', 'replayed']);
});

test('a stream that is greeted with ready and closed at once runs out of reconnect attempts', async () => {
  let calls = 0;
  const terminated: number[] = [];
  await openServerSentEventStream(createFetchStub(async () => {
    calls += 1;
    return createSseResponse(['event: ready\ndata: {"ok":true}\n\n']);
  }), 'https://example.test/events', { onTerminate: (info) => terminated.push(info.reconnectAttempts), onError: () => {} },
  { reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 2 } });
  await waitFor(() => terminated.length >= 1);
  expect(calls).toBe(3);
  expect(terminated).toEqual([3]);
});

test('a Retry-After on a refused reconnect is a floor under the reconnect delay', async () => {
  let calls = 0;
  const delays: number[] = [];
  const close = await openServerSentEventStream(createFetchStub(async () => {
    calls += 1;
    if (calls === 1) return createSseResponse([]);
    return new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } });
  }), 'https://example.test/events', {
    onReconnect: (info) => { delays.push(info.delayMs); if (delays.length >= 2) close(); },
    onError: () => {},
  }, { reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 } });
  await waitFor(() => delays.length >= 2);
  expect(delays).toEqual([0, 7000]);
});

test('a stream that stayed connected long enough starts a fresh reconnect budget when it drops', async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const attempts: number[] = [];
    const terminated: number[] = [];
    // Closing inside the callback stops the loop synchronously; a zero-delay reconnect loop
    // yields only microtasks, so polling with waitFor would never get a turn.
    const close = await openServerSentEventStream(createFetchStub(async () => (
      createSseResponse(['event: ready\ndata: {"ok":true}\n\n'])
    )), 'https://example.test/events', {
      // The greeting arrives after the connection is recorded, so this is the connection living a minute.
      onReady: () => { clock += 60_000; },
      onReconnect: (info) => { attempts.push(info.attempt); if (attempts.length >= 6) close(); },
      onTerminate: (info) => terminated.push(info.reconnectAttempts),
      onError: () => {},
    }, { reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 2 } });
    await waitFor(() => attempts.length >= 6);
    expect(attempts).toEqual([1, 1, 1, 1, 1, 1]);
    expect(terminated).toEqual([]);
  } finally {
    Date.now = realNow;
  }
});

test('a stream that stayed connected long enough and then fails with a read error starts a fresh reconnect budget', async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const attempts: number[] = [];
    const terminated: number[] = [];
    const encoder = new TextEncoder();
    const close = await openServerSentEventStream(createFetchStub(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {"ok":true}\n\n'));
      },
      pull() {
        throw new Error('connection reset');
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })), 'https://example.test/events', {
      onReady: () => { clock += 60_000; },
      onReconnect: (info) => { attempts.push(info.attempt); if (attempts.length >= 6) close(); },
      onTerminate: (info) => terminated.push(info.reconnectAttempts),
      onError: () => {},
    }, { reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 2 } });
    await waitFor(() => attempts.length >= 6);
    expect(attempts).toEqual([1, 1, 1, 1, 1, 1]);
    expect(terminated).toEqual([]);
  } finally {
    Date.now = realNow;
  }
});
