/** The transcript event index is built from what the messages store: no model request, one build per history revision. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { ConversationManager } from '../platform/src/platform/core/conversation.js';

let previous: ReturnType<typeof installJudgmentPort>;
let requests = 0;
beforeEach(() => {
  requests = 0;
  const port: JudgmentPort = { model: 'counting', async ask() { requests++; throw new Error('no reading expected'); } };
  previous = installJudgmentPort(port);
});
afterEach(() => { installJudgmentPort(previous); });

test('plain and declared notices are indexed with zero decision-model requests, and the index is reused until the history changes', async () => {
  const conversation = new ConversationManager();
  conversation.addUserMessage('Fix the parser.');
  for (let index = 0; index < 50; index++) conversation.addSystemMessage(`Plain notice ${index}`);
  conversation.addNotice('[Contract] waiting for the owner', { level: 'warning', kind: 'contract' });
  const first = await conversation.getTranscriptEventIndex();
  expect(requests).toBe(0);
  expect(first.events.filter(event => event.kind === 'system_notice')).toHaveLength(50);
  expect(first.events.at(-1)?.kind).toBe('contract_state');
  expect(await conversation.getTranscriptEventIndex()).toBe(first);
  conversation.addUserMessage('And the tests.');
  const second = await conversation.getTranscriptEventIndex();
  expect(second).not.toBe(first);
  expect(second.events.at(-1)?.kind).toBe('user_input');
  expect(requests).toBe(0);
});
