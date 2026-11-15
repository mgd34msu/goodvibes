/**
 * Preflight and post-turn context maintenance: what the owner is told and what
 * is left set when compaction is off, denied by a hook, or racing a busy agent.
 */
import { describe, expect, test } from 'bun:test';
import {
  checkContextWindowPreflight,
  handlePostTurnContextMaintenance,
  type ModelContextWarning,
  type PostTurnContextDeps,
  type PreflightDeps,
} from '../platform/src/platform/core/orchestrator-context-runtime.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import type { ConversationManager } from '../platform/src/platform/core/conversation.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { CompactionContext } from '../platform/src/platform/core/compaction-types.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/record.js';

const WINDOW = 100_000;

function makeModel(): ModelDefinition {
  return {
    id: 'fable-5',
    provider: 'anthropic',
    registryKey: 'anthropic:fable-5',
    displayName: 'Fable 5',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: WINDOW,
    selectable: true,
    tier: 'standard',
  };
}

/** A conversation whose estimate is about `tokens` (four characters per token). */
function makeConversation(tokens: number) {
  const systemMessages: string[] = [];
  const state: { compactCalls: number; lastContext: CompactionContext | undefined } = { compactCalls: 0, lastContext: undefined };
  const messages = [{ role: 'user' as const, content: 'x'.repeat(tokens * 4) }];
  const conversation = {
    getMessagesForLLM: () => messages,
    addSystemMessage: (message: string) => { systemMessages.push(message); },
    addNotice: (message: string) => { systemMessages.push(message); },
    replaceMessagesForLLM: () => {},
    compact: async (_registry: unknown, _modelId: string, _trigger: string, _provider: string, context?: CompactionContext) => {
      state.compactCalls += 1;
      state.lastContext = context;
    },
  } as unknown as ConversationManager;
  return { conversation, systemMessages, state };
}

function sharedDeps(
  conversation: ConversationManager,
  model: ModelDefinition,
  config: Record<string, unknown>,
  agents: () => AgentRecord[] = () => [],
) {
  return {
    conversation,
    requestRender: () => {},
    hookDispatcher: null,
    configManager: { get: (key: string) => config[key] } as unknown as Pick<ConfigManager, 'get'>,
    providerRegistry: {
      getCurrentModel: () => model,
      getContextWindowForModel: () => model.contextWindow,
      getKnownContextWindowForModel: () => model.contextWindow,
      listModels: () => [model],
    } as unknown as PreflightDeps['providerRegistry'],
    sessionLineageTracker: { getEntries: () => [], getCompactionCount: () => 0, getOriginalTask: () => null },
    sessionId: 'test-session',
    agentManager: { list: agents },
    contractRunner: { list: () => [] },
    planManager: null,
    sessionMemoryStore: null,
    runtimeBus: null,
    emitterContext: () => ({ sessionId: 'test-session', turnId: 'turn-1' }) as unknown as ReturnType<PreflightDeps['emitterContext']>,
  };
}

const WARNING: ModelContextWarning = { provider: 'anthropic', model: 'fable-5', providerStopReason: 'model_context_window_exceeded' };
const denyingHook = { fire: async () => ({ ok: true, decision: 'deny' as const, reason: 'policy says no' }) };

describe('preflight with auto-compact turned off', () => {
  test('a request that fits the window is sent even inside the safety buffer', async () => {
    const { conversation, systemMessages, state } = makeConversation(95_000);
    const model = makeModel();
    const deps: PreflightDeps = {
      ...sharedDeps(conversation, model, { 'behavior.autoCompactThreshold': 0 }),
      isCompacting: false,
      setIsCompacting: () => {},
    };

    expect(await checkContextWindowPreflight(deps, 'turn-1', model)).toBe('ok');
    expect(systemMessages).toEqual([]);
    expect(state.compactCalls).toBe(0);
  });

  test('a request that really exceeds the window is still refused', async () => {
    const { conversation, systemMessages } = makeConversation(WINDOW + 5_000);
    const model = makeModel();
    const deps: PreflightDeps = {
      ...sharedDeps(conversation, model, { 'behavior.compactionStrategy': 'off', 'behavior.autoCompactThreshold': 80 }),
      isCompacting: false,
      setIsCompacting: () => {},
    };

    expect(await checkContextWindowPreflight(deps, 'turn-1', model)).toBe('error');
    expect(systemMessages.join(' ')).toContain('exceeds');
  });
});

