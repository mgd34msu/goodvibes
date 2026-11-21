/**
 * TUI settings the TUI reads from settings.json, all through `get()`.
 *
 * `update.autoUpdateAtLaunch`, `update.launchCheckTimeoutMs`,
 * `update.applyTimeoutMs` and `checkpoints.*` are platform schema settings
 * (the Agent reads the same ones). `statusline.*`, `session.autoTitle`, the
 * notification and alert settings under `behavior.*` and
 * `storage.codeIndexEnabled` are the TUI's own settings,
 * registered on its config manager (config/host-settings.ts) from the
 * descriptors below. Either way the loader knows the key, a value of the wrong
 * type or out of range is reported at start and the default applies, and
 * Settings lists it.
 */

import type { ConfigKey, ConfigManager, HostBooleanSetting, HostNumberSetting, HostSetting, HostStringSetting } from '@goodvibes/engine/platform/platform/config';
import { BUDGET_ALERT_USD_CONFIG_KEY, BUDGET_ALERT_USD_DEFAULT } from '@goodvibes/engine/platform/platform/providers';
import { CODE_INDEX_ENABLED_CONFIG_KEY } from '@goodvibes/engine/platform/platform/runtime/operations';

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
  label: 'Command for your own status line',
  type: 'string',
  default: '',
  description: 'Shell command run at each turn boundary; the first line it prints shows in the status area. Empty turns the status line off. Read only from your own settings file: a project settings file cannot set it.',
});

export const STATUSLINE_DEFAULT_TIMEOUT_MS = 2000;

