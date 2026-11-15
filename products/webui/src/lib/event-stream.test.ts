/**
 * The tab's one event-stream owner: the connection budget it keeps and the revocation
 * it honours.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

const open = new Map<string, { handlers: ServerSentEventHandlers; closed: boolean }>();
let opens = 0;

mock.module('./goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  client: {
    streams: {
      open: (path: string, handlers: ServerSentEventHandlers) => {
        opens += 1;
        const entry = { handlers, closed: false };
        open.set(path, entry);
        return Promise.resolve(() => { entry.closed = true; });
      },
    },
  },
}));

const { subscribeEvents, subscribeEventStreamState } = await import('./event-stream');
const { invalidateClientLifetime } = await import('./client-lifetime');

const unsubscribers: (() => void)[] = [];
const settle = async () => { for (let index = 0; index < 4; index++) await Promise.resolve(); };
const liveConnections = () => [...open.values()].filter((entry) => !entry.closed).length;

afterEach(async () => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  await settle();
  open.clear();
  opens = 0;
});

test('every subscriber of a signed-in tab with a session detail and a hosted session open shares two connections', async () => {
  const noop = () => {};
  // App-wide invalidation, session lifecycle and approvals; then a session detail's
  // compaction receipts and an attached hosted session's output and lifecycle.
  unsubscribers.push(
    subscribeEvents({ domains: ['tasks', 'contracts', 'gate', 'providers', 'knowledge', 'control-plane', 'fleet', 'ops', 'session'], events: ['tasks'], onEvent: noop }),
    subscribeEvents({ domains: ['compaction'], events: ['compaction'], onEvent: noop }),
    subscribeEvents({ domains: ['turn', 'tools'], events: ['turn', 'tools'], onEvent: noop }),
    subscribeEvents({ domains: ['session'], events: ['hosted-session-update'], onEvent: noop }),
  );
  await settle();
  expect(opens).toBe(2);
  expect(liveConnections()).toBe(2);
  expect([...open.keys()].sort()).toEqual([
    '/api/control-plane/events?domains=compaction,tools,turn',
    '/api/control-plane/events?domains=contracts,control-plane,fleet,gate,knowledge,ops,providers,session,tasks',
  ]);
});

test('frames reach only the subscribers that handle their name', async () => {
  const seen: string[] = [];
  unsubscribers.push(
    subscribeEvents({ domains: ['gate'], events: ['approval-update'], onEvent: (name) => seen.push(`a:${name}`) }),
    subscribeEvents({ domains: ['session'], events: ['session-update'], onEvent: (name) => seen.push(`b:${name}`) }),
  );
  await settle();
  const stream = [...open.values()][0];
  stream?.handlers.onEvent?.('approval-update', {});
  stream?.handlers.onEvent?.('session-update', {});
  stream?.handlers.onEvent?.('heartbeat', {});
  expect(seen).toEqual(['a:approval-update', 'b:session-update']);
});

test('a revoked credential ends the lane with the daemon\'s next step and a new credential reopens it', async () => {
  let changes = 0;
  unsubscribers.push(subscribeEventStreamState(() => { changes += 1; }));
  unsubscribers.push(subscribeEvents({ domains: ['tasks'], events: ['tasks'], onEvent: () => {} }));
  await settle();
  const first = [...open.values()][0];
  first?.handlers.onEvent?.('closed', { reason: 'credential-revoked', next: 'Sign in again or pair this device again, then reconnect.' });
  expect(first?.closed).toBe(true);
  expect(changes).toBeGreaterThan(0);
  expect(opens).toBe(1);
  invalidateClientLifetime();
  await settle();
  expect(opens).toBe(2);
});
