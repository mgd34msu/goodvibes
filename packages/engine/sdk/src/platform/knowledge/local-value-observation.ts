import { types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';

export interface KnowledgeValueObservation {
  /** Detached comparison data, private to its owning operation. Not an ID,
   * persisted commitment, model projection or native publication authority. */
  readonly snapshot: unknown;
  matches(current: unknown): boolean;
}
/** One original capture, then descriptor-only comparisons of current data.
 * Keep key order and exact scalar values (including undefined and -0) without
 * cloning/stringifying/hashing the complete current value at every guard. */
export function observeKnowledgeValue(original: unknown): KnowledgeValueObservation {
  const snapshot = captureOwnedJson(original, nodeTypes.isProxy);
  const frames = new WeakMap<object, { readonly array: boolean; readonly keys: readonly string[]; readonly values: readonly unknown[] }>();
  const frame = (value: object) => {
    let known = frames.get(value);
    if (!known) {
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.getOwnPropertyNames(descriptors);
      known = Object.freeze({ array: Array.isArray(value), keys: Object.freeze(keys), values: Object.freeze(keys.map(key => descriptors[key]!.value as unknown)) });
      frames.set(value, known);
    }
    return known;
  };
  return Object.freeze({ snapshot, matches(current: unknown): boolean {
    const pending: Array<readonly [unknown, unknown]> = [[snapshot, current]];
    try {
      while (pending.length) {
        const [expected, value] = pending.pop()!;
        if (Object.is(expected, value)) continue;
        if (expected === null || value === null || typeof expected !== 'object' || typeof value !== 'object' || nodeTypes.isProxy(value)) return false;
        const retained = frame(expected), array = retained.array;
        if (array !== Array.isArray(value)) return false;
        const prototype: unknown = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
        const actual = Object.getOwnPropertyDescriptors(value);
        const actualKeys = Reflect.ownKeys(actual);
        if (actualKeys.some(key => typeof key !== 'string' || !('value' in actual[key]!) || typeof actual[key]!.value === 'function')) return false;
        // captureOwnedJson preserves the original enumerable JSON/data view;
        // hidden data is not silently promoted into a comparison payload.
        const keys = retained.keys, currentKeys = actualKeys.filter(key => array || actual[String(key)]?.enumerable);
        if (keys.length !== currentKeys.length || keys.some((key, index) => typeof key !== 'string' || key !== currentKeys[index])) return false;
        for (const [index, key] of keys.entries()) {
          const b = actual[key];
          if (!b || !('value' in b)) return false;
          pending.push([retained.values[index], b.value]);
        }
      }
      return true;
    } catch { return false; }
  } });
}
