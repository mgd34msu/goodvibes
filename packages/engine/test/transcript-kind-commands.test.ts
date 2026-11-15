import { describe, expect, test } from 'bun:test';
import { createConversationRuntimeCommand, type ConversationRuntimeContext } from '../terminal-shell/src/conversation-runtime-command.js';

function setup() {
  const printed: string[] = [];
  let indexReads = 0;
  const conversation = {
    getMessageSnapshot: () => [],
    getMessageCount: () => 0,
    getTranscriptEventIndex: async () => { indexReads++; return { events: [], groups: [] }; },
    nextTranscriptEventLine: async () => { indexReads++; return -1; },
    prevTranscriptEventLine: async () => { indexReads++; return -1; },
  };
  const ctx = { session: { conversationManager: conversation }, print: (text: string) => { printed.push(text); } } as unknown as ConversationRuntimeContext;
  const command = createConversationRuntimeCommand<ConversationRuntimeContext>(() => { throw new Error('unused'); }, () => { throw new Error('unused'); });
  return { printed, command, ctx, reads: () => indexReads };
}

describe('/conversation transcript kind', () => {
  for (const sub of ['events', 'groups', 'next', 'prev']) {
    test(`${sub} with a misspelled kind names the allowed kinds instead of showing an unfiltered list`, async () => {
      const { printed, command, ctx, reads } = setup();
      await command.handler([sub, 'tool_calls'], ctx);
      expect(printed.join('\n')).toContain('Unknown transcript kind "tool_calls"');
      expect(printed.join('\n')).toContain('tool_call');
      expect(reads()).toBe(0);
    });
  }

  test('a valid kind is read', async () => {
    const { printed, command, ctx, reads } = setup();
    await command.handler(['events', 'tool-call'], ctx);
    expect(reads()).toBe(1);
    expect(printed.join('\n')).toContain('Conversation Events: tool_call');
  });
});
