/**
 * settings-carry-forward.ts: what an earlier release left in a settings file
 * that this release keeps elsewhere or no longer has.
 *
 * Two kinds of stale key are carried forward once, by the manager that owns
 * the file (ConfigManager.load), and the owner is told once what moved or went:
 *
 * - a key only the daemon's settings file sets (config-ownership.ts), found in
 *   a program's own settings file: moved to the daemon's file when that file
 *   does not set it, and removed from the program's file either way;
 * - a key a release since 3.0.0 declared and this release does not
 *   (RETIRED_SETTING_KEYS, read from the settings schema of every release):
 *   removed from the file.
 *
 * A key 3.5.0 declared and this release does not (SETTINGS_KEPT_FOR_ROLLBACK)
 * is neither: it stays in the file untouched and is read past in silence, so
 * a rollback to 3.5.0 still reads it.
 *
 * Any other key this build does not know was typed by someone (a misspelling,
 * a key from a newer version): it is left in the file and reported once
 * (manager-ingestion.ts), never rewritten here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectDaemonOwnedEntries, persistDaemonKey, readDaemonTierFile, removeDaemonKey } from './daemon-config-tier.js';
import { readDotPath } from './shared-config-tier.js';
import { deleteRawDotPath } from './settings-io.js';
import { coreConfigDefaults } from './schema-domain-core.js';
import { GATE_PRESETS, parsePermissionMode } from '../gate/presets.js';

/**
 * A managed lock as a carry reads it (ConfigManager `#lockedValue`): undefined when `key` is not locked; `{ value }`
 * when it is and the value it holds is known (the locking program's own value, or the managed bundle's); null when it
 * is locked and that value is not known. A carry never writes a locked key with anything but the value its lock holds:
 * with that value known it writes that value, with it unknown it leaves the key as it is.
 */
export type LockedValue = (key: string) => { readonly value: unknown } | null | undefined;
const NOT_LOCKED: LockedValue = () => undefined;

/**
 * Settings keys a release from 3.0.0 to 3.4.2 declared that this release does
 * not, so a file can only hold them because an earlier release wrote them or
 * its owner set them then. Read from the `key:` rows of every release's
 * settings schema (platform/config/schema-domain-*.ts and the programs' host
 * settings) against this release's. The daemon-owned paths that are not
 * settings rows (`email.passwordRef`, `email.smtpPasswordRef`,
 * `google.oauth.refreshToken`) are still read and are not on this list.
 */
export const RETIRED_SETTING_KEYS: readonly string[] = [
  'behavior.suggestAlternativeOnProviderFail',
  'behavior.terminalNotifyTurnEnd',
  'controlPlane.allowRemote',
  'email.draftsMailbox',
  'email.enabled',
  'email.fromAddress',
  'email.imapHost',
  'email.imapPort',
  'email.imapSecurity',
  'email.mailbox',
  'email.smtpHost',
  'email.smtpPort',
  'email.smtpSecurity',
  'email.username',
  'google.credentials.migratedFrom',
  'judgment.decisionDeadlineMs',
  'notifications.burstCooldownMs',
  'notifications.burstWindowMs',
  'permissions.backgroundAgents',
  'push.subscriptions.sweepIntervalMinutes',
  'release.channel',
  'sandbox.replIsolation',
  'sandbox.vmBackend',
  'sandbox.windowsMode',
  'surfaces.email.imapHost',
  'surfaces.email.imapPassword',
  'surfaces.email.imapPort',
  'surfaces.email.imapUser',
  'surfaces.email.username',
  'tools.contractVerification',
];

/**
 * Settings keys 3.5.0 declared that this release does not (read from the `key:` rows of 3.5.0's settings schema
 * against this release's). A stored value is read past in silence, never reported as an unknown setting, and left in
 * the file as it is, so a 3.5.0 program after a rollback still reads it. Nothing in this release reads them.
 * - `contract.heartbeatTimeoutMs`: a step's silence limit; no step is stopped for being quiet now.
 * - `contract.gateTimeoutMs`: the gate command limit; a gate command runs until it exits.
 * - `contract.transportRetryDelayMs`: the wait before a failed step ran again; it runs again at once.
 * - `planner.wallTimeoutMs`: the longest writing a plan could take; a plan is written until it is done or stopped.
 * - `planner.adaptive`: the adaptive planner's switch, which changed nothing (a piece of work has its plan).
 */
