import { isDeepStrictEqual } from 'node:util';
import { redactStructuredDataAsync } from '@goodvibes-jev/engine/platform/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureOwnedJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { inspectCatalogData, captureCatalogData, captureCatalogSnapshotGuard, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingSnapshotGuard } from './agent-harness-model-reading-source.ts';
import type { EntryType, JsonValue } from '@goodvibes-jev/judgment/decisions';
import { personalOpsNativeFields, personalOpsResultFields, type PersonalOpsNativeSchema } from './agent-personal-ops-native-fields.ts';

/** Hidden producer data is still semantic source; serialization cannot omit it. */
export function capturePersonalOpsData(value: unknown): unknown {
  const captured = captureCatalogData(value);
  let nodes = 0, characters = 0;
  const visit = (entry: unknown): unknown => {
    if (++nodes > 20_000) throw new ToolInputProjectionError('invalid');
    if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid'); }
    if (!entry || typeof entry !== 'object') return entry;
    const names = Object.getOwnPropertyNames(entry);
    if (Array.isArray(entry)) {
      // A captured array carries its indices and `length`, nothing else.
      if (names.length !== entry.length + 1) throw new ToolInputProjectionError('invalid');
      return entry.map(visit);
    }
    const record = entry as Record<string, unknown>;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of names) {
      characters += key.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid');
      Object.defineProperty(result, key, { value: visit(record[key]), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

export function assertPersonalOpsDataCurrent(value: unknown, captured: unknown): void {
  if (!isDeepStrictEqual(capturePersonalOpsData(value), captured)) throw new ToolInputProjectionError('held');
}

type PersonalOpsComparison = { readonly kind: 'value'; readonly value: unknown } | {
  readonly kind: 'object'; readonly array: boolean; readonly length: number;
  readonly slots: ReadonlyMap<string, PersonalOpsComparison>;
};

/** Own a normalized baseline while keeping every fresh raw observation. The
 * public arbitrary-baseline assertion above deliberately keeps its old path. */
export function capturePersonalOpsSnapshot(value: unknown): {
  readonly captured: unknown;
  readonly assertCurrent: (current: unknown) => void;
} {
  if (value === null || typeof value !== 'object') {
    const captured = capturePersonalOpsData(value);
    return Object.freeze({ captured, assertCurrent(current: unknown) { assertPersonalOpsDataCurrent(current, captured); } });
  }
  const captured = capturePersonalOpsData(value);
  // Either the platform's own capture or a completely frozen, already admitted DTO
  // can prove stable data identity. A frozen parent with mutable descendants
  // still requires a complete comparison at every boundary.
  let immutable = false;
  try { immutable = captureOwnedJson(value) === value; } catch { /* The personal-ops grammar remains authoritative. */ }
  if (!immutable) {
    const seen = new Set<object>();
    const deeplyFrozen = (entry: unknown): boolean => {
      if (entry === null || typeof entry !== 'object') return true;
      if (seen.has(entry)) return true;
      if (!Object.isFrozen(entry)) return false;
      seen.add(entry);
      const record = entry as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(entry)) if (!deeplyFrozen(record[key])) return false;
      return true;
    };
    immutable = deeplyFrozen(value);
  }
  let expandedCatalogCharacters = 0;
  const compile = (entry: unknown): PersonalOpsComparison => {
    if (typeof entry === 'string') expandedCatalogCharacters += entry.length;
    if (entry === null || typeof entry !== 'object') return Object.freeze({ kind: 'value', value: entry });
    const array = Array.isArray(entry), record = entry as Record<string, unknown>;
    const slots = new Map<string, PersonalOpsComparison>();
    for (const key of Object.keys(entry)) {
      expandedCatalogCharacters += key.length;
      slots.set(key, compile(record[key]));
    }
    // Only the newly constructed normalization tree is frozen. Borrowed input
    // and public protection results retain their original mutability.
    Object.freeze(entry);
    return Object.freeze({ kind: 'object', array, length: array ? (entry as unknown[]).length : 0, slots });
  };
  const original = compile(captured);
  // A complete immutable descendant can also be reused at its exact captured
  // position. Only enable this proof when the fully expanded key/text cost is
  // within the catalog budget, so changing aliases cannot evade that budget.
  let assertNative: ((current: unknown) => void) | undefined;
  if (expandedCatalogCharacters <= 1_000_000) {
    try { assertNative = captureModelReadingSnapshotGuard(value, true); } catch { /* Keep the complete original grammar. */ }
  }
  // Exact catalog equality proves the same fully expanded normalized value,
  // whose stricter Personal Ops budgets were admitted above. This complete
  // single-pass guard avoids normalizing unchanged observations twice. Its
  // stricter order comparison may refuse equivalent values; those still take
  // the original normalization path, including invalid-tail checks.
  const assertExact = captureCatalogSnapshotGuard(value);
  const assertCurrent = (current: unknown): void => {
    if (immutable && current === value) return;
    if (assertNative) {
      try { assertNative(current); return; } catch { /* Key order may differ and still normalize equally. */ }
    }
    try { assertExact(current); return; } catch { /* Preserve normalized equality and complete invalid precedence below. */ }
    // Keep the complete first pass and its invalid precedence, alias grammar,
    // depth, node, character and array-slot limits exactly as before.
    const observation = inspectCatalogData(current);
    let nodes = 0, characters = 0, equal = true;
    const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
    const compare = (entry: unknown, expected: PersonalOpsComparison | undefined): void => {
      if (++nodes > 20_000) return invalid();
      if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) return invalid(); }
      if (entry === null || typeof entry !== 'object') {
        if (!expected || expected.kind !== 'value' || !Object.is(entry, expected.value)) equal = false;
        return;
      }
      const names = observation.get(entry);
      if (!names) return invalid();
      const array = Array.isArray(entry), record = entry as Record<string, unknown>;
      const expectedObject = expected?.kind === 'object' ? expected : undefined;
      if (!expectedObject || expectedObject.array !== array) equal = false;
      if (array) {
        const length = (entry as unknown[]).length;
        if (names.length !== length + 1) return invalid();
        for (const key of names) {
          if (key !== 'length' && (!Number.isSafeInteger(Number(key))
            || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length)) return invalid();
        }
        if (expectedObject?.length !== length) equal = false;
        for (let index = 0; index < length; index++) {
          const key = String(index);
          // Array indices carry no extra phase-two key-text charge.
          compare(record[key], expectedObject?.array ? expectedObject.slots.get(key) : undefined);
        }
        return;
      }
      if (!expectedObject || expectedObject.slots.size !== names.length) equal = false;
      for (const key of names) {
        characters += key.length; if (characters > 1_000_000) return invalid();
        // Every hidden field becomes normalized enumerable meaning. Object
        // insertion order and enumerability do not decide equality.
        compare(record[key], expectedObject && !expectedObject.array ? expectedObject.slots.get(key) : undefined);
      }
    };
    // Never stop on an unequal early field: all expanded aliases and malformed
    // tails must finish admission before a mismatch can become held.
    compare(current, original);
    if (!equal) throw new ToolInputProjectionError('held');
  };
  return Object.freeze({ captured, assertCurrent });
}

/** JSON normalization follows serialization grammar after the plain-data capture. */
export function personalOpsJson(value: unknown): JsonValue {
  const captured = capturePersonalOpsData(value);
  const visit = (entry: unknown): JsonValue => {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry !== 'object') throw new ToolInputProjectionError('invalid');
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(entry)) {
      if (child === undefined) continue;
      Object.defineProperty(result, key, { value: visit(child), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

/** Entry grammar excludes bare numeric and boolean roots. */
export function personalOpsEntry(value: unknown): EntryType {
  const entry = personalOpsJson(value);
  return typeof entry === 'boolean' || typeof entry === 'number' ? { value: entry } : entry;
}

/** Frozen declarations are proven unchanged once instead of at every redaction boundary. */
function freezeDeclarations<T extends readonly { readonly path: readonly string[] }[]>(declarations: T): T {
  for (const declaration of declarations) { Object.freeze(declaration.path); Object.freeze(declaration); }
  return Object.freeze(declarations);
}

/** Native producer facts remain local until the complete DTO is protected. */
export async function protectPersonalOpsData(value: unknown, options: CatalogRankingOptions = {}, schema?: PersonalOpsNativeSchema): Promise<unknown> {
  return protectPersonalOpsSource(value, options, true, schema);
}

/** Arbitrary provider results are observational data. Redacted names/values may
 * change their representation; complete original ownership still survives every
 * reading and publication. Native contracts continue through protectPersonalOpsData. */
export async function protectPersonalOpsResult(value: unknown, options: CatalogRankingOptions = {}): Promise<unknown> {
  return protectPersonalOpsSource(value, options, false);
}

async function protectPersonalOpsSource(value: unknown, options: CatalogRankingOptions, nativeFacts: boolean, schema?: PersonalOpsNativeSchema): Promise<unknown> {
  // One frozen copy, masked once. The masking is local and synchronous in
  // effect, so the copy cannot change under it: the call's signal and the
  // caller's own check are the only things looked at again.
  const captured = capturePersonalOpsSnapshot(value).captured;
  const assertCurrent = (): void => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const result = await redactStructuredDataAsync(captureOwnedJson(captured), { signal: options.signal, assertCurrent,
    declaredFields: freezeDeclarations(nativeFacts ? personalOpsNativeFields(captured, schema) : personalOpsResultFields(captured)),
  });
  const preserveFacts = (original: unknown, protectedValue: unknown): void => {
    if (typeof original === 'boolean' || typeof original === 'number' || original === null) {
      if (original !== protectedValue) throw new ToolInputProjectionError('held');
      return;
    }
    if (!original || typeof original !== 'object') return;
    if (!protectedValue || typeof protectedValue !== 'object' || Array.isArray(original) !== Array.isArray(protectedValue)) throw new ToolInputProjectionError('held');
    for (const [key, child] of Object.entries(original)) {
      // Opaque private object keys cannot establish a native producer fact.
      if (!Object.hasOwn(protectedValue, key)) throw new ToolInputProjectionError('held');
      preserveFacts(child, (protectedValue as Record<string, unknown>)[key]);
    }
  };
  if (nativeFacts) preserveFacts(captured, result);
  assertCurrent(); return result;
}
