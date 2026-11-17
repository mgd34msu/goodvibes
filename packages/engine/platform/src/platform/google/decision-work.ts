import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { DecisionModelsDisabledError, JudgmentPortMissingError, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';

/** Native lifetime remains binding when a decision endpoint is unavailable. */
export function googleCallerCurrent(options: JudgmentReadingOptions): () => void {
  const signal = options.signal, guard = options.assertCurrent;
  return () => {
    if (signal?.aborted) throw new JudgmentError('aborted', 'The Google operation was cancelled.');
    if (options.signal !== signal || options.assertCurrent !== guard) throw new Error('Google operation owner changed.');
    assertSynchronousJudgmentGuard(guard, () => new Error('Google operation ownership must be synchronous.'));
    if (signal?.aborted) throw new JudgmentError('aborted', 'The Google operation was cancelled.');
  };
}

/**
 * Own the complete flow, including its effects. Never restart it after an outage.
 * Each page reading inside it is asked of the decision model or read by code
 * (`decisionOrClassic`): with no decision model in use the flow runs on the code
 * readings, and a Hybrid outage moves the rest of the flow to them.
 */
export function withGoogleDecisionWork<T>(options: JudgmentReadingOptions, work: () => Promise<T>): Promise<T> {
  return withConfiguredDecisionModelPolicy(async () => {
    const current = googleCallerCurrent(options);
    current();
    try { const result = await work(); current(); return result; }
    catch (error) { current(); throw error; }
  });
}

/** Optional page observations may report unknown, but cannot hide policy or transport failures. */
export function preserveGoogleDecisionFailure(error: unknown, options: JudgmentReadingOptions): void {
  googleCallerCurrent(options)();
  if (error instanceof JudgmentError || error instanceof JudgmentPortMissingError || error instanceof DecisionModelsDisabledError) throw error;
}
