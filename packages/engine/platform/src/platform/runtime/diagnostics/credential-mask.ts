/**
 * Credential masking for diagnostic captures.
 *
 * Diagnostic panels keep and show tool arguments and domain state, and both
 * can carry tokens. Masking runs on the serialized JSON, so keys and shape
 * survive and only credential-shaped spans are replaced, the same masking the
 * at-rest logs use.
 */
import { redactAtRestLine } from '../at-rest-persistence.js';

/** Largest serialized argument payload a panel keeps; bigger ones are not retained. */
export const MAX_CAPTURED_ARGS_CHARS = 16_000;

/**
 * Return a copy of a JSON-safe value with credential-shaped spans masked.
 * Throws when masking is unavailable, so a caller leaves the value out instead
 * of showing it unmasked.
 */
export function maskCredentials<T>(value: T): T {
  return JSON.parse(redactAtRestLine(JSON.stringify(value))) as T;
}

/**
 * Mask tool arguments for retention in a diagnostics buffer. Arguments that are
 * too large to keep, or that cannot be masked or serialized, are replaced by a
 * placeholder that says so; the raw value is never retained.
 */
export function maskCapturedArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(args);
    if (serialized === undefined || serialized.length > MAX_CAPTURED_ARGS_CHARS) {
      return { omitted: `arguments not retained: larger than ${MAX_CAPTURED_ARGS_CHARS} characters` };
    }
    return JSON.parse(redactAtRestLine(serialized)) as Record<string, unknown>;
  } catch {
    return { omitted: 'arguments not retained: they could not be masked' };
  }
}
