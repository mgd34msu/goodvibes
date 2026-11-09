/** Preserve a proven internal presence invariant when a runtime index cannot encode it in its type. */
export function requireDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new RangeError('Required internal value is missing');
  return value;
}
