/**
 * Shared keybinding storage and matching; product action catalogs remain explicit.
 *
 * A binding is a single combo (`{ "key": "x", "ctrl": true }`) or a sequence:
 * the leader, then one key (`{ "key": "m", "leader": true }`). The leader is a
 * binding like any other (the action `leader`, Ctrl+G by default); after it,
 * the next key completes the sequence or cancels it. Nothing waits on a clock.
 *
 * The navigation keys (Tab, Enter, Esc, the arrows) are actions of the table
 * too: a key bound to one of them is read as that key everywhere
 * (`translateNavigation`), and a navigation key bound to another action does
 * that action instead, so every key the programs act on can be rebound.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolveSurfaceDirectory } from '@goodvibes/engine/platform/platform/runtime/shell';
import { logger, summarizeError, writeDocument } from '@goodvibes/engine/platform/platform/utils';

export interface KeyCombo {
  key: string;
  ctrl?: boolean | undefined;
  shift?: boolean | undefined;
  alt?: boolean | undefined;
  /** Pressed after the leader (`leader`): the second key of a sequence. */
  leader?: boolean | undefined;
}
export interface KeyToken {
  logicalName?: string | undefined;
  ctrl?: boolean | undefined;
  shift?: boolean | undefined;
  alt?: boolean | undefined;
  meta?: boolean | undefined;
}
export interface KeybindingsManagerOptions {
  readonly configPath?: string | undefined;
  readonly userRoot?: string | undefined;
  readonly homeDirectory?: string | undefined;
  readonly surfaceRoot?: string | undefined;
}
export interface KeybindingCatalog<Action extends string> {
  readonly surfaceRoot: string;
  readonly defaults: Readonly<Record<Action, readonly KeyCombo[]>>;
  readonly descriptions: Readonly<Record<Action, string>>;
  readonly aliases?: Readonly<Record<string, Action>> | undefined;
  readonly abbreviateNamedKeys?: boolean | undefined;
}
/** Two actions bound to the same key or sequence: only `responds` acts on it. */
export interface KeyConflict {
  readonly label: string;
  readonly actions: readonly string[];
  readonly responds: string;
  /** The conflict in plain words, naming both actions by what they do. */
  readonly sentence: string;
}

/**
 * One action of a key context: the keys of one screen (a place), read only
 * while it is open. Its name in keybindings.json is `<context>.<name>`
 * (`place.automation.pause`).
 */
export interface KeyContextAction {
  readonly name: string;
  readonly description: string;
  readonly defaults: readonly KeyCombo[];
  /**
   * When it applies (a place's list and the item states): two actions of one
   * context whose scopes never apply together may share a key.
   */
  readonly scope?: { readonly list?: string | undefined; readonly states?: readonly string[] | undefined } | undefined;
}

/** The keys of one screen, rebindable like the program's own and checked for conflicts within it and against them. */
export interface KeyContext {
  readonly id: string;
  /** The screen's name, as the Keys place groups them ("Automation"). */
  readonly title: string;
  readonly actions: readonly KeyContextAction[];
  /**
   * Read wherever the program's own keys are (the composer), not only while a screen is open: `lookup` and
   * `lookupAfterLeader` answer `<context>.<name>` for a key bound to one of its entries that no program action has
   * (This conversation's controls, read while writing a message).
   */
  readonly global?: true | undefined;
}

/** A context action as the Keys place lists it. */
export interface KeyContextEntry {
  readonly action: string;
  readonly context: string;
  readonly contextTitle: string;
  readonly combos: readonly KeyCombo[];
  readonly description: string;
}

/** Overrides under a name of this form wait for their context to be registered instead of being refused. */
const CONTEXT_PREFIX = 'place.';

/** The action that starts a sequence. */
export const LEADER_ACTION = 'leader';

/**
 * The navigation actions and the key each one IS: a key bound to the action is
 * read as this key by every screen. Esc, Enter, Tab and the arrows keep these
 * by default.
 */
