/** A plan cannot ask one unit for so many attempts that creating them exhausts the daemon. */
import { expect, test } from 'bun:test';
import { MAX_UNIT_ATTEMPTS, validateContractPlan, type PlanLimits } from '../../platform/src/platform/contract/plan-schema.js';
import { ASK, asPlan, shapeOf, validPlan } from './plan-support.js';

const LIMITS: PlanLimits = { maxUnits: 64, defaultAttempts: 1 };

function attemptProblems(attempts: number, asked: boolean) {
  const plan = validPlan();
  plan.groups[0]!.units[0]!.attempts = attempts;
  return validateContractPlan(asPlan(plan), ASK, shapeOf(asked ? ['asks_for_attempts'] : []), LIMITS).filter((problem) => problem.code === 'attempts');
}

test('a count above the ceiling is a plan problem even when several attempts were asked for', () => {
  const problems = attemptProblems(1_000_000, true);
  expect(problems.map((problem) => problem.targetId)).toEqual(['u1']);
  expect(problems[0]!.message).toContain(String(MAX_UNIT_ATTEMPTS));
});

test('the ceiling itself is allowed when several attempts were asked for', () => {
  expect(attemptProblems(MAX_UNIT_ATTEMPTS, true)).toEqual([]);
});
