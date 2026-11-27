import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import type { EffectResult } from './agent-harness-tool-utils.ts';
import { harnessDisplayPath } from './agent-harness-display-path.ts';
import type { Ranked } from '@goodvibes/judgment';
import type { CommandContext } from '../input/command-registry.ts';
import {
  ACTION_DESCRIPTIONS,
  DEFAULT_KEYBINDINGS,
  type KeyAction,
  type KeyCombo,
  type KeybindingsManager,
} from '../input/keybindings.ts';
import { clampReadLimit } from '@goodvibes/engine/terminal-shell/agent-turn/read-helpers';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';
import { clipboardPasteReceipt } from '@goodvibes/engine/terminal-shell/input-content';

/**
 * Keys the shell handles itself before configurable bindings are consulted, and
 * the two commands that show them (the shortcut listing).
 */
const FIXED_SHORTCUTS: readonly { readonly key: string; readonly description: string }[] = [
  { key: 'Enter', description: 'Send prompt' },
  { key: 'Shift+Enter / Ctrl+J', description: 'Insert newline' },
  { key: 'Up / Down', description: 'Navigate input history, lists, and scrollable overlays' },
  { key: 'Tab', description: 'Autocomplete slash command or file mention' },
  { key: 'Esc', description: 'Close overlays, pickers, and transient input modes' },
  { key: '?', description: 'Open help: every command and keyboard shortcut in one list' },
  { key: '/help keys', description: 'List every key and the file that changes them' },
];

interface HarnessKeybindingArgs {
  readonly query?: unknown;
  readonly actionId?: unknown;
  readonly target?: unknown;
  readonly key?: unknown;
  readonly value?: unknown;
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
}

type KeybindingOperationEffect =
  | 'shell-action'
  | 'visible-ui-navigation'
  | 'visible-ui-interaction'
  | 'prompt-editor-state'
  | 'clipboard-selection'
  | 'reserved';

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
  'renderRequest' | 'clearScreen' | 'openCommandPalette'
  | 'focusPrompt' | 'openPromptHistorySearch' | 'openConversationSearch'
  | 'pasteFromClipboard' | 'openBlockActions'>;

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

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

/** The refusal every keybinding operation returns: what did not happen, why, and what to do next. */
function refused(status: 'unavailable' | 'not_found' | 'ambiguous' | 'not_applied', reason: string, next: string, extra: Record<string, unknown> = {}): EffectResult {
  return { status, done: false, reason, next, ...extra };
}

const NO_MANAGER = (): EffectResult => refused('unavailable',
  'This Agent runtime has no live keybinding manager, so keybindings can be listed (defaults) but not run or changed.',
  'Ask the owner to edit keybindings.json directly, or run this from the interactive Agent.');

