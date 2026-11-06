import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput, prepareJudgmentResult, retainStrictJudgmentJson } from '../gate/index.js';
import { planningGoal } from './batteries/planning-goal.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';

export type PlanningGoalReading = 'goal' | 'command' | 'held' | 'unassessed';
export interface PlanningGoalObservation {
  readonly conclusion: PlanningGoalReading;
  readonly provenance?: 'classic';
  readonly assertCurrent: () => void;
}

/** A semantic observation only; the caller retains native intake authority. */
export async function readPlanningGoal(input: { readonly text: string }, options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {}): Promise<PlanningGoalObservation> {
  return decisionOrClassic(() => readDecisionPlanningGoal(input, options), () => {
    const original = retainStrictJudgmentJson(input);
    assertJudgmentInput(original.snapshot);
    const signal = options.signal, callerCurrent = options.assertCurrent;
    const current = () => {
      signal?.throwIfAborted(); original.assertCurrent();
      if (options.signal !== signal || options.assertCurrent !== callerCurrent) throw new TypeError('Planning source owner changed.');
      const restriction: unknown = callerCurrent?.();
      if (restriction !== undefined) { drainOwned(restriction); throw new TypeError('Invalid planning source guard.'); }
      signal?.throwIfAborted(); original.assertCurrent();
    };
    current();
    return Object.freeze({ conclusion: 'unassessed' as const, provenance: 'classic' as const, assertCurrent: current });
  });
}
async function readDecisionPlanningGoal(input: { readonly text: string }, options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'>): Promise<PlanningGoalObservation> {
  const original = retainStrictJudgmentJson(input);
  assertJudgmentInput(original.snapshot);
  const signal = options.signal, callerCurrent = options.assertCurrent, run = planningGoal.run;
  const policy = retainStrictJudgmentJson({ items: planningGoal.items, model: planningGoal.model });
  const authority = captureJudgmentPort('agents.planning-goal', {
    ...(signal === undefined ? {} : { signal }), prepareResultCapture: prepareJudgmentResult,
    assertCurrent: () => {
      signal?.throwIfAborted(); original.assertCurrent(); policy.assertCurrent();
      if (planningGoal.run !== run) throw new TypeError('Planning reading policy changed.');
      if (options.signal !== signal || options.assertCurrent !== callerCurrent) throw new TypeError('Planning source owner changed.');
      const result = callerCurrent?.(); if (result !== undefined) throw new TypeError('Invalid planning source guard.');
    },
  });
  const result = await run(authority.port, original.snapshot, {
    signal: authority.signal, site: 'agents.planning-goal', beforeAttempt: authority.assertCurrent,
  });
  authority.assertCurrent();
  const reading = result.readings.goal;
  const conclusion: PlanningGoalReading = reading.outcome !== 'act' || reading.verdict === 'uncertain' ? 'held' : reading.verdict === 'yes' ? 'goal' : 'command';
  result.recordAction(`planning goal:${conclusion}`);
  authority.assertCurrent();
  return Object.freeze({ conclusion, assertCurrent: authority.assertCurrent });
}