export const NAVIGATION_KEYS: Readonly<Record<string, KeyCombo>> = {
  'next-field': { key: 'tab' },
  'choose': { key: 'enter' },
  'back': { key: 'escape' },
  'move-up': { key: 'up' },
  'move-down': { key: 'down' },
  'move-left': { key: 'left' },
  'move-right': { key: 'right' },
};

function isKeyCombo(value: unknown): value is KeyCombo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('key' in value) || typeof value.key !== 'string' || value.key.length === 0) return false;
  for (const modifier of ['ctrl', 'shift', 'alt', 'leader'] as const) {
    const flag: unknown = Reflect.get(value, modifier);
    if (flag !== undefined && typeof flag !== 'boolean') return false;
  }
  return true;
}
function tokenKey(token: KeyToken): string {
  // The tokenizer reports Alt as meta; explicit alt takes precedence.
  return `${token.logicalName}:${token.ctrl ? 1 : 0}:${token.shift ? 1 : 0}:${(token.alt ?? token.meta) ? 1 : 0}`;
}
function comboKey(combo: KeyCombo): string {
  return `${combo.leader ? 'L|' : ''}${tokenKey({ ...combo, logicalName: combo.key })}`;
}

/**
 * The key a typed character is, for the key after the leader: a letter is
 * that key (a capital is Shift and the letter), any other single character is
 * itself. Undefined for text that is not one character (a paste).
 */
export function keyTokenFromText(value: string): KeyToken | undefined {
  const chars = [...value];
  if (chars.length !== 1) return undefined;
  const ch = chars[0]!;
  if (/^[A-Z]$/.test(ch)) return { logicalName: ch.toLowerCase(), shift: true };
  return { logicalName: ch };
}

const KEY_NAME_WORDS: Readonly<Record<string, string>> = {
  esc: 'escape', return: 'enter', pgup: 'pageup', pgdn: 'pagedown', pagedn: 'pagedown', del: 'delete', ins: 'insert', space: ' ',
};

/**
 * A key as a person writes it, as the table binds it: `ctrl+k`, `F5`,
 * `shift+tab`, `Ctrl+Shift+C`, and the leader then a key as `leader m` (or the
 * leader as it is shown: `Ctrl+G M`). What `formatCombo` writes reads back
 * (except `PageDn`-style short names, read as their keys).
 * Undefined for text that is no key.
 */
export function parseKeyText(text: string, leaderLabel?: string): KeyCombo | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return undefined;
  const one = (word: string): KeyCombo | undefined => {
    const parts = word.split('+').filter((part, index, all) => part !== '' || index === all.length - 1);
    const name = parts.pop();
    if (!name) return undefined;
    const combo: KeyCombo = { key: '' };
    for (const modifier of parts.map((part) => part.toLowerCase())) {
      if (modifier === 'ctrl' || modifier === 'control') combo.ctrl = true;
      else if (modifier === 'shift') combo.shift = true;
      else if (modifier === 'alt' || modifier === 'meta' || modifier === 'option') combo.alt = true;
      else return undefined;
    }
    // Letters are written as the table shows them (`M`); Shift is written out (`shift+y`).
    const lower = name.toLowerCase();
    combo.key = KEY_NAME_WORDS[lower] ?? lower;
    return combo;
  };
  if (words.length === 1) return one(words[0]!);
  const first = words[0]!.toLowerCase();
  if (first !== 'leader' && first !== (leaderLabel ?? '').toLowerCase()) return undefined;
  const after = one(words[1]!);
  return after ? { ...after, leader: true } : undefined;
}

/** Tokens a navigation translation produced, with the action each one stands for. */
const translated = new WeakMap<object, string>();

/** What `translateNavigation` made of a key. */
export type NavigationTranslation<T> =
  | { readonly kind: 'pass' }
  | { readonly kind: 'rewrite'; readonly token: T };

