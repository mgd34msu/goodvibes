import type { ConfigManager } from '../../config/manager.js';
import { join } from 'node:path';
import { CONFIG_SCHEMA } from '../../config/index.js';
import type { ConfigKey } from '../../config/index.js';
import { ProfileManager } from '../../profiles/manager.js';
import type { ManagedSettingsBundle } from '../sandbox/types.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { ConfigError } from '../../types/errors.js';
import {
  SECRET_LITERAL_PLACEHOLDER,
  assertNoCredentialLiterals,
  configSnapshot,
  isCredentialLiteral,
  defaultStore,
  recordableSettingValue,
  getConfigControlPlaneDir,
  readBundleRisk,
  makeRollbackToken,
  readStore,
  readStoreForWrite,
  sourcePriority,
  toLayerRecord,
  trimStore,
  withStoreLock,
  writeStore,
  type ManagedBundleChange,
  type ManagedRollbackRecord,
  type ManagedSettingLock,
  type ResolvedSettingEntry,
  type ResolvedSettingLookup,
  type SettingsConflictRecord,
  type SettingsConflictResolution,
  type SettingsControlPlaneSnapshot,
  type SettingsControlPlaneStore,
  type SettingsLayerRecord,
  type SettingsSource,
  type SettingsSyncBundle,
  type SettingsSyncEvent,
  type StagedManagedBundle,
  type SyncSurface,
} from './control-plane-store.js';

export type {
  ManagedBundleChange,
  ManagedRollbackRecord,
  ManagedSettingLock,
  ResolvedSettingEntry,
  ResolvedSettingLookup,
  SettingsConflictRecord,
  SettingsConflictResolution,
  SettingsControlPlaneSnapshot,
  SettingsLayerRecord,
  SettingsSource,
  SettingsSyncBundle,
  SettingsSyncEvent,
  StagedManagedBundle,
};

export function recordSettingsSyncEvent(event: SettingsSyncEvent, configDir: string): void {
  withStoreLock(configDir, () => {
    const store = readStoreForWrite(configDir);
    writeStore(trimStore({ ...store, events: [...store.events, event] }), configDir);
  });
}

export function recordSettingsSyncFailure(surface: SyncSurface, message: string, configDir: string): void {
  withStoreLock(configDir, () => {
    const store = readStoreForWrite(configDir);
    writeStore(trimStore({
      ...store,
      failures: [...store.failures, { surface, message, timestamp: Date.now() }],
    }), configDir);
  });
}

export function isManagedSettingLocked(key: ConfigKey, configDir: string): boolean {
  return readStore(configDir).managedLocks.some((entry) => entry.key === key);
}

/** Guards writes, so an unreadable store throws instead of reading as "no locks". */
export function getManagedSettingLock(key: ConfigKey, configDir: string): ManagedSettingLock | null {
  return readStoreForWrite(configDir).managedLocks.find((entry) => entry.key === key) ?? null;
}

export function setManagedSettingLock(key: ConfigKey, source: string, reason: string, configDir: string): void {
  withStoreLock(configDir, () => setManagedSettingLockLocked(key, source, reason, configDir));
}

function setManagedSettingLockLocked(key: ConfigKey, source: string, reason: string, configDir: string): void {
  const store = readStoreForWrite(configDir);
  const nextLocks = store.managedLocks.filter((entry) => entry.key !== key);
  nextLocks.push({ key, source, reason, updatedAt: Date.now() });
  const nextManaged = store.managedSettings.map((entry) => entry.key === key
    ? { ...entry, locked: true, sourceLabel: source, detail: reason, updatedAt: Date.now() }
    : entry);
  writeStore(trimStore({
    ...store,
    managedLocks: nextLocks.sort((a, b) => a.key.localeCompare(b.key)),
    managedSettings: nextManaged,
  }), configDir);
}

export function clearManagedSettingLock(key: ConfigKey, configDir: string): boolean {
  return withStoreLock(configDir, () => clearManagedSettingLockLocked(key, configDir));
}

function clearManagedSettingLockLocked(key: ConfigKey, configDir: string): boolean {
  const store = readStoreForWrite(configDir);
  const nextLocks = store.managedLocks.filter((entry) => entry.key !== key);
  if (nextLocks.length === store.managedLocks.length) return false;
  const nextManaged = store.managedSettings.map((entry) => entry.key === key
    ? { ...entry, locked: false }
    : entry);
  writeStore(trimStore({ ...store, managedLocks: nextLocks, managedSettings: nextManaged }), configDir);
  return true;
}

