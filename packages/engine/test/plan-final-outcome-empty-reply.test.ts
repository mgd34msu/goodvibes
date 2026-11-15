import { describe, expect, test } from 'bun:test';
import { handleFinalResponseOutcome } from '../platform/src/platform/core/orchestrator-turn-helpers.ts';

function outcomeArgs(parsed: { items?: unknown[] }, messages: string[]): Parameters<typeof handleFinalResponseOutcome>[0] {
  const plan = { id: 'plan-1', awaitingPlan: true };
  const planManager = {
    getIncarnation: () => 1,
    getActive: () => plan,
    parseFromMarkdown: async () => parsed,
    replaceItems: () => {},
    load: () => null,
    save: () => {},
  };
  return {
    conversation: { addAssistantMessage() {}, addSystemMessage: (text: string) => { messages.push(text); }, addNotice: (text: string) => { messages.push(text); } } as never,
    agentManager: { list: () => [], spawn: () => { throw new Error('no spawn'); } } as never,
    planManager: planManager as never,
    preTurnPlan: plan as never,
    configManager: { get: () => undefined } as never,
    providerRegistry: { getCurrentModel: () => ({ displayName: 'test', registryKey: 'test', provider: 'test' }) } as never,
    runtimeBus: null, emitterContext: () => ({ sessionId: 'session', source: 'test', traceId: 'test' }), turnId: 'turn',
    response: { content: 'Here is my answer without a plan.', toolCalls: [], stopReason: 'completed' } as never,
    requestRender() {}, sessionId: 'session',
  };
}

describe('a reply to a plan request that yields no items', () => {
  test('tells the user the plan is still awaiting its items', async () => {
    const messages: string[] = [];
    await handleFinalResponseOutcome(outcomeArgs({ items: [] }, messages));
    expect(messages.some(text => text.startsWith('[Plan] No items could be read'))).toBe(true);
  });

  test('items that were read are reported even when the saved plan cannot be reloaded', async () => {
    const messages: string[] = [];
    await handleFinalResponseOutcome(outcomeArgs({ items: [{ id: 'i1' }] }, messages));
    expect(messages.some(text => text.startsWith('[Plan] Parsed 1 item(s).'))).toBe(true);
    expect(messages.some(text => text.startsWith('[Plan] No items could be read'))).toBe(false);
  });
});
