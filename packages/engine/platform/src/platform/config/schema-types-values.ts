/**
 * schema-types-values.ts, the value type of a ConfigKey.
 *
 * Read off GoodVibesConfig at the key's path, so the interfaces are the one
 * declaration of what each setting holds: a lookup per path segment instead of
 * a clause per key. An optional field's value is its type without `undefined`
 * (the manager fills every key from its default).
 *
 * The import below is type-only in both directions (schema-types.ts re-exports
 * this module, this module imports types from it), so the cycle is erased at
 * compile time and no runtime edge exists.
 */
import type { ConfigKey, GoodVibesConfig } from './schema-types.js';

/** The type at a dot path of `T`. */
type ConfigPathValue<T, Path extends string> =
  Path extends `${infer Head}.${infer Rest}`
    ? Head extends keyof T ? ConfigPathValue<Exclude<T[Head], undefined>, Rest> : never
    : Path extends keyof T ? Exclude<T[Path], undefined> : never;

/** Maps a ConfigKey to its value type. */
export type ConfigValue<K extends ConfigKey> = ConfigPathValue<GoodVibesConfig, K>;
