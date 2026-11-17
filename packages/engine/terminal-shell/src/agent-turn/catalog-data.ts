/**
 * catalog-data.ts, the plain-data capture an Agent tool takes of what it reads
 * or is handed before it acts on it: a frozen copy within fixed budgets, and a
 * guard that the source still matches it. Shared by the Agent's catalogs and
 * its profile and occasions tools, in the Agent process and in a turn the
 * daemon hosts for the Agent.
 */
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';

/** Capture private DTO metadata without interpreting fields that will never be sent. */
export function captureCatalogData<T>(value: T, budget = { nodes: 0, characters: 0, slots: 0 }): T {
  return visitCatalogData(value, budget, true);
}

/**
 * Validate the same complete DTO grammar without allocating another frozen
 * graph. Answers each object's own property names (hidden ones included).
 */
export function inspectCatalogData(value: unknown): WeakMap<object, readonly string[]> {
  const names = new WeakMap<object, readonly string[]>();
  visitCatalogData(value, { nodes: 0, characters: 0, slots: 0 }, false, names);
  return names;
}

const isEnumerable = (entry: object, key: string): boolean => Object.prototype.propertyIsEnumerable.call(entry, key);

/**
 * The plain-data grammar: plain objects and arrays, finite numbers, strings,
 * booleans, null and undefined, no functions, symbols or `toJSON`, within the
 * budgets. Hidden (non-enumerable) fields are data too and keep their
 * enumerability in the copy. Values are read directly: the data is the
 * program's own or arguments the registry already validated and froze.
 */
function visitCatalogData<T>(value: T, budget: { nodes: number; characters: number; slots: number }, copy: boolean,
  observations?: WeakMap<object, readonly string[]>): T {
  const ancestors = new Set<object>();
  const copies = new WeakMap<object, object>();
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++budget.nodes > 100_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { budget.characters += entry.length; if (budget.characters > 1_000_000) return invalid(); return entry; }
    if (entry === null || entry === undefined || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || ancestors.has(entry)) return invalid();
    const existing = copies.get(entry); if (existing) return existing;
    const array = Array.isArray(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const names = Object.getOwnPropertyNames(entry);
    observations?.set(entry, names);
    if (Object.getOwnPropertySymbols(entry).length > 0 || Object.hasOwn(entry, 'toJSON')
      || (array && Object.hasOwn(entry, 'constructor'))) return invalid();
    const length = array ? (entry as unknown[]).length : 0;
    if (length > 20_000) return invalid();
    if (array && (budget.slots += length) > 100_000) return invalid();
    const record = entry as Record<string, unknown>;
    const result: object = copy ? (array ? new Array(length) : Object.create(null) as object) : entry;
    ancestors.add(entry);
    try {
      for (const key of names) {
        if (array && key === 'length') continue;
        const field = record[key];
        if (typeof field === 'function') return invalid();
        budget.characters += key.length;
        if (budget.characters > 1_000_000) return invalid();
        const child = capture(field, depth + 1);
        if (copy) Object.defineProperty(result, key, { value: child, enumerable: isEnumerable(entry, key) });
      }
      if (copy) Object.freeze(result);
      copies.set(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  return capture(value, 0) as T;
}

/** Retain the existing complete frozen copy alongside its fresh-data guard. */
export function captureCatalogSnapshot<T>(source: T): {
  readonly captured: T;
  readonly assertCurrent: (current: unknown) => void;
} {
  const captured = captureCatalogData(source);
  return { captured, assertCurrent: compileCatalogSnapshotGuard(captured) };
}

/** Compare fresh complete DTOs without copying them. Every call keeps the
 * original capture grammar and budgets, including alias and hidden-slot rules. */
export function captureCatalogSnapshotGuard(source: unknown): (current: unknown) => void {
  return compileCatalogSnapshotGuard(captureCatalogData(source));
}

/**
 * Compare fresh plain data with a captured copy: the same keys in the same
 * order and equal values, as JSON-shaped data. A frozen graph that matched
 * once cannot change, so it is not compared again. The data is the program's
 * own (catalog rows, store records, captured arguments); nothing here guards
 * against code in this process replacing built-ins or properties.
 */
function compileCatalogSnapshotGuard(captured: unknown): (current: unknown) => void {
  const matchedFrozen = new WeakSet<object>();
  return current => {
    if (current !== null && typeof current === 'object' && matchedFrozen.has(current)) return;
    if (!sameCatalogData(captured, current, 0)) throw new ToolInputProjectionError('held');
    if (current !== null && typeof current === 'object' && Object.isFrozen(current)) matchedFrozen.add(current);
  };
}

function sameCatalogData(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || depth > 64) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index]!;
    if (key !== rightKeys[index]) return false;
    if (!sameCatalogData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}
