/**
 * Shared serialization utility for the state inspector.
 *
 * Converts Maps → plain objects, Sets → arrays, and replaces circular
 * references with a sentinel string so any state snapshot is JSON-safe.
 */

/**
 * Serialize a value to a JSON-safe representation.
 * Maps → plain objects, Sets → arrays, circular refs → '[Circular]'.
 *
 * @param value - Value to serialize.
 * @param seen - WeakSet tracking seen objects to detect cycles.
 * @returns A JSON-safe representation.
 */
export function serializeSafe(value: unknown, seen = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  // `seen` holds the objects on the path being serialized, so an object shared
  // by two siblings is rendered both times and only a true cycle is marked.
  try {
    if (value instanceof Map) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        result[String(k)] = serializeSafe(v, seen);
      }
      return result;
    }

    if (value instanceof Set) {
      return [...value].map((v) => serializeSafe(v, seen));
    }

    if (Array.isArray(value)) {
      return value.map((v) => serializeSafe(v, seen));
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = serializeSafe(v, seen);
    }
    return result;
  } finally {
    seen.delete(value as object);
  }
}
