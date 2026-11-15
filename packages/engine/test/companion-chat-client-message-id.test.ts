/**
 * A send that carries a clientMessageId is safe to repeat: when the first
 * response is lost and the client sends again, the second send answers with the
 * first message and starts no second turn.
 */

import { describe, expect, test } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-manager.js';

const disposables = trackDisposables();

function setup() {
  const names: string[] = [];
  let turns = 0;
  const provider: CompanionLLMProvider = {
    async *chatStream() {
      turns += 1;
      yield { type: 'text_delta' as const, delta: 'reply' };
      yield { type: 'done' as const };
    },
  };
  const manager = disposables.add(new CompanionChatManager({
    provider,
    eventPublisher: { publishEvent(name: string) { names.push(name); } },
    gcIntervalMs: 999_999,
  }));
  const session = manager.createSession({ provider: 'p', model: 'm' });
  const settle = async () => {
    for (let i = 0; i < 80 && names.filter((name) => name === 'companion-chat.turn.completed').length < 1; i += 1) await settleEvents();
  };
  return { manager, session, turns: () => turns, settle };
}

const userMessages = (manager: CompanionChatManager, sessionId: string) =>
  manager.getMessages(sessionId).filter((message) => message.role === 'user');

describe('clientMessageId', () => {
  test('a repeated send returns the first message and starts no second turn', async () => {
    const { manager, session, turns, settle } = setup();
    const first = await manager.postMessage(session.id, 'hello', '', { clientMessageId: 'local-1' });
    const repeat = await manager.postMessage(session.id, 'hello', '', { clientMessageId: 'local-1' });
    await settle();
    expect(repeat).toBe(first);
    expect(userMessages(manager, session.id)).toHaveLength(1);
    expect(turns()).toBe(1);
  });

  test('two sends in flight at once with the same id make one message', async () => {
    const { manager, session, turns, settle } = setup();
    const [a, b] = await Promise.all([
      manager.postMessage(session.id, 'hello', '', { clientMessageId: 'local-2' }),
      manager.postMessage(session.id, 'hello', '', { clientMessageId: 'local-2' }),
    ]);
    await settle();
    expect(a).toBe(b);
    expect(userMessages(manager, session.id)).toHaveLength(1);
    expect(turns()).toBe(1);
  });

  test('different ids, or no id, are separate messages', async () => {
    const { manager, session } = setup();
    const a = await manager.postMessage(session.id, 'one', '', { clientMessageId: 'x' });
    const b = await manager.postMessage(session.id, 'two', '', { clientMessageId: 'y' });
    const c = await manager.postMessage(session.id, 'three');
    const d = await manager.postMessage(session.id, 'four');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  test('a repeated steer returns the first message and cancels nothing', async () => {
    const { manager, session, settle } = setup();
    const first = await manager.steerMessage(session.id, 'now', '', { clientMessageId: 'steer-1' });
    await settle();
    const repeat = await manager.steerMessage(session.id, 'now', '', { clientMessageId: 'steer-1' });
    expect(repeat.messageId).toBe(first.messageId);
    expect(repeat.cancelledTurnId).toBeUndefined();
    expect(userMessages(manager, session.id)).toHaveLength(1);
  });
});
