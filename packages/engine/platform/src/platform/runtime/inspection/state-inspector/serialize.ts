/**
 * Shared serialization utility for the state inspector.
 *
 * Turns any state value into something `JSON.stringify` accepts and a person
 * can read: Maps become plain objects, Sets arrays, a Date its ISO text, an
 * Error `{ name, message }`, a bigint its decimal text, binary data
 * `"<N bytes>"`, a function `"[Function]"`, and a cycle `"[Circular]"`. Depth
 * and the number of values rendered are bounded, so a large or widely shared
 * object (a conversation array referenced from many places) cannot make one
 * snapshot unbounded; what is cut off reads `"[Truncated]"`.
 */

/** Deepest nesting rendered; deeper values read "[Truncated]". */
export const SERIALIZE_MAX_DEPTH = 12;
/** Most values rendered in one call; later ones read "[Truncated]". */
export const SERIALIZE_MAX_NODES = 20_000;

const TRUNCATED = '[Truncated]';

interface SerializeBudget { nodes: number }

/**
 * Serialize a value to a JSON-safe representation.
 *
 * @param value - Value to serialize.
 * @param seen - Objects on the path being serialized, to detect cycles.
 * @returns A JSON-safe representation.
 */
export function serializeSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  return serializeValue(value, seen, 0, { nodes: 0 });
}

function serializeValue(value: unknown, seen: WeakSet<object>, depth: number, budget: SerializeBudget): unknown {
  if (++budget.nodes > SERIALIZE_MAX_NODES) return TRUNCATED;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (ArrayBuffer.isView(value)) return `<${value.byteLength} bytes>`;
  if (value instanceof ArrayBuffer) return `<${value.byteLength} bytes>`;
  if (depth >= SERIALIZE_MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  // `seen` holds the objects on the path being serialized, so an object shared
  // by two siblings is rendered both times and only a true cycle is marked;
  // the node budget bounds what sharing can cost.
  try {
    if (value instanceof Map) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        result[String(k)] = serializeValue(v, seen, depth + 1, budget);
      }
      return result;
    }

    if (value instanceof Set) {
      return [...value].map((v) => serializeValue(v, seen, depth + 1, budget));
    }

    if (Array.isArray(value)) {
      return value.map((v) => serializeValue(v, seen, depth + 1, budget));
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = serializeValue(v, seen, depth + 1, budget);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
