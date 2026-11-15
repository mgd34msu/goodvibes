/**
 * What a sub-agent is told by its own turn loop, and how the loop ends: a run
 * cancelled before it starts stays cancelled, the turn ceiling is announced
 * before it is reached and settles like every other terminal path, the
 * circuit breaker gives the model one last reply, in-flight tools are logged,
 * and the permission mode is named. Drives the real `runAgentTask` against a
 * scripted provider.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../platform/src/platform/agents/orchestrator-runner.js';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import type { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import type { BackgroundPermissionManager } from '../platform/src/platform/agents/background-permission-gate.js';
import { callingAgentId } from '../platform/src/platform/agents/calling-agent.js';
import { ContextAccountingHolder, createContextAccountingTool } from '../platform/src/platform/tools/context-accounting/index.js';

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0,
  selectable: true,
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-ax', task: 'inspect the parser', template: 'engineer', tools: ['probe'], status: 'pending',
    startedAt: Date.now(), toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct',
    reviewMode: 'none', communicationLane: 'parent-only', ...overrides,
  };
}

interface Harness {
  readonly root: string;
  readonly requests: ChatRequest[];
  readonly started: string[];
  readonly failed: string[];
  readonly context: AgentOrchestratorRunContext;
}

function harness(reply: (call: number) => ChatResponse, options: { toolSucceeds?: boolean; extra?: Partial<AgentOrchestratorRunContext> } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'runner-ax-')); roots.push(root);
  const requests: ChatRequest[] = [], started: string[] = [], failed: string[] = [];
  const provider: LLMProvider = {
    name: 'fake', models: ['fake-model'],
    async chat(request) { requests.push(request); return reply(requests.length); },
  };
  const tools = new ToolRegistry();
  tools.register({ definition: { name: 'probe', description: 'Probe', parameters: { type: 'object' } },
    execute: async () => options.toolSucceeds === false ? { success: false, error: 'probe unavailable' } : { success: true, output: 'probe result' } });
  const context: AgentOrchestratorRunContext = {
    workingDirectory: root, surfaceRoot: undefined, runtimeBus: new RuntimeEventBus(), featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    emitAgentProgress: () => {}, emitAgentStarted: (id) => { started.push(id); }, emitAgentCancelledEvent: () => {},
    emitAgentFailedEvent: (id) => { failed.push(id); }, emitAgentCompletedEvent: () => {}, emitStreamDelta: () => {},
    processManager: undefined, messageBus: new AgentMessageBus(), knowledgeService: undefined, memoryRegistry: undefined,
    archetypeLoader: undefined, providerOptimizer: undefined,
    providerRegistry: {
      getCurrentModel: () => FAKE_MODEL, getForModel: () => provider, listModels: () => [FAKE_MODEL],
      getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0, recordContextWindowRejection: () => {},
    },
    getFullRegistry: () => tools,
    buildScopedRegistry: (_allowedNames, fullRegistry) => fullRegistry,
    resolveProviderForRecord: (_registry, _record, currentModel) => ({ provider, modelId: currentModel.id, requestedModelId: currentModel.registryKey }),
    resolveFallbackModelRoutes: () => [],
    ...options.extra,
  };
  return { root, requests, started, failed, context };
}

const toolTurn = (call: number): ChatResponse => ({
  content: '', toolCalls: [{ id: `call-${call}`, name: 'probe', arguments: { step: call } }],
  usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call',
});

function userText(request: ChatRequest): string {
  return request.messages.filter((message) => message.role === 'user').map((message) => String(message.content)).join('\n');
}

function sessionRecords(root: string, agentId: string): { type: string }[] {
  const find = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { const found = find(path); if (found) return found; }
      else if (entry === `${agentId}.jsonl` && dir.endsWith(join('sessions', 'agents'))) return path;
    }
    return undefined;
  };
  const file = find(root);
  if (!file) throw new Error('agent session log not written');
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string });
}

describe('sub-agent loop: start and end', () => {
  test('a run cancelled before it starts stays cancelled and never reaches the model', async () => {
    const h = harness(() => ({ content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }));
    const record = makeRecord({ status: 'cancelled' });
    await runAgentTask(h.context, record);
    expect(record.status).toBe('cancelled');
    expect(h.requests).toHaveLength(0);
    expect(h.started).toHaveLength(0);
    expect(h.failed).toHaveLength(0);
  });

  test('the model is warned at 80% of its turn budget, and the limit exit settles and stops leaked processes', async () => {
    let listed = 0;
    const stopped: string[] = [];
    let settled = 0;
    const processManager = {
      list: () => (listed++ === 0 ? [] : [{ id: 'leaked-process', startedBy: 'agent-ax' }, { id: 'operators-process' }]),
      stop: (id: string) => { stopped.push(id); return true; },
      hasBoundaryOwner: () => false,
    } as unknown as ProcessManager;
    const h = harness(toolTurn, { extra: { processManager } });
    const record = makeRecord({ maxTurns: 5 });
    await runAgentTask(h.context, record);

    expect(h.requests).toHaveLength(5);
    expect(userText(h.requests[2]!)).not.toContain('Turn budget');
    expect(userText(h.requests[3]!)).toContain('this is turn 4 of 5');
    expect(record.status).toBe('failed');
    expect(record.failureReason).toBe('max_turns');
    expect(stopped).toEqual(['leaked-process']);
    expect(h.failed).toEqual([record.id]);

    const settling = harness(toolTurn, { extra: { beforeRunSettlement: async () => { settled++; } } });
    await runAgentTask(settling.context, makeRecord({ id: 'agent-settles', maxTurns: 1 }));
    expect(settled).toBeGreaterThan(0);
  });

  test('a tool call is logged when it starts, not only when it settles', async () => {
    const h = harness((call) => call === 1 ? toolTurn(call)
      : { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });
    const record = makeRecord();
    await runAgentTask(h.context, record);
    const types = sessionRecords(h.root, record.id).map((entry) => entry.type);
    expect(types).toContain('tool_started');
    expect(types.indexOf('tool_started')).toBeLessThan(types.indexOf('tool_execution'));
  });

  test('a tool call is announced on the agents bus so a long silent call is not read as a stall', async () => {
    const h = harness((call) => call === 1 ? toolTurn(call)
      : { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });
    const awaiting: { agentId: string; callId: string; tool: string }[] = [];
    h.context.runtimeBus!.onDomain('agents', (envelope) => {
      if (envelope.payload.type === 'AGENT_AWAITING_TOOL') awaiting.push(envelope.payload);
    });
    const record = makeRecord();
    await runAgentTask(h.context, record);
    expect(awaiting).toEqual([expect.objectContaining({ agentId: record.id, callId: 'call-1', tool: 'probe' })]);
  });
});

describe('sub-agent loop: a tool that reports progress', () => {
  test('is not silent: its reports reach the watchdog as agent progress, at most once per interval', async () => {
    let clock = 1_000_000;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    const published: string[] = [];
    const h = harness((call) => call === 1 ? toolTurn(call)
      : { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });
    const tools = new ToolRegistry();
    tools.register({ definition: { name: 'probe', description: 'Probe', parameters: { type: 'object' } },
      execute: async (_args, options) => {
        const afterStart = published.length;
        for (const seconds of [1, 2, 6, 7, 12]) { clock = 1_000_000 + seconds * 1_000; options?.onProgress?.(); }
        published.push(`reports published: ${published.length - afterStart}`);
        return { success: true, output: 'probe result' };
      } });
    const context = { ...h.context, getFullRegistry: () => tools, emitAgentProgress: (_id: string, text: string) => { published.push(text); } };
    try {
      await runAgentTask(context, makeRecord());
    } finally { now.mockRestore(); }
    // Reports at +6 s and +12 s are published; those at +1 s, +2 s and +7 s fall inside the 5 s interval.
    expect(published).toContain('reports published: 2');
  });
});

describe('sub-agent loop: cache use is measurable', () => {
  test('every turn\'s log record carries its cache reads, null when the provider reported none, and the prompt start does not change between turns', async () => {
    const h = harness((call) => call === 1
      ? { ...toolTurn(call), usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 20 } }
      : { content: 'done', toolCalls: [], usage: { inputTokens: 100, outputTokens: 5 }, stopReason: 'completed' });
    const record = makeRecord();
    await runAgentTask(h.context, record);
    const turns = sessionRecords(h.root, record.id).filter((entry) => entry.type === 'llm_response') as unknown as { cacheReadTokens: number | null; cacheWriteTokens: number | null }[];
    expect(turns.map((turn) => [turn.cacheReadTokens, turn.cacheWriteTokens])).toEqual([[80, 20], [null, null]]);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.systemPrompt).toBe(h.requests[0]!.systemPrompt);
  });
});

describe('sub-agent loop: asking about its own context', () => {
  test('each worker\'s context_accounting answers for that worker: its turns against its limit, its measured tokens, its tool calls', async () => {
    const holder = new ContextAccountingHolder();
    const answers: Record<string, unknown>[] = [];
    const h = harness((call) => call === 1
      ? { content: '', toolCalls: [{ id: 'call-1', name: 'context_accounting', arguments: {} }], usage: { inputTokens: 700, outputTokens: 30, cacheReadTokens: 200 }, stopReason: 'tool_call' }
      : { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }, { extra: { contextAccountingHolder: holder } });
    const wrapped = { ...h.context, getFullRegistry: () => {
      const registry = new ToolRegistry();
      registry.register({ definition: { name: 'context_accounting', description: 'Context', parameters: { type: 'object' } },
        execute: async (args, options) => { const result = await createContextAccountingTool(holder).execute(args, options); answers.push(JSON.parse(result.output!) as Record<string, unknown>); return result; } });
      return registry;
    } };
    const record = makeRecord({ tools: ['context_accounting'], maxTurns: 10 });
    await runAgentTask(wrapped, record);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      scope: 'worker agent agent-ax',
      turns: { used: 1, limit: 10 },
      run: { mode: 'engineer', toolCalls: 1 },
    });
    expect(JSON.stringify(answers[0])).toContain('700');
  });
});

describe('sub-agent loop: who a tool call belongs to', () => {
  test('a tool body sees the host\'s id for the calling agent, not anything the model passed', async () => {
    const seen: (string | undefined)[] = [];
    const h = harness((call) => call === 1 ? { ...toolTurn(call), toolCalls: [{ id: 'call-1', name: 'probe', arguments: { agentId: 'someone-else' } }] }
      : { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });
    const tools = new ToolRegistry();
    tools.register({ definition: { name: 'probe', description: 'Probe', parameters: { type: 'object' } },
      execute: async () => { seen.push(callingAgentId()); return { success: true, output: 'probe result' }; } });
    await runAgentTask({ ...h.context, getFullRegistry: () => tools }, makeRecord());
    expect(seen).toEqual(['agent-ax']);
    expect(callingAgentId()).toBeUndefined();
  });
});

describe('sub-agent loop: circuit breaker', () => {
  test('the breaker gives the model one final reply, and that reply is kept', async () => {
    const report = 'I was probing the parser; every probe call failed with "probe unavailable".';
    const h = harness((call) => call <= 10 ? toolTurn(call)
      : { content: report, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }, { toolSucceeds: false });
    const record = makeRecord();
    await runAgentTask(h.context, record);

    expect(h.requests).toHaveLength(11);
    expect(userText(h.requests[10]!)).toContain('CIRCUIT BREAKER');
    expect(userText(h.requests[5]!)).toContain('every tool call failed');
    expect(record.status).toBe('failed');
    expect(record.failureReason).toBe('circuit_breaker');
    expect(record.fullOutput).toBe(report);
  });
});

describe('sub-agent loop: permission mode', () => {
  test('the session permission mode is named to the model', async () => {
    const permissionManager = { getMode: () => 'safe-jev' } as unknown as BackgroundPermissionManager;
    const h = harness(() => ({ content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }),
      { extra: { permissionManager } });
    await runAgentTask(h.context, makeRecord({ tools: [] }));
    expect(h.requests[0]?.systemPrompt).toContain('Permission mode: Safe — Jev.');
  });
});
