/** Owned, nonpersistent inputs and the working persisted view of one manager. */
import { CONFIG_SCHEMA, type ConfigKey, type ConfigValue, type GoodVibesConfig } from './schema.js';
import { ConfigError } from '../types/errors.js';
import { DEFAULT_CONFIG_SNAPSHOT, coerceSchemaValue } from './manager-bootstrap.js';
import { readDotPath } from './shared-config-tier.js';
import { deleteRawDotPath, stripFrozenDefaults, writeRawDotPath } from './settings-io.js';
import type { ConfigKeyTier } from './manager-key-source.js';
import { nearestKnownSettingName } from './settings-unknown-forms.js';

/** Dot-segment ancestry, never an arbitrary string prefix. */
export function withinConfigPath(key: string, path: string): boolean {
  return key === path || key.startsWith(`${path}.`);
}

/** Capture only plain JSON-shaped values, without invoking getters or toJSON. */
function capture(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('unsupported configuration value');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('unsupported configuration object');
  }
  ancestors.add(value);
  try {
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('unsupported property');
      if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error('unsupported array property');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('unsupported property descriptor');
      (result as Record<string, unknown>)[key] = capture(descriptor.value, ancestors);
    }
    if (Array.isArray(value) && Object.keys(result).length !== value.length) throw new Error('sparse array');
    return result;
  } finally { ancestors.delete(value); }
}

function freezeCaptured(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeCaptured(nested);
    Object.freeze(value);
  }
  return value;
}

/** At most this many names of a section are listed for a key that is not a setting. */
const LISTED_SECTION_NAMES = 12;

/**
 * Why `key` is not a setting, with the nearest setting's name when one is
 * close, else the names its section has. Names only: never a value.
 */
function unknownSettingMessage(key: string): string {
  const nearest = nearestKnownSettingName(key, CONFIG_SCHEMA.map(setting => setting.key));
  if (nearest !== undefined) return `${key} is not a setting; did you mean ${nearest}?`;
  const cut = key.lastIndexOf('.');
  const section = cut < 0 ? '' : key.slice(0, cut);
  const names = section ? CONFIG_SCHEMA.filter(setting => setting.key.startsWith(`${section}.`)).map(setting => setting.key).sort() : [];
  if (names.length === 0) return `${key} is not a setting. Settings are named <section>.<name>, such as permissions.mode.`;
  const more = names.length > LISTED_SECTION_NAMES ? ` and ${names.length - LISTED_SECTION_NAMES} more` : '';
  return `${key} is not a setting; ${section} has ${names.slice(0, LISTED_SECTION_NAMES).join(', ')}${more}.`;
}

/** What a setting accepts, said without its current or offered value. */
function acceptedValues(schema: (typeof CONFIG_SCHEMA)[number]): string {
  if (schema.type === 'enum') return `one of ${(schema.enumValues ?? []).join(', ')}`;
  if (schema.type === 'boolean') return 'true or false';
  if (schema.type === 'number') return 'a number';
  if (schema.type === 'object') return 'a JSON object';
  return 'text';
}

/** One strict admission path for constructor aliases and frontend helpers. */
export function captureRuntimeValue<K extends ConfigKey>(key: K, value: unknown): ConfigValue<K> {
  const schema = CONFIG_SCHEMA.find(setting => setting.key === key);
  if (!schema) throw new ConfigError(unknownSettingMessage(key));
  // The current structured schema leaves are atomic. Do not silently introduce
  // overlapping runtime authority if the schema grows a descendant later.
  if (CONFIG_SCHEMA.some(setting => setting.key !== key &&
    (withinConfigPath(setting.key, key) || withinConfigPath(key, setting.key)))) {
    throw new ConfigError(`Runtime setting ${key} has overlapping schema paths.`);
  }
  try {
    const owned = freezeCaptured(capture(coerceSchemaValue(key, schema, capture(value))));
    const validType = schema.type === 'enum'
      ? typeof owned === 'string' && schema.enumValues?.includes(owned)
      : schema.type === 'object'
        ? owned !== null && typeof owned === 'object'
        : typeof owned === schema.type;
    if (!validType || (schema.validate && !schema.validate(owned))) throw new Error('invalid');
    return capture(owned) as ConfigValue<K>;
  } catch {
    // The key and what it accepts; no raw values, borrowed validator errors or URLs in diagnostics.
    throw new ConfigError(`${key} does not accept that value; it takes ${schema.validationHint ?? acceptedValues(schema)}.`);
  }
}

export class ConfigRuntimeState {
  readonly defaults = new Map<ConfigKey, unknown>();
  readonly overrides = new Map<ConfigKey, unknown>();
  /** Origin of the accepted/post-write non-runtime working value. */
  readonly sources = new Map<string, ConfigKeyTier>();

