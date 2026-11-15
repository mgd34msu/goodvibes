/**
 * A provider failure that never got an HTTP status (a reset, a timeout) is the
 * kind a retry clears, so withRetry must give it another attempt; a failure
 * with a permanent status must stay final.
 */
import { describe, expect, test } from 'bun:test';
import { ProviderError } from '../platform/src/platform/types/errors.ts';
import { isRetryableError, withRetry } from '../platform/src/platform/utils/retry.ts';

describe('ProviderError recoverability without a status', () => {
  test('a timeout or network category is recoverable', () => {
    expect(new ProviderError('timed out', { category: 'timeout' }).recoverable).toBe(true);
    expect(new ProviderError('no route', { category: 'network' }).recoverable).toBe(true);
  });

  test('a connection reset carried as the cause is recoverable', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(new ProviderError('fetch failed', { cause }).recoverable).toBe(true);
  });

  test('a permanent status stays final, and an unexplained failure with no status is not retried', () => {
    expect(new ProviderError('bad key', 401).recoverable).toBe(false);
    expect(new ProviderError('bad request', { statusCode: 400, category: 'network' }).recoverable).toBe(false);
    expect(new ProviderError('mystery').recoverable).toBe(false);
  });

  test('withRetry makes another attempt after a reset', async () => {
    let attempts = 0;
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const value = await withRetry(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new ProviderError('fetch failed', { cause }));
      return Promise.resolve('ok');
    }, { initialDelayMs: 1, maxDelayMs: 1 });
    expect(value).toBe('ok');
    expect(attempts).toBe(2);
    expect(isRetryableError(new ProviderError('fetch failed', { cause }))).toBe(true);
  });
});
