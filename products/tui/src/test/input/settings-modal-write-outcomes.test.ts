/**
 * What the settings modal tells the person after a write, a rejected edit, a
 * refused daemon write, a reset, and a synthetic-row refresh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, isDaemonOwnedConfigKey, type ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { SubscriptionManager, ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { buildSettingGroups, refreshEntryValues } from '../../input/settings-modal-data.ts';
import { commitEditValue } from '../../input/settings-modal-commit.ts';
import { applySettingValue, type DaemonOwnedConfigWriter } from '../../input/settings-modal-mutations.ts';
import { handleResetConfirmKey, resetSelected } from '../../input/settings-modal-reset.ts';
import type { SettingEntry } from '../../input/settings-modal-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

function settingsFileText(root: string): string {
  const dir = join(root, '.goodvibes', 'global-tui');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(join(dir, name), 'utf-8'))
    .join('\n');
}

describe('settings modal write outcomes', () => {
  let root: string;
  let cm: ConfigManager;

  beforeEach(() => {
    root = makeProjectTempDir('settings-write-outcomes');
    cm = createConfigManager(root);
  });

  afterEach(() => {
    cm.stopWatchingConfigFiles();
    rmSync(root, { recursive: true, force: true });
  });

  function find(groups: Map<string, SettingEntry[]>, key: string): SettingEntry {
    for (const entries of groups.values()) {
      const entry = entries.find((candidate) => candidate.setting.key === key);
      if (entry) return entry;
    }
    throw new Error(`no row for ${key}`);
  }

  function openModal(): SettingsModal {
    const modal = new SettingsModal();
    const subscriptionManager = new SubscriptionManager(join(root, 'subscriptions.json'));
    mkdirSync(root, { recursive: true });
    const serviceRegistry = new ServiceRegistry(join(root, 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root, configManager: cm }),
      subscriptionManager,
    });
    const mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    modal.open(cm, createFeatureFlagManager(), subscriptionManager, serviceRegistry, mcpRegistry);
    return modal;
  }

  function selectRow(modal: SettingsModal, category: (typeof SETTINGS_CATEGORIES)[number], key: string): void {
    modal.categoryIndex = SETTINGS_CATEGORIES.indexOf(category);
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === key);
    expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
    modal.focusRegion = 'settings';
  }

  describe('TUI-local rows keep their own reader when rows are refreshed', () => {
    test('alert toggles, thresholds and the code index row stay on their defaults after a refresh', () => {
      const groups = buildSettingGroups(cm) as unknown as Map<string, SettingEntry[]>;
      refreshEntryValues(groups as never, cm);

      const budgetGate = find(groups, 'behavior.notifyOnBudgetBreach');
      expect(budgetGate.currentValue).toBe(true);
      expect(budgetGate.isDefault).toBe(true);
      const turnEnd = find(groups, 'behavior.terminalNotifyTurnEnd');
      expect(turnEnd.currentValue).toBe(false);
      expect(turnEnd.isDefault).toBe(true);
      const afterSeconds = find(groups, 'behavior.notifyAfterSeconds');
      expect(afterSeconds.currentValue).toBe(60);
      expect(afterSeconds.isDefault).toBe(true);
      const codeIndex = find(groups, 'storage.codeIndexEnabled');
      expect(codeIndex.currentValue).toBe(false);
      expect(codeIndex.isDefault).toBe(true);
    });

    test('a written value is shown after a refresh', () => {
      cm.set('behavior.notifyOnBudgetBreach' as ConfigKey, false as never);
      const groups = buildSettingGroups(cm) as unknown as Map<string, SettingEntry[]>;
      refreshEntryValues(groups as never, cm);
      const budgetGate = find(groups, 'behavior.notifyOnBudgetBreach');
      expect(budgetGate.currentValue).toBe(false);
      expect(budgetGate.isDefault).toBe(false);
    });
  });

  describe('a rejected edit says so', () => {
    test('text that is not a number is refused with a message and leaves the value alone', () => {
      const modal = openModal();
      selectRow(modal, 'display', 'display.collapseThreshold');
      modal.activateSelected();
      expect(modal.editingMode).toBe(true);
      modal.editBuffer = 'abc';
      expect(modal.commitEdit()).toBe(false);
      expect(modal.lastSettingEffectMessage).toContain('display.collapseThreshold');
      expect(cm.get('display.collapseThreshold')).toBe(30);
      expect(modal.editingMode).toBe(false);
    });

    test('a cleared number field is refused rather than saved as 0', () => {
      const modal = openModal();
      selectRow(modal, 'display', 'display.collapseThreshold');
      modal.activateSelected();
      modal.editBuffer = '';
      expect(modal.commitEdit()).toBe(false);
      expect(modal.lastSettingEffectMessage).not.toBeNull();
      expect(cm.get('display.collapseThreshold')).toBe(30);
    });

    test('Infinity is refused rather than committed as a number', () => {
      const modal = openModal();
      selectRow(modal, 'display', 'display.collapseThreshold');
      modal.activateSelected();
      modal.editBuffer = 'Infinity';
      expect(modal.commitEdit()).toBe(false);
      expect(modal.lastSettingEffectMessage).toContain('display.collapseThreshold');
      expect(cm.get('display.collapseThreshold')).toBe(30);
    });

    test('a non-finite number is refused as not a number even when the setting has no range check', () => {
      const setting = { key: 'test.unranged', type: 'number' } as unknown as SettingEntry['setting'];
      for (const typed of ['Infinity', '1e999']) {
        const written: unknown[] = [];
        const rejected: string[] = [];
        const accepted = commitEditValue({
          editingMode: true, currentCategory: 'display', editBuffer: typed, configManager: {} as ConfigManager, secretsManager: null,
          mcpRegistry: null, mcpAllowAllConfirmationTarget: null,
          getSelectedMcp: () => null,
          getSelected: () => ({ kind: 'setting', setting } as unknown as SettingEntry),
          setValue: (_key, value) => { written.push(value); return true; },
          rejectEdit: (message) => rejected.push(message),
          setEditingMode: () => {}, setEditBuffer: () => {}, setMcpEntries: () => {}, setMcpAllowAllConfirmationTarget: () => {},
        });
        expect(accepted).toBe(false);
        expect(written).toEqual([]);
        expect(rejected.join('')).toContain('is not a number');
      }
    });

    test('a number the setting refuses is reported with the setting name', () => {
      const modal = openModal();
      selectRow(modal, 'display', 'display.collapseThreshold');
      modal.activateSelected();
      modal.editBuffer = '99999';
      expect(modal.commitEdit()).toBe(false);
      expect(modal.lastSettingEffectMessage).toContain('display.collapseThreshold');
      expect(cm.get('display.collapseThreshold')).toBe(30);
    });
  });

  describe('a daemon that refuses a daemon-owned write', () => {
    test('puts the previous value back, tells the daemon-change listener, and reports it', async () => {
      const key = 'watchers.enabled' as ConfigKey;
      expect(cm.get(key)).toBe(true);
      let refuse: (reason: Error) => void = () => {};
      const refused = new Promise<void>((_resolve, reject) => { refuse = reject; });
      const daemonConfig: DaemonOwnedConfigWriter = {
        ownsKey: (candidate) => isDaemonOwnedConfigKey(candidate),
        set: () => refused,
      };
      const applied: Array<{ previousValue: unknown; value: unknown }> = [];
      const reported = new Promise<string>((resolve) => {
        applySettingValue({
          key,
          value: false,
          configManager: cm,
          groups: new Map(),
          onSettingApplied: (change) => { applied.push({ previousValue: change.previousValue, value: change.value }); },
          refreshGroups: () => {},
          daemonConfig,
          onAsyncError: resolve,
        });
      });
      expect(cm.get(key)).toBe(false);
      refuse(new Error('daemon unreachable'));
      const message = await reported;
      expect(message).toContain('previous value restored');
      expect(cm.get(key)).toBe(true);
      expect(applied).toEqual([
        { previousValue: true, value: false },
        { previousValue: false, value: true },
      ]);
    });

    test('keeps a newer local edit instead of overwriting it with the old value', async () => {
      const key = 'watchers.pollIntervalMs' as ConfigKey;
      const original = cm.get(key);
      let refuse: (reason: Error) => void = () => {};
      const refused = new Promise<void>((_resolve, reject) => { refuse = reject; });
      const reported = new Promise<string>((resolve) => {
        applySettingValue({
          key,
          value: 7000,
          configManager: cm,
          groups: new Map(),
          onSettingApplied: null,
          refreshGroups: () => {},
          daemonConfig: { ownsKey: (candidate) => isDaemonOwnedConfigKey(candidate), set: () => refused },
          onAsyncError: resolve,
        });
      });
      cm.setDynamic(key, 8000);
      refuse(new Error('daemon unreachable'));
      const message = await reported;
      expect(message).not.toContain('previous value restored');
      expect(cm.get(key)).toBe(8000);
      expect(original).not.toBe(8000);
    });
  });

  describe('reset', () => {
    test('removes the explicit value so the setting reads as default again', () => {
      cm.setDynamic('display.collapseThreshold', 50);
      expect(settingsFileText(root)).toContain('collapseThreshold');
      const modal = openModal();
      selectRow(modal, 'display', 'display.collapseThreshold');
      expect(modal.resetSelected()).toEqual({ key: 'display.collapseThreshold', value: 30 });
      expect(cm.get('display.collapseThreshold')).toBe(30);
      expect(settingsFileText(root)).not.toContain('collapseThreshold');
      expect(modal.currentItems.find((entry) => entry.setting.key === 'display.collapseThreshold')?.isDefault).toBe(true);
    });

    test('a daemon-owned key is removed on the daemon, not rewritten with its default', async () => {
      const key = 'watchers.pollIntervalMs' as ConfigKey;
      cm.setDynamic(key, 12_345);
      const sent: string[] = [];
      const daemonConfig: DaemonOwnedConfigWriter = {
        ownsKey: (candidate) => isDaemonOwnedConfigKey(candidate),
        set: async (candidate, value) => { sent.push(`set ${candidate} ${String(value)}`); },
        reset: async (candidate) => { sent.push(`reset ${candidate}`); },
      };
      const defaultValue = cm.getSchema().find((setting) => setting.key === key)!.default;
      const result = applySettingValue({
        key, value: defaultValue, reset: true, configManager: cm, groups: new Map(), onSettingApplied: null, refreshGroups: () => {}, daemonConfig,
      });
      expect(result.failed).toBeUndefined();
      await Promise.resolve();
      expect(sent).toEqual([`reset ${key}`]);
      expect<unknown>(cm.get(key)).toBe(defaultValue);
      expect(settingsFileText(root)).not.toContain('pollIntervalMs');
    });

    test('a daemon writer that cannot reset still receives the default as a write', async () => {
      const key = 'watchers.pollIntervalMs' as ConfigKey;
      cm.setDynamic(key, 12_345);
      const sent: string[] = [];
      const daemonConfig: DaemonOwnedConfigWriter = {
        ownsKey: (candidate) => isDaemonOwnedConfigKey(candidate),
        set: async (candidate, value) => { sent.push(`set ${candidate} ${String(value)}`); },
      };
      const defaultValue = cm.getSchema().find((setting) => setting.key === key)!.default;
      applySettingValue({ key, value: defaultValue, reset: true, configManager: cm, groups: new Map(), onSettingApplied: null, refreshGroups: () => {}, daemonConfig });
      await Promise.resolve();
      expect(sent).toEqual([`set ${key} ${String(defaultValue)}`]);
    });

    test('a key that could not be written is not reported as reset', () => {
      const entry = (key: string): SettingEntry => ({
        setting: { key, type: 'boolean', default: true, description: '' },
        currentValue: false,
        isDefault: false,
      } as unknown as SettingEntry);
      const items = [entry('a.one'), entry('a.two'), entry('a.three')];
      const result = handleResetConfirmKey({
        key: 'y',
        resetCategoryConfirm: { subject: 'a' },
        resetAllConfirm: null,
        hasConfigManager: true,
        currentItems: () => items,
        groups: new Map(),
        setValue: (key) => String(key) !== 'a.two',
        setResetCategoryConfirm: () => {},
        setResetAllConfirm: () => {},
      });
      expect(result).toEqual({
        result: 'confirmed',
        entries: [{ key: 'a.one', value: true }, { key: 'a.three', value: true }],
        failedKeys: ['a.two'],
      });
    });

    test('a refused single reset returns nothing to sync', () => {
      const selected = {
        setting: { key: 'a.one', type: 'boolean', default: true, description: '' },
        currentValue: false,
        isDefault: false,
      } as unknown as SettingEntry;
      expect(resetSelected({
        editingMode: false,
        hasConfigManager: true,
        selected,
        secretsManager: null,
        setValue: () => false,
      })).toBeNull();
    });
  });
});
