/**
 * Managed settings and presets, managed by the daemon on the settings of the
 * program that asked: its own settings file (`~/.goodvibes/<program>/settings.json`
 * and the project's), the settings control-plane file beside it (managed locks,
 * the staged bundle, the rollback records), and its presets folder
 * (`~/.goodvibes/<program>/profiles`). These are the files that program reads,
 * so a change made here is what it runs with: it reads its settings files again
 * when they change. The daemon's own settings are a different file and are not
 * touched; a daemon-owned setting is written to the daemon's own file as always.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema.js';
import { CONFIG_KEYS } from '../../config/schema.js';
import { configKeyFacts } from '../../config/config-key-facts.js';
import type { ProfileData, ProfileManager } from '../../profiles/manager.js';
import { PROFILE_SETTING_KEYS, profileDataToConfigSnapshot } from '../../profiles/shape.js';
import type { ManagedSettingsBundle, ProfileBundleEntry, ProfileSyncBundle } from '../../runtime/sandbox/types.js';
import {
  applyStagedManagedBundle, clearManagedSettingLock, formatStagedManagedBundleReview, getSettingsControlPlaneSnapshot,
  inspectManagedSettingsBundle, recordSettingsSyncEvent, recordSettingsSyncFailure, rollbackManagedApply, setManagedSettingLock,
  stageManagedSettingsBundle,
} from '../../runtime/settings/control-plane.js';
import { CapabilityRefusal, REPLACED_DONE, type ActionValues, type CapabilityCaller, type CapabilityDefinition, type CapabilityResult, type InputDescription, type ListName } from '../types.js';
import { fixedInput, pickedInput, wordsInput } from './agent-stores.js';
import { noteListChanged } from '../../runtime/list-changes.js';

/** What these capabilities need: the asking program's own settings and presets, read fresh for each call. */
export interface ProgramSettingsCapabilityServices {
  readonly programSettings: {
    /** The asking program's settings (`tui` when no program said), with its project's layer. */
    config(caller: CapabilityCaller): ConfigManager;
    /** The asking program's presets folder. */
    presets(caller: CapabilityCaller): ProfileManager;
    /** A file path the caller gave, in its own project folder when it is not absolute. */
    resolvePath(caller: CapabilityCaller, path: string): string;
  };
}

export const MANAGED_ROLLBACKS_LIST = 'managed.rollbacks' as ListName;
export const PRESETS_LIST = 'managed.profiles' as ListName;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');

function readJsonFile(path: string, what: string): unknown {
  let text: string;
  try { text = readFileSync(path, 'utf-8'); } catch (error) { throw new CapabilityRefusal(`${path} could not be read (${errorText(error)}); nothing was changed.`); }
  try { return JSON.parse(text); } catch { throw new CapabilityRefusal(`${path} is not valid JSON, so it is not ${what}; nothing was changed.`); }
}

function keysOf(text: string | undefined): ConfigKey[] {
  const keys = (text ?? '').split(/[\n,]/).map((key) => key.trim()).filter(Boolean);
  const unknown = keys.filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) throw new CapabilityRefusal(`No setting is called ${unknown.join(', ')}; nothing was applied.`);
  return keys as ConfigKey[];
}

/** The settings a bundle changes, named, the ones that touch security first (values are never shown: one may be a credential). */
function securityLines(changes: readonly { readonly key: string }[]): string[] {
  const security = changes.filter((change) => { const facts = configKeyFacts(change.key); return facts.loosens !== undefined || facts.secret || facts.cardMaterial; });
  return security.length > 0 ? [`These settings touch security: ${security.map((change) => change.key).join(', ')}.`] : [];
}

function guarded(run: () => CapabilityResult | Promise<CapabilityResult>): Promise<CapabilityResult> {
  return Promise.resolve().then(run).catch((error: unknown) => {
    if (error instanceof CapabilityRefusal) throw error;
    throw new CapabilityRefusal(`${errorText(error)}.`);
  });
}

