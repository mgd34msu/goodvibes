/** Shared keybinding storage and matching; product action catalogs remain explicit. */
import { existsSync, readFileSync } from 'node:fs';
import { resolveSurfaceDirectory } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

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
  /** Reload from defaults; malformed overrides never become executable bindings. */
  loadFromDisk(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Keybindings must be an object.');
      this.bindings = this.cloneDefaults();
      for (const [rawAction, combo] of Object.entries(parsed)) {
        const aliases = this.catalog.aliases;
        const action = aliases && Object.hasOwn(aliases, rawAction) ? aliases[rawAction] : rawAction;
        if (action === undefined || !this.isAction(action)) {
          logger.debug('keybindings: unknown action, skipping', { action });
          continue;
        }
        const normalized: unknown[] = Array.isArray(combo) ? combo : [combo];
        if (!normalized.every(isKeyCombo)) {
          logger.debug('keybindings: invalid combo for action, skipping', { action });
          continue;
        }
        this.bindings[action] = normalized;
      }
      logger.debug('keybindings: loaded overrides from disk', { path: this.configPath });
    } catch (error) {
      logger.debug('keybindings: failed to load config file', { path: this.configPath, err: summarizeError(error) });
    }
    this.buildLookupMap();
  }
  private buildLookupMap(): void {
    this.lookupMap.clear();
    // Preserve catalog order and the existing last-writer rule for collisions.
    for (const action of this.actions()) {
      for (const combo of this.bindings[action]) this.lookupMap.set(tokenKey({ ...combo, logicalName: combo.key }), action);
    }
  }
  lookup(token: KeyToken): Action | null {
    return token.logicalName ? this.lookupMap.get(tokenKey(token)) ?? null : null;
  }
  matches(action: string, token: KeyToken): boolean {
    if (!this.isAction(action)) return false;
    return this.bindings[action].some(combo => combo.key === token.logicalName
      && !!combo.ctrl === !!token.ctrl && !!combo.shift === !!token.shift
      && !!combo.alt === !!(token.alt ?? token.meta));
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
