import { afterEach, describe, expect, spyOn, test } from 'bun:test';
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
import { useCoreReadings } from './_helpers/core-readings.ts';
import { waitFor } from './_helpers/test-timeout.js';

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

/** A provider call that ends only when its request is aborted, as a real transport does. */
function untilAborted(request: ChatRequest): Promise<ChatResponse> {
  return new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  });
}

const allow = async (): Promise<HookResult> => ({ ok: true });

describe('a finished answer stays the turn outcome after maintenance appends to the transcript', () => {
  test('a context-usage warning after the answer still completes the turn', async () => {
    const f = fixture({ inputTokens: 750_000 });
    await f.orchestrator.handleUserInput('hello');
    await f.settle();
    expect(f.types()).toContain('TURN_COMPLETED');
    expect(f.types()).not.toContain('TURN_ERROR');
    const messages = f.conversation.getMessageSnapshot();
    expect(messages.some(message => message.role === 'system' && String(message.content).startsWith('Context usage at 75%'))).toBe(true);
    expect(messages.some(message => message.role === 'system' && String(message.content).startsWith('[Judgment]'))).toBe(false);
  });

  test('a failed auto-compaction after the answer still completes the turn', async () => {
    const f = fixture({ inputTokens: 850_000 });
    await f.orchestrator.handleUserInput('hello');
    await f.settle();
    expect(f.types()).toContain('TURN_COMPLETED');
    expect(f.types()).not.toContain('TURN_ERROR');
    expect(f.orchestrator.isTurnActive).toBe(false);
  });
});

describe('cancelling after the answer exists', () => {
  test('stops post-turn compaction but keeps the answer and completes the turn', async () => {
    const entered = deferred(), release = deferred();
    const f = fixture({
      inputTokens: 850_000,
      hook: async (event) => {
        if (event.path === 'Pre:compact:auto') { entered.resolve(); await release.promise; }
        return { ok: true };
      },
    });
    const turn = f.orchestrator.handleUserInput('hello');
    await entered.promise;
    expect(f.orchestrator.isTurnActive).toBe(true);
    f.orchestrator.abort();
    release.resolve();
    await turn;
    await f.settle();
    expect(f.types()).toContain('TURN_COMPLETED');
    expect(f.types()).not.toContain('TURN_CANCEL');
    const messages = f.conversation.getMessageSnapshot();
    expect(messages.some(message => message.role === 'assistant' && message.content === 'final answer 1')).toBe(true);
    expect(messages.find(message => message.role === 'user')).not.toHaveProperty('cancelled');
    expect(messages.at(-1)).toMatchObject({ role: 'system', content: 'Auto-compaction cancelled.' });
    expect(f.orchestrator.isTurnActive).toBe(false);
  });
});

describe('stream events stay paired', () => {
  test('a hook that blocks the provider call closes the stream it opened', async () => {
    const f = fixture({
      hook: async (event) => event.path === 'Pre:llm:chat' ? { ok: true, decision: 'deny', reason: 'blocked by policy' } : allow(),
    });
    await f.orchestrator.handleUserInput('hello');
    await f.settle();
    const types = f.types();
    expect(types.filter(type => type === 'STREAM_START')).toHaveLength(1);
    expect(types.filter(type => type === 'STREAM_END')).toHaveLength(1);
    expect(types).toContain('TURN_ERROR');
  });

  test('a failure after the stream opened closes it, and the next turn starts clean', async () => {
    let prompts = 0;
    const f = fixture({ settings: { 'display.stream': true }, getSystemPrompt: () => { if (++prompts === 1) throw new Error('prompt unavailable'); return 'system'; } });
    await f.orchestrator.handleUserInput('first');
    await f.orchestrator.handleUserInput('second');
    await f.settle();
    const types = f.types();
    expect(types.filter(type => type === 'STREAM_START')).toHaveLength(2);
    expect(types.filter(type => type === 'STREAM_END')).toHaveLength(2);
    const [first, second] = types.reduce<string[][]>((turns, type) => { if (type === 'TURN_SUBMITTED') turns.push([]); turns.at(-1)?.push(type); return turns; }, []);
    expect(first!.filter(type => type === 'STREAM_END')).toHaveLength(1);
    expect(second!.filter(type => type === 'STREAM_END')).toHaveLength(1);
  });
});