type Def = CapabilityDefinition<ProgramSettingsCapabilityServices>;
interface Fields {
  readonly id: string; readonly actionId: string; readonly label: string; readonly word: string; readonly sentence: string;
  readonly inputs?: readonly InputDescription[] | undefined; readonly example: ActionValues;
  readonly risk?: Def['risk'] | undefined; readonly undoneBy?: string | undefined; readonly ownerOnly?: Def['ownerOnly'] | undefined;
  readonly riskDone?: string | undefined;
  readonly lasts?: Def['lasts'] | undefined; readonly repeat?: 'safe' | 'unsafe' | undefined;
  readonly run: (values: ActionValues, services: ProgramSettingsCapabilityServices['programSettings'], caller: CapabilityCaller) => CapabilityResult | Promise<CapabilityResult>;
}

function read(fields: Fields): Def {
  return {
    capability: { id: fields.id, group: 'tools', home: 'daemon', repeat: 'safe' },
    actionId: fields.actionId, label: fields.label, word: fields.word, inputs: fields.inputs ?? [], sentence: fields.sentence, done: '',
    touches: 'reads', lasts: 'not-a-change', risk: 'none', example: fields.example,
    run: (values, services, caller) => guarded(() => fields.run(values, services.programSettings, caller)),
  };
}
function change(fields: Fields): Def {
  return {
    capability: { id: fields.id, group: 'tools', home: 'daemon', repeat: fields.repeat ?? 'safe' },
    actionId: fields.actionId, label: fields.label, word: fields.word, inputs: fields.inputs ?? [], sentence: fields.sentence, done: '',
    touches: 'this-machine', lasts: fields.lasts ?? 'kept', risk: fields.risk ?? 'none',
    ...(fields.undoneBy ? { undoneBy: fields.undoneBy } : {}), ...(fields.ownerOnly ? { ownerOnly: fields.ownerOnly } : {}),
    ...(fields.riskDone ? { riskDone: fields.riskDone } : {}),
    example: fields.example,
    async run(values, services, caller) {
      const result = await guarded(() => fields.run(values, services.programSettings, caller));
      // Every screen showing the presets and managed settings reads them again (LIST_CHANGED `tools`).
      noteListChanged({ list: 'tools', change: 'changed' });
      return result;
    },
  };
}

const BUNDLE_FILE = wordsInput({ id: 'path', label: 'Bundle file', help: 'A managed settings bundle (JSON)', why: 'a file path in this project', kind: 'path', typed: { position: 1 } });
const ONLY_KEYS = wordsInput({ id: 'keys', label: 'Only these settings', help: 'Setting names, separated by commas', why: 'setting names as Settings shows them', typed: { flag: '--key', repeats: true }, optional: { default: '', means: 'every setting in it' } });
const KEY = wordsInput({ id: 'key', label: 'Setting', help: 'A setting\'s name, as Settings shows it', why: 'a setting name as Settings shows it', typed: { position: 1 } });

function managedFacts(config: ConfigManager, presets: ProfileManager) {
  const snapshot = getSettingsControlPlaneSnapshot(config);
  return {
    staged: snapshot.stagedManagedBundle
      ? [{ id: snapshot.stagedManagedBundle.id, state: 'staged', name: snapshot.stagedManagedBundle.profileName, path: snapshot.stagedManagedBundle.path,
        changes: snapshot.stagedManagedBundle.changeCount, risk: snapshot.stagedManagedBundle.risk, at: snapshot.stagedManagedBundle.importedAt,
        keys: snapshot.stagedManagedBundle.changes.filter((entry) => entry.changed).map((entry) => entry.key) }]
      : [],
    locks: snapshot.managedLocks.map((lock) => ({ id: lock.key, state: 'locked', key: lock.key, source: lock.source, reason: lock.reason, at: lock.updatedAt })),
    rollbacks: snapshot.rollbackHistory.map((entry) => ({ id: entry.token, state: 'applied', name: entry.profileName, path: entry.path, at: entry.appliedAt, settings: entry.restoredKeys.length, keys: entry.restoredKeys })),
    presets: presets.list().length,
  };
}

