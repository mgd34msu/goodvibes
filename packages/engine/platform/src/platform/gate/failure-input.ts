import { captureJudgmentFailureInput } from './failure-input-snapshot.js';

/** The failure as a reading may see it: the fields that decide it, privacy-screened; never throws for an Error. */
export function captureJudgmentFailure(input: unknown): unknown {
  return captureJudgmentFailureInput(input);
}
