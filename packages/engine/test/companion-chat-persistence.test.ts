/**
 * companion-chat-persistence.test.ts
 *
 * Verifies that CompanionChatManager persists sessions to disk and restores
 * them on re-instantiation (simulating daemon restart).
 *
 * Sessions written during one manager lifetime load into a fresh instance.
 * Messages (user + assistant) are restored in order.
 * Closed sessions SURVIVE restart (closed-skip fix) and stay GC-eligible.
 * Session directory is created if it does not exist.
 */

import { describe, expect, test } from 'bun:test';
import { waitFor, withTestTimeout } from './_helpers/test-timeout.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import { CompanionChatPersistence } from '../platform/src/platform/companion/companion-chat-persistence.js';
import type { PersistedChatSession } from '../platform/src/platform/companion/companion-chat-persistence.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../platform/src/platform/companion/companion-chat-manager.js';

const disposables = trackDisposables();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(reply = 'hi there'): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'text_delta', delta: reply } satisfies CompanionProviderChunk;
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

function makeManager(
  sessionsDir: string,
  overrides: {
    readonly closedSessionMemoryGraceMs?: number;
    readonly closedSessionRetentionMs?: number;
  } = {},
): CompanionChatManager {
  return disposables.add(new CompanionChatManager({
    provider: makeMockProvider(),
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999, // disable automatic GC
    persist: true, // explicitly opt into disk persistence, this file tests persistence behaviour
    sessionsDir,
    rateLimiter: false, // disable rate limiting in tests
    ...(overrides.closedSessionMemoryGraceMs !== undefined ? { closedSessionMemoryGraceMs: overrides.closedSessionMemoryGraceMs } : {}),
    ...(overrides.closedSessionRetentionMs !== undefined ? { closedSessionRetentionMs: overrides.closedSessionRetentionMs } : {}),
  }));
}

