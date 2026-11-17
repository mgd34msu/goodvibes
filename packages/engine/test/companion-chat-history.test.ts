// Proves: Web and phone chat history is missing after a restart, or a regenerate or edit removes the replaced messages.
// Red when: The companion chat stops appending its messages, drops the messages a regenerate or an edit superseded, or the transcript rewrite keeps a line other than each message's last.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.ts';
import type { CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-turn-control.ts';

const roots: string[] = [];
const managers: CompanionChatManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The model, scripted: each reply names the question it answers and how many replies came before. */
function scriptedModel(): CompanionLLMProvider {
  let replies = 0;
  return {
    async *chatStream(messages) {
      const last = messages.filter((message) => message.role === 'user').at(-1);
      replies += 1;
      yield { type: 'text_delta', delta: `reply ${replies} to ${typeof last?.content === 'string' ? last.content : 'the question'}` };
      yield { type: 'done' };
    },
  };
}

/** A daemon start over the chat directory: the manager the daemon composes, with persistence on. */
async function start(sessionsDir: string): Promise<{ manager: CompanionChatManager; turnEnded: () => Promise<void> }> {
  let waiting: Array<() => void> = [];
  const manager = new CompanionChatManager({
    provider: scriptedModel(),
    eventPublisher: { publishEvent: (event) => { if (event === 'companion-chat.turn.completed') for (const done of waiting.splice(0)) done(); } },
    sessionsDir,
    persist: true,
    rateLimiter: false,
  });
  managers.push(manager);
  await manager.init();
  // Registered before the call that starts the turn, so a turn that ends at once is still heard.
  const turnEnded = () => new Promise<void>((resolve) => { waiting.push(resolve); });
  return { manager, turnEnded };
}

const view = (manager: CompanionChatManager, sessionId: string) => manager.getMessages(sessionId)
  .map((message) => [message.role, message.content, message.supersededReason ?? 'active']);

test('history survives a restart with regenerated and edited messages kept as superseded, also after the transcript is rewritten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-companion-history-'));
  roots.push(root);
  const sessionsDir = join(root, 'companion-chat');
  const first = await start(sessionsDir);
  const sessionId = first.manager.createSession({ title: 'phone chat' }).id;
  await first.manager.postMessageAndWaitForReply(sessionId, 'what is two plus two');
  let ended = first.turnEnded();
  first.manager.regenerateMessage(sessionId);
  await ended;
  const question = first.manager.getMessages(sessionId).find((message) => message.role === 'user')!;
  ended = first.turnEnded();
  first.manager.editMessage(sessionId, { messageId: question.id, content: 'what is three plus three' });
  await ended;
  const expected = [
    ['user', 'what is two plus two', 'edit'],
    ['assistant', 'reply 1 to what is two plus two', 'regenerate'],
    ['assistant', 'reply 2 to what is two plus two', 'edit'],
    ['user', 'what is three plus three', 'active'],
    ['assistant', 'reply 3 to what is three plus three', 'active'],
  ];
  expect(view(first.manager, sessionId)).toEqual(expected);
  await first.manager.flushSession(sessionId);
  await first.manager.close();

  // The daemon restarts: the same history, superseded messages included.
  const second = await start(sessionsDir);
  expect(view(second.manager, sessionId)).toEqual(expected);

  // Enough regenerates that superseded lines dominate the transcript: the next start rewrites it on reading.
  for (let n = 0; n < 40; n++) {
    ended = second.turnEnded();
    second.manager.regenerateMessage(sessionId);
    await ended;
  }
  const history = view(second.manager, sessionId);
  expect(history).toHaveLength(5 + 40);
  await second.manager.flushSession(sessionId);
  await second.manager.close();
  const transcriptLines = () => readFileSync(join(sessionsDir, `${sessionId}.jsonl`), 'utf8').split('\n').filter(Boolean).length;
  const linesBefore = transcriptLines();
  for (const reading of [1, 2]) {
    // The first start after the regenerates rewrites the transcript as it reads; the second reads the rewritten one.
    const next = await start(sessionsDir);
    expect({ reading, history: view(next.manager, sessionId) }).toEqual({ reading, history });
    await next.manager.flushSession(sessionId);
    await next.manager.close();
  }
  // The control: the rewrite did run.
  expect(transcriptLines()).toBeLessThan(linesBefore);
});
