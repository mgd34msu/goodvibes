/**
 * System, settings (home `daemon`): every setting listed, read, changed and put
 * back, and the voice settings kept as a file, in the daemon for every door.
 *
 * Which settings: a key the daemon owns (config-ownership.ts) is the daemon's
 * own and is read and changed through its methods (`config.set`,
 * `config.reset`, `credentials.set`), as the same caller. Any other key is held
 * by a terminal program (its settings file, `~/.goodvibes/<program>/settings.json`
 * with its project's and the shared tier): the capability takes the program as
 * an input supplied from context. The terminal program asking fills it with its
 * own name (`CapabilityCaller.program`); a caller with none (the web UI, an
 * outside agent, a script) names it, the terminal app or the Agent, with no
 * default guessed. The program reads its settings files again when they change,
 * so the change is what it runs with.
 */
import type { ConfigKey, ConfigSetting } from '../../config/schema-types.js';
import type { ConfigManager } from '../../config/manager.js';
import { readResolvedSettingLookups } from '../../runtime/settings/control-plane.js';
import { machineManagedLockFolders, managedLockRefusalText, readManagedLock, readManagedLocks } from '../../runtime/settings/host-setting-policy-read.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { PROGRAM_LIST_SETTINGS } from '../../runtime/program-host-settings.js';
import { isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import { configKeyFacts, isProtectedConfigValue } from '../../config/config-key-facts.js';
import { CONFIG_SCHEMA } from '../../config/schema.js';
import { isSecretConfigKey } from '../../config/secret-backed-config.js';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readCallerJson } from '../path-inputs.js';
import { CapabilityRefusal, type ActionValues, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';
import type { ProgramSettingsCapabilityServices } from './program-settings.js';
import { splitIncomingSettings } from '../../support/setup-transfer.js';
import { bringsSecurity, heldBackLines, incomingSecurityInput } from './incoming-settings.js';

type Services = ProgramSettingsCapabilityServices;
type Def = CapabilityDefinition<Services>;
type Program = 'tui' | 'agent';

const PROGRAM_WORDS: Readonly<Record<Program, string>> = { tui: 'the terminal app', agent: 'the Agent' };

/** The program whose settings these are: the asking program's own (from context), else the one the caller named. */
export const PROGRAM_INPUT: InputDescription = {
  id: 'program', label: 'Program', help: 'Whose settings: filled by the terminal program asking; a caller with none chooses', kind: 'choice',
  choices: [{ value: 'tui', label: 'The terminal app' }, { value: 'agent', label: 'The Agent' }],
  required: { default: '', defaultMeans: 'the program asking' }, typed: { flag: '--program' },
  // Never asked where a program asks (its place's form, its typed line): the program is the caller's. The web form,
  // which no program asks through, shows it and needs it (webui place-capabilities.ts `namedByCaller`).
  showWhen: { suppliedBy: 'the program asking' },
};

function programOf(values: ActionValues, caller: CapabilityCaller): Program {
  const named = values.program;
  if (named === 'tui' || named === 'agent') return named;
  if (named) throw new CapabilityRefusal(`${named} is not a program: the terminal app (tui) or the Agent (agent).`);
  if (caller.program) return caller.program;
  throw new CapabilityRefusal('Whose settings: name the program, the terminal app (tui) or the Agent (agent); nothing was read or changed.', undefined, 'USAGE');
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Run a daemon method as the same caller. */
async function method(caller: CapabilityCaller, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return record(await caller.method(id, body));
}

/** A setting typed as on the command line: JSON first, then true, false, a number, else the text as written. */
export function settingValueOf(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  try { return JSON.parse(trimmed) as unknown; } catch {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return text;
  }
}

const SETTING: InputDescription = {
  id: 'key', label: 'Setting', help: 'The setting, by its name', kind: 'choice',
  choices: { list: 'settings' as ListName, allowOther: { reason: 'a setting this build has added beyond the list, typed as its key' } },
  required: true, typed: { position: 1 },
};

/**
 * The settings whose change can loosen a protection, classed in one place: a key whose own facts
 * (config/config-key-facts.ts `loosens(previous, next)`) say a change to it can loosen one, and in which direction
 * (turning a listener on, a trust off, a limit up). Only a change in that direction is put to the owner, opening on
 * No; the same key moved the other way (put back to its stricter value) applies at once, for a person and a model.
 * A model's call is classed by the gate from the setting's current value (permissions/manager.ts
 * `settingsWriteLoosens`); a place asks first when the new value can loosen from any value the setting may hold now.
 */
export const PROTECTION_LOOSENING_SETTINGS: readonly string[] = CONFIG_SCHEMA
  .filter((setting) => configKeyFacts(setting.key).loosens !== undefined)
  .map((setting) => setting.key);

/** Whether moving `key` to `next` can loosen a protection: from any value it may hold now (unset, either switch, its default, another). */
export function settingChangeMayLoosen(key: string, next: unknown): boolean {
  const loosens = configKeyFacts(key).loosens;
  if (!loosens) return false;
  const fallback = CONFIG_SCHEMA.find((setting) => setting.key === key)?.default;
  const earlier: readonly unknown[] = [undefined, null, true, false, '', 0, fallback, 'another value', 1_000_000, [], {}];
  return earlier.some((previous) => JSON.stringify(previous) !== JSON.stringify(next) && loosens(previous, next));
}

const DEFAULT_OF = (key: string): unknown => CONFIG_SCHEMA.find((setting) => setting.key === key)?.default;

/**
 * The daemon's own settings (config-ownership.ts), by key, and the credentials among the settings: a form asks the
 * program only for a key that is none of these, declared as data so the web form and `capabilities.list` read it
 * without this code. A key outside the schema the daemon owns by its domain is not listed: the program is then shown,
 * and not needed, since a daemon-owned key is read and changed through the daemon whichever program is named.
 */
const DAEMON_OWNED_SETTINGS: readonly string[] = CONFIG_SCHEMA.map((setting) => setting.key).filter((key) => isDaemonOwnedConfigKey(key));
const CREDENTIAL_SETTINGS: readonly string[] = CONFIG_SCHEMA.map((setting) => setting.key).filter((key) => !isDaemonOwnedConfigKey(key) && isSecretConfigKey(key));

/** The program, asked only for a setting a program holds: the daemon's own settings and credentials are the daemon's. */
const PROGRAM_FOR_PROGRAM_SETTING: InputDescription = {
  ...PROGRAM_INPUT,
  showWhen: { input: 'key', isNoneOf: DAEMON_OWNED_SETTINGS },
};
const PROGRAM_FOR_PROGRAM_CHANGE: InputDescription = {
  ...PROGRAM_INPUT,
  showWhen: { input: 'key', isNoneOf: [...DAEMON_OWNED_SETTINGS, ...CREDENTIAL_SETTINGS] },
};

/** For a daemon-owned setting no program is needed: either program's view reads the daemon's own file. */
function programForKey(values: ActionValues, caller: CapabilityCaller): Program {
  if (isDaemonOwnedConfigKey(values.key ?? '') && !values.program && !caller.program) return 'tui';
  return programOf(values, caller);
}

/** Every setting of a program: the schema's, then its own beyond it (runtime/program-host-settings.ts). */
function programSchema(config: ConfigManager): ConfigSetting[] {
  const host = config.getHostSettingsSchema().map((setting): ConfigSetting => ({
    key: setting.key as ConfigKey, label: setting.label, type: setting.type, default: setting.default, description: setting.description,
  }));
  return [...config.getSchema(), ...host, ...PROGRAM_LIST_SETTINGS];
}

function settingOf(schema: readonly ConfigSetting[], key: string): ConfigSetting {
  const setting = schema.find((candidate) => candidate.key === key);
  if (!setting) throw new CapabilityRefusal(`No setting named ${key}; nothing was read or changed.`);
  return setting;
}

/** What a settings screen shows beside a value: where it comes from, and a lock or a disagreement that holds it. */
interface SettingFacts {
  readonly source: string;
  readonly effectiveSource?: string | undefined;
  readonly locked?: boolean | undefined;
  readonly lockReason?: string | undefined;
  readonly conflict?: boolean | undefined;
  /** Why the policy that decides a lock could not be read; the value is shown, its locks are not known. */
  readonly policyUnreadable?: string | undefined;
}

/** One read of the program's managed policy and settings layers for every row (never one read per setting). */
function settingFactsReader(config: ConfigManager): (key: string) => SettingFacts {
  const hostKeys = new Set(config.getHostSettingsSchema().map((setting) => setting.key));
  let lookup: ((key: ConfigKey) => { readonly entry: { readonly effectiveSource?: string; readonly locked?: boolean; readonly lockReason?: string; readonly conflict?: boolean } } | null) | undefined;
  let policyProblem: string | undefined;
  try { lookup = readResolvedSettingLookups(config); } catch (error) { policyProblem = errorText(error); }
  let hostLocks: ReadonlyMap<string, { readonly source: string; readonly reason: string }> | undefined;
  let hostProblem: string | undefined;
  if (hostKeys.size > 0) {
    try { hostLocks = config.readHostManagedSettingLocks(); } catch (error) { hostProblem = errorText(error); }
  }
  return (key) => {
    const source = String(isDaemonOwnedConfigKey(key) ? 'daemon' : config.sourceOf(key as ConfigKey));
    if (hostKeys.has(key)) {
      const lock = hostLocks?.get(key);
      return { source, ...(lock ? { locked: true, lockReason: `${lock.source}: ${lock.reason}`, effectiveSource: 'managed' } : {}), ...(hostProblem ? { policyUnreadable: hostProblem } : {}) };
    }
    if (policyProblem) return { source, policyUnreadable: policyProblem };
    const entry = lookup?.(key as ConfigKey)?.entry;
    return {
      source,
      ...(entry?.effectiveSource ? { effectiveSource: entry.effectiveSource } : {}),
      ...(entry?.locked ? { locked: true } : {}),
      ...(entry?.lockReason ? { lockReason: entry.lockReason } : {}),
      ...(entry?.conflict ? { conflict: true } : {}),
    };
  };
}

/**
 * A write of a setting locked as managed anywhere on this machine (host-setting-policy-read.ts readManagedLocks), refused
 * before anything is asked: at `capabilities.run` before the owner is put a question, in the program's `capability_run`
 * before its gate decides it. The write's own settings manager refuses it again with the same sentence.
 */
export function lockedSettingRefusal(key: string | undefined): CapabilityRefusal | undefined {
  if (!key) return undefined;
  let lock: ReturnType<typeof readManagedLock>;
  try { lock = readManagedLock(key, machineManagedLockFolders()); }
  catch (error) { return new CapabilityRefusal(`Nothing was changed: ${errorText(error)}`, undefined, 'CONFIG_MANAGED', 403); }
  return lock ? new CapabilityRefusal(managedLockRefusalText(lock, isSecretConfigKey(key)), `Ask the owner: only the owner removes the lock ${lock.source} set`, 'CONFIG_MANAGED', 403) : undefined;
}

/**
 * A file of settings (an import, a sync bundle) that holds a setting locked as managed: refused whole, before anything
 * is asked, with each lock's sentence. `differs` says whether the file's value would change the key (a pull leaves a
 * value equal to the present one alone); absent, every locked key in the file counts.
 */
export function lockedFileSettingsRefusal(file: string, entries: readonly { readonly key: string; readonly value: unknown }[],
  differs: (key: string, value: unknown) => boolean = () => true): CapabilityRefusal | undefined {
  let locks: ReturnType<typeof readManagedLocks>;
  try { locks = readManagedLocks(machineManagedLockFolders()); }
  catch (error) { return new CapabilityRefusal(`Nothing was applied from ${file}: ${errorText(error)}`, undefined, 'CONFIG_MANAGED', 403); }
  const held = entries.flatMap(({ key, value }) => {
    const lock = locks.get(key);
    return lock && differs(key, value) ? [managedLockRefusalText(lock, isSecretConfigKey(key))] : [];
  });
  return held.length > 0
    ? new CapabilityRefusal(`Nothing was applied from ${file}: it holds ${held.length === 1 ? 'a setting' : `${held.length} settings`} locked as managed. ${held.join(' ')}`,
      'Take the locked settings out of the file, or ask the owner to remove the lock', 'CONFIG_MANAGED', 403)
    : undefined;
}

/** A program's own setting changed through the daemon: every screen showing that program's settings reads them again. */
function programSettingChanged(key: string): void {
  noteListChanged({ list: 'settings', change: 'changed', id: key });
}

const line = (setting: ConfigSetting, value: unknown): string => `  ${setting.label} · ${setting.key} = ${JSON.stringify(value) ?? String(value)}`;

/** What a value is shown as: a credential never by its value. */
const shown = (key: string, value: unknown): unknown => (isSecretConfigKey(key) && typeof value === 'string' && value !== '' && !value.startsWith('goodvibes://') ? '(hidden)' : value);

export const SETTINGS_LIST: Def = {
  capability: { id: 'settings.list', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'list', label: 'List my settings, or the settings that mention some words', word: 'list',
  inputs: [
    { id: 'words', label: 'Matching', help: 'Words a setting\'s name, key or description must hold', kind: 'text', freeTextReason: 'any words to narrow the list', required: { default: '', defaultMeans: 'every setting' }, typed: { tail: true } },
    PROGRAM_INPUT,
  ],
  sentence: 'Shows every setting whose name, key or description mentions {words}, with its value, as the program reads it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { words: 'sandbox' },
  async run(values, services, caller) {
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    const q = (values.words ?? '').trim().toLowerCase();
    const rows = programSchema(config).filter((setting) => !setting.deprecated && (!q || `${setting.label} ${setting.key} ${setting.description}`.toLowerCase().includes(q)));
    if (rows.length === 0) return { text: `No setting matches "${values.words}".`, data: { program, settings: [] } };
    const facts = settingFactsReader(config);
    // A program's own leaf with nothing stored under it reads as its default, not as a failure of the whole list.
    const read = (setting: ConfigSetting): unknown => { try { return config.get(setting.key); } catch { return setting.default; } };
    return {
      text: [`${rows.length} setting(s)${q ? ` matching "${values.words}"` : ''}, as ${PROGRAM_WORDS[program]} reads them:`, ...rows.map((setting) => line(setting, shown(setting.key, read(setting))))].join('\n'),
      // Each value with where it comes from and what holds it, so a settings screen shows them without reading files itself.
      data: { program, settings: rows.map((setting) => ({ key: setting.key, label: setting.label, value: shown(setting.key, read(setting)), ...facts(setting.key) })) },
    };
  },
};

export const SETTINGS_GET: Def = {
  capability: { id: 'settings.get', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'get', label: 'What a setting is set to: see its value', word: 'get', inputs: [SETTING, PROGRAM_FOR_PROGRAM_SETTING],
  sentence: 'Shows what one GoodVibes setting ({key}) is set to: its value, where the value is set, and what the setting does.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { key: 'display.showThinking' },
  async run(values, services, caller) {
    const program = programForKey(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    const setting = settingOf(programSchema(config), values.key!);
    let stored: unknown;
    try { stored = config.get(setting.key); } catch { stored = setting.default; }
    const value = shown(setting.key, stored);
    return {
      text: [setting.label, line(setting, value), `  set in: ${isDaemonOwnedConfigKey(setting.key) ? 'the daemon\'s settings' : String(config.sourceOf(setting.key))}`, `  ${setting.description}`].join('\n'),
      data: { program, key: setting.key, value },
    };
  },
};

export const SETTINGS_SET: Def = {
  capability: { id: 'settings.set', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'set', label: 'Change a setting to a new value', word: 'set',
  // Typed hidden only for a setting that holds a password or key; any other setting's value shows as it is typed.
  inputs: [SETTING, { id: 'value', label: 'Value', help: 'The new value; hidden as you type when the setting holds a password or key', kind: 'secret', required: true, typed: { tail: true }, plainWhen: (earlier) => Boolean(earlier.key) && !isSecretConfigKey(earlier.key!) }, PROGRAM_FOR_PROGRAM_CHANGE],
  sentence: 'The setting {key} will hold the value given {lasts}; a password or key goes to the secret store, never into a settings file.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'reset',
  // Asked first only when the new value moves the setting the way that loosens it (sandbox off, a listener opened).
  loosensIf: (values) => Boolean(values.key) && !isSecretConfigKey(values.key!) && settingChangeMayLoosen(values.key!, settingValueOf(values.value ?? '')),
  // A setting that holds a credential: its new value is a secret written to the secret store (the writes-a-secret
  // class of the one owner decision), so anyone but the owner in person is put to the owner, once, before it runs.
  secretWhen: { input: 'key', values: CONFIG_SCHEMA.filter((setting) => isSecretConfigKey(setting.key)).map((setting) => setting.key) },
  // A locked setting is refused before any question.
  check: (values) => lockedSettingRefusal(values.key),
  question: 'Set {key} to {value}?',
  example: { key: 'display.themeMode', value: 'light' },
  async run(values, services, caller) {
    const key = values.key!;
    const raw = values.value ?? '';
    // A credential: stored by the daemon, which reads it back and then points the setting at it.
    if (isSecretConfigKey(key)) {
      if (raw.trim() === '') throw new CapabilityRefusal(`Nothing was changed: ${key} holds a credential, and an empty value would remove it; putting the setting back to its default (settings.reset) removes it.`);
      await method(caller, 'credentials.set', { key, value: raw });
      return { text: `Set ${key}: stored in the secret store (value hidden); the setting holds a reference to it, never the value.`, data: { key } };
    }
    const value = settingValueOf(raw);
    if (isDaemonOwnedConfigKey(key)) {
      const answer = await method(caller, 'config.set', { key, value });
      if (answer.code === 'OWNER_APPROVAL_PENDING') return { text: `${key} loosens a protection: it is put to the owner, and changed once the owner approves it.`, data: { key, pending: true } };
      return { text: `Set ${key} on the daemon: ${JSON.stringify(answer.value ?? value)}.`, data: { key, value: answer.value ?? value } };
    }
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    settingOf(programSchema(config), key);
    let before: unknown;
    try { before = config.get(key as ConfigKey); } catch { before = undefined; }
    try {
      config.setDynamic(key as ConfigKey, value as never);
    } catch (error) {
      throw new CapabilityRefusal(`Could not set ${key}; nothing was changed: ${errorText(error)}.`);
    }
    const after = config.get(key as ConfigKey);
    programSettingChanged(key);
    return { text: `Set ${key} for ${PROGRAM_WORDS[program]}: ${JSON.stringify(before)} → ${JSON.stringify(after)}.`, data: { program, key, value: after } };
  },
};

export const SETTINGS_RESET: Def = {
  capability: { id: 'settings.reset', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'reset', label: 'Put a setting back to its default', word: 'reset', inputs: [SETTING, PROGRAM_FOR_PROGRAM_SETTING],
  sentence: '{key} goes back to its default {lasts}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  // Asked first only when the default is the looser value (a default seldom is: putting a protection back applies at once).
  loosensIf: (values) => Boolean(values.key) && settingChangeMayLoosen(values.key!, DEFAULT_OF(values.key!)),
  // A setting that holds a credential has no default but none: its reset removes the stored secret, which only giving
  // it again brings back. A model's or an outside caller's reset of one is put to the owner, opening on No.
  irreversibleWhen: { input: 'key', values: CONFIG_SCHEMA.filter((setting) => isSecretConfigKey(setting.key)).map((setting) => setting.key) },
  // What will really happen for such a key, in the one sentence the card shows: the secret goes, and no copy is kept.
  sentenceWhen: {
    input: 'key', values: CONFIG_SCHEMA.filter((setting) => isSecretConfigKey(setting.key)).map((setting) => setting.key),
    // The card's risk line beside it says "GoodVibes keeps no copy." (a run that cannot be undone).
    sentence: 'The secret stored for {key} is removed from the secret store; only giving it again brings it back.',
  },
  // A locked setting is refused before any question.
  check: (values) => lockedSettingRefusal(values.key),
  question: 'Put {key} back to its default?',
  example: { key: 'display.showThinking' },
  async run(values, services, caller) {
    const key = values.key!;
    // A credential's default is none: the stored secret is removed, then the reference to it.
    if (isSecretConfigKey(key)) {
      const answer = await method(caller, 'credentials.delete', { key });
      return {
        text: answer.cleared === false ? `${key} held no stored credential; it is not set.` : `${key} is removed from the secret store; it is not set.`,
        data: { key, value: '', cleared: answer.cleared !== false },
      };
    }
    if (isDaemonOwnedConfigKey(key)) {
      const answer = await method(caller, 'config.reset', { key });
      if (answer.code === 'OWNER_APPROVAL_PENDING') return { text: `${key} loosens a protection: it is put to the owner, and put back once the owner approves it.`, data: { key, pending: true } };
      return { text: `${key} is back to its default on the daemon: ${JSON.stringify(answer.value)}.`, data: { key, value: answer.value } };
    }
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    const setting = settingOf(programSchema(config), key);
    try { config.reset(setting.key); } catch (error) { throw new CapabilityRefusal(`Could not put ${key} back; nothing was changed: ${errorText(error)}.`); }
    programSettingChanged(key);
    return { text: `${setting.label} (${setting.key}) is back to its default for ${PROGRAM_WORDS[program]}: ${JSON.stringify(config.get(setting.key))}.`, data: { program, key } };
  },
};

// ---------------------------------------------------------------------------
// The voice settings as a file: voice.export, voice.inspect, voice.import
// ---------------------------------------------------------------------------

/**
 * A portable copy of the voice settings: always-speak (`ui.voiceEnabled`),
 * speech output (`tts.*`) and wake-word listening (`voice.wake.*`).
 * Credentials and daemon-owned keys (`voice.local.*`) are never carried.
 */
export interface VoiceBundle {
  readonly version: 2;
  readonly exportedAt: number;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** A setting a voice bundle carries. */
export function isVoiceBundleKey(key: string): boolean {
  if (key !== 'ui.voiceEnabled' && !key.startsWith('tts.') && !key.startsWith('voice.wake.')) return false;
  return !isDaemonOwnedConfigKey(key) && !isProtectedConfigValue(key);
}

/** The bundle a file holds, or why it is not one. Version 1 files carried only `enabled`. */
export function readVoiceBundle(value: unknown): { readonly bundle: VoiceBundle } | { readonly problem: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'That file is not a voice bundle (expected a JSON object).' };
  const b = value as Record<string, unknown>;
  const exportedAt = b['exportedAt'];
  if (typeof exportedAt !== 'number' || Number.isNaN(new Date(exportedAt).getTime())) {
    return { problem: 'That file is not a voice bundle (exportedAt is missing or not a time).' };
  }
  if (b['version'] === 1) {
    if (typeof b['enabled'] !== 'boolean') return { problem: 'That version 1 voice bundle has no enabled flag.' };
    return { bundle: { version: 2, exportedAt, settings: { 'ui.voiceEnabled': b['enabled'] } } };
  }
  if (b['version'] !== 2) return { problem: `That voice bundle is version ${String(b['version'])}; this build reads versions 1 and 2.` };
  const settings = b['settings'];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { problem: 'That voice bundle has no settings object.' };
  const foreign = Object.keys(settings).filter((key) => !isVoiceBundleKey(key));
  if (foreign.length > 0) return { problem: `That voice bundle carries settings that are not voice settings: ${foreign.join(', ')}.` };
  return { bundle: { version: 2, exportedAt, settings: settings as Record<string, unknown> } };
}

export function inspectVoiceBundle(value: unknown): string {
  const read = readVoiceBundle(value);
  if ('problem' in read) return read.problem;
  const entries = Object.entries(read.bundle.settings);
  return [
    `The file holds ${entries.length} voice setting${entries.length === 1 ? '' : 's'}, saved ${new Date(read.bundle.exportedAt).toISOString()}; nothing was applied.`,
    ...entries.map(([key, setting]) => `  ${key} = ${JSON.stringify(setting)}`),
  ].join('\n');
}

const VOICE_FILE = (help: string): InputDescription => ({
  id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 },
});

/** A voice settings file; never the system's or the parser's words (capabilities/path-inputs.ts). */
function readVoiceFile(target: string, caller: CapabilityCaller): unknown {
  return readCallerJson(target, 'a voice settings file', caller, 'Nothing was read.');
}

export const VOICE_EXPORT: Def = {
  capability: { id: 'voice.export', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'export', label: 'Save your voice settings to a file', word: 'export', inputs: [{ ...VOICE_FILE('Where to write them'), file: 'written' }, PROGRAM_INPUT],
  sentence: 'The voice settings you changed from their defaults are written to {path}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'voice.json' },
  async run(values, services, caller) {
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    const target = services.programSettings.resolvePath(caller, values.path!);
    const settings: Record<string, unknown> = {};
    for (const setting of config.getSchema()) {
      if (!isVoiceBundleKey(setting.key)) continue;
      const value = config.get(setting.key);
      if (JSON.stringify(value) !== JSON.stringify(setting.default)) settings[setting.key] = value;
    }
    const bundle: VoiceBundle = { version: 2, exportedAt: Date.now(), settings };
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
    const count = Object.keys(settings).length;
    return { text: `Voice settings written to ${target} (${count} changed voice setting${count === 1 ? '' : 's'}).`, data: { path: target, settings: count } };
  },
};

export const VOICE_INSPECT: Def = {
  capability: { id: 'voice.inspect', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'inspect', label: 'Read a voice settings file', word: 'inspect', inputs: [VOICE_FILE('The file to read')],
  sentence: 'Shows the settings in {path} without applying them.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'voice.json' },
  async run(values, services, caller) {
    return { text: inspectVoiceBundle(readVoiceFile(services.programSettings.resolvePath(caller, values.path!), caller)) };
  },
};

export const VOICE_IMPORT: Def = {
  capability: { id: 'voice.import', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'import', label: 'Apply voice settings from a file', word: 'import', inputs: [VOICE_FILE('The file to apply'), incomingSecurityInput('Apply them too'), PROGRAM_INPUT],
  sentence: 'The voice settings in {path} are applied until you change it; one that loosens a protection only if you choose to apply those too.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'voice.json' },
  async run(values, services, caller) {
    const program = programOf(values, caller);
    const config = services.programSettings.config({ ...caller, program });
    const target = services.programSettings.resolvePath(caller, values.path!);
    const read = readVoiceBundle(readVoiceFile(target, caller));
    if ('problem' in read) throw new CapabilityRefusal('Nothing was applied. ' + read.problem);
    // One rule for every import of settings: what loosens a protection is held back unless chosen (incoming-settings.ts).
    const split = splitIncomingSettings((key: ConfigKey) => config.get(key),
      Object.entries(read.bundle.settings).map(([key, setting]) => ({ key: key as ConfigKey, value: setting })), bringsSecurity(values));
    const held = heldBackLines(split.heldBack, 'apply the file again choosing to apply them too');
    if (split.apply.length === 0) {
      return { text: [`No voice setting was applied for ${PROGRAM_WORDS[program]} from ${target}.`, ...held].join('\n'), data: { program, saved: 0, heldBack: split.heldBack.map((change) => change.key) } };
    }
    const result = config.setMany(split.apply.map((change) => ({ key: change.key, value: change.next })), localOwnerActor());
    if (!result.ok) throw new CapabilityRefusal(`Voice settings not applied: ${result.refusal.reason}`, result.refusal.next[0]);
    return {
      text: [`Voice settings applied for ${PROGRAM_WORDS[program]}: ${result.saved.length} setting${result.saved.length === 1 ? '' : 's'} from ${target}.`, ...held].join('\n'),
      data: { program, saved: result.saved.length, heldBack: split.heldBack.map((change) => change.key) },
    };
  },
};

// ---------------------------------------------------------------------------
// The terminal app's settings, given to the Agent: settings.copy-from-terminal-app
// ---------------------------------------------------------------------------

/** The families of settings the Agent takes from the terminal app: the ones both programs read the same way. */
const COPIED_FROM_THE_TERMINAL_APP = ['display.', 'provider.', 'behavior.', 'storage.', 'permissions.', 'ui.', 'tts.', 'surfaces.', 'helper.', 'tools.', 'release.', 'automation.'] as const;

/**
 * A project's settings file travels with a cloned repository, so a value it holds for these is never copied: it would
 * change what may run, whether GoodVibes asks first, or where data goes. The same setting in your own settings is.
 */
const NEVER_FROM_A_PROJECT = ['permissions.', 'behavior.hitlMode', 'provider.', 'tools.', 'surfaces.', 'automation.', 'helper.'] as const;

export const SETTINGS_COPY_FROM_TERMINAL_APP: Def = {
  capability: { id: 'settings.copy-from-terminal-app', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'copy-from-terminal-app', label: 'Give the Agent the settings the terminal app has', word: 'copy-from-terminal-app',
  inputs: [incomingSecurityInput('Copy them too')],
  sentence: 'Each setting you set in the terminal app (in your own settings, or this project\'s where a project may set it) that the Agent holds differently is set the same in the Agent, until you change it; one that loosens a protection is copied only if you choose to copy those too.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: {},
  async run(values, services, caller) {
    const from = services.programSettings.config({ ...caller, program: 'tui' });
    const to = services.programSettings.config({ ...caller, program: 'agent' });
    const incoming: { key: ConfigKey; value: unknown }[] = [];
    for (const setting of CONFIG_SCHEMA) {
      const key = setting.key;
      if (setting.deprecated || isDaemonOwnedConfigKey(key) || !COPIED_FROM_THE_TERMINAL_APP.some((family) => key.startsWith(family))) continue;
      // Only what the terminal app has set itself: its shipped default, and the tiers both programs read, are the Agent's already.
      const tier = from.sourceOf(key);
      if (tier !== 'global' && (tier !== 'project' || NEVER_FROM_A_PROJECT.some((family) => key.startsWith(family)))) continue;
      let value: unknown;
      try { value = from.get(key); } catch { continue; }
      let current: unknown;
      try { current = to.get(key); } catch { current = undefined; }
      if (JSON.stringify(value) !== JSON.stringify(current)) incoming.push({ key, value });
    }
    // One rule for every import of settings: what loosens a protection is held back unless chosen (incoming-settings.ts).
    const split = splitIncomingSettings((key: ConfigKey) => to.get(key), incoming, bringsSecurity(values));
    const held = heldBackLines(split.heldBack, 'copy again choosing to copy them too');
    if (split.apply.length === 0) {
      return {
        text: [held.length > 0 ? 'No setting was copied to the Agent.' : 'The Agent already has every setting the terminal app has; nothing was copied.', ...held].join('\n'),
        data: { copied: [], heldBack: split.heldBack.map((change) => change.key) },
      };
    }
    const result = to.setMany(split.apply.map((change) => ({ key: change.key, value: change.next })), localOwnerActor());
    if (!result.ok) throw new CapabilityRefusal(`Nothing was copied: ${result.refusal.reason}`, result.refusal.next[0]);
    for (const change of split.apply) programSettingChanged(change.key);
    return {
      text: [
        `Copied ${split.apply.length} setting${split.apply.length === 1 ? '' : 's'} from the terminal app to the Agent:`,
        ...split.apply.map((change) => `  ${change.key} = ${JSON.stringify(shown(change.key, change.next))}`),
        ...held,
      ].join('\n'),
      data: { copied: split.apply.map((change) => change.key), heldBack: split.heldBack.map((change) => change.key) },
    };
  },
};

/** Every capability of this file, with the command it came from. */
export const SYSTEM_SETTINGS_CAPABILITIES: readonly { readonly definition: Def; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...[SETTINGS_LIST, SETTINGS_GET, SETTINGS_SET, SETTINGS_RESET, SETTINGS_COPY_FROM_TERMINAL_APP].map((definition) => ({ definition, command: { name: 'settings', title: 'Settings' } })),
  ...[VOICE_EXPORT, VOICE_INSPECT, VOICE_IMPORT].map((definition) => ({ definition, command: { name: 'voice', title: 'Voice' } })),
];
