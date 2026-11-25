/**
 * Settings sync: carrying your settings to another machine as a file, and
 * settling values that disagree. Run by the daemon, over the settings each
 * owner keeps: the daemon's own (a daemon-owned setting, config-ownership.ts)
 * and the asking program's (the terminal app's or the Agent's, its files as it
 * reads them). A bundle holds one part per owner, each labelled with it; pulling
 * one applies each part to its owner and says what was applied and what was left
 * (another program's part is left for that program to pull). A bundle a 3.5.0
 * terminal app wrote (one `settings` object) is split by owner the same way.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { CONFIG_KEYS } from '../../config/schema.js';
import { isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import {
  applySettingsSyncBundle, exportSettingsSyncBundle, formatResolvedSettingReview, formatSettingsControlPlaneReview,
  getSettingsControlPlaneSnapshot, inspectSettingsSyncBundle, recordSettingsSyncEvent, recordSettingsSyncFailure, resolveSettingsSyncConflict,
  type SettingsSyncBundle,
} from '../../runtime/settings/control-plane.js';
import { CapabilityRefusal, type ActionValues, type CapabilityCaller, type CapabilityDefinition, type CapabilityResult, type InputDescription, type ListName } from '../types.js';
import type { ProgramSettingsCapabilityServices } from './program-settings.js';
import { noteListChanged } from '../../runtime/list-changes.js';

/** The daemon's own settings, beside the asking program's (ProgramSettingsCapabilityServices). */
export interface SettingsSyncCapabilityServices extends ProgramSettingsCapabilityServices {
  readonly settingsSync: { daemon(): ConfigManager };
}

type Definition = CapabilityDefinition<SettingsSyncCapabilityServices>;
type Owner = 'daemon' | 'tui' | 'agent';
const OWNER_WORDS: Readonly<Record<Owner, string>> = { daemon: 'the daemon', tui: 'the terminal app', agent: 'the Agent' };

/** One owner's part of a bundle. */
interface BundlePart { readonly owner: Owner; readonly settings: Readonly<Record<string, unknown>> }
/** A bundle with a part per owner; `settings` stays for a 3.5.0 terminal app, which reads only it. */
type OwnedBundle = SettingsSyncBundle & { readonly parts?: readonly BundlePart[] };

const programOf = (caller: CapabilityCaller): 'tui' | 'agent' => caller.program ?? 'tui';
const ownerOfKey = (key: string, caller: CapabilityCaller): Owner => isDaemonOwnedConfigKey(key) ? 'daemon' : programOf(caller);
const configOf = (services: SettingsSyncCapabilityServices, owner: Owner, caller: CapabilityCaller): ConfigManager =>
  owner === 'daemon' ? services.settingsSync.daemon() : services.programSettings.config({ ...caller, program: owner });
/** An owner's name at the start of a sentence: "The daemon's". */
const Whose = (owner: Owner): string => `${OWNER_WORDS[owner][0]!.toUpperCase()}${OWNER_WORDS[owner].slice(1)}'s`;
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');

const PATH: InputDescription = { id: 'path', label: 'Bundle file', help: 'A settings sync bundle (JSON), in your project folder unless the path says where', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } };
const KEY: InputDescription = { id: 'key', label: 'Setting', help: 'A setting key, as Settings shows it', kind: 'text', freeTextReason: 'a setting key', required: true, typed: { position: 1 } };
export const SETTINGS_SYNC_CONFLICTS_LIST = 'settings-sync.conflicts' as ListName;

/** Read a bundle file, refusing in words a file that is unreadable, not JSON, or not shaped like a bundle. */
function readBundle(path: string): OwnedBundle {
  let text: string;
  try { text = readFileSync(path, 'utf-8'); } catch (error) { throw new CapabilityRefusal(`Cannot read ${path}: ${reason(error)}.`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new CapabilityRefusal(`${path} is not valid JSON, so it is not a settings sync bundle.`); }
  const bundle = parsed as Partial<Record<string, unknown>> | null;
  const settings = bundle?.settings;
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle) || typeof settings !== 'object' || settings === null || Array.isArray(settings)
    || typeof bundle.exportedAt !== 'number' || !Number.isFinite(bundle.exportedAt)) {
    throw new CapabilityRefusal(`${path} is not a settings sync bundle: expected a JSON object with a numeric exportedAt and a settings object. Nothing was applied.`);
  }
  return parsed as OwnedBundle;
}