export const SETTINGS_KEPT_FOR_ROLLBACK: readonly string[] = [
  'contract.gateTimeoutMs',
  'contract.heartbeatTimeoutMs',
  'contract.transportRetryDelayMs',
  'planner.adaptive',
  'planner.wallTimeoutMs',
];

/**
 * The `judgment.policy` values 3.5.0 and earlier stored for "no decision model is
 * used" (`Classic - Off` is its 3.2.0 name). This release does not have it: a
 * home that holds one is carried once to the mode Ask me with no decision model
 * set (ConfigManager, decision models off), so nothing is sent to one.
 */
export const RETIRED_NO_DECISION_MODEL_POLICIES: readonly string[] = ['No Decision Model', 'Classic - Off'];

/**
 * The decision-model settings a home carried from No Decision Model has moved
 * aside: taken out (so no decision model is set and nothing is sent to one) and
 * kept, as they were, under `judgment.setAside`, where choosing a decision
 * model again in Settings offers them back.
 */
export const DECISION_MODEL_SETTINGS_SET_ASIDE = ['judgment.endpoint', 'judgment.model', 'judgment.keySource', 'judgment.keyName', 'judgment.backend', 'judgment.fallbacks'] as const;

/** Where the moved-aside decision-model settings are kept (a settings key of its own, in the daemon's settings file). */
export const DECISION_MODEL_SET_ASIDE_KEY = 'judgment.setAside';

/** No decision model chosen (the carry writes it too): it wins over every decision-model setting and the environment. */
export const DECISION_MODEL_NONE_KEY = 'judgment.noDecisionModel';

/**
 * The settings folders of the programs on this machine (the terminal app's,
 * which the daemon's own settings also use, and the Agent's), under the
 * GoodVibes home: where the daemon sets the mode Ask me when it carries
 * decision models switched off forward (no decision model set).
 */
export const PROGRAM_SETTINGS_ROOTS: readonly string[] = ['tui', 'agent'];

/**
 * Daemon keys a program's own settings file held in 3.5.0, which that program's 3.5.0 binary still reads: copied
 * into the daemon's settings file once (when it does not set them yet) and left in the program's file as they were,
 * so a 3.5.0 binary after a rollback keeps its value. This release never reads them from the program's file (the
 * daemon's is the one copy) and says nothing about them there. `behavior.budgetAlertUsd`: the terminal app's own
 * spending alert until 3.5.0, the daemon's from this release. `sandbox.mcpIsolation`: each program's own choice of
 * running MCP servers inside the sandbox until 3.5.0, the daemon's from this release, which every program follows.
 * The model, its reasoning effort, its backups, the request routing and the permission mode: each program's own
 * default until 3.5.0, one default in the daemon's file from this release (a conversation still chooses its own).
 */
export const DAEMON_KEYS_KEPT_FOR_ROLLBACK: readonly string[] = [
  'behavior.budgetAlertUsd', 'sandbox.mcpIsolation', 'sandbox.enabled', 'storage.codeIndexEnabled',
  'provider.model', 'provider.reasoningEffort', 'provider.fallbackModels', 'provider.optimizerMode', 'provider.optimizerPinnedModel', 'permissions.mode',
];

/** What carrying one file forward did, for the one line the owner reads. */
export interface SettingsCarryForward {
  /** Daemon keys written to the daemon's settings file. */
  readonly moved: readonly string[];
  /** Daemon keys written to the daemon's settings file and left in this file for an earlier version (DAEMON_KEYS_KEPT_FOR_ROLLBACK). */
  readonly copied: readonly string[];
  /** Daemon keys the daemon's file already set: its value stays, the copy went. */
  readonly superseded: readonly string[];
  /** Keys this release no longer has, removed. */
  readonly removed: readonly string[];
}

/**
 * The stale keys of `document` (a program's own settings file, parsed). With
 * `daemonTierPath`, daemon keys are moved there; without it (the daemon's own
 * file, or a daemon on another machine) only retired keys are taken out.
 * Changes `document` in place and returns what it did; the caller writes the
 * file. Throws when the daemon's file cannot be read or written, before
 * `document` is changed.
 */
