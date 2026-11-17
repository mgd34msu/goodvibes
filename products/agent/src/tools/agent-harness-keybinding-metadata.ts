import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { Ranked } from '@goodvibes-jev/judgment';
import type { CommandContext } from '../input/command-registry.ts';
import {
  ACTION_DESCRIPTIONS,
  DEFAULT_KEYBINDINGS,
  type KeyAction,
  type KeyCombo,
  type KeybindingsManager,
} from '../input/keybindings.ts';
import { clampReadLimit } from './agent-harness-read-helpers.ts';

/**
 * Keys the shell handles itself before configurable bindings are consulted, and
 * the two commands that show them. One table: the shortcut listing shows `key`,
 * and a new binding is checked for a clash against `chords`.
 */
const FIXED_KEYS: readonly { readonly key: string; readonly description: string; readonly chords: readonly KeyCombo[] }[] = [
  { key: 'Enter', description: 'Send prompt', chords: [{ key: 'enter' }] },
  { key: 'Shift+Enter / Ctrl+J', description: 'Insert newline', chords: [{ key: 'enter', shift: true }, { key: 'j', ctrl: true }] },
  { key: 'Up / Down', description: 'Navigate input history, lists, and scrollable overlays', chords: [{ key: 'up' }, { key: 'down' }] },
  { key: 'Tab', description: 'Autocomplete slash command or file mention', chords: [{ key: 'tab' }] },
  { key: 'Esc', description: 'Close overlays, pickers, and transient input modes', chords: [{ key: 'escape' }] },
  { key: '? / F1', description: 'Toggle help overlay', chords: [{ key: '?' }, { key: 'f1' }] },
  { key: 'F2', description: 'Open runtime activity monitor', chords: [{ key: 'f2' }] },
  { key: '/shortcuts', description: 'Open keyboard shortcut reference', chords: [] },
  { key: '/keybindings', description: 'List configurable keybindings and config path', chords: [] },
];
const FIXED_SHORTCUTS: readonly { readonly key: string; readonly description: string }[] = FIXED_KEYS.map(({ key, description }) => ({ key, description }));

interface HarnessKeybindingArgs {
  readonly query?: unknown;
  readonly actionId?: unknown;
  readonly target?: unknown;
  readonly key?: unknown;
  readonly fields?: unknown;
  readonly combo?: unknown;
  readonly combos?: unknown;
  readonly value?: unknown;
  readonly limit?: unknown;
}

type KeybindingOperationEffect =
  | 'shell-action'
  | 'visible-ui-navigation'
  | 'visible-ui-interaction'
  | 'prompt-editor-state'
  | 'clipboard-selection'
  | 'reserved'
  | 'disabled';

interface KeybindingOperationRoute {
  readonly supported: boolean;
  readonly effect: KeybindingOperationEffect;
  readonly confirmation: string;
  readonly preferredMode?: 'run_keybinding' | 'open_ui_surface' | 'run_command' | 'direct-user-interaction';
  readonly surfaceId?: string;
  readonly command?: string;
  readonly note: string;
}

type KeybindingEntry = { readonly action: KeyAction; readonly description: string; readonly combos: KeyCombo[] };
type KeybindingContext = Pick<CommandContext, 'workspace'>;
type KeybindingExecutionContext = KeybindingContext & Pick<CommandContext,
  'renderRequest' | 'cancelGeneration' | 'clearScreen' | 'openWorkspacePicker' | 'openAgentWorkspace'
  | 'dismissAgentWorkspace' | 'focusPrompt' | 'openPromptHistorySearch' | 'openConversationSearch'
  | 'pasteFromClipboard' | 'openBlockActions' | 'isGenerating'>;

interface KeybindingLookup {
  readonly source: 'actionId' | 'target' | 'key' | 'query';
  readonly input: string;
  readonly resolvedBy: 'action' | 'case-insensitive-action' | 'key-combo' | 'search';
}

type KeybindingResolution =
  | {
    readonly status: 'found';
    readonly action: KeyAction;
    readonly lookup: KeybindingLookup;
    readonly judgment?: Ranked;
  }
  | {
    readonly status: 'ambiguous';
    readonly input: string;
    readonly candidates: readonly Record<string, unknown>[];
  };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

function requireKeybindingsManager(context: KeybindingContext): KeybindingsManager {
  const manager = context.workspace.keybindingsManager;
  if (!manager) throw new Error('workspace.keybindingsManager is unavailable in this Agent runtime');
  return manager;
}

function readKeybindingsManager(context: KeybindingContext): KeybindingsManager | null {
  return context.workspace.keybindingsManager ?? null;
}

function defaultKeybindingEntries(): KeybindingEntry[] {
  return (Object.entries(DEFAULT_KEYBINDINGS) as [KeyAction, KeyCombo[]][])
    .map(([action, combos]) => ({
      action,
      description: ACTION_DESCRIPTIONS[action],
      combos: combos.map((combo) => ({ ...combo })),
    }));
}

