import { expect, test } from 'bun:test';
import { createSystemOnePort, SqliteDecisionLog, withDecisionLog, noul, type DecisionEntry } from '@goodvibes-jev/judgment';
import { judgmentVolume, judgmentVolumeBreaches, captureJudgmentVolumeBudgets } from '../sdk/src/platform/observe/judgment-volume.ts';
import { analyzeDecisionLog } from '../sdk/src/platform/observe/analyze.ts';

async function recordedOperation() {
  const log = new SqliteDecisionLog(':memory:'); let requests = 0;
  const port = withDecisionLog(createSystemOnePort({ signal: new AbortController().signal,
    endpoint: { kind: 'local', baseURL: 'http://localhost:1001', apiKey: '' }, model: 'jev-latest', timeoutMs: 50, retry: {},
    fallbacks: [1002, 1003].map(number => ({ endpoint: { kind: 'local' as const, baseURL: `http://localhost:${number}`, authentication: 'none' as const, apiKey: '' }, model: 'kev-latest' })),
    fetch: async (_input, init) => {
      requests++;
      if (requests === 1) return new Response('', { status: 503 });
      const body = JSON.parse(String(init?.body));
      return Response.json({ model: body.model, answers: { answer: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 8, output_tokens: 2 } });
    },
  }), log);
  await port.ask({ state: 'Representative operation', questions: { answer: noul('Is the fixture available?') },
    signal: new AbortController().signal, context: { battery: 'test.call-volume', site: 'operation.one' } });
  return { log, requests };
}

test('a missing credential and failover are one logical decision, three targets, and exactly two wire attempts', async () => {
  const { log, requests } = await recordedOperation();
  try {
    const volume = judgmentVolume(log.query());
    expect(requests).toBe(2);
    expect(volume).toMatchObject({ logicalDecisions: 1, recordedEntries: 1, targetAttempts: 3, wireAttempts: 2, unknownDispatchAttempts: 0, callsWithoutAttemptEvidence: 0 });
    expect(log.query()[0]?.lineage?.attempts.map(attempt => attempt.dispatched)).toEqual([false, true, true]);
    expect(analyzeDecisionLog(log).volume).toEqual(volume);
    expect(judgmentVolumeBreaches(log.query(), [{ name: 'one operation', maxLogicalDecisions: 1, maxWireAttempts: 2 }])).toEqual([]);
    expect(judgmentVolumeBreaches(log.query(), [{ name: 'wire regression', maxLogicalDecisions: 1, maxWireAttempts: 1 }])).toEqual([{ budget: 'wire regression', kind: 'wire-attempts', observed: 2, maximum: 1 }]);
  } finally { log[Symbol.dispose](); }
});

test('historical and bounded lineage stay explicitly unknown and cannot certify a wire budget', async () => {
  const { log } = await recordedOperation();
  try {
    const entry = log.query()[0]; if (!entry) throw new Error('Missing fixture');
    const { lineage: _lineage, ...legacy } = entry;
    const entries: readonly DecisionEntry[] = [legacy];
    expect(judgmentVolume(entries)).toMatchObject({ logicalDecisions: 1, wireAttempts: 0, callsWithoutAttemptEvidence: 1 });
    expect(judgmentVolume([{ ...entry, lineage: { logicalRequestId: 'synthetic-empty', attempts: [] } }])).toMatchObject({ callsWithoutAttemptEvidence: 1 });
    expect(judgmentVolumeBreaches(entries, [{ name: 'historical', maxLogicalDecisions: 1, maxWireAttempts: 10 }])).toMatchObject([{ kind: 'incomplete-wire-evidence' }]);
    const attempts = entry.lineage?.attempts ?? [];
    const bounded = { ...entry, lineage: { logicalRequestId: 'synthetic-logical', attempts, omittedAttempts: 4 } };
    expect(judgmentVolume([bounded])).toMatchObject({ targetAttempts: 7, wireAttempts: 2, unknownDispatchAttempts: 4 });
  } finally { log[Symbol.dispose](); }
});

test('duplicate records do not multiply logical/wire accounting, and site budgets are exact', async () => {
  const { log } = await recordedOperation();
  try {
    const entry = log.query()[0]; if (!entry) throw new Error('Missing fixture');
    const duplicate = { ...entry, context: { ...entry.context, site: 'operation.two' } };
    expect(judgmentVolume([entry, duplicate])).toMatchObject({ logicalDecisions: 1, recordedEntries: 2, targetAttempts: 3, wireAttempts: 2 });
    expect(judgmentVolumeBreaches([entry, duplicate], [{ name: 'deduplicated battery', battery: 'test.call-volume', maxLogicalDecisions: 1, maxWireAttempts: 2 }])).toEqual([]);
    expect(judgmentVolumeBreaches([entry], [{ name: 'no reads here', site: 'operation.other', maxLogicalDecisions: 0, maxWireAttempts: 0 }])).toEqual([]);
  } finally { log[Symbol.dispose](); }
});

test('budget files reject negative, unbounded and unknown settings', () => {
  for (const max of [-1, Infinity, 0.5, Number.MAX_VALUE]) expect(() => captureJudgmentVolumeBudgets([{ name: 'budget', maxLogicalDecisions: max }])).toThrow();
  expect(() => captureJudgmentVolumeBudgets([{ name: 'budget', maxLogicalDecisions: 1, accuracyFloor: 0.95 }])).toThrow();
});