export function carrySettingsForward(document: Record<string, unknown>, daemonTierPath: string | null, locked: LockedValue = NOT_LOCKED): SettingsCarryForward {
  const merged = daemonTierPath === null ? [] : [...carryMergedLists(document, daemonTierPath), ...carryMergedRecords(document, daemonTierPath)];
  const daemonEntries = daemonTierPath === null ? [] : collectDaemonOwnedEntries(document)
    .filter(({ key }) => !MERGED_DAEMON_LISTS.includes(key) && !MERGED_DAEMON_RECORDS.includes(key));
  const retired = RETIRED_SETTING_KEYS.filter((key) => readDotPath(document, key).present);
  const moved: string[] = [];
  const copied: string[] = [];
  const superseded: string[] = [];
  const kept = new Set(DAEMON_KEYS_KEPT_FOR_ROLLBACK);
  if (daemonTierPath !== null && daemonEntries.length > 0) {
    const tier = readDaemonTierFile(daemonTierPath);
    for (const { key, value } of daemonEntries) {
      // A key a program's folder locked: the value its lock holds is the one carried (and kept, if the daemon holds another).
      const lock = locked(key);
      if (lock) {
        const now = readDotPath(tier, key);
        if (!now.present || JSON.stringify(now.value) !== JSON.stringify(lock.value)) { persistDaemonKey(daemonTierPath, key, lock.value); (kept.has(key) ? copied : moved).push(key); }
        continue;
      }
      // A key kept for a rollback is copied once and then left alone: the daemon's value is the one in force.
      if (readDotPath(tier, key).present) { if (!kept.has(key)) superseded.push(key); }
      else { persistDaemonKey(daemonTierPath, key, value); (kept.has(key) ? copied : moved).push(key); }
    }
  }
  for (const { key } of daemonEntries) if (!kept.has(key)) deleteRawDotPath(document, key);
  for (const key of retired) deleteRawDotPath(document, key);
  return { moved, copied: [...merged, ...copied], superseded, removed: retired };
}

/**
 * Daemon lists each program kept a copy of until 3.5.0, carried into the daemon's one list member by member: every
 * member a program's file holds that was never carried is added after the daemon's own, so nothing is dropped when
 * the terminal app and the Agent held different lists. The program's own value stays in its file, so a 3.5.0 program
 * after a rollback still sends where it did. A member once carried is never carried again (`carried-lists.json`
 * beside the daemon's settings), so one removed in the daemon does not come back from a program's old copy.
 */
export const MERGED_DAEMON_LISTS: readonly string[] = ['notifications.webhookUrls'];

/** Where the members already carried are recorded, beside the daemon's settings file. */
export function carriedListsPath(daemonTierPath: string): string {
  return join(dirname(daemonTierPath), 'carried-lists.json');
}

