/** Internal policy-file mechanics shared by ordinary and read-only host readers. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../../types/errors.js';
import type { ManagedSettingLock, SettingsControlPlaneStore } from './control-plane-store.js';
import { PROGRAM_PROJECT_SETTINGS_ROOTS } from '../../config/project-settings-file.js';
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '../../config/goodvibes-home.js';
import { resolveSurfaceDirectory } from '../surface-root.js';

export function getSettingsControlPath(configDir: string): string {
  return join(configDir, 'settings-sync.json');
}

export function defaultStore(): SettingsControlPlaneStore {
  return {
    version: 2,
    events: [],
    managedLocks: [],
    failures: [],
    syncedSettings: [],
    managedSettings: [],
    conflicts: [],
    rollbackHistory: [],
  };
}

export function migrateStore(raw: unknown): SettingsControlPlaneStore {
  if (!raw || typeof raw !== 'object') return defaultStore();
  const store = raw as Partial<SettingsControlPlaneStore> & { version?: number };
  if (store.version === 2) {
    return {
      ...defaultStore(),
      ...store,
      events: Array.isArray(store.events) ? store.events : [],
      managedLocks: Array.isArray(store.managedLocks) ? store.managedLocks : [],
      failures: Array.isArray(store.failures) ? store.failures : [],
      syncedSettings: Array.isArray(store.syncedSettings) ? store.syncedSettings : [],
      managedSettings: Array.isArray(store.managedSettings) ? store.managedSettings : [],
      conflicts: Array.isArray(store.conflicts) ? store.conflicts : [],
      rollbackHistory: Array.isArray(store.rollbackHistory) ? store.rollbackHistory : [],
    };
  }
  return {
    ...defaultStore(),
    events: Array.isArray(store.events) ? store.events : [],
    managedLocks: Array.isArray(store.managedLocks) ? store.managedLocks : [],
    failures: Array.isArray(store.failures) ? store.failures : [],
  };
}

/** One managed lock as policy states it, without its key. */
export type ManagedSettingLockView = Readonly<Omit<ManagedSettingLock, 'key'>>;

/** Every managed lock of one policy read, by setting key. */
export type ManagedSettingLocks = ReadonlyMap<string, ManagedSettingLockView>;

const NO_LOCKS: ManagedSettingLocks = new Map();

/**
 * Every lock from one read and parse of the policy file, without quarantine,
 * repair, persistence, or silent unlock. A screen resolving several settings
 * reads once and looks each key up here.
 */
export function readStrictManagedSettingLocks(configDir: string): ManagedSettingLocks {
  let raw: string;
  try { raw = readFileSync(getSettingsControlPath(configDir), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NO_LOCKS;
    throw policyReadFailure();
  }
  return parseLocks(raw);
}

/** The locks of one policy file's text; throws the metadata refusal on anything it cannot read as locks. */
function parseLocks(raw: string): ManagedSettingLocks {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw policyReadFailure();
    const locks = (parsed as { managedLocks?: unknown }).managedLocks;
    // Legacy stores with no lock list migrate to an empty one. A present list
    // must be readable before metadata can claim either locked or unlocked.
    if (locks !== undefined && !Array.isArray(locks)) throw policyReadFailure();
    const store = migrateStore(parsed);
    const byKey = new Map<string, ManagedSettingLockView>();
    for (const lock of store.managedLocks) {
      if (!lock || typeof lock !== 'object' || typeof lock.key !== 'string'
        || typeof lock.source !== 'string' || typeof lock.reason !== 'string'
        || typeof lock.updatedAt !== 'number' || !Number.isFinite(lock.updatedAt)) throw policyReadFailure();
      // A copy kept only for a released 3.5.0 after a rollback (mirrorLocksForRelease): its lock is read where it was recorded.
      if (typeof (lock as { mirroredFrom?: unknown }).mirroredFrom === 'string') continue;
      // The first lock for a key is the one that applies, as a list search finds it.
      if (!byKey.has(lock.key)) byKey.set(lock.key, Object.freeze({ source: lock.source, reason: lock.reason, updatedAt: lock.updatedAt }));
    }
    return byKey;
  } catch { throw policyReadFailure(); }
}

/** One key's lock; reads the policy file. Several keys read once with {@link readStrictManagedSettingLocks}. */
export function readStrictManagedSettingLock(key: string, configDir: string): ManagedSettingLockView | null {
  return readStrictManagedSettingLocks(configDir).get(key) ?? null;
}

function policyReadFailure(): ConfigError {
  return new ConfigError('Setting metadata unavailable because managed policy could not be read.');
}

/**
 * A managed lock as it holds on this machine: who set it and why, the lock file it is kept in, and the value it holds
 * the setting at when a managed bundle put one there (`value` is absent for a lock that keeps whatever value is set).
 */
export interface ManagedLockHeld extends ManagedSettingLockView {
  readonly key: string;
  readonly file: string;
  readonly value?: unknown;
}

