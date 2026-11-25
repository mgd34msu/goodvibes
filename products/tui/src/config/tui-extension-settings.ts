/**
 * TUI settings the TUI reads from settings.json, all through `get()`.
 *
 * `update.autoUpdateAtLaunch`, `update.launchCheckTimeoutMs`,
 * `update.applyTimeoutMs` and `checkpoints.*` are platform schema settings
 * (the Agent reads the same ones). `statusline.*`, `session.autoTitle`, the
 * notification and alert settings under `behavior.*` and
 * `storage.codeIndexEnabled` are the TUI's own settings, declared once in the
 * platform (runtime/program-host-settings.ts) so the daemon and the Agent's
 * settings screen know them too, and registered on this app's config manager
 * (config/host-settings.ts). Either way the loader knows the key, a value of
 * the wrong type or out of range is reported at start and the default
 * applies, and Settings lists it.
 */

import type { ConfigKey, ConfigManager, HostBooleanSetting, HostNumberSetting, HostSetting, HostStringSetting } from '@goodvibes/engine/platform/platform/config';
import {
  SESSION_AUTO_TITLE_SETTING,
  STATUSLINE_COMMAND_SETTING,
  STATUSLINE_TIMEOUT_SETTING,
} from '@goodvibes/engine/platform/platform/runtime/program-host-settings';

export {
  CODE_INDEX_ENABLED_SETTING,
  NOTIFY_AFTER_SECONDS_SETTING,
  NOTIFY_ON_AGENT_FAILURE_SETTING,
  NOTIFY_ON_APPROVAL_PENDING_SETTING,
  NOTIFY_ON_BUDGET_BREACH_SETTING,
  NOTIFY_ON_CHAIN_FAILURE_SETTING,
  NOTIFY_ONLY_WHEN_UNFOCUSED_SETTING,
  SESSION_AUTO_TITLE_SETTING,
  STATUSLINE_COMMAND_SETTING,
  STATUSLINE_DEFAULT_TIMEOUT_MS,
  STATUSLINE_TIMEOUT_SETTING,
  TERMINAL_BELL_SETTING,
  TERMINAL_NOTIFY_AGENT_BLOCKED_SETTING,
  TERMINAL_NOTIFY_APPROVAL_WAIT_SETTING,
  TERMINAL_NOTIFY_TURN_END_SETTING,
  TUI_EXTENSION_SETTINGS,
} from '@goodvibes/engine/platform/platform/runtime/program-host-settings';

type SettingsReader = Pick<ConfigManager, 'get'>;

function readHostSetting(configManager: SettingsReader, setting: HostBooleanSetting): boolean;
function readHostSetting(configManager: SettingsReader, setting: HostNumberSetting): number;
function readHostSetting(configManager: SettingsReader, setting: HostStringSetting): string;
function readHostSetting(configManager: SettingsReader, setting: HostSetting): boolean | number | string {
  // The manager resolves a registered key to an accepted value or its default.
  const value: unknown = configManager.get(setting.key as ConfigKey);
  return typeof value === typeof setting.default ? value as boolean | number | string : setting.default;
}

// ─── statusline.*, scriptable status line ───────────────────────────────────

/**
 * Scriptable status line. When `command` is set it is run as a POSIX shell
 * command at each turn boundary and its first stdout line renders in the
 * status area; `timeoutMs` bounds each run.
 */
export interface StatuslineSettings {
  /** Shell command whose first stdout line renders in the status area. Absent disables the feature. */
  readonly command?: string;
  /** Per-run timeout in milliseconds; STATUSLINE_DEFAULT_TIMEOUT_MS when absent. */
  readonly timeoutMs?: number;
}

/** The status line settings in effect; a blank command means off. */
export function readStatuslineSettings(configManager: SettingsReader): StatuslineSettings {
  const command = readHostSetting(configManager, STATUSLINE_COMMAND_SETTING).trim();
  const timeoutMs = readHostSetting(configManager, STATUSLINE_TIMEOUT_SETTING);
  return command ? { command, timeoutMs } : { timeoutMs };
}

// ─── session.*, session behavior ────────────────────────────────────────────

/** Session behavior. */
export interface SessionSettings {
  /**
   * Auto-title an untitled session using the configured tool/helper (weak/fast)
   * model after the first turn. Off by default because it costs a small model
   * call. Only ever sets a system-sourced title; a user-chosen title is left alone.
   */
  readonly autoTitle: boolean;
}

export function readSessionSettings(configManager: SettingsReader): SessionSettings {
  return { autoTitle: readHostSetting(configManager, SESSION_AUTO_TITLE_SETTING) };
}

// ─── update.*, launch-time self-update behavior ─────────────────────────────

/**
 * Launch-time self-update behavior. The feature itself (check at launch,
 * install via the checksum-verified download/verify/swap path, restart onto the
 * new binary) defaults ON for binary installs.
 */
export interface UpdateSettings {
  /** Check for a newer release at TUI launch and install it before starting (`update.autoUpdateAtLaunch`, default true). */
  readonly autoUpdateAtLaunch?: boolean;
  /** How long the launch-time version check may take before it is skipped (`update.launchCheckTimeoutMs`, default 2500, 250 to 30000). */
  readonly launchCheckTimeoutMs?: number;
  /** How long the launch waits for its download+verify+swap before starting the installed version; the update keeps running in the background (`update.applyTimeoutMs`, default 45000, 5000 to 300000). */
  readonly applyTimeoutMs?: number;
}

/** The launch-update settings in effect. */
export function readUpdateSettings(configManager: SettingsReader): UpdateSettings {
  return {
    autoUpdateAtLaunch: configManager.get('update.autoUpdateAtLaunch'),
    launchCheckTimeoutMs: configManager.get('update.launchCheckTimeoutMs'),
    applyTimeoutMs: configManager.get('update.applyTimeoutMs'),
  };
}

// The spending alert's amount is the daemon's setting `behavior.budgetAlertUsd` (platform schema), set in Money, Spending.

// ─── checkpoints.*, workspace checkpoint root-guard options ─────────────────

/** The platform checkpoint manager's root-guard options, as the `checkpoints.*` settings hold them. */
export interface CheckpointGuardSettings {
  readonly preferGitRoot: boolean;
  readonly allowBroadRoot: boolean;
  readonly allowLargeFirstSnapshot: boolean;
  readonly maxFirstSnapshotFiles: number;
  readonly autoRetention: boolean;
}

/** Merge the `checkpoints.*` settings onto a base WorkspaceCheckpointManager options object. */
export function withCheckpointGuardSettings<T extends object>(
  base: T,
  configManager: SettingsReader,
): T & CheckpointGuardSettings {
  return { ...base, ...readCheckpointGuardSettings(configManager) };
}

/** The `checkpoints.*` settings in effect (unset keys hold the checkpoint manager's own defaults). */
export function readCheckpointGuardSettings(configManager: SettingsReader): CheckpointGuardSettings {
  return {
    preferGitRoot: configManager.get('checkpoints.preferGitRoot'),
    allowBroadRoot: configManager.get('checkpoints.allowBroadRoot'),
    allowLargeFirstSnapshot: configManager.get('checkpoints.allowLargeFirstSnapshot'),
    maxFirstSnapshotFiles: configManager.get('checkpoints.maxFirstSnapshotFiles'),
    autoRetention: configManager.get('checkpoints.autoRetention'),
  };
}