function carryMergedLists(document: Record<string, unknown>, daemonTierPath: string): string[] {
  const merged: string[] = [];
  const markerPath = carriedListsPath(daemonTierPath);
  let carried: Record<string, unknown> = {};
  try { carried = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>; } catch { carried = {}; }
  let changed = false;
  for (const key of MERGED_DAEMON_LISTS) {
    const found = readDotPath(document, key);
    if (!found.present || !Array.isArray(found.value)) continue;
    const members = found.value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
    const done = new Set(Array.isArray(carried[key]) ? (carried[key] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : []);
    const fresh = members.filter((entry) => !done.has(entry));
    if (fresh.length === 0) continue;
    const tier = readDaemonTierFile(daemonTierPath);
    const current = readDotPath(tier, key);
    const list = current.present && Array.isArray(current.value) ? current.value.filter((entry): entry is string => typeof entry === 'string') : [];
    const added = fresh.filter((entry) => !list.includes(entry));
    if (added.length > 0) {
      persistDaemonKey(daemonTierPath, key, [...list, ...added]);
      merged.push(key);
    }
    carried = { ...carried, [key]: [...done, ...fresh] };
    changed = true;
  }
  if (changed) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(carried, null, 2)}\n`, { mode: 0o600 });
  }
  return merged;
}

/**
 * Daemon maps each program kept a copy of until 3.5.0 (your own model prices, keyed `provider:model`), carried into
 * the daemon's one map entry by entry: an entry a program's file holds that was never carried is added when the
 * daemon's map does not name it (the daemon's own entry wins), so nothing is dropped when the terminal app and the
 * Agent held different prices. The program's own value stays in its file for a 3.5.0 program after a rollback. An
 * entry once carried is never carried again (`carried-lists.json`), so one changed or removed in the daemon does not
 * come back from a program's old copy.
 */
export const MERGED_DAEMON_RECORDS: readonly string[] = ['pricing.modelPrices'];

function carryMergedRecords(document: Record<string, unknown>, daemonTierPath: string): string[] {
  const merged: string[] = [];
  const markerPath = carriedListsPath(daemonTierPath);
  let carried: Record<string, unknown> = {};
  try { carried = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>; } catch { carried = {}; }
  let changed = false;
  for (const key of MERGED_DAEMON_RECORDS) {
    const found = readDotPath(document, key);
    if (!found.present || found.value === null || typeof found.value !== 'object' || Array.isArray(found.value)) continue;
    const entries = Object.entries(found.value as Record<string, unknown>);
    const done = new Set(Array.isArray(carried[key]) ? (carried[key] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : []);
    const fresh = entries.filter(([name]) => !done.has(name));
    if (fresh.length === 0) continue;
    const tier = readDaemonTierFile(daemonTierPath);
    const current = readDotPath(tier, key);
    const map = current.present && current.value !== null && typeof current.value === 'object' && !Array.isArray(current.value)
      ? { ...(current.value as Record<string, unknown>) } : {};
    const added = fresh.filter(([name]) => !(name in map));
    if (added.length > 0) {
      for (const [name, value] of added) map[name] = value;
      persistDaemonKey(daemonTierPath, key, map);
      merged.push(key);
    }
    carried = { ...carried, [key]: [...done, ...fresh.map(([name]) => name)] };
    changed = true;
  }
  if (changed) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(carried, null, 2)}\n`, { mode: 0o600 });
  }
  return merged;
}

/**
 * The daemon's side of DAEMON_KEYS_KEPT_FOR_ROLLBACK, for a machine whose programs have not started since the
 * upgrade: each kept key a program's file (`programFile`) holds and the daemon's file does not is copied into the
 * daemon's file, the program's file untouched. Returns the keys copied. Throws when a file cannot be read or written.
 */
export function copyKeptProgramKeys(programFile: string, daemonTierPath: string, locked: LockedValue = NOT_LOCKED): readonly string[] {
  if (!existsSync(programFile)) return [];
  const program = JSON.parse(readFileSync(programFile, 'utf-8')) as Record<string, unknown>;
  const tier = readDaemonTierFile(daemonTierPath);
  // The lists each program kept (MERGED_DAEMON_LISTS) are merged member by member, as a program's own start does.
  const copied: string[] = [...carryMergedLists(program, daemonTierPath), ...carryMergedRecords(program, daemonTierPath)];
  for (const key of DAEMON_KEYS_KEPT_FOR_ROLLBACK) {
    // A key either program's folder locked: the value its lock holds is the one carried, whichever program is read first.
    const lock = locked(key);
    if (lock === null) continue;
    if (lock) {
      const now = readDotPath(readDaemonTierFile(daemonTierPath), key);
      if (!now.present || JSON.stringify(now.value) !== JSON.stringify(lock.value)) { persistDaemonKey(daemonTierPath, key, lock.value); copied.push(key); }
      continue;
    }
    const held = readDotPath(program, key);
    if (!held.present || readDotPath(tier, key).present) continue;
    persistDaemonKey(daemonTierPath, key, held.value);
    copied.push(key);
  }
  return copied;
}

/**
 * Kept keys (DAEMON_KEYS_KEPT_FOR_ROLLBACK) carried as the STRICTER of the programs' values, not the first program's:
 * `sandbox.mcpIsolation` is a protection, so when the terminal app ran MCP servers inside the sandbox and the Agent
 * as host processes (or the other way), the daemon keeps them inside. Each key's order of strictness, loosest first.
 */
