import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.js';
import type { AgentExecutionRecord } from '../../runtime/execution-ledger.js';
import { describeExecutionHistoryItem, executionHistorySummary } from '../../tools/agent-harness-execution-history.js';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.js';

let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(prior); });
afterAll(cleanupResearchScreeningFixtures);
function fixture() {
  let opened = 0;
  const records: AgentExecutionRecord[] = ['one', 'two'].map((id, index) => ({ id, callId: `call-${id}`, turnId: 'turn-fixture', tool: 'exec', routeKind: 'shell',
    status: index === 0 ? 'succeeded' : 'failed', phase: index === 0 ? 'TOOL_SUCCEEDED' : 'TOOL_FAILED',
    receivedAt: 1000 + index, updatedAt: 2000 + index, completedAt: 2000 + index,
    argsPreview: '{}', argsKeys: [], commandPreview: index === 0 ? 'artifact_probe --synthetic' : 'printf fixture',
    resultSummary: { kind: 'text', byteSize: 7, preview: index === 0 ? 'success' : 'failure' },
  }));
  const context = { workspace: {}, ops: { executionLedger: { getSnapshot: () => ({ records, total: 2, running: 0, succeeded: 1, failed: 1, cancelled: 0 }) } },
    session: { runtime: { sessionId: 'classic-history-fixture' } }, openProcessModal() { opened++; }, openLiveTail() { opened++; },
  } as unknown as CommandContext;
  const privacy = researchScreeningFixture();
  return { context, records, privacy, options: { sourceOwner: privacy.owner }, opened: () => opened };
}

test('Classic history, exact detail and local search retain actual outcomes without decision requests or verification claims', async () => {
  const f = fixture(); let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const summary = await executionHistorySummary(f.context, {}, f.options);
    expect(summary).toMatchObject({ status: 'available', provenance: 'classic', returned: 2,
      records: [expect.objectContaining({ status: 'succeeded' }), expect.objectContaining({ status: 'failed' })],
      activityCards: [expect.objectContaining({ status: 'failed', verification: expect.objectContaining({ status: 'not-evaluated', evidence: [], unassessedExecutionRecordIds: ['one', 'two'] }) })],
      judgments: [],
    });
    const exact = await describeExecutionHistoryItem(f.context, { executionRecordId: 'one' }, f.options);
    expect(exact).toMatchObject({ status: 'found', record: { provenance: 'classic', status: 'succeeded', userCard: { verification: { status: 'not-evaluated' } } } });
    const search = await executionHistorySummary(f.context, { query: 'artifact_probe' }, f.options);
    expect(search).toMatchObject({ returned: 1, judgments: [], records: [expect.objectContaining({ executionRecordId: 'one' })] });
    expect(await describeExecutionHistoryItem(f.context, { query: 'artifact_probe' }, f.options)).toMatchObject({ status: 'ambiguous' });
    expect(asks).toBe(0); expect(f.privacy.calls).toEqual([]); expect(f.opened()).toBe(0);
  });
});

for (const probability of [0.999, 0.5, 0.001]) test(`Preferred preserves a completed ${probability} reading when the next verification classification exhausts`, async () => {
  const f = fixture(); let asks = 0;
  const base = fakePort(() => noulAnswer(probability));
  installJudgmentPort({ ...base.port, async ask(request) {
    asks++; if (asks === 2) throw new JudgmentError('unavailable', 'fixture exhausted'); return base.port.ask(request);
  } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const summary = await executionHistorySummary(f.context, {}, f.options);
    expect(summary).toMatchObject({ returned: 2, provenance: 'classic', records: [expect.objectContaining({ status: 'succeeded' }), expect.objectContaining({ status: 'failed' })] });
    expect(summary.activityCards).toEqual([expect.objectContaining({ verification: expect.objectContaining({
      status: probability === 0.5 ? 'held' : 'not-evaluated',
      unassessedExecutionRecordIds: ['two'],
      ...(probability === 0.5 ? { heldExecutionRecordIds: ['one'] } : {}),
      evidence: probability === 0.999 ? [expect.objectContaining({ executionRecordId: 'one' })] : [],
    }) })]);
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
    expect(asks).toBe(2); expect(f.opened()).toBe(0);
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`history ${kind} is not Preferred exhaustion`, async () => {
  const f = fixture(); const failure = new JudgmentError(kind, 'fixture failure');
  installJudgmentPort({ model: 'fixture', async ask() { throw failure; } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(executionHistorySummary(f.context, {}, f.options)).rejects.toBe(failure);
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

for (const change of ['cancel', 'record', 'owner'] as const) test(`a changed ${change} cannot turn a failed history reading into Classic publication`, async () => {
  const f = fixture(); const abort = new AbortController(); const original = Object.getOwnPropertyDescriptor(f.privacy.owner, 'project');
  installJudgmentPort({ model: 'fixture', async ask() {
    if (change === 'cancel') abort.abort();
    if (change === 'record') Object.assign(f.records[0]!, { status: 'failed' });
    if (change === 'owner') Object.defineProperty(f.privacy.owner, 'project', { value: () => [], configurable: true });
    throw new JudgmentError('unavailable', 'fixture exhausted');
  } });
  try {
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await expect(executionHistorySummary(f.context, {}, { ...f.options, signal: abort.signal })).rejects.toThrow();
      expect(decisionModelPolicyState().operation).toBe('decision');
    });
  } finally { if (original) Object.defineProperty(f.privacy.owner, 'project', original); }
});
