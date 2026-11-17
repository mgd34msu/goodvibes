import { captureOwnedJson, JudgmentInputError } from '../gate/judgment-input.js';

/**
 * A knowledge record has one representation: the values code reads are the
 * values stored, clocks as integer milliseconds. A row an older build wrote
 * with an ISO clock is decoded to the number on read (`knowledgeClockNumber`)
 * and the store rewrites such columns as integers once (store-schema.ts).
 */
const immutableRecordVersions = new WeakMap<object, string>();
const versionGet = WeakMap.prototype.get, versionSet = WeakMap.prototype.set, applyVersion = Reflect.apply;
export function knowledgeRecordVersion(value: unknown): string {
  // captureOwnedJson reuses only its own deeply immutable roots. Mutable live
  // records are detached anew, so corrections are never hidden by this cache.
  const captured = captureOwnedJson(value);
  const cached = captured && typeof captured === 'object' ? applyVersion(versionGet, immutableRecordVersions, [captured]) as string | undefined : undefined;
  if (cached !== undefined) return cached;
  const encode = (item: unknown): unknown => {
    if (item === undefined) return ['undefined'];
    if (item === null) return ['null'];
    if (typeof item !== 'object') return [typeof item, typeof item === 'number' && Object.is(item, -0) ? '-0' : item];
    const entries = Object.entries(Object.getOwnPropertyDescriptors(item))
      .filter(([key]) => !Array.isArray(item) || key !== 'length')
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, descriptor]) => [key, encode(descriptor.value)]);
    return Array.isArray(item) ? ['array', item.length, entries] : ['object', entries];
  };
  const version = JSON.stringify(encode(captured));
  if (captured && typeof captured === 'object') applyVersion(versionSet, immutableRecordVersions, [captured, version]);
  return version;
}
export function sameKnowledgeRecord(left: unknown, right: unknown): boolean {
  // Bun's util comparator ignores named array fields. Reuse the complete
  // existing representation and its original immutable-root memo instead.
  return knowledgeRecordVersion(left) === knowledgeRecordVersion(right);
}
/**
 * The record as stored. There is no second copy to bind any more: the stored
 * form is the record itself, so this returns `view` as it is.
 */
export function retainKnowledgeRepresentation<T>(view: T, _stored?: unknown): T {
  return view;
}
/** A detached plain copy of the record as it is written. Never converts a primitive based on its name, type, magnitude or value. */
export function knowledgeRawRepresentation<T>(value: T): T {
  return knowledgeRepresentation(value, false);
}
/** Semantic admission retains hidden data as well as native clock provenance. */
export function knowledgeJudgmentRepresentation<T>(value: T): T {
  return knowledgeRepresentation(value, true);
}
function knowledgeRepresentation<T>(value: T, includeHidden: boolean): T {
  // Ordinary persistence is not a new privacy admission point. Inspect only data
  // descriptors; preserve unsupported subtrees (including their old toJSON/getter
  // serialization behavior) without evaluating them or acquiring proof.
  const copied = new WeakMap<object, object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (!item || typeof item !== 'object' || depth > 64) return item;
    if (copied.has(item)) return copied.get(item);
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(descriptors).length
      || Object.values(descriptors).some(descriptor => !('value' in descriptor) || typeof descriptor.value === 'function')) return item;
    const result: object = array ? new Array(descriptors.length!.value as number) : Object.create(null);
    copied.set(item, result);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array ? key === 'length' : !includeHidden && !descriptor.enumerable) continue;
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return visit(value, 0) as T;
}
/** Existing node retention has JSON-value normalization (unset object fields and
 * empty array slots). Keep it without discarding named array data. The complete
 * newly retained value, rather than its pre-normalized caller, gets a pair. */
