import { describe, expect, test } from 'bun:test';
import { JudgmentError, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '../src/index.ts';

const SECRET = 'Bearer sk-secret-provider-body';
const request = { state: 'private state', questions: { q: { type: 'noul', instructions: 'Q?' } } } as const;
const rejecting = (error: unknown): JudgmentPort => ({ model: 'jev-1.13.0', async ask() { throw error; } });
const exposedError = (error: unknown) => {
  expect(error).toBeInstanceOf(JudgmentError);
  const failure = error as JudgmentError;
  expect(failure.cause).toBeUndefined();
  expect(`${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`).not.toContain(SECRET);
  return failure;
};

describe('recording port trust boundary', () => {
  test.each([
    new Error(SECRET, { cause: new Error(SECRET) }),
    SECRET,
    { toString() { throw new Error(SECRET); }, rawBody: SECRET },
    new JudgmentError('rejected', SECRET, { cause: new Error(SECRET), status: 403, requestId: 'req-rejected' }),
  ])('replaces all upstream failure text without retaining causes or coercing thrown values', async (upstream) => {
    using log = new SqliteDecisionLog(':memory:');
    const error = exposedError(await withDecisionLog(rejecting(upstream), log).ask(request).catch((e: unknown) => e));
    expect(error.kind).toBe(upstream instanceof JudgmentError ? 'rejected' : 'internal');
    if (upstream instanceof JudgmentError) {
      expect(error.status).toBe(403);
      expect(error.requestId).toBe('req-rejected');
    }
    expect(log.query({ status: 'failed' })).toHaveLength(1);
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });
});
