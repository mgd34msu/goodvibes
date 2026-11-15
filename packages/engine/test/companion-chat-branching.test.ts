/**
 * companion-chat-branching.test.ts
 *
 * The regenerate + edit-and-branch verbs at the CompanionChatManager level, with
 * a real manager and a deterministic mock provider so the full turn actually
 * re-runs and produces a new assistant message. Proves the HONEST-LINEAGE
 * contract: a regenerated or edited turn's predecessor is retained (marked
 * superseded, still returned by getMessages), never silently dropped; and the
 * re-run turn only sees the active branch, not the superseded history.
 *
 * The daemon-wire proof of the same verbs over real HTTP (invoke + routes,
 * closed/deleted-session refusals with machine codes) lives in
 * companion-chat-verbs-daemon-wire.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { settleEvents, waitFor } from './_helpers/test-timeout.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { trackDisposables } from './_helpers/disposables.ts';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
  CompanionProviderMessage,
} from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatMessage } from '../platform/src/platform/companion/companion-chat-types.js';

const disposables = trackDisposables();

/**
 * A provider that replies with a caller-controlled sequence of texts (one per
 * turn) AND records the messages it was handed each turn, so a test can prove
 * the re-run turn saw only the active conversation branch.
 */
function makeScriptedProvider(replies: string[]): CompanionLLMProvider & {
  readonly turns: CompanionProviderMessage[][];
} {
  const turns: CompanionProviderMessage[][] = [];
  let index = 0;
  return {
    turns,
    async *chatStream(messages): AsyncIterable<CompanionProviderChunk> {
      turns.push(messages.map((m) => ({ ...m })));
      const reply = replies[index] ?? `reply-${index}`;
      index += 1;
      yield { type: 'text_delta', delta: reply };
      yield { type: 'done' };
    },
  };
}

function makeManager(provider: CompanionLLMProvider): CompanionChatManager {
  return disposables.add(
    new CompanionChatManager({
      provider,
      eventPublisher: { publishEvent() {} },
      gcIntervalMs: 999_999,
      rateLimiter: false,
    }),
  );
}

const activeOnly = <T extends { supersededAt?: number | undefined }>(
  messages: readonly T[],
): T[] => messages.filter((m) => m.supersededAt === undefined);

describe('regenerate: honest lineage', () => {
  test('supersedes the prior response (retained, retrievable) and produces a fresh one', async () => {
    const provider = makeScriptedProvider(['first answer', 'second answer']);
    const manager = makeManager(provider);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await manager.postMessage(session.id, 'What is 2+2?');
    await settleEvents();
    const afterFirst = manager.getMessages(session.id);
    const firstAssistant = afterFirst.find((m) => m.role === 'assistant');
    expect(firstAssistant?.content).toBe('first answer');

    const result = manager.regenerateMessage(session.id);
    expect(result.regeneratedFrom).toBe(firstAssistant!.id);
    expect(result.supersededMessageIds).toContain(firstAssistant!.id);
    expect(result.turnStarted).toBe(true);
    await settleEvents();

    const all = manager.getMessages(session.id);
    // The prior response is NOT gone, it is retained, flagged superseded.
    const retainedFirst = all.find((m) => m.id === firstAssistant!.id);
    expect(retainedFirst).toBeDefined();
    expect(retainedFirst!.content).toBe('first answer');
    expect(typeof retainedFirst!.supersededAt).toBe('number');
    expect(retainedFirst!.supersededReason).toBe('regenerate');
    expect(retainedFirst!.contentRevision).not.toBe(firstAssistant!.contentRevision);
    expect(Object.isFrozen(retainedFirst)).toBe(true);
    expect(manager.getMessages(session.id).find(m => m.id === retainedFirst!.id)).toBe(retainedFirst);

    // A new active assistant response exists with the regenerated content.
    const active = activeOnly(all);
    const activeAssistant = active.find((m) => m.role === 'assistant');
    expect(activeAssistant).toBeDefined();
    expect(activeAssistant!.id).not.toBe(firstAssistant!.id);
    expect(activeAssistant!.content).toBe('second answer');

    // The user prompt was NOT superseded (regenerate re-runs from it).
    expect(active.some((m) => m.role === 'user' && m.content === 'What is 2+2?')).toBe(true);

    // The re-run turn saw only the active branch: the second turn's context did
    // NOT include the superseded 'first answer'.
    const secondTurnMessages = provider.turns[1]!;
    expect(secondTurnMessages.some((m) => JSON.stringify(m).includes('first answer'))).toBe(false);
  });

  test('regenerating in a chat with no message to answer is an honest refusal', () => {
    const manager = makeManager(makeScriptedProvider([]));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    expect(() => manager.regenerateMessage(session.id)).toThrow();
    try {
      manager.regenerateMessage(session.id);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NO_ANCHOR_MESSAGE');
      expect((err as { status?: number }).status).toBe(409);
    }
  });
});

