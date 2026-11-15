import { describe, expect, test } from 'bun:test';

/**
 * withRetry / isRetryableError, verifies the onRetry callback fires with the
 * (attempt, maxAttempts, delayMs, error) argument order that ChatRequest.onRetry
 * expects (providers pass it straight through with no adapter), that
 * non-retryable errors skip the callback and rethrow immediately, and that the
 * callback fires exactly maxRetries times before the final rejection.
 */
describe('withRetry', () => {
  test('onRetry fires with (attempt, maxAttempts, delayMs, error) on a retryable error', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { AppError } = await import('../platform/src/platform/types/errors.js');
    const calls: Array<{ attempt: number; maxAttempts: number; delayMs: number; error: Error }> = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw new AppError('transient failure', 'TEST_TRANSIENT', true);
        return 'ok';
      },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 },
      (attempt, maxAttempts, delayMs, error) => {
        calls.push({ attempt, maxAttempts, delayMs, error });
      },
    );
    expect(result).toBe('ok');
    expect(calls.length).toBe(1);
    expect(calls[0]!.attempt).toBe(1);
    expect(calls[0]!.maxAttempts).toBe(3);
    expect(calls[0]!.delayMs).toBe(0);
    expect(calls[0]!.error.message).toBe('transient failure');
  });

  test('does NOT call onRetry and rethrows immediately on a non-retryable error', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { AppError } = await import('../platform/src/platform/types/errors.js');
    let attempts = 0;
    let onRetryCalls = 0;
    const promise = withRetry(
      async () => {
        attempts++;
        throw new AppError('permanent failure', 'TEST_FATAL', false);
      },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 },
      () => { onRetryCalls++; },
    );
    await expect(promise).rejects.toThrow('permanent failure');
    expect(attempts).toBe(1);
    expect(onRetryCalls).toBe(0);
  });

  test('fires onRetry maxRetries times before giving up', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { AppError } = await import('../platform/src/platform/types/errors.js');
    let attempts = 0;
    let onRetryCalls = 0;
    const promise = withRetry(
      async () => {
        attempts++;
        throw new AppError('always fails', 'TEST_ALWAYS', true);
      },
      { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
      () => { onRetryCalls++; },
    );
    await expect(promise).rejects.toThrow('always fails');
    expect(attempts).toBe(3); // initial attempt + 2 retries
    expect(onRetryCalls).toBe(2);
  });
});


test('beforeAttempt runs after backoff and denial never retries even a retryable-looking error', async () => {
  const { withRetry } = await import('../platform/src/platform/utils/retry.js');
  const { AppError } = await import('../platform/src/platform/types/errors.js');
  const order: string[] = []; let admitted = true; let sent = 0;
  const outcome = withRetry(async () => { order.push('send'); sent++; throw new AppError('transport', 'TRANSIENT', true); }, {
    initialDelayMs: 0, maxDelayMs: 0, maxRetries: 3,
    beforeAttempt: async () => { order.push('fence'); if (!admitted) throw new AppError('owner revoked', 'REVOKED', true); },
  }, () => { order.push('backoff'); admitted = false; });
  await expect(outcome).rejects.toThrow('owner revoked');
  expect(sent).toBe(1); expect(order).toEqual(['fence', 'send', 'backoff', 'fence']);
});

test('beforeAttempt rejection prevents the initial transport entirely', async () => {
  const { withRetry } = await import('../platform/src/platform/utils/retry.js'); let sent = 0;
  await expect(withRetry(async () => { sent++; return 'unexpected'; }, { beforeAttempt() { throw new Error('stale source'); } })).rejects.toThrow('stale source');
  expect(sent).toBe(0);
});

describe('withRetry provider-stated waits', () => {
  test('waits at least the error retryAfterMs and reports it to onRetry', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { ProviderError } = await import('../platform/src/platform/types/errors.js');
    const controller = new AbortController();
    const delays: number[] = [];
    let attempts = 0;
    // Aborting from onRetry ends the backoff at once, so the test never sleeps.
    await expect(withRetry(
      async () => { attempts++; throw new ProviderError('rate limited', { statusCode: 429, retryAfterMs: 5000 }); },
      { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10, signal: controller.signal },
      (_a, _m, delayMs) => { delays.push(delayMs); controller.abort(); },
    )).rejects.toThrow('rate limited');
    expect(delays).toHaveLength(1);
    expect(delays[0]!).toBeGreaterThanOrEqual(5000);
    expect(attempts).toBe(1);
  });

  test('surfaces a wait longer than the honoured ceiling instead of retrying early', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { ProviderError } = await import('../platform/src/platform/types/errors.js');
    let attempts = 0;
    let retries = 0;
    await expect(withRetry(
      async () => { attempts++; throw new ProviderError('slow down', { statusCode: 429, retryAfterMs: 600_000 }); },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 },
      () => { retries++; },
    )).rejects.toThrow('slow down');
    expect(attempts).toBe(1);
    expect(retries).toBe(0);
  });

  test('does not retry a billing failure even though its status is retryable', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { ProviderError } = await import('../platform/src/platform/types/errors.js');
    let attempts = 0;
    await expect(withRetry(
      async () => { attempts++; throw new ProviderError('quota spent', { statusCode: 429, category: 'billing' }); },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 },
    )).rejects.toThrow('quota spent');
    expect(attempts).toBe(1);
  });
});

describe('withRetry canRetry', () => {
  test('a retryable failure after delivered output is final when the host says so', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { AppError } = await import('../platform/src/platform/types/errors.js');
    let delivered = false;
    let attempts = 0;
    await expect(withRetry(
      async () => { attempts++; delivered = true; throw new AppError('stream dropped', 'TEST_TRANSIENT', true); },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0, canRetry: () => !delivered },
    )).rejects.toThrow('stream dropped');
    expect(attempts).toBe(1);
  });

  test('still retries when nothing was delivered', async () => {
    const { withRetry } = await import('../platform/src/platform/utils/retry.js');
    const { AppError } = await import('../platform/src/platform/types/errors.js');
    let attempts = 0;
    const result = await withRetry(
      async () => { attempts++; if (attempts < 2) throw new AppError('early failure', 'TEST_TRANSIENT', true); return 'ok'; },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0, canRetry: () => true },
    );
    expect(result).toBe('ok');
  });
});