export const MANAGED_REVIEW = read({
  id: 'managed.review', actionId: 'review', label: 'See managed settings at a glance', word: 'review',
  sentence: 'Shows your presets, the staged bundle, the settings locked as managed and the applies you can roll back.', example: {},
  run: (_values, services, caller) => {
    const config = services.config(caller);
    const facts = managedFacts(config, services.presets(caller));
    return {
      text: ['Managed settings', `  presets: ${facts.presets}`, `  staged bundle: ${facts.staged[0]?.name ?? 'none'}`, `  settings locked as managed: ${facts.locks.length}`, `  applies you can roll back: ${facts.rollbacks.length}`].join('\n'),
      data: facts,
    };
  },
});
export const MANAGED_STAGED = read({
  id: 'managed.staged', actionId: 'staged', label: 'See the staged bundle', word: 'staged',
  sentence: 'Shows the bundle staged to apply, and each change it makes.', example: {},
  run: (_values, services, caller) => {
    const config = services.config(caller);
    return { text: formatStagedManagedBundleReview(config), data: { staged: managedFacts(config, services.presets(caller)).staged } };
  },
});
export const MANAGED_HISTORY = read({
  id: 'managed.history', actionId: 'history', label: 'See applies you can roll back', word: 'history',
  sentence: 'Shows each managed apply and how many settings it changed.', example: {},
  run: (_values, services, caller) => {
    const rollbacks = managedFacts(services.config(caller), services.presets(caller)).rollbacks;
    return {
      text: rollbacks.length > 0 ? ['Applies you can roll back', ...rollbacks.map((entry) => `  ${entry.name}, ${new Date(entry.at).toLocaleString()}: ${entry.settings} setting(s)`)].join('\n') : 'No managed apply to roll back yet.',
      data: { rollbacks },
    };
  },
});
export const MANAGED_INSPECT = read({
  id: 'managed.inspect', actionId: 'inspect', label: 'Look inside a managed bundle', word: 'inspect', inputs: [BUNDLE_FILE],
  sentence: 'Shows what {path} would change here and how risky it is; nothing is changed.', example: { path: 'managed/team.json' },
  run: async (values, services, caller) => {
    const path = services.resolvePath(caller, values.path!);
    return { text: await inspectManagedSettingsBundle(services.config(caller), readJsonFile(path, 'a managed settings bundle') as ManagedSettingsBundle, path) };
  },
});
export const MANAGED_EXPORT = change({
  id: 'managed.export', actionId: 'export', label: 'Save a preset as a managed bundle', word: 'export', lasts: 'not-a-change',
  inputs: [pickedInput({ id: 'profile', label: 'Preset', help: 'Your saved presets', list: PRESETS_LIST, other: 'a preset name' }), { ...BUNDLE_FILE, help: 'Where to write the bundle', typed: { position: 2 } }],
  sentence: 'The settings of preset {profile} are written to {path} as a managed bundle.', example: { profile: 'team', path: 'managed/team.json' },
  run: (values, services, caller) => {
    const loaded = services.presets(caller).load(values.profile!);
    const bundle: ManagedSettingsBundle = { version: 1, exportedAt: Date.now(), profileName: values.profile!, settings: profileDataToConfigSnapshot(loaded.data) };
    const target = services.resolvePath(caller, values.path!);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    const config = services.config(caller);
    recordSettingsSyncEvent({ surface: 'managed', direction: 'export', path: target, timestamp: Date.now(), detail: `${Object.keys(bundle.settings).length} settings exported from ${values.profile}` }, config.getControlPlaneConfigDir());
    return { text: `Saved preset ${values.profile} as a managed bundle at ${target}.`, data: { file: target } };
  },
});
export const MANAGED_STAGE = change({
  id: 'managed.stage', actionId: 'stage', label: 'Stage a managed bundle to apply later', word: 'stage', inputs: [BUNDLE_FILE],
  sentence: 'The changes in {path} are staged, ready to apply, until you change it; nothing is applied yet.', example: { path: 'managed/team.json' },
  run: async (values, services, caller) => {
    const config = services.config(caller);
    const path = services.resolvePath(caller, values.path!);
    try {
      const stage = await stageManagedSettingsBundle(config, readJsonFile(path, 'a managed settings bundle') as ManagedSettingsBundle, path);
      return {
        text: [`Staged the managed bundle from ${path}: ${stage.changeCount} change(s), risk ${stage.risk}.`, ...(stage.ignoredKeys && stage.ignoredKeys.length > 0 ? [`Not staged, not settings this version manages: ${stage.ignoredKeys.join(', ')}.`] : [])].join('\n'),
        data: { stage: stage.id, changes: stage.changeCount, risk: stage.risk },
      };
    } catch (error) {
      recordSettingsSyncFailure('managed', errorText(error), config.getControlPlaneConfigDir());
      throw new CapabilityRefusal(`Not staged: ${errorText(error)}.`);
    }
  },
});