function isKeyAction(action: string): action is KeyAction {
  return Object.hasOwn(ACTION_DESCRIPTIONS, action);
}

const MODIFIER_NAMES: ReadonlySet<string> = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'command']);
const NAMED_KEYS: ReadonlySet<string> = new Set(['enter', 'escape', 'tab', 'backspace', 'delete', 'insert', 'space', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)]);
const KEY_NAME_ALIASES: Readonly<Record<string, string>> = { esc: 'escape', return: 'enter', pgup: 'pageup', pgdn: 'pagedown', del: 'delete', ins: 'insert' };

/** The shell matches keys by lowercase logical name, so a combo stored as "G" or "Esc" would never fire. */
function normalizeKeyName(key: string): string {
  const lower = key.trim().toLowerCase();
  return KEY_NAME_ALIASES[lower] ?? lower;
}

function invalidKeyReason(key: string): string | null {
  if (MODIFIER_NAMES.has(key)) return `"${key}" is a modifier; set it with ctrl, shift or alt and name the key that goes with it.`;
  if ([...key].length === 1 || NAMED_KEYS.has(key)) return null;
  return `"${key}" is not a key the shell can match. Use one character or one of: ${[...NAMED_KEYS].join(', ')}.`;
}

/** The closed set of spellings a modifier flag accepts; anything else is refused with the parameter's name. */
const MODIFIER_FLAG_WORDS: Readonly<Record<string, boolean>> = {
  true: true, false: false, yes: true, no: false, on: true, off: false, '1': true, '0': false,
};

function readModifierFlag(parameter: 'ctrl' | 'shift' | 'alt', value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const flag = MODIFIER_FLAG_WORDS[value.trim().toLowerCase()];
    if (flag !== undefined) return flag;
  }
  throw new Error(`set_keybinding was not applied: ${parameter} must be true or false (also accepted: yes/no, on/off, 1/0); got ${JSON.stringify(value)}.`);
}

async function normalizeCombo(value: unknown, _evidence: HarnessKeybindingArgs, options: CatalogRankingOptions): Promise<KeyCombo | null> {
  options.signal?.throwIfAborted();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = captureCatalogData(value), fields = Object.getOwnPropertyDescriptors(raw);
  const key = normalizeKeyName(readString(fields.key?.value));
  if (!key) return null;
  const combo: KeyCombo = { key };
  for (const parameter of ['ctrl', 'shift', 'alt'] as const) {
    const flag = readModifierFlag(parameter, fields[parameter]?.value);
    if (flag !== undefined) combo[parameter] = flag;
  }
  return combo;
}

function parseComboLabel(value: string): KeyCombo | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.at(-1);
  if (!key) return null;
  const combo: KeyCombo = { key: normalizeKeyName(key) };
  for (const part of parts.slice(0, -1)) {
    const normalized = part.toLowerCase();
    if (normalized === 'ctrl' || normalized === 'control') combo.ctrl = true;
    else if (normalized === 'shift') combo.shift = true;
    else if (normalized === 'alt' || normalized === 'option') combo.alt = true;
    else return null;
  }
  return combo;
}

async function combosFromArgs(args: HarnessKeybindingArgs, options: CatalogRankingOptions): Promise<KeyCombo[]> {
  const combos = await readCombosFromArgs(args, options);
  for (const combo of combos) {
    const reason = invalidKeyReason(combo.key);
    if (reason) throw new Error(`set_keybinding was not applied: ${reason}`);
  }
  return combos;
}

async function readCombosFromArgs(args: HarnessKeybindingArgs, options: CatalogRankingOptions): Promise<KeyCombo[]> {
  if (Array.isArray(args.combos)) {
    const combos: Array<KeyCombo | null> = [];
    for (const value of args.combos) combos.push(await normalizeCombo(value, args, options));
    if (combos.every((combo): combo is KeyCombo => combo !== null)) return combos;
    throw new Error('set_keybinding combos must be objects with key and optional boolean ctrl/shift/alt fields.');
  }
  const combo = await normalizeCombo(args.combo, args, options);
  if (combo) return [combo];
  const fieldCombo = await normalizeCombo(args.fields, args, options);
  if (fieldCombo) return [fieldCombo];
  const labelCombo = parseComboLabel(readString(args.value));
  if (labelCombo) return [labelCombo];
  throw new Error('set_keybinding requires combo, combos, fields (key plus optional ctrl/shift/alt), or a value such as "Ctrl+G".');
}

function comboFingerprint(combo: KeyCombo): string {
  return `${combo.key.toLowerCase()}:${combo.ctrl ? 1 : 0}:${combo.shift ? 1 : 0}:${combo.alt ? 1 : 0}`;
}

