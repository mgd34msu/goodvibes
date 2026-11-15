import { expect, test } from 'bun:test';
import type { AgentRecord } from '@goodvibes-jev/engine/platform/platform/tools';
import { renderUsageModal } from '../../renderer/usage-modal.ts';
import { UsageTracker } from '../../runtime/usage-tracker.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

function trackerWith(events: ReadonlyArray<{ type: string; agentId: string; task?: string }>): UsageTracker {
  const handlers = new Map<string, (payload: never) => void>();
  const feed = { on: (type: string, handler: (payload: never) => void) => { handlers.set(type, handler); return () => {}; } };
  const record = { model: 'test:model', usage: { inputTokens: 100, outputTokens: 10 } } as unknown as AgentRecord;
  const tracker = new UsageTracker({
    turnEvents: feed as never,
    agentEvents: feed as never,
    getUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: 'test:model' }),
    getContextTokens: () => 0,
    getContextWindow: () => 0,
    getModelId: () => 'test:model',
    getAgentStatus: () => record,
    configManager: { get: () => undefined, set: () => {} } as never,
  });
  for (const event of events) handlers.get(event.type)?.(event as never);
  return tracker;
}

test('a cancelled agent is counted as cancelled and marked, not shown with the success tick', () => {
  const tracker = trackerWith([
    { type: 'AGENT_SPAWNING', agentId: 'cancelled-agent', task: 'stopped work' },
    { type: 'AGENT_CANCELLED', agentId: 'cancelled-agent' },
  ]);
  const text = layerTextBlock(renderUsageModal({ tracker, tab: 'agents', turnOffset: 0, agentIndex: 0, entry: null, status: null }, 120, 40));
  expect(text).toContain('1 cancelled');
  expect(text).toContain('⊘');
  expect(text).not.toContain('✓');
});
