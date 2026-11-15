/** Shape checks the judgment readers apply to their inputs before any request is built. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== 'string') return false;
  return true;
}

export function isOptionalText(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * The privacy guard has already rejected accessors, cycles and exotic
 * prototypes; this also refuses hidden or lossy JSON data. `malformed` builds
 * the reader's own hold. `optional` accepts `undefined` at any depth.
 */
export function assertJsonTree(value: unknown, malformed: () => Error, optional = false): void {
  if (value === undefined && optional) return;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) throw malformed();
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw malformed();
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key !== 'length' && (!descriptor.enumerable || descriptor.get || descriptor.set)) throw malformed();
    }
    for (const child of value) assertJsonTree(child, malformed, optional);
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || descriptor.get || descriptor.set) throw malformed();
      assertJsonTree(descriptor.value, malformed, optional);
    }
  }
}
