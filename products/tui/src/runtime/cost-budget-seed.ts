/**
 * cost-budget-seed.ts, the first-run convenience that turns the
 * GOODVIBES_COST_BUDGET_USD environment variable into the budget alert config
 * key.
 *
 * The spending alert is the daemon's setting `behavior.budgetAlertUsd` (Money,
 * Spending, sets it from any program), and 0 there is a deliberate "alert off".
 * The variable therefore seeds the key only when nothing was ever stored for it;
 * a stored 0 is the owner's choice and stays.
 */
import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { BUDGET_ALERT_USD_CONFIG_KEY } from '@goodvibes/engine/platform/platform/providers';

/** Returns the budget it seeded, or null when it left the key alone. */
export function seedCostBudgetFromEnv(
  config: Pick<ConfigManager, 'describeConfigKeySource' | 'set'>,
  rawEnvValue: string | undefined,
): number | null {
  const parsed = Number(rawEnvValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  // The setting is in the schema, so a read always has a value; whether one was stored is its source.
  const key: ConfigKey = BUDGET_ALERT_USD_CONFIG_KEY;
  if (config.describeConfigKeySource(key).tier !== 'default') return null;
  config.set(key, parsed as never);
  return parsed;
}
