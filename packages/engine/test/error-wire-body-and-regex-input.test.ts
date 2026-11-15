import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  admitRegex,
  categoryForStatus,
  createHttpStatusError,
  GoodVibesError,
  installJudgmentPort,
} from '../errors/src/index.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

describe('http status errors read a wire body defensively', () => {
  test('fields of the wrong type or outside the wire set are dropped and the category follows the status', () => {
    const error = createHttpStatusError(503, 'https://d.example.com/x', 'GET', {
      error: 'x',
      category: 'contract',
      retryAfterMs: '5',
      recoverable: 'yes',
      source: 'bogus',
      requestId: 7,
    });
    expect(error.category).toBe('service');
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.recoverable).toBe(true);
    expect(error.source).toBe('transport');
    expect(error.requestId).toBeUndefined();
  });

  test('well-formed fields are kept', () => {
    const error = createHttpStatusError(429, 'https://d.example.com/x', 'GET', {
      error: 'slow down',
      category: 'rate_limit',
      retryAfterMs: 2500,
      recoverable: true,
      requestId: 'req-1',
    });
    expect(error.category).toBe('rate_limit');
    expect(error.retryAfterMs).toBe(2500);
    expect(error.requestId).toBe('req-1');
  });
});

describe('one status-to-category table', () => {
  test('an error built from a status carries the category the failure reading gives that status', () => {
    for (let status = 400; status <= 599; status += 1) {
      const error = new GoodVibesError('failed', { status });
      expect([status, error.category]).toEqual([status, categoryForStatus(status) ?? 'unknown']);
    }
  });

  test('a gateway timeout is a timeout whichever side builds the error', () => {
    expect(createHttpStatusError(504, 'https://d.example.com/x', 'GET', 'upstream timed out').category).toBe('timeout');
  });
});

describe('admitted regex', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    previous = installJudgmentPort(fakePort(() => noulAnswer(0.001)).port);
  });
  afterEach(() => { installJudgmentPort(previous); });

  test('an oversize input is refused for that call only and the expression stays usable', async () => {
    await using pattern = await admitRegex('needle', '', { operation: 'fixture', maxInputChars: 16 });
    await expect(pattern.test('x'.repeat(17))).rejects.toThrow('exceeds 16 characters');
    expect(await pattern.test('a needle')).toBe(true);
  });

  test('an invalid start index is refused for that call only', async () => {
    await using pattern = await admitRegex('a', 'y', { operation: 'fixture' });
    await expect(pattern.exec('ba', -1)).rejects.toThrow('invalid operation input');
    expect(await pattern.exec('ba', 1)).toMatchObject({ index: 1 });
  });
});
