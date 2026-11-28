/**
 * settings-screen/rows.ts, the rows of the one settings screen both terminal
 * programs show: every setting of the schema, each program's own settings
 * beyond it (platform runtime/program-host-settings.ts), the payments cards
 * row, and each feature as one unit in its domain (its switch first, then the
 * settings that tune it). Values are what the daemon answered for the program
 * shown (`settings.list`, capabilities/builtin/system-settings.ts): a setting
 * the daemon owns reads the same from either program, a program's own reads as
 * that program has it. Pure: nothing here reads a file or the daemon.
 */
import { CONFIG_SCHEMA, isDaemonOwnedConfigKey, type ConfigKey, type ConfigSetting, type HostSetting } from '@goodvibes/engine/platform/platform/config';
import {
  PROGRAM_HOST_SETTINGS, PROGRAM_LIST_SETTINGS, TERMINAL_PROGRAM_DEFAULTS, type TerminalProgram,
} from '@goodvibes/engine/platform/platform/runtime/program-host-settings';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes/engine/platform/platform/runtime/notification-privacy';
import { FEATURE_SETTINGS } from '@goodvibes/engine/platform/platform/runtime/feature-flags/feature-settings';
import { deriveWorktreeSetup, readWorktreeSetupChoice, worktreeSetupSettingValue } from '@goodvibes/engine/platform/platform/runtime/shell';
import { buildPaymentsCardsRow, PAYMENTS_CARDS_ROW_KEY } from '../payments-settings.js';
import { getConfigSchemaSetting, isFeatureValueEnabled, type FeatureSetting } from '../cli-feature-settings.js';
import { formatListEditText, parseListEditText } from '../settings-behavior.js';
import type { CommonSettingEntryState } from '../settings-model-types.js';

export type ScreenProgram = TerminalProgram;

/** One value as the daemon listed it, with where it comes from and what holds it. */
export interface ListedValue {
  readonly value: unknown;
  readonly source?: string | undefined;
  readonly effectiveSource?: string | undefined;
  readonly locked?: boolean | undefined;
  readonly lockReason?: string | undefined;
  readonly conflict?: boolean | undefined;
  readonly policyUnreadable?: string | undefined;
}

/** What is known of a program's values: being read, read, or why they could not be. */
export type ValueState =
  | { readonly kind: 'reading' }
  | { readonly kind: 'read'; readonly values: ReadonlyMap<string, ListedValue>; readonly at: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** A feature as one unit: its switch's state (the program's own gate when shown for itself, else read from the value). */
export interface ScreenFlag {
  readonly feature: FeatureSetting;
  state: 'enabled' | 'disabled';
  /** A startup-gated feature changed this session: on or off only after the program starts again. */
  pendingRestart: boolean;
}

/** One row of the screen. */
export interface ScreenEntry extends CommonSettingEntryState<string> {
  setting: ConfigSetting;
  /** Who keeps the value: the daemon (one value, the same from either program) or the program shown. */
  readonly owner: 'daemon' | 'program';
  /** A program's own setting beyond the schema. */
  readonly host?: true | undefined;
  /** Edited on one line as a list: `worktree` (auto, none or a list) or `list` (comma separated, or a JSON list). */
  readonly editor?: 'worktree' | 'list' | undefined;
  /** The feature this row switches on and off (its unit's first row). */
  flag?: ScreenFlag | undefined;
  /** The feature this row tunes. */
  ownerFlagId?: string | undefined;
  /** The cards row: Enter goes to the cards, it holds no value. */
  readonly cards?: true | undefined;
  /** Which file the value was read from (`global`, `project`, `shared`, `daemon`, `default`, `host`), as the daemon said. */
  source?: string | undefined;
}

/** The program's live gate states, by feature id, when the screen shows the program's own settings. */
export type FlagStates = ReadonlyMap<string, { readonly state: 'enabled' | 'disabled'; readonly pendingRestart: boolean }>;

/** Settings categories in the order rows are kept within a section (the terminal app's order, the Agent's extras after). */
export const SCREEN_CATEGORIES: readonly string[] = [
  'display', 'ui', 'behavior', 'notifications', 'permissions', 'policy', 'security',
  'provider', 'pricing', 'subscriptions', 'judgment', 'helper', 'tools', 'tts', 'voice',
  'service', 'daemon', 'network', 'controlPlane', 'httpListener', 'web', 'relay', 'secureAddress',
  'surfaces', 'hostedSessions', 'device', 'conversationGate', 'integrations', 'email', 'calendar', 'google', 'mcp', 'cloudflare',
  'batch', 'automation', 'checkin', 'occasions', 'watchers', 'orchestration', 'planner', 'contract', 'wrfc', 'payments',
  'storage', 'atRest', 'sandbox', 'fetch', 'agents', 'runtime', 'power', 'profile', 'memory', 'cache', 'telemetry', 'diagnostics', 'learning',
  'update', 'danger', 'fleet', 'cluster',
];

