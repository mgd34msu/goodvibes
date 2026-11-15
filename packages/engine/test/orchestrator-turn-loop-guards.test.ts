import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ChatRequest, ChatResponse } from '../platform/src/platform/providers/interface.js';
import { ConversationManager } from '../platform/src/platform/core/conversation.js';
import { ResponseCompletionGuard, waitForResponseDelegates } from '../platform/src/platform/core/response-completion.js';
import { executeOrchestratorTurnLoop, type OrchestratorTurnLoopContext } from '../platform/src/platform/core/orchestrator-turn-loop.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { UNKNOWN_MODEL_PRICING } from '../platform/src/platform/providers/model-pricing.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(.01)).port); });
afterEach(() => { installJudgmentPort(previous); });

const usage = { inputTokens: 1, outputTokens: 1 };

function harness(chat: (request: ChatRequest, call: number) => ChatResponse | Promise<ChatResponse>, extra: Partial<OrchestratorTurnLoopContext> = {}) {
  const conversation = new ConversationManager();
  conversation.addUserMessage('Do the task.');
  const bus = new RuntimeEventBus();
  const errors: { error: string; stopReason: string }[] = [];
  bus.on('TURN_ERROR', event => { errors.push({ error: (event.payload as { error: string }).error, stopReason: (event.payload as { stopReason: string }).stopReason }); });
  const model = { id: 'test-model', provider: 'test', registryKey: 'test:test-model', displayName: 'Test', description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true };
  let calls = 0;
  const provider = { name: 'test', models: ['test-model'], chat: async (request: ChatRequest) => chat(request, ++calls) };
  let failed = false;
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({ definition: { name: 'probe', description: 'Inspect', parameters: { type: 'object' } }, execute: async () => ({ success: false }) });
  const context: OrchestratorTurnLoopContext = {
    conversation, toolRegistry, getSystemPrompt: () => 'Assistant.', getAbortSignal: () => undefined,
    hookDispatcher: null, requestRender() {}, runtimeBus: bus, agentManager: { list: () => [], spawn: () => { throw new Error('No delegation'); } },
    configManager: { get: () => undefined } as never,
    providerRegistry: { require: () => provider, getCurrentModel: () => model, getForModel: () => provider,
      getTokenLimitsForModel: () => ({ maxOutputTokens: 4096, maxToolResultTokens: 50_000, maxToolCalls: 128, maxReasoningTokens: 16384 }),
      getContextWindowForModel: () => 0, recordContextWindowRejection() {}, reconcileObservedContextWindow() {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING },
    cacheHitTracker: { getMetrics: () => ({ turns: 0, hitRate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 }) },
    helperModel: { getUsage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }) } as never,
    sessionId: 's', preTurnPlan: null, planManager: null, text: 'Do the task.', turnId: 't',
    emitterContext: () => ({ sessionId: 's', traceId: 't', source: 'test' }),
    executeToolCalls: async (_turn, toolCalls) => toolCalls.map(call => ({ callId: call.id, success: false, error: 'The tool refused.' })),
    checkContextWindowPreflight: async () => 'ok',
    normalizeUsage: value => value, estimateFreshTurnInputTokens: () => 0, getMessageQueueLength: () => 0, isReconciliationEnabled: () => false,
    setPendingToolCalls() {}, setStreamingActive() {}, setStreamingInputTokens() {}, addStreamingOutputTokens() {},
    setLastRequestInputTokens() {}, setLastInputTokens() {}, markTurnFailed: () => { failed = true; }, noteModelContextWindowWarning() {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    isPassiveKnowledgeInjectionEnabled: () => false, isPassiveCodeInjectionEnabled: () => false, getAlreadyInjectedKnowledgeIds: () => [],
    addInjectedKnowledgeIds() {}, recordTurnKnowledgeInjection() {}, nextTurnKnowledgeSequence: () => 1,
    contractIntake: { intake: async () => ({ kind: 'turn' }) },
    ...extra,
  };
  return { context, conversation, errors, calls: () => calls, failed: () => failed };
}

