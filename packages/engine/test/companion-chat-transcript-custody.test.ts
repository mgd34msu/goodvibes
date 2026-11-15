/**
 * companion-chat-transcript-custody.test.ts
 *
 * A chat's saved transcript is never replaced by a smaller in-memory copy, a
 * failed save refuses only the request whose save failed (the next change
 * writes what is owed), and a failed delete leaves the chat deletable.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatManagerConfig, CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-manager.js';
import { CompanionChatPersistence } from '../platform/src/platform/companion/companion-chat-persistence.js';
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

test('a reply whose save failed is written by the chat\'s next change, and the chat keeps accepting messages', async () => {
  const f = fixture();
  const session = f.manager.createSession();
  const real = CompanionChatPersistence.prototype.appendMessages;
  let failNext = false;
  const failing = spyOn(CompanionChatPersistence.prototype, 'appendMessages').mockImplementation(function (this: CompanionChatPersistence, id, messages) {
    if (failNext && messages.some((message) => message.role === 'assistant')) { failNext = false; throw new Error('no space left on device'); }
    return real.call(this, id, messages);
  });
  try {
    failNext = true;
    await f.manager.postMessageAndWaitForReply(session.id, 'first');
    // No lock-out: the next message is accepted.
    await f.manager.postMessageAndWaitForReply(session.id, 'second');
  } finally { failing.mockRestore(); }

  await f.manager.close();
  const onDisk = (await new CompanionChatPersistence(f.root).loadAll()).find((entry) => entry.meta.id === session.id);
  expect(onDisk?.messages.map((message) => message.content)).toEqual(['first', 'answer', 'second', 'answer']);
});

test('a closed chat past the grace still returns its whole transcript, matching its message count', async () => {
  const f = fixture({ closedSessionMemoryGraceMs: 0 });
  const session = f.manager.createSession();
  await f.manager.postMessageAndWaitForReply(session.id, 'question');
  f.manager.closeSession(session.id);
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

  const failing = spyOn(CompanionChatPersistence.prototype, 'delete').mockRejectedValue(new Error('permission denied'));
  await expect(f.manager.deleteSession(session.id)).rejects.toThrow('permission denied');
  failing.mockRestore();

  expect(f.manager.getSession(session.id)?.status).toBe('closed');
  expect(await f.manager.deleteSession(session.id)).toEqual({ sessionId: session.id, deleted: true });
  expect(f.manager.getSession(session.id)).toBeNull();
  expect((await new CompanionChatPersistence(f.root).loadAll()).some((entry) => entry.meta.id === session.id)).toBe(false);
});

test('a change whose save fails is refused with its own code and does not take effect; the next one works', async () => {
  const f = fixture();
  const session = f.manager.createSession({ title: 'old title' });
  const failing = spyOn(CompanionChatPersistence.prototype, 'writeMeta').mockImplementation(() => {
    throw Object.assign(new Error('EROFS: read-only file system, open /home/owner/x'), { code: 'EROFS' });
  });
  const error = await f.manager.updateSessionPersisted(session.id, { title: 'new title' }).then(() => null, (cause: unknown) => cause);
  failing.mockRestore();
  expect(error).toMatchObject({ code: 'CHAT_SAVE_FAILED', status: 503 });
  expect((error as Error).message).toContain('EROFS');
  expect((error as Error).message).not.toContain('/home/owner');
  expect(f.manager.getSession(session.id)?.title).toBe('old title');

  expect((await f.manager.updateSessionPersisted(session.id, { title: 'new title' })).title).toBe('new title');
});