export const STRICTER_KEPT_KEYS: Readonly<Record<string, (value: unknown) => number>> = {
  // Any containment is stricter than none (`disabled`, or no value).
  'sandbox.mcpIsolation': (value) => (typeof value === 'string' && value !== 'disabled' ? 1 : 0),
  // Commands inside the sandbox (on, the default) are stricter than on the host (false).
  'sandbox.enabled': (value) => (value === false ? 0 : 1),
};

/** Each STRICTER_KEPT_KEYS key's value in a program whose file did not set it. */
const STRICTER_KEPT_DEFAULTS: Readonly<Record<string, unknown>> = { 'sandbox.mcpIsolation': 'disabled', 'sandbox.enabled': true };

/** What carrying one stricter key did: the value kept and each program's own, for the one line the owner reads. */
export interface StricterCarry {
  readonly key: string;
  readonly kept: unknown;
  readonly held: Readonly<Record<string, unknown>>;
}

/**
 * Once per key (recorded in `carried-lists.json` as `stricter`): each program's own value of a STRICTER_KEPT_KEYS key
 * read from its settings file, and the strictest written to the daemon's file when the daemon's value is a looser one
 * a program held (the first program's, copied by the plain carry). A value the daemon's file holds that no program
 * held is the owner's own choice there, and stays. Returns, for each key whose programs held different values, what
 * was kept, so the owner is told once. Programs' files are never changed (a 3.5.0 binary after a rollback reads its
 * own). Throws when a file cannot be read or written.
 */
export function carryStricterKeptValues(programFiles: Readonly<Record<string, string>>, daemonTierPath: string, locked: LockedValue = NOT_LOCKED): readonly StricterCarry[] {
  const markerPath = carriedListsPath(daemonTierPath);
  let carried: Record<string, unknown> = {};
  try { carried = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>; } catch { carried = {}; }
  const done = new Set(Array.isArray(carried['stricter']) ? (carried['stricter'] as unknown[]).filter((key): key is string => typeof key === 'string') : []);
  const told: StricterCarry[] = [];
  const finished: string[] = [];
  for (const [key, strictness] of Object.entries(STRICTER_KEPT_KEYS)) {
    if (done.has(key)) continue;
    const held: Record<string, unknown> = {};
    let anySet = false;
    for (const [program, file] of Object.entries(programFiles)) {
      if (!existsSync(file)) continue;
      const found = readDotPath(JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>, key);
      // A program whose file does not set the key followed its default (STRICTER_KEPT_DEFAULTS).
      held[program] = found.present ? found.value : STRICTER_KEPT_DEFAULTS[key];
      if (found.present) anySet = true;
    }
    const values = Object.values(held);
    if (!anySet) continue;
    // A locked key: the value its lock holds, or (that value not known) left as it is, carried once the lock is gone.
    const lock = locked(key);
    if (lock === null) continue;
    const strictest = lock ? lock.value : values.reduce((best, value) => (strictness(value) > strictness(best) ? value : best));
    const tier = readDaemonTierFile(daemonTierPath);
    const current = readDotPath(tier, key);
    const fromAProgram = !current.present || values.some((value) => JSON.stringify(value) === JSON.stringify(current.value));
    if (lock && JSON.stringify(current.value) !== JSON.stringify(strictest)) persistDaemonKey(daemonTierPath, key, strictest);
    else if (!lock && fromAProgram && (!current.present || strictness(strictest) > strictness(current.value))) persistDaemonKey(daemonTierPath, key, strictest);
    const differ = new Set(values.map((value) => JSON.stringify(value))).size > 1;
    if (differ && fromAProgram) told.push({ key, kept: strictest, held });
    finished.push(key);
  }
  if (finished.length > 0) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ ...carried, stricter: [...done, ...finished] }, null, 2)}\n`, { mode: 0o600 });
  }
  return told;
}

/** What carrying "Use the background daemon" (`daemon.enabled`) off forward did. */
export interface DaemonOffCarry {
  /** The programs (and `daemon`, the daemon's own file) whose file had it off. */
  readonly offIn: readonly string[];
  /** "Start the daemon at login" was turned off by the carry (false: it was set already and kept). */
  readonly loginStartTurnedOff: boolean;
}

/**
 * `daemon.enabled` ("Use the background daemon") was two things until 3.5.0: a program ran without the daemon, and the
 * daemon did not start by itself. The first is gone (every program uses the daemon and starts it when it is not
 * running); what stays true of a person's "off" is the second, which "Start the daemon at login" (`service.autostart`)
 * says. So, once on this machine (recorded in `carried-lists.json` as `daemonOff`): when any program's file or the
 * daemon's own has it off, "Start the daemon at login" is turned off in the daemon's file unless the person set it there
 * already. The old key is left where it was, so a 3.5.0 program after a rollback reads it as before. Undefined when
 * nothing was carried (nobody had it off, or it was carried before). Throws when a file cannot be read or written.
 */
export function carryDaemonOffToLoginStart(programFiles: Readonly<Record<string, string>>, daemonTierPath: string, locked: LockedValue = NOT_LOCKED): DaemonOffCarry | undefined {
  const markerPath = carriedListsPath(daemonTierPath);
  let carried: Record<string, unknown> = {};
  try { carried = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>; } catch { carried = {}; }
  if (carried['daemonOff'] === true) return undefined;
  const offIn: string[] = [];
  for (const [program, file] of Object.entries(programFiles)) {
    if (!existsSync(file)) continue;
    if (readDotPath(JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>, 'daemon.enabled').value === false) offIn.push(program);
  }
  const tier = readDaemonTierFile(daemonTierPath);
  if (readDotPath(tier, 'daemon.enabled').value === false) offIn.push('daemon');
  let loginStartTurnedOff = false;
  // A managed lock on "Start the daemon at login" keeps it as it is.
  if (offIn.length > 0 && !readDotPath(tier, 'service.autostart').present && locked('service.autostart') === undefined) {
    persistDaemonKey(daemonTierPath, 'service.autostart', false);
    loginStartTurnedOff = true;
  }
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify({ ...carried, daemonOff: true }, null, 2)}\n`, { mode: 0o600 });
  return offIn.length > 0 ? { offIn, loginStartTurnedOff } : undefined;
}

