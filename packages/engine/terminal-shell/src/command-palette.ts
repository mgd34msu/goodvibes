/**
 * command-palette.ts, the one help list both terminal apps open: `?`, `/help`,
 * `/commands` and Ctrl+P all open it.
 *
 * Every registered slash command, built live from the registry so it can never
 * drift from the real command set, and then the keyboard shortcuts as the last
 * group, read from the app's live key table. With no query the palette shows
 * four curated groups (Suggested, Session, Views, Settings), every other
 * command, and the shortcuts; typing filters across names, aliases, titles,
 * descriptions, categories and search words (an app adds its own, such as the
 * TUI's former view names "fleet", "tokens" and "git", which find the modal
 * that holds them now). A curated name the app does not register is skipped.
 * Each row is a plain title with the slash command (or the key) right-aligned
 * and dim, so the palette also teaches it.
 *
 * Suggested learns from what you use (per process); until it has something
 * to learn from it offers a sensible starting set.
 *
 * Enter runs the selected command; a described command opens its guided
 * path (what do you want to do, then its blanks). Another command that needs
 * arguments (and tab, for any command) fills the composer instead so the
 * arguments can be typed.
 */

import { readCommandDiscovery, type CommandDiscoveryReading } from '@goodvibes-jev/engine/platform/platform/routing';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.js';
import type { SurfaceLayer } from './renderer/surface-kit.js';
import { renderCommandPalette } from './renderer/command-palette.js';
import { isTextBackspace } from './delete-key-policy.js';
import type { PaletteEntry, PaletteGroup, PaletteRunMode, PaletteSection, PaletteView } from './command-palette-types.js';
export type { PaletteEntry, PaletteGroup, PaletteRunMode, PaletteSection, PaletteView } from './command-palette-types.js';

/** What the palette reads from a registered command (both apps' registries hold this much). */
export interface PaletteCommand {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[] | undefined;
  readonly argsHint?: string | undefined;
  readonly usage?: string | undefined;
  /** Present on a command built with `defineCommand`: Enter opens its guided path. */
  readonly described?: PaletteDescribed | undefined;
}

/** What the palette reads from a command's description (command-actions/types.ts `CommandDescription`). */
export interface PaletteDescribed {
  readonly title: string;
  readonly summary: string;
  readonly actions: readonly { readonly label: string }[];
}

/** One keyboard shortcut as the app's key table states it. */
export interface PaletteShortcut {
  /** The key or chord as the person presses it ("Ctrl+P", "Shift+Tab"). */
  readonly key: string;
  /** What it does, in a sentence. */
  readonly description: string;
}

interface CuratedEntry {
  readonly title: string;
  readonly group: Exclude<PaletteGroup, 'Suggested' | 'Commands'>;
  readonly keywords?: readonly string[];
  readonly right?: string;
}

/**
 * The curated groups, by command name. A name that is not registered in this
 * build is skipped, so the table never shows a command that does not exist.
 */
const CURATED: ReadonlyArray<readonly [string, CuratedEntry]> = [
  ['resume', { title: 'Resume a session', group: 'Session', keywords: ['open', 'load'] }],
  ['session', { title: 'Sessions', group: 'Session', keywords: ['saved', 'hosted', 'history'] }],
  ['clear', { title: 'Clear the conversation', group: 'Session', keywords: ['new', 'reset'] }],
  ['compact', { title: 'Compact context', group: 'Session', keywords: ['summarize', 'tokens'] }],
  ['fork', { title: 'Fork from here', group: 'Session', keywords: ['branch'] }],
  ['bookmarks', { title: 'Bookmarks', group: 'Session' }],
  ['replay', { title: 'Replay a session', group: 'Session' }],
  ['agents', { title: 'Agents', group: 'Views', keywords: ['hosted', 'acp', 'claude code', 'codex', 'opencode', 'steer', 'stop'] }],
  ['usage', { title: 'Usage', group: 'Views', keywords: ['budget', 'compact', 'price'] }],
  ['changes', { title: 'Changes', group: 'Views', keywords: ['files', 'stage', 'commit', 'hunk'] }],
  ['notifications', { title: 'Notifications', group: 'Views', keywords: ['notifications', 'alerts', 'messages', 'history', 'toasts'] }],
  ['context', { title: 'Context inspector', group: 'Views', keywords: ['tokens', 'window'] }],
  ['work-plan', { title: 'Work plan', group: 'Views', keywords: ['todo', 'plan'] }],
  ['hosted', { title: 'Hosted sessions', group: 'Views', keywords: ['daemon'] }],
  ['health', { title: 'Health', group: 'Views', keywords: ['doctor'] }],
  ['settings', { title: 'Settings', group: 'Settings', keywords: ['preferences', 'options', 'theme'] }],
  ['model', { title: 'Switch model', group: 'Settings', keywords: ['provider', 'llm'] }],
  ['effort', { title: 'Reasoning effort', group: 'Settings', keywords: ['thinking'] }],
  ['shortcuts', { title: 'Keyboard shortcuts', group: 'Settings', keywords: ['keys', 'help'] }],
  ['keybindings', { title: 'Keybindings', group: 'Settings', keywords: ['keys'] }],
  ['verbosity', { title: 'How much the app prints', group: 'Settings', keywords: ['quiet', 'notifications', 'print'] }],
  ['profiles', { title: 'Profiles', group: 'Settings' }],
  ['local-auth', { title: 'Local accounts', group: 'Settings', keywords: ['accounts', 'users', 'auth', 'password', 'local-auth'] }],
  ['tts', { title: 'Voice and speech', group: 'Settings', keywords: ['voice'] }],
];

