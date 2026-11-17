/**
 * The tab's one event-stream owner: the connection budget it keeps and the
 * revocation it honours.
 *
 * The real client, transport and event-stream owner run against a daemon stand-in
 * on loopback that records every event-stream connection it receives; the
 * assertions are on what arrived at the wire.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { nativeRequestPrimitives } from '../test-setup';

// The page environment's own fetch cannot read a stream; a browser's can, so the platform's is put back.
Object.assign(globalThis, nativeRequestPrimitives);

interface Connection {
  readonly path: string;
  readonly send: (event: string, payload: unknown) => void;
  readonly closed: Promise<void>;
  isClosed: boolean;
}

const connections: Connection[] = [];
const arrivals: (() => void)[] = [];
const encoder = new TextEncoder();
const daemon = Bun.serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/control-plane/events') return new Response('not found', { status: 404 });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const closed = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      cancel() { closed.resolve(); },
    });
    const connection: Connection = {
      path: `${url.pathname}${url.search}`,
      send: (event, payload) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)),
      closed: closed.promise,
      isClosed: false,
    };
    void closed.promise.then(() => { connection.isClosed = true; });
    request.signal.addEventListener('abort', () => closed.resolve());
    connections.push(connection);
    connection.send('ready', {});
    for (const arrived of arrivals.splice(0)) arrived();
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  },
});

// The client reads its daemon address when it is first imported.
process.env.VITE_GOODVIBES_BASE_URL = `http://127.0.0.1:${daemon.port}`;
const { subscribeEvents, subscribeEventStreamState } = await import('./event-stream');
const { invalidateClientLifetime } = await import('./client-lifetime');

/** Resolves once the daemon has received `count` event-stream connections in total. */
async function connectionsArrived(count: number): Promise<void> {
  while (connections.length < count) await new Promise<void>((resolve) => { arrivals.push(resolve); });
}

const unsubscribers: (() => void)[] = [];
beforeAll(() => { connections.length = 0; });
afterEach(async () => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  await Promise.all(connections.map((connection) => connection.closed));
  connections.length = 0;
});
afterAll(() => daemon.stop(true));

test('every subscriber of a signed-in tab with a session detail and a hosted session open shares two connections', async () => {
  const ready: Promise<void>[] = [];
  const subscribe = (domains: string[], events: string[]) => {
    const seen = Promise.withResolvers<void>();
    ready.push(seen.promise);
    unsubscribers.push(subscribeEvents({ domains: domains as never, events, onEvent: () => {}, onReady: () => seen.resolve() }));
  };
  // App-wide invalidation, session lifecycle and approvals; then a session detail's
  // compaction receipts and an attached hosted session's output and lifecycle.
  subscribe(['tasks', 'contracts', 'gate', 'providers', 'knowledge', 'control-plane', 'fleet', 'ops', 'session'], ['tasks']);
  subscribe(['compaction'], ['compaction']);
  subscribe(['turn', 'tools'], ['turn', 'tools']);
  subscribe(['session'], ['hosted-session-update']);
  await Promise.all(ready);
  expect(connections.filter((connection) => !connection.isClosed).map((connection) => connection.path).sort()).toEqual([
    '/api/control-plane/events?domains=compaction,tools,turn',
    '/api/control-plane/events?domains=contracts,control-plane,fleet,gate,knowledge,ops,providers,session,tasks',
  ]);
});

test('a revoked credential closes the lane without reconnecting with it, and a new credential reopens it', async () => {
  const ended = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  unsubscribers.push(subscribeEvents({ domains: ['tasks'], events: ['tasks'], onEvent: () => {}, onReady: () => ready.resolve() }));
  await ready.promise;
  expect(connections).toHaveLength(1);
  unsubscribers.push(subscribeEventStreamState(() => ended.resolve()));
  connections[0]!.send('closed', { reason: 'credential-revoked', next: 'Sign in again or pair this device again, then reconnect.' });
  await ended.promise;
  await connections[0]!.closed;
  expect(connections).toHaveLength(1);
  invalidateClientLifetime();
  await connectionsArrived(2);
  expect(connections[1]!.path).toBe('/api/control-plane/events?domains=tasks');
});
