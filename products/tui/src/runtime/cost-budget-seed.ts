/**
 * cost-budget-seed.ts, the first-run convenience that turns the
 * GOODVIBES_COST_BUDGET_USD environment variable into the budget alert config
 * key.
 *
 * Once a session starts, the Usage modal and `/usage alert <dollars>` write
 * `behavior.budgetAlertUsd` themselves, and 0 there is a deliberate "alert off".
 * The variable therefore seeds the key only when nothing was ever stored for it;
 * a stored 0 is the owner's choice and stays.
 */
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

const BUDGET_ALERT_KEY = 'behavior.budgetAlertUsd';

/** Returns the budget it seeded, or null when it left the key alone. */
export function seedCostBudgetFromEnv(
  config: Pick<ConfigManager, 'get' | 'set'>,
  rawEnvValue: string | undefined,
): number | null {
  const parsed = Number(rawEnvValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const stored = config.get(BUDGET_ALERT_KEY as Parameters<typeof config.get>[0]) as unknown;
  if (stored !== undefined && stored !== null) return null;
  config.set(BUDGET_ALERT_KEY as Parameters<typeof config.set>[0], parsed as never);
  return parsed;
}
