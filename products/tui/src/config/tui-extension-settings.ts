/**
 * TUI settings the TUI reads from settings.json, all through `get()`.
 *
 * `update.autoUpdateAtLaunch`, `update.launchCheckTimeoutMs` and
 * `checkpoints.*` are platform schema settings. `statusline.*`,
 * `session.autoTitle` and `update.applyTimeoutMs` are the TUI's own settings,
 * registered on its config manager (config/host-settings.ts) from the
 * descriptors below. Either way the loader knows the key, a value of the wrong
 * type or out of range is reported at start and the default applies, and
 * Settings lists it.
 */

import type { ConfigKey, ConfigManager, HostBooleanSetting, HostNumberSetting, HostSetting, HostStringSetting } from '@goodvibes-jev/engine/platform/platform/config';

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

export const STATUSLINE_COMMAND_SETTING: HostStringSetting = Object.freeze({
  key: 'statusline.command',
  type: 'string',
  default: '',
  description: 'Shell command run at each turn boundary; the first line it prints shows in the status area. Empty turns the status line off. Read only from your own settings file: a project settings file cannot set it.',
});

export const STATUSLINE_DEFAULT_TIMEOUT_MS = 2000;

export const STATUSLINE_TIMEOUT_SETTING: HostNumberSetting = Object.freeze({
  key: 'statusline.timeoutMs',
  type: 'number',
  default: STATUSLINE_DEFAULT_TIMEOUT_MS,
  integer: true,
  min: 100,
  max: 15_000,
  description: 'Milliseconds the status line command may run before it is stopped and the status line is cleared.',
});

/**
 * Scriptable status line. When `command` is set it is run as a POSIX shell
 * command at each turn boundary and its first stdout line renders in the
 * status area; `timeoutMs` bounds each run.
 */
export interface StatuslineSettings {
  /** Shell command whose first stdout line renders in the status area. Absent disables the feature. */
  readonly command?: string;
  /** Per-run timeout in milliseconds; {@link STATUSLINE_DEFAULT_TIMEOUT_MS} when absent. */
  readonly timeoutMs?: number;
}

/** The status line settings in effect; a blank command means off. */
export function readStatuslineSettings(configManager: SettingsReader): StatuslineSettings {
  const command = readHostSetting(configManager, STATUSLINE_COMMAND_SETTING).trim();
  const timeoutMs = readHostSetting(configManager, STATUSLINE_TIMEOUT_SETTING);
  return command ? { command, timeoutMs } : { timeoutMs };
}

// ─── session.*, session behavior ────────────────────────────────────────────

export const SESSION_AUTO_TITLE_SETTING: HostBooleanSetting = Object.freeze({
  key: 'session.autoTitle',
  type: 'boolean',
  default: false,
  description: 'Give an untitled session a short title from the helper model after its first turn (one small model request per session). A title you chose is never replaced.',
});

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

export const UPDATE_APPLY_TIMEOUT_SETTING: HostNumberSetting = Object.freeze({
  key: 'update.applyTimeoutMs',
  type: 'number',
  default: 45_000,
  integer: true,
  min: 5_000,
  max: 300_000,
  description: 'Milliseconds the launch-time download, verification and swap of a new release may take; past it the update is left for the next launch.',
});

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
  /** How long the launch-time download+verify+swap may take before it is deferred to the next launch (`update.applyTimeoutMs`, default 45000, 5000 to 300000). */
  readonly applyTimeoutMs?: number;
}

/** The launch-update settings in effect. */
export function readUpdateSettings(configManager: SettingsReader): UpdateSettings {
  return {
    autoUpdateAtLaunch: configManager.get('update.autoUpdateAtLaunch'),
    launchCheckTimeoutMs: configManager.get('update.launchCheckTimeoutMs'),
    applyTimeoutMs: readHostSetting(configManager, UPDATE_APPLY_TIMEOUT_SETTING),
  };
}

/** The TUI's own settings, registered on its config manager before the first load. */
export const TUI_EXTENSION_SETTINGS: readonly HostSetting[] = Object.freeze([
  STATUSLINE_COMMAND_SETTING,
  STATUSLINE_TIMEOUT_SETTING,
  SESSION_AUTO_TITLE_SETTING,
  UPDATE_APPLY_TIMEOUT_SETTING,
]);

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
