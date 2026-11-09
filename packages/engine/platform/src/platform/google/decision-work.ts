import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { DecisionModelsDisabledError, JudgmentPortMissingError, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { activateClassicFallback, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';

const GOOGLE_AUTOMATION = 'automatic Google page interpretation or verification selection; complete the step manually using Google settings or provide the exact credential through secure setup';

/** Native lifetime remains binding when a decision endpoint is unavailable. */
export function googleCallerCurrent(options: JudgmentReadingOptions): () => void {
  const signal = options.signal, guard = options.assertCurrent;
  return () => {
    if (signal?.aborted) throw new JudgmentError('aborted', 'The Google operation was cancelled.');
    if (options.signal !== signal || options.assertCurrent !== guard) throw new Error('Google operation owner changed.');
    const checked: unknown = guard?.();
    if (checked !== undefined) { drainOwned(checked); throw new Error('Google operation ownership must be synchronous.'); }
    if (signal?.aborted) throw new JudgmentError('aborted', 'The Google operation was cancelled.');
  };
}

/** Own the complete flow, including its effects. Never restart it after an outage. */
export function withGoogleDecisionWork<T>(options: JudgmentReadingOptions, work: () => Promise<T>): Promise<T> {
  return withConfiguredDecisionModelPolicy(async () => {
    const current = googleCallerCurrent(options);
    current(); requireDecisionFeature(GOOGLE_AUTOMATION);
    try { const result = await work(); current(); return result; }
    catch (error) {
      current();
      if (activateClassicFallback(error)) requireDecisionFeature(GOOGLE_AUTOMATION);
      throw error;
    }
  });
}

/** Optional page observations may report unknown, but cannot hide policy or transport failures. */
export function preserveGoogleDecisionFailure(error: unknown, options: JudgmentReadingOptions): void {
  googleCallerCurrent(options)();
  if (error instanceof JudgmentError || error instanceof JudgmentPortMissingError || error instanceof DecisionModelsDisabledError) throw error;
}
