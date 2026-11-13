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
 *      - `'new'`       → proceed with execution.
 *      - `'in-flight'` → a prior submission is still running; reject or wait.
 *      - `'duplicate'` → a prior submission completed; return cached result.
 *   2. On success, call `markComplete(key, result)` to cache the result.
 *   3. On failure, call `markFailed(key)` to allow a retry on the next attempt.
 *
 * TTL-based eviction runs automatically whenever the store exceeds `maxRecords`.
 * In-flight records are never evicted.
 */

import { GoodVibesError } from '@goodvibes-jev/engine/errors';
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

/** Default maximum stored records before eviction sweep. */
const DEFAULT_MAX_RECORDS = 5_000;

function missingRecordError(operation: 'markComplete' | 'markFailed', key: string): GoodVibesError {
  return new GoodVibesError(
    `IdempotencyStore.${operation}: no record found for key ${key}`,
    {
      code: 'IDEMPOTENCY_RECORD_NOT_FOUND',
      category: 'internal',
      source: 'runtime',
      recoverable: false,
      operation,
    },
  );
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
 *   store.markComplete(key, result);
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

  constructor(config: IdempotencyStoreConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = config.maxRecords ?? DEFAULT_MAX_RECORDS;
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
    | { readonly status: 'new' }
    | { readonly status: 'in-flight'; readonly record: IdempotencyRecord }
    | { readonly status: 'duplicate'; readonly record: IdempotencyRecord } {
    const existing = this.store.get(key);

    if (existing) {
      if (existing.status === 'in-flight') {
        return { status: 'in-flight', record: existing };
      }
      if (existing.status === 'failed') {
        // Failed records allow retry, delete and fall through to register as new.
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
      createdAt: Date.now(),
    };
    this.store.set(key, record);
    this._maybeSweep();

    return { status: 'new' };
  }

  /**
   * Mark a previously recorded key as `completed` and cache the result.
   *
   * Throws if the key is not in the store. In-flight records are not eligible
   * for eviction, so a missing key indicates an invalid finalization path.
   *
   * @param key    - Idempotency key.
   * @param result - Optional result to cache for duplicate callers.
   */
  markComplete(key: string, result?: unknown): void {
    const record = this.store.get(key);
    if (!record) throw missingRecordError('markComplete', key);
    // Finalized once: a no-op unless in-flight, so a late call cannot rewrite the outcome.
    if (!idempotencyLifecycle.can(record.status, 'completed')) return;
    record.status = 'completed';
    record.completedAt = Date.now();
    if (result !== undefined) {
      record.result = result;
    }
  }

  /**
   * Mark a previously recorded key as `failed`, allowing a subsequent retry.
   *
   * The record transitions from `in-flight` → `failed`. On the next call to
   * `checkAndRecord` with the same key the failed record is deleted and the
   * caller receives `'new'`, allowing a fresh retry.
   *
   * Throws if the key is not in the store. In-flight records are not eligible
   * for eviction, so a missing key indicates an invalid finalization path.
   *
   * @param key - Idempotency key.
   */
  markFailed(key: string): void {
    const record = this.store.get(key);
    if (!record) throw missingRecordError('markFailed', key);
    // A completed record keeps its cached result; only an in-flight record can fail.
    if (!idempotencyLifecycle.can(record.status, 'failed')) return;
    record.status = 'failed';
    record.completedAt = Date.now();
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
   * Evict completed and failed records whose age exceeds the configured TTL.
   *
   * Called automatically by `checkAndRecord` when the store is near capacity.
   * May also be called explicitly (e.g. on a periodic timer).
   *
   * In-flight records are never evicted.
   */
  sweep(): void {
    const now = Date.now();
    const cutoff = now - this.ttlMs;
    for (const [key, record] of this.store) {
      if (record.status !== 'in-flight' && record.createdAt < cutoff) {
        this.store.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Trigger a sweep when the store reaches 80% of the configured maximum. */
  private _maybeSweep(): void {
    if (this.store.size >= Math.floor(this.maxRecords * 0.8)) {
      this.sweep();
    }
  }
}
