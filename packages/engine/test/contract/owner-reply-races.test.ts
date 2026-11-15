/**
 * A reply being read does not stop the question being answered or the
 * contract ending by another surface: the operator's pick answers it at once
 * and the reply then applies nothing, a contract that ended meanwhile keeps the
 * reply unrecorded, and the refusals a caller can cause are typed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { OwnerReplyRefusedError } from '../../platform/src/platform/contract/escalation.js';
import type { AnswerContext } from './plan-support.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { contractOf, finishes, terminal } from './steps-support.js';

let harness: Harness | undefined;
afterEach(async () => {
  const finished = harness;
  harness = undefined;
  await finished?.dispose();
});

/** The selection proposes u1#a0 without enough confidence, so the owner decides; a reading is whatever `onReading` scripts. */
function attemptsScenario(onReading: (h: () => Harness, contractId: () => string) => void, reading: 'approve' | 'unclear' = 'approve') {
  let contractId = '';
  const port = (context: AnswerContext): unknown => {
    const candidates = context.state['candidates'] as { id: string }[] | undefined;
    if (candidates !== undefined) {
      if (context.name === 'pick') return choiceAnswer(context.question, 'u1#a0', 0.75);
      const fit = /^fits_(\d+)$/.exec(context.name);
      return fit === null ? undefined : noulAnswer(candidates[Number(fit[1])]!.id === 'u1#a0' ? 0.97 : 0.03);
    }
    if (context.name === 'reading') {
      onReading(() => harness!, () => contractId);
      return choiceAnswer(context.question, reading, 0.97);
    }
    return undefined;
  };
  const h = makeHarness({
    plan: oneUnitPlan(1),
    contract: { isolation: 'auto', defaultAttempts: 2 },
    scripts: { 'u1#a0': finishes('parser zero'), 'u1#a1': finishes('parser one') },
    port,
  });
  harness = h;
  return {
    h,
    async reach(): Promise<string> {
      const { contract } = await startContract(h);
      contractId = contract.id;
      await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the attempts to go to the owner', 15_000);
      return contract.id;
    },
    questionOf: (id: string): string => contractOf(h, id).escalations.at(-1)!.id,
  };
}

describe('owner replies racing other surfaces', () => {
  test('an operator pick during a reading takes effect, and the reply then applies nothing', async () => {
    let pick: Promise<unknown> | undefined;
    let groupId = '';
    const s = attemptsScenario((h, id) => {
      pick = h().runner.fleetControls().pickAttemptWinner(groupId, `${id()}:u1#a1`).then(() => 'picked', (error: unknown) => error);
    });
    const id = await s.reach();
    groupId = (await s.h.runner.fleetControls().listHeldMergeGroups())[0]!.groupId;
    const refused = await s.h.runner.reply(id, s.questionOf(id), 'Yes, go with the proposal.').then(() => undefined, (caught: unknown) => caught);
    expect(await pick).toBe('picked');
    expect(refused).toBeInstanceOf(OwnerReplyRefusedError);
    expect((refused as OwnerReplyRefusedError).refusal).toBe('not-open');
    await waitFor(() => terminal(s.h, id), 'the contract to end', 15_000);
    const done = contractOf(s.h, id);
    expect(done.status).toBe('passed');
    expect(done.units[0]!.attemptSelection?.pickedId).toBe('u1#a1');
  }, 30_000);

  test('a contract cancelled while the reply is read aborts the read, keeps the question unanswered and refuses the reply', async () => {
    const s = attemptsScenario((h, id) => { h().runner.cancel(id(), 'cancelled during the reading'); });
    const id = await s.reach();
    const question = s.questionOf(id);
    const error = await s.h.runner.reply(id, question, 'Yes.').then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('cancelled');
    const done = contractOf(s.h, id);
    expect(done.status).toBe('cancelled');
    const escalation = done.escalations.find((candidate) => candidate.id === question)!;
    expect(escalation.reply).toBeUndefined();
  }, 30_000);
});

describe('refusals a caller causes are typed', () => {
  test('a second concurrent reply is already-reading, and a reply to an answered question is not-open', async () => {
    let second: Promise<unknown> | undefined;
    const s = attemptsScenario((h, id) => {
      second = h().runner.reply(id(), contractOf(h(), id()).escalations.at(-1)!.id, 'again').then(() => undefined, (error: unknown) => error);
    }, 'unclear');
    const id = await s.reach();
    const first = s.questionOf(id);
    await s.h.runner.reply(id, first, 'What does that mean?');
    const concurrent = await second;
    expect(concurrent).toBeInstanceOf(OwnerReplyRefusedError);
    expect((concurrent as OwnerReplyRefusedError).refusal).toBe('already-reading');
    const stale = await s.h.runner.reply(id, first, 'again').then(() => undefined, (caught: unknown) => caught);
    expect(stale).toBeInstanceOf(OwnerReplyRefusedError);
    expect((stale as OwnerReplyRefusedError).refusal).toBe('not-open');
  }, 30_000);
});
