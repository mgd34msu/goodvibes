import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { MockLLMProvider } from '../setup.ts';
import { HookDispatcher } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { HookEvent, HookResult } from '@goodvibes-jev/engine/platform/platform/hooks';
import { PermissionManager } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { LLMProvider, ChatRequest, ChatResponse } from '@goodvibes-jev/engine/platform/platform/providers';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createEventEnvelope } from '@/runtime/index.ts';
import { createPermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';
import { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockChatResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'completed' | 'tool_call';
}

// MockLLMProvider is imported from setup.ts for shared usage.
// _makeMockProvider retained below for tests that use bun:test mock() directly.
function _makeMockProvider(responses: MockChatResponse[]) {
  let idx = 0;
  return {
    name: 'mock',
    models: ['mock-model'],
    chat: mock(async (_params: unknown) => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx++;
      return resp;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator', () => {
  let judgmentLog: SqliteDecisionLog;
  let previousJudgmentPort: ReturnType<typeof installJudgmentPort>;
  let runtimeBus: RuntimeEventBus;
  let toolRegistry: ToolRegistry;
  let testManagers: ReturnType<typeof createTestManagers>;
  let configManager: ReturnType<typeof createTestManagers>['configManager'];
  let testExecutionLock: Promise<void> = Promise.resolve();
  let releaseTestExecutionLock: (() => void) | null = null;

  beforeEach(async () => {
    await testExecutionLock;
    testExecutionLock = new Promise<void>((resolve) => {
      releaseTestExecutionLock = resolve;
    });
    testManagers = createTestManagers();
    configManager = testManagers.configManager;
    resetSettingsControlPlaneStore(configManager);
    runtimeBus = new RuntimeEventBus();
    toolRegistry = new ToolRegistry();
    // Core turn and tool-permission semantics are external readings. Keep
    // this suite focused on token accounting, hooks and turn-loop behavior.
    judgmentLog = new SqliteDecisionLog(':memory:');
    previousJudgmentPort = installJudgmentPort(withDecisionLog(fakePort((wireQuestionName, question) => {
    const name = wireQuestionName.replace(/^(effect|risk|edge)__/, '');
      if (name === 'disposition') return choiceAnswer(question, 'act', 0.97);
      if (name === 'intent') return choiceAnswer(question, 'chat', 0.97);
      if (name === 'risk') return scoreAnswer(question, 0, 0.97);
      if (name === 'family') return choiceAnswer(question, 'generic', 0.97);
      if (name === 'kind') return choiceAnswer(question, 'other', 0.97);
      if (name === 'capability') return choiceAnswer(question, 'generic', 0.97);
      if (name === 'completion_required') return noulAnswer(.99);
      if (name === 'category') return choiceAnswer(question, 'unknown', 0.97);
      if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.97);
      if (question.type === 'noul') return noulAnswer(name === 'mutates' ? 0.97 : 0.03);
      throw new Error(`Unexpected orchestrator reading: ${name}`);
    }).port, judgmentLog));
  });

  afterEach(() => {
    installJudgmentPort(previousJudgmentPort);
    judgmentLog[Symbol.dispose]();
    resetSettingsControlPlaneStore(configManager);
    releaseTestExecutionLock?.();
    releaseTestExecutionLock = null;
  });

  async function buildOrchestrator(renderRequest: (() => void) | null = null) {
    const { Orchestrator } = await import('@goodvibes-jev/engine/platform/platform/core');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const cm = new ConversationManager(() => 80, configManager);
    const policyRuntimeState = new PolicyRuntimeState();
    const pm = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
    const agentManager = new AgentManager({ configManager });
    // hookDispatcher is still optional; services are injected explicitly.
    const orch = new Orchestrator({
      conversation: cm,
      getViewportHeight: () => 24,
      scrollToEnd: () => {},
      toolRegistry,
      permissionManager: pm,
      getSystemPrompt: () => '',
      requestRender: renderRequest,
      runtimeBus,
      services: {
        agentManager,
        contractRunner: { list: () => [] },
        contractIntake: { intake: async () => ({ kind: 'turn' }) },
      },
    });
    orch.setCoreServices({
      providerRegistry: testManagers.providerRegistry,
      configManager,
    });
    return { orch, cm, pm };
  }

  async function buildOrchestratorWithHooks(hookDispatcher: HookDispatcher) {
    const { Orchestrator } = await import('@goodvibes-jev/engine/platform/platform/core');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const cm = new ConversationManager(() => 80, configManager);
    const policyRuntimeState = new PolicyRuntimeState();
    const pm = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
    const agentManager = new AgentManager({ configManager });
    const orch = new Orchestrator({
      conversation: cm,
      getViewportHeight: () => 24,
      scrollToEnd: () => {},
      toolRegistry,
      permissionManager: pm,
      getSystemPrompt: () => '',
      hookDispatcher,
      runtimeBus,
      services: {
        agentManager,
        contractRunner: { list: () => [] },
        contractIntake: { intake: async () => ({ kind: 'turn' }) },
      },
    });
    orch.setCoreServices({
      providerRegistry: testManagers.providerRegistry,
      configManager,
    });
    return { orch, cm, pm };
  }

  /** Helper: register a tool that resolves successfully */
  function registerSuccessTool(name: string, output = 'ok'): void {
    toolRegistry.register({
      definition: { name, description: name, parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output }),
    });
  }

  /** Helper: register a tool that throws */
  function registerThrowingTool(name: string, message = 'boom'): void {
    toolRegistry.register({
      definition: { name, description: name, parameters: { type: 'object', properties: {} } },
      execute: async () => { throw new Error(message); },
    });
  }

  describe('Orchestrator state', () => {
    test('isThinking starts false', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.isThinking).toBe(false);
    });

    test('a throw while a turn starts leaves the orchestrator free and the same text accepted again', async () => {
      let failRender = true;
      const { orch } = await buildOrchestrator(() => { if (failRender) { failRender = false; throw new Error('render failed'); } });
      await expect(orch.handleUserInput('hello')).rejects.toThrow('render failed');
      expect(orch.isTurnActive).toBe(false);
      // Not occupied and not refused as an in-flight duplicate: the same text starts a turn instead of being queued or dropped.
      const submitted: string[] = [];
      runtimeBus.on('TURN_SUBMITTED', (envelope) => { submitted.push(envelope.payload.type); });
      await orch.handleUserInput('hello').catch(() => undefined);
      expect(orch.messageQueue).toHaveLength(0);
      await Promise.resolve();
      expect(submitted).toEqual(['TURN_SUBMITTED']);
    });

    test.each(['safe-owner', 'safe-jev', 'yolo', 'plan'] as const)('the system prompt announces %s mode in one line', async (mode) => {
      const { orch } = await buildOrchestrator();
      const internals = orch as unknown as { permissionManager: { getMode(): string }; getSystemPrompt(): Promise<string> };
      internals.permissionManager = { getMode: () => mode };
      const lines = (await internals.getSystemPrompt()).split('\n').filter((line) => line.startsWith('Permission mode: '));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.length).toBeGreaterThan('Permission mode: '.length + 10);
    });

    test('messageQueue starts empty', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.messageQueue).toHaveLength(0);
    });

    test('usage starts at zero', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.usage.input).toBe(0);
      expect(orch.usage.output).toBe(0);
      expect(orch.lastRequestInputTokens).toBe(0);
    });

    test('getSpinner() returns a non-empty string', async () => {
      const { orch } = await buildOrchestrator();
      const spinner = orch.getSpinner();
      expect(typeof spinner).toBe('string');
      expect(spinner.length).toBeGreaterThan(0);
    });

    test('getSpinner() produces valid spinner frames at different positions', async () => {
      const { orch } = await buildOrchestrator();
      const frames = new Set<string>();
      for (let i = 0; i < 10; i++) {
        (orch as unknown as { thinkingFrame: number }).thinkingFrame = i;
        frames.add(orch.getSpinner());
      }
      // Should have multiple distinct spinner chars over 10 positions
      expect(frames.size).toBeGreaterThan(1);
    });

    test('dispose detaches every listener the orchestrator attached to the runtime bus', async () => {
      const live = new Set<symbol>();
      const attach = runtimeBus.on.bind(runtimeBus);
      const tracked: RuntimeEventBus['on'] = (eventType, callback) => {
        const detach = attach(eventType, callback);
        const token = Symbol('listener');
        live.add(token);
        return () => { live.delete(token); detach(); };
      };
      runtimeBus.on = tracked;
      const { orch } = await buildOrchestrator();
      expect(live.size).toBeGreaterThan(0);

      orch.dispose();

      expect(live.size).toBe(0);
    });
  });

  describe('turn lifecycle: queue and abort', () => {
    const lifecycleModel = {
      id: 'mock-model',
      provider: 'mock',
      registryKey: 'mock:mock-model',
      displayName: 'Mock',
      description: '',
      capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
      contextWindow: 8192,
      selectable: true,
    };
    let savedStream: boolean;

    beforeEach(() => {
      savedStream = (configManager.get('display.stream') as boolean | undefined) ?? true;
      configManager.set('display.stream', true);
    });

    afterEach(() => {
      configManager.set('display.stream', savedStream);
    });

    /**
     * A provider whose first call streams one delta and then holds until the
     * test releases it or the turn's abort signal fires; every later call
     * answers at once. `started` resolves once the first delta has been sent.
     */
    function heldFirstCallProvider() {
      const calls: ChatRequest[] = [];
      let release: () => void = () => {};
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: async (params: ChatRequest): Promise<ChatResponse> => {
          calls.push(params);
          const reply = calls.length === 1 ? 'first answer' : `answer ${calls.length}`;
          if (calls.length === 1) {
            params.onDelta?.({ content: 'partial ' });
            markStarted();
            await new Promise<void>((resolve, reject) => {
              void held.then(resolve);
              params.signal?.addEventListener('abort', () => reject(new Error('aborted by user')), { once: true });
            });
          }
          return { content: reply, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' };
        },
      };
      return { provider, calls, started, release: () => release() };
    }

    async function withProvider(provider: LLMProvider, run: () => Promise<void>): Promise<void> {
      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => lifecycleModel);
      try {
        await run();
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }
    }

    test('input sent during a real in-flight turn is queued, then runs in order once the turn ends', async () => {
      let renderCount = 0;
      const { orch, cm } = await buildOrchestrator(() => { renderCount++; });
      const held = heldFirstCallProvider();
      await withProvider(held.provider, async () => {
        const first = orch.handleUserInput('one');
        await held.started;
        expect(orch.isTurnActive).toBe(true);

        const rendersBefore = renderCount;
        void orch.handleUserInput('   '); // whitespace only is ignored
        void orch.handleUserInput('two');
        void orch.handleUserInput('three');
        expect(orch.messageQueue.map(m => m.text)).toEqual(['two', 'three']);
        expect(renderCount).toBeGreaterThan(rendersBefore);
        expect(held.calls).toHaveLength(1);

        held.release();
        await first;
      });

      expect(orch.messageQueue).toHaveLength(0);
      expect(orch.isTurnActive).toBe(false);
      expect(held.calls).toHaveLength(3);
      const users = cm.getMessagesForLLM().filter(m => m.role === 'user').map(m => m.content);
      expect(users).toEqual(['one', 'two', 'three']);
    });

    test('abort mid-stream frees the orchestrator, leaves no empty placeholder, and the queued message still runs', async () => {
      const { orch, cm } = await buildOrchestrator();
      const held = heldFirstCallProvider();
      await withProvider(held.provider, async () => {
        const first = orch.handleUserInput('one');
        await held.started;
        void orch.handleUserInput('two');
        expect(orch.messageQueue.map(m => m.text)).toEqual(['two']);

        orch.abort();
        await first;
      });

      expect(orch.isTurnActive).toBe(false);
      expect(orch.isThinking).toBe(false);
      expect(orch.messageQueue).toHaveLength(0);
      // The cancelled turn did not answer; the queued one did.
      expect(held.calls).toHaveLength(2);
      const messages = cm.getMessagesForLLM();
      const assistants = messages.filter(m => m.role === 'assistant');
      expect(assistants.map(m => m.content)).toEqual(['answer 2']);
      expect(messages.some(m => m.role === 'assistant' && m.content === '')).toBe(false);
    });

    test('abort() does not throw when not thinking', async () => {
      const { orch } = await buildOrchestrator();
      expect(() => orch.abort()).not.toThrow();
      expect(orch.isTurnActive).toBe(false);
    });
  });

  describe('token accounting', () => {
    let savedAutoApprove: boolean;
    let savedStream: boolean;
    const mockModel = {
      id: 'mock-model',
      provider: 'mock',
      registryKey: 'mock:mock-model',
      displayName: 'Mock',
      description: '',
      capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
      contextWindow: 8192,
      selectable: true,
    };

    beforeEach(() => {
      savedAutoApprove = (configManager.get('behavior.autoApprove') as boolean | undefined) ?? false;
      savedStream = (configManager.get('display.stream') as boolean | undefined) ?? true;
      configManager.set('behavior.autoApprove', false);
    });

    afterEach(() => {
      configManager.set('behavior.autoApprove', savedAutoApprove);
      configManager.set('display.stream', savedStream);
    });

    test('non-streaming turns still advance live output counters via hidden deltas', async () => {
      configManager.set('display.stream', false);
      let maxSeenInput = 0;
      let maxSeenOutput = 0;

      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          params.onDelta?.({ content: 'hello' });
          params.onDelta?.({ content: ' world' });
          return {
            content: 'hello world',
            toolCalls: [],
            usage: { inputTokens: 42, outputTokens: 11 },
            stopReason: 'completed',
          };
        }),
      };

      let orchRef: Awaited<ReturnType<typeof buildOrchestrator>>['orch'] | null = null;
      const { orch } = await buildOrchestrator(() => {
        if (orchRef) {
          maxSeenInput = Math.max(maxSeenInput, orchRef.streamingInputTokens);
          maxSeenOutput = Math.max(maxSeenOutput, orchRef.streamingOutputTokens);
        }
      });
      orchRef = orch;

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      try {
        await orch.handleUserInput('say hello');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(maxSeenInput).toBeGreaterThan(0);
      expect(maxSeenOutput).toBeGreaterThanOrEqual(2);
      expect(orch.usage.output).toBe(11);
    });

    test('reasoning-only deltas still advance live output counters', async () => {
      configManager.set('display.stream', false);
      let maxSeenOutput = 0;

      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          params.onDelta?.({ reasoning: 'thinking' });
          params.onDelta?.({ reasoning: ' harder' });
          return {
            content: 'done',
            toolCalls: [],
            usage: { inputTokens: 12, outputTokens: 6 },
            stopReason: 'completed',
          };
        }),
      };

      let orchRef: Awaited<ReturnType<typeof buildOrchestrator>>['orch'] | null = null;
      const { orch } = await buildOrchestrator(() => {
        if (orchRef) {
          maxSeenOutput = Math.max(maxSeenOutput, orchRef.streamingOutputTokens);
        }
      });
      orchRef = orch;

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      try {
        await orch.handleUserInput('reason');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(maxSeenOutput).toBeGreaterThan(0);
      expect(orch.usage.output).toBe(6);
    });

    test('usage normalizes cached prompt tokens into fresh input plus cache read', async () => {
      configManager.set('display.stream', false);

      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => ({
          content: 'done',
          toolCalls: [],
          usage: { inputTokens: 15000, outputTokens: 80, cacheReadTokens: 14900 },
          stopReason: 'completed',
        })),
      };

      const { orch } = await buildOrchestrator();

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      try {
        await orch.handleUserInput('cached request');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(orch.usage.input).toBe(100);
      expect(orch.usage.cacheRead).toBe(14900);
      expect(orch.lastRequestInputTokens).toBe(100);
      expect(orch.lastInputTokens).toBe(15000);
    });
  });

  describe('event replay routing', () => {
    test('replay notices route through the system-message router instead of the main conversation when available', async () => {
      const replayMockModel = {
        id: 'mock-model',
        provider: 'mock',
        registryKey: 'mock:mock-model',
        displayName: 'Mock',
        description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
      };
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => ({
          content: 'done',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'completed',
        })),
      };

      const { orch, cm } = await buildOrchestrator();
      const low = mock((_message: string) => {});
      orch.setSystemMessageRouter({ low });

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => replayMockModel);
      try {
        runtimeBus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', {
          type: 'CONTRACT_FAILED',
          contractId: 'contract-1',
          failureKind: 'other',
          membersSettled: true,
          reason: 'review score below threshold',
        }, {
          sessionId: 'test',
          traceId: 'test:wrfc',
          source: 'test',
        }));

        await orch.handleUserInput('turn one');
        await orch.handleUserInput('turn two');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(low).toHaveBeenCalledTimes(1);
      const replayMessages = cm.getMessageSnapshot().filter((message) => (
        message.role === 'system' && message.content.includes('[Replay]')
      ));
      expect(replayMessages).toHaveLength(0);
    });
  });

  describe('conversation follow-ups', () => {
    test('queued follow-ups resume the authorized request and publish a checked answer', async () => {
      const mockModel = {
        id: 'mock-model',
        provider: 'mock',
        registryKey: 'mock:mock-model',
        displayName: 'Mock',
        description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
      };
      const provider = new MockLLMProvider([{ content: 'WRFC passed and the engineer run is complete.' }]);
      const { orch, cm } = await buildOrchestrator();
      cm.addUserMessage('Run the WRFC chain and report the final result.');
      let completed!: () => void;
      const completion = new Promise<void>(resolve => { completed = resolve; });
      const unsubscribe = runtimeBus.on('TURN_COMPLETED', completed);

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      const origGetTokenLimitsForModel = reg.getTokenLimitsForModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      reg.getTokenLimitsForModel = mock(() => ({
        maxOutputTokens: 512,
        contextWindow: 8192,
        maxToolResultTokens: 16384,
        maxToolCalls: 32,
        maxReasoningTokens: 0,
      }));
      try {
        orch.enqueueConversationFollowUp({
          key: 'wrfc:chain-1:passed',
          summary: 'WRFC chain chain-1 passed all gates.',
        });
        await completion;
      } finally {
        unsubscribe();
        orch.dispose();
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
        reg.getTokenLimitsForModel = origGetTokenLimitsForModel;
      }

      const snapshot = cm.getMessageSnapshot();
      expect(snapshot).toContainEqual(expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('WRFC passed and the engineer run is complete.'),
      }));
      expect(provider.callLog).toHaveLength(1);
      const lastMessage = provider.callLog[0]?.messages.at(-1);
      expect(lastMessage?.role).toBe('user');
      expect(String(lastMessage?.content ?? '')).toContain('WRFC chain chain-1 passed all gates.');
    });
  });

  describe('registerDelegateTool', () => {
    test('registers delegate tool into the ToolRegistry', async () => {
      const { orch } = await buildOrchestrator();

      const mockAcp = {
        spawn: mock(async (_task: unknown) => 'agent-id-123'),
      } as unknown as import('@goodvibes-jev/engine/platform/platform/acp').AcpManager;

      orch.registerDelegateTool(mockAcp);

      expect(toolRegistry.has('delegate')).toBe(true);
    });

    test('delegate tool definition has required parameters', async () => {
      const { orch } = await buildOrchestrator();

      const mockAcp = {
        spawn: mock(async (_task: unknown) => 'agent-id'),
      } as unknown as import('@goodvibes-jev/engine/platform/platform/acp').AcpManager;

      orch.registerDelegateTool(mockAcp);

      const defs = toolRegistry.getToolDefinitions();
      const delegateDef = defs.find((d) => d.name === 'delegate');
      expect(delegateDef).toEqual(expect.objectContaining({
        name: 'delegate',
        parameters: expect.any(Object),
      }));
      const params = delegateDef!.parameters as { required: string[] };
      expect(params.required).toContain('description');
      expect(params.required).toContain('context');
      expect(params.required).toContain('tools');
    });

    test('direct delegate execution cannot replace the original captured request', async () => {
      const { orch } = await buildOrchestrator();

      const spawnMock = mock(async (_task: unknown) => 'spawned-agent-id');
      const mockAcp = { spawn: spawnMock } as unknown as import('@goodvibes-jev/engine/platform/platform/acp').AcpManager;

      orch.registerDelegateTool(mockAcp);

      const result = await toolRegistry.execute('call-x', 'delegate', {
        description: 'Run tests',
        context: 'Run all unit tests',
        tools: ['read'],
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('original request captured by the active turn');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    test('the checked agent interface prevents registering an alternate ACP delegation route', async () => {
      const { orch } = await buildOrchestrator();
      toolRegistry.register({ definition: { name: 'agent', description: 'Native checked delegation.', parameters: {} },
        execute: async () => ({ success: false, error: 'Synthetic checked plan is held.' }) });
      const spawnMock = mock(async () => 'must-not-spawn');
      orch.registerDelegateTool({ spawn: spawnMock } as unknown as import('@goodvibes-jev/engine/platform/platform/acp').AcpManager);
      expect(toolRegistry.has('agent')).toBe(true);
      expect(toolRegistry.has('delegate')).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    test('delegate tool returns failure when acpManager is null', async () => {
      const { orch } = await buildOrchestrator();

      // Register WITHOUT calling registerDelegateTool - then directly inject
      // We test the internal null-check by accessing the tool function after registration
      // First register with a real mock to get the tool registered
      const mockAcp = { spawn: mock(async () => 'id') } as unknown as import('@goodvibes-jev/engine/platform/platform/acp').AcpManager;
      orch.registerDelegateTool(mockAcp);

      // Now manually clear the internal acpManager via type cast to simulate null scenario
      (orch as unknown as { acpManager: null }).acpManager = null;

      const result = await toolRegistry.execute('call-null', 'delegate', {
        description: 'task',
        context: 'ctx',
        tools: [],
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('not initialized');
    });
  });

  describe('Hook firing', () => {
    // Config autoApprove stays off; the test PermissionManager approves every check through its prompt callback.
    let savedAutoApprove: boolean;

    beforeEach(() => {
      savedAutoApprove = (configManager.get('behavior.autoApprove') as boolean | undefined) ?? false;
      configManager.set('behavior.autoApprove', false);
    });

    afterEach(() => {
      configManager.set('behavior.autoApprove', savedAutoApprove);
    });

    /** Directly call the private executeToolCalls method via type cast */
    type OrchestratorInternal = {
      executeToolCalls: (
        turnId: string,
        calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
        sourceOf: () => { goal: string; criteria: readonly string[] },
      ) => Promise<Array<{ callId: string; success: boolean; output?: string; error?: string }>>;
    };

    const sourceOf = () => ({ goal: 'Run the registered fixture tool and report its result', criteria: ['Preserve tool hook ordering'] });

    test('Pre hook fires before tool execution with correct event shape', async () => {
      const dispatcher = new HookDispatcher();
      const firedEvents: HookEvent[] = [];
      dispatcher.register('Pre:tool:mytool', {
        type: 'ts',
        match: 'Pre:tool:mytool',
        path: '',
      });
      // Spy on fire instead of registering a real runner
      const origFire = dispatcher.fire.bind(dispatcher);
      const firedPaths: string[] = [];
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        firedEvents.push(event);
        firedPaths.push(event.path);
        return origFire(event);
      };

      registerSuccessTool('mytool');
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      await internal.executeToolCalls('turn-1', [{ id: 'c1', name: 'mytool', arguments: {} }], sourceOf);

      const preEvent = firedEvents.find(e => e.phase === 'Pre');
      expect(preEvent).toEqual(expect.objectContaining({
        path: 'Pre:tool:mytool',
        category: 'tool',
        specific: 'mytool',
        payload: expect.objectContaining({ callId: 'c1', tool: 'mytool' }),
      }));
      expect(typeof preEvent!.sessionId).toBe('string');
      expect(preEvent!.sessionId.length).toBeGreaterThan(0);
    });

    test('Post hook fires after successful execution', async () => {
      const dispatcher = new HookDispatcher();
      const firedEvents: HookEvent[] = [];
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        firedEvents.push(event);
        return { ok: true };
      };

      registerSuccessTool('goodtool', 'done');
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-2', [{ id: 'c2', name: 'goodtool', arguments: {} }], sourceOf);

      expect(results[0].success).toBe(true);
      const postEvent = firedEvents.find(e => e.phase === 'Post');
      expect(postEvent).toEqual(expect.objectContaining({
        path: 'Post:tool:goodtool',
        payload: expect.objectContaining({ callId: 'c2', tool: 'goodtool' }),
      }));
    });

    test('Fail hook fires when tool throws', async () => {
      const dispatcher = new HookDispatcher();
      const firedEvents: HookEvent[] = [];
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        firedEvents.push(event);
        return { ok: true };
      };

      registerThrowingTool('badtool', 'something went wrong');
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-3', [{ id: 'c3', name: 'badtool', arguments: {} }], sourceOf);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('something went wrong');

      const failEvent = firedEvents.find(e => e.phase === 'Fail');
      expect(failEvent).toEqual(expect.objectContaining({
        path: 'Fail:tool:badtool',
        payload: expect.objectContaining({ callId: 'c3', tool: 'badtool', error: 'something went wrong' }),
      }));

      // Post hook must NOT fire on failure
      const postEvent = firedEvents.find(e => e.phase === 'Post');
      expect(postEvent).toBeUndefined();
    });

    test('Pre hook deny skips execution and returns denied ToolResult', async () => {
      const dispatcher = new HookDispatcher();
      const executeMock = mock(async () => ({ success: true, output: 'should not run' }));
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        if (event.phase === 'Pre') {
          return { ok: true, decision: 'deny', reason: 'blocked by policy' };
        }
        return { ok: true };
      };

      // Register the tool but track whether it ran
      toolRegistry.register({
        definition: { name: 'restricted', description: 'restricted', parameters: { type: 'object', properties: {} } },
        execute: executeMock,
      });

      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-4', [{ id: 'c4', name: 'restricted', arguments: {} }], sourceOf);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('blocked by policy');
      // Tool execute should never have been called
      expect(executeMock).not.toHaveBeenCalled();
    });

    test('no hooks: tool executes normally when hookDispatcher is null', async () => {
      registerSuccessTool('plaintool', 'plain result');
      const { orch } = await buildOrchestrator();
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-5', [{ id: 'c5', name: 'plaintool', arguments: {} }], sourceOf);

      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('plain result');
    });

    test('a failing Pre hook fails closed: the tool is not run and the error names the hook', async () => {
      const dispatcher = new HookDispatcher();
      dispatcher.fire = async (_event: HookEvent): Promise<HookResult> => {
        throw new Error('hook system exploded');
      };

      const executeMock = mock(async () => ({ success: true, output: 'still works' }));
      toolRegistry.register({
        definition: { name: 'robusttool', description: 'robusttool', parameters: { type: 'object', properties: {} } },
        execute: executeMock,
      });
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-6', [{ id: 'c6', name: 'robusttool', arguments: {} }], sourceOf);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Pre hook failed');
      expect(results[0].error).toContain('hook system exploded');
      expect(executeMock).not.toHaveBeenCalled();
    });
  });

  describe('turn loop - spawn behavior', () => {
    let providerPatchLock: Promise<void> = Promise.resolve();

    /**
     * Mock model descriptor shared across spawn-behavior tests.
     * Capabilities.toolCalling must be true so the orchestrator includes tools
     * in the chat request and processes tool-use responses.
     */
    const MOCK_MODEL = {
      id: 'mock-model',
      provider: 'mock',
      registryKey: 'mock:mock-model',
      displayName: 'Mock',
      description: '',
      capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
      contextWindow: 8192,
      selectable: true,
    };

    /**
     * Patch the actual ProviderRegistry instance (the Proxy delegates to it)
     * so getCurrentModel and getForModel return our mocks.  Restores originals
     * in a finally block.
     */
    async function withMockProvider<T>(
      provider: LLMProvider,
      fn: () => Promise<T>,
    ): Promise<T> {
      const waitForTurn = providerPatchLock;
      let releaseLock!: () => void;
      providerPatchLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      await waitForTurn;
      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      // Patch all three provider-lookup paths used by core/orchestrator.ts
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => MOCK_MODEL);
      try {
        return await fn();
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
        releaseLock();
      }
    }

    // Config autoApprove stays off; the test PermissionManager approves every check through its prompt callback.
    let savedAutoApprove: boolean;

    beforeEach(() => {
      savedAutoApprove = (configManager.get('behavior.autoApprove') as boolean | undefined) ?? false;
      configManager.set('behavior.autoApprove', false);
    });

    afterEach(() => {
      configManager.set('behavior.autoApprove', savedAutoApprove);
    });

    test('batch-spawn continues through the tool result to a checked final answer', async () => {
      let calls = 0;
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          if (++calls > 1) return { content: 'The requested assignments were submitted.', toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' };
          return {
            content: '',
            toolCalls: [{
              id: 'call-batch-1',
              name: 'agent',
              arguments: {
                mode: 'batch-spawn',
                tasks: [
                  { task: 'Write unit tests' },
                  { task: 'Write integration tests' },
                ],
              },
            }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_call',
          };
        }),
      };

      // Register a no-op agent tool so executeToolCalls doesn't error
      toolRegistry.register({
        definition: { name: 'agent', description: 'agent', parameters: { type: 'object', properties: {}, required: ['mode'] } },
        execute: async () => ({ success: true, output: 'batch spawned' }),
      });

      const turnCompleteEvents: unknown[] = [];
      runtimeBus.on('TURN_COMPLETED', (data) => turnCompleteEvents.push(data));

      const { orch, cm } = await buildOrchestrator();

      await withMockProvider(provider, () => orch.handleUserInput('spawn two agents'));

      const messages = (
        cm as unknown as {
          messages: Array<{ role: string; callId?: string; content: unknown }>;
        }
      ).messages;
      const assistantMessages = messages.filter((message) => message.role === 'assistant');
      const toolMessages = messages.filter((message) => message.role === 'tool');
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages.at(-1)?.content).toBe('The requested assignments were submitted.');
      expect(calls).toBe(2);
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.callId).toBe('call-batch-1');
      expect(toolMessages[0]?.content).toBe('batch spawned');
      expect(turnCompleteEvents.length).toBeGreaterThan(0);
    });

    test('spawn continues through the tool result to a checked final answer', async () => {
      let calls = 0;
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          if (++calls > 1) return { content: 'The requested assignment was submitted.', toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' };
          return {
            content: '',
            toolCalls: [{
              id: 'call-spawn-1',
              name: 'agent',
              arguments: { mode: 'spawn', task: 'Write tests' },
            }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_call',
          };
        }),
      };

      toolRegistry.register({
        definition: { name: 'agent', description: 'agent', parameters: { type: 'object', properties: {}, required: ['mode'] } },
        execute: async () => ({ success: true, output: 'spawned' }),
      });

      const turnCompleteEvents: unknown[] = [];
      runtimeBus.on('TURN_COMPLETED', (data) => turnCompleteEvents.push(data));

      const { orch, cm } = await buildOrchestrator();

      await withMockProvider(provider, () => orch.handleUserInput('spawn an agent'));

      const messages = (
        cm as unknown as {
          messages: Array<{ role: string; callId?: string; content: unknown }>;
        }
      ).messages;
      const assistantMessages = messages.filter((message) => message.role === 'assistant');
      const toolMessages = messages.filter((message) => message.role === 'tool');
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages.at(-1)?.content).toBe('The requested assignment was submitted.');
      expect(calls).toBe(2);
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.callId).toBe('call-spawn-1');
      expect(toolMessages[0]?.content).toBe('spawned');
      expect(turnCompleteEvents.length).toBeGreaterThan(0);
    });

    test('non-spawn agent mode (status) does NOT end the turn loop early', async () => {
      let chatCallCount = 0;
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          chatCallCount++;
          if (chatCallCount === 1) {
            // First call: return an agent status tool call (not spawn)
            return {
              content: '',
              toolCalls: [{
                id: 'call-status-1',
                name: 'agent',
                arguments: { mode: 'status', agentId: 'agent-123' },
              }],
              usage: { inputTokens: 10, outputTokens: 5 },
              stopReason: 'tool_call',
            };
          }
          // Second call: finish cleanly
          return {
            content: 'Status checked.',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'completed',
          };
        }),
      };

      toolRegistry.register({
        definition: { name: 'agent', description: 'agent', parameters: { type: 'object', properties: {}, required: ['mode'] } },
        execute: async () => ({ success: true, output: 'status: running' }),
      });

      const { orch } = await buildOrchestrator();

      await withMockProvider(provider, () => orch.handleUserInput('check agent status'));

      // Status mode should NOT end the loop, LLM is called twice (tool result sent back)
      expect(chatCallCount).toBe(2);
    });
  });
});
