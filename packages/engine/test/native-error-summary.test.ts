import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { AppError as NativeAppError } from '../platform/src/platform/types/error-values.js';
import { AppError, ProviderError } from '../platform/src/platform/types/errors.js';
import { normalizeError, summarizeError } from '../platform/src/platform/utils/error-display.js';
import { summarizeError as nativeSummary } from '../platform/src/platform/utils/native-error-summary.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

test('native error identity and summaries remain shared with platform normalization without decision access', () => {
  let requests = 0;
  const previous = installJudgmentPort({ get model(): never { throw new Error('Unexpected model access'); },
    async ask() { requests++; throw new Error('Unexpected decision request'); } });
  restore = () => { installJudgmentPort(previous); };
  expect(NativeAppError).toBe(AppError);
  expect(nativeSummary).toBe(summarizeError);
  const values: unknown[] = [
    new Error('Native inference failed'),
    new AppError('{"error":{"message":"Model unavailable","code":"MODEL_LOAD"}}', 'FIXTURE', false,
      { phase: 'inference', requestId: 'synthetic-request', providerCode: 'MODEL_LOAD' }),
    new ProviderError('Model refused the request', { statusCode: 403, provider: 'synthetic', requestId: 'synthetic-request' }),
    '  Literal native failure  ',
    { message: 'Structured native failure' },
    { message: 'x'.repeat(300) },
    '', null, undefined, 42,
  ];
  for (const value of values) {
    const options = { fallbackMessage: 'Native fallback', provider: 'synthetic', source: 'runtime' as const };
    expect(nativeSummary(value, options)).toBe(normalizeError(value, options).summary);
  }
  expect(requests).toBe(0);
});
