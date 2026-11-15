/**
 * Where a sub-agent's conversation is cut when it is compacted, which prompt it
 * gets when no budget is left, and which input a turn budget reports.
 */
import { describe, expect, test } from 'bun:test';

import { buildLayeredOrchestratorSystemPrompt } from '../platform/src/platform/agents/orchestrator-prompts.js';
import { compactAgentConversation } from '../platform/src/platform/agents/orchestrator-utils.js';
import { resolveTurnBudget } from '../platform/src/platform/agents/turn-budget.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.js';
import type { ProviderMessage } from '../platform/src/platform/providers/interface.js';

function record(): AgentRecord {
  return {
    id: 'agent-1', task: 'Review the parser', template: 'researcher', tools: ['read', 'find'],
    status: 'running', startedAt: 0, toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct',
    reviewMode: 'none', communicationLane: 'parent-only',
  } as AgentRecord;
}

function history(pairs: number, task: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'user', content: task }];
  for (let index = 0; index < pairs; index++) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${index}`, name: 'read', arguments: {} }] });
    messages.push({ role: 'tool', callId: `c${index}`, content: `result ${index}` });
  }
  return messages;
}

function orphanedToolResults(messages: readonly ProviderMessage[]): string[] {
  const called = new Set<string>();
  const orphans: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) called.add(call.id);
    if (message.role === 'tool' && !called.has(message.callId)) orphans.push(message.callId);
  }
  return orphans;
}

describe('compaction keeps tool results with their calls', () => {
  test('a cut that lands on a tool result keeps the assistant message that made the call', () => {
    const task = 'Review the parser';
    const messages = history(20, task); // 41 messages; keepRecent 13 would start on a tool result
    expect(messages[messages.length - 13]?.role).toBe('tool');
    const compacted = compactAgentConversation(messages, 13, task);
    expect(orphanedToolResults(compacted)).toEqual([]);
    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[compacted.length - 1]).toEqual(messages[messages.length - 1]!);
  });
});

describe('the emergency system prompt', () => {
  test('a window already overrun (negative remaining) gets the same prompt as none left', () => {
    const emergency = buildLayeredOrchestratorSystemPrompt(record(), 0);
    expect(buildLayeredOrchestratorSystemPrompt(record(), -500)).toBe(emergency);
    expect(emergency).toContain('You are an autonomous agent');
  });
});

describe('turn budget source', () => {
  test('an invalid spawn override is not reported as applied', () => {
    for (const spawnOverride of [-1, Number.NaN, 1.5]) {
      expect(resolveTurnBudget({ configDefault: 50, spawnOverride, policyCap: 200 })).toEqual({ limit: 50, source: 'default' });
    }
    expect(resolveTurnBudget({ configDefault: 50, spawnOverride: 10, policyCap: 200 })).toEqual({ limit: 10, source: 'spawn-override' });
  });
});
