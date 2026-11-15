/**
 * companion-chat-turn-exclusivity.test.ts
 *
 * Regenerate and edit refuse while a reply is running instead of starting a
 * second concurrent turn; queued sends whose turn can never start answer their
 * waiters; the idle sweep never closes a chat mid-reply; a publisher that throws
 * on turn.started does not wedge the chat's turn slot.
 */

import { describe, expect, test } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-manager.js';

const disposables = trackDisposables();

function makeGate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
}

/** Each chatStream call yields one delta, then waits on its gate (if any) or the abort signal. */
function makeGatedProvider(gates: Record<number, { wait: Promise<void> }>) {
  let calls = 0;
  let active = 0;
  const stats = { maxActive: 0, calls: () => calls };
  const provider: CompanionLLMProvider = {
    async *chatStream(_messages, options) {
      const idx = calls++;
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      try {
        yield { type: 'text_delta' as const, delta: `reply-${idx} ` };
        const gate = gates[idx];
        if (gate) {
          await Promise.race([gate.wait, new Promise<void>((resolve) => options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true }))]);
        }
        yield { type: 'done' as const };
      } finally {
        active -= 1;
      }
    },
  };
  return { provider, stats };
}

function makeManager(
  provider: CompanionLLMProvider,
  publish: (name: string) => void = () => {},
  overrides: { idleActiveMs?: number } = {},
): CompanionChatManager {
  return disposables.add(new CompanionChatManager({
    provider,
    eventPublisher: { publishEvent(name: string) { publish(name); } },
    gcIntervalMs: 999_999,
    rateLimiter: false,
    ...overrides,
  }));
}

async function until(check: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await settleEvents();
  }
  throw new Error('condition never held');
}

describe('regenerate and edit while a reply is running', () => {
  test('regenerate during a running reply is refused and starts no second turn', async () => {
    const gate1 = makeGate();
    const { provider, stats } = makeGatedProvider({ 1: gate1 });
    const manager = makeManager(provider);
    const session = manager.createSession();
    await manager.postMessageAndWaitForReply(session.id, 'first');
    await manager.postMessage(session.id, 'second');
    await until(() => stats.calls() === 2);

    expect(() => manager.regenerateMessage(session.id)).toThrow(expect.objectContaining({ code: 'CHAT_TURN_BUSY', status: 409 }));
    expect(() => manager.regenerateMessage(session.id)).toThrow(/still replying.*Stop the current reply/);
    const firstUser = manager.getMessages(session.id).find((message) => message.role === 'user');
    expect(() => manager.editMessage(session.id, { messageId: firstUser!.id, content: 'edited' }))
      .toThrow(expect.objectContaining({ code: 'CHAT_TURN_BUSY' }));

    gate1.open();
    await until(() => manager.getMessages(session.id).filter((message) => message.role === 'assistant').length === 2);
    expect(stats.maxActive).toBe(1);
    // Nothing was superseded by the refused calls.
    expect(manager.getMessages(session.id).some((message) => message.supersededAt !== undefined)).toBe(false);

    // Once the reply finishes, regenerate works as before.
    expect(manager.regenerateMessage(session.id).turnStarted).toBe(true);
    await until(() => stats.calls() === 3);
  });
});

describe('queued sends whose turn can never start', () => {
  test('closing a chat answers a waiting queued send instead of leaving it pending forever', async () => {
    const gate0 = makeGate();
    const { provider } = makeGatedProvider({ 0: gate0 });
    const manager = makeManager(provider);
    const session = manager.createSession();
    await manager.postMessage(session.id, 'first');
    const queued = manager.postMessageAndWaitForReply(session.id, 'second');
    await until(() => manager.getMessages(session.id).some((message) => message.deliveryState === 'queued'));

    manager.closeSession(session.id);
    const result = await queued;
    expect(result.error).toMatch(/closed before this queued message was answered/);
  });

  test('shutting the service down answers a waiting queued send', async () => {
    const gate0 = makeGate();
    const { provider } = makeGatedProvider({ 0: gate0 });
    const manager = makeManager(provider);
    const session = manager.createSession();
    await manager.postMessage(session.id, 'first');
    const queued = manager.postMessageAndWaitForReply(session.id, 'second');
    await until(() => manager.getMessages(session.id).some((message) => message.deliveryState === 'queued'));

    await manager.close();
    const result = await queued;
    expect(result.error).toMatch(/shut down before this queued message was answered/);
  });
});

describe('idle sweep', () => {
  test('a chat whose reply is still running is not closed for inactivity', async () => {
    const gate0 = makeGate();
    const { provider } = makeGatedProvider({ 0: gate0 });
    const manager = makeManager(provider, () => {}, { idleActiveMs: 0 });
    const session = manager.createSession();
    const reply = manager.postMessageAndWaitForReply(session.id, 'long job');
    await until(() => manager.getMessages(session.id).length === 1);
    await settleEvents();

    manager._gcSweep();
    expect(manager.getSession(session.id)?.status).toBe('active');
    gate0.open();
    expect((await reply).error).toBeUndefined();
  });
});

describe('turn slot', () => {
  test('a publisher that throws on turn.started does not leave the chat permanently busy', async () => {
    const { provider } = makeGatedProvider({});
    let throwOnce = true;
    const manager = makeManager(provider, (name) => {
      if (name === 'companion-chat.turn.started' && throwOnce) { throwOnce = false; throw new Error('subscriber went away'); }
    });
    const session = manager.createSession();
    const first = await manager.postMessageAndWaitForReply(session.id, 'first');
    expect(first.error).toMatch(/subscriber went away/);
    const second = await manager.postMessageAndWaitForReply(session.id, 'second');
    expect(second.error).toBeUndefined();
    expect(second.response).toContain('reply-');
  });
});