function combosEqual(left: readonly KeyCombo[], right: readonly KeyCombo[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((combo, index) => comboFingerprint(combo) === comboFingerprint(right[index]));
}

function formatCombo(manager: KeybindingsManager | null, combo: KeyCombo): string {
  if (manager) return manager.formatCombo(combo);
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return parts.join('+');
}

function describeCombo(manager: KeybindingsManager | null, combo: KeyCombo): Record<string, unknown> {
  return {
    key: combo.key,
    ctrl: combo.ctrl === true,
    shift: combo.shift === true,
    alt: combo.alt === true,
    label: formatCombo(manager, combo),
  };
}

function keybindingLookupFromArgs(args: HarnessKeybindingArgs): { readonly source: KeybindingLookup['source']; readonly input: string } | null {
  const actionId = readString(args.actionId);
  if (actionId) return { source: 'actionId', input: actionId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const key = readString(args.key);
  if (key) return { source: 'key', input: key };
  const query = readString(args.query);
  if (query) return { source: 'query', input: query };
  return null;
}

function bindingDescription(manager: KeybindingsManager | null, entry: KeybindingEntry): string {
  return [
    entry.action,
    entry.description,
    ...entry.combos.map((combo) => comboFingerprint(combo)),
    ...entry.combos.map((combo) => formatCombo(manager, combo)),
  ].join('\n');
}

function bindingCandidate(manager: KeybindingsManager | null, entry: KeybindingEntry): Record<string, unknown> {
  return {
    action: entry.action,
    description: entry.description,
    labels: entry.combos.map((combo) => formatCombo(manager, combo)),
    modelRoute: keybindingModelRoute(entry.action),
    inspectRoute: `agent_harness mode:"keybinding" actionId:"${entry.action}"`,
  };
}

function captureKeybindingSources(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions, retainSources = true) {
  const signal = options.signal, owner = options.sourceOwner, outerCurrent = options.assertCurrent;
  const retainCurrent = options.retainCurrent, preserved = options.requirePreservedSource;
  signal?.throwIfAborted(); outerCurrent?.();
  const manager = readKeybindingsManager(context);
  const entries = captureCatalogData(manager?.getAll() ?? defaultKeybindingEntries());
  const configPath = manager?.getConfigPath() ?? null;
  const input = captureCatalogData(args);
  const defaults = captureCatalogData(defaultKeybindingEntries());
  const revision = JSON.stringify({ entries, configPath, input, defaults });
  const getAll = manager?.getAll, getConfigPath = manager?.getConfigPath, format = manager?.formatCombo;
  const assertBinding = () => {
    if (options.signal !== signal || options.sourceOwner !== owner || options.assertCurrent !== outerCurrent
      || options.retainCurrent !== retainCurrent || options.requirePreservedSource !== preserved) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted();
  };
  const assertSource = () => {
    assertBinding();
    if (readKeybindingsManager(context) !== manager || manager?.getAll !== getAll || manager?.getConfigPath !== getConfigPath
      || manager?.formatCombo !== format || JSON.stringify(captureCatalogData({
        entries: manager?.getAll() ?? defaultKeybindingEntries(), configPath: manager?.getConfigPath() ?? null, input: args, defaults: defaultKeybindingEntries(),
      })) !== revision) throw new ToolInputProjectionError('stale');
  };
  const assertCurrent = () => { assertBinding(); outerCurrent?.(); assertSource(); };
  assertCurrent();
  if (retainSources) retainCurrent?.(assertSource, 'agent.harness.keybindings.sources');
  assertCurrent();
  return { manager, entries, configPath, input, assertCurrent, assertSource };
}

async function rankKeybindings(sources: ReturnType<typeof captureKeybindingSources>, query: string, options: CatalogRankingOptions) {
  sources.assertCurrent();
  if (!query) return { matches: sources.entries.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  return rankHarnessCatalog(sources.entries, query, entry => ({ id: entry.action, description: bindingDescription(sources.manager, entry), evidence: entry }),
    'agent.harness.keybindings', { ...options, requirePreservedSource: true, assertCurrent: sources.assertCurrent });
}

async function resolveHarnessKeybinding(sources: ReturnType<typeof captureKeybindingSources>, args: HarnessKeybindingArgs, options: CatalogRankingOptions): Promise<KeybindingResolution | null> {
  const { manager, entries } = sources;
  const lookup = keybindingLookupFromArgs(args);
  if (!lookup) return null;
  if (isKeyAction(lookup.input)) return { status: 'found', action: lookup.input, lookup: { ...lookup, resolvedBy: 'action' } };
  const inputLower = lookup.input.toLowerCase();
  const ciActions = entries.filter((entry) => entry.action.toLowerCase() === inputLower);
  if (ciActions.length === 1) return { status: 'found', action: ciActions[0]!.action, lookup: { ...lookup, resolvedBy: 'case-insensitive-action' } };
  if (ciActions.length > 1) return { status: 'ambiguous', input: lookup.input, candidates: ciActions.map((entry) => bindingCandidate(manager, entry)).slice(0, 8) };
  if (lookup.source === 'actionId') return null;
  const combo = parseComboLabel(lookup.input);
  const exactCombos = combo ? entries.filter(entry => entry.combos.some(candidate => comboFingerprint({ ...candidate, key: candidate.key.toLowerCase() }) === comboFingerprint(combo))) : [];
  if (exactCombos.length === 1) return { status: 'found', action: exactCombos[0]!.action, lookup: { ...lookup, resolvedBy: 'key-combo' } };
  if (exactCombos.length > 1) return { status: 'ambiguous', input: lookup.input, candidates: exactCombos.map(entry => bindingCandidate(manager, entry)).slice(0, 8) };
  if (lookup.source === 'key' || (combo && (combo.ctrl || combo.alt || combo.shift))) return null;
  const { matches } = await rankKeybindings(sources, lookup.input, options);
  sources.assertCurrent();
  const single = matches.length === 1 ? matches[0] : undefined;
  if (single?.judgment?.reading.verdict === 'yes' && single.judgment?.reading.outcome === 'act') return { status: 'found', action: single.entry.action, lookup: { ...lookup, resolvedBy: 'search' }, judgment: single.judgment };
  if (matches.length > 0) return { status: 'ambiguous', input: lookup.input, candidates: matches.map(({ entry, judgment }) => ({ ...bindingCandidate(manager, entry), judgment })).slice(0, 8) };
  return null;
}

function keybindingModelRoute(action: KeyAction): string {
  const route = keybindingOperationRoute(action);
  if (route.preferredMode === 'run_keybinding') return `workspace action:"run_keybinding" actionId:"${action}"`;
  if (route.preferredMode === 'open_ui_surface' && route.surfaceId) return `workspace action:"open" surfaceId:"${route.surfaceId}"`;
  if (route.preferredMode === 'open_ui_surface') return 'workspace action:"open"';
  if (route.preferredMode === 'run_command' && route.command) return `workspace action:"run_command" command:"${route.command}"`;
  if (route.preferredMode === 'run_command') return 'workspace action:"run_command"';
  return 'direct-user-interaction';
}

function keybindingModelAccess(action: KeyAction, operation: KeybindingOperationRoute): Record<string, unknown> {
  return {
    inspect: `agent_harness mode:"keybinding" actionId:"${action}"`,
    run: operation.supported ? `agent_harness mode:"run_keybinding" actionId:"${action}"` : 'not exposed',
    set: `agent_harness mode:"set_keybinding" actionId:"${action}" combo:{...}`,
    reset: `agent_harness mode:"reset_keybinding" actionId:"${action}"`,
    preferred: keybindingModelRoute(action),
    directInspect: `workspace action:"keybinding" actionId:"${action}"`,
    directRun: operation.supported ? `workspace action:"run_keybinding" actionId:"${action}"` : 'not exposed',
    directSet: `workspace action:"set_keybinding" actionId:"${action}" combo:{...}`,
    directReset: `workspace action:"reset_keybinding" actionId:"${action}"`,
  };
}

function describeBinding(manager: KeybindingsManager | null, action: KeyAction, combos: KeyCombo[], lookup?: KeybindingLookup): Record<string, unknown> {
  const defaults = DEFAULT_KEYBINDINGS[action];
  const customized = !combosEqual(combos, defaults);
  const modelOperation = keybindingOperationRoute(action);
  return {
    action,
    description: ACTION_DESCRIPTIONS[action],
    ...(lookup ? { lookup } : {}),
    bindings: combos.map((combo) => describeCombo(manager, combo)),
    labels: combos.map((combo) => formatCombo(manager, combo)),
    defaultBindings: defaults.map((combo) => describeCombo(manager, combo)),
    customized,
    source: manager ? (customized ? 'custom' : 'default') : 'default-fallback',
    modelRoute: keybindingModelRoute(action),
    inspectRoute: `agent_harness mode:"keybinding" actionId:"${action}"`,
    modelAccess: keybindingModelAccess(action, modelOperation),
    modelOperation,
  };
}

function keybindingOperationRoute(action: KeyAction): KeybindingOperationRoute {
  switch (action) {
    case 'clear-cancel':
      return {
        supported: true,
        effect: 'shell-action',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Runs the available cancel-generation route. Prompt clearing and double-press exit remain direct user interaction.',
      };
    case 'screen-clear':
      return {
        supported: true,
        effect: 'shell-action',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Runs the available clear-screen route.',
      };
    case 'activity-open':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        confirmation: 'Direct user interaction only.',
        note: 'Opens the Activity modal (running work, what needs you, what is coming up, recent activity).',
      };
    case 'workspace-picker':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        surfaceId: 'agent-workspace',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Opens the Agent workspace home.',
      };
    case 'workspace-close':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Dismisses the Agent workspace.',
      };
    case 'workspace-close-all':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Dismisses the Agent workspace (alias chord: Ctrl+Shift+X has the same effect as Ctrl+X).',
      };
    case 'history-search':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        surfaceId: 'prompt-history-search',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Opens the visible prompt-history search overlay; optional search text may be supplied with value.',
      };
    case 'search':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        surfaceId: 'conversation-search',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Opens the visible conversation search overlay; optional search text may be supplied with value.',
      };
    case 'paste':
      return {
        supported: true,
        effect: 'shell-action',
        preferredMode: 'run_keybinding',
        command: '/paste',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Runs the paste route and reports whether text, image, or nothing was pasted.',
      };
    case 'block-save':
      return {
        supported: false,
        effect: 'disabled',
        preferredMode: 'direct-user-interaction',
        confirmation: 'No model operation is exposed.',
        note: 'Saving a block to a file is disabled in the Agent. Use block-copy to copy the block, or export the conversation instead.',
      };
    case 'block-copy':
    case 'bookmark':
      return {
        supported: true,
        effect: 'visible-ui-interaction',
        preferredMode: 'run_keybinding',
        surfaceId: 'block-actions',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Opens the visible nearest-block actions surface. The exact block action remains an interactive visible-shell selection because it depends on cursor/scroll position.',
      };
    case 'workspace-tab-next':
    case 'workspace-tab-prev':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'open_ui_surface',
        surfaceId: 'agent-workspace',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission; open the workspace with agent_harness mode:"open_ui_surface" and an explicit categoryId or target instead of cycling hidden UI state.',
        note: 'Category cycling depends on the live workspace focus position. The model should open the intended Agent workspace category directly.',
      };
    case 'copy-selection':
      return {
        supported: false,
        effect: 'clipboard-selection',
        preferredMode: 'direct-user-interaction',
        confirmation: 'No model operation is exposed.',
        note: 'Terminal text selection is outside the Agent command context. Use transcript/session export or a content-specific model route when a concrete artifact is needed.',
      };
    case 'delete-word':
    case 'line-start':
    case 'next-error-line-end':
    case 'kill-line':
    case 'clear-prompt':
    case 'undo':
    case 'redo':
      return {
        supported: false,
        effect: 'prompt-editor-state',
        preferredMode: 'direct-user-interaction',
        confirmation: 'No model operation is exposed.',
        note: 'This shortcut mutates live prompt-buffer cursor/edit state that is not part of the model tool contract.',
      };
    case 'focus-work-tree':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Moves the keyboard onto the conversation work tree: arrows move and fold, Enter opens a tool call, y copies, Esc returns to the composer.',
      };
  }
}

