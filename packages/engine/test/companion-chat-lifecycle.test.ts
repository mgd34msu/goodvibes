/**
 * companion-chat-lifecycle.test.ts
 *
 * Verifies the session lifecycle:
 * create → message → close, happy path
 * closed sessions reject further messages with 409
 * sessions that were never found return 404
 * idle GC never closes a chat; the next send continues it with its history
 * GC leaves sessions with recent activity alone
 */

import { describe, expect, test } from 'bun:test';
import { installFrozenNow, waitFor } from './_helpers/test-timeout.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../platform/src/platform/companion/companion-chat-manager.js';

const disposables = trackDisposables();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(reply = 'response'): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'text_delta', delta: reply } satisfies CompanionProviderChunk;
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

function makeManager(overrides: { idleActiveMs?: number; idleEmptyMs?: number } = {}): CompanionChatManager {
  return disposables.add(
    new CompanionChatManager({
      provider: makeMockProvider(),
      eventPublisher: { publishEvent() {} },
      gcIntervalMs: 999_999, // disable automatic GC; we call _gcSweep() manually
      idleActiveMs: overrides.idleActiveMs ?? 30 * 60_000,
      idleEmptyMs: overrides.idleEmptyMs ?? 5 * 60_000,
    }),
  );
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('create → message → close lifecycle', () => {
  test('full lifecycle completes without error', async () => {
    const manager = makeManager();

    const session = manager.createSession({ title: 'My chat', provider: 'anthropic', model: 'claude-sonnet' });
    expect(session.id).not.toBe('');
    expect(session.kind).toBe('companion-chat');
    expect(session.status).toBe('active');

    // Post a message
    const messageId = await manager.postMessage(session.id, 'Hello');
    expect(typeof messageId).toBe('string');

    await waitFor(() => manager.getMessages(session.id).some((message) => message.role === 'assistant'));

    // Messages should include user + assistant
    const messages = manager.getMessages(session.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('Hello');

    // Close
    const closed = manager.closeSession(session.id);
    expect(closed?.status).toBe('closed');
    expect(typeof closed?.closedAt).toBe('number');

    // getSession still returns the closed session
    const retrieved = manager.getSession(session.id);
    expect(retrieved?.status).toBe('closed');
  });

  test('session metadata is correct immediately after creation', () => {
    const manager = makeManager();
    const session = manager.createSession({ title: 'Test', model: 'gpt-5', provider: 'openai', systemPrompt: 'Be helpful' });
    expect(session.kind).toBe('companion-chat');
    expect(session.title).toBe('Test');
    expect(session.model).toBe('gpt-5');
    expect(session.provider).toBe('openai');
    expect(session.systemPrompt).toBe('Be helpful');
    expect(session.status).toBe('active');
    expect(session.messageCount).toBe(0);
  });

  test('session route metadata requires provider and model together', () => {
    const manager = makeManager();
    expect(() => manager.createSession({ title: 'Partial route', model: 'gpt-5' })).toThrow(
      'provider and model must be supplied together',
    );
  });
});

// ---------------------------------------------------------------------------
// Closed sessions reject messages with 409
// ---------------------------------------------------------------------------

describe('closed sessions reject further messages', () => {
  test('postMessage on a closed session throws with status 409', async () => {
    const manager = makeManager();
    const session = manager.createSession();
    manager.closeSession(session.id);

    await expect(manager.postMessage(session.id, 'should fail')).rejects.toMatchObject({
      status: 409,
      code: 'SESSION_CLOSED',
    });
  });

  test('closing an already-closed session is idempotent (returns session, status still closed)', () => {
    const manager = makeManager();
    const session = manager.createSession();
    const first = manager.closeSession(session.id);
    const second = manager.closeSession(session.id);
    expect(first?.status).toBe('closed');
    expect(second?.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Non-existent sessions return 404
// ---------------------------------------------------------------------------

describe('non-existent sessions', () => {
  test('getSession returns null for unknown id', () => {
    const manager = makeManager();
    expect(manager.getSession('no-such-id')).toBeNull();
  });

  test('postMessage on unknown session throws with status 404', async () => {
    const manager = makeManager();
    await expect(manager.postMessage('no-such-id', 'hello')).rejects.toMatchObject({
      status: 404,
      code: 'SESSION_NOT_FOUND',
    });
  });

  test('closeSession returns null for unknown id', () => {
    const manager = makeManager();
    expect(manager.closeSession('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idleness never closes a chat: the GC drops its history from memory and the
// next send rebuilds it, so the conversation continues where it was.
// ---------------------------------------------------------------------------

describe('GC keeps idle chats open', () => {
  test('an idle chat stays open and its next send carries the earlier history', async () => {
    const seen: string[][] = [];
    const manager = disposables.add(new CompanionChatManager({
      provider: {
        async *chatStream(messages) {
          seen.push(messages.map((message) => `${message.role}:${typeof message.content === 'string' ? message.content : ''}`));
          yield { type: 'text_delta', delta: `answer ${seen.length}` } satisfies CompanionProviderChunk;
          yield { type: 'done' } satisfies CompanionProviderChunk;
        },
      },
      eventPublisher: { publishEvent() {} },
      gcIntervalMs: 999_999,
      idleActiveMs: 0,
      idleEmptyMs: 0,
    }));
    const session = manager.createSession();
    await manager.postMessage(session.id, 'first');
    await waitFor(() => manager.getMessages(session.id).some((message) => message.role === 'assistant'));

    manager._gcSweep();
    expect(manager.getSession(session.id)?.status).toBe('active');

    await manager.postMessage(session.id, 'second');
    await waitFor(() => manager.getMessages(session.id).filter((message) => message.role === 'assistant').length === 2);
    expect(seen[1]).toEqual(['user:first', 'assistant:answer 1', 'user:second']);
  });
});

// ---------------------------------------------------------------------------
// GC leaves recently-active sessions alone
// ---------------------------------------------------------------------------

describe('GC does not close recently-active sessions', () => {
  test('session with recent activity survives _gcSweep()', async () => {
    const manager = makeManager({ idleEmptyMs: 100, idleActiveMs: 100 });
    const session = manager.createSession();

    await manager.postMessage(session.id, 'Recent message');
    await waitFor(() => manager.getMessages(session.id).some((message) => message.role === 'assistant'));

    // The clock is held at the activity time, so a slow host cannot age the session past the window.
    const restore = installFrozenNow(Date.now());
    try {
      (manager as unknown as { sessions: Map<string, { lastActivityAt: number }> }).sessions.get(session.id)!.lastActivityAt = Date.now();
      manager._gcSweep();
    } finally {
      restore();
    }

    expect(manager.getSession(session.id)?.status).toBe('active');
  });
});