/**
 * THE reader of "is this key locked, and to what". A lock is kept in the `settings-sync.json` beside a settings file:
 * the daemon's own folder, its client-scoped folder, each program's folder (where that program's "Lock a setting" and
 * managed applies record it, and where a 3.5.0 program wrote it). A lock in any of them holds for the key at every store
 * (the daemon's settings, each program's own, the one project settings file, the shared file) and through every door, so
 * every write path asks this one function with the folders its settings manager names (`ConfigManager.managedLockFolders`).
 * The first folder that locks the key answers. A lock file that exists but cannot be read refuses (no write is let
 * through on a lock nobody can read): the refusal names the file.
 */
export function readManagedLocks(folders: readonly string[]): ReadonlyMap<string, ManagedLockHeld> {
  const held = new Map<string, ManagedLockHeld>();
  for (const folder of folders) {
    const file = getSettingsControlPath(folder);
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw unreadableLockFile(file);
    }
    let locks: ManagedSettingLocks;
    let values: Map<string, unknown>;
    try {
      locks = parseLocks(raw);
      values = new Map();
      const managed = (JSON.parse(raw) as { managedSettings?: unknown }).managedSettings;
      if (Array.isArray(managed)) {
        for (const entry of managed as { key?: unknown; value?: unknown; locked?: unknown }[]) {
          if (entry && typeof entry.key === 'string' && entry.locked === true && !values.has(entry.key)) values.set(entry.key, entry.value);
        }
      }
    } catch { throw unreadableLockFile(file); }
    for (const [key, lock] of locks) {
      if (held.has(key)) continue;
      held.set(key, Object.freeze({ key, ...lock, file, ...(values.has(key) ? { value: structuredClone(values.get(key)) } : {}) }));
    }
  }
  return held;
}

/**
 * The folders {@link readManagedLocks} reads, first one first: a settings manager's own folder (when it has one), the
 * daemon's own folder (beside its settings file), then each program's folder and the daemon's client-scoped folder
 * (`tui`, `agent`, `daemon-host` under the home's `.goodvibes`).
 */
export function managedLockFolders(input: { readonly ownFolder?: string | undefined; readonly homeDirectory: string | null; readonly daemonHomeDirectory: string | null }): readonly string[] {
  const folders: string[] = [];
  if (input.ownFolder) folders.push(input.ownFolder);
  if (input.daemonHomeDirectory) folders.push(input.daemonHomeDirectory);
  if (input.homeDirectory) for (const root of PROGRAM_PROJECT_SETTINGS_ROOTS) folders.push(resolveSurfaceDirectory(input.homeDirectory, root));
  return Object.freeze([...new Set(folders)]);
}

/**
 * The same folders for this process's home and daemon home (GOODVIBES_HOME, GOODVIBES_DAEMON_HOME; the daemon puts its
 * flags there at start), for a check made before anything is asked, where no settings manager is in hand.
 */
export function machineManagedLockFolders(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const homeDirectory = resolveGoodVibesHome(env);
  return managedLockFolders({ homeDirectory, daemonHomeDirectory: resolveGoodVibesDaemonHome(homeDirectory, env) });
}

/**
 * The one folder whose lock file a released 3.5.0 reads (its daemon and its terminal app read `~/.goodvibes/tui/`):
 * every lock that holds is also kept there (control-plane.ts mirrorLocksForRelease), so a rollback weakens nothing.
 */
export function releaseLockFolder(homeDirectory: string): string {
  return resolveSurfaceDirectory(homeDirectory, 'tui');
}

/** One key's lock from {@link readManagedLocks}, or null. */
export function readManagedLock(key: string, folders: readonly string[]): ManagedLockHeld | null {
  return readManagedLocks(folders).get(key) ?? null;
}

/**
 * The one sentence a write of a locked setting is refused with, at every store and door: the setting, who locked it
 * and why, the value it is held at when known, that nothing changed, and how the lock is removed (the owner's own act).
 * A credential's value is never named.
 */
export function managedLockRefusalText(lock: ManagedLockHeld, secretValue = false): string {
  const at = 'value' in lock && !secretValue ? `, at ${JSON.stringify(lock.value)}` : '';
  return `${lock.key} is locked as managed by ${lock.source} (${lock.reason})${at}, so it was not changed. `
    + `Only the owner removes the lock: Tools and extensions, Managed settings, unlock (it is kept in ${lock.file}).`;
}

function unreadableLockFile(file: string): ConfigError {
  return new ConfigError(`The managed locks in ${file} could not be read, so no setting is changed until they can be: fix the file's permissions or contents (the owner may remove it).`);
}

/** {@link readStrictManagedSettingLocks} with the host-metadata refusal. */
export function readHostManagedSettingLocks(configDir: string): ManagedSettingLocks {
  try { return readStrictManagedSettingLocks(configDir); }
  catch { throw new ConfigError('Host setting metadata unavailable because managed policy could not be read.'); }
}

/** One host key's lock; reads the policy file. */
export function readHostManagedSettingLock(key: string, configDir: string): ManagedSettingLockView | null {
  return readHostManagedSettingLocks(configDir).get(key) ?? null;
}
