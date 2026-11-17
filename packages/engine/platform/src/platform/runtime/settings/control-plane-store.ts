import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../../utils/atomic-json-store.js';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../../config/manager.js';
import { CONFIG_SCHEMA } from '../../config/index.js';
import type { ConfigKey } from '../../config/index.js';
import { configKeyFacts, listProjectUnsettableConfigKeys } from '../../config/config-key-facts.js';
import { credentialValueRefusal } from '../../config/write-admission.js';
import { isSecretBearingConfigKey, isSecretReferenceValue } from '../../config/secret-bearing-config-keys.js';
import { ConfigError } from '../../types/errors.js';
import { withSyncFileLock } from '../../config/sync-file-lock.js';
import { defaultStore, getSettingsControlPath, migrateStore } from './host-setting-policy-read.js';
export { defaultStore } from './host-setting-policy-read.js';

export type SyncSurface = 'profiles' | 'managed' | 'settings-sync';
export type SyncDirection = 'export' | 'import' | 'apply' | 'pull' | 'push' | 'rollback';
export type SettingsSource = 'default' | 'local' | 'synced' | 'managed';

export interface SettingsSyncEvent {
  readonly surface: SyncSurface;
  readonly direction: SyncDirection;
  readonly path: string;
  readonly timestamp: number;
  readonly detail: string;
}

export interface ManagedSettingLock {
  readonly key: ConfigKey;
  readonly source: string;
  readonly reason: string;
  readonly updatedAt: number;
}

export interface SettingsLayerRecord {
  readonly key: ConfigKey;
  readonly value: unknown;
  readonly source: Exclude<SettingsSource, 'default' | 'local'>;
  readonly sourceLabel: string;
  readonly detail: string;
  readonly path?: string | undefined;
  readonly updatedAt: number;
  readonly locked?: boolean | undefined;
}

export interface SettingsConflictRecord {
  readonly key: ConfigKey;
  readonly localValue: unknown;
  readonly incomingValue: unknown;
  readonly source: Exclude<SettingsSource, 'default' | 'local'>;
  readonly path: string;
  readonly updatedAt: number;
}

export type SettingsConflictResolution = 'local' | 'synced';

export interface ManagedBundleChange {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly nextValue: unknown;
  readonly changed: boolean;
  readonly locked: boolean;
  readonly source: string;
  readonly reason: string;
}

export interface StagedManagedBundle {
  readonly id: string;
  readonly profileName: string;
  readonly path: string;
  readonly importedAt: number;
  readonly changeCount: number;
  readonly risk: 'low' | 'medium' | 'high' | 'unassessed';
  readonly changes: readonly ManagedBundleChange[];
  /** Bundle keys that are not settings this build manages (misspelled, removed, host-owned); they were not staged. */
  readonly ignoredKeys?: readonly string[] | undefined;
}

export interface ManagedRollbackRecord {
  readonly token: string;
  readonly profileName: string;
  readonly path: string;
  readonly appliedAt: number;
  /** Keys whose live value the apply changed; rollback writes `previousValues` back for these. */
  readonly restoredKeys: readonly ConfigKey[];
  readonly previousValues: Readonly<Partial<Record<ConfigKey, unknown>>>;
  /** Every key the apply locked, changed or not; rollback releases these. Absent in records written before it existed (then `restoredKeys`). */
  readonly appliedKeys?: readonly ConfigKey[] | undefined;
  /** Managed layers and locks the apply replaced, put back by rollback. */
  readonly replacedLayers?: ReadonlyArray<SettingsLayerRecord> | undefined;
  readonly replacedLocks?: ReadonlyArray<ManagedSettingLock> | undefined;
}

export interface SettingsControlPlaneStore {
  readonly version: 2;
  readonly events: ReadonlyArray<SettingsSyncEvent>;
  readonly managedLocks: ReadonlyArray<ManagedSettingLock>;
  readonly failures: ReadonlyArray<{
    readonly surface: SyncSurface;
    readonly message: string;
    readonly timestamp: number;
  }>;
  readonly syncedSettings: ReadonlyArray<SettingsLayerRecord>;
  readonly managedSettings: ReadonlyArray<SettingsLayerRecord>;
  readonly conflicts: ReadonlyArray<SettingsConflictRecord>;
  readonly stagedManagedBundle?: StagedManagedBundle | undefined;
  readonly rollbackHistory: ReadonlyArray<ManagedRollbackRecord>;
}

