/**
 * Readings of the owner's own state for a decision model: the plain-data
 * capture every Agent tool uses before something leaves for a model, wherever
 * the tool runs.
 *
 * A tool call reads each source once into a plain value and passes that value
 * down; a value cannot change, so nothing compares it again between steps.
 * Data that is copied for a reading is bounded here (node and character
 * budgets) and nowhere else.
 *
 * First-party local reads are not privacy-screened: they are the owner's own
 * state read by his own session. Research content keeps its own screening
 * owner (protected-research-report.ts). What leaves for a model is still
 * checked once by `snapshotJudgmentEvidence` (card data, attached secrets,
 * malformed input).
 */
import { snapshotJudgmentEvidence, snapshotJudgmentInput } from '@goodvibes/engine/platform/platform/gate/judgment-input';
import { assertProjectionCurrent, ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import type { ProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security';
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';

/** A reading's restriction callback: absent, or a function that still holds. */
export function assertModelReadingRestriction(callback: (() => unknown) | undefined): void {
  if (callback === undefined) return;
  if (typeof callback !== 'function') throw new ToolInputProjectionError('held');
  assertProjectionCurrent(callback);
}

export interface ModelReadingOptions {
  readonly signal?: AbortSignal | undefined;
  /** The research screening owner, for readers of research content only; local readings need none. */
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  /** The caller's own check (the call is still wanted); cheap, never a re-read of a source. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Checks a reading hands to the publication boundary of the tool call (a judgment port's restriction). */
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
}

/** A bounded plain copy of every field, including ones consumers do not display (hidden fields are data too). */
function captureModelReadingData<T>(value: T): T {
  const budget = { nodes: 0, characters: 0, slots: 0 };
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
    const length = array ? (entry as unknown[]).length : 0;
    if (length > 20_000) return invalid();
    if (array && (budget.slots += length) > 100_000) return invalid();
    const record = entry as Record<string, unknown>;
    const result: object = array ? new Array(length) : Object.create(null);
    ancestors.add(entry);
    try {
      for (const key of Object.getOwnPropertyNames(entry)) {
        if (array && key === 'length') continue;
        const field = record[key];
        if (typeof field === 'function') return invalid();
        budget.characters += key.length;
        if (budget.characters > 1_000_000) return invalid();
        Object.defineProperty(result, key, { value: capture(field, depth + 1), enumerable: true });
      }
      Object.freeze(result); copies.set(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  return capture(value, 0) as T;
}

/** The complete immutable input, checked once at the boundary where it leaves for a model. */
export function captureModelReadingInput<T>(value: T): T {
  return snapshotJudgmentInput(captureModelReadingData(value)) as T;
}
/** A fresh capture must equal the bytes captured at the start of the call. */
export function assertModelReadingInputCurrent(value: unknown, serialized: string | undefined): void {
  if (JSON.stringify(captureModelReadingData(value)) !== serialized) throw new ToolInputProjectionError('held');
}

/** Only the ArtifactStore contract declares these top-level fields as epoch
 * clocks. Keep the native record and expose the same instant as ISO for a
 * reading. Metadata, bodies and every other field keep their meaning. */
export function captureModelArtifactClockSource<T extends Pick<ArtifactDescriptor, 'createdAt' | 'expiresAt'>>(value: T) {
  const native = captureModelReadingData(value);
  const instant = (clock: number): string => {
    if (!Number.isSafeInteger(clock) || Math.abs(clock) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
    return new Date(clock).toISOString();
  };
  const reading = { ...native, createdAt: instant(native.createdAt),
    ...(Object.hasOwn(native, 'expiresAt') ? { expiresAt: native.expiresAt === undefined ? undefined : instant(native.expiresAt) } : {}) };
  return { native, reading };
}

export function captureModelArtifactClockSources(value: readonly ArtifactDescriptor[]) {
  const native = captureModelReadingData(value);
  return { native, reading: native.map(artifact => captureModelArtifactClockSource(artifact).reading) };
}

/**
 * A check that plain data still equals what it was when captured: the same
 * keys and equal values. The data is copied at capture, so a later change to
 * the original is seen; a frozen value that matched once is not compared
 * again. It compares data, not the program's own built-ins or descriptors.
 */
export function captureModelReadingSnapshotGuard(captured: unknown, _exactDescriptors = false): (value: unknown) => void {
  const original = copyPlainData(captured, 0);
  const matchedFrozen = new WeakSet<object>();
  return value => {
    if (value !== null && typeof value === 'object' && matchedFrozen.has(value)) return;
    if (!samePlainData(original, value, 0)) throw new ToolInputProjectionError('held');
    if (value !== null && typeof value === 'object' && Object.isFrozen(value)) matchedFrozen.add(value);
  };
}

function copyPlainData(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 64) throw new ToolInputProjectionError('held');
  if (Array.isArray(value)) return value.map(entry => copyPlainData(entry, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = copyPlainData((value as Record<string, unknown>)[key], depth + 1);
  return copy;
}

function samePlainData(expected: unknown, current: unknown, depth: number): boolean {
  if (Object.is(expected, current)) return true;
  if (expected === null || current === null || typeof expected !== 'object' || typeof current !== 'object' || depth > 64) return false;
  if (Array.isArray(expected) !== Array.isArray(current)) return false;
  const keys = Object.keys(expected);
  if (keys.length !== Object.keys(current).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(current, key)) return false;
    if (!samePlainData((expected as Record<string, unknown>)[key], (current as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}

/**
 * One reading: the source is copied once into a frozen plain value (checked
 * once for what may not leave for a model) and handed to `consume`. "Still
 * wanted" is the call's signal plus the caller's own check; the copy cannot
 * change, so it is not compared again.
 */
export async function withModelReadingSource<T, R>(source: T, options: ModelReadingOptions,
  consume: (captured: T, options: ModelReadingOptions) => Promise<R>): Promise<R> {
  options.signal?.throwIfAborted(); assertModelReadingRestriction(options.assertCurrent);
  const captured = snapshotJudgmentEvidence(captureModelReadingData(source)) as T;
  return consume(captured, options);
}