export const STATUSLINE_TIMEOUT_SETTING: HostNumberSetting = Object.freeze({
  key: 'statusline.timeoutMs',
  label: 'Longest the status line command may run (ms)',
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
  label: 'Name new sessions automatically',
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

// ─── behavior.*, notifications and alerts ───────────────────────────────────
//
// Each setting is declared once here: its type, default, range, label and
// description. The manager validates and defaults it, Settings lists it, and
// every reader takes `configManager.get(key)`, so a row and the notifier that
// acts on it always read the same value.

export const NOTIFY_AFTER_SECONDS_SETTING: HostNumberSetting = Object.freeze({
  key: 'behavior.notifyAfterSeconds',
  label: 'Notify when an answer takes longer than (seconds, 0 for off)',
  type: 'number',
  default: 60,
  integer: true,
  min: 0,
  max: 86_400,
  description: 'Seconds a turn must run before a push notification fires (0 = off). Delivers to desktop (notify-send/osascript) and configured ntfy/webhook URLs.',
});

export const BUDGET_ALERT_USD_SETTING: HostNumberSetting = Object.freeze({
  key: BUDGET_ALERT_USD_CONFIG_KEY,
  label: 'Session budget for alerts (USD, 0 for no budget)',
  type: 'number',
  default: BUDGET_ALERT_USD_DEFAULT,
  min: 0,
  description: 'Session cost-budget alert threshold in USD (0 = no budget configured). Also set with the Usage modal\'s "b" key or /usage alert <dollars>.',
});

function alertToggle(key: string, label: string, description: string, defaultOn: boolean): HostBooleanSetting {
  return Object.freeze({ key, label, type: 'boolean' as const, default: defaultOn, description });
}

export const NOTIFY_ON_BUDGET_BREACH_SETTING = alertToggle('behavior.notifyOnBudgetBreach', 'Alert when the session goes over budget',
  'Alert when session cost crosses the configured budget (set via the Usage modal\'s "b" key).', true);
export const NOTIFY_ON_AGENT_FAILURE_SETTING = alertToggle('behavior.notifyOnAgentFailure', 'Alert when a helper agent fails',
  'Alert when a delegated or background agent fails.', true);
export const NOTIFY_ON_CHAIN_FAILURE_SETTING = alertToggle('behavior.notifyOnChainFailure', 'Alert when a review chain fails',
  'Alert when a WRFC review chain fails.', true);
export const NOTIFY_ON_APPROVAL_PENDING_SETTING = alertToggle('behavior.notifyOnApprovalPending', 'Alert when something waits for your approval',
  'Alert when a tool call is waiting on your approval.', true);
export const NOTIFY_ONLY_WHEN_UNFOCUSED_SETTING = alertToggle('behavior.notifyOnlyWhenUnfocused', 'Alert only when the terminal is in the background',
  'Master gate for the four alerts above: fire only when the terminal window is unfocused, or when focus state was never observed (terminal does not report focus). Turn off to always fire regardless of focus.', true);

// In-terminal (OSC 9) notifications and the bell, each with its own default.
// They are focus-gated on their own (only for an unfocused or unknown
// terminal), independent of `notifyOnlyWhenUnfocused`.
export const TERMINAL_NOTIFY_APPROVAL_WAIT_SETTING = alertToggle('behavior.terminalNotifyApprovalWait', 'Notify from the terminal when something waits for approval',
  'Send an in-terminal (OSC 9) desktop notification when a tool call is waiting on your approval. Fires only when the terminal window is unfocused. Works over SSH/tmux where OS notifications do not.', true);
export const TERMINAL_NOTIFY_TURN_END_SETTING = alertToggle('behavior.terminalNotifyTurnEnd', 'Notify from the terminal when an answer finishes',
  'Send an in-terminal (OSC 9) desktop notification when a turn finishes. Off by default. Fires only when the terminal window is unfocused.', false);
export const TERMINAL_NOTIFY_AGENT_BLOCKED_SETTING = alertToggle('behavior.terminalNotifyAgentBlocked', 'Notify from the terminal when a helper agent needs you',
  'Send an in-terminal (OSC 9) desktop notification when a delegated agent blocks waiting for your input. Off by default. Fires only when the terminal window is unfocused.', false);
export const TERMINAL_BELL_SETTING = alertToggle('behavior.terminalBell', 'Ring the terminal bell with notifications',
  'Also ring the terminal bell alongside in-terminal notifications. Off by default.', false);

// ─── storage.*, the code index ──────────────────────────────────────────────

export const CODE_INDEX_ENABLED_SETTING: HostBooleanSetting = Object.freeze({
  key: CODE_INDEX_ENABLED_CONFIG_KEY,
  label: 'Keep the code index up to date',
  type: 'boolean',
  default: false,
  description: 'Keep the repo source-tree code index running: build it on startup, reindex files after edits, and (with the agent-passive-code-injection flag) inject code hits into coding turns. Bounded file/size scan; see /codebase status. Off by default: /codebase build indexes once, on demand, and the index is NOT kept current after edits.',
});

/** The TUI's own settings, registered on its config manager before the first load. */
export const TUI_EXTENSION_SETTINGS: readonly HostSetting[] = Object.freeze([
  STATUSLINE_COMMAND_SETTING,
  STATUSLINE_TIMEOUT_SETTING,
  SESSION_AUTO_TITLE_SETTING,
  NOTIFY_AFTER_SECONDS_SETTING,
  BUDGET_ALERT_USD_SETTING,
  NOTIFY_ON_BUDGET_BREACH_SETTING,
  NOTIFY_ON_AGENT_FAILURE_SETTING,
  NOTIFY_ON_CHAIN_FAILURE_SETTING,
  NOTIFY_ON_APPROVAL_PENDING_SETTING,
  NOTIFY_ONLY_WHEN_UNFOCUSED_SETTING,
  TERMINAL_NOTIFY_APPROVAL_WAIT_SETTING,
  TERMINAL_NOTIFY_TURN_END_SETTING,
  TERMINAL_NOTIFY_AGENT_BLOCKED_SETTING,
  TERMINAL_BELL_SETTING,
  CODE_INDEX_ENABLED_SETTING,
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