/** A program's own setting under a section of its own is listed where that section belongs. */
const HOST_SECTION_CATEGORY: Readonly<Record<string, string>> = { statusline: 'ui', session: 'behavior' };
/** A root listed beside another (its own namespace still decides its section when one claims it). */
const LISTED_WITH: Readonly<Record<string, string>> = { worktree: 'orchestration', checkpoints: 'storage', browser: 'fetch', push: 'notifications' };

/** Display order of the `ui` rows. */
const UI_PRIORITY: Readonly<Record<string, number>> = { 'ui.systemMessages': 0, 'ui.operationalMessages': 1, 'ui.contractMessages': 2, 'ui.voiceEnabled': 3 };

const WORKTREE_KEYS: ReadonlySet<string> = new Set(['worktree.setup.commands', 'worktree.setup.carryOverGlobs']);
const LIST_KEYS: ReadonlySet<string> = new Set(['sandbox.egressAllowlist', 'sandbox.workspaceWritable', 'permissions.execEnvScrubAllowlist']);

/** The threat-model note every relay setting carries. */
export const RELAY_THREAT_MODEL_NOTE =
  'The relay operator sees only ciphertext and connection metadata; it cannot read message contents. Self-host your own relay for full control.';

const PROGRAM_DEFAULTS: ReadonlyMap<string, unknown> = new Map(TERMINAL_PROGRAM_DEFAULTS);

/** Structural equality for "is this the default" (settings values are JSON). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  return keys.length === Object.keys(bo).length && keys.every((key) => Object.hasOwn(bo, key) && deepEqual(ao[key], bo[key]));
}

/** The value a setting has when nothing is stored for it in a terminal program: the default both programs set, else the schema's. */
export function programDefaultOf(setting: Pick<ConfigSetting, 'key' | 'default'>): unknown {
  return PROGRAM_DEFAULTS.has(setting.key) ? PROGRAM_DEFAULTS.get(setting.key) : setting.default;
}

/** A program's own setting as a row of the schema's shape (a number keeps its range as the check). */
function hostRow(setting: HostSetting): ConfigSetting {
  const row: ConfigSetting = { key: setting.key as ConfigKey, label: setting.label, type: setting.type, default: setting.default, description: setting.description };
  if (setting.type !== 'number') return row;
  const { integer, min, max } = setting;
  const hint = [integer ? 'a whole number' : 'a number', min !== undefined ? `at least ${min}` : '', max !== undefined ? `at most ${max}` : ''].filter(Boolean).join(', ');
  return {
    ...row,
    validate: (value) => typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isInteger(value)) && (min === undefined || value >= min) && (max === undefined || value <= max),
    validationHint: hint,
  };
}

/** What auto does for the repository at `sourceRoot`, from the derivation setup itself uses. */
function describeWorktreeAuto(key: string, sourceRoot: string): string {
  try {
    const derived = deriveWorktreeSetup(sourceRoot);
    if (key === 'worktree.setup.commands') {
      return derived.commands.length > 0 ? `Here, auto runs: ${derived.commands.join('; ')}.` : 'Here, auto runs nothing (no lockfile it knows at the repository root).';
    }
    return derived.carryOverGlobs.length > 0 ? `Here, auto copies: ${derived.carryOverGlobs.join(', ')}.` : 'Here, auto copies nothing (no .env file at the repository root).';
  } catch {
    return '';
  }
}

const WORKTREE_EDIT_HELP = 'Type auto, none, or a list (comma separated, or a JSON list such as [".env.{local,dev}"] when an entry has a comma).';
const LIST_EDIT_HELP = 'Type the entries comma separated, or a JSON list when an entry has a comma; empty clears it.';

/** The one-line text of a worktree setup value: auto, none, or the list. */
export function worktreeEditText(value: unknown): string {
  const choice = readWorktreeSetupChoice(value);
  if (choice.mode !== 'list') return choice.mode;
  // A one-entry list that reads like a mode word is written as JSON so it stays a list.
  if (choice.values.length === 1 && (choice.values[0] === 'auto' || choice.values[0] === 'none')) return JSON.stringify(choice.values);
  return formatListEditText(choice.values);
}

