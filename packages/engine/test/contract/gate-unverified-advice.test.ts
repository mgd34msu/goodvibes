/** A required test gate with no readable completion tells the worker how to supply it, in terms the gate really accepts. */
import { expect, test } from 'bun:test';
import { unverifiedGateAdvice, type QualityGateResult } from '../../platform/src/platform/contract/gates.js';
import { protocolCompletion } from '../../platform/src/platform/contract/gate-receipts.js';

const result = (reason?: string): QualityGateResult => ({ gate: 'test', passed: false, output: '', durationMs: 1, outcome: 'unverified', required: true, ...(reason === undefined ? {} : { reason }) });

test('the advice names the run id variable and a protocol line the gate accepts', () => {
  const advice = unverifiedGateAdvice(result('check-completion-unverified'));
  expect(advice).toContain('GOODVIBES_GATE_RUN_ID');
  expect(advice).toContain('`bun test`');
  const line = JSON.stringify({ kind: 'goodvibes-gate-result', schemaVersion: 1, gate: 'test', runId: 'run-1', outcome: 'passed', checks: { passed: 1, failed: 0, skipped: 0 }, observation: {} });
  for (const key of ['kind', 'schemaVersion', 'gate', 'runId', 'outcome', 'checks', 'observation']) expect(advice).toContain(`"${key}"`);
  expect(protocolCompletion(line, 'test', 'run-1')).toMatchObject({ kind: 'assertions', runner: 'registered-protocol' });
});

test('any other reason is passed on as it is', () => {
  expect(unverifiedGateAdvice(result('source-changed-during-check'))).toBe('source-changed-during-check');
  expect(unverifiedGateAdvice(result())).toBe('unverified check completion');
});
