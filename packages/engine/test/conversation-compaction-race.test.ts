// Proves: A message added while the conversation is being compacted is replaced by the summary and lost.
// Red when: The compaction is applied although the conversation's revision moved while it was being produced.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ConversationManager } from '../platform/src/platform/core/conversation.ts';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';

// Without a decision model the compaction asks nothing; with one, its waits are model requests. The race is the same.
let retirePolicy: () => void = () => undefined;
beforeEach(() => { retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false); });
afterEach(() => retirePolicy());

/** Plain compaction of a conversation without contracts asks no model; any use of the registry fails the case. */
const noModel = new Proxy({}, { get: () => { throw new Error('the compaction asked a model'); } }) as unknown as ProviderRegistry;

function longConversation(): ConversationManager {
  const conversation = new ConversationManager();
  for (let turn = 1; turn <= 30; turn++) {
    conversation.addUserMessage(`Step ${turn}: look at module ${turn} and report what it does. ${'Context for the step. '.repeat(40)}`);
    conversation.addAssistantMessage(`Module ${turn} parses its input and writes a summary. ${'Detail of the module. '.repeat(40)}`);
  }
  return conversation;
}

test('a message added while compaction runs is kept and the compaction is not applied; with none added it is applied', async () => {
  const quiet = longConversation();
  const before = quiet.getMessageCount();
  expect((await quiet.compact(noModel, 'model-a'))?.outcome).toBe('applied');
  expect(quiet.getMessageCount()).toBeLessThan(before);

  const busy = longConversation();
  const original = busy.getMessagesForLLM();
  const compaction = busy.compact(noModel, 'model-a');
  // The compaction has read the conversation and is waiting; a new message arrives.
  busy.addUserMessage('A message that arrived during the compaction.');
  await expect(compaction).rejects.toThrow('Conversation changed during compaction');
  expect(busy.getMessagesForLLM()).toEqual([...original, { role: 'user', content: 'A message that arrived during the compaction.' }]);
});
