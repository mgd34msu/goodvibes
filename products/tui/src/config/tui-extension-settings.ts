/**
 * TUI settings the TUI reads from settings.json.
 *
 * `update.autoUpdateAtLaunch` and `update.launchCheckTimeoutMs` are platform
 * schema settings: the loader validates them and `get()` returns the value in
 * effect. The rest are not yet known to the loader (`statusline.*`,
 * `session.autoTitle`, `checkpoints.*`, `update.applyTimeoutMs`): the loader
 * keeps unknown keys in the file and in `getRaw()`, so they are read from there.
 *
 * Each raw reader validates its fields and returns a PARTIAL object holding
 * only the keys set to a well-typed value. A missing or malformed block yields
 * an empty object rather than throwing, so a bad edit degrades to "use the
 * built-in defaults", never a crash; the defaults stay with their consumer.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

type RawRecord = Record<string, unknown>;

function readNamespace(configManager: Pick<ConfigManager, 'getRaw'>, namespace: string): RawRecord | null {
  const block = (configManager.getRaw() as RawRecord)[namespace];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  return block as RawRecord;
}

function readBoolean(src: RawRecord, key: string): boolean | undefined {
  const value = src[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInt(src: RawRecord, key: string): number | undefined {
  const value = src[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function readNonEmptyString(src: RawRecord, key: string): string | undefined {
  const value = src[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ─── statusline.*, scriptable status line ───────────────────────────────────

/**
 * User-settable scriptable status line. When `command` is present it is run as
 * a POSIX shell command at each turn boundary and its first stdout line renders
 * in the status area. `timeoutMs` bounds each run.
 */
export interface StatuslineSettings {
  /** Shell command whose first stdout line renders in the status area. Absent/empty disables the feature. */
  readonly command?: string;
  /** Per-run timeout in milliseconds. Defaults to 2000; clamped to [100, 15000]. */
  readonly timeoutMs?: number;
}

export const STATUSLINE_DEFAULT_TIMEOUT_MS = 2000;
const STATUSLINE_MIN_TIMEOUT_MS = 100;
const STATUSLINE_MAX_TIMEOUT_MS = 15_000;

// ─── session.*, session behavior ────────────────────────────────────────────

/** User-settable session behavior. */
export interface SessionSettings {
  /**
   * Auto-title an untitled session using the configured tool/helper (weak/fast)
   * model after the first turn. Off by default because it costs a small model
   * call. Only ever sets a system-sourced title; a user-chosen title is left alone.
   */
  readonly autoTitle?: boolean;
}

/** Read `session.*` from settings.json. */
export function readSessionSettings(configManager: Pick<ConfigManager, 'getRaw'>): SessionSettings {
  const src = readNamespace(configManager, 'session');
  if (!src) return {};
  const out: { autoTitle?: boolean } = {};
  const autoTitle = readBoolean(src, 'autoTitle');
  if (autoTitle !== undefined) out.autoTitle = autoTitle;
  return out;
}

/** Read `statusline.*` from settings.json, validating and clamping the timeout. */
export function readStatuslineSettings(configManager: Pick<ConfigManager, 'getRaw'>): StatuslineSettings {
  const src = readNamespace(configManager, 'statusline');
  if (!src) return {};
  const out: { command?: string; timeoutMs?: number } = {};
  const command = readNonEmptyString(src, 'command');
  if (command !== undefined) out.command = command;
  const timeoutMs = readPositiveInt(src, 'timeoutMs');
  if (timeoutMs !== undefined) {
    out.timeoutMs = Math.min(STATUSLINE_MAX_TIMEOUT_MS, Math.max(STATUSLINE_MIN_TIMEOUT_MS, timeoutMs));
  }
  return out;
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
  /** How long the launch-time download+verify+swap may take before it is deferred to the next launch. Defaults to 45000; clamped to [5000, 300000]. */
  readonly applyTimeoutMs?: number;
}

const LAUNCH_APPLY_MIN_TIMEOUT_MS = 5_000;
const LAUNCH_APPLY_MAX_TIMEOUT_MS = 300_000;

