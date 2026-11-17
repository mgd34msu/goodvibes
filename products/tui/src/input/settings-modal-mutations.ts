/**
 * settings-modal-mutations, pure mutation helpers for SettingsModal.
 *
 * These functions encapsulate the side-effectful write operations. Every
 * write, feature-unit headers included, is a plain domain-settings config
 * write; the platform's settings bridge keeps the runtime gate manager in sync
 * (flipping runtime-toggleable gates live and recording honest
 * pending-restart markers for startup-gated ones). Each function takes its
 * dependencies as explicit arguments rather than accessing class-level state.
 */

import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FlagEntry, SettingEntry } from './settings-modal-types.ts';
import { deepEqual, refreshHostSettingEntry, refreshSettingsPolicyAvailability } from './settings-modal-data.ts';

// ---------------------------------------------------------------------------
// ApplyValueResult, returned by applySettingValue so the caller can react
// ---------------------------------------------------------------------------

export interface ApplyValueResult {
  /** Restart domain that was triggered, if any. */
  readonly restartDomain: 'control-plane' | 'http-listener' | 'web' | null;
  /** Message from onSettingApplied handler, if any. */
  readonly effectMessage: string | null;
  /** Whether the value actually changed (false = no-op). */
  readonly changed: boolean;
  /** True when the write was refused or threw; the value is unchanged and effectMessage says why. */
  readonly failed?: boolean;
  /**
   * A daemon-owned write in flight: nothing is written here, the row keeps its
   * value until the daemon answers. Resolves once the daemon applied it (the
   * row then shows it); rejects with the daemon's refusal (nothing was written).
   */
  readonly settled?: Promise<void>;
}

export type SettingAppliedCallback = (change: {
  readonly key: string;
  readonly previousValue: unknown;
  readonly value: unknown;
}) => { readonly message?: string } | void;

// ---------------------------------------------------------------------------
// applySettingValue
// ---------------------------------------------------------------------------

/**
 * Where a DAEMON-owned setting is written.
 *
 * `surfaces.*`, `controlPlane.*`, `watchers.*`, `device.*`, `automation.*` and
 * the rest are executed by the daemon, unattended, with every surface closed.
 * The daemon is the one writer of its settings file: while it is reachable a
 * daemon-owned row is sent over `config.set` and nothing is written here; the
 * row shows "saving" until the daemon answers, and a refused value is written
 * nowhere. With no daemon running, the daemon's settings file is written for it
 * to read when it starts.
 */
export interface DaemonOwnedConfigWriter {
  ownsKey(key: string): boolean;
  set(key: string, value: unknown): Promise<void>;
  /** Removes the daemon's explicit value so the key reads as its default; absent keeps a reset as a write of the default. */
  reset?(key: string): Promise<void>;
  /** Whether the daemon can take a write now (no request); absent counts as reachable. */
  reachable?(): boolean;
}