export function exportSettingsSyncBundle(configManager: ConfigManager): SettingsSyncBundle {
  return {
    version: 1,
    exportedAt: Date.now(),
    source: 'settings-sync',
    // A credential setting's literal (kept from before settings held only references) is not exported.
    settings: Object.fromEntries(Object.entries(configSnapshot(configManager))
      .filter(([key, value]) => !isCredentialLiteral(key, value))),
  };
}

export function applySettingsSyncBundle(
  configManager: ConfigManager,
  bundle: SettingsSyncBundle,
  path: string,
): { appliedCount: number; conflictCount: number; skippedLockedKeys?: readonly ConfigKey[] } {
  const configDir = getConfigControlPlaneDir(configManager);
  return withStoreLock(configDir, () => applySettingsSyncBundleLocked(configManager, bundle, path, configDir));
}

function applySettingsSyncBundleLocked(
  configManager: ConfigManager,
  bundle: SettingsSyncBundle,
  path: string,
  configDir: string,
): { appliedCount: number; conflictCount: number; skippedLockedKeys?: readonly ConfigKey[] } {
  assertNoCredentialLiterals(bundle.settings, 'settings-sync bundle');
  const before = configSnapshot(configManager);
  const store = readStoreForWrite(configDir);
  const nextSynced: SettingsLayerRecord[] = [...store.syncedSettings];
  const nextConflicts = store.conflicts.filter((entry) => entry.source !== 'synced');
  const lockedKeys = new Set(store.managedLocks.map((entry) => entry.key));
  const accepted: Array<{ key: ConfigKey; value: unknown }> = [];
  const skippedLockedKeys: ConfigKey[] = [];
  for (const [rawKey, nextValue] of Object.entries(bundle.settings)) {
    if (!CONFIG_SCHEMA.some((entry) => entry.key === rawKey)) continue;
    const key = rawKey as ConfigKey;
    // A managed lock outranks a pulled value; the managed layer is the effective one.
    if (lockedKeys.has(key)) { skippedLockedKeys.push(key); continue; }
    accepted.push({ key, value: nextValue });
  }
  // Refuse the whole bundle before the first write: setDynamic persists per key.
  for (const { key, value } of accepted) configManager.validateDynamic(key, value, { bypassManagedLock: true });
  let appliedCount = 0;
  let conflictCount = 0;
  const written: ConfigKey[] = [];
  try {
    for (const { key, value: nextValue } of accepted) {
      const previousValue = before[key]!;
      if (JSON.stringify(previousValue) !== JSON.stringify(nextValue)) {
        conflictCount++;
        nextConflicts.push({
          key,
          localValue: recordableSettingValue(key, previousValue),
          incomingValue: recordableSettingValue(key, nextValue),
          source: 'synced',
          path,
          updatedAt: Date.now(),
        });
      }
      configManager.setDynamic(key, nextValue, { bypassManagedLock: true });
      written.push(key);
      const filtered = nextSynced.filter((entry) => entry.key !== key);
      filtered.push(toLayerRecord(key, nextValue, 'synced', 'settings-sync', `Pulled from ${path}`, path, false));
      nextSynced.splice(0, nextSynced.length, ...filtered);
      appliedCount++;
    }
  } catch (error) {
    restoreWrittenSettings(configManager, written, before);
    throw error;
  }
  writeStore(trimStore(withoutStaleLayers(configManager, {
    ...store,
    syncedSettings: nextSynced.sort((a, b) => a.key.localeCompare(b.key)),
    conflicts: nextConflicts.sort((a, b) => a.key.localeCompare(b.key)),
    events: [...store.events, {
      surface: 'settings-sync',
      direction: 'pull',
      path,
      timestamp: Date.now(),
      detail: `${appliedCount} settings pulled${skippedLockedKeys.length > 0 ? `, ${skippedLockedKeys.length} skipped because managed locks own them: ${skippedLockedKeys.join(', ')}` : ''}`,
    }],
  })), configDir);
  return { appliedCount, conflictCount, ...(skippedLockedKeys.length > 0 ? { skippedLockedKeys } : {}) };
}

/** Put keys written by a bundle that then failed back to the values they had, so a failed apply leaves no half-applied state. */
function restoreWrittenSettings(configManager: ConfigManager, written: readonly ConfigKey[], before: Readonly<Record<ConfigKey, unknown>>): void {
  for (const key of written) {
    try {
      configManager.setDynamic(key, structuredClone(before[key]), { bypassManagedLock: true });
    } catch {
      // Best effort: the original error is the one reported.
    }
  }
}