/** The config path as the model may see it: home shown as ~. */
function shownConfigPath(context: KeybindingContext, manager: KeybindingsManager | null): string | null {
  const path = manager?.getConfigPath();
  return path ? harnessDisplayPath(path, context.workspace.shellPaths?.homeDirectory) : null;
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

const KEY_NAME_ALIASES: Readonly<Record<string, string>> = { esc: 'escape', return: 'enter', pgup: 'pageup', pgdn: 'pagedown', del: 'delete', ins: 'insert' };

/** The shell matches keys by lowercase logical name, so a combo stored as "G" or "Esc" would never fire. */
function normalizeKeyName(key: string): string {
  const lower = key.trim().toLowerCase();
  return KEY_NAME_ALIASES[lower] ?? lower;
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

function comboFingerprint(combo: KeyCombo): string {
  return `${combo.leader ? 'leader:' : ''}${combo.key.toLowerCase()}:${combo.ctrl ? 1 : 0}:${combo.shift ? 1 : 0}:${combo.alt ? 1 : 0}`;
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
  return `${combo.leader ? 'the leader then ' : ''}${parts.join('+')}`;
}

function describeCombo(manager: KeybindingsManager | null, combo: KeyCombo): Record<string, unknown> {
  return {
    key: combo.key,
    ctrl: combo.ctrl === true,
    shift: combo.shift === true,
    alt: combo.alt === true,
    ...(combo.leader ? { leader: true } : {}),
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

/** One read of the manager per call; a description built from it is consistent by construction. */
function readKeybindingSources(context: KeybindingContext, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const manager = readKeybindingsManager(context);
  return { manager, entries: manager?.getAll() ?? defaultKeybindingEntries(), configPath: shownConfigPath(context, manager) };
}

async function rankKeybindings(sources: ReturnType<typeof readKeybindingSources>, query: string, options: CatalogRankingOptions) {
  if (!query) return { matches: sources.entries.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  return rankHarnessCatalog(sources.entries, query, entry => ({ id: entry.action, description: bindingDescription(sources.manager, entry) }),
    'agent.harness.keybindings', options);
}

async function resolveHarnessKeybinding(sources: ReturnType<typeof readKeybindingSources>, args: HarnessKeybindingArgs, options: CatalogRankingOptions): Promise<KeybindingResolution | null> {
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
  options.signal?.throwIfAborted();
  const single = matches.length === 1 ? matches[0] : undefined;
  if (single?.judgment?.reading.verdict === 'yes' && single.judgment?.reading.outcome === 'act') return { status: 'found', action: single.entry.action, lookup: { ...lookup, resolvedBy: 'search' }, judgment: single.judgment };
  if (matches.length > 0) return { status: 'ambiguous', input: lookup.input, candidates: matches.map(({ entry, judgment }) => ({ ...bindingCandidate(manager, entry), judgment })).slice(0, 8) };
  return null;
}

function keybindingModelRoute(action: KeyAction): string {
  const route = keybindingOperationRoute(action);
  if (route.preferredMode === 'run_keybinding') return `screens_keys_commands action:"run_keybinding" actionId:"${action}"`;
  if (route.preferredMode === 'open_ui_surface' && route.surfaceId) return `screens_keys_commands action:"open" surfaceId:"${route.surfaceId}"`;
  if (route.preferredMode === 'open_ui_surface') return 'screens_keys_commands action:"open"';
  if (route.preferredMode === 'run_command' && route.command) return `screens_keys_commands action:"run_command" command:"${route.command}"`;
  if (route.preferredMode === 'run_command') return 'screens_keys_commands action:"run_command"';
  return 'direct-user-interaction';
}

function keybindingModelAccess(action: KeyAction, operation: KeybindingOperationRoute): Record<string, unknown> {
  return {
    inspect: `screens_keys_commands action:"keybinding" actionId:"${action}"`,
    run: operation.supported ? `screens_keys_commands action:"run_keybinding" actionId:"${action}"` : 'not exposed',
    set: `capability_run id:"keys.bind" inputs:{"action":"${action}","key":"<key>"}`,
    reset: `capability_run id:"keys.reset" inputs:{"action":"${action}"}`,
    preferred: keybindingModelRoute(action),
  };
}

/** The list form: what the binding is and how to run it; the single-binding view has the rest. */
function summarizeBinding(manager: KeybindingsManager | null, action: KeyAction, combos: KeyCombo[]): Record<string, unknown> {
  return {
    action,
    description: ACTION_DESCRIPTIONS[action],
    labels: combos.map((combo) => formatCombo(manager, combo)),
    customized: !combosEqual(combos, DEFAULT_KEYBINDINGS[action]),
    run: keybindingModelRoute(action),
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
      // While the model's own tool call runs a generation is in progress, so the
      // model would cancel the turn that asked and never read the result.
      return {
        supported: false,
        effect: 'shell-action',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Cancels the running generation, which is the model\'s own turn; only the owner presses it. Prompt clearing and double-press exit are direct user interaction too.',
      };
    case 'screen-clear':
      return {
        supported: true,
        effect: 'shell-action',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Runs the available clear-screen route.',
      };
    case 'open-agents':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        confirmation: 'Direct user interaction only.',
        note: 'Opens Your agents (what is running, what waits for you, what is scheduled, background services).',
      };
    case 'command-palette':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        surfaceId: 'help-overlay',
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Opens help: every command and keyboard shortcut in one searchable list.',
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
        confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.',
        note: 'Runs the paste route and reports whether text, image, or nothing was pasted (the capability paste.clipboard does the same).',
      };
    case 'block-save':
      return {
        supported: false,
        effect: 'visible-ui-interaction',
        preferredMode: 'direct-user-interaction',
        confirmation: 'No model operation is exposed.',
        note: 'Ctrl+S saves the block nearest the scroll position to a new file in the Agent bookmarks folder, so it depends on what the user is looking at. To save content yourself, write the file with the write tool.',
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
    case 'cycle-permission-mode':
    case 'open-notifications':
    case 'failure-other-model':
    case 'failure-details':
    case 'failure-retry':
    case 'failure-sign-in':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Acts on what the person sees: the session permission mode, the notices, or the newest failed turn\'s row (send it again, another model, details, sign in).',
      };
    case 'focus-work-tree':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Moves the keyboard onto the conversation work tree: arrows move and fold, Enter opens a tool call, y copies, Esc returns to the composer.',
      };
    case 'next-session':
    case 'previous-session':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Shows the next or previous agent or process from the session row above the conversation.',
      };
    case 'leader':
    case 'next-field':
    case 'choose':
    case 'back':
    case 'move-up':
    case 'move-down':
    case 'move-left':
    case 'move-right':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'A key the person presses on what is on screen: the leader starts a two-key shortcut; Tab, Enter, Esc and the arrows move, choose and go back.',
      };
    case 'open-menu':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Opens the menu of every place for the person at the screen.',
      };
    case 'scroll-page-up':
    case 'scroll-page-down':
    case 'model-picker-group':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Acts on what the person sees: scrolls the conversation a page, sends the next typed message as an ordinary one instead of the answer to a contract\'s question, or groups the open model list another way.',
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
    case '/help keys': return 'screens_keys_commands action:"keybindings"';
    case '?': return 'screens_keys_commands action:"open" surfaceId:"help-overlay"';
    case 'Tab': return 'screens_keys_commands action:"commands"';
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
      inspectShortcuts: 'screens_keys_commands action:"shortcuts"',
      inspectKeybindings: 'screens_keys_commands action:"keybindings"',
      preferred: fixedShortcutModelRoute(shortcut),
    },
  };
}

