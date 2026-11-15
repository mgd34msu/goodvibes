import { expect, test } from 'bun:test';
import { NativeWorkExecutionControls } from '../terminal-shell/src/native/native-work-execution.js';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot } from '../platform/src/platform/workflow/work-ledger/index.js';
import type { NativeWorkExecutionIdentity, NativeWorkExecutionSnapshot, OperatorNativeWorkExecutionClient } from '../platform/src/platform/workflow/work-ledger/native-execution-client.js';

const ledger = (): WorkLedgerReadSnapshot => ({ projectId: 'p', revision: 0, cursor: 0, works: [{
  work: { source: null, id: 'work-1', title: 'Ship', goal: 'Goal', criteria: ['one'], revision: 3, criteriaRevision: 2, reportedState: 'in_progress', currentAttemptId: 'attempt-1', createdAt: 1, updatedAt: 1 },
  attempt: { id: 'attempt-1', workId: 'work-1', predecessorId: null, ownerId: 'owner', revision: 4, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 },
  verification: { state: 'unverified', reason: 'No evidence', evidence: null }, attention: [],
}] });

function host(hostRevision: { work: number; criteria: number; attempt: number }, hostAttempt = 'attempt-1') {
  const seen: { action: string; identity: NativeWorkExecutionIdentity }[] = [];
  const snapshot = (identity: NativeWorkExecutionIdentity): NativeWorkExecutionSnapshot => ({
    kind: 'execution', projectId: 'p', ...identity, currentRevision: hostRevision, currentAttempt: hostAttempt === identity.attemptId,
    stale: JSON.stringify(identity.expectedRevision) !== JSON.stringify(hostRevision), state: 'launch-claimed', recovery: 'available',
    receipt: { contractId: 'c', ownerAgentId: 'o' }, progress: null,
  });
  const reader: WorkLedgerReadClient = { projectId: 'p', readSnapshot: async () => ledger(), history: async () => [], subscribe: () => () => {}, dispose() {} };
  const client: OperatorNativeWorkExecutionClient = {
    start: async (identity) => { seen.push({ action: 'start', identity }); return snapshot(identity); },
    status: async (identity) => { seen.push({ action: 'status', identity }); return snapshot(identity); },
    // The host refuses a cancel built from revisions that are no longer current.
    cancel: async (identity) => {
      seen.push({ action: 'cancel', identity });
      if (JSON.stringify(identity.expectedRevision) !== JSON.stringify(hostRevision)) throw Object.assign(new Error('stale'), { code: 'NATIVE_EXECUTION_STALE' });
      return snapshot(identity);
    },
    resume: async (identity) => { seen.push({ action: 'resume', identity }); return snapshot(identity); },
    dispose() {},
  };
  const controls = new NativeWorkExecutionControls(() => {});
  controls.bind(client, reader, () => true);
  return { controls, seen };
}

test('after the revisions advance, a status read lets the next cancel carry the host current revisions', async () => {
  const { controls, seen } = host({ work: 5, criteria: 2, attempt: 6 });
  controls.observe(ledger());
  await controls.run('cancel', 'work-1');
  expect(controls.state?.message).toContain('changed');
  await controls.run('status', 'work-1');
  await controls.run('cancel', 'work-1');
  expect(seen.at(-1)).toMatchObject({ action: 'cancel', identity: { attemptId: 'attempt-1', expectedRevision: { work: 5, criteria: 2, attempt: 6 } } });
  expect(controls.state?.snapshot).toBeDefined();
  controls.clear();
});

test('a status read of a different attempt never retargets the retained one', async () => {
  const { controls, seen } = host({ work: 5, criteria: 2, attempt: 6 }, 'attempt-2');
  controls.observe(ledger());
  await controls.run('status', 'work-1');
  await controls.run('cancel', 'work-1');
  expect(seen.at(-1)?.identity).toEqual({ workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 3, criteria: 2, attempt: 4 } });
  controls.clear();
});