export interface ResolvedSettingEntry {
  readonly key: ConfigKey;
  readonly category: string;
  readonly effectiveValue: unknown;
  readonly effectiveSource: SettingsSource;
  readonly defaultValue: unknown;
  readonly localValue: unknown;
  readonly syncedValue?: unknown | undefined;
  readonly managedValue?: unknown | undefined;
  readonly overriddenSources: readonly SettingsSource[];
  readonly locked: boolean;
  readonly lockReason?: string | undefined;
  readonly sourceLabel?: string | undefined;
  readonly updatedAt?: number | undefined;
  readonly conflict: boolean;
}

export interface SettingsControlPlaneSnapshot {
  readonly liveKeyCount: number;
  readonly profileCount: number;
  readonly managedLockCount: number;
  readonly resolvedCounts: Readonly<Record<SettingsSource, number>>;
  readonly lastSync?: SettingsSyncEvent | undefined;
  readonly recentEvents: ReadonlyArray<SettingsSyncEvent>;
  readonly recentFailures: SettingsControlPlaneStore['failures'];
  readonly managedLocks: ReadonlyArray<ManagedSettingLock>;
  readonly conflicts: ReadonlyArray<SettingsConflictRecord>;
  readonly stagedManagedBundle?: StagedManagedBundle | undefined;
  readonly rollbackHistory: ReadonlyArray<ManagedRollbackRecord>;
  readonly resolvedEntries: ReadonlyArray<ResolvedSettingEntry>;
}

export interface ResolvedSettingLookup {
  readonly entry: ResolvedSettingEntry;
  readonly lock?: ManagedSettingLock | undefined;
  readonly syncedLayer?: SettingsLayerRecord | undefined;
  readonly managedLayer?: SettingsLayerRecord | undefined;
}

export interface SettingsSyncBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly source: 'settings-sync';
  readonly settings: Record<string, unknown>;
}

export function getConfigControlPlaneDir(configManager: ConfigManager): string {
  return configManager.getControlPlaneConfigDir();
}

function readStoreFile(configDir: string): SettingsControlPlaneStore {
  return (
    readJsonFileOrQuarantine<SettingsControlPlaneStore>(getSettingsControlPath(configDir), {
      label: 'runtime/settings-control-plane',
      recovery: 'The settings control-plane history starts empty: recorded events and failures are gone, and every managed lock is released until the control plane reapplies it.',
      validate: (parsed) => migrateStore(parsed),
    }) ?? defaultStore()
  );
}

/** For read-only views: a store that cannot be read shows as empty. Never use it ahead of a write. */
export function readStore(configDir: string): SettingsControlPlaneStore {
  try {
    return readStoreFile(configDir);
  } catch {
    return defaultStore();
  }
}

/**
 * For read-modify-write. A missing file, or one that was corrupt and has been
 * quarantined, is an empty store. Any other read failure (permissions, the file
 * replaced mid-read) throws: writing back an empty store would erase every
 * managed lock in the real file.
 */
export function readStoreForWrite(configDir: string): SettingsControlPlaneStore {
  try {
    return readStoreFile(configDir);
  } catch (error) {
    throw new ConfigError(`The settings control-plane file ${getSettingsControlPath(configDir)} could not be read (${error instanceof Error ? error.message : String(error)}). Managed locks are not changed; fix the file's permissions or remove it, then retry.`);
  }
}

/**
 * Hold the cross-process lock on settings-sync.json across a synchronous
 * read-modify-write. The daemon and the terminal products share this file; without
 * it each reads the old store and the later write drops the other's lock or event.
 */
export function withStoreLock<T>(configDir: string, operation: () => T): T {
  return withSyncFileLock(getSettingsControlPath(configDir), operation);
}

