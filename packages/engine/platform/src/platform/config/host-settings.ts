import { CONFIG_SCHEMA, DEFAULT_CONFIG, type ConfigSetting, type GoodVibesConfig } from './schema.js';
import { configKeyScope } from './config-ownership.js';
import { ConfigError } from '../types/errors.js';
import { readDotPath } from './shared-config-tier.js';
import { deleteRawDotPath, writeRawDotPath } from './settings-io.js';
import type { ConfigSetOptions, ConfigUnsubscribe } from './manager.js';
import type { ManagedSettingLock } from '../runtime/settings/control-plane-store.js';

/**
 * A surface-owned scalar leaf, under an existing config category or under a
 * section of the surface's own (`statusline.command`). Registration is per
 * instance, never a change to the platform's shared schema/defaults. The host
 * owner chooses the default and must choose a restrictive fallback for a
 * policy-sensitive setting; the platform cannot determine what a value means.
 * Absent preferences, malformed stored values, and failed reloads resolve to it.
 *
 * set/setDynamic edit an existing explicit project leaf, otherwise the global
 * leaf. setProjectValue remains explicitly project-scoped. Bulk saves preserve
 * the destination's own host leaves rather than copying effective permissions
 * between tiers. Only a value of the declared type (and range) may be written.
 */
export interface HostBooleanSetting {
  readonly key: string;
  readonly type: 'boolean';
  readonly default: boolean;
  readonly description: string;
  /** True when a project settings file (repository content) may set it; otherwise only the owner's own file does. */
  readonly projectSettable?: boolean;
}

/** A surface-owned number leaf; `integer`, `min` and `max` bound what is accepted. */
export interface HostNumberSetting {
  readonly key: string;
  readonly type: 'number';
  readonly default: number;
  readonly description: string;
  /** True when a project settings file (repository content) may set it; otherwise only the owner's own file does. */
  readonly projectSettable?: boolean;
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
}

/** A surface-owned string leaf; any string is accepted, the empty string included. */
export interface HostStringSetting {
  readonly key: string;
  readonly type: 'string';
  readonly default: string;
  readonly description: string;
  /** True when a project settings file (repository content) may set it; otherwise only the owner's own file does. */
  readonly projectSettable?: boolean;
}

export type HostSetting = HostBooleanSetting | HostNumberSetting | HostStringSetting;
export type HostSettingValue = HostSetting['default'];

/** A validated boolean setting bound to the manager that registered its key. */
export interface HostBooleanSettingHandle {
  readonly key: string;
  readonly get: () => boolean;
  /** Current value and policy metadata; unreadable policy throws without changing it. */
  readonly getResolved: () => HostBooleanSettingResolved;
  /** Set the existing explicit project leaf, otherwise the global leaf. */
  readonly set: (value: boolean, options?: ConfigSetOptions) => void;
  /** Set the project leaf, falling back to the global leaf without a project. */
  readonly setProjectValue: (value: boolean, options?: ConfigSetOptions) => void;
  readonly subscribe: (callback: (next: boolean, previous: boolean) => void) => ConfigUnsubscribe;
  /** Reset both global and explicit project leaves to the registered default. */
  readonly reset: () => void;
}

/** Read-only host metadata; source describes the value, not a storage tier. */
export interface HostBooleanSettingResolved {
  readonly key: string;
  readonly value: boolean;
  readonly defaultValue: boolean;
  readonly source: 'default' | 'local';
  readonly managedLock: Readonly<Omit<ManagedSettingLock, 'key'>> | null;
}

export type HostSettingValues = Map<string, HostSettingValue>;

function acceptsValue(definition: HostSetting, value: unknown): boolean {
  switch (definition.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && (!definition.integer || Number.isInteger(value))
        && (definition.min === undefined || value >= definition.min)
        && (definition.max === undefined || value <= definition.max);
  }
}

function valueHint(definition: HostSetting): string {
  if (definition.type === 'boolean') return 'literal boolean';
  if (definition.type === 'string') return 'string';
  const kind = definition.integer ? 'integer' : 'finite number';
  if (definition.min !== undefined && definition.max !== undefined) return `${kind} in [${definition.min}, ${definition.max}]`;
  if (definition.min !== undefined) return `${kind} of at least ${definition.min}`;
  if (definition.max !== undefined) return `${kind} of at most ${definition.max}`;
  return kind;
}