/** The one line the owner is told when "Use the background daemon" was off. */
export function describeDaemonOffCarry(carry: DaemonOffCarry): string {
  const where = (program: string): string => (program === 'tui' ? 'the terminal app' : program === 'agent' ? 'the Agent' : 'the daemon\'s settings');
  const places = carry.offIn.map(where).join(' and ');
  return `"Use the background daemon" was off in ${places}. Every program now uses the daemon and starts it when it is not running, so that setting is gone. `
    + (carry.loginStartTurnedOff
      ? '"Start the daemon at login" is off instead, so the daemon does not start by itself when you sign in; System, Settings changes it. '
      : '"Start the daemon at login" keeps the value you gave it. ')
    + 'A 3.5.0 program, after going back to it, still reads its old setting.';
}

/** The one line the owner is told when the programs held different values of a protection. */
export function describeStricterCarry(carry: StricterCarry): string {
  if (carry.key === 'sandbox.mcpIsolation') {
    const inside = (value: unknown): boolean => STRICTER_KEPT_KEYS['sandbox.mcpIsolation']!(value) > 0;
    const where = (program: string): string => (program === 'tui' ? 'the terminal app' : program === 'agent' ? 'the Agent' : program);
    const holders = Object.entries(carry.held);
    const contained = holders.filter(([, value]) => inside(value)).map(([program]) => where(program));
    const host = holders.filter(([, value]) => !inside(value)).map(([program]) => where(program));
    return `Before this version ${contained.join(' and ')} ran MCP servers inside the sandbox and ${host.join(' and ')} ran them as host processes. `
      + 'The daemon now keeps one setting for every program, and it kept the stricter one: MCP servers run inside the sandbox in every program. '
      + '"Run MCP servers as host processes" in Permissions and safety, Sandbox setting, changes it.';
  }
  if (carry.key === 'sandbox.enabled') {
    const where = (program: string): string => (program === 'tui' ? 'the terminal app' : program === 'agent' ? 'the Agent' : program);
    const holders = Object.entries(carry.held);
    const inside = holders.filter(([, value]) => value !== false).map(([program]) => where(program));
    const host = holders.filter(([, value]) => value === false).map(([program]) => where(program));
    return `Before this version ${inside.join(' and ')} ran commands inside the sandbox and ${host.join(' and ')} ran them on the host. `
      + 'The daemon now keeps one setting for every program, and it kept the stricter one: commands run inside the sandbox in every program. '
      + '"Run commands on the host, with no sandbox" in Permissions and safety, Sandbox setting, changes it.';
  }
  return `Before this version the programs held different values of ${carry.key}; the daemon kept the stricter one (${JSON.stringify(carry.kept)}) for every program.`;
}