/** The Suggested group before there is any usage to learn from. */
const DEFAULT_SUGGESTED = ['changes', 'model', 'compact'];
const SUGGESTED_COUNT = 3;

/** How often each command was run from the palette in this process. */
const usage = new Map<string, number>();

export function recordPaletteUse(id: string): void {
  usage.set(id, (usage.get(id) ?? 0) + 1);
}

/** Test hook. */
export function resetPaletteUsageForTests(): void {
  usage.clear();
}

function hasRequiredArgs(command: PaletteCommand): boolean {
  // A described command asks for what it needs: Enter opens its guided path.
  if (command.described) return false;
  const hint = command.argsHint ?? command.usage ?? '';
  return /<[^>]+>/.test(hint.replace(/\[[^\]]*\]/g, ''));
}

/** The first clause of a text, for a title. */
function firstClause(text: string): string {
  const first = text.split(/(?<=[.;])\s/)[0]!.replace(/[.;]$/, '');
  return first.length > 0 ? first : text;
}

/** Title for a command outside the curated table: its description's title, else its description's first clause. */
function titleOf(command: PaletteCommand): string {
  if (command.described?.title) return command.described.title;
  const text = command.description.trim();
  return text ? firstClause(text) : `/${command.name}`;
}

/** The one sentence the detail pane and the narrow screen show: the description's summary, else its first sentence. */
function summaryOf(command: PaletteCommand): string {
  if (command.described?.summary) return command.described.summary;
  const text = command.description.trim();
  return text.split(/(?<=[.;])\s/)[0] ?? text;
}

/**
 * Build the palette's entries from the registered commands and the app's
 * keyboard shortcuts. `extraKeywords` adds an app's own search words to a
 * command (the TUI's former view names).
 */
