/** Shared keybinding storage and matching; product action catalogs remain explicit. */
import { existsSync, readFileSync } from 'node:fs';
import { resolveSurfaceDirectory } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { logger, summarizeError, writeDocument } from '@goodvibes-jev/engine/platform/platform/utils';

export interface KeyCombo {
  key: string;
  ctrl?: boolean | undefined;
  shift?: boolean | undefined;
  alt?: boolean | undefined;
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
function isKeyCombo(value: unknown): value is KeyCombo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('key' in value) || typeof value.key !== 'string' || value.key.length === 0) return false;
  for (const modifier of ['ctrl', 'shift', 'alt'] as const) {
    const flag: unknown = Reflect.get(value, modifier);
    if (flag !== undefined && typeof flag !== 'boolean') return false;
  }
  return true;
}
function tokenKey(token: KeyToken): string {
  // The tokenizer reports Alt as meta; explicit alt takes precedence.
  return `${token.logicalName}:${token.ctrl ? 1 : 0}:${token.shift ? 1 : 0}:${(token.alt ?? token.meta) ? 1 : 0}`;
}
export class KeybindingsManager<Action extends string> {
  private bindings: Record<Action, KeyCombo[]>;
  private readonly configPath: string;
  private readonly lookupMap = new Map<string, Action>();

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
      this.buildLookupMap();
      return notices;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Keybindings must be an object.');
      this.bindings = this.cloneDefaults();
      for (const [rawAction, combo] of Object.entries(parsed)) {
        const aliases = this.catalog.aliases;
        const action = aliases && Object.hasOwn(aliases, rawAction) ? aliases[rawAction] : rawAction;
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
      notices.push(`keybindings: ${this.configPath} could not be read (${summarizeError(error)}); defaults are in use`);
    }
    notices.push(...this.buildLookupMap());
    if (notices.length > 0) logger.warn('keybindings: some overrides were not applied', { path: this.configPath, notices });
    return notices;
  }
  /**
   * Bind `action` to `combos` in the user's file and reload. Entries for the
   * same action under a legacy name are dropped, so the one written is the one
   * that applies. Returns the reload's notices.
   */
  setOverride(action: Action, combos: readonly KeyCombo[]): readonly string[] {
    if (combos.length === 0 || !combos.every(isKeyCombo)) throw new Error(`keybindings: a binding for "${action}" needs at least one key combination with a key name.`);
    return this.writeOverride(action, combos.map(combo => ({ ...combo })));
  }
  /** Remove every entry for `action` (canonical or legacy name) from the user's file and reload, so the default applies. */
  clearOverride(action: Action): readonly string[] {
    return this.writeOverride(action, undefined);
  }
  /**
   * The one writer of the file, reading it with the same rules as
   * loadFromDisk(). A file that cannot be read or parsed is left exactly as it
   * is and nothing is written: it may be a hand edit the user is in the middle of.
   */
  private writeOverride(action: Action, combos: KeyCombo[] | undefined): readonly string[] {
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
  /** Rebuild the single chord table that both lookup() and matches() read, and describe every chord two actions share. */
  private buildLookupMap(): string[] {
    this.lookupMap.clear();
    const owners = new Map<string, { combo: KeyCombo; actions: Action[] }>();
    // Preserve catalog order and the last-writer rule for collisions.
    for (const action of this.actions()) {
      for (const combo of this.bindings[action]) {
        const key = tokenKey({ ...combo, logicalName: combo.key });
        this.lookupMap.set(key, action);
        const entry = owners.get(key) ?? { combo, actions: [] };
        if (!entry.actions.includes(action)) entry.actions.push(action);
        owners.set(key, entry);
      }
    }
    const conflicts: string[] = [];
    for (const [key, { combo, actions }] of owners) {
      if (actions.length < 2) continue;
      conflicts.push(`keybindings: ${this.formatCombo(combo)} is bound to ${actions.join(' and ')}; only ${this.lookupMap.get(key)} responds to it`);
    }
    return conflicts;
  }
  lookup(token: KeyToken): Action | null {
    return token.logicalName ? this.lookupMap.get(tokenKey(token)) ?? null : null;
  }
  /** Reads the same table as lookup(), so a chord shared by two actions reaches only the one lookup() names. */
  matches(action: string, token: KeyToken): boolean {
    return this.isAction(action) && this.lookup(token) === action;
  }
  getAll(): Array<{ action: Action; combos: KeyCombo[]; description: string }> {
    return this.actions().map(action => ({ action, combos: this.bindings[action], description: this.catalog.descriptions[action] }));
  }
  getComboLabel(action: string): string {
    if (!this.isAction(action)) return '(unbound)';
    const first = this.bindings[action][0];
    return first ? this.formatCombo(first) : '(unbound)';
  }
  formatCombo(combo: KeyCombo): string {
    const parts: string[] = [];
    if (combo.ctrl) parts.push('Ctrl');
    if (combo.alt) parts.push('Alt');
    if (combo.shift) parts.push('Shift');
    const named: Readonly<Record<string, string>> = { pageup: 'PageUp', pagedown: 'PageDn' };
    const friendly = this.catalog.abbreviateNamedKeys && Object.hasOwn(named, combo.key) ? named[combo.key] : undefined;
    parts.push(combo.key.length === 1 ? combo.key.toUpperCase()
      : friendly ?? combo.key);
    return parts.join('+');
  }
  getConfigPath(): string { return this.configPath; }
}