export function normalizeKnowledgeStoredView<T>(value: T): T {
  let captured: unknown;
  try { captured = captureOwnedJson(value); } catch { return JSON.parse(JSON.stringify(value)) as T; }
  const visit = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    const array = Array.isArray(item), result: object = array ? new Array(item.length).fill(null) : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (array && key === 'length') continue;
      const index = Number(key), indexed = array && Number.isInteger(index) && index >= 0 && String(index) === key && index < item.length;
      if (!array && descriptor.value === undefined) continue;
      Object.defineProperty(result, key, { value: indexed && descriptor.value === undefined ? null : visit(descriptor.value), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return visit(captured) as T;
}
/** Normalize the owned fresh/cache view to the existing persisted JSON value
 * semantics while preserving named array data for complete original admission.
 * Unsupported ordinary inputs remain unchanged, without a new proof. */
export function retainKnowledgePreparedRecord<T>(record: T): T {
  try { captureOwnedJson(record); } catch { return record; }
  return normalizeKnowledgeStoredView(record);
}
/** Lossless successor to the import path's old snapshotNodeInput clone. Keep its
 * nonfinite-number preservation for downstream existing checks, but visit every
 * own array field rather than dropping caller extras with Array.map. It checks
 * shape only (plain data, no accessors or cycles, bounded depth); how large one
 * imported record may be is KNOWLEDGE_IMPORT_RECORD_MAX_CHARS, checked per record. */
export function captureKnowledgeStoreInput<T>(input: T): T {
  const ancestors = new Set<object>();
  const fail = (): never => { throw new JudgmentInputError('unsupported-input'); };
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 64) return fail();
    if (typeof value === 'string') return value;
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object' || ancestors.has(value)) return fail();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(descriptors).length || Object.values(descriptors).some(item => !('value' in item))) return fail();
    const length = array ? descriptors.length!.value as number : 0;
    if (array) for (let index = 0; index < length; index++) if (!Object.hasOwn(descriptors, String(index))) return fail();
    const output: object = array ? new Array(length) : {};
    ancestors.add(value);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array ? key === 'length' : !descriptor.enumerable) continue;
        Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(output);
    } finally { ancestors.delete(value); }
  };
  return visit(input, 0) as T;
}
export function copyKnowledgeRepresentation<T>(original: T, copy: T): T {
  let unchanged: boolean;
  try { unchanged = sameKnowledgeRecord(original, copy); } catch { return copy; }
  if (!unchanged) throw new TypeError('Knowledge representation copy changed');
  return copy;
}
export function knowledgeClockIso(value: number): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new TypeError('Invalid knowledge clock');
  return new Date(value).toISOString();
}
export function isKnowledgeClock(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= 8_640_000_000_000_000 && new Date(parsed).toISOString() === value;
}
/** General hydration stays compatible. Semantic admission validates originals. */
export function knowledgeClockNumber(value: unknown): number {
  return typeof value === 'string' && isKnowledgeClock(value) ? Date.parse(value) : Number(value);
}
/** Only an actual prepare operation invokes this at fresh clock creation; the clocks are stored as the numbers they are. */
export function prepareKnowledgeOwnedClocks<T extends { readonly createdAt: number; readonly updatedAt: number }>(record: T, existing: T | null | undefined, now: number): T {
  if (record.updatedAt !== now || (existing ? !Object.is(record.createdAt, existing.createdAt) : record.createdAt !== now)) throw new TypeError('Owned knowledge clocks do not match their writer');
  return record;
}
/** A producer's explicit record edit keeps the clocks it carries; with one representation there is nothing else to carry. */
export function carryKnowledgeRecordClocks<T extends { readonly createdAt: number; readonly updatedAt: number }>(_origin: T, record: T): T {
  return record;
}
/** These constructors own the stamps; existing/caller numeric metadata is never
 * rewritten merely because it uses these same property names. */
export function knowledgeDecisionStamp<T extends Record<string, unknown>>(now: number, fields: T): T & { decidedAt: number } {
  return { ...fields, decidedAt: now };
}
export function knowledgeReviewStamp<T extends Record<string, unknown>>(now: number, fields: T): T & { reviewedAt: number } {
  return { ...fields, reviewedAt: now };
}
/**
 * Record metadata reads exactly as it is stored: a clock a producer wrote as
 * ISO text stays text, a number stays a number, so writing a record back
 * never changes its metadata (or the identity and content revisions computed
 * from it). A reader that needs the number uses `knowledgeClockNumber`.
 */
export function knowledgeNodeMetadataView(raw: Record<string, unknown>): Record<string, unknown> {
  return raw;
}
export function knowledgeSourceMetadataView(raw: Record<string, unknown>): Record<string, unknown> {
  return raw;
}
/** The search producer emits canonical data immediately, so intervening ingest
 * copies never need to infer provenance from a caller's numeric searchedAt. */
export function knowledgeSearchStamp<T extends Record<string, unknown>>(fields: T): T & { searchedAt: string } {
  return { ...fields, searchedAt: knowledgeClockIso(Date.now()) };
}
/** Source crawl clock minted here; this does not normalize an input clock. */
export function knowledgeSourceCrawledNow<T extends object>(input: T): T & { lastCrawledAt: number } {
  captureOwnedJson(input);
  if (Object.hasOwn(input, 'lastCrawledAt')) throw new TypeError('Owned crawl input must not supply lastCrawledAt');
  return { ...input, lastCrawledAt: Date.now() };
}
