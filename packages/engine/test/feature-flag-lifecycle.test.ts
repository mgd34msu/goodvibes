/**
 * feature-flag-lifecycle.test.ts
 *
 * The restart marker for a gate its consumer reads once, the bounded
 * transition log, and the teardown of the settings bridge a composition attached.
 */
import { describe, expect, test } from 'bun:test';
import { createFeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/manager.js';
import { FEATURE_SETTINGS } from '../platform/src/platform/runtime/feature-flags/feature-settings.js';
import { disposeRuntimeFeatureFlags, resolveRuntimeFeatureFlags } from '../platform/src/platform/runtime/feature-flag-composition.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';

describe('overflow spill backend gate', () => {
  test('is startup-gated: surfaces show restart required and a live change is recorded as pending', () => {
    const setting = FEATURE_SETTINGS.find((s) => s.id === 'overflow-spill-backends')!;
    expect(setting.restartRequired).toBe(true);
    const manager = createFeatureFlagManager();
    manager.applyConfigState('overflow-spill-backends', 'enabled');
    expect(manager.isEnabled('overflow-spill-backends')).toBe(false);
    expect(manager.hasPendingRestart('overflow-spill-backends')).toBe(true);
  });
});

describe('transition log', () => {
  test('keeps only the latest entries and hands out a copy', () => {
    const manager = createFeatureFlagManager();
    for (let i = 0; i < 700; i++) {
      manager.applyConfigState('agent-passive-code-injection', 'enabled');
      manager.applyConfigState('agent-passive-code-injection', 'disabled');
    }
    const log = manager.getTransitions();
    expect(log.length).toBe(1000);
    expect(log[log.length - 1]!.next).toBe('disabled');
    (log as unknown as unknown[]).length = 0;
    expect(manager.getTransitions().length).toBe(1000);
  });
});

import { createTerminalFeatureFlags, disposeTerminalFeatureFlags } from '../terminal-shell/src/bootstrap-primitives.js';

describe('settings bridge teardown', () => {
  test('disposeRuntimeFeatureFlags removes every config subscription the composition added', () => {
    let live = 0;
    const configManager = {
      get: () => undefined,
      subscribe: () => {
        live += 1;
        let released = false;
        return () => {
          if (!released) { released = true; live -= 1; }
        };
      },
    } as unknown as ConfigManager;
    const featureFlags = resolveRuntimeFeatureFlags({ configManager });
    expect(live).toBeGreaterThan(0);
    disposeRuntimeFeatureFlags(featureFlags);
    expect(live).toBe(0);
  });

  test('disposeTerminalFeatureFlags removes the subscriptions createTerminalFeatureFlags added', () => {
    let live = 0;
    const configManager = {
      get: () => undefined,
      subscribe: () => {
        live += 1;
        let released = false;
        return () => {
          if (!released) { released = true; live -= 1; }
        };
      },
    } as unknown as ConfigManager;
    const featureFlags = createTerminalFeatureFlags(configManager);
    expect(live).toBeGreaterThan(0);
    disposeTerminalFeatureFlags(featureFlags);
    expect(live).toBe(0);
  });

  test('a manager the caller supplied is left alone', () => {
    let subscribed = 0;
    const configManager = { get: () => undefined, subscribe: () => { subscribed += 1; return () => {}; } } as unknown as ConfigManager;
    const supplied = createFeatureFlagManager();
    expect(resolveRuntimeFeatureFlags({ configManager, featureFlags: supplied })).toBe(supplied);
    expect(subscribed).toBe(0);
    disposeRuntimeFeatureFlags(supplied);
  });
});