/** What applying a managed bundle did to security: true whether it loosened, tightened or left it alone. */
const MANAGED_APPLIED = 'Any setting it changed that touches security is named above; it can loosen or tighten a protection, and none named means it changed none.';
const APPLY_OWNER_ONLY = { reason: 'a managed bundle can change security settings on this machine', instead: 'Ask the owner to apply it in Tools and extensions, Managed settings.' };

export const MANAGED_APPLY = change({
  id: 'managed.apply', actionId: 'apply', label: 'Apply a managed bundle', word: 'apply', inputs: [BUNDLE_FILE, ONLY_KEYS], risk: 'loosens-a-protection', undoneBy: 'rollback', ownerOnly: APPLY_OWNER_ONLY,
  sentence: 'The settings in {path} are applied and locked as managed until you change it; rolling the apply back puts the earlier values back.', example: { path: 'managed/team.json' },
  // A bundle may tighten as well as loosen: what it did to security is the list above, not the risk's words.
  riskDone: MANAGED_APPLIED,
  run: async (values, services, caller) => {
    const requested = keysOf(values.keys);
    const config = services.config(caller);
    const path = services.resolvePath(caller, values.path!);
    const bundle = readJsonFile(path, 'a managed settings bundle') as ManagedSettingsBundle;
    try {
      // One read: what is staged is what is applied, and only the stage this call made.
      const stage = await stageManagedSettingsBundle(config, bundle, path);
      const result = await applyStagedManagedBundle(config, requested, stage.id);
      const changed = stage.changes.filter((entry) => entry.changed && (requested.length === 0 || requested.includes(entry.key as ConfigKey)));
      return {
        text: [
          `Applied the managed bundle from ${path}: ${result.appliedCount} change(s), risk ${stage.risk}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}.`,
          ...securityLines(changed),
          ...(stage.ignoredKeys && stage.ignoredKeys.length > 0 ? [`Not applied, not settings this version manages: ${stage.ignoredKeys.join(', ')}.`] : []),
        ].join('\n'),
        data: { rollback: result.rollbackToken, applied: result.appliedCount, remaining: result.remainingCount },
      };
    } catch (error) {
      recordSettingsSyncFailure('managed', errorText(error), config.getControlPlaneConfigDir());
      throw new CapabilityRefusal(`Not applied: ${errorText(error)}.`);
    }
  },
});
export const MANAGED_APPLY_STAGED = change({
  id: 'managed.apply-staged', actionId: 'apply-staged', label: 'Apply the staged bundle', word: 'apply-staged', inputs: [ONLY_KEYS], risk: 'loosens-a-protection', undoneBy: 'rollback', ownerOnly: APPLY_OWNER_ONLY,
  sentence: 'The staged settings are applied and locked as managed until you change it; rolling the apply back puts the earlier values back.', example: {},
  riskDone: MANAGED_APPLIED,
  run: async (values, services, caller) => {
    const requested = keysOf(values.keys);
    const config = services.config(caller);
    const staged = getSettingsControlPlaneSnapshot(config).stagedManagedBundle;
    if (!staged) throw new CapabilityRefusal('Nothing is staged; nothing was applied.', 'Stage a bundle first.');
    try {
      // The stage shown is the one applied: another stage put there since is refused.
      const result = await applyStagedManagedBundle(config, requested, staged.id);
      const changed = staged.changes.filter((entry) => entry.changed && (requested.length === 0 || requested.includes(entry.key as ConfigKey)));
      return {
        text: [`Applied the staged settings: ${result.appliedCount} change(s)${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}.`, ...securityLines(changed)].join('\n'),
        data: { rollback: result.rollbackToken, applied: result.appliedCount, remaining: result.remainingCount },
      };
    } catch (error) {
      recordSettingsSyncFailure('managed', errorText(error), config.getControlPlaneConfigDir());
      throw new CapabilityRefusal(`Not applied: ${errorText(error)}.`);
    }
  },
});
export const MANAGED_ROLLBACK = change({
  id: 'managed.rollback', actionId: 'rollback', label: 'Undo a managed apply: put back the values from before it', word: 'rollback',
  inputs: [pickedInput({ id: 'token', label: 'Apply', help: 'Past managed applies', list: MANAGED_ROLLBACKS_LIST, other: 'an apply\'s token' })],
  sentence: 'The settings apply {token} changed get their earlier values back, until you change it.', example: { token: 'rb-3f1c' },
  run: (values, services, caller) => {
    const config = services.config(caller);
    try {
      const restored = rollbackManagedApply(config, values.token!);
      return { text: `Put back ${restored} setting(s) to their values from before that apply.`, data: { restored } };
    } catch (error) {
      recordSettingsSyncFailure('managed', errorText(error), config.getControlPlaneConfigDir());
      throw new CapabilityRefusal(`Not rolled back: ${errorText(error)}.`);
    }
  },
});
export const MANAGED_LOCK = change({
  id: 'managed.lock', actionId: 'lock', label: 'Lock a setting as managed', word: 'lock', undoneBy: 'unlock',
  inputs: [KEY, wordsInput({ id: 'source', label: 'Who manages it', help: 'Who set the lock (your team, an admin)', why: 'a name you choose', typed: { position: 2 } }), wordsInput({ id: 'reason', label: 'Why', help: 'The reason shown to whoever tries to change it', why: 'your own words', typed: { tail: true } })],
  sentence: '{key} is locked as managed by {source} ("{reason}"), so it cannot be changed here, until you change it.', example: { key: 'permissions.mode', source: 'security-team', reason: 'set by policy' },
  run: (values, services, caller) => {
    if (!CONFIG_KEYS.has(values.key!)) throw new CapabilityRefusal(`No setting is called ${values.key}; no lock was recorded.`);
    setManagedSettingLock(values.key as ConfigKey, values.source!, values.reason!, services.config(caller).getControlPlaneConfigDir());
    return { text: `Locked ${values.key} as managed by ${values.source}.`, data: { key: values.key } };
  },
});
export const MANAGED_UNLOCK = change({
  id: 'managed.unlock', actionId: 'unlock', label: 'Unlock a managed setting', word: 'unlock', inputs: [KEY], risk: 'loosens-a-protection', undoneBy: 'lock',
  ownerOnly: { reason: 'a lock set by your organisation is a security setting', instead: 'Ask the owner to unlock it in Tools and extensions, Managed settings.' },
  sentence: 'The managed lock on {key} is cleared, so it can be changed here again, until you change it.', example: { key: 'permissions.mode' },
  run: (values, services, caller) => {
    if (!CONFIG_KEYS.has(values.key!)) throw new CapabilityRefusal(`No setting is called ${values.key}.`);
    if (!clearManagedSettingLock(values.key as ConfigKey, services.config(caller).getControlPlaneConfigDir())) throw new CapabilityRefusal(`${values.key} has no managed lock; nothing was changed.`, undefined, 'NOT_FOUND');
    return { text: `Unlocked ${values.key}.`, data: { key: values.key } };
  },
});

