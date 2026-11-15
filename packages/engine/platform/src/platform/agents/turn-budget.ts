/**
 * agents/turn-budget.ts
 *
 * Resolving the per-agent turn ceiling as a real, configurable feature rather
 * than a hardcoded constant, and naming the budget-exhaustion outcome so wire
 * consumers can read it instead of regex-matching a prose string.
 *
 * Resolution order (mirrors the orchestration spawn-policy cap machinery so the
 * two never fight): a per-spawn override wins over the config default, but the
 * policy cap always wins over the override, a caller cannot lift the ceiling
 * past agents.maxTurnsCap. The resolved budget carries WHICH input applied so
 * the failure outcome can report it (default / spawn-override / policy-bound).
 */

/** The machine-readable outcome kind for a run that spent its whole turn budget. */
export const TURN_BUDGET_EXHAUSTED = 'max_turns' as const;
export type TurnBudgetExhausted = typeof TURN_BUDGET_EXHAUSTED;

/** Which input determined the applied turn budget. */
export type TurnBudgetSource = 'default' | 'spawn-override' | 'policy-bound';

export interface ResolvedTurnBudget {
  /** The turn ceiling that actually applies to the run. */
  readonly limit: number; // 0 means no turn ceiling
  /** Which input set it, for the honest turn-budget-exhausted outcome. */
  readonly source: TurnBudgetSource;
}

export interface ResolveTurnBudgetInput {
  /** The configured default (agents.maxTurns). */
  readonly configDefault: number;
  /** A per-spawn override, if the spawn requested one. */
  readonly spawnOverride?: number | undefined;
  /** The hard cap a spawn override cannot exceed (agents.maxTurnsCap). */
  readonly policyCap: number;
}

function turnLimitOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Zero disables a ceiling. An explicitly configured owner cap still wins. */
export function resolveTurnBudget(input: ResolveTurnBudgetInput): ResolvedTurnBudget {
  const cap = turnLimitOr(input.policyCap, 0);
  const configured = turnLimitOr(input.configDefault, 0);
  const requested = turnLimitOr(input.spawnOverride, configured);
  if (cap > 0 && (requested === 0 || requested > cap)) {
    return { limit: cap, source: 'policy-bound' };
  }
  const overrideApplied = turnLimitOr(input.spawnOverride, -1) >= 0;
  return { limit: requested, source: overrideApplied ? 'spawn-override' : 'default' };
}

/** The human-readable turn-limit error string, unchanged prose, so nothing that reads it breaks. */
export function formatTurnLimitError(limit: number): string {
  return `Exceeded maximum turn limit (${limit})`;
}


/** The turn on which the model is told its budget is nearly spent: the first turn at or past 80% of it (0 for no ceiling). */
export function turnLimitWarningTurn(limit: number): number {
  return limit > 0 ? Math.max(1, Math.ceil(limit * 0.8)) : 0;
}

/** What the model is told on that turn, so it can finish before the ceiling fails the run. */
export function formatTurnLimitWarning(turn: number, limit: number): string {
  const remaining = limit - turn + 1;
  return `Turn budget: this is turn ${turn} of ${limit}; ${remaining <= 1 ? 'it is your last turn' : `${remaining} turns remain, including this one`}. `
    + 'When the budget is spent the run fails and only your last message is kept. Finish the essential work and end with your final answer.';
}