/** The editor's starting text for a list row, or null for any other row. */
export function listEditText(entry: Pick<ScreenEntry, 'editor' | 'currentValue'>): string | null {
  if (!entry.editor) return null;
  if (typeof entry.currentValue === 'string') return entry.currentValue;
  if (entry.editor === 'worktree') return worktreeEditText(entry.currentValue);
  return formatListEditText(Array.isArray(entry.currentValue) ? entry.currentValue.filter((value): value is string => typeof value === 'string') : []);
}

/** The value to store for a list row's text, or why it is refused; null for any other row. */
export function parseListEdit(entry: Pick<ScreenEntry, 'editor'>, text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } | null {
  if (entry.editor === 'worktree') {
    const word = text.trim().toLowerCase();
    if (word === '' || word === 'auto') return { ok: true, value: worktreeSetupSettingValue({ mode: 'auto' }) };
    if (word === 'none') return { ok: true, value: worktreeSetupSettingValue({ mode: 'none' }) };
    const parsed = parseListEditText(text);
    if (!parsed.ok) return parsed;
    return { ok: true, value: worktreeSetupSettingValue(parsed.values.length > 0 ? { mode: 'list', values: parsed.values } : { mode: 'auto' }) };
  }
  if (entry.editor !== 'list') return null;
  const parsed = parseListEditText(text);
  return parsed.ok ? { ok: true, value: parsed.values } : parsed;
}

/** Fill a row's value, its default-ness and what holds it, from what is known of the program's values. */
export function applyValue(entry: ScreenEntry, state: ValueState): void {
  const key = entry.setting.key;
  Object.assign(entry, { effectiveSource: undefined, locked: undefined, lockReason: undefined, conflict: undefined, sourceLabel: undefined, metadataUnavailable: undefined, source: undefined });
  if (entry.cards) return;
  if (state.kind !== 'read') {
    entry.currentValue = undefined;
    entry.isDefault = false;
    entry.effectiveSource = 'unavailable';
    entry.sourceLabel = state.kind === 'reading' ? 'reading from the daemon' : `could not be read: ${state.reason}`;
    return;
  }
  const listed = state.values.get(key);
  const stored = listed ? listed.value : entry.setting.default;
  if (entry.editor === 'worktree') {
    const choice = readWorktreeSetupChoice(stored);
    entry.currentValue = worktreeEditText(worktreeSetupSettingValue(choice));
    entry.isDefault = choice.mode === 'auto';
  } else if (entry.editor === 'list') {
    const values = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
    entry.currentValue = values;
    entry.isDefault = values.length === 0;
  } else {
    entry.currentValue = stored;
    entry.isDefault = deepEqual(stored, entry.setting.default);
  }
  if (!listed) return;
  if (listed.effectiveSource) entry.effectiveSource = listed.effectiveSource;
  if (listed.locked) entry.locked = true;
  if (listed.lockReason) entry.lockReason = listed.lockReason;
  if (listed.conflict) entry.conflict = true;
  if (listed.policyUnreadable) entry.metadataUnavailable = listed.policyUnreadable;
  entry.source = listed.source;
}

/** The features a program's gate knows, each with its state: the program's own when shown for itself, else read from the value. */
export function flagOf(feature: FeatureSetting, value: unknown, live: FlagStates | null): ScreenFlag {
  const known = live?.get(feature.id);
  return {
    feature,
    state: known?.state ?? (isFeatureValueEnabled(feature, value) ? 'enabled' : 'disabled'),
    pendingRestart: known?.pendingRestart ?? false,
  };
}

export interface ScreenRowsInput {
  /** Whose settings the rows show. */
  readonly program: ScreenProgram;
  readonly values: ValueState;
  /** The program's live gate states when the rows are the asking program's own; null for the other program. */
  readonly flags: FlagStates | null;
  /** The features the program's gate registers (only those get a unit); null lists every feature. */
  readonly registeredFeatures: ReadonlySet<string> | null;
  /** The repository auto worktree setup is described for. */
  readonly sourceRoot: string;
  /** Where the daemon keeps its settings, said on each setting it owns; null when unknown. */
  readonly daemonTierPath: string | null;
}

