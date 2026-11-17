import { REASONING_EFFORT_SEVERITY } from '@goodvibes-jev/engine/contracts';

export { REASONING_EFFORT_SEVERITY };

/** Position in the severity ordering, or -1 when the level is not a known one. */
export function reasoningEffortRank(level: string): number {
  return REASONING_EFFORT_SEVERITY.indexOf(level);
}

/**
 * Validate a persisted preference without tying it to a temporary serving model.
 * Known levels remain valid across model switches; request construction snaps
 * the stored level to what each model accepts, and the places that know the
 * model (`/effort`, the model picker) say which level it will use.
 */
export function isAcceptableReasoningEffortSetting(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && reasoningEffortRank(value) !== -1;
}