export function totalHarnessKeybindings(context: KeybindingContext): number {
  return context.workspace.keybindingsManager?.getAll().length ?? Object.keys(DEFAULT_KEYBINDINGS).length;
}

export function totalHarnessShortcuts(context: KeybindingContext): number {
  return totalHarnessKeybindings(context) + FIXED_SHORTCUTS.length;
}

function fixedShortcutModelRoute(shortcut: Record<string, string>): string {
  switch (shortcut.key) {
    case '/shortcuts': return 'workspace action:"shortcuts"';
    case '/keybindings': return 'workspace action:"keybindings"';
    case '? / F1': return 'workspace action:"open" surfaceId:"help-overlay"';
    case 'F2': return 'workspace action:"open" surfaceId:"process-monitor"';
    case 'Tab': return 'workspace action:"commands"';
    case 'Enter':
    case 'Shift+Enter / Ctrl+J': return 'main conversation';
    default: return 'direct-user-interaction';
  }
}

function describeFixedShortcut(shortcut: Record<string, string>): Record<string, unknown> {
  return {
    ...shortcut,
    source: 'fixed',
    userEditable: false,
    modelRoute: fixedShortcutModelRoute(shortcut),
    modelAccess: {
      inspectShortcuts: 'workspace action:"shortcuts"',
      inspectKeybindings: 'workspace action:"keybindings"',
      preferred: fixedShortcutModelRoute(shortcut),
    },
  };
}

