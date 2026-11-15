/**
 * companion-chat-delivery-state.test.ts
 *
 * A queued message whose turn can never run ends as `unanswered` in the saved
 * transcript, including after a daemon restart; a chat whose save failed
 * reopens once a save works again instead of staying shut until a restart.
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

function fixture(options: Partial<CompanionChatManagerConfig> = {}, directory?: string) {
  const root = directory ?? makeProjectTempDir('companion-delivery-state');
  if (!directory) roots.push(root);
  const manager = new CompanionChatManager({
    persist: true, sessionsDir: root, rateLimiter: false, gcIntervalMs: 999_999,
    eventPublisher: { publishEvent() {} }, provider: answers, ...options,
  });
  managers.push(manager);
  return { root, manager };
}

test('a queued message in a chat that is closed becomes unanswered and is saved that way', async () => {
  const release = Promise.withResolvers<void>();
  const f = fixture({ provider: { async *chatStream() { await release.promise; yield { type: 'done' }; } } });
  const session = f.manager.createSession();
  await f.manager.postMessage(session.id, 'first');
  const queued = f.manager.postMessageAndWaitForReply(session.id, 'second');
  for (let i = 0; i < 100 && !f.manager.getMessages(session.id).some((m) => m.deliveryState === 'queued'); i++) await Promise.resolve();
  expect(f.manager.getMessages(session.id).some((m) => m.deliveryState === 'queued')).toBe(true);

  f.manager.closeSession(session.id);
  await queued;
  await f.manager.flushSession(session.id);
  expect(f.manager.getMessages(session.id).filter((m) => m.role === 'user').map((m) => m.deliveryState))
    .toEqual([undefined, 'unanswered']);
  release.resolve();
  await f.manager.close();

  const restored = fixture({}, f.root);
  await restored.manager.init();
  expect(restored.manager.getMessages(session.id).some((m) => m.deliveryState === 'unanswered')).toBe(true);
  expect(restored.manager.getMessages(session.id).some((m) => m.deliveryState === 'queued')).toBe(false);
});

test('after a restart a message still marked queued in an active chat is marked unanswered', async () => {
  const first = fixture();
  const session = first.manager.createSession();
  await first.manager.flushSession(session.id);
  // The daemon died with this message queued: the saved copy says so.
  await new CompanionChatPersistence(first.root).save({
    meta: first.manager.getSession(session.id)!,
    messages: [{
      id: 'm1', sessionId: session.id, role: 'user', content: 'asked while a reply ran',
      createdAt: 1, attachments: [], contentRevision: 'r1', deliveryState: 'queued',
    }],
  });
  await first.manager.close();

  const restarted = fixture({}, first.root);
  await restarted.manager.init();
  expect(restarted.manager.getMessages(session.id)[0]?.deliveryState).toBe('unanswered');
  await restarted.manager.flushSession(session.id);
  await restarted.manager.close();

  const again = fixture({}, first.root);
  await again.manager.init();
  expect(again.manager.getMessages(session.id)[0]?.deliveryState).toBe('unanswered');
});

test('a chat whose save failed accepts messages again once a save works', async () => {
  const f = fixture();
  const failing = spyOn(CompanionChatPersistence.prototype, 'save').mockImplementation(async () => {
    throw new Error('no space left on device');
  });
  const session = f.manager.createSession();
  await expect(f.manager.flushSession(session.id)).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
  await expect(f.manager.postMessage(session.id, 'while the disk is full')).rejects.toMatchObject({
    code: 'CHAT_PERSISTENCE_UNAVAILABLE',
    message: expect.stringContaining('retries saving it on its own'),
  });
  // Still failing: it stays shut, and the next attempt tries again.
  expect(await f.manager.recoverFailedSaves()).toBe(0);
  await expect(f.manager.postMessage(session.id, 'still full')).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' });

  failing.mockRestore();
  expect(await f.manager.recoverFailedSaves()).toBe(1);
  await f.manager.postMessageAndWaitForReply(session.id, 'space again');
  await f.manager.flushSession(session.id);
  await f.manager.close();

  const restored = fixture({}, f.root);
  await restored.manager.init();
  expect(restored.manager.getMessages(session.id).map((m) => m.content)).toContain('space again');
});

test('a save that may already have been published is not rewritten by the retry', async () => {
  const f = fixture();
  const failing = spyOn(CompanionChatPersistence.prototype, 'save').mockImplementation(async () => {
    throw new AtomicWriteDurabilityError('chat.json', 'published-indeterminate', new Error('fsync failed'));
  });
  const session = f.manager.createSession();
  await expect(f.manager.flushSession(session.id)).rejects.toBeDefined();
  failing.mockRestore();
  expect(await f.manager.recoverFailedSaves()).toBe(0);
  await expect(f.manager.postMessage(session.id, 'must stay held')).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
  await f.manager.close().catch(() => undefined);
});
