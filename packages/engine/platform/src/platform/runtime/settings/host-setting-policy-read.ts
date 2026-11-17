/** Internal policy-file mechanics shared by ordinary and read-only host readers. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../../types/errors.js';
import type { ManagedSettingLock, SettingsControlPlaneStore } from './control-plane-store.js';

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

/** {@link readStrictManagedSettingLocks} with the host-metadata refusal. */
export function readHostManagedSettingLocks(configDir: string): ManagedSettingLocks {
  try { return readStrictManagedSettingLocks(configDir); }
  catch { throw new ConfigError('Host setting metadata unavailable because managed policy could not be read.'); }
}

/** One host key's lock; reads the policy file. */
export function readHostManagedSettingLock(key: string, configDir: string): ManagedSettingLockView | null {
  return readHostManagedSettingLocks(configDir).get(key) ?? null;
}
