/** The advice a worker reads for a required gate with no current evidence says what happened and what changes it. */
import { expect, test } from 'bun:test';
import { unverifiedGateAdvice, type QualityGateResult } from '../../platform/src/platform/contract/gates.js';

const result = (reason?: string): QualityGateResult => ({ gate: 'test', passed: false, output: '', durationMs: 1, outcome: 'unverified', required: true, ...(reason === undefined ? {} : { reason }) });

test('a timeout and a source change each say what happened', () => {
  expect(unverifiedGateAdvice(result('timeout'))).toContain('contract.gateTimeoutMs');
  expect(unverifiedGateAdvice(result('source-changed-during-check'))).toContain('runs again');
});

test('any other reason is passed on as it is', () => {
  expect(unverifiedGateAdvice(result('source-identity-unavailable'))).toBe('source-identity-unavailable');
  expect(unverifiedGateAdvice(result())).toBe('unverified check completion');
});
