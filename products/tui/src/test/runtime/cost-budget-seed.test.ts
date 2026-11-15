/**
 * GOODVIBES_COST_BUDGET_USD seeds the budget alert only when nothing was ever
 * stored. A stored 0 is the owner turning the alert off, and stays off.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { seedCostBudgetFromEnv } from '../../runtime/cost-budget-seed.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let dir: string;
let config: ConfigManager;
beforeEach(() => {
  dir = makeProjectTempDir('gv-cost-budget-seed');
  config = new ConfigManager({ surfaceRoot: 'tui', workingDir: dir, homeDir: dir, configDir: join(dir, '.goodvibes', 'global-tui') });
});
afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

const KEY = 'behavior.budgetAlertUsd' as never;

describe('seeding the budget alert from the environment', () => {
  test('a key that was never set takes the variable', () => {
    expect(seedCostBudgetFromEnv(config, '5')).toBe(5);
    expect<unknown>(config.get(KEY)).toBe(5);
  });

  test('a stored 0 (alert deliberately off) is not re-armed by the variable', () => {
    config.set(KEY, 0 as never);

    expect(seedCostBudgetFromEnv(config, '5')).toBeNull();
    expect<unknown>(config.get(KEY)).toBe(0);
  });

  test('a stored budget is kept, and an unusable variable seeds nothing', () => {
    config.set(KEY, 12 as never);
    expect(seedCostBudgetFromEnv(config, '5')).toBeNull();
    expect<unknown>(config.get(KEY)).toBe(12);

    const fresh = new ConfigManager({ surfaceRoot: 'tui', workingDir: dir, homeDir: dir, configDir: join(dir, '.goodvibes', 'other-tui') });
    expect(seedCostBudgetFromEnv(fresh, 'abc')).toBeNull();
    expect(seedCostBudgetFromEnv(fresh, '-3')).toBeNull();
    expect(seedCostBudgetFromEnv(fresh, undefined)).toBeNull();
  });
});