/** The keys of the one shared default the two programs each kept their own of until 3.5.0 (carrySharedDefaults). */
export const SHARED_DEFAULT_KEYS = ['provider.model', 'provider.reasoningEffort', 'permissions.mode'] as const;
export type SharedDefaultKey = typeof SHARED_DEFAULT_KEYS[number];

/** What carrying the shared defaults did: each program's own values and the ones kept. */
export interface SharedDefaultsCarry {
  readonly held: Readonly<Record<string, Readonly<Record<SharedDefaultKey, unknown>>>>;
  readonly kept: Readonly<Record<SharedDefaultKey, unknown>>;
}

const SHARED_DEFAULTS_MARKER = 'shared-defaults';

function sharedDefault(key: SharedDefaultKey): unknown {
  return readDotPath(coreConfigDefaults as unknown as Record<string, unknown>, key).value;
}

/** A permission mode's strictness, strictest first: Plan 0, Ask me 1, Jev decides and Just vibes 2, YOLO 3. */
function modeLooseness(value: unknown): number {
  switch (parsePermissionMode(value)) {
    case 'plan': return 0;
    case 'ask-me': return 1;
    case 'jev-decides': case 'just-vibes': return 2;
    case 'yolo': return 3;
    default: return 2;
  }
}

/**
 * The one shared default the daemon keeps from this release (model, its reasoning effort, permission mode), carried
 * from the two programs' own 3.5.0 defaults the same way whichever program starts first: the permission mode is the
 * STRICTER of the programs' (Plan, then Ask me, then Jev decides and Just vibes, then YOLO), the model and its effort
 * are the terminal app's (the Agent's only when the terminal app never kept a settings file). A program whose file
 * does not set a key held that key's default. Once (recorded in `carried-lists.json` as `shared-defaults`); the
 * daemon's value is changed only when it is one a program held (the first program's, copied by the plain carry) or
 * unset, never the owner's own later choice there. Programs' files are never changed (a 3.5.0 binary after a rollback
 * reads its own). Returns what each program held and what was kept when the programs held different values, so the
 * owner is told once; undefined otherwise. Throws when a file cannot be read or written.
 */
