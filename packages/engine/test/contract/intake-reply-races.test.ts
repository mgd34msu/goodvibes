/**
 * A turn read as the owner's reply can reach a contract that stopped waiting while the reading ran
 * (it ended, or another surface answered first). Nothing was applied, so the turn is an ordinary message.
 */
import { afterEach, expect, test } from 'bun:test';
import { noulAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { createContractIntake, type ContractIntakeDeps, type ContractView } from '../../platform/src/platform/contract/index.js';
import { OwnerReplyRefusedError, type OwnerReplyRefusal } from '../../platform/src/platform/contract/escalation.js';
import { makeContract } from './fixtures.js';

let restore: JudgmentPort | undefined;
afterEach(() => {
  if (restore !== undefined) installJudgmentPort(restore);
  restore = undefined;
});

function waiting(): ContractView {
  return { ...makeContract(), id: 'ctr-00001111', sessionId: 's1',
    escalations: [{ id: 'ctr-00001111.e1', at: 1, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'q1', unmetCriterionIds: [] }] };
}

function intakeWhoseReply(reply: ContractIntakeDeps['runner']['reply']) {
  restore = installJudgmentPort(fakePort((name) => (name === 'responds' ? noulAnswer(0.97) : undefined)).port);
  const contracts = [waiting()];
  const runner: ContractIntakeDeps['runner'] = { list: () => contracts, start: async () => { throw new Error('no contract may start'); }, reply };
  return createContractIntake({ runner, projectRoot: '/repo' });
}

for (const refusal of ['ended', 'not-open', 'already-reading'] as const satisfies readonly OwnerReplyRefusal[]) {
  test(`a reply refused as "${refusal}" leaves the turn to the conversation`, async () => {
    const intake = intakeWhoseReply(async () => { throw new OwnerReplyRefusedError(`refused: ${refusal}`, refusal); });
    expect(await intake.intake({ text: 'yes, go ahead', sessionId: 's1' })).toEqual({ kind: 'turn' });
  });
}

test('a reply that failed for any other reason still fails the turn', async () => {
  const intake = intakeWhoseReply(async () => { throw new Error('the reply could not be read; the question is still open'); });
  await expect(intake.intake({ text: 'yes, go ahead', sessionId: 's1' })).rejects.toThrow('could not be read');
});