export function applySettingValue({
  key,
  value,
  configManager,
  groups,
  onSettingApplied,
  refreshGroups,
  daemonConfig,
  onAsyncError,
  onAsyncSaved,
  reset,
}: {
  key: ConfigKey;
  value: unknown;
  configManager: ConfigManager;
  groups: Map<string, SettingEntry[]>;
  onSettingApplied: SettingAppliedCallback | null;
  /** Called after applying the value so the caller can re-read currentValues. */
  refreshGroups: () => void;
  /** Present when a daemon is configured; absent keeps every write local. */
  daemonConfig?: DaemonOwnedConfigWriter | null | undefined;
  /** Renders a refused daemon write, so a failed save is never silent. */
  onAsyncError?: ((message: string) => void) | undefined;
  /** Renders a daemon write that was applied (the row now shows it). */
  onAsyncSaved?: ((message: string | null) => void) | undefined;
  /**
   * `value` is the key's schema default and the write is a reset: a schema key
   * is removed from the settings files (so it reads "default" again and follows
   * later default changes) instead of being persisted as an explicit value.
   * A daemon-owned key is also removed on the daemon when the writer can
   * reset; without that it keeps the write of the default.
   */
  reset?: boolean | undefined;
}): ApplyValueResult {
  refreshSettingsPolicyAvailability(groups, configManager);
  const unavailable = [...groups.values()].flat().find(entry => entry.setting.key === key && entry.metadataUnavailable);
  if (unavailable) {
    return { restartDomain: null, effectMessage: `Save failed: ${unavailable.metadataUnavailable}`, changed: false, failed: true };
  }
  // Defensive: a handful of TUI-local synthetic keys (see worktree-setup-config.ts)
  // live under a config section CONFIG_SCHEMA/DEFAULT_CONFIG has never populated
  // (e.g. 'worktree' as of the platform 1.6.1 repack), so configManager.get can throw
  // "Invalid config path" here even though the write attempt below is already
  // guarded. Without this, that read, which runs unconditionally, before the
  // write's own try/catch, would crash the whole settings modal on save instead
  // of surfacing the honest "Save failed" message the write path below produces.
  let previousValue: unknown;
  try {
    previousValue = configManager.getStored(key);
  } catch (e) {
    logger.error('SettingsModal: failed to read previous config value', { key, error: summarizeError(e) });
  }
  // REQUIRES_RESTART: platform's ConfigSetting has no requiresRestart field yet (see
  // goodvibes-platform HANDOFF-FROM-TUI-SESSION-20260611.md §Item 8). Until it does,
  // we detect restart-triggering keys by sub-key name heuristic below.
  const isRestartKey = ['host', 'port', 'hostMode', 'enabled'].includes(key.split('.')[1] ?? '');

  const syncEntries = (): void => {
    // Update every entry carrying this key: cross-listed rows (the network
    // combined view) and feature-unit headers that share one enablement key
    // (e.g. both compaction features read behavior.compactionStrategy).
    for (const entries of groups.values()) {
      for (const entry of entries) {
        if (entry.setting.key !== key) continue;
        // A settings row shows the stored setting; an owner-profile value is a consumer's fact, not this row's.
        entry.currentValue = configManager.getStored(key);
        entry.isDefault = deepEqual(entry.currentValue, entry.setting.default);
        refreshHostSettingEntry(entry, configManager);
      }
    }
  };

  const daemonOwned = daemonConfig?.ownsKey(key) === true;
  // permissions.mode keeps the write: setting it also clears the legacy auto-approve override, which reset() would leave on.
  const removable = reset === true && key !== 'permissions.mode' && configManager.getSchema().some((setting) => setting.key === key);
  if (daemonOwned && daemonConfig && daemonConfig.reachable?.() !== false) {
    // The daemon is the one writer: nothing is written here, and the row keeps
    // its value until the daemon answers.
    try {
      if (!removable) configManager.validateDynamic(key, value);
    } catch (e) {
      return { restartDomain: null, effectMessage: `Save failed: ${summarizeError(e)}`, changed: false, failed: true };
    }
    const removeOnDaemon = removable && daemonConfig.reset !== undefined;
    const applied = removable ? configManager.getSchema().find((setting) => setting.key === key)?.default : value;
    const settled = (removeOnDaemon ? daemonConfig.reset!(key) : daemonConfig.set(key, applied)).then(() => {
      configManager.adoptDaemonValue(key, applied);
      syncEntries();
      const effect = deepEqual(previousValue, applied) ? undefined : onSettingApplied?.({ key, previousValue, value: applied });
      refreshGroups();
      onAsyncSaved?.((effect ? effect.message : undefined) ?? 'Saved by the daemon.');
    }, (error: unknown) => {
      logger.error('SettingsModal: the daemon refused a daemon-owned config write', { key, error: summarizeError(error) });
      onAsyncError?.(`Not saved: the daemon refused that setting, and nothing was written: ${summarizeError(error)}`);
      throw error;
    });
    void settled.catch(() => {});
    return { restartDomain: null, effectMessage: 'Saving to the daemon…', changed: false, settled };
  }
  // No daemon reachable: its settings file is what it reads when it starts.
  const offline = daemonOwned ? { daemonNotRunning: true } : {};
  try {
    if (removable) {
      // reset() refuses a key locked by managed policy, exactly as a write is refused.
      configManager.reset(key, offline);
    } else {
      configManager.setDynamic(key, value, offline);
    }
  } catch (e) {
    logger.error('SettingsModal: failed to set config value', { key, error: summarizeError(e) });
    for (const entries of groups.values()) for (const entry of entries) refreshHostSettingEntry(entry, configManager);
    return {
      restartDomain: null,
      effectMessage: `Save failed: ${summarizeError(e)}`,
      changed: false,
      failed: true,
    };
  }

  syncEntries();

  // Determine restart domain
  let restartDomain: 'control-plane' | 'http-listener' | 'web' | null = null;
  if (previousValue !== value && isRestartKey) {
    const rawCat = key.split('.')[0] as string;
    if (rawCat === 'controlPlane') restartDomain = 'control-plane';
    else if (rawCat === 'httpListener') restartDomain = 'http-listener';
    else if (rawCat === 'web') restartDomain = 'web';
  }

  // Fire change callback
  let effectMessage: string | null = null;
  if (previousValue !== value && onSettingApplied) {
    const result = onSettingApplied({ key, previousValue, value });
    effectMessage = result?.message ?? null;
    refreshGroups();
  }

  return { restartDomain, effectMessage, changed: previousValue !== value };
}

/** Host UI writes use the validated boolean handle, never a generic consumer key cast. */
export function applyHostSettingValue({ key, value, configManager, groups, onSettingApplied }: {
  key: string;
  value: unknown;
  configManager: ConfigManager;
  groups: Map<string, SettingEntry[]>;
  onSettingApplied: SettingAppliedCallback | null;
}): ApplyValueResult {
  const refresh = () => {
    for (const entries of groups.values()) for (const entry of entries) {
      if (entry.setting.key === key) refreshHostSettingEntry(entry, configManager);
    }
  };
  try {
    const handle = configManager.getHostBooleanSetting(key);
    if (typeof value !== 'boolean') throw new Error('Host settings require a literal boolean.');
    // Check current metadata at action time as well as at modal open. A stale
    // unlocked row must not permit a write through unavailable policy metadata.
    const before = handle.getResolved();
    if (before.managedLock) throw new Error(`Managed setting is locked: ${before.managedLock.source}: ${before.managedLock.reason}`);
    handle.set(value);
    const currentValue = handle.get();
    refresh();
    const changed = before.value !== currentValue;
    const result = changed ? onSettingApplied?.({ key, previousValue: before.value, value: currentValue }) : undefined;
    return { restartDomain: null, effectMessage: result?.message ?? null, changed };
  } catch (error) {
    refresh();
    return { restartDomain: null, effectMessage: `Save failed: ${summarizeError(error)}`, changed: false, failed: true };
  }
}

/**
 * Refresh a FlagEntry's live/persisted/pending fields from the manager's
 * authoritative snapshot so the settings UI never displays a guessed state.
 */
export function syncFlagEntryFromManager(
  flagEntry: FlagEntry,
  featureFlagManager: FeatureFlagManager,
): void {
  const snapshot = featureFlagManager.getAll().get(flagEntry.flag.id);
  if (!snapshot) return;
  flagEntry.state = snapshot.state;
  flagEntry.persistedState = snapshot.persistedState;
  flagEntry.pendingRestart = snapshot.pendingRestart;
}