export function carrySharedDefaults(programFiles: Readonly<Record<string, string>>, daemonTierPath: string, locked: LockedValue = NOT_LOCKED): SharedDefaultsCarry | undefined {
  const markerPath = carriedListsPath(daemonTierPath);
  let carried: Record<string, unknown> = {};
  try { carried = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>; } catch { carried = {}; }
  if (carried[SHARED_DEFAULTS_MARKER] === true) return undefined;
  const held: Record<string, Record<SharedDefaultKey, unknown>> = {};
  let anySet = false;
  for (const [program, file] of Object.entries(programFiles)) {
    if (!existsSync(file)) continue;
    const document = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const values = {} as Record<SharedDefaultKey, unknown>;
    for (const key of SHARED_DEFAULT_KEYS) {
      const found = readDotPath(document, key);
      values[key] = found.present ? found.value : sharedDefault(key);
      if (found.present) anySet = true;
    }
    held[program] = values;
  }
  const finish = (): void => {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ ...carried, [SHARED_DEFAULTS_MARKER]: true }, null, 2)}\n`, { mode: 0o600 });
  };
  if (!anySet) { finish(); return undefined; }
  const programs = Object.keys(held);
  const leading = held['tui'] ?? held[programs[0]!]!;
  const modes = programs.map((program) => held[program]!['permissions.mode']);
  const kept: Record<SharedDefaultKey, unknown> = {
    'provider.model': leading['provider.model'],
    'provider.reasoningEffort': leading['provider.reasoningEffort'],
    'permissions.mode': modes.reduce((best, value) => (modeLooseness(value) < modeLooseness(best) ? value : best)),
  };
  const tier = readDaemonTierFile(daemonTierPath);
  for (const key of SHARED_DEFAULT_KEYS) {
    const current = readDotPath(tier, key);
    // A locked key: the value its lock holds, or (that value not known) left as it is.
    const lock = locked(key);
    if (lock === null) continue;
    if (lock) kept[key] = lock.value;
    const fromAProgram = lock !== undefined || !current.present || programs.some((program) => JSON.stringify(held[program]![key]) === JSON.stringify(current.value));
    if (!fromAProgram) continue;
    const wanted = kept[key];
    if (current.present && JSON.stringify(current.value) === JSON.stringify(wanted)) continue;
    // The kept value is the default: the daemon holds none, so the default is in force.
    if (JSON.stringify(wanted) === JSON.stringify(sharedDefault(key))) { if (current.present) removeDaemonKey(daemonTierPath, key); }
    else persistDaemonKey(daemonTierPath, key, wanted);
  }
  finish();
  const differ = programs.length > 1 && SHARED_DEFAULT_KEYS.some((key) => new Set(programs.map((program) => JSON.stringify(held[program]![key]))).size > 1);
  return differ ? { held, kept } : undefined;
}

/** The one notice the owner reads when the programs kept different defaults: both programs' values and what was kept. */
export function describeSharedDefaultsCarry(carry: SharedDefaultsCarry): string {
  const where = (program: string): string => (program === 'tui' ? 'the terminal app' : program === 'agent' ? 'the Agent' : program);
  const mode = (value: unknown): string => {
    const parsed = parsePermissionMode(value);
    return parsed === undefined ? String(value) : GATE_PRESETS[parsed].label;
  };
  const words = (values: Readonly<Record<SharedDefaultKey, unknown>>): string =>
    `the model ${String(values['provider.model'])} with reasoning effort ${String(values['provider.reasoningEffort'])} and the mode ${mode(values['permissions.mode'])}`;
  const each = Object.entries(carry.held).map(([program, values]) => `${where(program)} used ${words(values)}`);
  return `Before this version each program kept its own defaults: ${each.join('; ')}. `
    + `Every program now starts its conversations with one default: the model ${String(carry.kept['provider.model'])} with reasoning effort ${String(carry.kept['provider.reasoningEffort'])} (the terminal app's), `
    + `and the mode ${mode(carry.kept['permissions.mode'])} (the stricter of the two). `
    + 'A conversation can still choose its own. The default model is changed in Models and providers, the effort and the mode in Settings ("How hard the model thinks", "When GoodVibes asks").';
}

/** Whether carrying forward changed anything. */
export function carriedAnything(result: SettingsCarryForward): boolean {
  return result.moved.length + result.copied.length + result.superseded.length + result.removed.length > 0;
}

/** A path under the home directory written from `~`, as a person reads it. */
function shortPath(file: string): string {
  const home = homedir();
  return home && (file === home || file.startsWith(`${home}/`)) ? `~${file.slice(home.length)}` : file;
}

/** The one line the owner is told, naming every key, where it went and where the file as it was is kept. */
export function describeSettingsCarryForward(file: string, daemonFile: string | null, result: SettingsCarryForward, keptAs?: string): string {
  const parts: string[] = [];
  if (result.moved.length > 0) parts.push(`moved to the daemon's settings (${daemonFile === null ? 'its own file' : shortPath(daemonFile)}): ${result.moved.join(', ')}`);
  if (result.copied.length > 0) parts.push(`copied to the daemon's settings (${daemonFile === null ? 'its own file' : shortPath(daemonFile)}), which every program now uses, and left here as they were for an earlier version: ${result.copied.join(', ')}`);
  if (result.superseded.length > 0) parts.push(`removed because the daemon's settings already set them: ${result.superseded.join(', ')}`);
  if (result.removed.length > 0) parts.push(`removed because this version no longer has them: ${result.removed.join(', ')}`);
  const kept = keptAs === undefined ? '' : ` The file as it was is kept as ${shortPath(keptAs)}.`;
  return `Settings an earlier version left in ${shortPath(file)} were carried forward; ${parts.join('; ')}.${kept}`;
}