/** A bundle's parts: as labelled, or (a 3.5.0 bundle) its one settings object split by who owns each key. */
function partsOf(bundle: OwnedBundle, caller: CapabilityCaller): readonly BundlePart[] {
  const owners: readonly Owner[] = ['daemon', 'tui', 'agent'];
  if (Array.isArray(bundle.parts)) {
    return bundle.parts.filter((part): part is BundlePart => part !== null && typeof part === 'object' && owners.includes(part.owner)
      && typeof part.settings === 'object' && part.settings !== null && !Array.isArray(part.settings));
  }
  const split = new Map<Owner, Record<string, unknown>>();
  for (const [key, value] of Object.entries(bundle.settings)) {
    const owner = ownerOfKey(key, caller);
    split.set(owner, { ...(split.get(owner) ?? {}), [key]: value });
  }
  return [...split.entries()].map(([owner, settings]) => ({ owner, settings }));
}

const read = (fields: Omit<Definition, 'capability' | 'touches' | 'lasts' | 'risk' | 'done'> & { readonly id: string }): Definition => {
  const { id, ...rest } = fields;
  return { ...rest, capability: { id, group: 'devices', home: 'daemon', repeat: 'safe' }, touches: 'reads', lasts: 'not-a-change', risk: 'none', done: '' };
};

/** Both owners' sync records, each under its owner's name. */
function bothOwners(services: SettingsSyncCapabilityServices, caller: CapabilityCaller): readonly { readonly owner: Owner; readonly config: ConfigManager }[] {
  return (['daemon', programOf(caller)] as const).map((owner) => ({ owner, config: configOf(services, owner, caller) }));
}

/**
 * The settings that disagree, each once and under its owner: the owners' records may be one store (both settings
 * files sit under one home), so a key read from both is listed once, as the setting of whoever owns it.
 */
function conflictsOf(services: SettingsSyncCapabilityServices, caller: CapabilityCaller): readonly { owner: Owner; key: string; source: string; path: string }[] {
  const seen = new Map<string, { owner: Owner; key: string; source: string; path: string }>();
  for (const { config } of bothOwners(services, caller)) {
    for (const conflict of getSettingsControlPlaneSnapshot(config).conflicts) {
      if (!seen.has(conflict.key)) seen.set(conflict.key, { owner: ownerOfKey(conflict.key, caller), key: conflict.key, source: conflict.source, path: conflict.path });
    }
  }
  return [...seen.values()];
}

export const SETTINGS_SYNC_REVIEW = read({
  id: 'settings-sync.review', actionId: 'review', label: 'See where your settings come from', word: 'review', inputs: [], example: {},
  sentence: 'Shows which layers your settings come from, for the daemon\'s settings and this program\'s, with sync state, conflicts, locks and recent failures.',
  async run(_values, services, caller) {
    const parts = bothOwners(services, caller).map(({ owner, config }) => [`${Whose(owner)} settings:`, ...formatSettingsControlPlaneReview(config).map((line) => `  ${line}`)].join('\n'));
    return { text: parts.join('\n'), data: { conflicts: conflictsOf(services, caller) } };
  },
});

export const SETTINGS_SYNC_SHOW = read({
  id: 'settings-sync.show', actionId: 'show', label: 'See where one setting\'s value comes from', word: 'show', inputs: [KEY], example: { key: 'provider.model' },
  sentence: 'Shows {key}\'s value in each layer of its owner\'s settings, and which one wins.',
  async run(values, services, caller) {
    const key = values.key!.trim();
    if (!CONFIG_KEYS.has(key as ConfigKey)) throw new CapabilityRefusal(`Unknown setting key: ${key}.`, 'Settings shows every key.');
    const owner = ownerOfKey(key, caller);
    return { text: `${key} is ${OWNER_WORDS[owner]}'s setting.\n${formatResolvedSettingReview(configOf(services, owner, caller), key as ConfigKey)}`, data: { key, owner } };
  },
});

export const SETTINGS_SYNC_CONFLICTS = read({
  id: 'settings-sync.conflicts', actionId: 'conflicts', label: 'See settings that disagree', word: 'conflicts', inputs: [], example: {},
  sentence: 'Shows the settings whose pulled value differs from this machine\'s, with whose setting each is.',
  async run(_values, services, caller) {
    const conflicts = conflictsOf(services, caller);
    return {
      text: conflicts.length > 0 ? conflicts.map((conflict) => `${conflict.key} (${OWNER_WORDS[conflict.owner]}'s): from ${conflict.path}`).join('\n') : 'No settings disagree.',
      data: { conflicts },
    };
  },
});

