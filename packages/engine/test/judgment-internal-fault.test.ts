import { expect, test } from 'bun:test';
import { JudgmentError, noul, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort, decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import { browserJudgmentRefusal } from '../daemon-api/src/browser-judgment-contract.ts';
import { decisionOrClassic, withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { withWebuiAnswerBoundary } from '../platform/src/platform/judgment-browser/batteries/webui-answers.ts';
import { CONTRACT_NATIVE_WAITING_SCHEMA } from '../platform/src/platform/control-plane/operator-contract-schemas-contract-inspection.ts';
import { failureFromError } from '../platform/src/platform/contract/run-context.ts';

const PRIVATE = 'private-local-fault-detail';
const request = { state: 'Synthetic internal error ownership', questions: { yes: noul('Is this synthetic?') } };

test('an unknown borrowed port fault is recorded as internal and cannot activate Preferred Classic fallback', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let calls = 0, classic = 0;
  const port = withDecisionLog({ model: 'jev-latest', async ask() { calls++; throw new TypeError(PRIVATE); } }, log);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(decisionOrClassic(() => port.ask(request), () => { classic++; return null; }))
      .rejects.toMatchObject({ kind: 'internal' });
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'decision', reason: null });
  });
  expect(calls).toBe(1); expect(classic).toBe(0);
  expect(log.query()).toMatchObject([{ status: 'failed', error: { kind: 'internal' } }]);
  expect(JSON.stringify(log.query())).not.toContain(PRIVATE);
});

test('the strict WebUI boundary and native inspection schema preserve actual internal attempt evidence', async () => {
  const attempt = { attempt: 1, endpointIndex: 0, endpointKind: 'local' as const, requestedModel: 'jev-latest',
    latencyMs: 1, dispatched: false, outcome: 'internal' as const };
  const lineage = { logicalRequestId: 'original-logical-call', attempts: [attempt] };
  const port = withWebuiAnswerBoundary({ model: 'jev-latest', async ask() {
    throw new JudgmentError('internal', PRIVATE, { status: 503, requestId: PRIVATE, lineage });
  } });
  const error: unknown = await port.ask(request).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(JudgmentError);
  if (!(error instanceof JudgmentError)) throw new Error('Missing typed client failure');
  expect(error.kind).toBe('internal'); expect(error.lineage).toEqual(lineage);
  expect(error.status).toBeUndefined(); expect(error.requestId).toBeUndefined(); expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error) + error.message).not.toContain(PRIVATE);
  const wire = JSON.parse(JSON.stringify({ schemaVersion: 1, requests: [{ logicalRequestId: lineage.logicalRequestId,
    attempt: error.lineage?.attempts[0], elapsedMs: 1, nextDelayMs: 0 }] }));
  expect(firstJsonSchemaFailure(CONTRACT_NATIVE_WAITING_SCHEMA, wire)).toBeUndefined();
});

test('unknown browser errors and contract failures report a client fault instead of a model outage', () => {
  const browser = browserJudgmentRefusal(Object.assign(new TypeError(PRIVATE), { status: 503, code: PRIVATE }));
  expect(browser).toEqual({ status: 500, body: { protocolVersion: 1, status: 'held', error: {
    code: 'JUDGMENT_INTERNAL', message: 'The decision client failed internally. The operation has stopped.',
  } } });
  expect(failureFromError(new JudgmentError('internal', PRIVATE))).toEqual({ kind: 'other',
    reason: 'The decision client failed internally. The operation has stopped.' });
  expect(JSON.stringify(browser)).not.toContain(PRIVATE);
});


test('planning readiness cannot turn an internal client fault into unavailable readiness or Preferred fallback', async () => {
  const { readPlanningSemanticFacts } = await import('../platform/src/platform/knowledge/project-planning/readiness.ts');
  let calls = 0;
  const previous = installJudgmentPort({ model: 'jev-latest', async ask() { calls++; throw new JudgmentError('internal', PRIVATE); } });
  try {
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await expect(readPlanningSemanticFacts({ goal: 'Synthetic explicit planning outcome' })).rejects.toMatchObject({ kind: 'internal' });
      expect(decisionModelPolicyState().operation).toBe('decision');
    });
    expect(calls).toBe(1);
  } finally { installJudgmentPort(previous); }
});