export function resolveSettingsSyncConflict(
  configManager: ConfigManager,
  key: ConfigKey,
  resolution: SettingsConflictResolution,
): boolean {
  const configDir = getConfigControlPlaneDir(configManager);
  return withStoreLock(configDir, () => resolveSettingsSyncConflictLocked(configManager, key, resolution, configDir));
}

function resolveSettingsSyncConflictLocked(
  configManager: ConfigManager,
  key: ConfigKey,
  resolution: SettingsConflictResolution,
  configDir: string,
): boolean {
  const store = readStoreForWrite(configDir);
  const conflict = store.conflicts.find((entry) => entry.key === key && entry.source === 'synced');
  if (!conflict) return false;

  const nextConflicts = store.conflicts.filter((entry) => !(entry.key === key && entry.source === 'synced'));
  let nextSynced = store.syncedSettings.filter((entry) => entry.key !== key);

  if (resolution === 'local') {
    configManager.setDynamic(key, structuredClone(conflict.localValue), { bypassManagedLock: true });
  } else {
    configManager.setDynamic(key, structuredClone(conflict.incomingValue), { bypassManagedLock: true });
    nextSynced = [
      ...nextSynced,
      toLayerRecord(
        key,
        conflict.incomingValue,
        'synced',
        'settings-sync',
        `Resolved synced conflict from ${conflict.path}`,
        conflict.path,
        false,
      ),
    ].sort((a, b) => a.key.localeCompare(b.key));
  }

  writeStore(trimStore(withoutStaleLayers(configManager, {
    ...store,
    conflicts: nextConflicts.sort((a, b) => a.key.localeCompare(b.key)),
    syncedSettings: nextSynced,
    events: [...store.events, {
      surface: 'settings-sync',
      direction: 'apply',
      path: conflict.path,
      timestamp: Date.now(),
      detail: `Conflict resolved for ${key} using ${resolution} value`,
    }],
  })), configDir);
  return true;
}

/** Refuse anything that is not a version 1 managed settings bundle, naming what is wrong. */
function assertManagedBundleShape(bundle: unknown): asserts bundle is ManagedSettingsBundle {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('Not a managed settings bundle: expected a JSON object with version, profileName and settings.');
  }
  const candidate = bundle as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new Error(`Unsupported managed settings bundle version ${JSON.stringify(candidate.version)}: this build reads version 1. Re-export the bundle from a matching release.`);
  }
  if (typeof candidate.profileName !== 'string' || candidate.profileName.trim() === '') {
    throw new Error('Not a managed settings bundle: profileName must be a non-empty string.');
  }
  if (!candidate.settings || typeof candidate.settings !== 'object' || Array.isArray(candidate.settings)) {
    throw new Error('Not a managed settings bundle: settings must be an object of key/value pairs.');
  }
}

/** Build the stage for a bundle without persisting anything. */
async function buildManagedStage(
  configManager: ConfigManager,
  bundle: ManagedSettingsBundle,
  path: string,
): Promise<StagedManagedBundle> {
  assertManagedBundleShape(bundle);
  // A credential travels as a goodvibes://secrets/ reference; a literal is refused before it is staged, shown or rated.
  assertNoCredentialLiterals(bundle.settings, 'managed settings bundle');
  const current = configSnapshot(configManager);
  const changes: ManagedBundleChange[] = [];
  const ignoredKeys: string[] = [];
  for (const [rawKey, nextValue] of Object.entries(bundle.settings)) {
    const schema = CONFIG_SCHEMA.find((entry) => entry.key === rawKey);
    if (!schema) { ignoredKeys.push(rawKey); continue; }
    const key = rawKey as ConfigKey;
    const previousValue = current[key]!;
    changes.push({
      key,
      previousValue: recordableSettingValue(key, previousValue),
      nextValue: structuredClone(nextValue),
      changed: JSON.stringify(previousValue) !== JSON.stringify(nextValue),
      locked: true,
      source: `managed:${bundle.profileName}`,
      reason: `Managed bundle ${bundle.profileName}`,
    });
  }
  return {
    id: makeRollbackToken(),
    profileName: bundle.profileName,
    path,
    importedAt: Date.now(),
    changeCount: changes.filter((entry) => entry.changed).length,
    risk: readBundleRisk(changes),
    changes,
    ...(ignoredKeys.length > 0 ? { ignoredKeys } : {}),
  };
}

