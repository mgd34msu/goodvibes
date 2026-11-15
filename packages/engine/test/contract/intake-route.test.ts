/**
 * Turn intake (docs/design/contract-runner.md 10.3): with an open escalation
 * in the session, `contract.escalation-turn` reads whether the turn responds
 * to its question; unless it reads no at act the turn is the owner's reply and
 * goes to the contract before any route is read, and a no at act routes it
 * like any other turn;
 * `contract.request-route` at act on `contract` starts a contract with origin
 * `turn` and the turn's text as the ask; every other route, and a contract
 * route below act, leaves the turn to the conversation. The agent tool's
 * `contractStarted` field is read as a fixed format.
 */
import { describe, expect, test } from 'bun:test';
import {
  createContractIntake,
  describeIntake,
  openEscalation,
  toolResultStartedContract,
  type ContractIntakeDeps,
  type ContractView,
  type OwnerReplyOutcome,
  type StartContractInput,
} from '../../platform/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';

function waitingContracts(): ContractView[] {
  const waiting: ContractView = {
    ...makeContract(),
    id: 'ctr-00001111',
    sessionId: 's1',
    escalations: [
      { id: 'ctr-00001111.e1', at: 1, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'q1', unmetCriterionIds: [], resolvedAt: 2 },
      { id: 'ctr-00001111.e2', at: 3, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'q2', unmetCriterionIds: [] },
    ],
  };
  return [waiting, { ...waiting, id: 'ctr-00002222', sessionId: 's2' }];
}

function fakeRunner(contracts: ContractView[] = []) {
  const started: StartContractInput[] = [];
  const replies: { contractId: string; escalationId: string; text: string }[] = [];
  const runner: ContractIntakeDeps['runner'] = {
    list: (filter) => contracts.filter((contract) => filter?.sessionId === undefined || contract.sessionId === filter.sessionId),
    start: async (input) => {
      started.push(input);
      return { contract: { ...makeContract(), id: 'ctr-0000abcd' }, owner: { id: 'agent-owner' } } as never;
    },
    reply: async (contractId, escalationId, text): Promise<OwnerReplyOutcome> => {
      replies.push({ contractId, escalationId, text });
      return { escalationId, reading: 'approve', outcome: 'act', action: 'approved' };
    },
  };
  return { runner, started, replies };
}

describe('turn intake', () => {
  test('a message that does not answer a question is an ordinary turn: nothing is read, started or answered', async () => {
    const { runner, started, replies } = fakeRunner(waitingContracts());
    expect(await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'yes, accept it', sessionId: 's1' })).toEqual({ kind: 'turn' });
    expect(started).toEqual([]);
    expect(replies).toEqual([]);
  });

  test('a message answering the open question is the reply', async () => {
    const { runner, replies, started } = fakeRunner(waitingContracts());
    const outcome = await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'yes, accept it', sessionId: 's1', answersEscalationId: 'ctr-00001111.e2' });
    expect(outcome.kind).toBe('replied');
    expect(replies).toEqual([{ contractId: 'ctr-00001111', escalationId: 'ctr-00001111.e2', text: 'yes, accept it' }]);
    expect(started).toEqual([]);
    if (outcome.kind === 'replied') expect(describeIntake(outcome)).toContain('read as approve: approved');
  });

  test('an answer to a question that is no longer the open one is an ordinary turn', async () => {
    const { runner, replies } = fakeRunner(waitingContracts());
    expect(await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'yes', sessionId: 's1', answersEscalationId: 'ctr-00001111.e1' })).toEqual({ kind: 'turn' });
    expect(replies).toEqual([]);
  });

  test('a reply to a failed-turn question is described as retrying or cancelled, never as an amendment', async () => {
    const contracts = waitingContracts();
    const open = contracts[0]!.escalations.find((entry) => entry.resolvedAt === undefined)!;
    Object.assign(open, { failurePause: true });
    for (const [action, expected] of [['amended', 'retry: the turn is retrying'], ['stopped', 'cancel: the contract is cancelled']] as const) {
      const { runner } = fakeRunner(contracts);
      const outcome = await createContractIntake({ runner: { ...runner, reply: async (_contractId, escalationId) => ({ escalationId, reading: 'amend', outcome: 'act', action }) }, projectRoot: '/repo' })
        .intake({ text: 'retry', sessionId: 's1', answersEscalationId: open.id });
      if (outcome.kind !== 'replied') throw new Error('the turn should have been the reply');
      expect(describeIntake(outcome)).toContain(expected);
      expect(describeIntake(outcome)).not.toContain('read as');
    }
  });

  test('the newest open escalation across the session\'s contracts is the one answered', () => {
    const base = makeContract();
    const older: ContractView = { ...base, id: 'ctr-a', escalations: [{ id: 'a.e1', at: 5, scope: 'plan', targetId: 'ctr-a', reason: 'plan-unresolved', question: 'q', unmetCriterionIds: [] }] };
    const newer: ContractView = { ...base, id: 'ctr-b', escalations: [{ id: 'b.e1', at: 9, scope: 'plan', targetId: 'ctr-b', reason: 'plan-unresolved', question: 'q', unmetCriterionIds: [] }] };
    expect(openEscalation([older, newer])?.escalation.id).toBe('b.e1');
    expect(openEscalation([{ ...base, escalations: [] }])).toBeNull();
  });
});

describe('toolResultStartedContract', () => {
  test('reads the agent tool\'s contractStarted field and nothing else', () => {
    expect(toolResultStartedContract({ callId: 'c', success: true, output: JSON.stringify({ contractStarted: true, contractId: 'ctr-1' }) })).toBe(true);
    expect(toolResultStartedContract({ callId: 'c', success: true, output: JSON.stringify({ agentId: 'a', status: 'spawned' }) })).toBe(false);
    expect(toolResultStartedContract({ callId: 'c', success: false, output: JSON.stringify({ contractStarted: true }) })).toBe(false);
    expect(toolResultStartedContract({ callId: 'c', success: true, output: 'not json' })).toBe(false);
  });
});
