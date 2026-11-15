/**
 * companion-chat-transcript-custody.test.ts
 *
 * A chat's saved transcript is never replaced by a smaller in-memory copy, a
 * failed delete leaves the chat deletable, and a storage refusal names the
 * actual cause (a failed write versus a service that is going away).
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatManagerConfig, CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-manager.js';
import { CompanionChatPersistence } from '../platform/src/platform/companion/companion-chat-persistence.js';
import { AtomicWriteDurabilityError } from '../platform/src/platform/utils/atomic-json-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const managers: CompanionChatManager[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const answers: CompanionLLMProvider = {
  async *chatStream() { yield { type: 'text_delta', delta: 'answer' }; yield { type: 'done' }; },
};

function fixture(options: Partial<CompanionChatManagerConfig> = {}) {
  const root = makeProjectTempDir('companion-transcript-custody');
  roots.push(root);
  const manager = new CompanionChatManager({
    persist: true, sessionsDir: root, rateLimiter: false, gcIntervalMs: 999_999,
    eventPublisher: { publishEvent() {} }, provider: answers, ...options,
  });
  managers.push(manager);
  return { root, manager };
}

test('a close whose save failed, swept after the grace, cannot be recovered over the saved transcript', async () => {
  const f = fixture({ closedSessionMemoryGraceMs: 0 });
  const session = f.manager.createSession();
  await f.manager.postMessageAndWaitForReply(session.id, 'keep this');
  await f.manager.flushSession(session.id);
  expect(f.manager.getMessages(session.id)).toHaveLength(2);

  const failing = spyOn(CompanionChatPersistence.prototype, 'save').mockImplementation(async () => {
    throw new Error('no space left on device');
  });
  f.manager.closeSession(session.id);
  await expect(f.manager.flushSession(session.id)).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' });

  // The grace has passed (it is zero), so the sweep runs its eviction.
  f.manager._gcSweep();
  expect(f.manager.getMessages(session.id)).toHaveLength(2);
  expect(f.manager.getSession(session.id)?.messageCount).toBe(2);

  failing.mockRestore();
  expect(await f.manager.recoverFailedSaves()).toBe(1);

  const onDisk = (await new CompanionChatPersistence(f.root).loadAll()).find((entry) => entry.meta.id === session.id);
  expect(onDisk?.messages.map((message) => message.content)).toEqual(['keep this', 'answer']);
  expect(onDisk?.meta.status).toBe('closed');
});

test('a closed chat past the grace still returns its whole transcript, matching its message count', async () => {
  const f = fixture({ closedSessionMemoryGraceMs: 0 });
  const session = f.manager.createSession();
  await f.manager.postMessageAndWaitForReply(session.id, 'question');
  f.manager.closeSession(session.id);
  await f.manager.flushSession(session.id);
  f.manager._gcSweep();
  f.manager._gcSweep();
  const meta = f.manager.getSession(session.id);
  expect(meta?.status).toBe('closed');
  expect(f.manager.getMessages(session.id)).toHaveLength(meta?.messageCount ?? -1);
  expect(f.manager.getMessages(session.id).length).toBeGreaterThan(0);
});

test('a delete whose unlink fails leaves the chat known, and a later delete works', async () => {
  const f = fixture();
  const session = f.manager.createSession();
  await f.manager.postMessageAndWaitForReply(session.id, 'to delete');
  f.manager.closeSession(session.id);
  await f.manager.flushSession(session.id);

  const failing = spyOn(CompanionChatPersistence.prototype, 'delete').mockRejectedValue(new Error('permission denied'));
  await expect(f.manager.deleteSession(session.id)).rejects.toThrow('permission denied');
  failing.mockRestore();

  expect(f.manager.getSession(session.id)?.status).toBe('closed');
  expect(await f.manager.deleteSession(session.id)).toEqual({ sessionId: session.id, deleted: true });
  expect(f.manager.getSession(session.id)).toBeNull();
  expect((await new CompanionChatPersistence(f.root).loadAll()).some((entry) => entry.meta.id === session.id)).toBe(false);
});

test('a metadata change whose write fails says the write failed, not that the service is shutting down', async () => {
  const f = fixture();
  const session = f.manager.createSession();
  await f.manager.flushSession(session.id);
  const failing = spyOn(CompanionChatPersistence.prototype, 'saveSync').mockImplementation(() => {
    throw new Error('read-only file system');
  });
  const error = await f.manager.updateSessionPersisted(session.id, { title: 'new title' }).then(() => null, (cause: unknown) => cause);
  failing.mockRestore();
  expect(error).toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE', status: 503 });
  expect((error as Error).message).toContain('Saving this chat failed');
  expect((error as Error).message).toContain('read-only file system');
  expect((error as Error).message).not.toContain('shutting down');
});

test('a save that may have been published tells the operator to restart, not to wait for a retry', async () => {
  const f = fixture();
  const failing = spyOn(CompanionChatPersistence.prototype, 'save').mockImplementation(async () => {
    throw new AtomicWriteDurabilityError('chat.json', 'published-indeterminate', new Error('fsync failed'));
  });
  const session = f.manager.createSession();
  const error = await f.manager.flushSession(session.id).then(() => null, (cause: unknown) => cause);
  failing.mockRestore();
  expect(error).toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
  expect((error as Error).message).toContain('Restart the daemon');
  expect((error as Error).message).not.toContain('retries saving it on its own');
});