export async function stageManagedSettingsBundle(
  configManager: ConfigManager,
  bundle: ManagedSettingsBundle,
  path: string,
): Promise<StagedManagedBundle> {
  const stage = await buildManagedStage(configManager, bundle, path);
  const configDir = getConfigControlPlaneDir(configManager);
  withStoreLock(configDir, () => {
    const store = readStoreForWrite(configDir);
    writeStore(trimStore({
      ...store,
      stagedManagedBundle: stage,
      events: [...store.events, {
        surface: 'managed',
        direction: 'import',
        path,
        timestamp: Date.now(),
        detail: `${stage.changeCount} managed settings staged from ${stage.profileName}${stage.ignoredKeys ? `; ignored unknown keys: ${stage.ignoredKeys.join(', ')}` : ''}`,
      }],
    }), configDir);
  });
  return stage;
}

export async function applyStagedManagedBundle(
  configManager: ConfigManager,
  selectedKeys?: readonly ConfigKey[],
): Promise<{ rollbackToken: string; appliedCount: number; remainingCount: number }> {
  const configDir = getConfigControlPlaneDir(configManager);
  const selectedSet = selectedKeys && selectedKeys.length > 0
    ? new Set(selectedKeys)
    : null;
  return withStoreLock(configDir, () => applyStagedManagedBundleLocked(configManager, configDir, selectedSet));
}

function applyStagedManagedBundleLocked(
  configManager: ConfigManager,
  configDir: string,
  selectedSet: ReadonlySet<ConfigKey> | null,
): { rollbackToken: string; appliedCount: number; remainingCount: number } {
  // One read under the store lock: what is applied is exactly what is staged now.
  const store = readStoreForWrite(configDir);
  const stage = store.stagedManagedBundle;
  if (!stage) {
    throw new Error('No staged managed settings bundle is available.');
  }
  const stagedChanges = selectedSet
    ? stage.changes.filter((change) => selectedSet.has(change.key))
    : [...stage.changes];
  if (stagedChanges.length === 0) {
    throw new Error('No staged managed settings matched the requested keys.');
  }
  const remainingChanges = stage.changes.filter((change) => !stagedChanges.some((candidate) => candidate.key === change.key));
  const remainingRisk = remainingChanges.length > 0 ? readBundleRisk(remainingChanges) : undefined;
  const before = configSnapshot(configManager);
  // Refuse the whole apply before the first write: setDynamic persists per key.
  for (const change of stagedChanges) configManager.validateDynamic(change.key, change.nextValue, { bypassManagedLock: true });
  const previousValues: Partial<Record<ConfigKey, unknown>> = {};
  const appliedKeys = stagedChanges.map((change) => change.key);
  const replacedLayers = store.managedSettings.filter((entry) => appliedKeys.includes(entry.key));
  const replacedLocks = store.managedLocks.filter((entry) => appliedKeys.includes(entry.key));
  const nextManaged = store.managedSettings.filter((entry) => !appliedKeys.includes(entry.key));
  const nextLocks = store.managedLocks.filter((entry) => !appliedKeys.includes(entry.key));
  const restoredKeys: ConfigKey[] = [];
  const written: ConfigKey[] = [];
  const rollbackToken = makeRollbackToken();
  try {
    for (const change of stagedChanges) {
      // The value to roll back to is the one in effect now, not the one seen at staging.
      previousValues[change.key] = recordableSettingValue(change.key, before[change.key]);
      configManager.setDynamic(change.key, change.nextValue, { bypassManagedLock: true });
      written.push(change.key);
      nextManaged.push(toLayerRecord(
        change.key,
        change.nextValue,
        'managed',
        change.source,
        change.reason,
        stage.path,
        true,
      ));
      nextLocks.push({
        key: change.key,
        source: change.source,
        reason: change.reason,
        updatedAt: Date.now(),
      });
      if (JSON.stringify(before[change.key]) !== JSON.stringify(change.nextValue)) restoredKeys.push(change.key);
    }
  } catch (error) {
    restoreWrittenSettings(configManager, written, before);
    throw error;
  }
  const nextStage: StagedManagedBundle | undefined = remainingChanges.length > 0
    ? {
        ...stage,
        changeCount: remainingChanges.filter((entry) => entry.changed).length,
        risk: remainingRisk ?? 'unassessed',
        changes: remainingChanges,
      }
    : undefined;
  writeStore(trimStore(withoutStaleLayers(configManager, {
    ...store,
    managedSettings: nextManaged.sort((a, b) => a.key.localeCompare(b.key)),
    managedLocks: nextLocks.sort((a, b) => a.key.localeCompare(b.key)),
    stagedManagedBundle: nextStage,
    rollbackHistory: [
      ...store.rollbackHistory,
      {
        token: rollbackToken,
        profileName: stage.profileName,
        path: stage.path,
        appliedAt: Date.now(),
        restoredKeys,
        previousValues,
        appliedKeys,
        ...(replacedLayers.length > 0 ? { replacedLayers } : {}),
        ...(replacedLocks.length > 0 ? { replacedLocks } : {}),
      },
    ],
    events: [...store.events, {
      surface: 'managed',
      direction: 'apply',
      path: stage.path,
      timestamp: Date.now(),
      detail: `${restoredKeys.length} managed settings applied from ${stage.profileName}${remainingChanges.length > 0 ? ` (${remainingChanges.length} still staged)` : ''}`,
    }],
  })), configDir);
  return { rollbackToken, appliedCount: restoredKeys.length, remainingCount: remainingChanges.length };
}