// ---------------------------------------------------------------------------
// Presets: saved sets of display, model and behaviour settings
// ---------------------------------------------------------------------------

const PRESET = pickedInput({ id: 'preset', label: 'Preset', help: 'Your saved presets', list: PRESETS_LIST, other: 'a preset name' });
const PRESETS_FILE = wordsInput({ id: 'path', label: 'File', help: 'A presets file', why: 'a file on this machine', kind: 'path', typed: { position: 1 } });

function presetFacts(presets: ProfileManager) {
  return presets.list().map((preset) => ({ id: preset.name, name: preset.name, state: 'saved', savedAt: preset.timestamp }));
}

export const PRESETS_LIST_ALL = read({
  id: 'presets.list', actionId: 'list', label: 'See your presets', word: 'list',
  sentence: 'Lists your saved presets and when each was saved.', example: {},
  run: (_values, services, caller) => {
    const presets = presetFacts(services.presets(caller));
    return {
      text: presets.length > 0 ? ['Presets', ...presets.map((preset) => `  ${preset.name}  saved ${new Date(preset.savedAt).toLocaleString()}`)].join('\n') : 'No presets saved yet: save your settings as one first.',
      data: { presets },
    };
  },
});

/** The setting keys a preset carries, by section. */
const SECTION_KEYS = (section: 'display' | 'behavior'): readonly ConfigKey[] => PROFILE_SETTING_KEYS.filter((key) => key.startsWith(`${section}.`));
const PROVIDER_FIELDS = new Set(PROFILE_SETTING_KEYS.filter((key) => key.startsWith('provider.')).map((key) => key.slice('provider.'.length)));