/** The daemon-owned note on every setting the daemon keeps. */
export function daemonOwnedNote(daemonTierPath: string | null): string {
  return daemonTierPath
    ? `The daemon keeps this setting (in ${daemonTierPath}), so it applies to every program, not just this one.`
    : 'The daemon keeps this setting, so it applies to every program, not just this one.';
}

function sentence(text: string): string {
  return text.trim().replace(/[^.!?)]$/, (last) => `${last}.`);
}

/** Every row of the screen for one program, by category in the screen's order; features as units in their domain. */
export function buildScreenGroups(input: ScreenRowsInput): Map<string, ScreenEntry[]> {
  const groups = new Map<string, ScreenEntry[]>();
  for (const category of SCREEN_CATEGORIES) groups.set(category, []);
  const add = (category: string, entry: ScreenEntry): void => {
    const list = groups.get(category);
    if (list) list.push(entry); else groups.set(category, [entry]);
  };
  const daemonNote = daemonOwnedNote(input.daemonTierPath);
  const rowFor = (setting: ConfigSetting, host: boolean): ScreenEntry => {
    const owner = isDaemonOwnedConfigKey(setting.key) ? 'daemon' : 'program';
    const root = setting.key.split('.', 1)[0] ?? setting.key;
    let described = setting.description;
    if (root === 'relay' && !described.includes(RELAY_THREAT_MODEL_NOTE)) described = `${sentence(described)} ${RELAY_THREAT_MODEL_NOTE}`;
    if (owner === 'daemon') described = `${sentence(described)} ${daemonNote}`;
    const editor = WORKTREE_KEYS.has(setting.key) ? 'worktree' as const : LIST_KEYS.has(setting.key) ? 'list' as const : undefined;
    if (editor === 'worktree') described = [sentence(described), describeWorktreeAuto(setting.key, input.sourceRoot), WORKTREE_EDIT_HELP].filter(Boolean).join(' ');
    else if (editor === 'list') described = `${sentence(described)} ${LIST_EDIT_HELP}`;
    const productDefault = programDefaultOf(setting);
    const row: ConfigSetting = {
      ...setting,
      description: described,
      ...(editor ? { type: 'string' as const } : {}),
      ...(deepEqual(productDefault, setting.default) ? {} : { default: productDefault }),
    };
    const entry: ScreenEntry = { setting: row, owner, currentValue: undefined, isDefault: true, ...(host ? { host: true as const } : {}), ...(editor ? { editor } : {}) };
    applyValue(entry, input.values);
    return entry;
  };

  for (const setting of CONFIG_SCHEMA) {
    if (setting.deprecated) continue;
    const root = setting.key.split('.', 1)[0] ?? setting.key;
    add(LISTED_WITH[root] ?? root, rowFor(setting, false));
  }
  for (const setting of PROGRAM_HOST_SETTINGS[input.program]) {
    const root = setting.key.split('.', 1)[0] ?? setting.key;
    add(HOST_SECTION_CATEGORY[root] ?? root, rowFor(hostRow(setting), true));
  }
  for (const setting of PROGRAM_LIST_SETTINGS) add(setting.key.split('.', 1)[0] ?? setting.key, rowFor(setting, true));

  // The ui rows in their order; a program's own row (outside the list) after the listed ones.
  groups.get('ui')?.sort((a, b) => (UI_PRIORITY[a.setting.key] ?? 99) - (UI_PRIORITY[b.setting.key] ?? 99));
  // The notification privacy control after the notification toggles.
  const behavior = groups.get('behavior');
  if (behavior) {
    const privacy = behavior.findIndex((entry) => (entry.setting.key as string) === NOTIFICATIONS_METADATA_ONLY_KEY);
    if (privacy >= 0) behavior.push(...behavior.splice(privacy, 1));
  }
  // Cards are not settings: one row goes to where they are added and removed.
  const cards = buildPaymentsCardsRow();
  add('payments', { setting: cards.setting, owner: 'daemon', currentValue: cards.currentValue, isDefault: true, locked: true, lockReason: cards.lockReason, cards: true });

  applyFeatureUnits(groups, input);
  return groups;
}

/**
 * Each feature as one unit in its domain: its switch (the real row of its
 * enablement key, with the feature's name) followed by the settings it owns,
 * then the domain's other rows. A key two features claim is listed under the first.
 */