describe('completion notice', () => {
  test('rings for a completed long turn and stays silent for a cancelled one', async () => {
    let clock = 1_000_000;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const bells: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { if (chunk === '\x07') bells.push('bell'); return true; }) as typeof process.stdout.write);
    try {
      const done = fixture({ chat: async () => { clock += 10_000; return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }; } });
      await done.orchestrator.handleUserInput('long turn');
      expect(bells).toHaveLength(1);

      const entered = deferred();
      const cancelled = fixture({ chat: async (request) => { clock += 10_000; entered.resolve(); return untilAborted(request); } });
      const turn = cancelled.orchestrator.handleUserInput('cancelled turn');
      await entered.promise;
      cancelled.orchestrator.abort();
      await turn;
      expect(bells).toHaveLength(1);
    } finally {
      write.mockRestore(); now.mockRestore();
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});

describe('a queued input that asks to await its own turn', () => {
  test('settles when its own turn ends, not when it is queued', async () => {
    const entered = deferred(), release = deferred<ChatResponse>();
    let call = 0;
    const f = fixture({ chat: async () => {
      call++;
      if (call === 1) { entered.resolve(); return release.promise; }
      return { content: 'second answer', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } });
    const first = f.orchestrator.handleUserInput('first');
    await entered.promise;
    let queuedSettled = false;
    const queued = f.orchestrator.handleUserInput('second', undefined, { awaitQueuedTurn: true }).then(() => { queuedSettled = true; });
    await f.settle();
    expect(queuedSettled).toBe(false);
    release.resolve({ content: 'first answer', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });
    await first; await queued;
    expect(f.conversation.getMessageSnapshot().some(message => message.role === 'assistant' && message.content === 'second answer')).toBe(true);
  });

  test('rejects when the orchestrator is disposed before the queued input runs', async () => {
    const entered = deferred();
    const f = fixture({ chat: async (request) => { entered.resolve(); return untilAborted(request); } });
    const first = f.orchestrator.handleUserInput('first');
    await entered.promise;
    const queued = f.orchestrator.handleUserInput('second', undefined, { awaitQueuedTurn: true });
    f.orchestrator.dispose();
    await expect(queued).rejects.toBeInstanceOf(QueuedInputUndeliveredError);
    await first;
  });

  test('settles without error when the owner deletes it from the queue', async () => {
    const entered = deferred(), release = deferred<ChatResponse>();
    const f = fixture({ chat: async () => { entered.resolve(); return release.promise; } });
    const first = f.orchestrator.handleUserInput('first');
    await entered.promise;
    const queued = f.orchestrator.handleUserInput('second', undefined, { awaitQueuedTurn: true });
    const [entry] = f.orchestrator.listQueuedMessages();
    expect(f.orchestrator.deleteQueuedMessage(entry!.id)).toBe(true);
    await queued;
    release.resolve({ content: 'first answer', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });
    await first;
    await waitFor(() => !f.orchestrator.isBusy);
  });
});

describe('a throw while a turn settles never leaves the orchestrator occupied', () => {
  test('a render callback that throws as the turn ends still releases the turn', async () => {
    let scrolls = 0;
    const f = fixture({ scrollToEnd: () => { if (++scrolls > 1) throw new Error('renderer gone'); } });
    await expect(f.orchestrator.handleUserInput('hello')).rejects.toThrow('renderer gone');
    expect(f.orchestrator.isBusy).toBe(false);
  });

  test('a failure while starting post-turn compaction does not leave compaction marked running', async () => {
    const f = fixture({ inputTokens: 850_000 });
    const emit = f.runtimeBus.emit.bind(f.runtimeBus);
    const failing = spyOn(f.runtimeBus, 'emit').mockImplementation((domain, envelope) => {
      if (envelope.type === 'OPS_CONTEXT_WARNING') throw new Error('observer failed');
      emit(domain, envelope);
    });
    try {
      await f.orchestrator.handleUserInput('hello');
      await f.settle();
      expect(f.orchestrator.isBusy).toBe(false);
      expect(f.orchestrator.isTurnActive).toBe(false);
    } finally { failing.mockRestore(); }
  });
});
