/**
 * Explicit feature enable/disable over the dissolved feature model:
 * domain-key resolution shapes and the runtime-only CLI overrides.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import {
  isFeatureEnabledInConfig,
  resolveFeatureEnablementWrite,
} from '../../runtime/feature-enablement.ts';
import { applyRuntimeFeatureOverrides } from '../../cli/config-overrides.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('resolveFeatureEnablementWrite', () => {
  test('boolean bindings write the domain key true/false', () => {
    expect(resolveFeatureEnablementWrite('exec-sandbox', 'enabled')).toEqual({ key: 'sandbox.enabled', value: true });
    expect(resolveFeatureEnablementWrite('exec-sandbox', 'disabled')).toEqual({ key: 'sandbox.enabled', value: false });
    expect(resolveFeatureEnablementWrite('route-binding', 'disabled')).toEqual({ key: 'integrations.routeBinding', value: false });
  });

  test('enum bindings write the canonical enabled value and a schema-honest disabled value', () => {
    expect(resolveFeatureEnablementWrite('permissions-policy-engine', 'enabled')).toEqual({
      key: 'permissions.engine',
      value: 'policy-engine',
    });
    const disabled = resolveFeatureEnablementWrite('permissions-policy-engine', 'disabled');
    expect(disabled.key).toBe('permissions.engine');
    expect(disabled.value).not.toBe('policy-engine');
  });

  test('always-available (constant) features refuse with their real settings keys', () => {
    expect(() => resolveFeatureEnablementWrite('slack-surface', 'disabled')).toThrow('surfaces.slack.enabled');
    expect(() => resolveFeatureEnablementWrite('slack-surface', 'enabled')).toThrow('always available');
  });

  test('unknown ids fail loudly naming the known features', () => {
    expect(() => resolveFeatureEnablementWrite('no-such-feature', 'enabled')).toThrow('Unknown feature "no-such-feature"');
    expect(() => resolveFeatureEnablementWrite('no-such-feature', 'enabled')).toThrow('exec-sandbox');
  });
});

describe('runtime-only CLI feature overrides', () => {
  let root: string;
  let configManager: ConfigManager;

  beforeEach(() => {
    root = makeProjectTempDir('gv-feature-overrides');
    configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(root, 'config'),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('writes the domain key in memory without persisting to disk', () => {
    expect(configManager.get('sandbox.enabled')).toBe(true);
    const errors = applyRuntimeFeatureOverrides(configManager, {
      enableFeatures: [],
      disableFeatures: ['exec-sandbox'],
    });
    expect(errors).toEqual([]);
    expect(configManager.get('sandbox.enabled')).toBe(false);
    expect(isFeatureEnabledInConfig(configManager, 'exec-sandbox')).toBe(false);

    // Runtime-only: the settings file (if any) never sees the override.
    const settingsPath = join(root, 'config', 'settings.json');
    const persisted = (() => {
      try {
        return JSON.parse(readFileSync(settingsPath, 'utf-8')) as { sandbox?: { enabled?: boolean } };
      } catch {
        return null;
      }
    })();
    if (persisted?.sandbox && 'enabled' in persisted.sandbox) {
      expect(persisted.sandbox.enabled).toBe(true);
    }
  });

  test('enum features get their canonical enabled value', () => {
    const errors = applyRuntimeFeatureOverrides(configManager, {
      enableFeatures: ['permissions-policy-engine'],
      disableFeatures: [],
    });
    expect(errors).toEqual([]);
    expect(configManager.get('permissions.engine')).toBe('policy-engine');
  });

  test('unknown and always-available features return honest errors instead of being swallowed', () => {
    const errors = applyRuntimeFeatureOverrides(configManager, {
      enableFeatures: ['not-a-feature'],
      disableFeatures: ['slack-surface'],
    });
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('Invalid --enable not-a-feature.');
    expect(errors[0]).toContain('Unknown feature');
    expect(errors[1]).toContain('Invalid --disable slack-surface.');
    expect(errors[1]).toContain('surfaces.slack.enabled');
  });
});
