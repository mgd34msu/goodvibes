/**
 * Reading connector config without turning "not set up" into a crash.
 *
 * `ConfigManager.resolvePath()` THROWS `Invalid config path` for a path it
 * cannot walk. "No Google account is connected" is a normal, expected state
 * with a clear next step; an exception would turn it into a broken status
 * command, a broken capability probe, and a daemon route that answers 500
 * where it should answer "not configured". So every read in this module goes
 * through here, and an unreadable path reads as absent.
 *
 * This is a read guard only. Writes still surface their errors: failing to
 * STORE a credential must be loud, because the alternative is telling someone
 * their account is connected when nothing was saved.
 */

import type { GoogleConfigPort } from './types.js';

/**
 * Read one config value, treating an unreachable path as unset.
 *
 * Returns `undefined` both when the value is genuinely absent and when reading
 * it threw, the two are the same fact to every caller here, and neither is an
 * error worth propagating.
 */
export function safeConfigGet(config: Pick<GoogleConfigPort, 'get'>, key: string): unknown {
  try {
    return config.get(key);
  } catch {
    return undefined;
  }
}

/** A trimmed non-empty string from config, or null. Never throws. */
export function safeConfigString(config: Pick<GoogleConfigPort, 'get'>, key: string): string | null {
  const value = safeConfigGet(config, key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
