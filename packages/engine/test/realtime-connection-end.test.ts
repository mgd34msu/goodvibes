/**
 * A realtime connection that ends, or never really starts, must say so and must
 * let the feed open a new one. Covers the WebSocket connector (refused
 * authentication, missing token, a socket that cannot be built, replayed turn
 * frames after a reconnect, which hosts may use plain ws://), the domain feed's handling of a connection that ended on its own, and
 * the SSE connector's reaction to lost-event notices.
 */
import { describe, expect, test } from 'bun:test';
import { createRemoteDomainEvents } from '../transport-realtime/src/domain-events.ts';
import type { SerializedEventEnvelope } from '../transport-realtime/src/domain-events.ts';
import { createEventSourceConnector } from '../transport-realtime/src/event-source-connector.ts';
import { buildWebSocketUrl, createWebSocketConnector } from '../transport-realtime/src/runtime-events.ts';
import type { ConnectionState } from '../transport-realtime/src/connector-options.ts';
import type { RuntimeEventRecord } from '../contracts/src/index.ts';

/** Lets every pending promise continuation and zero-delay timer run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class MockSocket {
  static instances: MockSocket[] = [];
  static get OPEN(): number { return 1; }
  readyState = 0;
  readonly sent: string[] = [];
  private listeners = new Map<string, Set<(e: Event) => void>>();
  constructor(readonly url: string) { MockSocket.instances.push(this); }
  addEventListener(type: string, fn: (e: Event) => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void): void { this.listeners.get(type)?.delete(fn); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  fire(type: string, event: Event): void { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event); }
  open(): void { this.readyState = 1; this.fire('open', new Event('open')); }
  receive(frame: unknown): void { this.fire('message', new MessageEvent('message', { data: JSON.stringify(frame) })); }
}

const Impl = MockSocket as unknown as typeof WebSocket;
const lastSocket = (): MockSocket => MockSocket.instances[MockSocket.instances.length - 1]!;

function turnEnvelope(type: string, turnId: string, sessionId = 's1'): unknown {
  return { type: 'event', event: 'turn', payload: { type, sessionId, payload: { type, turnId } } };
}

describe('websocket connector: a connection that cannot work says so', () => {
  test('a refused authentication ends the connection as failed and reports why', async () => {
    MockSocket.instances = [];
    const states: ConnectionState[] = [];
    const errors: unknown[] = [];
    let ended = 0;
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', Impl, {
      onConnectionStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e),
    });
    await connector('turn', () => {}, () => { ended += 1; });
    lastSocket().open();
    await flush();
    expect(states[states.length - 1]).toBe('connected');

    lastSocket().receive({ type: 'auth', ok: false, error: 'Unauthorized' });

    expect(states[states.length - 1]).toBe('failed');
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('Unauthorized');
    expect(ended).toBe(1);
  });

  test('a token resolver that returns nothing ends a reconnect-less connection as failed, once', async () => {
    MockSocket.instances = [];
    const states: ConnectionState[] = [];
    const errors: Array<{ code?: string }> = [];
    let ended = 0;
    const connector = createWebSocketConnector('http://127.0.0.1:3210', () => null, Impl, {
      reconnect: { enabled: false },
      onConnectionStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e as { code?: string }),
    });
    await connector('turn', () => {}, () => { ended += 1; });
    lastSocket().open();
    await flush();

    expect(states[states.length - 1]).toBe('failed');
    expect(errors.map((e) => e.code)).toEqual(['ENGINE_AUTH_TOKEN_MISSING']);
    expect(ended).toBe(1);
  });

  test('with reconnect on, a token that appears later is picked up by the next attempt', async () => {
    MockSocket.instances = [];
    let token: string | null = null;
    const states: ConnectionState[] = [];
    const connector = createWebSocketConnector('http://127.0.0.1:3210', () => token, Impl, {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
      onError: () => {},
    });
    const stop = await connector('turn', () => {});
    lastSocket().open();
    await flush();
    expect(MockSocket.instances).toHaveLength(2);
    expect(states).toContain('reconnecting');

    token = 'late-token';
    lastSocket().open();
    await flush();

    expect(states[states.length - 1]).toBe('connected');
    expect(JSON.parse(lastSocket().sent[0]!).token).toBe('late-token');
    (stop as () => void)();
  });

  test('a socket that cannot be constructed is reported and ends the connection without an unhandled rejection', async () => {
    const states: ConnectionState[] = [];
    const errors: unknown[] = [];
    let ended = 0;
    class Throwing { static get OPEN(): number { return 1; } constructor() { throw new Error('blocked port'); } }
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', Throwing as unknown as typeof WebSocket, {
      reconnect: { enabled: false },
      onConnectionStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e),
    });
    await connector('turn', () => {}, () => { ended += 1; });
    await flush();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('blocked port');
    expect(states[states.length - 1]).toBe('failed');
    expect(ended).toBe(1);
  });

  test('an abnormal drop with reconnect off ends as disconnected instead of staying connected', async () => {
    MockSocket.instances = [];
    const states: ConnectionState[] = [];
    let ended = 0;
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', Impl, {
      reconnect: { enabled: false },
      onConnectionStateChange: (s) => states.push(s),
      onError: () => {},
    });
    await connector('turn', () => {}, () => { ended += 1; });
    lastSocket().open();
    await flush();
    lastSocket().fire('close', new CloseEvent('close', { code: 1006, wasClean: false }));

    expect(states[states.length - 1]).toBe('disconnected');
    expect(ended).toBe(1);
  });
});

describe('websocket connector: replayed turn frames', () => {
  test('a reconnect that replays a finished turn does not hand it to the consumer again', async () => {
    MockSocket.instances = [];
    const seen: string[] = [];
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', Impl, {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onError: () => {},
    });
    const stop = await connector('turn', (envelope) => {
      const payload = envelope.payload as RuntimeEventRecord & { turnId: string };
      seen.push(`${envelope.type}:${payload.turnId}`);
    });
    lastSocket().open();
    await flush();
    lastSocket().receive(turnEnvelope('TURN_SUBMITTED', 't1'));
    lastSocket().receive(turnEnvelope('TURN_COMPLETED', 't1'));

    // The socket drops; the gateway replays the domain's recent traffic on the new one.
    lastSocket().fire('close', new CloseEvent('close', { code: 1006, wasClean: false }));
    await flush();
    expect(MockSocket.instances).toHaveLength(2);
    lastSocket().open();
    await flush();
    lastSocket().receive(turnEnvelope('TURN_SUBMITTED', 't1'));
    lastSocket().receive(turnEnvelope('TURN_COMPLETED', 't1'));
    // The turn actually running.
    lastSocket().receive(turnEnvelope('TURN_SUBMITTED', 't2'));
    lastSocket().receive(turnEnvelope('TURN_COMPLETED', 't2'));

    expect(seen).toEqual(['TURN_SUBMITTED:t1', 'TURN_COMPLETED:t1', 'TURN_SUBMITTED:t2', 'TURN_COMPLETED:t2']);
    (stop as () => void)();
  });
});

describe('buildWebSocketUrl: which hosts may use plain ws://', () => {
  test('a private-network http base becomes ws://, as the HTTP transport already allows', () => {
    expect(buildWebSocketUrl('http://192.168.1.20:3421', ['turn'])).toStartWith('ws://192.168.1.20:3421/api/control-plane/ws');
    expect(buildWebSocketUrl('http://phone.local:3421', ['turn'])).toStartWith('ws://phone.local:3421/');
  });

  test('IPv6 loopback is accepted', () => {
    expect(buildWebSocketUrl('http://[::1]:3421', ['turn'])).toStartWith('ws://[::1]:3421/');
  });

  test('a public host that merely starts with 127. is refused', () => {
    expect(() => buildWebSocketUrl('ws://127.evil.example', ['turn'])).toThrow();
    expect(() => buildWebSocketUrl('http://127.0.0.1.attacker.example', ['turn'])).toThrow();
  });

  test('a public http host is refused and https becomes wss', () => {
    expect(() => buildWebSocketUrl('http://daemon.example.com', ['turn'])).toThrow();
    expect(buildWebSocketUrl('https://daemon.example.com', ['turn'])).toStartWith('wss://daemon.example.com/');
  });

  test('a base path prefix is kept', () => {
    expect(buildWebSocketUrl('https://host.example/goodvibes', ['turn'])).toStartWith('wss://host.example/goodvibes/api/control-plane/ws');
  });
});

describe('domain feed: a connection that ended on its own is not treated as still open', () => {
  type Envelope = SerializedEventEnvelope;
  const noop = (_envelope: Envelope): void => {};

  test('a connection that ended on its own is reopened while the feed has listeners', async () => {
    const endings: Array<() => void> = [];
    let connects = 0;
    let cleanups = 0;
    const delivered: string[] = [];
    const events = createRemoteDomainEvents(['turn'] as const, async (_domain, onEnvelope, onEnded) => {
      connects += 1;
      const connection = connects;
      endings.push(() => onEnded?.());
      if (connection === 2) queueMicrotask(() => onEnvelope({ type: 'TURN_SUBMITTED', payload: { type: 'TURN_SUBMITTED' } } as never));
      return () => { cleanups += 1; };
    }, { onConnectionError: () => {} });

    events.turn.on('TURN_SUBMITTED' as never, ((payload: { type: string }) => { delivered.push(payload.type); }) as never);
    await flush();
    expect(connects).toBe(1);

    endings[0]!();
    expect(cleanups).toBe(1);
    await flush();
    expect(connects).toBe(2);
    expect(delivered).toEqual(['TURN_SUBMITTED']);
  });

  test('a final end (a refused credential) is reported and not reopened until a listener registers again', async () => {
    const endings: Array<() => void> = [];
    const errors: Error[] = [];
    let connects = 0;
    const events = createRemoteDomainEvents(['turn'] as const, async (_domain, _onEnvelope, onEnded) => {
      connects += 1;
      endings.push(() => onEnded?.({ final: true }));
      return () => {};
    }, { onConnectionError: (e) => errors.push(e) });

    events.turn.on('TURN_SUBMITTED' as never, noop as never);
    await flush();
    endings[0]!();
    await flush();
    expect(connects).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('not reopened');

    events.turn.on('TURN_COMPLETED' as never, noop as never);
    await flush();
    expect(connects).toBe(2);
  });

  test('an end signalled before the connector has handed over its cleanup is still honoured', async () => {
    let connects = 0;
    let cleanups = 0;
    const events = createRemoteDomainEvents(['turn'] as const, async (_domain, _onEnvelope, onEnded) => {
      connects += 1;
      if (connects === 1) onEnded?.();
      return () => { cleanups += 1; };
    }, { onConnectionError: () => {} });

    events.turn.on('TURN_SUBMITTED' as never, noop as never);
    await flush();
    expect(cleanups).toBe(1);
    expect(connects).toBe(2);
  });

  test('an end signalled after the last listener left does not disturb the next connection', async () => {
    const endings: Array<() => void> = [];
    let connects = 0;
    const errors: Error[] = [];
    const events = createRemoteDomainEvents(['turn'] as const, async (_domain, _onEnvelope, onEnded) => {
      connects += 1;
      endings.push(() => onEnded?.());
      return () => {};
    }, { onConnectionError: (e) => errors.push(e) });

    const off = events.turn.on('TURN_SUBMITTED' as never, noop as never);
    await flush();
    off();
    events.turn.on('TURN_SUBMITTED' as never, noop as never);
    await flush();
    expect(connects).toBe(2);

    endings[0]!(); // the first, already released, connection reporting late
    expect(errors).toHaveLength(0);
    events.turn.on('TURN_COMPLETED' as never, noop as never);
    await flush();
    expect(connects).toBe(2);
  });
});

describe('SSE connector: lost-event notices', () => {
  const encoder = new TextEncoder();
  function sse(chunks: readonly string[]): Response {
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  const turnFrame = (id: string, type: string, turnId: string): string =>
    `id: ${id}\nevent: turn\ndata: ${JSON.stringify({ type, sessionId: 's1', payload: { type, turnId } })}\n\n`;

  test('a ready frame that could not resume reports it, forgets the position and unbinds the gate', async () => {
    const presented: Array<string | null> = [];
    const errors: Array<{ category?: string }> = [];
    let call = 0;
    const connector = createEventSourceConnector('http://127.0.0.1:3210', null, (async (_input: RequestInfo | URL, init?: RequestInit) => {
      presented.push(new Headers(init?.headers).get('last-event-id'));
      call += 1;
      if (call === 1) return sse([turnFrame('evt-1', 'TURN_SUBMITTED', 'turn-1')]);
      // The daemon restarted: it cannot place evt-1, and a turn is already running.
      return sse([
        `event: ready\ndata: ${JSON.stringify({ resume: { resume: 'unresolved', sinceId: 'evt-1' } })}\n\n`,
        turnFrame('evt-9', 'STREAM_DELTA', 'turn-2'),
        turnFrame('evt-10', 'TURN_COMPLETED', 'turn-2'),
      ]);
    }) as unknown as typeof fetch, { reconnect: { enabled: false }, onError: (e) => errors.push(e as { category?: string }) });
    const seen: string[] = [];
    const onEnvelope = (envelope: SerializedEventEnvelope): void => { seen.push(envelope.type); };

    const closeFirst = await connector('turn', onEnvelope);
    await flush();
    (closeFirst as () => void)();
    const closeSecond = await connector('turn', onEnvelope);
    await flush();
    (closeSecond as () => void)();

    expect(presented).toEqual([null, 'evt-1']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.category).toBe('protocol');
    // Without the unbind, the stale binding to turn-1 would drop all of turn-2.
    expect(seen).toEqual(['TURN_SUBMITTED', 'STREAM_DELTA', 'TURN_COMPLETED']);

  });

  test('after a ready frame that could not resume, the next stream starts from the catch-up window', async () => {
    const presented: Array<string | null> = [];
    let call = 0;
    const connector = createEventSourceConnector('http://127.0.0.1:3210', null, (async (_input: RequestInfo | URL, init?: RequestInit) => {
      presented.push(new Headers(init?.headers).get('last-event-id'));
      call += 1;
      if (call === 1) return sse([turnFrame('evt-1', 'STREAM_DELTA', 'turn-1')]);
      return sse([`event: ready\ndata: ${JSON.stringify({ resume: { resume: 'unresolved', sinceId: 'evt-1' } })}\n\n`]);
    }) as unknown as typeof fetch, { reconnect: { enabled: false }, onError: () => {} });

    for (let i = 0; i < 3; i += 1) {
      const close = await connector('turn', () => {});
      await flush();
      (close as () => void)();
    }

    expect(presented).toEqual([null, 'evt-1', null]);
  });

  test('a relay overflow notice is reported, never swallowed as an unrelated event', async () => {
    const errors: Error[] = [];
    const seen: string[] = [];
    const connector = createEventSourceConnector('http://127.0.0.1:3210', null, (async () => sse([
      `event: relay-overflow\ndata: {"dropped":3}\n\n`,
    ])) as unknown as typeof fetch, { reconnect: { enabled: false }, onError: (e) => errors.push(e as Error) });

    const close = await connector('turn', (envelope) => { seen.push(envelope.type); });
    await flush();
    (close as () => void)();

    expect(seen).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('3');
    expect(errors[0]!.message).toContain('dropped');
  });

  test('a stream that closes with reconnect off tells the feed, which reopens it for its listener', async () => {
    let opens = 0;
    const events = createRemoteDomainEvents(['turn'] as const, createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      (async () => { opens += 1; return sse([]); }) as unknown as typeof fetch,
      { reconnect: { enabled: false } },
    ), { onConnectionError: () => {} });

    const off = events.turn.on('TURN_SUBMITTED' as never, (() => {}) as never);
    await flush();
    expect(opens).toBe(2);
    off();
  });

  test('a stream refused for its credential ends the feed instead of reconnecting', async () => {
    let opens = 0;
    const errors: Error[] = [];
    const events = createRemoteDomainEvents(['turn'] as const, createEventSourceConnector(
      'http://127.0.0.1:3210',
      'expired',
      (async () => {
        opens += 1;
        // Connects once, then the daemon refuses the credential on the reconnect.
        return opens === 1 ? sse([]) : new Response('unauthorized', { status: 401 });
      }) as unknown as typeof fetch,
      { reconnect: { baseDelayMs: 0, maxDelayMs: 0 } },
    ), { onConnectionError: (e) => errors.push(e) });

    events.turn.on('TURN_SUBMITTED' as never, (() => {}) as never);
    for (let i = 0; i < 4; i += 1) await flush();
    expect(opens).toBe(2);
    expect(errors.some((e) => e.message.includes('not reopened'))).toBe(true);
  });
});