export class KeybindingsManager<Action extends string> {
  private bindings: Record<Action, KeyCombo[]>;
  private readonly configPath: string;
  private readonly lookupMap = new Map<string, Action>();
  private conflicts: KeyConflict[] = [];
  /** The screens' own key contexts (places), by id. */
  private readonly contexts = new Map<string, KeyContext>();
  /** Each context action's keys now, by `<context>.<name>`. */
  private readonly contextBindings = new Map<string, KeyCombo[]>();
  /** The file's entries as last read, so a context registered later gets its overrides. */
  private lastOverrides: Readonly<Record<string, unknown>> = {};
  /** Told after every read of the file (a change from the Keys place, the model, or a hand edit read again). */
  private readonly listeners = new Set<() => void>();

  constructor(options: KeybindingsManagerOptions, private readonly catalog: KeybindingCatalog<Action>) {
    const userRoot = options.userRoot ?? options.homeDirectory;
    if (options.configPath) this.configPath = options.configPath;
    else {
      if (!userRoot) throw new Error('KeybindingsManager requires configPath or an explicit userRoot/homeDirectory.');
      this.configPath = resolveSurfaceDirectory(userRoot, options.surfaceRoot || catalog.surfaceRoot, 'keybindings.json');
    }
    this.bindings = this.cloneDefaults();
    this.buildLookupMap();
  }
  private actions(): Action[] { return Object.keys(this.catalog.defaults) as Action[]; }
  private isAction(value: string): value is Action { return Object.hasOwn(this.catalog.defaults, value); }
  private cloneDefaults(): Record<Action, KeyCombo[]> {
    const result = {} as Record<Action, KeyCombo[]>;
    for (const action of this.actions()) result[action] = this.catalog.defaults[action].map(combo => ({ ...combo }));
    return result;
  }
  /**
   * Reload from defaults; malformed overrides never become executable bindings.
   * Returns one line per override that was skipped (and one when the whole file
   * was unreadable) so the host can tell the user why a shortcut does nothing.
   */
  loadFromDisk(): readonly string[] {
    const notices: string[] = [];
    if (!existsSync(this.configPath)) {
      // A deleted file means no overrides, not the previous file's overrides.
      this.bindings = this.cloneDefaults();
      this.lastOverrides = {};
      this.applyContextOverrides(notices);
      this.buildLookupMap();
      this.notify();
      return notices;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Keybindings must be an object.');
      this.bindings = this.cloneDefaults();
      this.lastOverrides = parsed as Record<string, unknown>;
      for (const [rawAction, combo] of Object.entries(parsed)) {
        const aliases = this.catalog.aliases;
        const action = aliases && Object.hasOwn(aliases, rawAction) ? aliases[rawAction] : rawAction;
        // A screen's key (a place's) is applied by its context, now or when the screen registers it.
        if (rawAction.startsWith(CONTEXT_PREFIX)) continue;
        if (action === undefined || !this.isAction(action)) {
          notices.push(`keybindings: unknown action "${rawAction}" ignored`);
          continue;
        }
        const normalized: unknown[] = Array.isArray(combo) ? combo : [combo];
        if (!normalized.every(isKeyCombo)) {
          notices.push(`keybindings: invalid key combination for "${rawAction}" ignored; the default stays`);
          continue;
        }
        this.bindings[action] = normalized;
      }
      logger.debug('keybindings: loaded overrides from disk', { path: this.configPath });
    } catch (error) {
      this.bindings = this.cloneDefaults();
      this.lastOverrides = {};
      notices.push(`keybindings: ${this.configPath} could not be read (${summarizeError(error)}); defaults are in use`);
    }
    this.applyContextOverrides(notices);
    notices.push(...this.buildLookupMap());
    if (notices.length > 0) logger.warn('keybindings: some overrides were not applied', { path: this.configPath, notices });
    this.notify();
    return notices;
  }
  /** Be told after every read of the file; returns the stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { logger.debug('keybindings: a listener threw', { error: summarizeError(error) }); }
    }
  }
  /**
   * Bind `action` to `combos` in the user's file and reload. Entries for the
   * same action under a legacy name are dropped, so the one written is the one
   * that applies. Returns the reload's notices.
   */
  setOverride(action: Action | string, combos: readonly KeyCombo[]): readonly string[] {
    if (!this.isAction(action) && !this.contextBindings.has(action)) throw new Error(`keybindings: "${action}" is not an action of this program.`);
    if (combos.length === 0 || !combos.every(isKeyCombo)) throw new Error(`keybindings: a binding for "${action}" needs at least one key combination with a key name.`);
    return this.writeOverride(action, combos.map(combo => ({ ...combo })));
  }
  /** Remove every entry for `action` (canonical or legacy name) from the user's file and reload, so the default applies. */
  clearOverride(action: Action | string): readonly string[] {
    if (!this.isAction(action) && !this.contextBindings.has(action)) throw new Error(`keybindings: "${action}" is not an action of this program.`);
    return this.writeOverride(action, undefined);
  }
  /** Put every key back on its default: the file's entries are all removed (the file itself stays). */
  clearAllOverrides(): readonly string[] {
    if (existsSync(this.configPath)) writeDocument(this.configPath, {});
    return this.loadFromDisk();
  }
  /**
   * Register a screen's keys (a place's): each action gets its override from
   * the file, else its defaults; conflicts within the context and against the
   * program's own keys are reported like any other. Returns the notices.
   */
  registerContext(context: KeyContext): readonly string[] {
    this.contexts.set(context.id, context);
    const notices: string[] = [];
    this.applyContextOverrides(notices, context);
    notices.push(...this.buildLookupMap().filter((notice) => notice.includes(`"${context.title}: `)));
    this.notify();
    return notices;
  }
  /** Each registered context's keys from the last read of the file, else their defaults. */
  private applyContextOverrides(notices: string[], only?: KeyContext): void {
    for (const context of only ? [only] : this.contexts.values()) {
      for (const action of context.actions) {
        const id = `${context.id}.${action.name}`;
        const raw = this.lastOverrides[id];
        if (raw === undefined) { this.contextBindings.set(id, action.defaults.map((combo) => ({ ...combo }))); continue; }
        const normalized: unknown[] = Array.isArray(raw) ? raw : [raw];
        if (!normalized.every(isKeyCombo)) {
          notices.push(`keybindings: invalid key combination for "${id}" ignored; the default stays`);
          this.contextBindings.set(id, action.defaults.map((combo) => ({ ...combo })));
          continue;
        }
        this.contextBindings.set(id, normalized.map((combo) => ({ ...combo })));
      }
    }
  }
  /** The names of the context actions `token` presses in `contextId` (`pause`); several share a key when their scopes never apply together. */
  lookupInContext(contextId: string, token: KeyToken): readonly string[] {
    const context = this.contexts.get(contextId);
    if (!context || !token.logicalName) return [];
    const pressed = tokenKey(token);
    return context.actions
      .filter((action) => (this.contextBindings.get(`${context.id}.${action.name}`) ?? []).some((combo) => !combo.leader && comboKey(combo) === pressed))
      .map((action) => action.name);
  }
  /** Every registered context action, with its keys now (the Keys place lists them under their screen's name). */
  getContextActions(): KeyContextEntry[] {
    const entries: KeyContextEntry[] = [];
    for (const context of this.contexts.values()) {
      for (const action of context.actions) {
        const id = `${context.id}.${action.name}`;
        entries.push({ action: id, context: context.id, contextTitle: context.title, combos: this.contextBindings.get(id) ?? [], description: action.description });
      }
    }
    return entries;
  }
  /**
   * The one writer of the file, reading it with the same rules as
   * loadFromDisk(). A file that cannot be read or parsed is left exactly as it
   * is and nothing is written: it may be a hand edit the user is in the middle of.
   */
  private writeOverride(action: Action | string, combos: KeyCombo[] | undefined): readonly string[] {
    let overrides: Record<string, unknown> = {};
    if (existsSync(this.configPath)) {
      let raw: string;
      try { raw = readFileSync(this.configPath, 'utf-8'); } catch (error) {
        throw new Error(`keybindings: ${this.configPath} could not be read (${summarizeError(error)}); it was left unchanged and no binding was written. Fix its permissions, then try again.`);
      }
      if (raw.trim()) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch (error) {
          throw new Error(`keybindings: ${this.configPath} is not valid JSON (${summarizeError(error)}); it was left unchanged and no binding was written. Fix the file, or delete it to start from the defaults, then try again.`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`keybindings: ${this.configPath} is not a JSON object; it was left unchanged and no binding was written. Fix the file, or delete it to start from the defaults, then try again.`);
        }
        overrides = parsed as Record<string, unknown>;
      }
    }
    const aliases = this.catalog.aliases;
    for (const name of Object.keys(overrides)) {
      if ((aliases && Object.hasOwn(aliases, name) ? aliases[name] : name) === action) delete overrides[name];
    }
    if (combos) overrides[action] = combos.length === 1 ? combos[0] : combos;
    writeDocument(this.configPath, overrides);
    return this.loadFromDisk();
  }
  /**
   * Rebuild the one table that lookup(), lookupAfterLeader() and matches()
   * read, and describe in plain words every key or sequence two actions share
   * and every sequence that cannot be pressed because no leader is bound.
   */
  private buildLookupMap(): string[] {
    this.lookupMap.clear();
    const owners = new Map<string, { combo: KeyCombo; actions: Action[] }>();
    // Preserve catalog order and the last-writer rule for collisions.
    for (const action of this.actions()) {
      for (const combo of this.bindings[action]) {
        const key = comboKey(combo);
        this.lookupMap.set(key, action);
        const entry = owners.get(key) ?? { combo, actions: [] };
        if (!entry.actions.includes(action)) entry.actions.push(action);
        owners.set(key, entry);
      }
    }
    this.conflicts = [];
    for (const [key, { combo, actions }] of owners) {
      if (actions.length < 2) continue;
      const responds = this.lookupMap.get(key)!;
      const label = this.formatCombo(combo);
      const named = actions.map((action) => `"${this.describe(action)}"`);
      const sentence = `${label} is bound to both ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}; only "${this.describe(responds)}" responds to it. Change one of them in the Keys place or in ${this.configPath}.`;
      this.conflicts.push({ label, actions, responds, sentence });
    }
    this.conflicts.push(...this.contextConflicts(owners));
    const notices = this.conflicts.map((conflict) => `keybindings: ${conflict.sentence}`);
    if (this.isAction(LEADER_ACTION) && this.bindings[LEADER_ACTION].length === 0) {
      for (const action of this.actions()) {
        if (this.bindings[action].some((combo) => combo.leader)) notices.push(`keybindings: "${this.describe(action)}" is bound to a key after the leader, but no leader key is bound, so it cannot be pressed.`);
      }
    }
    return notices;
  }
  /**
   * A screen's keys that clash: two of its actions on one key where both can
   * apply at once, or one of its keys that the program reads before the screen
   * (the leader, Ctrl+C) or that a program key elsewhere is also bound to.
   */
  private contextConflicts(owners: ReadonlyMap<string, { combo: KeyCombo; actions: Action[] }>): KeyConflict[] {
    const conflicts: KeyConflict[] = [];
    const overlap = (a: KeyContextAction, b: KeyContextAction): boolean => {
      if (a.scope?.list !== undefined && b.scope?.list !== undefined && a.scope.list !== b.scope.list) return false;
      if (a.scope?.states && b.scope?.states) return a.scope.states.some((state) => b.scope!.states!.includes(state));
      return true;
    };
    for (const context of this.contexts.values()) {
      const seen = new Map<string, KeyContextAction[]>();
      for (const action of context.actions) {
        for (const combo of this.contextBindings.get(`${context.id}.${action.name}`) ?? []) {
          const key = comboKey(combo);
          const sharing = seen.get(key) ?? [];
          for (const other of sharing) {
            if (!overlap(action, other)) continue;
            const ids = [`${context.id}.${other.name}`, `${context.id}.${action.name}`];
            const label = this.formatCombo(combo);
            conflicts.push({ label, actions: ids, responds: ids[0]!,
              sentence: `${label} is bound to both "${this.describe(ids[0]!)}" and "${this.describe(ids[1]!)}"; only "${this.describe(ids[0]!)}" responds to it. Change one of them in the Keys place or in ${this.configPath}.` });
          }
          seen.set(key, [...sharing, action]);
          // A program key on the same key: the leader and Ctrl+C are read before any screen; another is not read while the screen is open.
          const program = owners.get(key);
          if (!program || combo.leader) continue;
          const id = `${context.id}.${action.name}`;
          const first = program.actions.find((owner) => !Object.hasOwn(NAVIGATION_KEYS, owner));
          if (!first) continue;
          // A context read in the composer (`global`) gives way to the program's own key there.
          const before = first === LEADER_ACTION || first === 'clear-cancel' || context.global === true;
          // A program key the screen's key shadows only while the screen is open is no conflict: each works where it
          // is read. Only a key read before the screen (the leader, Ctrl+C, a context read in the composer) is one.
          if (!before) continue;
          const label = this.formatCombo(combo);
          const responds = before ? first : id;
          conflicts.push({ label, actions: [first, id], responds,
            sentence: `${label} is bound to both "${this.describe(first)}" and "${this.describe(id)}"; ${before ? `only "${this.describe(first)}" responds to it` : `in ${context.title} only "${this.describe(id)}" responds to it`}. Change one of them in the Keys place or in ${this.configPath}.` });
        }
      }
    }
    return conflicts;
  }
  private describe(action: Action | string): string {
    if (this.isAction(action)) return this.catalog.descriptions[action] ?? action;
    for (const context of this.contexts.values()) {
      if (!action.startsWith(`${context.id}.`)) continue;
      const found = context.actions.find((candidate) => `${context.id}.${candidate.name}` === action);
      if (found) return `${context.title}: ${found.description}`;
    }
    return action;
  }
  /** The action a key names on its own (never the second key of a sequence). */
  lookup(token: KeyToken): Action | null {
    const stood = translated.get(token as object);
    if (stood !== undefined && this.isAction(stood)) return stood;
    if (!token.logicalName) return null;
    return this.lookupMap.get(tokenKey(token)) ?? this.lookupGlobal(tokenKey(token), false);
  }
  /** The action the key pressed after the leader completes; null when that sequence is not bound. */
  lookupAfterLeader(token: KeyToken): Action | null {
    if (!token.logicalName) return null;
    return this.lookupMap.get(`L|${tokenKey(token)}`) ?? this.lookupGlobal(tokenKey(token), true);
  }
  /**
   * The entry of a global context (KeyContext `global`) a key no program action has is bound to, as
   * `<context>.<name>`; null when none. A program action on the same key wins (the conflict is reported).
   */
  private lookupGlobal(pressed: string, afterLeader: boolean): Action | null {
    for (const context of this.contexts.values()) {
      if (!context.global) continue;
      for (const action of context.actions) {
        const id = `${context.id}.${action.name}`;
        if ((this.contextBindings.get(id) ?? []).some((combo) => Boolean(combo.leader) === afterLeader && tokenKey({ ...combo, logicalName: combo.key }) === pressed)) {
          return id as Action;
        }
      }
    }
    return null;
  }
  /** Reads the same table as lookup(), so a chord shared by two actions reaches only the one lookup() names. */
  matches(action: string, token: KeyToken): boolean {
    return this.isAction(action) && this.lookup(token) === action;
  }
  /**
   * Read a key through the navigation actions: a key bound to one of them
   * becomes that action's own key (bound Ctrl+Space to next-field and it is a
   * Tab to every screen); a navigation key bound to another action stands for
   * that action and is no longer read as itself; an unbound navigation key is
   * nothing. Every other key passes as it is.
   */
  translateNavigation<T extends KeyToken & { readonly type?: string; readonly name?: string | undefined }>(token: T): NavigationTranslation<T> | { readonly kind: 'drop' } {
    if (token.type !== undefined && token.type !== 'key') return { kind: 'pass' };
    if (translated.has(token as object) || !token.logicalName) return { kind: 'pass' };
    const action = this.lookupMap.get(tokenKey(token)) ?? null;
    const navigation = action !== null ? NAVIGATION_KEYS[action] : undefined;
    const plain = !token.ctrl && !token.shift && !(token.alt ?? token.meta);
    const ownNavigation = plain ? Object.entries(NAVIGATION_KEYS).find(([, combo]) => combo.key === token.logicalName)?.[0] : undefined;
    if (navigation) {
      if (ownNavigation === action) return { kind: 'pass' };
      const rewritten = { ...token, name: navigation.key, logicalName: navigation.key, ctrl: false, shift: false, alt: false, meta: false } as T;
      translated.set(rewritten as object, action!);
      return { kind: 'rewrite', token: rewritten };
    }
    if (ownNavigation === undefined || !this.isAction(ownNavigation)) return { kind: 'pass' };
    // A navigation key given to another action: it stands for that action, never for itself.
    if (action === null) return { kind: 'drop' };
    const standing = { ...token, name: `bound:${action}`, logicalName: `bound:${action}` } as T;
    translated.set(standing as object, action);
    return { kind: 'rewrite', token: standing };
  }
  getAll(): Array<{ action: Action; combos: KeyCombo[]; description: string }> {
    return this.actions().map(action => ({ action, combos: this.bindings[action], description: this.catalog.descriptions[action] }));
  }
  /** The default bindings of an action (the Keys place's "put back the default"). */
  getDefaults(action: string): readonly KeyCombo[] {
    if (this.isAction(action)) return this.catalog.defaults[action];
    for (const context of this.contexts.values()) {
      const found = context.actions.find((candidate) => `${context.id}.${candidate.name}` === action);
      if (found) return found.defaults;
    }
    return [];
  }
  /** Every key or sequence two actions share, as last read. */
  getConflicts(): readonly KeyConflict[] {
    return this.conflicts;
  }
  /** The sequences that can follow the leader, in catalog order, with what each does. */
  getLeaderSequences(): Array<{ action: Action; combo: KeyCombo; description: string }> {
    const sequences: Array<{ action: Action; combo: KeyCombo; description: string }> = [];
    for (const action of this.actions()) {
      for (const combo of this.bindings[action]) {
        if (combo.leader && this.lookupMap.get(comboKey(combo)) === action) sequences.push({ action, combo, description: this.describe(action) });
      }
    }
    return sequences;
  }
  getComboLabel(action: string): string {
    const first = this.isAction(action) ? this.bindings[action][0] : this.contextBindings.get(action)?.[0];
    return first ? this.formatCombo(first) : '(unbound)';
  }
  /** Every key bound to an action (a table action or a place's context entry), as the table prints each; [] when unbound. */
  getComboLabels(action: string): readonly string[] {
    const combos = this.isAction(action) ? this.bindings[action] : this.contextBindings.get(action) ?? [];
    return combos.map((combo) => this.formatCombo(combo));
  }
  /** The key after the leader as a keycap shows it: `m`, `shift+y`, `up`. */
  formatFollowKey(combo: KeyCombo): string {
    return this.formatSingle({ ...combo, leader: false }).toLowerCase();
  }
  formatCombo(combo: KeyCombo): string {
    if (!combo.leader) return this.formatSingle(combo);
    const leader = this.isAction(LEADER_ACTION) ? this.bindings[LEADER_ACTION][0] : undefined;
    return `${leader ? this.formatSingle(leader) : 'the leader'} ${this.formatSingle({ ...combo, leader: false })}`;
  }
  private formatSingle(combo: KeyCombo): string {
    const parts: string[] = [];
    if (combo.ctrl) parts.push('Ctrl');
    if (combo.alt) parts.push('Alt');
    if (combo.shift) parts.push('Shift');
    const named: Readonly<Record<string, string>> = { pageup: 'PageUp', pagedown: 'PageDn' };
    const friendly = this.catalog.abbreviateNamedKeys && Object.hasOwn(named, combo.key) ? named[combo.key] : undefined;
    parts.push(combo.key.length === 1 || /^f\d{1,2}$/.test(combo.key) ? combo.key.toUpperCase()
      : friendly ?? combo.key);
    return parts.join('+');
  }
  getConfigPath(): string { return this.configPath; }
}
