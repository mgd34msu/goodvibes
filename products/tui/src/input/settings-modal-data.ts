export {buildMcpEntries} from '@goodvibes/engine/terminal-shell/settings-mcp-entries';
import { isValidConfigKey } from '@goodvibes/engine/platform/platform/config';
/**
 * settings-modal-data, pure data-assembly helpers for SettingsModal.
 *
 * All functions are stateless: they take dependencies as arguments and return
 * derived data without mutating state. The class in settings-modal.ts delegates
 * to these during open() and tab-switch operations.
 */

import { type ConfigKey } from '@goodvibes/engine/platform/platform/config';
import type { ConfigManager, ConfigSetting, HostManagedSettingLocks } from '@goodvibes/engine/platform/platform/config';
import { readResolvedSettingLookups } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';

import { buildSubscriptionEntries } from '@goodvibes/engine/terminal-shell/settings-subscriptions';
import type { SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes/engine/platform/platform/runtime/operations';
import {
  WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY,
  WORKTREE_SETUP_COMMANDS_CONFIG_KEY,
  buildWorktreeSetupCarryOverGlobsSyntheticEntry,
  buildWorktreeSetupCommandsSyntheticEntry,
  formatWorktreeSetupEditText,
  isWorktreeSetupListConfigKey,
  readWorktreeSetupSetting,
} from './worktree-setup-config.ts';
import { worktreeSetupSettingValue } from '@goodvibes/engine/platform/platform/runtime/shell';
import {
  injectSandboxExecSyntheticEntries,
  isSandboxExecListConfigKey,
  readSandboxExecList,
} from './sandbox-exec-config.ts';
import {
  injectExecEnvScrubSyntheticEntry,
  isExecEnvScrubAllowlistConfigKey,
  readExecEnvScrubAllowlist,
} from './exec-env-scrub-config.ts';
import { SETTINGS_CATEGORIES, type BuiltinSettingEntry, type FlagEntry, type HostSettingEntry, type SettingEntry, type SettingsCategory, type SubscriptionEntry } from './settings-modal-types.ts';
import { enrichRelaySettingDescriptions } from './relay-settings-descriptions.ts';
import { enrichDaemonOwnedSettingDescriptions } from './daemon-owned-settings-descriptions.ts';
import { applyFeatureUnitLayout } from './feature-unit-layout.ts';
import { FEATURE_SETTINGS_BY_ID } from '@goodvibes/engine/terminal-shell';
import {
  buildPaymentsCardsRow,
  PAYMENTS_CARDS_ROW_KEY,
} from './payments-config.ts';

/** Display order of the `ui` category; every key must be a real config key. */
export const UI_SETTING_PRIORITY: Readonly<Partial<Record<ConfigKey, number>>> = {
  'ui.systemMessages': 0,
  'ui.operationalMessages': 1,
  'ui.contractMessages': 2,
  'ui.voiceEnabled': 3,
};

// ---------------------------------------------------------------------------
// deepEqual, structural equality for isDefault comparisons
// ---------------------------------------------------------------------------

/**
 * Structural equality for setting-default comparisons: scalars, arrays, and
 * plain objects (config defaults are always JSON-safe; no circular refs).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// buildSettingGroups, loads the instance schema into per-category SettingEntry maps
// ---------------------------------------------------------------------------

const POLICY_METADATA_UNAVAILABLE = 'Managed policy metadata is unavailable. Editing is disabled until it can be read.';

/**
 * The managed locks of one policy read, or null when policy cannot be read.
 * One read per user action: every row refresh in that action takes this
 * instead of reading the policy file again.
 */
export type SettingsPolicyRead = HostManagedSettingLocks | null;

const NO_HOST_LOCKS: HostManagedSettingLocks = new Map();

export function readSettingsPolicy(configManager: ConfigManager): SettingsPolicyRead {
  // Without a host boolean row nothing shows lock metadata, so nothing is read.
  if (!configManager.getHostSettingsSchema().some((setting) => setting.type === 'boolean')) return NO_HOST_LOCKS;
  try { return configManager.readHostManagedSettingLocks(); }
  catch { return null; }
}

/** Refresh a host row exclusively through its validated public handle. */
export function refreshHostSettingEntry(
  entry: SettingEntry,
  configManager: ConfigManager,
  policy?: SettingsPolicyRead,
): void {
  if (entry.kind !== 'host') return;
  const locks = policy === undefined ? readSettingsPolicy(configManager) : policy;
  const handle = configManager.getHostBooleanSetting(entry.setting.key);
  entry.currentValue = handle.get();
  entry.isDefault = entry.currentValue === entry.setting.default;
  if (locks) {
    const resolved = handle.getResolved(locks);
    entry.currentValue = resolved.value;
    entry.isDefault = resolved.value === resolved.defaultValue;
    Object.assign(entry, {
      effectiveSource: resolved.source,
      locked: resolved.managedLock !== null,
      conflict: false,
      sourceLabel: undefined,
      lockReason: resolved.managedLock ? `${resolved.managedLock.source}: ${resolved.managedLock.reason}` : undefined,
      metadataUnavailable: undefined,
    });
  } else {
    // The platform deliberately withholds lock metadata when policy cannot be read.
    // Do not turn that absence into an unlocked/default provenance claim.
    Object.assign(entry, {
      effectiveSource: undefined,
      locked: undefined,
      conflict: undefined,
      sourceLabel: undefined,
      lockReason: undefined,
      metadataUnavailable: POLICY_METADATA_UNAVAILABLE,
    });
  }
}

/**
 * Best-effort UI preflight, not an atomic policy transaction or new authority:
 * the setter's own refusal decides a locked write. Host metadata reads are
 * pure; defer legacy builtin recovery until they work.
 */
export function refreshSettingsPolicyAvailability(
  groups: Map<string, SettingEntry[]>,
  configManager: ConfigManager,
  policy: SettingsPolicyRead = readSettingsPolicy(configManager),
): boolean {
  if (!configManager.getHostSettingsSchema().some((setting) => setting.type === 'boolean')) return true;
  const unavailable = policy === null;
  const entries = [...groups.values()].flat();
  for (const entry of entries) {
    if (entry.kind === 'host') refreshHostSettingEntry(entry, configManager, policy);
  }
  let lookup: ReturnType<typeof readResolvedSettingLookups> | undefined;
  for (const entry of entries) {
    if (unavailable) {
      Object.assign(entry, {
        effectiveSource: undefined, locked: undefined, conflict: undefined,
        sourceLabel: undefined, lockReason: undefined, metadataUnavailable: POLICY_METADATA_UNAVAILABLE,
      });
    } else if (entry.kind !== 'host' && entry.metadataUnavailable) {
      refreshBuiltinSettingValue(entry, configManager);
      lookup ??= readResolvedSettingLookups(configManager);
      const resolved = lookup(entry.setting.key)?.entry;
      Object.assign(entry, {
        effectiveSource: resolved?.effectiveSource, locked: resolved?.locked,
        conflict: resolved?.conflict, sourceLabel: resolved?.sourceLabel, lockReason: resolved?.lockReason,
        metadataUnavailable: undefined,
      });
    }
  }
  return !unavailable;
}

/** A host setting under a section of the TUI's own is listed in the category its section belongs to. */
const HOST_SECTION_CATEGORY: Readonly<Record<string, SettingsCategory>> = { statusline: 'ui', session: 'behavior' };

function hostSettingCategory(key: string): SettingsCategory {
  const root = key.split('.')[0] ?? '';
  return HOST_SECTION_CATEGORY[root] ?? root as SettingsCategory;
}

export function buildSettingGroups(
  configManager: ConfigManager,
  featureFlagManager?: FeatureFlagManager | null,
): Map<SettingsCategory, SettingEntry[]> {
  const groups = new Map<SettingsCategory, SettingEntry[]>();
  // Every category starts empty and is filled from the instance schema below; the
  // feature-unit layout pass then folds each capability's rows into one unit.
  for (const cat of SETTINGS_CATEGORIES) groups.set(cat, []);

  // Host descriptors are a separate readonly schema, not builtin ConfigKeys.
  const hostSchema = configManager.getHostSettingsSchema();
  const policy = readSettingsPolicy(configManager);
  const hostEntries = hostSchema.flatMap((setting): HostSettingEntry[] => {
    if (setting.type !== 'boolean') return [];
    const entry: HostSettingEntry = {
      kind: 'host', setting, currentValue: setting.default, isDefault: true,
    };
    refreshHostSettingEntry(entry, configManager, policy);
    return [entry];
  });
  const hostMetadataUnavailable = hostEntries.some(entry => entry.metadataUnavailable !== undefined);
  // A number or string host setting is edited like a schema row: the manager's
  // get, setDynamic and validation take a registered host key.
  const hostValueEntries = hostSchema.flatMap((setting): BuiltinSettingEntry[] => {
    if (setting.type === 'boolean') return [];
    const row: ConfigSetting = { key: setting.key as ConfigKey, label: setting.label, type: setting.type, default: setting.default, description: setting.description };
    const currentValue = configManager.get(row.key);
    return [{
      setting: row, currentValue, isDefault: deepEqual(currentValue, row.default),
      metadataUnavailable: hostMetadataUnavailable ? POLICY_METADATA_UNAVAILABLE : undefined,
    }];
  });

  // The legacy builtin governance reader can quarantine malformed policy.
  // Keep that recovery out of this read pass when pure host metadata is
  // unavailable; otherwise opening settings could erase the policy failure.
  // One read of the control-plane file for every row, not one per setting.
  const lookup = hostMetadataUnavailable ? undefined : readResolvedSettingLookups(configManager);
  for (const setting of configManager.getSchema()) {
    // These lists keep their own one-line list editor rows, added below.
    if (isSandboxExecListConfigKey(setting.key) || isWorktreeSetupListConfigKey(setting.key)) continue;
    const rawCat = setting.key.split('.')[0] as string;
    const cat = rawCat as SettingsCategory;
    // A settings row shows the stored setting; an owner-profile value is a consumer's fact, not this row's.
    const currentValue = configManager.get(setting.key as ConfigKey);
    const resolved = lookup?.(setting.key as ConfigKey)?.entry;
    // "Default" and "reset to" are this product's default, which a product may set over the schema's.
    const productDefault = configManager.defaultOf(setting.key);
    const row = deepEqual(productDefault, setting.default) ? setting : { ...setting, default: productDefault };
    const entry: SettingEntry = {
      setting: row,
      currentValue,
      isDefault: deepEqual(currentValue, productDefault),
      effectiveSource: resolved?.effectiveSource,
      locked: resolved?.locked,
      conflict: resolved?.conflict,
      sourceLabel: resolved?.sourceLabel,
      lockReason: resolved?.lockReason,
      metadataUnavailable: hostMetadataUnavailable ? POLICY_METADATA_UNAVAILABLE : undefined,
    };
    if (groups.has(cat)) groups.get(cat)!.push(entry);
    if ((rawCat === 'controlPlane' || rawCat === 'httpListener' || rawCat === 'web') && groups.has('network')) {
      groups.get('network')!.push(entry);
    }
    // fleet.maxSize (was orchestration.maxActiveAgents) surfaces under orchestration.
    if (rawCat === 'fleet' && groups.has('orchestration')) groups.get('orchestration')!.push(entry);
    // push.* configures the delivery side of the very notifications the
    // notifications.* keys already shape (pushApproval, pushNeedsInput,
    // pushCompletion), so the contact address and the subscription
    // housekeeping bounds belong in that same category rather than in one of
    // their own. Without this they match no category at all and would be
    // dropped from the workspace entirely, reachable only by editing the
    // config file by hand.
    if (rawCat === 'push' && groups.has('notifications')) groups.get('notifications')!.push(entry);
    // cluster.* decides which node on this network reads the inbox, and it is
    // configured in the same terms the network category already speaks: a
    // group address, a port, a shared phrase, a peer list. Given no category of
    // its own it would match nothing and drop out of the workspace entirely,
    // reachable only by hand-editing a settings file.
    if (rawCat === 'cluster' && groups.has('network')) groups.get('network')!.push(entry);
    // checkpoints.* bound what a workspace checkpoint may store, beside the other local-storage rows.
    if (rawCat === 'checkpoints' && groups.has('storage')) groups.get('storage')!.push(entry);
    // browser.network.pinned decides what the browser may reach, beside the fetch tool's host rules.
    if (rawCat === 'browser' && groups.has('fetch')) groups.get('fetch')!.push(entry);
  }

  for (const entry of [...hostEntries, ...hostValueEntries]) {
    groups.get(hostSettingCategory(entry.setting.key))?.push(entry);
  }

  const uiEntries = groups.get('ui');
  if (uiEntries) {
    // A TUI-local row has a key outside the platform schema and sorts after the listed ones.
    const priorityOf = (key: string): number => (isValidConfigKey(key) ? UI_SETTING_PRIORITY[key] : undefined) ?? 99;
    uiEntries.sort((a, b) => priorityOf(a.setting.key) - priorityOf(b.setting.key));
  }

  // Cross-list ui.voiceEnabled into the 'tts' category so that /settings open tts
  // shows the always-speak toggle alongside the other TTS settings.
  const ttsEntries = groups.get('tts');
  if (ttsEntries && uiEntries) {
    const voiceEnabledEntry = uiEntries.find((e) => e.setting.key === 'ui.voiceEnabled');
    if (voiceEnabledEntry && !ttsEntries.some((e) => e.setting.key === 'ui.voiceEnabled')) {
      ttsEntries.unshift(voiceEnabledEntry);
    }
  }

  // The notification settings (behavior.notify*, terminalNotify*, terminalBell,
  // budgetAlertUsd) and storage.codeIndexEnabled are the terminal app's own
  // settings, registered on its manager (config/tui-extension-settings.ts) and
  // listed above from its host schema. The host-owned privacy control goes
  // after the notification toggles.
  const behaviorEntries = groups.get('behavior');
  if (behaviorEntries) {
    const privacyIndex = behaviorEntries.findIndex((e) => e.setting.key === NOTIFICATIONS_METADATA_ONLY_KEY);
    if (privacyIndex >= 0) behaviorEntries.push(...behaviorEntries.splice(privacyIndex, 1));
  }

  // Inject the worktree.setup.commands / worktree.setup.carryOverGlobs
  // synthetic entries into the orchestration category (worktree isolation is
  // an orchestration-engine concern, see WorkstreamIsolation 'worktree').
  // They are settings rows of the platform schema; this screen edits them as
  // auto, none or a list on one line, instead of the JSON editor of other object rows.
  const orchestrationEntries = groups.get('orchestration');
  if (orchestrationEntries) {
    if (!orchestrationEntries.some((e) => e.setting.key === WORKTREE_SETUP_COMMANDS_CONFIG_KEY)) {
      orchestrationEntries.push(buildWorktreeSetupCommandsSyntheticEntry(configManager));
    }
    if (!orchestrationEntries.some((e) => e.setting.key === WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY)) {
      orchestrationEntries.push(buildWorktreeSetupCarryOverGlobsSyntheticEntry(configManager));
    }
  }

  // Inject the sandbox.egressAllowlist / sandbox.workspaceWritable list editors
  // (schema rows given a list editor, as above) and the
  // permissions.execEnvScrubAllowlist synthetic entry (see exec-env-scrub-config.ts).
  injectSandboxExecSyntheticEntries(groups, configManager);
  injectExecEnvScrubSyntheticEntry(groups, configManager);

  // Payments: the CONFIG_SCHEMA loop above already filled 'payments' with the
  // real settings. Cards are not settings: one locked row points to /payments add-card.
  const paymentsEntries = groups.get('payments');
  if (paymentsEntries && !paymentsEntries.some((e) => e.setting.key === PAYMENTS_CARDS_ROW_KEY)) {
    paymentsEntries.push(buildPaymentsCardsRow());
  }

  // relay.* is a real platform CONFIG_SCHEMA domain; append the threat-model note
  // the platform's own descriptions don't carry (see relay-settings-descriptions.ts).
  enrichRelaySettingDescriptions(groups);

  // Daemon-owned keys (e.g. surfaces.telegram.*) live only in the daemon's
  // own config store, say so in the detail text (daemon-owned-settings-descriptions.ts).
  enrichDaemonOwnedSettingDescriptions(groups, configManager);

  // Feature-unit presentation: each capability becomes ONE unit (its real
  // enablement row + the settings keys it tunes) in its settings domain,
  // sourced from FEATURE_SETTINGS. Runs AFTER synthetic injection so
  // non-feature-owned rows stay orphans; skipped on the featureless path.
  if (featureFlagManager) applyFeatureUnitLayout(groups, buildFlagEntries(featureFlagManager));

  // learning.consolidation.* is a real platform config domain now, so its keys arrive
  // through the CONFIG_SCHEMA loop above; the old TUI-local synthetic entries were
  // removed for this reason.

  // Synthetic and feature-header rows use the same guarded mutation paths.
  // They must not remain editable while the shared policy read is suspended.
  if (hostMetadataUnavailable) {
    for (const entries of groups.values()) for (const entry of entries) {
      Object.assign(entry, {
        effectiveSource: undefined, locked: undefined, conflict: undefined,
        sourceLabel: undefined, lockReason: undefined, metadataUnavailable: POLICY_METADATA_UNAVAILABLE,
      });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// buildFlagEntries, snapshot of current feature flag states
// ---------------------------------------------------------------------------

export function buildFlagEntries(featureFlagManager: FeatureFlagManager | null): FlagEntry[] {
  if (!featureFlagManager) return [];
  const entries: FlagEntry[] = [];
  for (const { flag, state, persistedState, pendingRestart } of featureFlagManager.getAll().values()) {
    const feature = FEATURE_SETTINGS_BY_ID.get(flag.id);
    if (!feature) continue; // gate with no settings surface (registry/binding drift is platform test-guarded)
    entries.push({ feature, flag, state, persistedState, pendingRestart });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// buildMcpEntries, snapshot of current MCP server security entries
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// buildSubscriptionEntries, re-export for use by SettingsModal
// ---------------------------------------------------------------------------

export { buildSubscriptionEntries };

// ---------------------------------------------------------------------------
// buildNetworkFilteredItems, applies host-mode visibility rules for 'network' tab
// ---------------------------------------------------------------------------

export function buildNetworkFilteredItems(
  items: SettingEntry[],
  configManager: ConfigManager | null,
): SettingEntry[] {
  return items.filter(entry => {
    if (entry.setting.key === 'controlPlane.host') {
      return configManager?.get('controlPlane.hostMode') === 'custom';
    }
    if (entry.setting.key === 'httpListener.host') {
      return configManager?.get('httpListener.hostMode') === 'custom';
    }
    if (entry.setting.key === 'web.host') {
      return configManager?.get('web.hostMode') === 'custom';
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// refreshEntryValues, re-reads currentValue/isDefault for all loaded entries
// ---------------------------------------------------------------------------

export function refreshEntryValues(
  groups: Map<SettingsCategory, SettingEntry[]>,
  configManager: ConfigManager,
  policy: SettingsPolicyRead = readSettingsPolicy(configManager),
): void {
  // Host rows are refreshed here, from the same policy read.
  refreshSettingsPolicyAvailability(groups, configManager, policy);
  for (const entries of groups.values()) {
    for (const entry of entries) {
      if (entry.kind !== 'host') refreshBuiltinSettingValue(entry, configManager);
    }
  }
}

// ---------------------------------------------------------------------------
// updateEntryForKey, updates a single setting entry after a value change
// ---------------------------------------------------------------------------

export function updateEntryForKey(
  groups: Map<SettingsCategory, SettingEntry[]>,
  key: string,
  configManager: ConfigManager,
): void {
  for (const entries of groups.values()) {
    const entry = entries.find((candidate) => candidate.setting.key === key);
    if (entry) {
      if (entry.kind === 'host') {
        refreshHostSettingEntry(entry, configManager);
        continue;
      }
      refreshBuiltinSettingValue(entry, configManager);
    }
  }
}

/** Synthetic rows retain their declared reader during refresh and policy recovery. */
function refreshBuiltinSettingValue(entry: BuiltinSettingEntry, configManager: ConfigManager): void {
  const key: string = entry.setting.key;
  if (isWorktreeSetupListConfigKey(entry.setting.key)) {
    // The row shows its mode as edit text: auto, none, or the list.
    const choice = readWorktreeSetupSetting(configManager, entry.setting.key);
    entry.currentValue = formatWorktreeSetupEditText(worktreeSetupSettingValue(choice));
    entry.isDefault = choice.mode === 'auto';
    return;
  }
  if (isSandboxExecListConfigKey(entry.setting.key)) {
    const value = readSandboxExecList(configManager, entry.setting.key);
    entry.currentValue = value;
    entry.isDefault = value.length === 0;
    return;
  }
  if (isExecEnvScrubAllowlistConfigKey(entry.setting.key)) {
    const value = readExecEnvScrubAllowlist(configManager);
    entry.currentValue = value;
    entry.isDefault = value.length === 0;
    return;
  }
  if (key === PAYMENTS_CARDS_ROW_KEY) return;
  entry.currentValue = configManager.get(entry.setting.key);
  // The row's default is the product's (buildSettingGroups), read again in case it changed since.
  entry.isDefault = deepEqual(entry.currentValue, configManager.defaultOf(key));
}

// ---------------------------------------------------------------------------
// Re-export SubscriptionEntry for convenience
// ---------------------------------------------------------------------------

export type { SubscriptionEntry } from './settings-modal-types.ts';
export type { SubscriptionManager };
export type { ServiceInspectionQuery };
