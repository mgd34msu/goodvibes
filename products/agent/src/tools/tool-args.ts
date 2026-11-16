/**
 * Readers for model-supplied tool arguments, with one rule each, so a value
 * means the same thing in every Agent tool.
 */

/** Text, trimmed; anything that is not a string reads as empty. */
export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A boolean parameter: a JSON boolean, or the exact text `true` / `false` (the
 * engine's schema repair turns most other spellings into one of those before a
 * tool sees them). Absent (undefined, null or blank text) is `fallback`.
 * Anything else is refused with the parameter's name, never guessed at:
 * `"yes"` or `"apply"` is not quietly read as true in one tool and false in another.
 */
export function readFlag(value: unknown, name: string): boolean | undefined;
export function readFlag(value: unknown, name: string, fallback: boolean): boolean;
export function readFlag(value: unknown, name: string, fallback?: boolean): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return fallback;
  throw new Error(`${name} must be true or false${fallback === undefined ? '; omit it to leave it unset' : `; omit it for the default (${fallback})`}.`);
}
