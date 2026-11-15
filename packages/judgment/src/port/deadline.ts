/** How long a decision a person or a tool call waits on may take before its fallback applies. */
export const DEFAULT_DECISION_DEADLINE_MS = 1_500;
/** The largest decision deadline the settings accept. */
export const MAX_DECISION_DEADLINE_MS = 120_000;
/** Consecutive missed deadlines after which a target is skipped for {@link DEADLINE_COOLDOWN_MS}. */
export const DEADLINE_MISSES_BEFORE_COOLDOWN = 3;
/** How long a target that kept missing its deadline is skipped. */
export const DEADLINE_COOLDOWN_MS = 60_000;

/** A whole number of milliseconds a decision deadline can be. */
export function validDecisionDeadline(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DECISION_DEADLINE_MS;
}