/**
 * Roll back one managed apply; answers how many settings were restored. A
 * credential that held plain text before the apply was never recorded, so it
 * keeps the managed value: after everything else is rolled back and saved,
 * the call throws naming those settings and what to do.
 */
export function rollbackManagedApply(configManager: ConfigManager, token: string): number {
  const configDir = getConfigControlPlaneDir(configManager);
  return withStoreLock(configDir, () => rollbackManagedApplyLocked(configManager, token, configDir));
}

function rollbackManagedApplyLocked(configManager: ConfigManager, token: string, configDir: string): number {
  const store = readStoreForWrite(configDir);
  const record = store.rollbackHistory.find((entry) => entry.token === token);
  if (!record) throw new Error(`Unknown managed rollback token: ${token}. A token works once; rolled-back tokens are removed from the history (see /managed rollback-history).`);
  const releasedKeys = record.appliedKeys ?? record.restoredKeys;
  // A later apply recorded this record's layers and values as what it replaced; rolling this one back first
  // would let the later rollback re-install them. Roll back newest first.
  const laterOverlap = store.rollbackHistory
    .slice(store.rollbackHistory.indexOf(record) + 1)
    .find((entry) => (entry.appliedKeys ?? entry.restoredKeys).some((key) => releasedKeys.includes(key)));
  if (laterOverlap) {
    throw new Error(`Managed rollback ${token} was not performed: the later apply ${laterOverlap.token} changed some of the same settings. Roll back ${laterOverlap.token} first, then ${token}.`);
  }
  let restored = 0;
  const nextManaged = [
    ...store.managedSettings.filter((entry) => !releasedKeys.includes(entry.key)),
    ...(record.replacedLayers ?? []),
  ].sort((a, b) => a.key.localeCompare(b.key));
  const nextLocks = [
    ...store.managedLocks.filter((entry) => !releasedKeys.includes(entry.key)),
    ...(record.replacedLocks ?? []),
  ].sort((a, b) => a.key.localeCompare(b.key));
  const notRestorable: ConfigKey[] = [];
  for (const key of record.restoredKeys) {
    const previousValue = record.previousValues[key]!;
    if (isSecretBearingConfigKey(key) && previousValue === SECRET_LITERAL_PLACEHOLDER) {
      notRestorable.push(key);
      continue;
    }
    if (previousValue !== undefined) {
      configManager.setDynamic(key, structuredClone(previousValue), { bypassManagedLock: true });
      restored++;
      continue;
    }
    const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
    if (!schema) continue;
    configManager.setDynamic(key, structuredClone(schema.default), { bypassManagedLock: true });
    restored++;
  }
  writeStore(trimStore(withoutStaleLayers(configManager, {
    ...store,
    managedSettings: nextManaged,
    managedLocks: nextLocks,
    rollbackHistory: store.rollbackHistory.filter((entry) => entry.token !== token),
    events: [...store.events, {
      surface: 'managed',
      direction: 'rollback',
      path: record.path,
      timestamp: Date.now(),
      detail: `${restored} managed settings rolled back from ${record.profileName}${notRestorable.length > 0 ? `; ${notRestorable.join(', ')} kept the managed value (the earlier plain-text credential was not recorded)` : ''}`,
    }],
  })), configDir);
  if (notRestorable.length > 0) {
    throw new ConfigError(`Managed rollback ${token} restored ${restored} setting(s), but ${notRestorable.join(', ')} kept the value the apply set: before the apply ${notRestorable.length > 1 ? 'they' : 'it'} held a plain-text credential, which is never recorded. Set ${notRestorable.length > 1 ? 'each' : 'it'} to a goodvibes://secrets/ reference to change it.`);
  }
  return restored;
}