/** The launch-update settings in effect: the two schema settings, plus `update.applyTimeoutMs` when set. */
export function readUpdateSettings(configManager: Pick<ConfigManager, 'get' | 'getRaw'>): UpdateSettings {
  const out: { autoUpdateAtLaunch?: boolean; launchCheckTimeoutMs?: number; applyTimeoutMs?: number } = {
    autoUpdateAtLaunch: configManager.get('update.autoUpdateAtLaunch'),
    launchCheckTimeoutMs: configManager.get('update.launchCheckTimeoutMs'),
  };
  const src = readNamespace(configManager, 'update');
  if (!src) return out;
  const applyTimeoutMs = readPositiveInt(src, 'applyTimeoutMs');
  if (applyTimeoutMs !== undefined) {
    out.applyTimeoutMs = Math.min(LAUNCH_APPLY_MAX_TIMEOUT_MS, Math.max(LAUNCH_APPLY_MIN_TIMEOUT_MS, applyTimeoutMs));
  }
  return out;
}

// ─── checkpoints.*, workspace checkpoint root-guard options ─────────────────

/**
 * User-settable root-guard options for the platform's WorkspaceCheckpointManager.
 * All optional: an omitted key defers to the manager's own default. Field
 * names and semantics mirror the platform's `WorkspaceCheckpointManagerOptions`.
 */
export interface CheckpointGuardSettings {
  /** Prefer the enclosing git repo's top level over the raw workspace root. platform default: true. */
  readonly preferGitRoot?: boolean;
  /** Opt in to snapshotting a broad root (filesystem root / home / ~/.goodvibes). platform default: false. */
  readonly allowBroadRoot?: boolean;
  /** Opt in to a first snapshot whose full sweep exceeds maxFirstSnapshotFiles. platform default: false. */
  readonly allowLargeFirstSnapshot?: boolean;
  /** Ceiling for the first-ever snapshot's file sweep. platform default: 50000. */
  readonly maxFirstSnapshotFiles?: number;
  /** Run a retention sweep automatically after each create() and once at init. platform default: true. */
  readonly autoRetention?: boolean;
}

/**
 * Merge the user's `checkpoints.*` root-guard settings onto a base
 * WorkspaceCheckpointManager options object.
 *
 * The platform's WorkspaceCheckpointManager declares and reads these options
 * (preferGitRoot, allowBroadRoot, allowLargeFirstSnapshot, maxFirstSnapshotFiles,
 * autoRetention), so they take effect as merged here. The return type intersects
 * the base with CheckpointGuardSettings so the extra keys flow through
 * structurally without an unsafe cast.
 */
export function withCheckpointGuardSettings<T extends object>(
  base: T,
  configManager: Pick<ConfigManager, 'getRaw'>,
): T & CheckpointGuardSettings {
  return { ...base, ...readCheckpointGuardSettings(configManager) };
}

/**
 * Read `checkpoints.*` from settings.json. Returns only the keys present and
 * well-typed; unknown or malformed values are dropped so the platform's own
 * defaults apply for them.
 */
export function readCheckpointGuardSettings(configManager: Pick<ConfigManager, 'getRaw'>): CheckpointGuardSettings {
  const src = readNamespace(configManager, 'checkpoints');
  if (!src) return {};
  const out: {
    preferGitRoot?: boolean;
    allowBroadRoot?: boolean;
    allowLargeFirstSnapshot?: boolean;
    maxFirstSnapshotFiles?: number;
    autoRetention?: boolean;
  } = {};
  const preferGitRoot = readBoolean(src, 'preferGitRoot');
  if (preferGitRoot !== undefined) out.preferGitRoot = preferGitRoot;
  const allowBroadRoot = readBoolean(src, 'allowBroadRoot');
  if (allowBroadRoot !== undefined) out.allowBroadRoot = allowBroadRoot;
  const allowLargeFirstSnapshot = readBoolean(src, 'allowLargeFirstSnapshot');
  if (allowLargeFirstSnapshot !== undefined) out.allowLargeFirstSnapshot = allowLargeFirstSnapshot;
  const maxFirstSnapshotFiles = readPositiveInt(src, 'maxFirstSnapshotFiles');
  if (maxFirstSnapshotFiles !== undefined) out.maxFirstSnapshotFiles = maxFirstSnapshotFiles;
  const autoRetention = readBoolean(src, 'autoRetention');
  if (autoRetention !== undefined) out.autoRetention = autoRetention;
  return out;
}