export const SETTINGS_SYNC_RESOLVE: Definition = {
  capability: { id: 'settings-sync.resolve', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'resolve', label: 'Settle a setting that disagrees', word: 'resolve',
  inputs: [
    { ...KEY, help: 'A setting whose pulled value differs from this machine\'s', kind: 'choice', choices: { list: SETTINGS_SYNC_CONFLICTS_LIST } },
    { id: 'keep', label: 'Keep', help: 'Which value wins', kind: 'choice', choices: [{ value: 'local', label: 'This machine\'s value' }, { value: 'synced', label: 'The pulled value' }], required: true, typed: { position: 2 } },
  ],
  sentence: '{key} keeps the {keep} value until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { key: 'provider.model', keep: 'local' },
  async run(values, services, caller) {
    const key = values.key!.trim();
    const owner = ownerOfKey(key, caller);
    if (!resolveSettingsSyncConflict(configOf(services, owner, caller), key as ConfigKey, values.keep === 'synced' ? 'synced' : 'local')) {
      throw new CapabilityRefusal(`No pulled value of ${key} disagrees with this machine's.`, 'See settings that disagree lists the open ones.');
    }
    noteListChanged({ list: 'settings-sync', change: 'changed', id: key });
    return { text: `${key} keeps the ${values.keep === 'synced' ? 'pulled' : 'local'} value.`, data: { key, owner, keep: values.keep } };
  },
};

export const SETTINGS_SYNC_FAILURES = read({
  id: 'settings-sync.failures', actionId: 'failures', label: 'See recent sync failures', word: 'failures', inputs: [], example: {},
  sentence: 'Shows the sync and managed-setting attempts that failed recently and why, for the daemon\'s settings and this program\'s.',
  async run(_values, services, caller) {
    const failures = bothOwners(services, caller).flatMap(({ owner, config }) => getSettingsControlPlaneSnapshot(config).recentFailures.map((failure) => ({ owner, surface: failure.surface, message: failure.message })));
    return { text: failures.length > 0 ? failures.map((failure) => `${OWNER_WORDS[failure.owner]}: ${failure.message}`).join('\n') : 'No sync or managed-setting attempt failed recently.', data: { failures } };
  },
});

export const SETTINGS_SYNC_EXPORT: Definition = {
  capability: { id: 'settings-sync.export', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'export', label: 'Save your settings to a sync bundle', word: 'export', inputs: [{ ...PATH, help: 'Where to write the bundle, in your project folder unless the path says where' }],
  sentence: 'The daemon\'s settings and this program\'s are written to {path}, each part labelled with its owner, for another machine to pull.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'settings-sync.json' },
  async run(values, services, caller) {
    const target = services.programSettings.resolvePath(caller, values.path!);
    const parts: BundlePart[] = bothOwners(services, caller).map(({ owner, config }) => ({
      owner, settings: Object.fromEntries(Object.entries(exportSettingsSyncBundle(config).settings).filter(([key]) => (ownerOfKey(key, caller) === 'daemon') === (owner === 'daemon'))),
    }));
    const settings = Object.assign({}, ...parts.map((part) => part.settings)) as Record<string, unknown>;
    const bundle: OwnedBundle = { ...exportSettingsSyncBundle(services.settingsSync.daemon()), settings, parts };
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    } catch (error) {
      throw new CapabilityRefusal(`Nothing was saved: ${target} could not be written (${reason(error)}).`);
    }
    for (const { config } of bothOwners(services, caller)) {
      recordSettingsSyncEvent({ surface: 'settings-sync', direction: 'export', path: target, timestamp: Date.now(), detail: `${Object.keys(settings).length} settings exported` }, config.getControlPlaneConfigDir());
    }
    return {
      text: `Saved the settings to ${target}: ${parts.map((part) => `${Object.keys(part.settings).length} of ${OWNER_WORDS[part.owner]}'s`).join(', ')}.`,
      data: { path: target, parts: parts.map((part) => ({ owner: part.owner, count: Object.keys(part.settings).length })) },
    };
  },
};

export const SETTINGS_SYNC_INSPECT = read({
  id: 'settings-sync.inspect', actionId: 'inspect', label: 'Look inside a sync bundle', word: 'inspect', inputs: [PATH], example: { path: 'settings-sync.json' },
  sentence: 'Shows what {path} holds, part by part and whose each part is; nothing is changed.',
  async run(values, services, caller) {
    const path = services.programSettings.resolvePath(caller, values.path!);
    let bundle: OwnedBundle;
    try { bundle = readBundle(path); } catch (error) {
      recordSettingsSyncFailure('settings-sync', reason(error), services.settingsSync.daemon().getControlPlaneConfigDir());
      throw error;
    }
    const parts = partsOf(bundle, caller);
    return {
      text: [inspectSettingsSyncBundle(bundle), ...parts.map((part) => `${Whose(part.owner)} part: ${Object.keys(part.settings).length} settings${part.owner !== 'daemon' && part.owner !== programOf(caller) ? ' (pulled from that program, not this one)' : ''}`)].join('\n'),
      data: { path, parts: parts.map((part) => ({ owner: part.owner, count: Object.keys(part.settings).length })) },
    };
  },
});

export const SETTINGS_SYNC_PULL: Definition = {
  capability: { id: 'settings-sync.pull', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'pull', label: 'Take the settings from a sync bundle', word: 'pull', inputs: [PATH],
  sentence: 'Each part of {path} replaces its owner\'s settings (the daemon\'s, this program\'s) until you change it, except keys a managed lock owns; another program\'s part is left for it. What changed is listed, with the copy of each settings file from before that puts it back.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection',
  ownerOnly: { reason: 'a sync bundle can change security settings on this machine', instead: 'See where your settings come from, in the Devices and network place.' },
  example: { path: 'settings-sync.json' },
  async run(values: ActionValues, services, caller): Promise<CapabilityResult> {
    const path = services.programSettings.resolvePath(caller, values.path!);
    const failed = (error: unknown): never => {
      recordSettingsSyncFailure('settings-sync', reason(error), services.settingsSync.daemon().getControlPlaneConfigDir());
      throw error instanceof CapabilityRefusal ? error : new CapabilityRefusal(`Not pulled: ${reason(error)}.`, 'Look inside a sync bundle shows what it holds.');
    };
    let bundle: OwnedBundle;
    try { bundle = readBundle(path); } catch (error) { return failed(error); }
    const lines: string[] = [];
    const applied: { owner: Owner; applied: number; conflicts: number; locked: readonly string[] }[] = [];
    const left: { owner: Owner; count: number }[] = [];
    for (const part of partsOf(bundle, caller)) {
      if (part.owner !== 'daemon' && part.owner !== programOf(caller)) { left.push({ owner: part.owner, count: Object.keys(part.settings).length }); continue; }
      // A key of the other owner in this part is left: each part is applied to its owner only.
      const own = Object.fromEntries(Object.entries(part.settings).filter(([key]) => ownerOfKey(key, caller) === part.owner));
      const config = configOf(services, part.owner, caller);
      const changes = Object.entries(own).filter(([key, next]) => CONFIG_KEYS.has(key as ConfigKey) && JSON.stringify(config.get(key as ConfigKey)) !== JSON.stringify(next));
      const settingsPath = config.getConfigPath();
      const before = `${settingsPath}.before-pull-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      let kept: string | null = null;
      if (changes.length > 0 && existsSync(settingsPath)) {
        try { copyFileSync(settingsPath, before); kept = before; } catch (error) { return failed(new Error(`${Whose(part.owner)} settings from before could not be kept at ${before} (${reason(error)}), so nothing of its part was pulled`)); }
      }
      try {
        // Only the values that differ are set: setting a running daemon's listener to the value it has would still
        // make it bind again, closing every connection, the asking one included.
        const result = applySettingsSyncBundle(config, { ...bundle, settings: Object.fromEntries(changes) }, path);
        applied.push({ owner: part.owner, applied: result.appliedCount, conflicts: result.conflictCount, locked: result.skippedLockedKeys ?? [] });
        lines.push(`${Whose(part.owner)} settings: ${result.appliedCount} applied, ${changes.length} changed${result.skippedLockedKeys?.length ? `, ${result.skippedLockedKeys.length} left because managed locks own them (${result.skippedLockedKeys.join(', ')})` : ''}.`);
        if (changes.length > 0) lines.push(`  Changed: ${changes.map(([key]) => key).join(', ')}.`);
        if (kept) lines.push(`  To put them back: the file as it was is kept as ${kept}; copy it over ${settingsPath}.`);
      } catch (error) {
        return failed(error);
      }
    }
    for (const part of left) lines.push(`Left: ${OWNER_WORDS[part.owner]}'s part (${part.count} settings); pull the same file from ${OWNER_WORDS[part.owner]} to apply it there.`);
    if (lines.length === 0) lines.push('The bundle held nothing for the daemon or this program; nothing was applied.');
    if (applied.length > 0) noteListChanged({ list: 'settings-sync', change: 'changed' });
    return { text: [`Pulled ${path}.`, ...lines].join('\n'), data: { path, applied, left } };
  },
};

/** Every settings-sync capability, in the order a person meets them. */
export const SETTINGS_SYNC_CAPABILITIES: readonly Definition[] = [
  SETTINGS_SYNC_REVIEW, SETTINGS_SYNC_SHOW, SETTINGS_SYNC_CONFLICTS, SETTINGS_SYNC_RESOLVE, SETTINGS_SYNC_FAILURES,
  SETTINGS_SYNC_EXPORT, SETTINGS_SYNC_INSPECT, SETTINGS_SYNC_PULL,
];