  /** Accepted global values retained beneath project overrides; never reread during save. */
  globalLayer: Record<string, unknown> = {};

  constructor(public nonRuntime: GoodVibesConfig) {}

  fork(): ConfigRuntimeState {
    const result = new ConfigRuntimeState(structuredClone(this.nonRuntime));
    result.globalLayer = structuredClone(this.globalLayer);
    for (const [key, value] of this.defaults) result.defaults.set(key, structuredClone(value));
    for (const [key, value] of this.overrides) result.overrides.set(key, structuredClone(value));
    for (const [key, tier] of this.sources) result.sources.set(key, tier);
    return result;
  }

  recordLayer(raw: Record<string, unknown>, tier: ConfigKeyTier, prefix = ''): void {
    if (tier === 'global' && !prefix) this.globalLayer = structuredClone(raw);
    for (const [field, value] of Object.entries(raw)) {
      const path = prefix ? `${prefix}.${field}` : field;
      this.sources.set(path, tier);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        this.recordLayer(value as Record<string, unknown>, tier, path);
      }
    }
  }

  compose(): GoodVibesConfig {
    const effective = structuredClone(this.nonRuntime) as unknown as Record<string, unknown>;
    for (const [key, value] of this.defaults) {
      if (!this.sources.has(key)) writeRawDotPath(effective, key, structuredClone(value));
    }
    for (const [key, value] of this.overrides) writeRawDotPath(effective, key, structuredClone(value));
    return effective as unknown as GoodVibesConfig;
  }

  retire(path?: string): void {
    for (const key of this.overrides.keys()) if (path === undefined || withinConfigPath(key, path)) this.overrides.delete(key);
  }

  mark(path: string, tier?: ConfigKeyTier): void {
    if (!tier) deleteRawDotPath(this.globalLayer, path);
    if (tier === 'global') {
      const found = readDotPath(this.nonRuntime, path);
      if (found.present) writeRawDotPath(this.globalLayer, path, structuredClone(found.value));
    }
    for (const key of this.sources.keys()) if (withinConfigPath(key, path)) this.sources.delete(key);
    if (tier) {
      const found = readDotPath(this.nonRuntime, path);
      if (!found.present) return;
      this.sources.set(path, tier);
      if (found.value !== null && typeof found.value === 'object' && !Array.isArray(found.value)) {
        this.recordLayer(found.value as Record<string, unknown>, tier, path);
      }
    }
  }

  /** Reconcile only the accepted destination; runtime inputs and higher tiers survive. */
  acceptBulkSnapshot(raw: Record<string, unknown>, tier: 'global' | 'project', hostKeyNames: Iterable<string>): void {
    const hostKeys = new Set(hostKeyNames);
    const written = new ConfigRuntimeState(this.nonRuntime);
    written.recordLayer(raw, tier);
    const previous = new Map(this.sources);
    const higher = (source: ConfigKeyTier | undefined) => source === 'daemon' || source === 'shared'
      || (tier === 'global' && source === 'project');
    if (tier === 'global') this.globalLayer = structuredClone(raw);
    for (const [key, source] of previous) {
      if (source !== tier || written.sources.has(key) || hostKeys.has(key)) continue;
      const fallback = tier === 'project' ? readDotPath(this.globalLayer, key) : { present: false, value: undefined };
      if (fallback.present) this.sources.set(key, 'global'); else this.sources.delete(key);
      // Parents describe provenance too, but replacing one wholesale would
      // clobber accepted higher-tier descendants. Restore the leaves instead.
      if ([...previous.keys()].some(child => child.startsWith(`${key}.`))) continue;
      const value = fallback.present ? fallback : readDotPath(DEFAULT_CONFIG_SNAPSHOT, key);
      if (value.present) writeRawDotPath(this.nonRuntime as unknown as Record<string, unknown>, key, structuredClone(value.value));
      else deleteRawDotPath(this.nonRuntime as unknown as Record<string, unknown>, key);
    }
    for (const key of written.sources.keys()) {
      if (!hostKeys.has(key) && !higher(previous.get(key))) this.sources.set(key, tier);
    }
  }

  bulkSnapshot(): Record<string, unknown> {
    const { config } = stripFrozenDefaults(structuredClone(this.nonRuntime) as unknown as Record<string, unknown>);
    // An explicit shipped-default value may suppress a different frontend
    // default. Preserve that accepted choice without persisting either map.
    for (const key of this.defaults.keys()) {
      if (this.sources.has(key)) {
        const found = readDotPath(this.nonRuntime, key);
        if (found.present) writeRawDotPath(config, key, structuredClone(found.value));
      }
    }
    return config;
  }
}
