import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { redactionCredential, residualCredential } from '@goodvibes-jev/engine/platform/platform/utils';
import { authoredPrivacyAnswer, errorText } from '../helpers/authored-diagnostic-readings.ts';
/**
 * Agent context window awareness tests.
 *
 * Tests:
 *  1. The pre-call guard trims the system prompt once the estimate passes 85% of the window
 *  2. Retry on context-size-exceeded provider error
 *  3. Feature flag disabled → no compaction, error re-thrown
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { AgentOrchestrator } from '@goodvibes-jev/engine/platform/platform/agents';
import type { AgentRecord } from '@goodvibes-jev/engine/platform/platform/tools';
import type { LLMProvider, ChatRequest, ChatResponse } from '@goodvibes-jev/engine/platform/platform/providers';
import { getTestAgentOrchestrator, getTestProviderRegistry, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
// The field-name reading no longer exists (the activity log masks locally); a request naming it is unexpected.
const fieldKind = { name: 'engine.redaction.field-kind', items: { kind: { question: {} as never } } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'g01-test-01',
    task: 'Reply with a short confirmation.',
    template: 'general',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    orchestrationDepth: 0,
    toolCallCount: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'contract',
    communicationLane: 'direct',
    ...overrides,
  };
}

function makeMockProvider(
  responses: Array<{
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    throws?: Error;
  }>,
): LLMProvider {
  let idx = 0;
  return {
    name: 'mock',
    models: ['mock-model'],
    chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx++;
      if (resp.throws) throw resp.throws;
      const toolCalls = resp.toolCalls ?? [];
      return {
        content: resp.content,
        toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: toolCalls.length > 0 ? 'tool_call' : 'completed',
      };
    }),
  };
}

const MOCK_MODEL_SMALL = {
  id: 'mock-model',
  provider: 'mock',
  registryKey: 'mock:mock-model',
  displayName: 'Mock Small',
  description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
  contextWindow: 4096,
  selectable: true,
};

const MOCK_MODEL_LARGE = {
  id: 'mock-model',
  provider: 'mock',
  registryKey: 'mock:mock-model',
  displayName: 'Mock Large',
  description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
  contextWindow: 128_000,
  selectable: true,
};

async function withMockProvider<T>(
  provider: LLMProvider,
  modelDef: typeof MOCK_MODEL_SMALL,
  fn: () => Promise<T>,
): Promise<T> {
  const reg = (await getTestProviderRegistry());
  const readDiagnostic = authoredPrivacyAnswer({ parts: [[errorText('401 Unauthorized')]] });
  const diagnostics = fakePort((name, question, state) => {
    const diagnostic = readDiagnostic(name, question, state);
    if (diagnostic !== undefined) return diagnostic;
    const error = typeof state === 'string' ? state : JSON.stringify(state);
    if (name === 'category') return choiceAnswer(question, error.includes('401') ? 'authentication' : 'bad_request', 0.99);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.99);
    if (name === 'context_exceeded') return noulAnswer(/context|prompt is too long/i.test(error) ? 0.99 : 0.01);
    if (['billing', 'rate_limited', 'transient_network', 'provider_unusable', 'before_response'].includes(name)) return noulAnswer(0.01);
    throw new Error(`Unexpected synthetic error reading: ${name}`);
  });
  const completion = fakePort(name => noulAnswer(name === 'completion_required' ? 0.99 : 0.01));
  const previousPort = installJudgmentPort({ model: diagnostics.port.model, ask(request) {
    if (['engine.core.completion-applicability', 'engine.core.response-completion', 'engine.core.execution-assurance', 'engine.core.delegation-consolidation']
      .includes(String(request.context?.battery))) return completion.port.ask(request);
    return diagnostics.port.ask(request);
  } });
  const origGetForModel = reg.getForModel.bind(reg);
  const origGetCurrentModel = reg.getCurrentModel.bind(reg);
  reg.getForModel = mock(() => provider);
  reg.getCurrentModel = mock(() => modelDef);
  try {
    return await fn();
  } finally {
    installJudgmentPort(previousPort);
    reg.getForModel = origGetForModel;
    reg.getCurrentModel = origGetCurrentModel;
  }
}

// ---------------------------------------------------------------------------
// Integration: agent runs normally without compaction needed
// ---------------------------------------------------------------------------

describe('AgentOrchestrator context-window awareness', () => {
  // The flag test installs a manager on the shared orchestrator; start every test from a clean runtime.
  beforeEach(() => { resetTestRuntimeServices(); });

  test('completes successfully when context is within limits', async () => {
    const provider = makeMockProvider([{ content: 'done' }]);
    const record = makeRecord({ id: 'g01-normal-01' });

    await withMockProvider(provider, MOCK_MODEL_LARGE, async () => {
      const orch = (await getTestAgentOrchestrator());
      await orch.runAgent(record);
    });

    expect(record.status).toBe('completed');
    expect(record.fullOutput).toBe('done');
  });

  test('retries once on context-size-exceeded error and succeeds', async () => {
    const contextError = new Error('Context size exceeded: prompt has 200000 tokens');
    const provider = makeMockProvider([
      { content: '', throws: contextError },
      { content: 'done after compaction' },
    ]);
    const record = makeRecord({ id: 'g01-retry-01' });

    await withMockProvider(provider, MOCK_MODEL_LARGE, async () => {
      const orch = (await getTestAgentOrchestrator());
      await orch.runAgent(record);
    });

    expect(record.status).toBe('completed');
    expect(record.fullOutput).toBe('done after compaction');
    // provider.chat called twice: first fails, second succeeds
    expect((provider.chat as ReturnType<typeof mock>).mock.calls.length).toBe(2);
  });

  test('fails permanently on second context-size-exceeded error (no infinite loop)', async () => {
    const contextError = new Error('context_length_exceeded: max 4096 tokens');
    const provider = makeMockProvider([
      { content: '', throws: contextError },
      { content: '', throws: contextError },
    ]);
    const record = makeRecord({ id: 'g01-retry-fail-01' });

    await withMockProvider(provider, MOCK_MODEL_SMALL, async () => {
      const orch = (await getTestAgentOrchestrator());
      await orch.runAgent(record);
    });

    expect(record.status).toBe('failed');
    // contextRetried flag prevents a third attempt, only 2 chat calls made
    expect((provider.chat as ReturnType<typeof mock>).mock.calls.length).toBe(2);
  });

  test('non-context errors are re-thrown without compaction retry', async () => {
    // Network errors use separate retry logic with delays, so use a non-retryable error.
    const authError = new Error('401 Unauthorized');
    const provider = makeMockProvider([
      { content: '', throws: authError },
    ]);
    const record = makeRecord({ id: 'g01-auth-error-01' });

    await withMockProvider(provider, MOCK_MODEL_LARGE, async () => {
      const orch = (await getTestAgentOrchestrator());
      await orch.runAgent(record);
    });

    expect(record.status).toBe('failed');
    expect(record.error).toContain('401');
    // Only one call, no compaction retry for auth errors
    expect((provider.chat as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test('pre-call guard: the system prompt is trimmed only when the estimate passes 85% of the window', async () => {
    const runOnce = async (model: typeof MOCK_MODEL_SMALL, id: string, task: string): Promise<{ readonly systemPrompt: string; readonly messageCount: number }> => {
      const captured: Array<{ readonly systemPrompt: string; readonly messageCount: number }> = [];
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          captured.push({ systemPrompt: params.systemPrompt ?? '', messageCount: params.messages.length });
          return { content: 'done', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' };
        }),
      };
      const record = makeRecord({ id, task });
      await withMockProvider(provider, model, async () => {
        const orch = (await getTestAgentOrchestrator());
        await orch.runAgent(record);
      });
      expect(record.status).toBe('completed');
      expect(captured).toHaveLength(1);
      return captured[0]!;
    };

    const roomy = await runOnce(MOCK_MODEL_SMALL, 'g01-precompact-roomy', 'Reply with a short confirmation.');
    const cramped = await runOnce(MOCK_MODEL_SMALL, 'g01-precompact-tiny', 'Reply with a short confirmation. Context: a harmless note. '.repeat(250));

    // Both runs share one window (the registry's 4096-token entry for the mock model);
    // only the task size differs. The long task pushes the estimate past 85% of the
    // window, so the guard rebuilds a shorter system prompt into the remaining room.
    expect(roomy.systemPrompt.length).toBeGreaterThan(0);
    expect(cramped.systemPrompt.length).toBeLessThan(roomy.systemPrompt.length);
  });

  test('feature flag disabled: context-exceeded error is not retried', async () => {
    const contextError = new Error('context_length_exceeded: over limit');
    const provider = makeMockProvider([
      { content: '', throws: contextError },
      { content: 'should not be reached' },
    ]);
    const record = makeRecord({ id: 'g01-flag-off-01' });

    // Create a mock FeatureFlagManager that reports the flag as disabled
    const mockFlagManager = {
      isEnabled: mock((flagId: string) => {
        if (flagId === 'agent-context-window-awareness') return false;
        return true;
      }),
    };

    await withMockProvider(provider, MOCK_MODEL_LARGE, async () => {
      const orch = (await getTestAgentOrchestrator());
      // @ts-expect-error, duck-typed mock for FeatureFlagManager
      orch.setFeatureFlagManager(mockFlagManager);
      await orch.runAgent(record);
    });

    expect(record.status).toBe('failed');
    // flag disabled → error re-thrown immediately, no retry
    expect((provider.chat as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});


test('authored diagnostics reject changed complete sources, residuals, fields and question schemas', () => {
  const readDiagnostic = authoredPrivacyAnswer({ parts: [[errorText('401 Unauthorized')]] });
  const source = { phase: 'source', parts: [errorText('401 Unauthorized')], target: 'whole-line' };
  const question = redactionCredential.items.lineHasCredential.question;
  expect(readDiagnostic('lineHasCredential', question, source)).toEqual(noulAnswer(0.01));
  expect(() => readDiagnostic('lineHasCredential', question, { ...source,
    parts: [errorText('401 Unauthorized; recovery phrase is private')] })).toThrow('Unspecified authored error source projection');
  expect(() => readDiagnostic('credentialRemains', residualCredential.items.credentialRemains.question,
    { parts: [errorText('A different private diagnostic')] })).toThrow('Unspecified authored error residual projection');
  expect(() => readDiagnostic('kind', fieldKind.items.kind.question, { field: 'unlockPassphrase' }))
    .toThrow('Unspecified authored error field role');
  expect(() => readDiagnostic('lineHasCredential', { ...question, instructions: 'A different question' }, source))
    .toThrow('Unexpected authored diagnostic question schema');
});
