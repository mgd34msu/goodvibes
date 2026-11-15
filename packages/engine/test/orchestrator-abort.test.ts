/**
 * Orchestrator.abort() releases the thinking-animation interval of a real,
 * constructed Orchestrator that is mid-turn.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Orchestrator } from '../platform/src/platform/core/orchestrator.js';
import { ConversationManager } from '../platform/src/platform/core/conversation.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { PermissionManager } from '../platform/src/platform/permissions/manager.js';
import type { ModelDefinition, ProviderRegistry } from '../platform/src/platform/providers/registry.js';
import type { LLMProvider } from '../platform/src/platform/providers/interface.js';
import { UNKNOWN_MODEL_PRICING } from '../platform/src/platform/providers/model-pricing.js';
import { useCoreReadings } from './_helpers/core-readings.ts';

useCoreReadings({ intent: 'chat', needsPlan: false, risk: 0 });

const orchestrators: Orchestrator[] = [];
afterEach(() => { for (const orchestrator of orchestrators.splice(0)) orchestrator.dispose(); });

/** A turn parked inside getSystemPrompt: the orchestrator is thinking and its animation interval is live. */
async function thinkingOrchestrator() {
  let release!: (prompt: string) => void;
  const prompt = new Promise<string>((resolve) => { release = resolve; });
  let entered!: () => void;
  const enteredPrompt = new Promise<void>((resolve) => { entered = resolve; });
  const model: ModelDefinition = {
    id: 'test', registryKey: 'test:test', displayName: 'Test', description: 'test', provider: 'test',
    contextWindow: 0, selectable: true,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
  };
  const provider: LLMProvider = {
    name: 'test', models: ['test'],
    chat: async () => ({ content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }),
  };
  const providerRegistry = {
    getCurrentModel: () => model, getForModel: () => provider,
    getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0,
    getTokenLimitsForModel: () => ({ maxOutputTokens: 200 }),
    reconcileObservedContextWindow: () => {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
  } as unknown as ProviderRegistry;
  const configManager = {
    get: (key: string) => key === 'judgment.policy' ? undefined : key === 'behavior.autoCompactThreshold' ? 0 : false,
    getCategory: () => ({}), getWorkingDirectory: () => process.cwd(),
  } as unknown as ConfigManager;
  const orchestrator = new Orchestrator({
    conversation: new ConversationManager(), toolRegistry: new ToolRegistry(),
    getViewportHeight: () => 10, scrollToEnd: () => {},
    permissionManager: { getMode: () => 'plan', check: async () => true } as unknown as PermissionManager,
    getSystemPrompt: () => { entered(); return prompt; },
    services: {
      agentManager: { list: () => [], spawn: () => { throw new Error('unexpected agent spawn'); } },
      contractRunner: { list: () => [] }, contractIntake: { intake: async () => ({ kind: 'turn' }) },
    },
  });
  orchestrator.setCoreServices({ configManager, providerRegistry });
  orchestrators.push(orchestrator);
  const setIntervalSpy = spyOn(globalThis, 'setInterval');
  const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
  const turn = orchestrator.handleUserInput('hello');
  await enteredPrompt;
  const finish = async () => { release('late prompt'); await turn; };
  return { orchestrator, setIntervalSpy, clearIntervalSpy, finish };
}

const internals = (orchestrator: Orchestrator) =>
  orchestrator as unknown as { animInterval: ReturnType<typeof setInterval> | null; isThinking: boolean };

describe('Orchestrator.abort() animInterval cleanup', () => {
  test('abort() during a turn clears the exact animation interval it started and stops thinking', async () => {
    const f = await thinkingOrchestrator();
    try {
      const started = internals(f.orchestrator).animInterval;
      expect(started).not.toBeNull();
      expect(internals(f.orchestrator).isThinking).toBe(true);
      expect(f.setIntervalSpy.mock.results.map((result) => result.value)).toContain(started);
      f.clearIntervalSpy.mockClear();

      f.orchestrator.abort();

      expect(f.clearIntervalSpy.mock.calls.map((call) => call[0])).toContain(started ?? undefined);
      expect(internals(f.orchestrator).animInterval).toBeNull();
      expect(internals(f.orchestrator).isThinking).toBe(false);
    } finally {
      await f.finish();
      f.setIntervalSpy.mockRestore();
      f.clearIntervalSpy.mockRestore();
    }
  });

  test('a second abort() clears nothing more and does not throw', async () => {
    const f = await thinkingOrchestrator();
    try {
      f.orchestrator.abort();
      f.clearIntervalSpy.mockClear();
      expect(() => f.orchestrator.abort()).not.toThrow();
      expect(f.clearIntervalSpy).not.toHaveBeenCalled();
      expect(internals(f.orchestrator).animInterval).toBeNull();
    } finally {
      await f.finish();
      f.setIntervalSpy.mockRestore();
      f.clearIntervalSpy.mockRestore();
    }
  });
});
