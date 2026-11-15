/**
 * Reads a boolean switch from an environment value.
 * `1` and `true` (any case) are on; `0`, `false`, empty and unset are off.
 * Any other text is off too, so a typo never turns a switch on.
 */
export function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}