const failingCall = (call: number): ChatResponse => ({ content: '', toolCalls: [{ id: `c${call}`, name: 'probe', arguments: {} }], usage, stopReason: 'tool_call' });

describe('a turn whose tool rounds keep failing', () => {
  test('ends with a named error after repeated circuit-breaker trips, and each recovery notice reaches the model only once', async () => {
    const prompts: string[] = [];
    const systemPrompts = new Set<string>();
    const h = harness((request, call) => {
      const last = request.messages.at(-1);
      prompts.push(last?.role === 'user' && typeof last.content === 'string' ? last.content : '');
      systemPrompts.add(request.systemPrompt ?? '');
      return failingCall(call);
    });
    await executeOrchestratorTurnLoop(h.context);
    // Three trips of ten consecutive all-failed rounds each.
    expect(h.calls()).toBe(30);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.stopReason).toBe('tool_loop_circuit_breaker');
    expect(h.errors[0]!.error).toContain('send the request again');
    expect(h.failed()).toBe(true);
    // The first notice is on the call right after the first trip and gone on the next.
    expect(prompts[10]).toContain('[Tool recovery]');
    expect(prompts[11]).not.toContain('[Tool recovery]');
    // Recovery text travels after the history, so the provider's cached prefix survives every call.
    expect(systemPrompts.size).toBe(1);
    // The person sees the recovery as a warning the loop declared; nothing reads its level.
    expect(h.conversation.getMessageSnapshot().some(message => message.role === 'system' && message.notice?.level === 'warning'
      && message.content.startsWith('[Tool recovery]'))).toBe(true);
  }, 15_000);
});

describe('a verification journal that cannot be opened', () => {
  test('the turn runs, nothing is written through the journal location, and the person is told why the evidence is not saved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-loop-journal-'));
    try {
      const elsewhere = join(root, 'shared-state');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(root, '.goodvibes'));
      const h = harness((_request, call) => ({ content: 'done', toolCalls: [], usage, stopReason: 'completed' as const, ...(call < 0 ? {} : {}) }),
        { configManager: { get: () => undefined, getWorkingDirectory: () => root } as never });
      await executeOrchestratorTurnLoop(h.context);
      expect(h.calls()).toBeGreaterThan(0);
      expect(h.conversation.getMessageSnapshot().some(message => message.role === 'system'
        && message.content.includes('verification journal for this workspace could not be opened'))).toBe(true);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('completion checking', () => {
  test('a notice that arrives while the applicability reading runs does not restart the check', async () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('Say hello.');
    let changed = false, reads = 0;
    installJudgmentPort({ model: 'jev-latest', async ask(request) {
      reads++;
      if (!changed) { changed = true; conversation.addSystemMessage('[Daemon] A late notice arrived.'); }
      return fakePort(name => noulAnswer(name === 'completion_required' ? .01 : .01)).port.ask(request);
    } });
    const guard = new ResponseCompletionGuard();
    const correction = await guard.checkUntilAvailable(() => ({ request: 'Say hello.', response: 'Hello.', conversation, tools: [] }));
    expect(correction).toBeNull();
    expect(reads).toBe(1);
  });

  test('a delegate that stays pending releases the wait when the turn is cancelled', async () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('Review the repo.');
    conversation.addAssistantMessage('', { toolCalls: [{ id: 'agent', name: 'agent', arguments: { mode: 'spawn' } }] });
    conversation.addToolResults([{ callId: 'agent', success: true, output: '{"agentId":"queued"}' }]);
    const manager = { list: () => [{ id: 'queued', task: 'Review', status: 'pending', fullOutput: '' }] } as never;
    const controller = new AbortController();
    const waiting = waitForResponseDelegates(conversation, manager, { signal: controller.signal }, [], () => true).then(() => 'resolved', () => 'released');
    controller.abort(new Error('cancelled'));
    expect(await waiting).toBe('released');
  });
});
