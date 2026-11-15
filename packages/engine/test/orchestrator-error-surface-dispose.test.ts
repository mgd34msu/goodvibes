import { afterEach, describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { Orchestrator, QueuedInputUndeliveredError } from '../platform/src/platform/core/orchestrator.js';
import { ConversationManager } from '../platform/src/platform/core/conversation.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { PermissionManager } from '../platform/src/platform/permissions/manager.js';
import type { ModelDefinition, ProviderRegistry } from '../platform/src/platform/providers/registry.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { HookEvent, HookResult } from '../platform/src/platform/hooks/types.js';
import { UNKNOWN_MODEL_PRICING } from '../platform/src/platform/providers/model-pricing.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ProviderError } from '../platform/src/platform/types/errors.js';
import { useCoreReadings } from './_helpers/core-readings.ts';
import { waitFor } from './_helpers/test-timeout.js';
import { currentTurnSurfaceId } from '../platform/src/platform/security/turn-boundary.js';

useCoreReadings({ intent: 'chat', needsPlan: false, risk: 0 });
const orchestrators: Orchestrator[] = [];
afterEach(() => { for (const orchestrator of orchestrators.splice(0)) orchestrator.dispose(); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const WINDOW = 1_000_000;

interface FixtureOptions {
  readonly inputTokens?: number;
  readonly hook?: (event: HookEvent) => Promise<HookResult>;
  readonly chat?: (request: ChatRequest) => Promise<ChatResponse>;
  readonly scrollToEnd?: () => void;
  readonly getSystemPrompt?: () => string;
  readonly settings?: Record<string, unknown>;
}

function fixture(options: FixtureOptions = {}) {
  const runtimeBus = new RuntimeEventBus();
  const events: Array<{ type: string; turnId?: string | undefined }> = [];
  for (const type of ['TURN_SUBMITTED', 'TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL', 'PREFLIGHT_FAIL', 'STREAM_START', 'STREAM_END'] as const) {
    runtimeBus.on(type, (envelope) => { events.push({ type, turnId: (envelope.payload as { turnId?: string }).turnId }); });
  }
  const conversation = new ConversationManager();
  const model: ModelDefinition = {
    id: 'test', registryKey: 'test:test', displayName: 'Test', description: 'test', provider: 'test',
    contextWindow: WINDOW, selectable: true,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
  };
  let calls = 0;
  const provider: LLMProvider = {
    name: 'test', models: ['test'],
    chat: async (request) => {
      calls++;
      if (options.chat) return options.chat(request);
      return { content: `final answer ${calls}`, toolCalls: [], usage: { inputTokens: options.inputTokens ?? 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
  const providerRegistry = {
    getCurrentModel: () => model, getForModel: () => provider,
    getContextWindowForModel: () => WINDOW,
    getKnownContextWindowForModel: () => WINDOW,
    getTokenLimitsForModel: () => ({ maxOutputTokens: 200 }),
    reconcileObservedContextWindow: () => {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
  } as unknown as ProviderRegistry;
  const settings: Record<string, unknown> = {
    'behavior.autoCompactThreshold': 80,
    'behavior.staleContextWarnings': true,
    'behavior.notifyOnComplete': true,
    ...options.settings,
  };
  const configManager = {
    get: (key: string) => key in settings ? settings[key] : key === 'judgment.policy' ? undefined : false,
    getCategory: () => ({}), getWorkingDirectory: () => process.cwd(),
  } as unknown as ConfigManager;
  const orchestrator = new Orchestrator({
    conversation, toolRegistry: new ToolRegistry(), getViewportHeight: () => 10, scrollToEnd: options.scrollToEnd ?? (() => {}),
    permissionManager: { getMode: () => 'default', check: async () => true } as unknown as PermissionManager,
    getSystemPrompt: options.getSystemPrompt ?? (() => 'system'),
    runtimeBus,
    ...(options.hook ? { hookDispatcher: { fire: options.hook } } : {}),
    services: {
      agentManager: { list: () => [], spawn: () => { throw new Error('unexpected agent spawn'); } },
      contractRunner: { list: () => [] }, contractIntake: { intake: async () => ({ kind: 'turn' }) },
    },
  });
  orchestrator.setCoreServices({ configManager, providerRegistry });
  orchestrators.push(orchestrator);
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const types = () => events.map(event => event.type);
  return { orchestrator, conversation, events, types, settle, runtimeBus };
}

const reply = (content: string): ChatResponse => ({ content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });

describe('dispose settles queued input exactly once', () => {
  test('a disposed orchestrator is no longer busy, and a second dispose does not settle the queue again', async () => {
    const entered = deferred(), release = deferred<ChatResponse>();
    const f = fixture({ chat: async () => { entered.resolve(); return release.promise; } });
    const first = f.orchestrator.handleUserInput('first');
    await entered.promise;
    let rejections = 0;
    const queued = f.orchestrator.handleUserInput('second', undefined, { awaitQueuedTurn: true }).catch((error: unknown) => {
      if (error instanceof QueuedInputUndeliveredError) rejections++;
    });
    expect(f.orchestrator.listQueuedMessages()).toHaveLength(1);
    f.orchestrator.dispose();
    f.orchestrator.dispose();
    await queued;
    release.resolve(reply('first answer'));
    await first.catch(() => {});
    expect(rejections).toBe(1);
    expect(f.orchestrator.listQueuedMessages()).toHaveLength(0);
    await waitFor(() => !f.orchestrator.isBusy);
  });
});

describe('background recovery keeps the input surface of the request it continues', () => {
  test('the recovery turn runs under the surface the last user turn arrived on, not the caller\'s context', async () => {
    const surfaces: Array<string | undefined> = [];
    const f = fixture({ chat: async () => { surfaces.push(currentTurnSurfaceId()); return reply(`answer ${surfaces.length}`); } });
    await f.orchestrator.handleUserInput('summarise my inbox', undefined, { origin: { source: 'email', surface: 'mailbox', ownerDirect: false } });
    expect(surfaces).toEqual(['mailbox']);
    // The flush that resumes background work is scheduled from a bare event handler: no surface in scope.
    expect(currentTurnSurfaceId()).toBeUndefined();
    const resume = (f.orchestrator as unknown as { resumeBackgroundWork(items: readonly unknown[], signal: AbortSignal): Promise<void> }).resumeBackgroundWork.bind(f.orchestrator);
    await resume([{ kind: 'agent-finished' }], new AbortController().signal);
    expect(surfaces).toEqual(['mailbox', 'mailbox']);
  });

  test('an owner-typed request resumes as the owner', async () => {
    const surfaces: Array<string | undefined> = [];
    const f = fixture({ chat: async () => { surfaces.push(currentTurnSurfaceId()); return reply('ok'); } });
    await f.orchestrator.handleUserInput('hello');
    const resume = (f.orchestrator as unknown as { resumeBackgroundWork(items: readonly unknown[], signal: AbortSignal): Promise<void> }).resumeBackgroundWork.bind(f.orchestrator);
    await resume([], new AbortController().signal);
    expect(surfaces).toEqual([undefined, undefined]);
  });
});

describe('a failed turn publishes the same redacted text the transcript shows', () => {
  test('TURN_ERROR carries the formatted, redacted message and not the raw provider text', async () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const f = fixture({ chat: async () => { throw new Error(`upstream rejected the request; credential ${secret} was echoed back`); } });
    const published: string[] = [];
    f.runtimeBus.on('TURN_ERROR', (envelope) => { published.push((envelope.payload as { error: string }).error); });
    await f.orchestrator.handleUserInput('hello').catch(() => {});
    await f.settle();
    expect(published).toHaveLength(1);
    expect(published[0]).not.toContain(secret);
    const local = f.conversation.getMessageSnapshot().filter(message => message.role === 'system').map(message => String(message.content));
    expect(local).toContain(published[0]!);
  });

  test('a provider failure carries its HTTP status and connection errno as fields, not only in the text', async () => {
    // Reading the provider failure for the transcript asks the judgment port; answer it so the turn's own error path runs.
    const previous = installJudgmentPort(fakePort((_name, question) => (question.type === 'choice' ? choiceAnswer(question, Object.keys(question.criteria)[0]!, 0.99) : noulAnswer(0.01))).port);
    try {
    const f = fixture({ chat: async () => { throw new ProviderError('unauthorized', 401); } });
    const payloads: Array<{ status?: number; code?: string }> = [];
    f.runtimeBus.on('TURN_ERROR', (envelope) => { payloads.push(envelope.payload as { status?: number; code?: string }); });
    await f.orchestrator.handleUserInput('hello').catch(() => {});
    await f.settle();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.status).toBe(401);

    const refused = fixture({ chat: async () => { throw new ProviderError('connect failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); } });
    const refusedPayloads: Array<{ status?: number; code?: string }> = [];
    refused.runtimeBus.on('TURN_ERROR', (envelope) => { refusedPayloads.push(envelope.payload as { status?: number; code?: string }); });
    await refused.orchestrator.handleUserInput('hello').catch(() => {});
    await refused.settle();
    expect(refusedPayloads[0]!.code).toBe('ECONNREFUSED');
    expect(refusedPayloads[0]!.status).toBeUndefined();
    } finally { installJudgmentPort(previous); }
  });
});
