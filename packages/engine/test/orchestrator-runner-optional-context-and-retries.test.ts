/**
 * Provider retries and optional context in the agent turn loop (`runAgentTask`),
 * driven with a scripted provider: a failed optional knowledge reading does not
 * fail the run, transient provider failures stop being retried after a bounded
 * total wait, and the full system prompt returns after the emergency one served
 * the retry that followed a context-size rejection.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../platform/src/platform/agents/orchestrator-runner.js';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.js';
import type { ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import { useFailureReadings } from './_helpers/failure-readings.ts';

const NETWORK_WORDING = 'socket hang up while streaming the reply';
const CONTEXT_WORDING = 'prompt is too long for this model context window';

useFailureReadings([
  [NETWORK_WORDING, { category: 'network', transientNetwork: true, beforeResponse: true }],
  [CONTEXT_WORDING, { category: 'unknown', contextExceeded: true }],
]);

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model', provider: 'fake', registryKey: 'fake:fake-model', displayName: 'Fake Model', description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true,
};

interface Emitted { readonly failed: string[]; readonly completed: string[] }

function makeContext(workingDirectory: string, provider: LLMProvider, emitted: Emitted, registry = new ToolRegistry()): AgentOrchestratorRunContext {
  return {
    workingDirectory, surfaceRoot: undefined, runtimeBus: new RuntimeEventBus(), featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    emitAgentProgress: () => {}, emitAgentStarted: () => {}, emitAgentCancelledEvent: () => {},
    emitAgentFailedEvent: (id) => { emitted.failed.push(id); },
    emitAgentCompletedEvent: (id) => { emitted.completed.push(id); },
    emitStreamDelta: () => {}, processManager: undefined, messageBus: new AgentMessageBus(),
    knowledgeService: undefined, memoryRegistry: undefined, archetypeLoader: undefined, providerOptimizer: undefined,
    providerRegistry: {
      getCurrentModel: () => FAKE_MODEL, getForModel: () => provider, listModels: () => [FAKE_MODEL],
      getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0, recordContextWindowRejection: () => {},
    },
    getFullRegistry: () => registry,
    buildScopedRegistry: (_allowedNames, fullRegistry) => fullRegistry,
    resolveProviderForRecord: (_registry, _record, currentModel) => ({ provider, modelId: currentModel.id, requestedModelId: currentModel.registryKey }),
    resolveFallbackModelRoutes: () => [],
  };
}

function makeRecord(id: string, tools: string[] = []): AgentRecord {
  return {
    id, task: 'do work', template: 'engineer', tools, status: 'pending', startedAt: Date.now(), toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only',
  };
}

const done: ChatResponse = { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'runner-retries-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('transient provider failures', () => {
  test('a provider that never recovers fails the run with its last error once the total wait is spent', async () => {
    const record = makeRecord('ag-endless-network');
    let calls = 0;
    const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat() { calls += 1; throw new Error(NETWORK_WORDING); } };
    const waits: number[] = [];
    const emitted: Emitted = { failed: [], completed: [] };
    await runAgentTask({ ...makeContext(dir, provider, emitted), waitForRetry: async (delayMs) => { waits.push(delayMs); } }, record);

    expect(record.status).toBe('failed');
    expect(emitted.failed).toEqual([record.id]);
    // Every wait was taken, none was skipped, and the request was tried once more after the last one.
    expect(calls).toBe(waits.length + 1);
    expect(waits.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(20 * 60_000);
    expect(waits.length).toBeGreaterThan(5);
  });
});

describe('optional knowledge retrieval', () => {
  test('a retrieval that fails on a later turn does not fail the run', async () => {
    const record = makeRecord('ag-optional-knowledge', ['read_progress']);
    let reads = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: 'read_progress', description: 'Read', parameters: { type: 'object' } },
      execute: async () => ({ success: true, output: 'read' }) });
    // The first call is the spawn-time selection; every later one is a per-turn retrieval.
    const memoryRegistry = {
      getAll: () => { reads += 1; if (reads > 1) throw new Error('memory reading unavailable'); return []; },
      semanticCandidates: () => [],
      vectorStats: () => ({ backend: 'sqlite-vec' as const, enabled: false, available: false, path: '', dimensions: 0, indexedRecords: 0,
        embeddingProviderId: 'none', embeddingProviderLabel: 'none' }),
    };
    let calls = 0;
    const provider: LLMProvider = {
      name: 'fake', models: ['fake-model'],
      async chat(): Promise<ChatResponse> {
        calls += 1;
        return calls === 1
          ? { content: '', toolCalls: [{ id: 'c1', name: 'read_progress', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' }
          : done;
      },
    };
    const emitted: Emitted = { failed: [], completed: [] };
    await runAgentTask({ ...makeContext(dir, provider, emitted, registry), memoryRegistry }, record);
    expect(reads).toBeGreaterThan(1);
    expect(record.status).toBe('completed');
    expect(emitted.failed).toEqual([]);
  });
});

describe('the emergency prompt after a context-size rejection', () => {
  test('serves only the retry; the next turn carries the full prompt again', async () => {
    const record = makeRecord('ag-emergency-prompt', ['read_progress']);
    const registry = new ToolRegistry();
    registry.register({ definition: { name: 'read_progress', description: 'Read', parameters: { type: 'object' } },
      execute: async () => ({ success: true, output: 'read' }) });
    const prompts: string[] = [];
    const provider: LLMProvider = {
      name: 'fake', models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        prompts.push(request.systemPrompt ?? '');
        if (prompts.length === 1) throw new Error(CONTEXT_WORDING);
        if (prompts.length === 2) return { content: '', toolCalls: [{ id: 'c1', name: 'read_progress', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        return done;
      },
    };
    const emitted: Emitted = { failed: [], completed: [] };
    await runAgentTask(makeContext(dir, provider, emitted, registry), record);
    expect(record.status).toBe('completed');
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('You are an autonomous agent. Complete your task.');
    expect(prompts[2]).toBe(prompts[0]!);
  });
});