export async function listHarnessShortcuts(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const keybindings = await listHarnessKeybindings(context, args, options);
  const query = readString(args.query);
  const selected = query ? await rankHarnessCatalog(FIXED_SHORTCUTS, query,
    shortcut => ({ id: shortcut.key, description: `${shortcut.key}\n${shortcut.description}` }),
    'agent.harness.shortcuts', options)
    : { matches: FIXED_SHORTCUTS.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  options.signal?.throwIfAborted();
  const fixed = selected.matches.slice(0, readLimit(args.limit, 200)).map(({ entry, judgment }) => ({
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
      : 'Fixed shortcuts are runtime/editor controls. Configurable keybindings can be inspected, supported shell-safe actions can be run with run_keybinding, and bindings can be changed with capability_run id:"keys.bind" (keys.reset puts one back).',
  };
}

export async function listHarnessKeybindings(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const sources = readKeybindingSources(context, options);
  const { manager } = sources;
  const selected = await rankKeybindings(sources, readString(args.query), options);
  options.signal?.throwIfAborted();
  const long = args.includeParameters === true;
  const entries = selected.matches.slice(0, readLimit(args.limit, 200)).map(({ entry, judgment }) => ({
    ...(long ? describeBinding(manager, entry.action, entry.combos) : summarizeBinding(manager, entry.action, entry.combos)), ...(judgment ? { judgment } : {}),
  }));
  return {
    status: manager ? 'available' : 'degraded',
    configPath: sources.configPath,
    keybindings: entries,
    judgments: selected.judgments,
    returned: entries.length,
    total: sources.entries.length,
    policy: manager
      ? 'Reads the live resolved keybindings; screens_keys_commands action:"keybinding" actionId:"<action>" (or includeParameters:true) shows a binding\'s defaults and routes. run_keybinding executes only supported shell-safe actions. capability_run id:"keys.bind" (keys.reset puts one back) writes the same keybindings.json file the user can edit.'
      : 'Live keybinding manager is unavailable; default keybindings are shown for discovery only. run_keybinding needs a live manager; capability_run id:"keys.bind" (keys.reset puts one back) changes a binding.',
  };
}

export async function describeHarnessKeybinding(context: KeybindingContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown> | null> {
  const sources = readKeybindingSources(context, options);
  const { manager, entries } = sources;
  const resolved = await resolveHarnessKeybinding(sources, args, options);
  options.signal?.throwIfAborted();
  if (resolved?.status === 'ambiguous') return { status: 'ambiguous', input: resolved.input, candidates: resolved.candidates };
  if (!resolved) return null;
  const entry = entries.find((candidate) => candidate.action === resolved.action);
  return entry ? {
    status: manager ? 'available' : 'degraded',
    configPath: sources.configPath,
    ...describeBinding(manager, entry.action, entry.combos, resolved.lookup),
    ...(resolved.judgment ? { judgment: resolved.judgment } : {}),
    ...(manager ? {} : { note: 'Default keybinding descriptor only; run_keybinding requires the runtime keybinding manager.' }),
  } : null;
}

function unknownKeybinding(mode: string, args: HarnessKeybindingArgs): EffectResult {
  const given = readString(args.actionId) || readString(args.target) || readString(args.key) || readString(args.query);
  return refused('not_found', given ? `No keybinding action matches ${JSON.stringify(given)}, so nothing was done.` : `${mode} needs an actionId, key, target or query.`,
    'List the actions with screens_keys_commands action:"keybindings" and repeat with one actionId.');
}

function runUnavailable(action: KeyAction, route: KeybindingOperationRoute, reason?: string): EffectResult {
  return {
    status: 'keybinding_route_unavailable',
    done: false,
    action,
    modelOperation: route,
    ...(reason ? { reason } : {}),
  };
}

export async function runHarnessKeybinding(context: KeybindingExecutionContext, args: HarnessKeybindingArgs, options: CatalogRankingOptions = {}): Promise<EffectResult> {
  const sources = readKeybindingSources(context, options);
  const manager = sources.manager;
  if (!manager) return NO_MANAGER();
  const resolved = await resolveHarnessKeybinding(sources, args, options);
  options.signal?.throwIfAborted();
  if (resolved?.status === 'ambiguous') return refused('ambiguous', `${resolved.input} matches more than one keybinding, so nothing was run.`,
    'Repeat with one actionId from candidates.', { input: resolved.input, candidates: resolved.candidates });
  if (!resolved) return unknownKeybinding('run_keybinding', args);
  const entry = sources.entries.find((candidate) => candidate.action === resolved.action);
  if (!entry) return unknownKeybinding('run_keybinding', args);
  const route = keybindingOperationRoute(resolved.action);
  const descriptor = {
    configPath: sources.configPath,
    ...describeBinding(manager, entry.action, entry.combos, resolved.lookup),
    ...(resolved.judgment ? { judgment: resolved.judgment } : {}),
  };
  if (!route.supported) {
    return {
      status: 'unsupported_keybinding_action',
      done: false,
      action: resolved.action,
      keybinding: descriptor,
      modelOperation: route,
      reason: route.note,
    };
  }

  switch (resolved.action) {
    case 'screen-clear':
      if (!context.clearScreen) return runUnavailable(resolved.action, route, 'Clear-screen route is unavailable.');
      context.clearScreen();
      return { status: 'executed', done: true, action: resolved.action, effect: 'screen-clear', keybinding: descriptor };
    case 'command-palette':
      if (!context.openCommandPalette) return runUnavailable(resolved.action, route, 'Command palette route is unavailable.');
      context.openCommandPalette();
      return { status: 'executed', done: true, action: resolved.action, effect: 'help-opened', route: 'openCommandPalette', keybinding: descriptor };
    case 'history-search': {
      if (!context.openPromptHistorySearch) return runUnavailable(resolved.action, route, 'Prompt history search route is unavailable.');
      const query = readString(args.value);
      context.openPromptHistorySearch(query || undefined);
      return { status: 'executed', done: true, action: resolved.action, effect: 'prompt-history-search-opened', query, keybinding: descriptor };
    }
    case 'search': {
      if (!context.openConversationSearch) return runUnavailable(resolved.action, route, 'Conversation search route is unavailable.');
      const query = readString(args.value);
      context.openConversationSearch(query || undefined);
      return { status: 'executed', done: true, action: resolved.action, effect: 'conversation-search-opened', query, keybinding: descriptor };
    }
    case 'paste': {
      if (!context.pasteFromClipboard) return runUnavailable(resolved.action, route, 'This Agent shell does not give commands a clipboard paste route. Ctrl+V in the prompt still pastes; ask the user to paste directly.');
      // The receipt says that something was pasted, its kind and line count: never the
      // clipboard text, its marker or the unsent composer around it (the model reads this).
      const pasted = clipboardPasteReceipt(context.pasteFromClipboard());
      if (!pasted.pasted) {
        return { status: 'not_pasted', done: false, action: resolved.action, effect: 'paste-from-clipboard', reason: 'The clipboard holds no supported text or image data, so nothing was pasted.', pasted, keybinding: descriptor };
      }
      return { status: 'executed', done: true, action: resolved.action, effect: 'paste-from-clipboard', pasted, keybinding: descriptor };
    }
    case 'block-copy':
    case 'bookmark': {
      if (!context.openBlockActions) return runUnavailable(resolved.action, route, 'Block action surface route is unavailable.');
      const opened = context.openBlockActions();
      return opened
        ? {
          status: 'visible_interaction_required',
          done: true,
          action: resolved.action,
          effect: 'block-actions-opened',
          keybinding: descriptor,
          note: 'The block action surface is open. Selecting the exact nearest-block action remains visible interactive shell work.',
        }
        : {
          status: 'not_opened',
          done: false,
          action: resolved.action,
          effect: 'block-actions',
          keybinding: descriptor,
          note: 'The current shell did not have an empty prompt plus nearby block required for block actions.',
        };
    }
    default:
      return {
        status: 'unsupported_keybinding_action',
        done: false,
        action: resolved.action,
        keybinding: descriptor,
        modelOperation: route,
      };
  }
}