export function writeStore(store: SettingsControlPlaneStore, configDir: string): void {
  writeJsonFileAtomic(getSettingsControlPath(configDir), store);
}

export function trimStore(store: SettingsControlPlaneStore): SettingsControlPlaneStore {
  return {
    ...store,
    events: store.events.slice(-60),
    failures: store.failures.slice(-20),
    conflicts: store.conflicts.slice(-40),
    rollbackHistory: store.rollbackHistory.slice(-20),
  };
}

export function configSnapshot(configManager: ConfigManager): Record<ConfigKey, unknown> {
  const snapshot = {} as Record<ConfigKey, unknown>;
  for (const entry of CONFIG_SCHEMA) {
    snapshot[entry.key] = structuredClone(configManager.get(entry.key));
  }
  return snapshot;
}

/** What the control-plane file and its reviews keep for a credential setting's literal value. */
export const SECRET_LITERAL_PLACEHOLDER = '(credential set; value not recorded)';

/**
 * The value to record or show for `key`: a credential setting's literal (a
 * value kept from before settings held only references) becomes a placeholder
 * that says it is set; a `goodvibes://secrets/…` reference, an empty value and
 * every other setting are kept as they are.
 */
export function recordableSettingValue(key: string, value: unknown): unknown {
  return isCredentialLiteral(key, value) ? SECRET_LITERAL_PLACEHOLDER : structuredClone(value);
}

/** A credential setting holding a literal rather than a `goodvibes://secrets/…` reference. */
export function isCredentialLiteral(key: string, value: unknown): boolean {
  return isSecretBearingConfigKey(key) && typeof value === 'string' && value.trim() !== '' && !isSecretReferenceValue(value);
}

/**
 * Refuse a bundle that carries a credential literal before anything about it is
 * staged, shown or written; the refusal names the setting, never the value.
 */
export function assertNoCredentialLiterals(settings: Readonly<Record<string, unknown>>, bundleKind: string): void {
  for (const [key, value] of Object.entries(settings)) {
    const refusal = credentialValueRefusal(key, value);
    if (refusal) throw new ConfigError(`The ${bundleKind} carries a credential literal for ${key}; nothing was staged or written. ${refusal.reason} ${refusal.next}`);
  }
}

export function sourcePriority(source: SettingsSource): number {
  switch (source) {
    case 'managed': return 3;
    case 'synced': return 2;
    case 'local': return 1;
    case 'default': return 0;
  }
}

/** Settings that point work, data or a stored credential at a destination (config-key-facts.ts). */
let destinationKeys: ReadonlySet<string> | undefined;

/**
 * The risk shown for a staged managed bundle, decided from what the schema
 * declares about each changed setting; no value leaves the process. High: a
 * credential or card setting, or a change its key declares as loosening
 * security (the sandbox, permissions, a policy source). Medium: a setting the
 * program does not know, or one that points work, data or a stored credential
 * at a destination (a webhook, the judgment endpoint, a bridge URL). Low
 * otherwise, and for a bundle that changes nothing.
 */
export function readBundleRisk(changes: readonly ManagedBundleChange[]): Exclude<StagedManagedBundle['risk'], 'unassessed'> {
  destinationKeys ??= new Set(listProjectUnsettableConfigKeys());
  let risk: 'low' | 'medium' = 'low';
  for (const change of changes) {
    if (!change.changed) continue;
    const facts = configKeyFacts(change.key);
    if (facts.secret || facts.cardMaterial || facts.loosens?.(change.previousValue, change.nextValue)) return 'high';
    if (!facts.inSchema || destinationKeys.has(change.key)) risk = 'medium';
  }
  return risk;
}

export function makeRollbackToken(): string {
  return `managed-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function toLayerRecord(
  key: ConfigKey,
  value: unknown,
  source: Exclude<SettingsSource, 'default' | 'local'>,
  sourceLabel: string,
  detail: string,
  path?: string,
  locked?: boolean,
): SettingsLayerRecord {
  return {
    key,
    value: structuredClone(value),
    source,
    sourceLabel,
    detail,
    ...(path ? { path } : {}),
    updatedAt: Date.now(),
    ...(locked ? { locked: true } : {}),
  };
}
