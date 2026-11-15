import { afterEach, describe, expect, test } from 'bun:test';
import { instrumentedLlmCall } from '../platform/src/platform/runtime/llm-observability.ts';
import { llmRequestsTotal, resetMetrics } from '../platform/src/platform/runtime/metrics.ts';

afterEach(() => resetMetrics());

describe('instrumentedLlmCall when reading usage from the response fails', () => {
  test('a throwing token extractor does not re-issue the billed request or fail the call', async () => {
    let calls = 0;
    const outcome = await instrumentedLlmCall(
      async () => { calls += 1; return {} as { usage: { input: number } }; },
      {
        maxRetries: 2,
        provider: 'p',
        model: 'm',
        extractTokens: (response) => ({ inputTokens: response.usage.input }),
      },
    );

    expect(calls).toBe(1);
    expect(outcome.retries).toBe(0);
    expect(Object.keys(outcome.result)).toEqual([]);
    expect(llmRequestsTotal.total({ status: 'success' })).toBe(1);
    expect(llmRequestsTotal.total({ status: 'error' })).toBe(0);
  });

  test('a failing provider call is still retried and then reported as an error', async () => {
    let calls = 0;
    await expect(instrumentedLlmCall(
      async () => { calls += 1; throw new Error('provider down'); },
      { maxRetries: 2, provider: 'p', model: 'm' },
    )).rejects.toThrow('provider down');

    expect(calls).toBe(3);
    expect(llmRequestsTotal.total({ status: 'error' })).toBe(1);
  });
});