describe('edit-and-branch: honest lineage', () => {
  test('supersedes the original message (retained) and branches with revisionOf', async () => {
    const provider = makeScriptedProvider(['answer to red', 'answer to blue']);
    const manager = makeManager(provider);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await manager.postMessage(session.id, 'Tell me about red');
    await settleEvents();
    const afterFirst = manager.getMessages(session.id);
    const originalUser = afterFirst.find((m) => m.role === 'user')!;
    const originalAssistant = afterFirst.find((m) => m.role === 'assistant')!;

    const result = manager.editMessage(session.id, {
      messageId: originalUser.id,
      content: 'Tell me about blue',
    });
    expect(result.editedFrom).toBe(originalUser.id);
    expect(result.messageId).not.toBe(originalUser.id);
    expect(result.supersededMessageIds).toContain(originalUser.id);
    expect(result.supersededMessageIds).toContain(originalAssistant.id);
    await settleEvents();

    const all = manager.getMessages(session.id);
    // Original user message retained, flagged superseded, retrievable.
    const retainedUser = all.find((m) => m.id === originalUser.id)!;
    expect(retainedUser.content).toBe('Tell me about red');
    expect(typeof retainedUser.supersededAt).toBe('number');
    expect(retainedUser.supersededReason).toBe('edit');

    // New user message carries the edit and links back via revisionOf.
    const newUser = all.find((m) => m.id === result.messageId)!;
    expect(newUser.role).toBe('user');
    expect(newUser.content).toBe('Tell me about blue');
    expect(newUser.revisionOf).toBe(originalUser.id);
    expect(newUser.supersededAt).toBeUndefined();

    // A fresh assistant answer to the edited message exists on the active branch.
    const active = activeOnly(all);
    const activeAssistant = active.find((m) => m.role === 'assistant')!;
    expect(activeAssistant.content).toBe('answer to blue');

    // The branch turn saw the edited message, not the original.
    const branchTurn = provider.turns[1]!;
    const branchText = JSON.stringify(branchTurn);
    expect(branchText.includes('Tell me about blue')).toBe(true);
    expect(branchText.includes('Tell me about red')).toBe(false);
  });

  test('editing an unknown message id refuses with MESSAGE_NOT_FOUND', () => {
    const manager = makeManager(makeScriptedProvider([]));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    try {
      manager.editMessage(session.id, { messageId: 'nope', content: 'x' });
      throw new Error('expected refusal');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('MESSAGE_NOT_FOUND');
      expect((err as { status?: number }).status).toBe(404);
    }
  });

  test('editing an assistant message refuses with NOT_A_USER_MESSAGE', async () => {
    const manager = makeManager(makeScriptedProvider(['a']));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'Q');
    await settleEvents();
    const assistant = manager.getMessages(session.id).find((m) => m.role === 'assistant')!;
    try {
      manager.editMessage(session.id, { messageId: assistant.id, content: 'x' });
      throw new Error('expected refusal');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NOT_A_USER_MESSAGE');
      expect((err as { status?: number }).status).toBe(400);
    }
  });
});

