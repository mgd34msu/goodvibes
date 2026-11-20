/**
 * Idempotency, store and key generation.
 *
 * Provides an in-process idempotency store for tool-call deduplication across
 * replay and reconnect within this store's lifetime. Keys are deterministic (derived from
 * session + turn + call identifiers) so the same logical call always maps to the
 * same key regardless of when it is submitted.
 *
 * Lifecycle:
 *   1. Before executing a tool, call `checkAndRecord(key)`.
 *      - `'new'`       → proceed with execution; the result carries the caller's `claim`.
 *      - `'in-flight'` → a prior submission is still running; reject or wait.
 *      - `'duplicate'` → a prior submission completed; return cached result.
 *   2. On success, call `claim.complete(result)` to cache the result.
 *   3. On failure, call `claim.fail()` to allow a retry on the next attempt.
 *
 * A claim settles only the record it created: an abandoned in-flight record
 * that was replaced under the same key has a new epoch, so the original
 * owner's late `complete` or `fail` changes nothing and returns false.
 *
 * TTL-based eviction runs automatically whenever the store exceeds `maxRecords`.
 * An in-flight record is evicted only once it is older than `inFlightTimeoutMs`,
 * which marks its caller as gone.
 */

import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import type {
  IdempotencyKeyContext,
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStoreConfig,
} from './types.js';

export type { IdempotencyKeyContext, IdempotencyRecord, IdempotencyStoreConfig } from './types.js';
export type { IdempotencyStatus } from './types.js';

/**
 * The idempotency record lifecycle. Only an in-flight record is finalized, once:
 * a completed record keeps its cached result and a failed one stays failed until
 * `checkAndRecord` deletes it and registers a fresh in-flight record (a new
 * record, not a transition of the old one).
 */
export const idempotencyLifecycle = defineLifecycle<IdempotencyStatus>('idempotency record', {
  'in-flight': ['completed', 'failed'],
  completed: [],
  failed: [],
});

/** Default TTL: 5 minutes. */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

/** Default age after which an unfinalized in-flight record counts as abandoned: 2 hours. */
const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

/** Default maximum stored records before eviction sweep. */
const DEFAULT_MAX_RECORDS = 5_000;

/** The owner's hold on the record `checkAndRecord` created for it. */
export interface IdempotencyClaim {
  readonly key: string;
  /** The record's epoch at creation; a replacement record under the same key has another. */
  readonly epoch: number;
  /** Caches the result. False (nothing changed) when the record was replaced or is already finalized. */
  complete(result?: unknown): boolean;
  /** Lets the next submission retry. False (nothing changed) when the record was replaced or is already finalized. */
  fail(): boolean;
}

/**
 * IdempotencyStore, bounded, TTL-evicted in-process store.
 *
 * Thread safety: Node.js is single-threaded; no locking is required.
 * Suitable for in-process use within a single runtime session.
 *
 * @example
 * ```ts
 * const store = new IdempotencyStore({ ttlMs: 5 * 60_000 });
 * const key = store.generateKey({ sessionId, turnId, callId });
 * const check = store.checkAndRecord(key);
 * if (check.status === 'new') {
 *   const result = await doWork();
 *   check.claim.complete(result);
 *   return result;
 * } else if (check.status === 'duplicate') {
 *   return check.record.result; // cached
 * } else {
 *   throw new Error('Tool call already in-flight');
 * }
 * ```
 */
