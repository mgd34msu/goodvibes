/**
 * Every decision a contract asks of the decision model has a fallback, and a
 * decision that cannot be made never ends the work it was judging.
 *
 * `judgedOrNot` runs a decision phase. With no decision model in use, or when
 * Hybrid found the set model failing (the owner is told once, by the failure
 * notice), the phase's own no-model path runs. When the decision still cannot
 * be made (the endpoint refused the request, the set model failed under
 * Decision Model Only, the decision client or its log failed), the no-model
 * path runs too, told why, so the work is kept and recorded as not judged.
 * Only a cancellation, and errors that are not the decision model's, pass
 * through.
 */
import { decisionModelPolicyState, DecisionModelsDisabledError, JudgmentPortMissingError } from '@goodvibes/engine/errors';
import { JudgmentError } from '@goodvibes/judgment';
import { decisionModelFailure, decisionOrClassic } from '../runtime/decision-policy.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/** Why the decision model could not make a decision, or undefined when the error is not the decision model's. */
export function notJudgedReason(error: unknown): string | undefined {
  if (error instanceof JudgmentPortMissingError) return error.message;
  if (error instanceof JudgmentError && error.kind !== 'aborted') return error.message;
  return undefined;
}

/**
 * Why the no-model path runs now: undefined when no decision model is in use
 * (none set, or No Decision Model chosen), else what the set model's failure was.
 */
function unavailableReason(): string | undefined {
  const state = decisionModelPolicyState();
  if (state.reason !== 'unavailable') return undefined;
  const failure = decisionModelFailure();
  return failure === undefined ? 'the decision model is unavailable' : `the decision model ${failure.model} is unavailable (${failure.what})`;
}

/**
 * The decision, or the phase's no-model path with the reason the decision
 * model did not decide (undefined: no decision model is in use). `fallback`
 * runs at most once and must not repeat an effect `decision` already made.
 */
export async function judgedOrNot<T>(site: string, decision: () => Promise<T>, fallback: (notJudged: string | undefined) => T | Promise<T>): Promise<T> {
  let fellBack = false;
  try {
    return await decisionOrClassic(decision, () => { fellBack = true; return fallback(unavailableReason()); });
  } catch (error) {
    if (fellBack) throw error;
    const reason = notJudgedReason(error) ?? (error instanceof DecisionModelsDisabledError ? error.message : undefined);
    if (reason === undefined) throw error;
    logger.warn('contract: a decision could not be made; its no-model path decides and the work is kept', { site, error: summarizeError(error) });
    return fallback(reason);
  }
}
