/**
 * profile-fallback.ts, the port `ConfigManager.resolveForConsumer()` reads an
 * unset key through.
 *
 * This file exists so `platform/config` gains NO import of
 * `platform/owner-profile`. The profile module opens files, watches a directory
 * and pulls in `node:fs`; the config schema and manager are reached from
 * runtime-neutral bundles and from surfaces that have no daemon at all. A port
 * declared here and an implementation injected at the composition root keeps
 * both true, exactly as `attachHookDispatcher` already does for hooks.
 *
 * ## Where the fallback applies, and where it must not
 *
 * `ConfigManager.resolveForConsumer()` ONLY. Never `get()`, `getAll()`, a
 * category read, a settings dump, snapshot, export or settings row: those carry
 * the stored setting, so a restore or import never pins a profile value as an
 * explicit setting. `resolveForConsumer()` is one keyed read by a consumer that
 * needs that value to do its job. A dump is a different act: it hands the whole
 * settings surface to a caller, and a fallback applied there would put
 * `commerce.shippingAddress` in front of something that never asked for it and
 * never triggered the closed-tier disclosure rule. A bulk read therefore sees
 * the raw stored value, unset, and the profile value reaches only the one
 * consumer that asked for that one key.
 *
 * ## Direction
 *
 * An explicitly configured value always wins. The profile fills a gap; it never
 * overrides a decision the operator made. The reverse direction would be the
 * drift class this whole design exists to remove, running backwards.
 */

/**
 * Reads the profile value for one config key, or `undefined` when there is
 * nothing to fill the gap with.
 *
 * Keyed by the CONFIG path (`checkin.quietHours`), not by the profile field id,
 * so the map that connects the two lives entirely in the owner-profile module
 * and the manager stays ignorant of both.
 */
export type ConfigProfileFallbackReader = (key: string) => unknown;

/**
 * Whether a resolved config value is a gap the profile may fill.
 *
 * Deliberately narrow: `undefined`, `null`, and a string that is empty or all
 * whitespace. A `false` boolean and a `0` number are real configured values and
 * are never treated as unset, the keys this serves are all strings whose
 * schema default is `''`, and widening the predicate to "falsy" would make the
 * profile silently override a boolean an operator turned off.
 *
 * A string an operator explicitly set to empty is indistinguishable from unset,
 * and that is the right answer: clearing a setting is how you say "I have no
 * opinion here", which is exactly when the profile should speak.
 */
export function isUnsetConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim().length === 0;
}

/**
 * The whole policy, in one place: what `ConfigManager.get()` answers for one
 * key once the stored value has been resolved.
 *
 * `stored` wins whenever it is set. With no reader installed, or with a reader
 * that has nothing for this key, `stored` is returned unchanged, so a build
 * that never installs a profile behaves byte-for-byte as it did before this
 * existed.
 *
 * Called from `ConfigManager.resolveForConsumer()` and from nowhere else; every
 * other read of the manager returns the stored value by construction.
 */
export function resolveWithProfileFallback(
  key: string,
  stored: unknown,
  reader: ConfigProfileFallbackReader | null,
): unknown {
  if (reader === null || !isUnsetConfigValue(stored)) return stored;
  let fromProfile: unknown;
  // A keyed read never throws: a profile value that needs an asynchronous,
  // verified reading (a postal address part) is not a synchronous answer, so
  // the stored value stands and the address is read through
  // `ConfigManager.preparePostalAddress`.
  try { fromProfile = reader(key); } catch { return stored; }
  return fromProfile === undefined ? stored : fromProfile;
}

/** A config slice whose owner may also answer the profile-filled value of one key. */
export interface ConsumerConfigReader {
  get(key: string): unknown;
  resolveForConsumer?(key: string): unknown;
}

/**
 * The value a feature acts on: the profile-filled value where the reader
 * offers one (a `ConfigManager`), the stored setting otherwise.
 */
export function readConsumerSetting(config: ConsumerConfigReader, key: string): unknown {
  return config.resolveForConsumer ? config.resolveForConsumer(key) : config.get(key);
}