export const PRESETS_LOAD = change({
  id: 'presets.load', actionId: 'load', label: 'Load a preset', word: 'load', inputs: [PRESET],
  sentence: 'The display, model and behaviour settings saved in {preset} become yours, until you change them.', example: { preset: 'focus' },
  run: (values, services, caller) => {
    const config = services.config(caller);
    const { data } = services.presets(caller).load(values.preset!);
    const applied: string[] = []; const failed: string[] = []; const skipped: string[] = [];
    const set = (key: ConfigKey, value: unknown): void => {
      try { config.setDynamic(key, value); applied.push(key); } catch { failed.push(key); }
    };
    for (const section of ['display', 'behavior'] as const) {
      const part = data[section] as Record<string, unknown> | undefined;
      if (!part) continue;
      const keys = SECTION_KEYS(section);
      const known = new Set(keys.map((key) => key.split('.')[1]));
      for (const field of Object.keys(part)) if (!known.has(field)) skipped.push(`${section}.${field}`);
      for (const key of keys) { const field = key.split('.')[1]!; if (Object.hasOwn(part, field)) set(key, part[field]); }
    }
    if (data.provider) {
      for (const field of Object.keys(data.provider)) if (!PROVIDER_FIELDS.has(field)) skipped.push(`provider.${field}`);
      if (data.provider.model !== undefined) set('provider.model' as ConfigKey, data.provider.model);
      if (data.provider.reasoningEffort !== undefined) set('provider.reasoningEffort' as ConfigKey, data.provider.reasoningEffort);
    }
    if (applied.length === 0 && failed.length > 0) throw new CapabilityRefusal(`Preset ${values.preset} was not loaded: these settings were refused: ${failed.join(', ')}.`);
    return {
      text: [`Loaded preset ${values.preset}: ${applied.length} setting(s).`, ...(failed.length > 0 ? [`Not taken: ${failed.join(', ')}.`] : []), ...(skipped.length > 0 ? [`Not taken from a preset by this version: ${skipped.join(', ')}.`] : [])].join('\n'),
      data: { preset: values.preset, applied, failed, skipped },
    };
  },
});
export const PRESETS_SAVE = change({
  id: 'presets.save', actionId: 'save', label: 'Save your settings as a preset', word: 'save', repeat: 'safe',
  inputs: [wordsInput({ id: 'name', label: 'Name', help: 'What to call it; a preset of that name is replaced', why: 'a name you choose', typed: { position: 1 } })],
  sentence: 'Your display, model and behaviour settings now are saved as preset {name}, until you change it.', undoneBy: 'delete', example: { name: 'focus' },
  run: (values, services, caller) => {
    const config = services.config(caller);
    const section = (keys: readonly ConfigKey[]) => Object.fromEntries(keys.map((key) => [key.split('.')[1]!, config.get(key)]));
    const data: ProfileData = {
      display: section(SECTION_KEYS('display')) as unknown as NonNullable<ProfileData['display']>,
      provider: { model: config.get('provider.model' as ConfigKey) as string, reasoningEffort: config.get('provider.reasoningEffort' as ConfigKey) as NonNullable<ProfileData['provider']>['reasoningEffort'] },
      behavior: section(SECTION_KEYS('behavior')) as unknown as NonNullable<ProfileData['behavior']>,
    };
    const presets = services.presets(caller);
    presets.save(values.name!, data);
    return { text: `Saved your settings as preset ${presets.storedName(values.name!) ?? values.name}.`, data: { preset: presets.storedName(values.name!) ?? values.name } };
  },
});
export const PRESETS_DELETE = change({
  id: 'presets.delete', actionId: 'delete', label: 'Delete a preset', word: 'delete', inputs: [PRESET], risk: 'cannot-be-undone',
  sentence: 'Preset {preset} is deleted; your settings stay as they are.', example: { preset: 'focus' },
  run: (values, services, caller) => {
    if (!services.presets(caller).delete(values.preset!)) throw new CapabilityRefusal(`No preset named ${values.preset}.`, undefined, 'NOT_FOUND');
    return { text: `Deleted preset ${values.preset}.`, data: { preset: values.preset } };
  },
});
export const PRESETS_EXPORT = change({
  id: 'presets.export', actionId: 'export', label: 'Save your presets to a file', word: 'export', lasts: 'not-a-change',
  inputs: [PRESETS_FILE, fixedInput({ id: 'overwrite', label: 'If the file exists', help: 'Keep it, or write over it', choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }], typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'keep it and stop' } })],
  sentence: 'Every preset is written to {path}, to bring to another machine.', example: { path: 'presets.json' },
  run: (values, services, caller) => {
    const target = services.resolvePath(caller, values.path!);
    if (existsSync(target) && values.overwrite !== 'yes') throw new CapabilityRefusal(`${target} already exists; nothing was written.`, 'Choose "Write over it" to replace it.');
    const presets = services.presets(caller);
    const profiles = presets.list().map((profile) => { const loaded = presets.load(profile.name); return { name: profile.name, timestamp: loaded.timestamp, data: loaded.data } satisfies ProfileBundleEntry; });
    const bundle: ProfileSyncBundle = { version: 1, exportedAt: Date.now(), profiles };
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    recordSettingsSyncEvent({ surface: 'profiles', direction: 'export', path: target, timestamp: Date.now(), detail: `${profiles.length} profiles exported` }, services.config(caller).getControlPlaneConfigDir());
    return { text: `Saved ${profiles.length} preset${profiles.length === 1 ? '' : 's'} to ${target}.`, data: { file: target, presets: profiles.length } };
  },
});
export const PRESETS_INSPECT = read({
  id: 'presets.inspect', actionId: 'inspect', label: 'Check a presets file', word: 'inspect', inputs: [PRESETS_FILE],
  sentence: 'Shows what the presets file {path} holds, without adding anything.', example: { path: 'presets.json' },
  run: (values, services, caller) => {
    const path = services.resolvePath(caller, values.path!);
    const bundle = readJsonFile(path, 'a presets file') as Partial<ProfileSyncBundle>;
    const profiles = Array.isArray(bundle.profiles) ? bundle.profiles : [];
    return {
      text: ['Presets file', `  saved: ${typeof bundle.exportedAt === 'number' ? new Date(bundle.exportedAt).toISOString() : 'not said'}`, `  presets: ${profiles.length}`, `  in use when saved: ${bundle.activeProfile ?? 'none'}`].join('\n'),
      data: { presets: profiles.map((entry) => (entry as { name?: unknown }).name).filter((name): name is string => typeof name === 'string') },
    };
  },
});
export const PRESETS_IMPORT = change({
  id: 'presets.import', actionId: 'import', label: 'Add presets from a file', word: 'import', repeat: 'unsafe',
  inputs: [
    PRESETS_FILE,
    wordsInput({ id: 'prefix', label: 'Name prefix', help: 'A word put before each name, so none clash with yours', why: 'a word you choose', typed: { flag: '--prefix' }, optional: { default: '', means: 'their own names' } }),
    fixedInput({ id: 'overwrite', label: 'If a name is taken', help: 'One of your presets may have the same name', choices: [{ value: 'no', label: 'Stop and say so' }, { value: 'yes', label: 'Replace yours', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }], typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'stop and say so' } }),
  ],
  sentence: 'The presets in {path} are added to yours, until you change it.', undoneBy: 'delete', example: { path: 'presets.json', prefix: 'laptop' },
  run: (values, services, caller) => {
    const presets = services.presets(caller);
    const configDir = services.config(caller).getControlPlaneConfigDir();
    const target = services.resolvePath(caller, values.path!);
    const overwrite = values.overwrite === 'yes';
    const prefix = values.prefix?.trim() ?? '';
    const bundle = readJsonFile(target, 'a presets file') as Partial<ProfileSyncBundle>;
    if (!Array.isArray(bundle.profiles)) throw new CapabilityRefusal(`${target} is not a presets file (no "profiles" list); nothing was changed.`);
    const invalid = bundle.profiles.findIndex((entry) => {
      const item = entry as { name?: unknown; data?: unknown } | null;
      return typeof item?.name !== 'string' || item.name.trim() === '' || typeof item.data !== 'object' || item.data === null;
    });
    if (invalid >= 0) throw new CapabilityRefusal(`Preset ${invalid + 1} in the file has no name or settings; nothing was changed.`);
    const incoming = bundle.profiles.map((entry) => ({ name: prefix ? `${prefix}-${entry.name}` : entry.name, data: entry.data }));
    const unstorable = incoming.filter((entry) => presets.storedName(entry.name) === undefined).map((entry) => entry.name);
    if (unstorable.length > 0) throw new CapabilityRefusal(`${unstorable.length} preset name(s) keep no characters once stored: ${unstorable.map((name) => JSON.stringify(name)).join(', ')}; nothing was changed.`);
    const storedAs = (name: string): string => presets.storedName(name)!;
    const seen = new Map<string, string>();
    for (const entry of incoming) {
      const first = seen.get(storedAs(entry.name));
      if (first !== undefined) throw new CapabilityRefusal(`"${first}" and "${entry.name}" are both stored as "${storedAs(entry.name)}"; nothing was changed.`);
      seen.set(storedAs(entry.name), entry.name);
    }
    const existing = new Set(presets.list().map((profile) => profile.name));
    const clashes = incoming.filter((entry) => existing.has(storedAs(entry.name))).map((entry) => storedAs(entry.name));
    if (clashes.length > 0 && !overwrite) throw new CapabilityRefusal(`${clashes.length} preset(s) already exist: ${clashes.join(', ')}; nothing was changed.`, 'Choose "Replace yours", or give a name prefix.');
    const saved: string[] = [];
    try {
      for (const entry of incoming) { presets.save(entry.name, entry.data); saved.push(entry.name); }
    } catch (error) {
      recordSettingsSyncFailure('profiles', `import stopped after ${saved.length} of ${incoming.length}: ${errorText(error)}`, configDir);
      throw new CapabilityRefusal(`Adding presets stopped (${errorText(error)}) after ${saved.length} of ${incoming.length}: ${saved.join(', ') || 'none'} saved.`);
    }
    recordSettingsSyncEvent({ surface: 'profiles', direction: 'import', path: target, timestamp: Date.now(), detail: `${incoming.length} profiles imported${prefix ? ` with prefix ${prefix}` : ''}${clashes.length > 0 ? `, ${clashes.length} replaced` : ''}` }, configDir);
    return { text: `Added ${incoming.length} preset(s) from ${target}${clashes.length > 0 ? `; replaced: ${clashes.join(', ')}` : ''}.`, data: { added: incoming.map((entry) => storedAs(entry.name)), replaced: clashes } };
  },
});

export const MANAGED_CAPABILITIES: readonly Def[] = [
  MANAGED_REVIEW, MANAGED_STAGED, MANAGED_HISTORY, MANAGED_INSPECT, MANAGED_EXPORT, MANAGED_STAGE, MANAGED_APPLY, MANAGED_APPLY_STAGED,
  MANAGED_ROLLBACK, MANAGED_LOCK, MANAGED_UNLOCK,
];
export const PRESETS_CAPABILITIES: readonly Def[] = [
  PRESETS_LIST_ALL, PRESETS_LOAD, PRESETS_SAVE, PRESETS_DELETE, PRESETS_EXPORT, PRESETS_INSPECT, PRESETS_IMPORT,
];