export class IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;
  private readonly maxRecords: number;
  private readonly inFlightTimeoutMs: number;
  private readonly now: () => number;
  /** The epoch the next created record gets; one integer per record. */
  private nextEpoch = 1;

  constructor(config: IdempotencyStoreConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = config.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.inFlightTimeoutMs = config.inFlightTimeoutMs ?? DEFAULT_IN_FLIGHT_TIMEOUT_MS;
    this.now = config.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // Key generation
  // ---------------------------------------------------------------------------

  /**
   * Generate a deterministic idempotency key from a call context.
   *
   * Encodes the exact identifier tuple, so separators inside an identifier do
   * not merge distinct calls. Callers must pass identifiers, never prompt text.
   *
   * @param context - Session, turn, and call identifiers.
   * @returns JSON-encoded identifier tuple, for this in-process map.
   */
  generateKey(context: IdempotencyKeyContext): string {
    return JSON.stringify([context.sessionId, context.turnId, context.callId]);
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  /**
   * Check whether a key has been seen before and record it as `in-flight` if new.
   *
   * Returns a discriminated union:
   * - `{ status: 'new' }`       , key is unseen; record created and marked in-flight.
   * - `{ status: 'in-flight' }` , a prior submission is still running.
   * - `{ status: 'duplicate', record }`, prior submission completed; record holds cached result.
   *
   * @param key - Idempotency key from `generateKey`.
   */
  checkAndRecord(
    key: string,
  ):
    | { readonly status: 'new'; readonly claim: IdempotencyClaim }
    | { readonly status: 'in-flight'; readonly record: IdempotencyRecord }
    | { readonly status: 'duplicate'; readonly record: IdempotencyRecord } {
    const existing = this.store.get(key);

    if (existing) {
      if (existing.status === 'in-flight' && !this._abandoned(existing, this.now())) {
        return { status: 'in-flight', record: existing };
      }
      if (existing.status === 'in-flight' || existing.status === 'failed') {
        // Failed (or abandoned in-flight) records allow retry, delete and fall through to register as new.
        this.store.delete(key);
      } else {
        // completed, return cached result to duplicate callers
        return { status: 'duplicate', record: existing };
      }
    }

    // New key, record as in-flight
    const record: IdempotencyRecord = {
      key,
      status: 'in-flight',
      createdAt: this.now(),
      epoch: this.nextEpoch++,
    };
    this.store.set(key, record);
    this._maybeSweep();

    return { status: 'new', claim: this._claim(record) };
  }

  /**
   * The claim on `record`: it finalizes the record only while the store still
   * holds that record (same epoch) and it is in flight. Finalized once, so a
   * late call cannot rewrite the outcome; a failed record lets the next
   * `checkAndRecord` with the key register a fresh in-flight record.
   */
  private _claim(record: IdempotencyRecord): IdempotencyClaim {
    const { key, epoch } = record;
    const settle = (to: 'completed' | 'failed', result?: unknown): boolean => {
      const current = this.store.get(key);
      if (current === undefined || current.epoch !== epoch || !idempotencyLifecycle.can(current.status, to)) return false;
      current.status = to;
      current.completedAt = this.now();
      if (to === 'completed' && result !== undefined) current.result = result;
      return true;
    };
    return Object.freeze({ key, epoch, complete: (result?: unknown) => settle('completed', result), fail: () => settle('failed') });
  }

  // ---------------------------------------------------------------------------
  // Inspection
  // ---------------------------------------------------------------------------

  /**
   * Look up a record by key without changing its state.
   *
   * @param key - Idempotency key.
   * @returns The record, or `undefined` if not found or already evicted.
   */
  getRecord(key: string): IdempotencyRecord | undefined {
    return this.store.get(key);
  }

  /**
   * Returns the current number of records in the store (including in-flight).
   */
  get size(): number {
    return this.store.size;
  }

  // ---------------------------------------------------------------------------
  // TTL eviction
  // ---------------------------------------------------------------------------

  /**
   * Evict completed and failed records whose age exceeds the configured TTL,
   * in-flight records abandoned past `inFlightTimeoutMs`, and, when the store
   * still holds more than `maxRecords`, the oldest finalized records beyond it.
   *
   * Called automatically by `checkAndRecord` when the store is near capacity.
   * May also be called explicitly (e.g. on a periodic timer).
   */
  sweep(): void {
    const now = this.now();
    const cutoff = now - this.ttlMs;
    for (const [key, record] of this.store) {
      if (record.status === 'in-flight' ? this._abandoned(record, now) : record.createdAt < cutoff) {
        this.store.delete(key);
      }
    }
    // Map iteration is insertion order, oldest first. A live in-flight record is never dropped for capacity.
    for (const [key, record] of this.store) {
      if (this.store.size <= this.maxRecords) break;
      if (record.status !== 'in-flight') this.store.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _abandoned(record: IdempotencyRecord, now: number): boolean {
    return now - record.createdAt > this.inFlightTimeoutMs;
  }

  /** Trigger a sweep when the store reaches 80% of the configured maximum. */
  private _maybeSweep(): void {
    if (this.store.size >= Math.floor(this.maxRecords * 0.8)) {
      this.sweep();
    }
  }
}