/** The value the setting has now: the config is the one store of it. */
function liveSettingValue(configManager: ConfigManager, key: ConfigKey): unknown {
  return configManager.get(key);
}

/** A pulled or managed layer is in effect only while the live setting still holds the value it applied. */
function layerIsCurrent(configManager: ConfigManager, layer: SettingsLayerRecord): boolean {
  return JSON.stringify(liveSettingValue(configManager, layer.key)) === JSON.stringify(layer.value);
}

/**
 * The store without layers the owner has since changed by hand, and without
 * the conflicts of those layers: the layer keeps provenance only while its
 * value is the one in effect. A locked managed layer stays (the lock keeps
 * the value). Applied on each write that has the live config in hand.
 */
function withoutStaleLayers(configManager: ConfigManager, store: SettingsControlPlaneStore): SettingsControlPlaneStore {
  const syncedSettings = store.syncedSettings.filter((layer) => layerIsCurrent(configManager, layer));
  const managedSettings = store.managedSettings.filter((layer) => layer.locked === true || layerIsCurrent(configManager, layer));
  const current = {
    synced: new Set(syncedSettings.map((layer) => layer.key)),
    managed: new Set(managedSettings.map((layer) => layer.key)),
  };
  const conflicts = store.conflicts.filter((conflict) => current[conflict.source].has(conflict.key));
  return { ...store, syncedSettings, managedSettings, conflicts };
}