export async function listHarnessShortcuts(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const sources = captureKeybindingSources(context, args, options);
  const keybindings = await listHarnessKeybindings(context, sources.input, options);
  const query = readString(sources.input.query);
  const allFixed = captureCatalogData(FIXED_SHORTCUTS);
  const assertSource = () => {
    sources.assertSource();
    if (JSON.stringify(captureCatalogData(FIXED_SHORTCUTS)) !== JSON.stringify(allFixed)) throw new ToolInputProjectionError('stale');
  };
  const assertCurrent = () => { sources.assertCurrent(); assertSource(); };
  options.retainCurrent?.(assertSource, 'agent.harness.shortcuts.sources');
  const selected = query ? await rankHarnessCatalog(allFixed, query,
    shortcut => ({ id: shortcut.key, description: `${shortcut.key}\n${shortcut.description}`, evidence: shortcut }),
    'agent.harness.shortcuts', { ...options, requirePreservedSource: true, assertCurrent })
    : { matches: allFixed.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  assertCurrent();
  const fixed = selected.matches.slice(0, readLimit(sources.input.limit, 200)).map(({ entry, judgment }) => ({
    ...describeFixedShortcut(entry), ...(judgment ? { judgment } : {}),
  }));
  const degraded = keybindings.status === 'degraded';
  return {
    status: degraded ? 'degraded' : 'available',
    configPath: keybindings.configPath,
    fixedShortcuts: fixed,
    judgments: selected.judgments,
    configurableKeybindings: keybindings.keybindings,
    returned: fixed.length + Number(keybindings.returned ?? 0),
    total: totalHarnessShortcuts(context),
    policy: degraded
      ? 'Fixed shortcuts and default keybindings are available for discovery. Live keybinding execution and mutation require the runtime keybinding manager.'
      : 'Fixed shortcuts are runtime/editor controls. Configurable keybindings can be inspected, supported shell-safe actions can be run with run_keybinding, and bindings can be changed with set_keybinding/reset_keybinding.',
  };
}

export async function listHarnessKeybindings(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const sources = captureKeybindingSources(context, args, options);
  const { manager } = sources;
  const selected = await rankKeybindings(sources, readString(sources.input.query), options);
  sources.assertCurrent();
  const entries = selected.matches.slice(0, readLimit(sources.input.limit, 200)).map(({ entry, judgment }) => ({
    ...describeBinding(manager, entry.action, entry.combos), ...(judgment ? { judgment } : {}),
  }));
  return {
    status: manager ? 'available' : 'degraded',
    configPath: sources.configPath,
    keybindings: entries,
    judgments: selected.judgments,
    returned: entries.length,
    total: sources.entries.length,
    policy: manager
      ? 'Reads the live resolved keybindings, including modelOperation route metadata. run_keybinding executes only supported shell-safe actions. set_keybinding/reset_keybinding write the same keybindings.json file the user can edit and reload the runtime manager.'
      : 'Live keybinding manager is unavailable; default keybindings are shown for discovery only. run_keybinding, set_keybinding, and reset_keybinding require a live manager.',
  };
}

export async function describeHarnessKeybinding(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown> | null> {
  const sources = captureKeybindingSources(context, args, options);
  const { manager, entries } = sources;
  const resolved = await resolveHarnessKeybinding(sources, sources.input, options);
  sources.assertCurrent();
  if (resolved?.status === 'ambiguous') return { status: 'ambiguous', input: resolved.input, candidates: resolved.candidates };
  if (!resolved) return null;
  const entry = entries.find((candidate) => candidate.action === resolved.action);
  return entry ? {
    status: manager ? 'available' : 'degraded',
    configPath: sources.configPath,
    ...describeBinding(manager, entry.action, entry.combos, resolved.lookup),
    ...(resolved.judgment ? { judgment: resolved.judgment } : {}),
    ...(manager ? {} : { note: 'Default keybinding descriptor only; live run/set/reset operations require the runtime keybinding manager.' }),
  } : null;
}

function runUnavailable(action: KeyAction, route: KeybindingOperationRoute, reason?: string): Record<string, unknown> {
  return {
    status: 'keybinding_route_unavailable',
    action,
    modelOperation: route,
    ...(reason ? { reason } : {}),
  };
}

export async function runHarnessKeybinding(context: KeybindingExecutionContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const manager = requireKeybindingsManager(context);
  const sources = captureKeybindingSources(context, args, options, false);
  const resolved = await resolveHarnessKeybinding(sources, sources.input, options);
  sources.assertCurrent();
  if (resolved?.status === 'ambiguous') return { status: 'ambiguous', input: resolved.input, candidates: resolved.candidates };
  if (!resolved) throw new Error('run_keybinding requires a valid keybinding actionId, key, target or query.');
  const entry = manager.getAll().find((candidate) => candidate.action === resolved.action);
  if (!entry) throw new Error(`No live keybinding entry found for ${resolved.action}.`);
  const route = keybindingOperationRoute(resolved.action);
  const descriptor = {
    configPath: manager.getConfigPath(),
    ...describeBinding(manager, entry.action, entry.combos, resolved.lookup),
    ...(resolved.judgment ? { judgment: resolved.judgment } : {}),
  };
  if (!route.supported) {
    return {
      status: 'unsupported_keybinding_action',
      action: resolved.action,
      keybinding: descriptor,
      modelOperation: route,
      reason: route.note,
    };
  }

  switch (resolved.action) {
    case 'clear-cancel':
      if (!context.cancelGeneration) return runUnavailable(resolved.action, route, 'Cancel-generation route is unavailable.');
      if (context.isGenerating && !context.isGenerating()) {
        return { status: 'nothing_to_cancel', action: resolved.action, reason: 'No generation is running, so nothing was cancelled.', keybinding: descriptor };
      }
      context.cancelGeneration();
      return { status: 'executed', action: resolved.action, effect: 'cancel-generation', keybinding: descriptor };
    case 'screen-clear':
      if (!context.clearScreen) return runUnavailable(resolved.action, route, 'Clear-screen route is unavailable.');
      context.clearScreen();
      return { status: 'executed', action: resolved.action, effect: 'screen-clear', keybinding: descriptor };
    case 'workspace-picker':
      if (context.openWorkspacePicker) {
        context.openWorkspacePicker();
        return { status: 'executed', action: resolved.action, effect: 'agent-workspace-opened', route: 'openWorkspacePicker', keybinding: descriptor };
      }
      if (context.openAgentWorkspace) {
        context.openAgentWorkspace('home');
        return { status: 'executed', action: resolved.action, effect: 'agent-workspace-opened', route: 'openAgentWorkspace', categoryId: 'home', keybinding: descriptor };
      }
      return runUnavailable(resolved.action, route, 'No workspace picker or Agent workspace route is available.');
    case 'workspace-close': {
      if (!context.dismissAgentWorkspace) return runUnavailable(resolved.action, route, 'Agent workspace dismiss route is unavailable.');
      const dismissedAgentWorkspace = context.dismissAgentWorkspace();
      if (dismissedAgentWorkspace) {
        return {
          status: 'executed',
          action: resolved.action,
          effect: 'agent-workspace-dismissed',
          route: 'dismissAgentWorkspace',
          keybinding: descriptor,
        };
      }
      // The real shortcut only dismisses the workspace; focusing the prompt here would be an effect it does not have.
      return { status: 'nothing_to_dismiss', action: resolved.action, reason: 'No Agent workspace is open, so nothing was dismissed.', keybinding: descriptor };
    }
    case 'workspace-close-all': {
      if (!context.dismissAgentWorkspace) return runUnavailable(resolved.action, route, 'Agent workspace dismiss route is unavailable.');
      const dismissedAgentWorkspace = context.dismissAgentWorkspace();
      if (dismissedAgentWorkspace) {
        return {
          status: 'executed',
          action: resolved.action,
          effect: 'agent-workspace-dismissed',
          route: 'dismissAgentWorkspace',
          keybinding: descriptor,
        };
      }
      // The real shortcut only dismisses the workspace; focusing the prompt here would be an effect it does not have.
      return { status: 'nothing_to_dismiss', action: resolved.action, reason: 'No Agent workspace is open, so nothing was dismissed.', keybinding: descriptor };
    }
    case 'history-search': {
      if (!context.openPromptHistorySearch) return runUnavailable(resolved.action, route, 'Prompt history search route is unavailable.');
      const query = readString(args.value);
      context.openPromptHistorySearch(query || undefined);
      return { status: 'executed', action: resolved.action, effect: 'prompt-history-search-opened', query, keybinding: descriptor };
    }
    case 'search': {
      if (!context.openConversationSearch) return runUnavailable(resolved.action, route, 'Conversation search route is unavailable.');
      const query = readString(args.value);
      context.openConversationSearch(query || undefined);
      return { status: 'executed', action: resolved.action, effect: 'conversation-search-opened', query, keybinding: descriptor };
    }
    case 'paste': {
      if (!context.pasteFromClipboard) return runUnavailable(resolved.action, route, 'This Agent shell does not give commands a clipboard paste route. Ctrl+V in the prompt still pastes; ask the user to paste directly.');
      const pasted = context.pasteFromClipboard();
      if (!pasted.pasted) {
        return { status: 'not_pasted', action: resolved.action, effect: 'paste-from-clipboard', reason: 'The clipboard holds no supported text or image data, so nothing was pasted.', pasted, keybinding: descriptor };
      }
      return { status: 'executed', action: resolved.action, effect: 'paste-from-clipboard', pasted, keybinding: descriptor };
    }
    case 'block-copy':
    case 'bookmark': {
      if (!context.openBlockActions) return runUnavailable(resolved.action, route, 'Block action surface route is unavailable.');
      const opened = context.openBlockActions();
      return opened
        ? {
          status: 'visible_interaction_required',
          action: resolved.action,
          effect: 'block-actions-opened',
          keybinding: descriptor,
          note: 'The block action surface is open. Selecting the exact nearest-block action remains visible interactive shell work.',
        }
        : {
          status: 'not_opened',
          action: resolved.action,
          effect: 'block-actions',
          keybinding: descriptor,
          note: 'The current shell did not have an empty prompt plus nearby block required for block actions.',
        };
    }
    default:
      return {
        status: 'unsupported_keybinding_action',
        action: resolved.action,
        keybinding: descriptor,
        modelOperation: route,
      };
  }
}

/** Other actions that use one of `combos`, and which of the two wins (the later action in catalog order takes the chord). */
function chordConflicts(manager: KeybindingsManager, action: KeyAction, combos: readonly KeyCombo[]): Record<string, unknown>[] {
  const mine = new Set(combos.map(comboFingerprint));
  const all = manager.getAll();
  const position = all.findIndex((entry) => entry.action === action);
  const conflicts: Record<string, unknown>[] = [];
  all.forEach((entry, index) => {
    if (entry.action === action) return;
    const shared = entry.combos.filter((combo) => mine.has(comboFingerprint(combo)));
    if (shared.length === 0) return;
    conflicts.push({ action: entry.action, chord: formatCombo(manager, shared[0]!), takesTheChord: index > position ? entry.action : action });
  });
  for (const combo of combos) {
    const fixed = FIXED_KEYS.find((entry) => entry.chords.some((chord) => comboFingerprint(chord) === comboFingerprint(combo)));
    if (fixed) conflicts.push({ fixedShortcut: fixed.description, chord: formatCombo(manager, combo) });
  }
  return conflicts;
}

export async function setHarnessKeybinding(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const manager = requireKeybindingsManager(context);
  const sources = captureKeybindingSources(context, args, options, false);
  const resolved = await resolveHarnessKeybinding(sources, sources.input, options);
  sources.assertCurrent();
  if (resolved?.status === 'ambiguous') throw new Error(`Ambiguous keybinding action ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  if (!resolved) throw new Error('set_keybinding requires a valid keybinding actionId, key, target or query.');
  const modifierGuards = new Set<() => void>();
  const assertModifiersCurrent = () => { sources.assertCurrent(); for (const guard of modifierGuards) guard(); };
  const combos = await combosFromArgs(sources.input, { ...options, assertCurrent: assertModifiersCurrent,
    retainCurrent(guard, key) { modifierGuards.add(guard); options.retainCurrent?.(guard, key); } });
  assertModifiersCurrent();
  const configPath = manager.getConfigPath();
  // The manager reads, drops any legacy-name entry for this action, writes once and reloads;
  // a file it cannot read or parse is left as it is and the call is refused with the reason.
  let loadNotices: readonly string[];
  try { loadNotices = manager.setOverride(resolved.action, combos); } catch (error) {
    throw new Error(`set_keybinding was not applied: ${error instanceof Error ? error.message : String(error)}`);
  }
  options.signal?.throwIfAborted();
  const keybinding = await describeHarnessKeybinding(context, { actionId: resolved.action }, options);
  const conflicts = chordConflicts(manager, resolved.action, combos);
  const warnings = [
    ...loadNotices,
    // The loader already names a chord two actions share; only a clash it cannot see (a fixed shortcut) needs this text.
    ...(conflicts.some((conflict) => 'fixedShortcut' in conflict) || (conflicts.length > 0 && !loadNotices.some((notice) => notice.includes(' is bound to '))) ? ['The chord is also used elsewhere (see conflicts); only one binding takes it. Rebind the other action, or reset this one, if that was not intended.'] : []),
  ];
  return {
    status: 'updated',
    configPath,
    keybinding,
    lookup: resolved.lookup,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(resolved.judgment ? { selectionJudgment: resolved.judgment } : {}),
  };
}

export async function resetHarnessKeybinding(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const manager = requireKeybindingsManager(context);
  const sources = captureKeybindingSources(context, args, options, false);
  const resolved = await resolveHarnessKeybinding(sources, sources.input, options);
  sources.assertCurrent();
  if (resolved?.status === 'ambiguous') throw new Error(`Ambiguous keybinding action ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  if (!resolved) throw new Error('reset_keybinding requires a valid keybinding actionId, key, target or query.');
  const configPath = manager.getConfigPath();
  sources.assertCurrent();
  let loadNotices: readonly string[];
  try { loadNotices = manager.clearOverride(resolved.action); } catch (error) {
    throw new Error(`reset_keybinding was not applied: ${error instanceof Error ? error.message : String(error)}`);
  }
  options.signal?.throwIfAborted();
  const keybinding = await describeHarnessKeybinding(context, { actionId: resolved.action }, options);
  const warnings = [...loadNotices];
  return {
    status: 'reset',
    configPath,
    keybinding,
    lookup: resolved.lookup,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(resolved.judgment ? { selectionJudgment: resolved.judgment } : {}),
  };
}