/** A chat saved by an earlier version as one file; start-up converts it. */
function seedSavedChat(sessionsDir: string, chat: PersistedChatSession): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${chat.meta.id}.json`), JSON.stringify(chat));
}

function makePersistedSession(id: string): PersistedChatSession {
  const now = Date.now();
  return {
    meta: {
      id,
      kind: 'companion-chat',
      title: 'Chat',
      model: null,
      provider: null,
      systemPrompt: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      messageCount: 0,
    },
    messages: [],
  };
}

// ---------------------------------------------------------------------------
// Sessions restored across manager re-instantiation
// ---------------------------------------------------------------------------

describe('active sessions restored on re-instantiation', () => {
  test('session created in instance A is visible in instance B after init()', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const managerA = makeManager(sessionsDir);
      await managerA.init();

      const session = managerA.createSession({ title: 'My chat' });
      expect(session.status).toBe('active');

      await managerA.close(); // drains the pending save

      // Simulate daemon restart
      const managerB = makeManager(sessionsDir);
      await managerB.init();

      const restored = managerB.getSession(session.id);
      expect(restored).not.toBeNull();
      expect(restored!.id).toBe(session.id);
      expect(restored!.title).toBe('My chat');
      expect(restored!.status).toBe('active');

      managerB.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Messages (user + assistant) restored in order
// ---------------------------------------------------------------------------

describe('messages restored in order after restart', () => {
  test('user and assistant messages are available after reload', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const managerA = makeManager(sessionsDir);
      await managerA.init();

      const session = managerA.createSession();
      await managerA.postMessage(session.id, 'Hello world');

      await waitFor(() => managerA.getMessages(session.id).some((message) => message.role === 'assistant'));

      const msgsA = managerA.getMessages(session.id);
      expect(msgsA.length).toBeGreaterThanOrEqual(1);
      expect(msgsA[0]!.role).toBe('user');
      expect(msgsA[0]!.content).toBe('Hello world');
      const revision = msgsA[0]!.contentRevision;
      expect(typeof revision).toBe('string');
      expect(managerA.getMessages(session.id)[0]).toBe(msgsA[0]);
      expect(managerA.getMessage(session.id, msgsA[0]!.id)).toBe(msgsA[0]);
      expect(Object.isFrozen(msgsA[0])).toBe(true);
      expect(Reflect.set(msgsA[0]!, 'content', 'foreign text')).toBe(false);
      msgsA.splice(0, 1);
      expect(managerA.getMessages(session.id)[0]!.content).toBe('Hello world');

      await managerA.close();

      // Simulate daemon restart
      const managerB = makeManager(sessionsDir);
      await managerB.init();

      const msgsB = managerB.getMessages(session.id);
      expect(msgsB.length).toBeGreaterThanOrEqual(1);
      expect(msgsB[0]!.role).toBe('user');
      expect(msgsB[0]!.content).toBe('Hello world');
      expect(typeof msgsB[0]!.contentRevision).toBe('string');
      expect(msgsB[0]!.contentRevision).not.toBe(revision);

      // Assert order is preserved
      for (let i = 0; i < msgsB.length - 1; i++) {
        expect(msgsB[i]!.createdAt).toBeLessThanOrEqual(msgsB[i + 1]!.createdAt);
      }

      managerB.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Closed sessions SURVIVE restart (closed-skip data-loss fix) and
// are HISTORY. The old behavior dropped closed sessions on reload, the exact
// "299 on-disk, serves 0" bug. They must now load (listable + importable). GC's
// deletion authority is SPLIT: it may evict replay state from memory after a
// grace (meta and transcript stay, on-disk copy untouched), but it must NOT delete
// the persisted file unless an explicit finite retention window is configured.
// ---------------------------------------------------------------------------

describe('closed sessions survive restart and stay listable', () => {
  test('a session closed before shutdown loads after restart (closed-skip fix)', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const managerA = makeManager(sessionsDir);
      await managerA.init();

      const session = managerA.createSession();
      managerA.closeSession(session.id);

      await managerA.close();

      // Restart
      const managerB = makeManager(sessionsDir);
      await managerB.init();

      // Closed sessions are now retained in a lightweight terminal state.
      const restored = managerB.getSession(session.id);
      expect(restored).not.toBeNull();
      expect(restored?.status).toBe('closed');
      // listSessions({includeClosed:true}) must not silently return fewer than on-disk.
      expect(managerB.listSessions({ includeClosed: true }).sessions.map((s) => s.id)).toContain(session.id);
      // Default list still hides closed sessions.
      expect(managerB.listSessions().sessions.map((s) => s.id)).not.toContain(session.id);

      managerB.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('default retention: an ancient-closed session survives the sweep: listable and on disk', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-gc-'));
    try {
      // Seed a closed session whose closedAt is well past the OLD 5-min grace.
      const stale: PersistedChatSession = {
        meta: {
          id: 'stale-closed', kind: 'companion-chat', title: 'Stale', model: null, provider: null,
          systemPrompt: null, status: 'closed', createdAt: 1, updatedAt: 1,
          closedAt: Date.now() - 10 * 60_000, messageCount: 0,
        },
        messages: [],
      };
      seedSavedChat(sessionsDir, stale);

      const manager = makeManager(sessionsDir); // default retention = indefinite
      await manager.init();
      expect(manager.getSession('stale-closed')).not.toBeNull();
      // Sweep runs but must NOT delete under the default (retain indefinitely).
      manager._gcSweep();
      expect(manager.getSession('stale-closed')).not.toBeNull();
      expect(manager.listSessions({ includeClosed: true }).sessions.map((s) => s.id)).toContain('stale-closed');
      manager.dispose();

      // Still on disk, a fresh manager reloads it.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getSession('stale-closed')).not.toBeNull();
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('memory eviction: an ancient-closed session leaves memory and reads back whole from disk', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-evict-'));
    try {
      const stale: PersistedChatSession = {
        meta: {
          id: 'evict-me', kind: 'companion-chat', title: 'Evict', model: null, provider: null,
          systemPrompt: null, status: 'closed', createdAt: 1, updatedAt: 1,
          closedAt: Date.now() - 10 * 60_000, messageCount: 2,
        },
        messages: [
          { id: 'm1', sessionId: 'evict-me', role: 'user', content: 'hi', attachments: [], createdAt: 2 },
          { id: 'm2', sessionId: 'evict-me', role: 'assistant', content: 'yo', attachments: [], createdAt: 3 },
        ],
      };
      seedSavedChat(sessionsDir, stale);

      const manager = makeManager(sessionsDir, { closedSessionMemoryGraceMs: 5 * 60_000 });
      await manager.init();
      expect(manager.getMessages('evict-me')).toHaveLength(2);

      manager._gcSweep(); // past grace → transcript and history leave memory
      // Reading the chat again loads the transcript from disk: never an empty list next to a count of 2.
      expect(manager.getSession('evict-me')?.status).toBe('closed');
      expect(manager.getMessages('evict-me')).toHaveLength(2);
      expect(manager.getSession('evict-me')?.messageCount).toBe(2);
      manager.dispose();

      // On-disk copy is UNTOUCHED, a fresh manager restores the bodies.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getMessages('evict-me')).toHaveLength(2);
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('explicit retention window: a closed session past the window IS deleted (opt-in)', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-retain-'));
    try {
      const stale: PersistedChatSession = {
        meta: {
          id: 'retire-me', kind: 'companion-chat', title: 'Retire', model: null, provider: null,
          systemPrompt: null, status: 'closed', createdAt: 1, updatedAt: 1,
          closedAt: Date.now() - 10 * 60_000, messageCount: 0,
        },
        messages: [],
      };
      seedSavedChat(sessionsDir, stale);

      const manager = makeManager(sessionsDir, { closedSessionRetentionMs: 5 * 60_000 });
      await manager.init();
      expect(manager.getSession('retire-me')).not.toBeNull();
      manager._gcSweep(); // past the finite retention window → delete
      await waitFor(() => manager.getSession('retire-me') === null);
      expect(readdirSync(sessionsDir).filter((name) => name.startsWith('retire-me') && !name.endsWith('.migrated'))).toEqual([]);
      manager.dispose();

      // Deleted from disk too.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getSession('retire-me')).toBeNull();
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Sessions directory is created if it does not exist
// ---------------------------------------------------------------------------

describe('sessions directory created if missing', () => {
  test('manager creates nested sessions directory automatically', async () => {
    const base = mkdtempSync(join(tmpdir(), 'companion-base-'));
    const sessionsDir = join(base, 'deep', 'nested', 'sessions');
    try {
      const manager = makeManager(sessionsDir);
      await manager.init(); // should not throw even if dir doesn't exist

      const session = manager.createSession({ title: 'Auto-created dir' });

      // Confirm the session was persisted (directory was auto-created)
      manager.dispose();

      const manager2 = makeManager(sessionsDir);
      await manager2.init();
      const restored = manager2.getSession(session.id);
      expect(restored).not.toBeNull();
      manager2.dispose();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Persistence failures reject instead of pretending success
// ---------------------------------------------------------------------------

describe('persistence failures are observable', () => {
  test('a summary save throws when its file cannot be replaced', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const persistence = new CompanionChatPersistence(sessionsDir);
      mkdirSync(join(sessionsDir, 'blocked.meta.json'));

      expect(() => persistence.writeMeta(makePersistedSession('blocked').meta)).toThrow();
      expect(existsSync(join(sessionsDir, 'blocked.meta.json'))).toBe(true);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('delete rejects when the session path cannot be unlinked', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const persistence = new CompanionChatPersistence(sessionsDir);
      mkdirSync(join(sessionsDir, 'blocked.json'));

      await expect(persistence.delete('blocked')).rejects.toThrow(
        'Companion chat session delete failed for blocked',
      );
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Close then delete leaves nothing a restart could reload.
// ---------------------------------------------------------------------------

describe('deleteSession after closeSession', () => {
  test('removes every file of the chat, so a restart does not bring it back', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-race-'));
    try {
      const manager = makeManager(sessionsDir);
      await manager.init();

      const session = manager.createSession();
      await manager.postMessage(session.id, 'hello');
      await waitFor(() => manager.getMessages(session.id).some((message) => message.role === 'assistant'));
      manager.closeSession(session.id);
      const result = await withTestTimeout(manager.deleteSession(session.id), 2_000, 'deleteSession did not settle');
      expect(result).toEqual({ sessionId: session.id, deleted: true });
      await manager.close();
      expect(readdirSync(sessionsDir).filter((name) => name.startsWith(session.id))).toEqual([]);

      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getSession(session.id)).toBeNull();
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
