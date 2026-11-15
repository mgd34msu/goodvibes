/**
 * companion-chat-session-isolation.test.ts
 *
 * Verifies:
 * Events for session A do NOT appear in session B's event stream.
 * Chat session events do NOT appear in the global (TUI-visible) event feed.
 * Two concurrent sessions can exchange messages without cross-contamination.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionChatEventPublisher,
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../platform/src/platform/companion/companion-chat-manager.js';

const disposables = trackDisposables();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(reply = 'ok'): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'text_delta', delta: reply } satisfies CompanionProviderChunk;
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

type PublishedEvent = {
  event: string;
  payload: unknown;
  filter?: { clientId?: string; clientIdPrefix?: string; [k: string]: unknown };
};

function makeTrackingPublisher(): CompanionChatEventPublisher & { events: PublishedEvent[] } {
  const events: PublishedEvent[] = [];
  return {
    events,
    publishEvent(event, payload, filter?) {
      events.push({ event, payload, ...(filter !== undefined ? { filter } : {}) });
    },
  };
}

function eventsForClient(events: PublishedEvent[], clientId: string): PublishedEvent[] {
  return events.filter((e) => !e.filter?.clientId || e.filter.clientId === clientId);
}

function eventsNotForClient(events: PublishedEvent[], clientId: string): PublishedEvent[] {
  return events.filter((e) => e.filter?.clientId && e.filter.clientId !== clientId);
}

// ---------------------------------------------------------------------------
// Events for session A don't bleed into session B
// ---------------------------------------------------------------------------

describe('session-scoped event isolation', () => {
  let publisher: ReturnType<typeof makeTrackingPublisher>;
  let manager: CompanionChatManager;

  beforeEach(() => {
    publisher = makeTrackingPublisher();
    manager = disposables.add(
      new CompanionChatManager({
        provider: makeMockProvider('reply'),
        eventPublisher: publisher,
        gcIntervalMs: 999_999,
      }),
    );
  });

  test('events for session A carry session A clientId, not session B clientId', async () => {
    const sessionA = manager.createSession({ title: 'Session A' });
    const sessionB = manager.createSession({ title: 'Session B' });

    const clientIdA = `companion-chat:${sessionA.id}`;
    const clientIdB = `companion-chat:${sessionB.id}`;

    manager.registerSubscriber(sessionA.id, clientIdA);
    manager.registerSubscriber(sessionB.id, clientIdB);

    // Post a message to session A only
    await manager.postMessage(sessionA.id, 'Hello from A');
    await settleEvents();

    // All A events should carry clientId A
    const aEvents = eventsForClient(publisher.events, clientIdA);
    expect(aEvents.map((event) => event.event)).toEqual([
      'companion-chat.turn.started',
      'companion-chat.turn.delta',
      'companion-chat.turn.completed',
    ]);

    // None of session A's events should carry session B's clientId
    const wrongClientEvents = publisher.events.filter(
      (e) => e.filter?.clientId === clientIdB,
    );
    expect(wrongClientEvents).toHaveLength(0);
  });

  test('session B events do not appear when only session A posts', async () => {
    const sessionA = manager.createSession();
    const sessionB = manager.createSession();

    const clientIdA = `companion-chat:${sessionA.id}`;
    manager.registerSubscriber(sessionA.id, clientIdA);
    // Session B has NO registered subscriber, simulates "nobody is listening"

    await manager.postMessage(sessionA.id, 'Only A talks');
    await settleEvents();

    // No events should be scoped to session B's ID
    const bId = sessionB.id;
    const sessionBPayloads = publisher.events.filter((e) => {
      const p = e.payload as { sessionId?: string };
      return p.sessionId === bId;
    });
    expect(sessionBPayloads).toHaveLength(0);
  });

  test('concurrent sessions A and B both complete without cross-contamination', async () => {
    const sessionA = manager.createSession({ title: 'A' });
    const sessionB = manager.createSession({ title: 'B' });

    const clientIdA = `companion-chat:${sessionA.id}`;
    const clientIdB = `companion-chat:${sessionB.id}`;

    manager.registerSubscriber(sessionA.id, clientIdA);
    manager.registerSubscriber(sessionB.id, clientIdB);

    // Post to both concurrently
    await Promise.all([
      manager.postMessage(sessionA.id, 'Message A'),
      manager.postMessage(sessionB.id, 'Message B'),
    ]);
    await settleEvents(100);

    // Events scoped to A should only have sessionId=A
    const aEvents = publisher.events.filter((e) => e.filter?.clientId === clientIdA);
    for (const e of aEvents) {
      const p = e.payload as { sessionId?: string };
      expect(p.sessionId).toBe(sessionA.id);
    }

    // Events scoped to B should only have sessionId=B
    const bEvents = publisher.events.filter((e) => e.filter?.clientId === clientIdB);
    for (const e of bEvents) {
      const p = e.payload as { sessionId?: string };
      expect(p.sessionId).toBe(sessionB.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Chat events don't leak into the global/TUI control-plane feed
// ---------------------------------------------------------------------------

describe('no leak into global control-plane feed', () => {
  test('all published events carry a clientId filter (never broadcast to all clients)', async () => {
    const publisher = makeTrackingPublisher();
    const manager = disposables.add(
      new CompanionChatManager({
        provider: makeMockProvider('response text'),
        eventPublisher: publisher,
        gcIntervalMs: 999_999,
      }),
    );

    const session = manager.createSession();
    manager.registerSubscriber(session.id, `companion-chat:${session.id}`);

    await manager.postMessage(session.id, 'Test message');
    await settleEvents();

    // Every event must carry a non-empty client filter.
    // Events without one would broadcast to ALL connected SSE clients
    // (including the TUI), which violates isolation.
    expect(publisher.events.length).toBeGreaterThan(0);
    for (const e of publisher.events) {
      expect(e.filter?.clientIdPrefix).toBe(`companion-chat:${session.id}:`);
    }
  });

  test('two readers of one chat both stay addressed, whichever registered last or closed', async () => {
    const publisher = makeTrackingPublisher();
    const manager = disposables.add(
      new CompanionChatManager({
        provider: makeMockProvider('shared'),
        eventPublisher: publisher,
        gcIntervalMs: 999_999,
      }),
    );
    const session = manager.createSession();
    const first = `companion-chat:${session.id}:first`;
    const second = `companion-chat:${session.id}:second`;
    manager.registerSubscriber(session.id, first);
    manager.registerSubscriber(session.id, second);

    await manager.postMessage(session.id, 'Both readers');
    await settleEvents();

    expect(publisher.events.length).toBeGreaterThan(0);
    for (const e of publisher.events) {
      expect(e.filter?.clientId).toBeUndefined();
      const prefix = e.filter?.clientIdPrefix;
      expect(typeof prefix).toBe('string');
      expect(first.startsWith(prefix as string)).toBe(true);
      expect(second.startsWith(prefix as string)).toBe(true);
    }
  });

  test('events published without a subscriber carry a session-scoped clientId (no global broadcast)', async () => {
    const publisher = makeTrackingPublisher();
    const manager = disposables.add(
      new CompanionChatManager({
        provider: makeMockProvider('ignored'),
        eventPublisher: publisher,
        gcIntervalMs: 999_999,
      }),
    );

    const session = manager.createSession();
    // Deliberately do NOT call registerSubscriber
    await manager.postMessage(session.id, 'No subscriber');
    await settleEvents();

    expect(publisher.events.length).toBeGreaterThan(0);
    for (const e of publisher.events) {
      expect(e.filter?.clientIdPrefix).toBe(`companion-chat:${session.id}:`);
    }
  });
});

// ---------------------------------------------------------------------------
// Message history isolation
// ---------------------------------------------------------------------------

describe('conversation history isolation', () => {
  test('session A conversation does not share messages with session B', async () => {
    const publisher = makeTrackingPublisher();
    const manager = disposables.add(
      new CompanionChatManager({
        provider: makeMockProvider('fine'),
        eventPublisher: publisher,
        gcIntervalMs: 999_999,
      }),
    );

    const sessionA = manager.createSession();
    const sessionB = manager.createSession();

    await manager.postMessage(sessionA.id, 'Only for A');
    await settleEvents();

    const msgsA = manager.getMessages(sessionA.id);
    const msgsB = manager.getMessages(sessionB.id);

    // A has messages, B has none (no message posted to B)
    expect(msgsA.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(msgsB).toHaveLength(0);

    // A's messages all belong to session A
    for (const m of msgsA) {
      expect(m.sessionId).toBe(sessionA.id);
    }
  });
});
