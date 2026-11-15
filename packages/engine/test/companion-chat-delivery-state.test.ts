/**
 * companion-chat-delivery-state.test.ts
 *
 * A queued message whose turn can never run ends as `unanswered` in the saved
 * transcript, including after a daemon restart; a failed save refuses only
 * its own request; a reply that fails, or that the daemon stopped in, is
 * saved as a failed reply instead of leaving an unanswered question.
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
  await first.manager.close();
  // The daemon died with this message queued: the saved copy says so.
  const store = new CompanionChatPersistence(first.root);
  store.appendMessages(session.id, [{
    id: 'm1', sessionId: session.id, role: 'user', content: 'asked while a reply ran',
    createdAt: 1, attachments: [], deliveryState: 'queued',
  }]);
  store.close();

  const restarted = fixture({}, first.root);
  await restarted.manager.init();
  expect(restarted.manager.getMessages(session.id)[0]?.deliveryState).toBe('unanswered');
  await restarted.manager.close();

  const again = fixture({}, first.root);
  await again.manager.init();
  expect(again.manager.getMessages(session.id)[0]?.deliveryState).toBe('unanswered');
});

test('a message whose save failed is refused alone; the next send works without a wait or a restart', async () => {
  const f = fixture();
  const session = f.manager.createSession();
  const failing = spyOn(CompanionChatPersistence.prototype, 'appendMessages').mockImplementation(() => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });
  await expect(f.manager.postMessage(session.id, 'while the disk is full')).rejects.toMatchObject({ code: 'CHAT_SAVE_FAILED', status: 503 });
  failing.mockRestore();
  expect(f.manager.getMessages(session.id)).toEqual([]);

  await f.manager.postMessageAndWaitForReply(session.id, 'space again');
  await f.manager.close();

  const restored = fixture({}, f.root);
  await restored.manager.init();
  expect(restored.manager.getMessages(session.id).map((m) => m.content)).toEqual(['space again', 'answer']);
});

test('a reply that fails is saved as a failed reply with its partial text and the reason', async () => {
  const f = fixture({ provider: { async *chatStream() {
    yield { type: 'text_delta', delta: 'half an ' };
    yield { type: 'text_delta', delta: 'answer' };
    yield { type: 'error', error: 'rate limited' };
  } } });
  const session = f.manager.createSession();
  const reply = await f.manager.postMessageAndWaitForReply(session.id, 'question');
  expect(reply.error).toBe('rate limited');
  await f.manager.close();

  const restored = fixture({}, f.root);
  await restored.manager.init();
  const [user, failed] = restored.manager.getMessages(session.id);
  expect(user?.content).toBe('question');
  expect(failed).toMatchObject({ role: 'assistant', content: 'half an answer', deliveryState: 'failed', failureReason: 'rate limited', inReplyTo: user?.id });
});

test('a reply the daemon stopped in is recorded as failed when the chat is next opened', async () => {
  const f = fixture({ provider: { async *chatStream(_messages, options) {
    await new Promise<void>((resolve) => options.abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
    yield { type: 'done' };
  } } });
  const session = f.manager.createSession();
  const asked = await f.manager.postMessage(session.id, 'question');
  // The process dies here: no reply, no end of turn. A new manager reads what is on disk.
  const restarted = fixture({}, f.root);
  await restarted.manager.init();
  const messages = restarted.manager.getMessages(session.id);
  expect(messages.map((m) => [m.role, m.deliveryState, m.inReplyTo])).toEqual([['user', undefined, undefined], ['assistant', 'failed', asked]]);
});