export function buildPaletteEntries(
  commands: readonly PaletteCommand[],
  categories: ReadonlyMap<string, string>,
  extraKeywords: ReadonlyMap<string, readonly string[]> = new Map(),
  shortcuts: readonly PaletteShortcut[] = [],
): PaletteEntry[] {
  const curated = new Map(CURATED);
  const entries: PaletteEntry[] = [];
  for (const command of commands) {
    const c = curated.get(command.name);
    const extra = extraKeywords.get(command.name) ?? [];
    entries.push({
      id: command.name,
      kind: 'command',
      title: c?.title ?? titleOf(command),
      summary: summaryOf(command),
      description: command.description,
      category: categories.get(command.name) ?? 'Other',
      group: c?.group ?? 'Commands',
      aliases: command.aliases ?? [],
      keywords: [...extra, ...(c?.keywords ?? [])],
      actions: command.described?.actions.map((action) => action.label) ?? [],
      ...(command.argsHint ?? command.usage ? { argsHint: command.argsHint ?? command.usage } : {}),
      needsArgs: hasRequiredArgs(command),
      right: c?.right ?? `/${command.name}`,
    });
  }
  // Curated entries in table order, the rest alphabetically by name.
  const order = new Map(CURATED.map(([name], index) => [name, index]));
  entries.sort((a, b) => {
    const oa = order.get(a.id);
    const ob = order.get(b.id);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });
  // The keyboard shortcuts, last, in the app's own order.
  shortcuts.forEach((shortcut, index) => {
    entries.push({
      id: `key:${index}`,
      kind: 'shortcut',
      title: shortcut.description,
      summary: shortcut.description,
      description: shortcut.description,
      category: 'Keyboard shortcuts',
      group: 'Keyboard shortcuts',
      aliases: [],
      keywords: [shortcut.key],
      actions: [],
      needsArgs: false,
      right: shortcut.key,
    });
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function wordScore(entry: PaletteEntry, word: string): number {
  if (entry.kind === 'shortcut') {
    const title = entry.title.toLowerCase();
    const key = entry.right.toLowerCase();
    if (key === word) return 90;
    if (title.split(/[\s/-]+/).some((w) => w.startsWith(word))) return 30;
    if (key.includes(word) || title.includes(word)) return 15;
    return 0;
  }
  const name = entry.id.toLowerCase();
  const title = entry.title.toLowerCase();
  if (name === word) return 100;
  if (name.startsWith(word)) return 80;
  if (entry.aliases.some((a) => a.toLowerCase() === word)) return 75;
  if (entry.aliases.some((a) => a.toLowerCase().startsWith(word))) return 70;
  if (title.split(/[\s/-]+/).some((w) => w.startsWith(word))) return 60;
  if (entry.keywords.some((k) => k.toLowerCase().startsWith(word))) return 55;
  if (name.includes(word) || title.includes(word)) return 40;
  if (entry.keywords.some((k) => k.toLowerCase().includes(word))) return 35;
  if (entry.description.toLowerCase().includes(word)) return 20;
  if (entry.category.toLowerCase().includes(word)) return 10;
  return 0;
}

/** Match score for a query (every word must match somewhere), or 0 for no match. */
export function paletteScore(entry: PaletteEntry, query: string): number {
  const words = query.trim().toLowerCase().replace(/^\//, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let total = 0;
  for (const word of words) {
    const s = wordScore(entry, word);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}


// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export interface CommandPaletteOptions {
  readonly entries: readonly PaletteEntry[];
  readonly onChanged?: () => void;
  /** Run or fill the composer with a command; the palette has already closed. */
  readonly onRun: (entry: PaletteEntry, mode: PaletteRunMode) => void;
  /** Optional live note for a row (e.g. the current model), shown muted after its title. */
  readonly describe?: (id: string) => string | undefined;
}

export class CommandPalette implements SurfaceModal, PaletteView {
  readonly name = 'command-palette';
  private queryValue = '';
  private closed = false;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchController: AbortController | undefined;
  private semantic: CommandDiscoveryReading | undefined;
  searching = false;

  get query(): string { return this.queryValue; }
  set query(value: string) { this.setQuery(value); }
  selectedIndex = 0;
  private sectionsCache: { query: string; sections: PaletteSection[] } | null = null;

  constructor(private readonly options: CommandPaletteOptions) {}

  get entries(): readonly PaletteEntry[] {
    return this.options.entries;
  }

  describe(id: string): string | undefined {
    return this.options.describe?.(id);
  }

  /** The groups shown for the current query. */
  sections(): PaletteSection[] {
    if (this.sectionsCache?.query === this.query) return this.sectionsCache.sections;
    const sections: PaletteSection[] = [];
    if (this.query.trim().length === 0) {
      const byId = new Map(this.entries.map((e) => [e.id, e]));
      const learned = [...usage.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const suggested: PaletteEntry[] = [];
      for (const id of [...learned, ...DEFAULT_SUGGESTED]) {
        const entry = byId.get(id);
        if (entry && !suggested.includes(entry)) suggested.push(entry);
        if (suggested.length >= SUGGESTED_COUNT) break;
      }
      if (suggested.length > 0) sections.push({ group: 'Suggested', entries: suggested });
      for (const group of ['Session', 'Views', 'Settings', 'Commands', 'Keyboard shortcuts'] as const) {
        const entries = this.entries.filter((e) => e.group === group && !suggested.includes(e));
        if (entries.length > 0) sections.push({ group, entries });
      }
    } else {
      const ranked = this.entries
        .map((entry, index) => ({ entry, index, score: paletteScore(entry, this.query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((r) => r.entry);
      const commands = ranked.filter((entry) => entry.kind === 'command');
      const keys = ranked.filter((entry) => entry.kind === 'shortcut');
      const entries = commands.length ? commands : this.semantic?.ids.flatMap(id => this.entries.filter(entry => entry.kind === 'command' && entry.id === id)) ?? [];
      if (entries.length > 0) sections.push({ group: 'Commands', entries });
      if (keys.length > 0) sections.push({ group: 'Keyboard shortcuts', entries: keys });
    }
    this.sectionsCache = { query: this.query, sections };
    return sections;
  }

  /** Entries in display order (what up and down walk). */
  flat(): PaletteEntry[] {
    return this.sections().flatMap((s) => s.entries);
  }

  getSelected(): PaletteEntry | null {
    const flat = this.flat();
    return flat[Math.max(0, Math.min(this.selectedIndex, flat.length - 1))] ?? null;
  }

  setQuery(query: string): void {
    if (query === this.queryValue || this.closed) return;
    this.cancelSearch();
    this.queryValue = query;
    this.selectedIndex = 0;
    this.sectionsCache = null;
    this.semantic = undefined;
    if (!query.trim() || this.entries.some(entry => entry.kind === 'command' && paletteScore(entry, query) > 0)) return;
    this.searching = true;
    const controller = new AbortController();
    this.searchController = controller;
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      void this.findSemanticCommands(query, controller);
    }, 250);
  }

  /**
   * The entries are fixed when the palette opens, and a suggestion only names a
   * command: running it resolves the name against the live registry, which
   * reports a command that has gone since by name. So the one check is that
   * this search is still the palette's current one.
   */
  private async findSemanticCommands(query: string, controller: AbortController): Promise<void> {
    const current = () => {
      controller.signal.throwIfAborted();
      if (this.closed || this.query !== query || this.searchController !== controller) throw new Error('Command search changed.');
    };
    try {
      const commands = this.entries.filter((entry) => entry.kind === 'command').map(({ id, title, description, aliases, keywords }) => ({ id, title, description, aliases, keywords }));
      const reading = await readCommandDiscovery({ query, commands }, { signal: controller.signal, assertCurrent: current });
      current();
      this.semantic = reading;
      this.sectionsCache = null;
    } catch { /* Literal results remain available when semantic search is unavailable. */ }
    finally {
      if (this.searchController === controller) {
        this.searching = false;
        this.options.onChanged?.();
      }
    }
  }

  private cancelSearch(): void {
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    this.searchController?.abort();
    this.searchController = undefined;
    this.searching = false;
  }

  onClose(): void {
    this.closed = true;
    this.cancelSearch();
    this.semantic = undefined;
    this.sectionsCache = null;
  }

  move(delta: number): void {
    const count = this.flat().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (token.type === 'text') {
      const text = [...token.value].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
      if (text) this.setQuery(this.query + text);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (token.ctrl && (key === 'p' || key === 'k')) {
      host.close(this, 'escape');
      return;
    }
    if (key === 'up') this.move(-1);
    else if (key === 'down') this.move(1);
    else if (key === 'pageup') this.move(-10);
    else if (key === 'pagedown') this.move(10);
    else if (isTextBackspace(key)) this.setQuery(this.query.slice(0, -1));
    else if (key === 'enter' || key === 'tab') {
      const entry = this.getSelected();
      // A shortcut row is read, not run: its key is pressed where it applies.
      if (!entry || entry.kind === 'shortcut') return;
      host.close(this, 'done');
      recordPaletteUse(entry.id);
      this.options.onRun(entry, key === 'tab' || entry.needsArgs ? 'fill' : 'run');
    }
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderCommandPalette(this, screenWidth, screenHeight);
  }
}

/** What opening the palette needs from an app's shell; both apps pass the same pieces. */
export interface CommandPaletteHost {
  readonly modals: SurfaceModalHost;
  /** The registered commands, read when the palette opens (never a hand-kept list). */
  readonly commands: () => readonly PaletteCommand[] | undefined;
  readonly categories: () => ReadonlyMap<string, string>;
  readonly extraKeywords?: ReadonlyMap<string, readonly string[]> | undefined;
  /** The app's keyboard shortcuts from its live key table: the list's last group. */
  readonly shortcuts?: (() => readonly PaletteShortcut[]) | undefined;
  readonly describe?: ((id: string) => string | undefined) | undefined;
  /** Runs the command as if typed bare: a described command opens its guided path. */
  readonly run: (name: string) => Promise<void>;
  /** Puts `/name ` in the composer, command mode armed, so arguments can be typed. */
  readonly fill: (name: string) => void;
  readonly render: () => void;
}

/** Open the palette over the shell, unless it is already the top modal. */
export function openCommandPaletteOn(host: CommandPaletteHost): void {
  const commands = host.commands();
  if (!commands) return;
  if (host.modals.top() instanceof CommandPalette) return;
  const palette = new CommandPalette({
    entries: buildPaletteEntries(commands, host.categories(), host.extraKeywords, host.shortcuts?.() ?? []),
    onChanged: host.render,
    ...(host.describe ? { describe: host.describe } : {}),
    onRun: (entry, mode) => {
      if (mode === 'run') { void host.run(entry.id).finally(() => host.render()); return; }
      host.fill(entry.id);
      host.render();
    },
  });
  host.modals.push(palette);
  host.render();
}
