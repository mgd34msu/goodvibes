import { expect, test } from 'bun:test';
import { createHttpStatusError } from '../errors/src/index.ts';
import { browserJudgmentRefusal } from '../daemon-api/src/browser-judgment-contract.ts';

test('a held judgment refusal keeps its own code and message on the client error', () => {
  const refusal = browserJudgmentRefusal(new Error('anything'));
  const error = createHttpStatusError(refusal.status, 'http://localhost/api/judgment', 'POST', refusal.body);
  expect(error.code).toBe('JUDGMENT_INTERNAL');
  expect(error.message).toContain('failed internally');
  expect(error.status).toBe(500);
  expect((error.body as { error: { code: string } }).error.code).toBe('JUDGMENT_INTERNAL');
});

test('a nested error with no usable code or message falls back to the status', () => {
  const error = createHttpStatusError(404, 'http://localhost/x', 'GET', { error: { code: 7, message: '  ' } });
  expect(error.code).toBe('NOT_FOUND');
  expect(error.message).toBe('Request failed with status 404');
});
