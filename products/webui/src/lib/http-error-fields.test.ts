import { describe, expect, test } from 'bun:test';
import { daemonErrorFields } from './goodvibes';
import { formatError, isAuthExpiredError, isDaemonUnreachableError } from './errors';

describe('the error a daemon HTTP failure becomes', () => {
  test('carries the daemon category, hint and retry wait, and formatError shows them', () => {
    const body = { error: 'Slow down', hint: 'Wait 30s and retry', category: 'rate_limit', retryAfterMs: 30_000, recoverable: true };
    const error = Object.assign(new Error('POST /x failed: 429'), { status: 429, body, ...daemonErrorFields(429, body) });
    expect(error).toMatchObject({ category: 'rate_limit', hint: 'Wait 30s and retry', retryAfterMs: 30_000, recoverable: true });
    expect(formatError(error)).toBe('Slow down (HTTP 429 · rate_limit · Wait 30s and retry)');
  });

  test('a body without a category falls back to service, a 401 stays authentication', () => {
    expect(daemonErrorFields(500, { error: 'x' })).toEqual({ category: 'service' });
    expect(daemonErrorFields(500, null)).toEqual({ category: 'service' });
    expect(daemonErrorFields(401, { category: 'rate_limit' }).category).toBe('authentication');
  });

  test('a body category never makes a non-401 answer look like sign-out or an unreachable daemon', () => {
    for (const category of ['authentication', 'network']) {
      const error = { status: 403, ...daemonErrorFields(403, { category }) };
      expect(isAuthExpiredError(error)).toBe(false);
      expect(isDaemonUnreachableError(error)).toBe(false);
    }
  });
});
