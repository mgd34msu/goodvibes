/**
 * With no repair limit, a fix planner that keeps answering with a plan the
 * code checks reject is not asked for ever: the owner decides after the
 * second identical rejection.
 */
import { afterEach, expect, test } from 'bun:test';
import { plannerOutput } from './plan-support.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { contractOf, fixPlan, keepsFailing, routeAnswer, stepPlanner } from './steps-support.js';

let harness: Harness | undefined;
afterEach(async () => {
  const finished = harness;
  harness = undefined;
  await finished?.dispose();
});

test('the same rejected fix plan twice with planRepairLimit 0 goes to the owner', async () => {
  // Serves a criterion the unit does not have, so the code checks reject it every time.
  const rejected = (): string => plannerOutput(fixPlan([{ serves: ['u1.c99'], files: ['src/csv.ts'] }]));
  const planner = stepPlanner(oneUnitPlan(1), { fix: rejected });
  const h = makeHarness({
    plan: oneUnitPlan(1),
    contract: { stallLimit: 2, planRepairLimit: 0 },
    planner: planner.runner,
    scripts: { u1: keepsFailing(3) },
    port: routeAnswer('split'),
  });
  harness = h;
  const { contract } = await startContract(h);
  await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the owner to be asked about the fix plan', 15_000);
  expect(planner.of('fix')).toHaveLength(2);
  const escalation = contractOf(h, contract.id).escalations.at(-1)!;
  expect(escalation.reason).toBe('stalled');
  expect(escalation.question).toContain('could not be made to pass its checks');
}, 25_000);