describe('closed / unknown session refusals', () => {
  test('regenerate + edit on a closed session throw SESSION_CLOSED (409)', async () => {
    const manager = makeManager(makeScriptedProvider(['a']));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'Q');
    await settleEvents();
    const user = manager.getMessages(session.id).find((m) => m.role === 'user')!;
    manager.closeSession(session.id);

    for (const act of [
      () => manager.regenerateMessage(session.id),
      () => manager.editMessage(session.id, { messageId: user.id, content: 'x' }),
    ]) {
      try {
        act();
        throw new Error('expected SESSION_CLOSED refusal');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('SESSION_CLOSED');
        expect((err as { status?: number }).status).toBe(409);
      }
    }
  });

  test('regenerate + edit on an unknown session throw SESSION_NOT_FOUND (404)', () => {
    const manager = makeManager(makeScriptedProvider([]));
    for (const act of [
      () => manager.regenerateMessage('ghost'),
      () => manager.editMessage('ghost', { messageId: 'm', content: 'x' }),
    ]) {
      try {
        act();
        throw new Error('expected SESSION_NOT_FOUND refusal');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('SESSION_NOT_FOUND');
        expect((err as { status?: number }).status).toBe(404);
      }
    }
  });
});

describe('regenerate after a failed attempt', () => {
  test('pressing regenerate again answers the same message instead of rewinding a whole exchange', async () => {
    let call = 0;
    const manager = makeManager({
      async *chatStream(): AsyncIterable<CompanionProviderChunk> {
        call += 1;
        if (call === 3) { yield { type: 'error', error: 'provider unavailable' }; return; }
        yield { type: 'text_delta', delta: `answer ${call}` };
        yield { type: 'done' };
      },
    });
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessageAndWaitForReply(session.id, 'U1');
    const u2 = await manager.postMessage(session.id, 'U2');
    await waitFor(() => manager.getMessages(session.id).filter((m) => m.role === 'assistant').length === 2);

    manager.regenerateMessage(session.id); // fails
    await waitFor(() => manager.getMessages(session.id).some((m) => m.deliveryState === 'failed'));
    const retry = manager.regenerateMessage(session.id);
    await waitFor(() => call === 4);
    await settleEvents();

    const active = activeOnly(manager.getMessages(session.id));
    expect(active.map((m) => m.content)).toEqual(['U1', 'answer 1', 'U2', 'answer 4']);
    expect(retry.supersededMessageIds.every((id) => manager.getMessages(session.id).find((m) => m.id === id)?.role === 'assistant')).toBe(true);
    expect(active.find((m) => m.content === 'answer 4')?.inReplyTo).toBe(u2);
  });
});

describe('history after a restart', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  test('the model is given the active chain only, not the reply that was regenerated away', async () => {
    const root = makeProjectTempDir('companion-branch-restart');
    roots.push(root);
    const before = makeScriptedProvider(['first answer', 'second answer']);
    const first = new CompanionChatManager({ provider: before, eventPublisher: { publishEvent() {} }, gcIntervalMs: 999_999, rateLimiter: false, persist: true, sessionsDir: root });
    const session = first.createSession({ provider: 'p', model: 'm' });
    await first.postMessageAndWaitForReply(session.id, 'question');
    first.regenerateMessage(session.id);
    await waitFor(() => before.turns.length === 2);
    await settleEvents();
    await first.close();

    const after = makeScriptedProvider(['third answer']);
    const second = disposables.add(new CompanionChatManager({ provider: after, eventPublisher: { publishEvent() {} }, gcIntervalMs: 999_999, rateLimiter: false, persist: true, sessionsDir: root }));
    await second.init();
    await second.postMessageAndWaitForReply(session.id, 'follow-up');
    const seen = after.turns[0]!.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`);
    expect(seen).toEqual(['user:question', 'assistant:second answer', 'user:follow-up']);
  });
});