function applyFeatureUnits(groups: Map<string, ScreenEntry[]>, input: ScreenRowsInput): void {
  const features = FEATURE_SETTINGS.filter((feature) => input.registeredFeatures === null || input.registeredFeatures.has(feature.id));
  if (features.length === 0) return;
  const enablementKeys = new Set(FEATURE_SETTINGS.map((feature) => feature.enablement.key as string));
  const owner = new Map<string, string>();
  for (const feature of FEATURE_SETTINGS) for (const key of feature.settings) if (!enablementKeys.has(key) && !owner.has(key)) owner.set(key, feature.id);
  const registered = new Set(features.map((feature) => feature.id));
  const byDomain = new Map<string, FeatureSetting[]>();
  for (const feature of features) byDomain.set(feature.domain, [...(byDomain.get(feature.domain) ?? []), feature]);
  for (const [domain, domainFeatures] of byDomain) {
    const existing = groups.get(domain) ?? [];
    const rowByKey = new Map<string, ScreenEntry>();
    for (const entry of existing) if (!rowByKey.has(entry.setting.key)) rowByKey.set(entry.setting.key, entry);
    const hosted = new Set(domainFeatures.map((feature) => feature.enablement.key as string));
    const owned = new Map<string, ScreenEntry[]>();
    const orphans: ScreenEntry[] = [];
    for (const entry of existing) {
      if (entry.host || entry.cards) { orphans.push(entry); continue; }
      if (hosted.has(entry.setting.key)) continue;
      const ownerId = owner.get(entry.setting.key);
      if (ownerId !== undefined && registered.has(ownerId)) owned.set(ownerId, [...(owned.get(ownerId) ?? []), { ...entry, ownerFlagId: ownerId }]);
      else orphans.push(entry);
    }
    const rebuilt: ScreenEntry[] = [];
    for (const feature of domainFeatures) {
      const base = rowByKey.get(feature.enablement.key);
      const setting: ConfigSetting = base?.setting ?? getConfigSchemaSetting(feature.enablement.key)
        ?? { key: feature.enablement.key, label: feature.name, type: 'boolean', default: feature.defaultEnabled, description: feature.description };
      const header: ScreenEntry = base
        ? { ...base, setting, flag: flagOf(feature, base.currentValue, input.flags) }
        : { setting, owner: isDaemonOwnedConfigKey(setting.key) ? 'daemon' : 'program', currentValue: undefined, isDefault: true, flag: flagOf(feature, undefined, input.flags) };
      if (!base) applyValue(header, input.values);
      rebuilt.push(header);
      rebuilt.push(...(owned.get(feature.id) ?? []));
    }
    rebuilt.push(...orphans);
    groups.set(domain, rebuilt);
  }
}

/** Every feature as the Features list shows it: by domain, then in declaration order. */
export function featureListOf(input: Pick<ScreenRowsInput, 'values' | 'flags'>): ScreenFlag[] {
  const values = input.values.kind === 'read' ? input.values.values : new Map<string, ListedValue>();
  return FEATURE_SETTINGS
    .map((feature, index) => ({ flag: flagOf(feature, values.get(feature.enablement.key)?.value, input.flags), index }))
    .sort((a, b) => a.flag.feature.domain.localeCompare(b.flag.feature.domain) || a.index - b.index)
    .map(({ flag }) => flag);
}

/** Every value a `settings.list` answer holds, by key; why not, when the answer is not one. */
export function listedValuesOf(data: unknown): ReadonlyMap<string, ListedValue> | string {
  const settings = (data as { readonly settings?: unknown } | null | undefined)?.settings;
  if (!Array.isArray(settings)) return 'the daemon answered without a list of settings';
  const values = new Map<string, ListedValue>();
  for (const row of settings) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    if (typeof item['key'] !== 'string') continue;
    const text = (name: string): string | undefined => (typeof item[name] === 'string' ? item[name] as string : undefined);
    values.set(item['key'], {
      value: item['value'],
      source: text('source'),
      effectiveSource: text('effectiveSource'),
      locked: item['locked'] === true ? true : undefined,
      lockReason: text('lockReason'),
      conflict: item['conflict'] === true ? true : undefined,
      policyUnreadable: text('policyUnreadable'),
    });
  }
  return values;
}

/**
 * The rows the terminal app's settings screen showed beyond the two schemas,
 * for the generated reference (scripts/generate-llms-full.ts): the same
 * builder, with nothing read.
 */
export function buildSettingGroups(_configManager: object): Map<string, ScreenEntry[]> {
  return buildScreenGroups({ program: 'tui', values: { kind: 'reading' }, flags: null, registeredFeatures: null, sourceRoot: process.cwd(), daemonTierPath: null });
}

export { PAYMENTS_CARDS_ROW_KEY };
