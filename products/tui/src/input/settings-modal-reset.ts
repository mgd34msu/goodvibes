/**
 * settings-modal-reset, pure reset helpers for SettingsModal.
 *
 * These functions encapsulate the three reset operations:
 *   - resetSelected: reset the currently selected setting to its schema default
 *   - initiateResetCategory: arm the category-reset confirmation gate
 *   - initiateResetAll: arm the reset-all confirmation gate
 *   - handleResetConfirmKey: route a keypress through the active gate
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state. resetCategoryConfirm and resetAllConfirm
 * remain public class fields on SettingsModal, the renderer reads them
 * directly to decide the footer state.
 */

import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { isSecretConfigKey } from '../config/secret-config.ts';
import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';
import type { SettingsSecretsManager } from './settings-modal-secrets.ts';

// ---------------------------------------------------------------------------
// resetSelected
// ---------------------------------------------------------------------------

export function resetSelected({
  editingMode,
  hasConfigManager,
  selected,
  resetSecrets,
  setValue,
  setHostValue,
}: {
  editingMode: boolean;
  hasConfigManager: boolean;
  selected: SettingEntry | null;
  secretsManager: SettingsSecretsManager | null;
  /** Starts captured-owner async resets; pending secrets are not reported as completed. */
  resetSecrets?: (entries: ReadonlyArray<{ key: ConfigKey; value: unknown }>) => void;
  /** Returns false when the write was refused; the reset is then not reported. */
  setValue: (key: ConfigKey, value: unknown) => boolean | void;
  setHostValue?: (key: string, value: boolean) => boolean | void;
}): { key: string; value: unknown } | null {
  if (editingMode || !hasConfigManager) return null;
  if (!selected) return null;
  if (selected.kind === 'host') {
    if (!setHostValue) return null;
    // Modal reset is scoped set(default), not the handle's full-owner reset().
    if (setHostValue(selected.setting.key, selected.setting.default) === false) return null;
    return { key: selected.setting.key, value: selected.setting.default };
  }
  if (selected.metadataUnavailable) return null;
  const key = selected.setting.key;
  if (isSecretConfigKey(key)) {
    resetSecrets?.([{ key, value: selected.setting.default }]);
    return null;
  }
  if (setValue(key, selected.setting.default) === false) return null;
  return { key, value: selected.setting.default };
}

// ---------------------------------------------------------------------------
// initiateResetCategory
// ---------------------------------------------------------------------------

export function initiateResetCategory({
  hasConfigManager,
  currentCategory,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  hasConfigManager: boolean;
  currentCategory: string;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): void {
  if (!hasConfigManager) return;
  setResetCategoryConfirm({ subject: currentCategory });
  setResetAllConfirm(null);
}

// ---------------------------------------------------------------------------
// initiateResetAll
// ---------------------------------------------------------------------------

export function initiateResetAll({
  hasConfigManager,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  hasConfigManager: boolean;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): void {
  if (!hasConfigManager) return;
  setResetAllConfirm({ subject: 'all' });
  setResetCategoryConfirm(null);
}

// ---------------------------------------------------------------------------
// handleResetConfirmKey
// ---------------------------------------------------------------------------

export type ResetConfirmKeyResult =
  | { result: 'confirmed'; entries: ReadonlyArray<{ key: string; value: unknown }>; failedKeys?: ReadonlyArray<string> }
  | 'cancelled'
  | 'absorbed'
  | 'inactive';

export function handleResetConfirmKey({
  key,
  resetCategoryConfirm,
  resetAllConfirm,
  hasConfigManager,
  currentItems,
  groups,
  setValue,
  resetSecrets,
  setHostValue,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  key: string;
  resetCategoryConfirm: { readonly subject: string } | null;
  resetAllConfirm: { readonly subject: 'all' } | null;
  hasConfigManager: boolean;
  currentItems: () => SettingEntry[];
  groups: Map<SettingsCategory, SettingEntry[]>;
  /** Returns false when the write was refused (managed lock, save failure); that key is not reported as reset. */
  setValue: (key: ConfigKey, value: unknown) => boolean | void;
  resetSecrets?: (entries: ReadonlyArray<{ key: ConfigKey; value: unknown }>) => void;
  setHostValue?: (key: string, value: boolean) => boolean | void;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): ResetConfirmKeyResult {
  const gate = resetCategoryConfirm ?? resetAllConfirm;
  if (!gate || !hasConfigManager) return 'inactive';

  if (key === 'enter' || key === 'y') {
    const entries: Array<{ key: string; value: unknown }> = [];
    const failedKeys: string[] = [];
    // A key listed under two categories (network, fleet, push, feature
    // headers) is reset and counted once.
    const seen = new Set<string>();
    const resetOne = (item: SettingEntry): void => {
      if (seen.has(item.setting.key)) return;
      seen.add(item.setting.key);
      const ok = item.kind === 'host'
        ? setHostValue?.(item.setting.key, item.setting.default)
        : setValue(item.setting.key, item.setting.default);
      if (ok === false) failedKeys.push(item.setting.key);
      else entries.push({ key: item.setting.key, value: item.setting.default });
    };
    const secretEntries = new Map<ConfigKey, { key: ConfigKey; value: unknown }>();
    if (resetCategoryConfirm) {
      // Reset all settings in the current category to defaults.
      const items = currentItems();
      for (const item of items) {
        if (item.kind === 'host' ? !setHostValue : item.metadataUnavailable) continue;
        if (item.kind !== 'host' && isSecretConfigKey(item.setting.key)) {
          secretEntries.set(item.setting.key, { key: item.setting.key, value: item.setting.default });
          continue;
        }
        resetOne(item);
      }
      setResetCategoryConfirm(null);
    } else {
      // Reset ALL settings across all categories to defaults.
      for (const [, items] of groups) {
        for (const item of items) {
          if (item.kind === 'host' ? !setHostValue : item.metadataUnavailable) continue;
          if (item.kind !== 'host' && isSecretConfigKey(item.setting.key)) {
            secretEntries.set(item.setting.key, { key: item.setting.key, value: item.setting.default });
            continue;
          }
          resetOne(item);
        }
      }
      setResetAllConfirm(null);
    }
    if (secretEntries.size > 0) resetSecrets?.([...secretEntries.values()]);
    return failedKeys.length > 0 ? { result: 'confirmed', entries, failedKeys } : { result: 'confirmed', entries };
  }

  if (key === 'escape' || key === 'n') {
    setResetCategoryConfirm(null);
    setResetAllConfirm(null);
    return 'cancelled';
  }

  // All other keys are absorbed while the gate is active.
  return 'absorbed';
}
