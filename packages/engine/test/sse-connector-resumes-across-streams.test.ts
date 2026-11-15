/**
 * sse-connector-resumes-across-streams.test.ts
 *
 * The platform-side client the platform composes for daemon-routed sessions is
 * `createEventSourceConnector`. It already resumed a stream across that
 * stream's OWN reconnects; what it did not do is resume across stream
 * LIFETIMES, close one stream, open the next for the following turn, and the
 * new stream claimed to have seen nothing, so the gateway replayed it the tail
 * of the previous turn including that turn's TURN_COMPLETED.
 *
 * These pin both halves of the connector's behaviour: the position survives a
 * close-and-reopen, and a terminal frame for a turn this connection is not
 * rendering never reaches a subscriber.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { createEventSourceConnector } from '../transport-realtime/src/event-source-connector.ts';
import { createRemoteRuntimeEvents } from '../transport-realtime/src/runtime-events.ts';

/**
 * Serves SSE responses and reports when the connector has consumed every frame
 * of them. The stream is pull-driven: a pull after the last frame means the
 * reader came back for more, so the frames before it were already handled.
 * That replaces sleeping for "long enough" with the condition itself.
 */
function sseRecorder(options: { readonly closes?: boolean } = {}): {
  respond: (chunks: readonly string[]) => Response;
  consumed: () => Promise<void>;
} {
  const encoder = new TextEncoder();
  const drains: Promise<void>[] = [];
  // The connector opens its stream on a later turn of the event loop.
  let markResponded: () => void = () => {};
  const responded = new Promise<void>((resolve) => { markResponded = resolve; });
  return {
    respond(chunks) {
      markResponded();
      let next = 0;
      let markDrained: () => void = () => {};
      drains.push(new Promise<void>((resolve) => { markDrained = resolve; }));
      return new Response(new ReadableStream({
        pull(controller) {
          if (next < chunks.length) {
            controller.enqueue(encoder.encode(chunks[next]!));
            next += 1;
            return;
          }
          if (options.closes === true) controller.close();
          markDrained();
        },
      }, { highWaterMark: 0 }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
    async consumed() {
      await responded;
      await Promise.all(drains);
      // One macrotask turn so envelopes dispatched from the last frame have run.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    },
  };
}

let sse = sseRecorder();
beforeEach(() => { sse = sseRecorder(); });

function fetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

function turnFrame(id: string, type: string, turnId: string, sessionId = 's1'): string {
  return `id: ${id}\nevent: turn\ndata: ${JSON.stringify({
    type,
    sessionId,
    payload: { type, turnId },
  })}\n\n`;
}

/** The connector's cleanup is typed `void | (() => void)`; a real connection always returns one. */
function closer(cleanup: void | (() => void)): () => void {
  if (typeof cleanup !== 'function') throw new Error('expected the connector to return a cleanup function');
  return cleanup;
}

describe('the connector resumes across stream lifetimes, not just across reconnects', () => {
  test('a stream opened after the previous one closed presents the position it reached', async () => {
    const presented: Array<string | null> = [];
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async (_input, init) => {
        presented.push(new Headers(init?.headers).get('last-event-id'));
        return sse.respond([turnFrame('evt-1', 'TURN_COMPLETED', 'turn-1')]);
      }),
      { reconnect: { enabled: false } },
    );

    // Turn one: a fresh connection, nothing to resume from.
    const closeFirst = closer(await connector('turn', () => {}));
    await sse.consumed();
    closeFirst();

    // Turn two: the client opens a NEW stream. Under the defect this presented
    // null again and was handed turn one's tail.
    const closeSecond = closer(await connector('turn', () => {}));
    await sse.consumed();
    closeSecond();

    expect(presented).toEqual([null, 'evt-1']);
  });

  test('every domain a client listens to rides one stream, and a changed set resumes from the shared position', async () => {
    const opened: Array<{ url: string; id: string | null }> = [];
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async (input, init) => {
        opened.push({ url: decodeURIComponent(String(input)), id: new Headers(init?.headers).get('last-event-id') });
        return sse.respond([turnFrame(`evt-${opened.length}`, 'STREAM_DELTA', 'turn-1')]);
      }),
      { reconnect: { enabled: false } },
    );
    const events = createRemoteRuntimeEvents(connector);
    const domains = ['turn', 'tools', 'agents', 'session', 'gate', 'fleet', 'config', 'ops', 'tasks'] as const;
    const offs = domains.map((domain) => events[domain].on('STREAM_DELTA' as never, (() => {}) as never));
    await sse.consumed();

    // Nine domains, one stream.
    expect(opened).toHaveLength(1);
    expect(opened[0]!.url).toContain(`domains=${[...domains].sort().join(',')}`);

    // Dropping a domain reopens with the smaller set, resuming from the position the first stream reached.
    offs[8]!();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    await sse.consumed();
    expect(opened).toHaveLength(2);
    expect(opened[1]!.url).not.toContain('tasks');
    expect(opened[1]!.id).toBe('evt-1');
    for (const off of offs.slice(0, 8)) off();
  });
});