function buildResolvedEntries(configManager: ConfigManager, store: SettingsControlPlaneStore, key?: ConfigKey): ResolvedSettingEntry[] {
  const schema = configManager.getSchema();
  return (key === undefined ? schema : schema.filter(setting => setting.key === key)).map((setting) => {
    const localValue = structuredClone(liveSettingValue(configManager, setting.key));
    const syncedEntry = store.syncedSettings.find((entry) => entry.key === setting.key);
    const managedEntry = store.managedSettings.find((entry) => entry.key === setting.key);
    const overriddenSources: SettingsSource[] = [];
    // The effective value is always the live one; a layer is named its source
    // only while the live value is still the one that layer applied.
    const effectiveValue: unknown = localValue;
    let effectiveSource: SettingsSource = 'default';
    let sourceLabel: string | undefined;
    let updatedAt: number | undefined;
    let lockReason: string | undefined;
    let layerSource: 'managed' | 'synced' | undefined;
    if (managedEntry && (managedEntry.locked === true || layerIsCurrent(configManager, managedEntry))) {
      layerSource = 'managed';
      effectiveSource = 'managed';
      overriddenSources.push('local');
      if (syncedEntry) overriddenSources.push('synced');
      sourceLabel = managedEntry.sourceLabel;
      updatedAt = managedEntry.updatedAt;
      lockReason = managedEntry.detail;
    } else if (syncedEntry && layerIsCurrent(configManager, syncedEntry)) {
      layerSource = 'synced';
      effectiveSource = 'synced';
      overriddenSources.push('local');
      sourceLabel = syncedEntry.sourceLabel;
      updatedAt = syncedEntry.updatedAt;
    } else if (JSON.stringify(localValue) !== JSON.stringify(setting.default)) {
      effectiveSource = 'local';
    }
    const locked = store.managedLocks.some((entry) => entry.key === setting.key);
    return {
      key: setting.key,
      category: setting.key.split('.')[0] ?? 'general',
      effectiveValue,
      effectiveSource,
      defaultValue: structuredClone(setting.default),
      localValue,
      syncedValue: syncedEntry?.value,
      managedValue: managedEntry?.value,
      overriddenSources: overriddenSources.sort((a, b) => sourcePriority(b) - sourcePriority(a)),
      locked,
      lockReason,
      sourceLabel,
      updatedAt,
      // A conflict stands only while the layer it was recorded against is in effect.
      conflict: layerSource !== undefined && store.conflicts.some((entry) => entry.key === setting.key && entry.source === layerSource),
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export function getSettingsControlPlaneSnapshot(configManager: ConfigManager): SettingsControlPlaneSnapshot {
  const store = readStore(getConfigControlPlaneDir(configManager));
  const hostKeys = new Set(configManager.getHostSettingsSchema?.().map(entry => entry.key) ?? []);
  const managedLocks = store.managedLocks.filter(entry => !hostKeys.has(entry.key));
  const resolvedEntries = buildResolvedEntries(configManager, store);
  const profileManager = new ProfileManager(join(configManager.getControlPlaneConfigDir(), 'profiles'));
  const resolvedCounts: Record<SettingsSource, number> = {
    default: 0,
    local: 0,
    synced: 0,
    managed: 0,
  };
  for (const entry of resolvedEntries) resolvedCounts[entry.effectiveSource]++;
  return {
    liveKeyCount: configManager.getSchema().length,
    profileCount: profileManager.list().length,
    managedLockCount: managedLocks.length,
    resolvedCounts,
    lastSync: store.events[store.events.length - 1],
    recentEvents: store.events.slice(-8).reverse(),
    recentFailures: store.failures.slice(-6).reverse(),
    managedLocks,
    conflicts: store.conflicts.slice(-10).reverse(),
    stagedManagedBundle: store.stagedManagedBundle,
    rollbackHistory: store.rollbackHistory.slice(-8).reverse(),
    resolvedEntries,
  };
}

/** One setting's resolution. Reads the control-plane file; a caller resolving many keys uses {@link readResolvedSettingLookups}. */
export function getResolvedSettingLookup(
  configManager: ConfigManager,
  key: ConfigKey,
): ResolvedSettingLookup | null {
  const store = readStore(getConfigControlPlaneDir(configManager));
  const entry = buildResolvedEntries(configManager, store, key)[0];
  return entry ? lookupFor(store, entry) : null;
}

/**
 * Every setting's resolution from one read of the control-plane file, for a
 * screen that shows them all (the settings modal); the per-key lookup reads
 * and parses the file once per key.
 */
export function readResolvedSettingLookups(configManager: ConfigManager): (key: ConfigKey) => ResolvedSettingLookup | null {
  const store = readStore(getConfigControlPlaneDir(configManager));
  const entries = new Map(buildResolvedEntries(configManager, store).map((entry) => [entry.key, entry] as const));
  return (key) => {
    const entry = entries.get(key);
    return entry ? lookupFor(store, entry) : null;
  };
}

function lookupFor(store: SettingsControlPlaneStore, entry: ResolvedSettingEntry): ResolvedSettingLookup {
  return {
    entry,
    lock: store.managedLocks.find((candidate) => candidate.key === entry.key),
    syncedLayer: store.syncedSettings.find((candidate) => candidate.key === entry.key),
    managedLayer: store.managedSettings.find((candidate) => candidate.key === entry.key),
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '(unset)';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatResolvedSettingReview(
  configManager: ConfigManager,
  key: ConfigKey,
): string {
  const lookup = getResolvedSettingLookup(configManager, key);
  if (!lookup) {
    return `Unknown config key: ${key}`;
  }
  const { entry, lock, syncedLayer, managedLayer } = lookup;
  const lines = [
    'Resolved Setting Review',
    `  key: ${entry.key}`,
    `  category: ${entry.category}`,
    `  effective source: ${entry.effectiveSource}`,
    `  effective value: ${formatValue(entry.effectiveValue)}`,
    `  default value: ${formatValue(entry.defaultValue)}`,
    `  local value: ${formatValue(entry.localValue)}`,
    `  synced value: ${formatValue(entry.syncedValue)}`,
    `  managed value: ${formatValue(entry.managedValue)}`,
    `  overridden: ${entry.overriddenSources.length > 0 ? entry.overriddenSources.join(', ') : 'none'}`,
    `  locked: ${entry.locked ? 'yes' : 'no'}`,
    `  conflict: ${entry.conflict ? 'yes' : 'no'}`,
  ];
  if (entry.sourceLabel) lines.push(`  source label: ${entry.sourceLabel}`);
  if (entry.lockReason) lines.push(`  lock reason: ${entry.lockReason}`);
  if (entry.updatedAt) lines.push(`  updated: ${new Date(entry.updatedAt).toISOString()}`);
  if (lock) {
    lines.push('  live lock:');
    lines.push(`    source: ${lock.source}`);
    lines.push(`    reason: ${lock.reason}`);
    lines.push(`    updated: ${new Date(lock.updatedAt).toISOString()}`);
  }
  if (syncedLayer) {
    lines.push('  synced layer:');
    lines.push(`    source: ${syncedLayer.sourceLabel}`);
    lines.push(`    detail: ${syncedLayer.detail}`);
    if (syncedLayer.path) lines.push(`    path: ${syncedLayer.path}`);
  }
  if (managedLayer) {
    lines.push('  managed layer:');
    lines.push(`    source: ${managedLayer.sourceLabel}`);
    lines.push(`    detail: ${managedLayer.detail}`);
    if (managedLayer.path) lines.push(`    path: ${managedLayer.path}`);
  }
  return lines.join('\n');
}

export function formatStagedManagedBundleReview(configManager: ConfigManager): string {
  const snapshot = getSettingsControlPlaneSnapshot(configManager);
  const stage = snapshot.stagedManagedBundle;
  if (!stage) return 'No staged managed settings bundle is available.';
  const lines = [
    'Staged Managed Bundle Review',
    `  profileName: ${stage.profileName}`,
    `  importedAt: ${new Date(stage.importedAt).toISOString()}`,
    `  risk: ${stage.risk}`,
    `  changeCount: ${stage.changeCount}/${stage.changes.length}`,
    `  path: ${stage.path}`,
  ];
  if (stage.ignoredKeys) lines.push(`  ignored unknown keys: ${stage.ignoredKeys.join(', ')}`);
  for (const change of stage.changes.slice(0, 20)) {
    lines.push(`  ${change.key}`);
    lines.push(`    changed: ${change.changed ? 'yes' : 'no'}`);
    lines.push(`    previous: ${formatValue(change.previousValue)}`);
    lines.push(`    next: ${formatValue(change.nextValue)}`);
    lines.push(`    lock: ${change.source}  ${change.reason}`);
  }
  if (stage.changes.length > 20) {
    lines.push(`  ... ${stage.changes.length - 20} more change(s)`);
  }
  return lines.join('\n');
}

export async function inspectManagedSettingsBundle(
  configManager: ConfigManager,
  bundle: ManagedSettingsBundle,
  path: string,
): Promise<string> {
  // Read-only: staging would replace whatever bundle is staged now.
  const stage = await buildManagedStage(configManager, bundle, path);
  const changePreview = stage.changes.slice(0, 8).map((change) =>
    `  ${change.key}  ${change.changed ? 'change' : 'same'}  source=${change.source}`);
  return [
    'Managed Settings Review (inspected only; nothing staged)',
    `  profileName: ${bundle.profileName}`,
    `  importedAt: ${new Date(stage.importedAt).toISOString()}`,
    `  changes: ${stage.changeCount}/${stage.changes.length}`,
    `  risk: ${stage.risk}`,
    ...changePreview,
    ...(stage.ignoredKeys ? [`  ignored unknown keys: ${stage.ignoredKeys.join(', ')}`] : []),
  ].join('\n');
}

export function inspectSettingsSyncBundle(bundle: SettingsSyncBundle): string {
  return [
    'Settings Sync Bundle',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  settings: ${Object.keys(bundle.settings).length}`,
  ].join('\n');
}

export function formatSettingsControlPlaneReview(configManager: ConfigManager): string[] {
  const snapshot = getSettingsControlPlaneSnapshot(configManager);
  const lines = [
    'Settings Sync Review',
    `  live keys: ${snapshot.liveKeyCount}`,
    `  saved profiles: ${snapshot.profileCount}`,
    `  managed locks: ${snapshot.managedLockCount}`,
    `  effective managed: ${snapshot.resolvedCounts.managed}`,
    `  effective synced: ${snapshot.resolvedCounts.synced}`,
    `  effective local: ${snapshot.resolvedCounts.local}`,
    `  defaulted: ${snapshot.resolvedCounts.default}`,
    `  last sync: ${snapshot.lastSync ? `${snapshot.lastSync.surface}/${snapshot.lastSync.direction} at ${new Date(snapshot.lastSync.timestamp).toISOString()}` : 'none'}`,
  ];
  if (snapshot.stagedManagedBundle) {
    lines.push(
      `  staged managed bundle: ${snapshot.stagedManagedBundle.profileName}`,
      `    changes=${snapshot.stagedManagedBundle.changeCount} risk=${snapshot.stagedManagedBundle.risk} path=${snapshot.stagedManagedBundle.path}`,
    );
  }
  if (snapshot.conflicts.length > 0) {
    lines.push('  conflicts:');
    for (const conflict of snapshot.conflicts.slice(0, 8)) {
      lines.push(`    ${conflict.key}  source=${conflict.source}  path=${conflict.path}`);
    }
  }
  if (snapshot.managedLocks.length > 0) {
    lines.push('  managed locks:');
    for (const lock of snapshot.managedLocks.slice(0, 10)) {
      lines.push(`    ${lock.key}  source=${lock.source}  ${lock.reason}`);
    }
  }
  if (snapshot.recentFailures.length > 0) {
    lines.push('  recent failures:');
    for (const failure of snapshot.recentFailures) {
      lines.push(`    ${failure.surface}  ${failure.message}`);
    }
  }
  return lines;
}
