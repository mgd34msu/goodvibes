import { expect, test } from 'bun:test';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import { DEFAULT_CONFIG } from '../platform/src/platform/config/schema.js';
import { buildDefaultFailurePolicy } from '../platform/src/platform/automation/manager-runtime-helpers.js';

test('a config reader with no value for the failure cooldown gets the shipped cooldown', () => {
  const partial = { get: () => undefined } as unknown as ConfigManager;
  expect(buildDefaultFailurePolicy(partial).cooldownMs).toBe(DEFAULT_CONFIG.automation.failureCooldownMs);
});
