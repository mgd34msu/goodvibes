/**
 * Every decision a contract asks of the decision model has a fallback, and a
 * decision that cannot be made never ends the work it was judging.
 *
 * `judgedOrNot` runs a decision phase through `decisionOrClassic`, which gives
 * every decision the model did not make (no model in use, Hybrid found the set
 * model failing, the endpoint refused the request, the set model failed under
 * Decision Model Only, the decision client or its log failed) to the phase's
 * no-model path, told why, so the work is kept and recorded as not judged.
 * Only a cancellation, and errors that are not the decision model's, pass
 * through.
 */
import { decisionModelPolicyState, DecisionModelsDisabledError, JudgmentPortMissingError } from '@goodvibes/engine/errors';
import { JudgmentError } from '@goodvibes/judgment';
import { decisionModelFailure, decisionOrClassic } from '../runtime/decision-policy.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/**
 * Why the no-model path runs now: undefined when no decision model is in use
 * (none set, or No Decision Model chosen); what the set model's failure was
 * when Hybrid moved the work to its no-model path; else the failure itself.
 */
function notJudgedReason(failure: unknown): string | undefined {
  const state = decisionModelPolicyState();
  if (state.reason === 'unavailable') {
    const known = decisionModelFailure();
    return known === undefined ? 'the decision model is unavailable' : `the decision model ${known.model} is unavailable (${known.what})`;
  }
  if (failure instanceof JudgmentPortMissingError || failure instanceof DecisionModelsDisabledError) return failure.message;
  if (failure instanceof JudgmentError) return failure.message;
  return undefined;
}

/**
 * The decision, or the phase's no-model path with the reason the decision
 * model did not decide (undefined: no decision model is in use). `fallback`
 * runs at most once and must not repeat an effect `decision` already made.
 */
export function judgedOrNot<T>(site: string, decision: () => Promise<T>, fallback: (notJudged: string | undefined) => T | Promise<T>): Promise<T> {
  return decisionOrClassic(decision, (failure) => {
    if (failure !== undefined) logger.warn('contract: a decision could not be made; its no-model path decides and the work is kept', { site, error: summarizeError(failure) });
    return fallback(notJudgedReason(failure));
  });
}