function freezeDefinition(definition: HostSetting): Readonly<HostSetting> {
  const { key, description } = definition;
  if (typeof description !== 'string' || !description.trim()) {
    throw new ConfigError(`Host setting ${key} requires a description.`);
  }
  const project = definition.projectSettable === true ? { projectSettable: true } : {};
  switch (definition.type) {
    case 'boolean':
      if (typeof definition.default === 'boolean') return Object.freeze({ key, type: 'boolean' as const, default: definition.default, description, ...project });
      break;
    case 'string':
      if (typeof definition.default === 'string') return Object.freeze({ key, type: 'string' as const, default: definition.default, description, ...project });
      break;
    case 'number': {
      const { integer, min, max } = definition;
      const bounds = [min, max].every((bound) => bound === undefined || (typeof bound === 'number' && Number.isFinite(bound)))
        && (min === undefined || max === undefined || min <= max) && (integer === undefined || typeof integer === 'boolean');
      const frozen: HostNumberSetting = Object.freeze({
        key, type: 'number' as const, default: definition.default, description, ...project,
        ...(integer ? { integer } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
      });
      if (bounds && acceptsValue(frozen, definition.default)) return frozen;
      break;
    }
  }
  throw new ConfigError(`Host setting ${key} requires a boolean, number or string descriptor whose default is an accepted value.`);
}

export function isHostSettingsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Internal, immutable per-manager registration. Live values stay in config. */
export class HostSettings {
  readonly definitions: readonly Readonly<HostSetting>[];
  private readonly byKey: ReadonlyMap<string, Readonly<HostSetting>>;

  constructor(definitions: readonly HostSetting[] = []) {
    const keys = new Set<string>();
    this.definitions = Object.freeze(definitions.map((definition) => {
      const key = definition.key;
      const parts = typeof key === 'string' ? key.split('.') : [];
      const root = parts[0];
      const leaf = parts[1];
      const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
      // A root the platform does not define is the surface's own section; a
      // platform root must be an object category.
      if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(part) || unsafe.has(part))
        || !root || !leaf || (Object.hasOwn(DEFAULT_CONFIG, root)
        && !isHostSettingsObject((DEFAULT_CONFIG as unknown as Record<string, unknown>)[root]))) {
        throw new ConfigError('A host setting must be a new scalar leaf under a config object category or a section of its own.');
      }
      if (keys.has(key) || CONFIG_SCHEMA.some((entry) => entry.key === key)
        || readDotPath(DEFAULT_CONFIG, key).present || configKeyScope(key) !== 'client') {
        throw new ConfigError(`Host setting ${key} collides with a registered or non-client config path.`);
      }
      const frozen = freezeDefinition(definition);
      keys.add(key);
      return frozen;
    }));
    this.byKey = new Map(this.definitions.map((definition) => [definition.key, definition]));
  }

  get active(): boolean { return this.definitions.length > 0; }
  has(key: string): boolean { return this.byKey.has(key); }
  /** True when a project settings file may set this registered key. */
  projectSettable(key: string): boolean { return this.byKey.get(key)?.projectSettable === true; }
  keys(): IterableIterator<string> { return this.byKey.keys(); }

  /** True when `value` is of the registered key's type and within its range. */
  accepts(key: string, value: unknown): boolean {
    const definition = this.byKey.get(key);
    return definition !== undefined && acceptsValue(definition, value);
  }

  schema(key: string): Omit<ConfigSetting, 'key'> | undefined {
    const definition = this.byKey.get(key);
    return definition ? {
      type: definition.type, default: definition.default, description: definition.description,
      validate: (value: unknown) => acceptsValue(definition, value), validationHint: valueHint(definition),
    } : undefined;
  }

  defaults(): HostSettingValues {
    return new Map(this.definitions.map((definition) => [definition.key, definition.default]));
  }

  snapshot(config: GoodVibesConfig): HostSettingValues {
    return new Map(this.definitions.map((definition) => {
      const value = readDotPath(config, definition.key).value;
      return [definition.key, acceptsValue(definition, value) ? value as HostSettingValue : definition.default];
    }));
  }

  apply(config: GoodVibesConfig, values: HostSettingValues): void {
    for (const [key, value] of values) writeRawDotPath(config as unknown as Record<string, unknown>, key, value);
  }

  /**
   * Missing leaves inherit; present malformed leaves/sections override with default.
   * A project file (`layer: 'project'`) is repository content: only settings
   * declared `projectSettable` are read from it.
   */
  overlay(values: HostSettingValues, raw: unknown, layer: 'global' | 'project' = 'global'): string[] {
    if (!isHostSettingsObject(raw)) throw new ConfigError('Host settings could not be read from a JSON object.');
    const malformed: string[] = [];
    for (const definition of this.definitions) {
      if (layer === 'project' && definition.projectSettable !== true) continue;
      const [root, leaf] = definition.key.split('.') as [string, string];
      if (!Object.hasOwn(raw, root)) continue;
      const category = raw[root];
      if (!isHostSettingsObject(category)) {
        values.set(definition.key, definition.default);
        malformed.push(definition.key);
      } else if (Object.hasOwn(category, leaf)) {
        const value = category[leaf];
        const accepted = acceptsValue(definition, value);
        values.set(definition.key, accepted ? value as HostSettingValue : definition.default);
        if (!accepted) malformed.push(definition.key);
      }
    }
    return malformed;
  }

  /** Preserve only this destination's host leaves, never transplant effective values. */
  preserveDestination(snapshot: Record<string, unknown>, destination: Record<string, unknown>): void {
    for (const definition of this.definitions) {
      deleteRawDotPath(snapshot, definition.key);
      const [root, leaf] = definition.key.split('.') as [string, string];
      if (!Object.hasOwn(destination, root)) continue;
      const category = destination[root];
      if (!isHostSettingsObject(category)) {
        throw new ConfigError(`Cannot preserve host setting ${definition.key} from a malformed destination category.`);
      }
      if (Object.hasOwn(category, leaf)) writeRawDotPath(snapshot, definition.key, structuredClone(category[leaf]));
    }
  }
}
