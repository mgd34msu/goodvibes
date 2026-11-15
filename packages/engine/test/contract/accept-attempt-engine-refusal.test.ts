/**
 * Taking an attempt records the pick before the engine starts the merge. When
 * the engine refuses, the pick is withdrawn and the unit goes back to its owner,
 * so the same attempt can be taken again; it must not sit in held-merge with a
 * recorded pick and no merge coming.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { readContractConfig } from '../../platform/src/platform/contract/config.js';
import { configReader } from './plan-support.js';
import { acceptAttempt } from '../../platform/src/platform/contract/index.js';
import { ContractRun } from '../../platform/src/platform/contract/run-context.js';
import type { OrchestrationEngine } from '../../platform/src/platform/orchestration/engine.js';
import { emptyWorkItemUsage, type WorkItem, type Workstream } from '../../platform/src/platform/orchestration/types.js';
import { logger } from '../../platform/src/platform/utils/logger.js';
import { makeContract, makeGroup, makeUnit } from './fixtures.js';

const undo: Array<() => void> = [];
afterEach(() => { for (const restore of undo.splice(0)) restore(); });

function item(id: string): WorkItem {
  return { id, contractId: 'c', contractUnitId: id, title: id, task: '', dependsOn: [], currentPhaseId: null, state: 'held-merge', attemptGroupId: 'grp',
    allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 1 };
}

function fixture(pick: () => Promise<unknown>) {
  const spy = spyOn(logger, 'warn').mockImplementation(() => {});
  undo.push(() => spy.mockRestore());
  const attempts = [
    makeUnit({ id: 'u1#a0', groupId: 'g1', status: 'held-merge', attemptOf: 'u1' }),
    makeUnit({ id: 'u1#a1', groupId: 'g1', status: 'held-merge', attemptOf: 'u1' }),
  ];
  const unit = makeUnit({ id: 'u1', groupId: 'g1', status: 'checking', attemptUnits: attempts,
    attemptSelection: { engineGroupId: 'grp', candidateIds: ['u1#a0', 'u1#a1'], outcome: 'confirm', reasons: 'test' } });
  const contract = makeContract({ units: [unit], groups: [makeGroup({ id: 'g1', unitIds: ['u1'], status: 'running' })] });
  const unexpected = (): never => { throw new Error('unexpected control call'); };
  const run = new ContractRun(contract, { now: () => 1_000, config: () => readContractConfig(configReader()), emit: () => {}, touchAgent: () => {} },
    { passGroup: unexpected, finishPassed: unexpected, fail: unexpected, cancel: unexpected });
  const workstream: Workstream = { id: 'ws', title: 'ws', schemaVersion: 1, phases: [], items: [item('u1#a0'), item('u1#a1')], createdAt: 1 };
  const picks: string[] = [];
  run.engine = {
    listWorkstreams: () => [workstream],
    pickAttemptWinner: async (_group: string, winner: string) => { picks.push(winner); return pick(); },
  } as unknown as OrchestrationEngine;
  return { run, unit, picks };
}

test('an engine that refuses the merge leaves no recorded pick, and the unit is back with its owner', async () => {
  const f = fixture(() => Promise.reject(new Error('merge lane unavailable')));
  await expect(acceptAttempt(f.run, 'u1', 'u1#a0', 'owner approved')).rejects.toThrow('merge lane unavailable');
  expect(f.unit.attemptSelection?.pickedId).toBeUndefined();
  expect(f.unit.status).toBe('awaiting-owner');
  expect(f.run.contract.decisions.at(-1)?.reason).toContain('could not be merged');
});

test('the same attempt can be taken again once the engine accepts', async () => {
  let refuse = true;
  const f = fixture(async () => { if (refuse) throw new Error('merge lane unavailable'); return {}; });
  await expect(acceptAttempt(f.run, 'u1', 'u1#a0', 'owner approved')).rejects.toThrow();
  refuse = false;
  await acceptAttempt(f.run, 'u1', 'u1#a0', 'owner approved again');
  expect(f.unit.attemptSelection?.pickedId).toBe('u1#a0');
  expect(f.unit.status).toBe('held-merge');
  expect(f.picks).toEqual(['u1#a0', 'u1#a0']);
});