describe('a replayed terminal frame never reaches the connector\'s subscribers', () => {
  test('the previous turn\'s TURN_COMPLETED is dropped while a new turn is rendering', async () => {
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async () => sse.respond([
        // The new turn starts.
        turnFrame('evt-10', 'TURN_SUBMITTED', 'turn-2'),
        // A replay the resume did not prevent: the previous turn's tail.
        turnFrame('evt-3', 'TURN_COMPLETED', 'turn-1'),
        // The turn actually running goes on.
        turnFrame('evt-11', 'STREAM_DELTA', 'turn-2'),
        turnFrame('evt-12', 'TURN_COMPLETED', 'turn-2'),
      ])),
      { reconnect: { enabled: false } },
    );

    const events = createRemoteRuntimeEvents(connector);
    const completed: string[] = [];
    const deltas: string[] = [];
    const unsubCompleted = events.turn.onEnvelope('TURN_COMPLETED', (envelope) => {
      completed.push((envelope.payload as { turnId: string }).turnId);
    });
    const unsubDelta = events.turn.onEnvelope('STREAM_DELTA', (envelope) => {
      deltas.push((envelope.payload as { turnId: string }).turnId);
    });
    await sse.consumed();
    unsubCompleted();
    unsubDelta();

    // turn-1's terminal frame never arrives; turn-2's real frames all do.
    expect(completed).toEqual(['turn-2']);
    expect(deltas).toEqual(['turn-2']);
  });

  test('turnScope "off" hands every frame through for a consumer doing its own bookkeeping', async () => {
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async () => sse.respond([
        turnFrame('evt-10', 'TURN_SUBMITTED', 'turn-2'),
        turnFrame('evt-3', 'TURN_COMPLETED', 'turn-1'),
        turnFrame('evt-12', 'TURN_COMPLETED', 'turn-2'),
      ])),
      { reconnect: { enabled: false }, turnScope: 'off' },
    );

    const events = createRemoteRuntimeEvents(connector);
    const completed: string[] = [];
    const unsub = events.turn.onEnvelope('TURN_COMPLETED', (envelope) => {
      completed.push((envelope.payload as { turnId: string }).turnId);
    });
    await sse.consumed();
    unsub();

    expect(completed).toEqual(['turn-1', 'turn-2']);
  });

  test('a connector pinned to one turn delivers that turn and nothing else', async () => {
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async () => sse.respond([
        turnFrame('evt-1', 'TURN_COMPLETED', 'someone-elses'),
        turnFrame('evt-2', 'TURN_COMPLETED', 'mine'),
      ])),
      { reconnect: { enabled: false }, turnScope: { turnId: 'mine' } },
    );

    const events = createRemoteRuntimeEvents(connector);
    const completed: string[] = [];
    const unsub = events.turn.onEnvelope('TURN_COMPLETED', (envelope) => {
      completed.push((envelope.payload as { turnId: string }).turnId);
    });
    await sse.consumed();
    unsub();

    expect(completed).toEqual(['mine']);
  });

  test('frames that name no turn are delivered whatever the gate is bound to', async () => {
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async () => sse.respond([
        turnFrame('evt-1', 'TURN_SUBMITTED', 'turn-2'),
        `id: evt-2\nevent: agents\ndata: ${JSON.stringify({ type: 'AGENT_COMPLETED', payload: { id: 'a1' } })}\n\n`,
      ])),
      { reconnect: { enabled: false } },
    );

    const events = createRemoteRuntimeEvents(connector);
    const agents: unknown[] = [];
    const unsub = events.agents.onEnvelope('AGENT_COMPLETED', (envelope) => { agents.push(envelope.payload); });
    await sse.consumed();
    unsub();

    expect(agents).toEqual([{ id: 'a1' }]);
  });
});

describe('a stream that closes without an id leaves the position alone', () => {
  test('a stream with no ids at all still presents nothing on the next open', async () => {
    const presented: Array<string | null> = [];
    const closing = sseRecorder({ closes: true });
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async (_input, init) => {
        presented.push(new Headers(init?.headers).get('last-event-id'));
        return closing.respond(['event: ready\ndata: {}\n\n']);
      }),
      { reconnect: { enabled: false } },
    );

    closer(await connector('turn', () => {}))();
    await closing.consumed();
    closer(await connector('turn', () => {}))();
    await closing.consumed();

    expect(presented).toEqual([null, null]);
  });
});