describe('a Pre hook that denies compaction', () => {
  test('preflight keeps the provider warning set and says compaction was skipped', async () => {
    const { conversation, systemMessages, state } = makeConversation(1_000);
    const model = makeModel();
    let cleared = false;
    const deps: PreflightDeps = {
      ...sharedDeps(conversation, model, { 'behavior.autoCompactThreshold': 80 }),
      hookDispatcher: denyingHook,
      isCompacting: false,
      setIsCompacting: () => {},
      modelContextWarning: WARNING,
      clearModelContextWarning: () => { cleared = true; },
    };

    expect(await checkContextWindowPreflight(deps, 'turn-1', model)).toBe('ok');
    expect(cleared).toBe(false);
    expect(state.compactCalls).toBe(0);
    expect(systemMessages.some((message) => message.includes('Auto-compacting'))).toBe(false);
    const notice = systemMessages.join(' ');
    expect(notice).toContain('skipped');
    expect(notice).toContain('policy says no');
  });

  test('post-turn maintenance keeps the provider warning set and says compaction was skipped', async () => {
    const { conversation, systemMessages, state } = makeConversation(1_000);
    const model = makeModel();
    let cleared = false;
    const deps: PostTurnContextDeps = {
      ...sharedDeps(conversation, model, { 'behavior.autoCompactThreshold': 80, 'behavior.staleContextWarnings': false }),
      hookDispatcher: denyingHook,
      isCompacting: false,
      setIsCompacting: () => {},
      lastWarningBracket: 0,
      setLastWarningBracket: () => {},
      modelContextWarning: WARNING,
      clearModelContextWarning: () => { cleared = true; },
    };

    await handlePostTurnContextMaintenance(deps, 'turn-1', 10_000);

    expect(cleared).toBe(false);
    expect(state.compactCalls).toBe(0);
    expect(systemMessages.some((message) => message.includes('Auto-compacting'))).toBe(false);
    expect(systemMessages.join(' ')).toContain('skipped');
  });

  test('an allowed compaction still consumes the warning and announces itself', async () => {
    const { conversation, systemMessages, state } = makeConversation(1_000);
    const model = makeModel();
    let cleared = false;
    const deps: PreflightDeps = {
      ...sharedDeps(conversation, model, { 'behavior.autoCompactThreshold': 80 }),
      hookDispatcher: { fire: async () => ({ ok: true }) },
      isCompacting: false,
      setIsCompacting: () => {},
      modelContextWarning: WARNING,
      clearModelContextWarning: () => { cleared = true; },
    };

    expect(await checkContextWindowPreflight(deps, 'turn-1', model)).toBe('compacted');
    expect(cleared).toBe(true);
    expect(state.compactCalls).toBe(1);
    expect(systemMessages.some((message) => message.includes('Auto-compacting'))).toBe(true);
  });
});

describe('the compaction context', () => {
  test('carries the session id and a copy of the agent records, not the live ones', async () => {
    const { conversation, state } = makeConversation(1_000);
    const model = makeModel();
    const live = { id: 'agent-1', status: 'running', toolCallCount: 1, fullOutput: 'first' } as unknown as AgentRecord;
    const deps: PreflightDeps = {
      ...sharedDeps(conversation, model, { 'behavior.autoCompactThreshold': 80 }, () => [live]),
      isCompacting: false,
      setIsCompacting: () => {},
      modelContextWarning: WARNING,
      clearModelContextWarning: () => {},
    };

    await checkContextWindowPreflight(deps, 'turn-1', model);
    // The running agent keeps advancing while compaction makes its extraction calls.
    live.toolCallCount = 9;
    live.fullOutput = 'advanced';

    expect(state.lastContext?.sessionId).toBe('test-session');
    expect(state.lastContext?.agents[0]).toMatchObject({ id: 'agent-1', toolCallCount: 1, fullOutput: 'first' });
  });
});
