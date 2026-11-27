// Proves: A piece of Work whose planner offers again a plan already refused dies or loops instead of waiting for the owner once, so the work he asked for is lost.
// Red when: The repeated refused plan ends the work failed, crashes it on an illegal move, asks the owner more than once or runs the planner again unasked, or the owner's answer does not run the planner again on his words or does not stop the work on "stop".
import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { makeHarness, makeRepo, oneUnitPlan, type Harness } from './runner-support.js';
import { plannerOutput, type DraftPlan } from './plan-support.js';
import { nativeSourcePlan } from '../../platform/src/platform/contract/native-source.ts';
import type { DecompositionRunnerRequest } from '../../platform/src/platform/core/plan-decomposition.ts';
import type { ContractView, NativeContractSource } from '../../platform/src/platform/contract/index.js';

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await Promise.resolve(h.dispose()).catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GOAL = 'Add a CSV parser module';
const CRITERION = 'A CSV parser module exists';
const CORRECTION = 'Keep my goal and result exactly as I gave them; plan one step for the parser.';
const source = (id: string): NativeContractSource => ({
  sourceId: `source-${id}`, sourceRevision: '1', inputRevision: '1', criteriaId: `criteria-${id}`, criteriaRevision: '1', goal: GOAL, criteria: [CRITERION],
});

/** Waits, on the runner's own events, until `ready` reads true for the contract. */
function until(h: Harness, contractId: string, ready: (contract: ContractView) => boolean): Promise<ContractView> {
  return new Promise((resolve) => {
    const check = (): boolean => { const contract = h.runner.get(contractId); if (contract && ready(contract)) { resolve(contract); return true; } return false; };
    if (check()) return;
    const stop = h.runner.on(() => { if (check()) stop(); });
  });
}
const settledOrAsking = (contract: ContractView) => ['awaiting-owner', 'failed', 'cancelled', 'passed'].includes(contract.status);

test('a repeated refused plan is put to the owner once; his words plan it again, and "stop" stops it', async () => {
  const root = makeRepo(); roots.push(root);
  // The planner, for the model: one plan that rewrites the owner's goal (refused every time), until it is told his words.
  const refused: DraftPlan = { ...oneUnitPlan(1), goal: 'A different goal', criteria: [{ id: 'c1', text: 'Something else exists', quote: 'something else' }] };
  const passing: DraftPlan = { ...oneUnitPlan(1), ...nativeSourcePlan({ goal: GOAL, criteria: [CRITERION] }) } as DraftPlan;
  const requests: DecompositionRunnerRequest[] = [];
  const h = makeHarness({
    root, recordNative: true, plan: passing, contract: { maxActiveContracts: 4 },
    planner: { run: async (request) => {
      requests.push(request);
      return { status: 'completed', output: plannerOutput(request.userPrompt.includes(CORRECTION) ? passing : refused), elapsedMs: 1, agentId: `planner-${requests.length}` };
    } },
    scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] },
  });
  harnesses.push(h);

  const first = await h.runner.start({ ask: GOAL, sessionId: 'work-1', origin: 'external', projectRoot: root, isolation: 'shared', nativeSource: source('1') });
  const asked = await until(h, first.contract.id, settledOrAsking);
  expect(asked.status).toBe('awaiting-owner');
  const open = asked.escalations.filter((entry) => entry.resolvedAt === undefined);
  expect(open).toHaveLength(1);
  expect(open[0]!.question).toContain('offered the same plan again');
  // The first plan and its one repair; nothing more until the owner answers.
  expect(requests).toHaveLength(2);

  const changed = await h.runner.reply(first.contract.id, open[0]!.id, CORRECTION);
  expect(changed.action).toBe('amended');
  // Running its new plan, or ended, or asking again (a plan written again without his words repeats the refused one).
  const replanned = await until(h, first.contract.id, (contract) => contract.status === 'running' || ['failed', 'cancelled', 'passed'].includes(contract.status)
    || contract.escalations.some((entry) => entry.resolvedAt === undefined));
  expect(replanned.status).toBe('running');
  expect(requests).toHaveLength(3);
  expect(requests[2]!.userPrompt).toContain(CORRECTION);

  const second = await h.runner.start({ ask: GOAL, sessionId: 'work-2', origin: 'external', projectRoot: root, isolation: 'shared', nativeSource: source('2') });
  const askedAgain = await until(h, second.contract.id, settledOrAsking);
  expect(askedAgain.status).toBe('awaiting-owner');
  const question = askedAgain.escalations.find((entry) => entry.resolvedAt === undefined)!;
  expect((await h.runner.reply(second.contract.id, question.id, 'stop')).action).toBe('stopped');
  expect((await until(h, second.contract.id, (contract) => ['failed', 'cancelled', 'passed'].includes(contract.status))).status).toBe('cancelled');
});
