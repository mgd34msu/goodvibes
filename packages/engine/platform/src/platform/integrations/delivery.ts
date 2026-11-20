import { deliveryHttpStatus, describeStructuralDeliveryError } from './delivery-diagnostics.js';
import { logger } from '../utils/logger.js';
import { randomInt, randomUUID } from 'node:crypto';
import {
  GoodVibesError,
  structuredTransience,
  type FailureClass,
  type FailureTransience,
  type TransienceBasis,
  type TransienceOptions,
} from '@goodvibes/engine/errors';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { ConfigManager } from '../config/manager.js';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';

import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// Delivery outcome taxonomy
// ---------------------------------------------------------------------------

/**
 * The three possible outcomes for a single integration delivery attempt.
 *
 * - `delivered`  , message reached the destination successfully
 * - `retrying`   , delivery failed with a retryable error; queued for retry
 * - `dead_letter`, all retry attempts exhausted or terminal failure; moved to DLQ
 */
export type DeliveryOutcome = 'delivered' | 'retrying' | 'dead_letter';

/**
 * Classification of a delivery failure.
 *
 * - `retryable`, transient error; should be retried with backoff
 *   (network timeout, HTTP 429, HTTP 5xx)
 * - `terminal` , permanent error; should not be retried
 *   (HTTP 400/401/403/404, invalid URL, message too large)
 */
export type DeliveryFailureClass = FailureClass;

// ---------------------------------------------------------------------------
// Failure transience
// ---------------------------------------------------------------------------

export type { FailureTransience, TransienceBasis, TransienceOptions };

// One retry decision for every site: a DeliveryError states its class through
// `recoverable`, which the shared decision honours first.
export { readFailureTransience, structuredTransience } from '@goodvibes/engine/errors';

/**
 * Whether a delivery failure is worth another attempt, decided from the
 * failure's own facts (a stated class, Retry-After, HTTP status, connection
 * code, timeout class), never by reading its wording. A failure that carries
 * none of them is retried: the attempt budget bounds it.
 */
export function deliveryTransience(error: unknown): FailureTransience {
  return structuredTransience(error)
    ?? { failureClass: 'retryable', basis: 'classic', detail: 'no status, code or error class; retried within the attempt budget' };
}

/** Classifies a delivery error as retryable or terminal (see {@link deliveryTransience}). */
export async function classifyDeliveryError(error: unknown, _site?: string): Promise<DeliveryFailureClass> {
  return deliveryTransience(error).failureClass;
}

// ---------------------------------------------------------------------------
// DeliveryError, typed error with explicit classification
// ---------------------------------------------------------------------------

/** Typed delivery error that carries an explicit failure classification. */
export class DeliveryError extends GoodVibesError {
  declare readonly code: 'DELIVERY_ERROR';
  constructor(
    message: string,
    public readonly failureClass: DeliveryFailureClass,
    public readonly statusCode?: number,
  ) {
    super(message, { code: 'DELIVERY_ERROR', category: 'internal', source: 'runtime', recoverable: failureClass === 'retryable' });
    this.name = 'DeliveryError';
  }
}

// ---------------------------------------------------------------------------
// Dead-letter entry
// ---------------------------------------------------------------------------

/**
 * A single entry in the dead-letter queue.
 * Immutable snapshot of a delivery that exhausted all retry attempts.
 */
export interface DeadLetterEntry<TPayload = string> {
  /** Unique entry identifier. */
  readonly id: string;
  /** Integration channel (e.g. "slack", "discord", "webhook"). */
  readonly channel: string;
  /** Event name that triggered the delivery. */
  readonly event: string;
  /**
   * Where the transport sends it when one channel has several destinations
   * (a webhook URL). Kept for replay; never shown in diagnostics, since a URL
   * can carry a secret topic or token.
   */
  readonly target?: string | undefined;
  /** Owned payload that failed to deliver. Existing queues default to text. */
  readonly payload: TPayload;
  /** Epoch ms when the entry was created (first attempt). */
  readonly createdAt: number;
  /** Epoch ms when the entry moved to the DLQ. */
  readonly deadAt: number;
  /** Number of delivery attempts made. */
  readonly attempts: number;
  /** Final error message. */
  readonly finalError: string;
  /** Failure class of the final error. */
  readonly failureClass: DeliveryFailureClass;
  /** Validated structural evidence, available on restricted-diagnostic queues. */
  readonly status?: number | undefined;
  readonly basis?: TransienceBasis | undefined;
}

// ---------------------------------------------------------------------------
// Delivery metrics
// ---------------------------------------------------------------------------

/** Counters for delivery SLO tracking. */
export interface DeliveryMetrics {
  /** Total delivery attempts (all channels combined). */
  readonly totalAttempts: number;
  /** Successfully delivered messages. */
  readonly delivered: number;
  /** Messages currently queued for retry. */
  readonly retrying: number;
  /** Messages moved to the dead-letter queue. */
  readonly deadLettered: number;
  /** Total entries in the DLQ (including previously replayed). */
  readonly dlqSize: number;
}

// ---------------------------------------------------------------------------
// Queue configuration
// ---------------------------------------------------------------------------

/** Configuration for the DeliveryQueue. */
export interface DeliveryQueueConfig {
  /**
   * Maximum retry attempts after the initial delivery attempt.
   * E.g., maxRetries: 3 means 4 total attempts (1 initial + 3 retries).
   */
  maxRetries: number;
  /** Initial backoff delay in ms (default: 1000). */
  initialDelayMs: number;
  /** Maximum backoff delay in ms (default: 30_000). */
  maxDelayMs: number;
  /** Maximum dead-letter queue size; oldest entries evicted when exceeded (default: 500). */
  maxDlqSize: number;
  /**
   * When true, SLO enforcement is active: dead-letter events are logged at
   * error level and metrics are updated. When false, failures are logged at
   * warn level only.
   *
   * Controlled by the integrations.delivery.sloEnforced setting (the `integration-delivery-slo` gate).
   */
  sloEnforced: boolean;
}

export interface DeliveryQueueOptions extends Partial<DeliveryQueueConfig> {
  /** Structural mode retains/logs no response or transport wording; decisions still read the original failure. */
  readonly diagnosticMode?: 'detailed' | 'structural' | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  /**
   * Optional config source. When supplied, retry/backoff/DLQ/SLO defaults are read
   * from integrations.delivery.*, explicit option fields still override, and the
   * gate remains the fallback source for sloEnforced.
   */
  readonly configManager?: Pick<ConfigManager, 'get'> | null | undefined;
}

const DEFAULT_CONFIG: DeliveryQueueConfig = {
  maxRetries: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxDlqSize: 500,
  sloEnforced: false,
};

/** Read integration delivery defaults from config, or {} when no config source. */
function readDeliveryConfig(
  configManager?: Pick<ConfigManager, 'get'> | null | undefined,
): Partial<DeliveryQueueConfig> {
  if (!configManager) return {};
  const read = {
    maxRetries: configManager.get('integrations.delivery.maxRetries'),
    initialDelayMs: configManager.get('integrations.delivery.initialDelayMs'),
    maxDelayMs: configManager.get('integrations.delivery.maxDelayMs'),
    maxDlqSize: configManager.get('integrations.delivery.maxDlqSize'),
    sloEnforced: configManager.get('integrations.delivery.sloEnforced'),
  };
  // An unset key must leave the default in place, not overwrite it with undefined.
  return Object.fromEntries(Object.entries(read).filter(([, value]) => value !== undefined)) as Partial<DeliveryQueueConfig>;
}

interface PendingEntry<TPayload> {
  id: string;
  channel: string;
  event: string;
  target?: string | undefined;
  payload: TPayload;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  deliver: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// DeliveryQueue
// ---------------------------------------------------------------------------

/**
 * How a queue writes its payloads into the dead-letter file and reads them
 * back. `encode` returns undefined for a payload that must not be written
 * down; that entry stays in memory only.
 */
export interface DeadLetterCodec<TPayload> {
  encode(payload: TPayload): unknown;
  decode(value: unknown): TPayload | undefined;
}

interface StoredDeadLetter {
  readonly id: string;
  readonly channel: string;
  readonly event: string;
  readonly target?: string;
  readonly payload: unknown;
  readonly createdAt: number;
  readonly deadAt: number;
  readonly attempts: number;
  readonly finalError: string;
  readonly failureClass: DeliveryFailureClass;
  readonly status?: number;
  readonly basis?: TransienceBasis;
}

const BASES: ReadonlySet<string> = new Set<TransienceBasis>(['explicit', 'retry-after', 'status', 'errno', 'error-type', 'cancelled', 'reading', 'classic', 'no-wording']);

function readStoredDeadLetters(parsed: unknown): StoredDeadLetter[] {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    throw new Error('expected { entries: [...] }');
  }
  const out: StoredDeadLetter[] = [];
  for (const raw of (parsed as { entries: unknown[] }).entries) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.channel !== 'string' || typeof r.event !== 'string') continue;
    if (typeof r.createdAt !== 'number' || typeof r.deadAt !== 'number' || typeof r.attempts !== 'number') continue;
    if (r.failureClass !== 'retryable' && r.failureClass !== 'terminal') continue;
    out.push({
      id: r.id, channel: r.channel, event: r.event, payload: r.payload,
      createdAt: r.createdAt, deadAt: r.deadAt, attempts: r.attempts,
      finalError: typeof r.finalError === 'string' ? r.finalError : 'Delivery failed',
      failureClass: r.failureClass,
      ...(typeof r.target === 'string' ? { target: r.target } : {}),
      ...(typeof r.status === 'number' ? { status: r.status } : {}),
      ...(typeof r.basis === 'string' && BASES.has(r.basis) ? { basis: r.basis as TransienceBasis } : {}),
    });
  }
  return out;
}

/**
 * Delivery queue with retry/backoff and dead-letter storage.
 *
 * Wrap any integration send operation with `enqueue()`. The queue:
 *  1. Attempts delivery immediately.
 *  2. On failure, decides whether it is transient from the failure's own facts
 *     ({@link deliveryTransience}); no model reads the wording.
 *  3. On retryable failure: schedules retry with exponential backoff + jitter.
 *  4. On terminal failure or exhausted retries: moves entry to DLQ.
 *  5. Emits `delivery:dead_letter` events to registered listeners.
 *
 * Dead-letter entries can be replayed via `replay()` or cleared with `clearDlq()`.
 * After {@link DeliveryQueue.persistDeadLetters} they are kept in a file and
 * survive a restart.
 *
 * Enable SLO enforcement via the integrations.delivery.sloEnforced setting to
 * surface dead-letter failures as error-level log entries and expose them in
 * integration diagnostics.
 */
export class DeliveryQueue<TPayload = string> {
  private readonly _config: DeliveryQueueConfig;
  private readonly _structuralDiagnostics: boolean;
  private readonly _dlq: DeadLetterEntry<TPayload>[] = [];
  private _store: { readonly path: string; readonly codec: DeadLetterCodec<TPayload> } | undefined;
  /** Dead letters being replayed now: they stay listed (and on disk) until the replay's delivery succeeded. */
  private readonly _replaying = new Set<string>();
  private readonly _pending = new Map<string, PendingEntry<TPayload>>();
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _listeners = new Set<(entry: DeadLetterEntry<TPayload>) => void>();

  // Metrics counters
  private _totalAttempts = 0;
  private _delivered = 0;
  private _retrying = 0;
  private _deadLettered = 0;
  private _closed = false;
  private _closing: Promise<void> | undefined;
  private readonly _active = new Set<Promise<unknown>>();
  /** The same counters per channel, for a queue shared by several channels. */
  private readonly _channelTallies = new Map<string, { totalAttempts: number; delivered: number; retrying: number; deadLettered: number }>();

  private _tally(channel: string): { totalAttempts: number; delivered: number; retrying: number; deadLettered: number } {
    let tally = this._channelTallies.get(channel);
    if (!tally) {
      tally = { totalAttempts: 0, delivered: 0, retrying: 0, deadLettered: 0 };
      this._channelTallies.set(channel, tally);
    }
    return tally;
  }

  constructor(config: DeliveryQueueOptions = {}) {
    const { featureFlags, configManager, diagnosticMode, ...queueConfig } = config;
    this._structuralDiagnostics = diagnosticMode === 'structural';
    const fromConfig = readDeliveryConfig(configManager);
    this._config = {
      ...DEFAULT_CONFIG,
      ...fromConfig,
      ...queueConfig,
      sloEnforced: queueConfig.sloEnforced
        ?? fromConfig.sloEnforced
        ?? featureFlags?.isEnabled('integration-delivery-slo')
        ?? DEFAULT_CONFIG.sloEnforced,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Enqueue a delivery attempt.
   *
   * @param channel - Integration channel identifier (e.g. "slack").
   * @param event   - Event name for tracing.
   * @param payload - Owned delivery payload; string by default for existing callers.
   * @param deliver - Async function that performs the actual delivery.
   * @returns The delivery outcome for the immediate attempt.
   */
  async enqueue(
    channel: string,
    event: string,
    payload: TPayload,
    deliver: () => Promise<void>,
    options: { readonly target?: string | undefined } = {},
  ): Promise<DeliveryOutcome> {
    this._assertOpen();
    const id = `${channel}:${event}:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const entry: PendingEntry<TPayload> = {
      id,
      channel,
      event,
      ...(options.target !== undefined ? { target: options.target } : {}),
      payload,
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
      deliver,
    };
    this._pending.set(id, entry);
    return this._startAttempt(entry);
  }

  /**
   * Keep dead letters in `path` from now on: entries already there (from an
   * earlier run) are loaded at once, and every change to the list is written
   * through. One document write per dead letter, replay or clear; nothing on
   * a delivery that succeeds. Throws when the file cannot be written: the
   * caller must not discard another copy of these entries (an adopted file)
   * on the strength of a write that did not happen.
   */
  persistDeadLetters(path: string, codec: DeadLetterCodec<TPayload>): void {
    this._store = { path, codec };
    const stored = readDocument(path, {
      label: 'integrations/dead-letters',
      validate: readStoredDeadLetters,
      recovery: 'Notifications that had failed before this file became unreadable are no longer listed or replayable.',
    }) ?? [];
    const known = new Set(this._dlq.map((entry) => entry.id));
    for (const row of stored) {
      if (known.has(row.id)) continue;
      const payload = codec.decode(row.payload);
      if (payload === undefined) continue;
      const { payload: _encoded, ...rest } = row;
      this._retainDeadLetter({ ...rest, payload }, false);
    }
    this._writeDeadLetters(this._dlq);
  }

  /**
   * Replay dead-letter entries: all of them, or only those whose id is in `ids`.
   *
   * Each entry is re-enqueued with a fresh retry budget. The DLQ is cleared
   * on a per-entry basis as each replayed entry resolves.
   *
   * @param deliver - The delivery function to replay with. The dead-letter
   *   queue keeps payloads, not the original delivery closures (they do not
   *   survive a restart), so the caller supplies how to send.
   *
   * @returns Array of per-entry replay results.
   */
  replay(
    deliver: (entry: DeadLetterEntry<TPayload>) => Promise<void>,
    ids?: readonly string[],
    /** The destination the resent entry is for from now on; absent: the one it failed on. */
    retarget?: (entry: DeadLetterEntry<TPayload>) => string | undefined,
  ): Promise<Array<{ id: string; outcome: DeliveryOutcome }>> {
    return this._own(() => this._replay(deliver, ids, retarget));
  }

  private async _replay(
    deliver: (entry: DeadLetterEntry<TPayload>) => Promise<void>,
    ids?: readonly string[],
    retarget?: (entry: DeadLetterEntry<TPayload>) => string | undefined,
  ): Promise<Array<{ id: string; outcome: DeliveryOutcome }>> {
    this._assertOpen();
    const wanted = ids === undefined ? undefined : new Set(ids);
    const entries = this._dlq.filter((entry) => wanted === undefined || wanted.has(entry.id));
    const results: Array<{ id: string; outcome: DeliveryOutcome }> = [];

    for (const dlqEntry of entries) {
      this._assertOpen();
      // Another replay or an explicit clear may have already consumed this row.
      if (this._replaying.has(dlqEntry.id) || !this._dlq.some((e) => e.id === dlqEntry.id)) continue;
      // The row stays listed, and on disk, while it is replayed: a daemon that
      // stops mid-replay still lists it after its restart.
      this._replaying.add(dlqEntry.id);
      try {
        const outcome = await this.enqueue(
          dlqEntry.channel,
          dlqEntry.event,
          dlqEntry.payload,
          () => deliver(dlqEntry),
          { target: retarget ? retarget(dlqEntry) : dlqEntry.target },
        );
        // Settled: delivered, or dead-lettered again as its own new row. Either
        // way this row is done, and goes with one write.
        this._removeDeadLetter(dlqEntry);
        results.push({ id: dlqEntry.id, outcome });
      } finally {
        // A replay with no settled outcome leaves the row where it was.
        this._replaying.delete(dlqEntry.id);
      }
    }

    return results;
  }

  /** Save, then publish: the list without the row is written, then the row leaves memory. A failed write leaves it listed and throws. */
  private _removeDeadLetter(dlqEntry: DeadLetterEntry<TPayload>): void {
    const remaining = this._dlq.filter((entry) => entry.id !== dlqEntry.id);
    if (remaining.length === this._dlq.length) return;
    this._writeDeadLetters(remaining);
    const idx = this._dlq.findIndex((e) => e.id === dlqEntry.id);
    if (idx === -1) return;
    this._dlq.splice(idx, 1);
    this._deadLettered = Math.max(0, this._deadLettered - 1);
    this._tally(dlqEntry.channel).deadLettered = Math.max(0, this._tally(dlqEntry.channel).deadLettered - 1);
  }

  /**
   * Register a listener invoked whenever an entry moves to the DLQ.
   * Returns an unsubscribe function.
   */
  onDeadLetter(listener: (entry: DeadLetterEntry<TPayload>) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Get current dead-letter queue contents (snapshot). */
  getDlq(): readonly DeadLetterEntry<TPayload>[] {
    return [...this._dlq];
  }

  /** Clear all dead-letter entries. */
  clearDlq(): number {
    const count = this._dlq.length;
    // Written first: a failed write throws and the list stays as it was.
    this._writeDeadLetters([]);
    this._dlq.length = 0;
    this._deadLettered = 0;
    for (const tally of this._channelTallies.values()) tally.deadLettered = 0;
    return count;
  }

  /** Whether SLO enforcement is active for this queue. */
  get sloEnforced(): boolean { return this._config.sloEnforced; }

  /**
   * Current delivery metrics snapshot: the whole queue, or only the entries
   * enqueued for `channel` when one queue serves several channels.
   */
  getMetrics(channel?: string): DeliveryMetrics {
    if (channel !== undefined) {
      const tally = this._channelTallies.get(channel);
      return {
        totalAttempts: tally?.totalAttempts ?? 0,
        delivered: tally?.delivered ?? 0,
        retrying: tally?.retrying ?? 0,
        deadLettered: tally?.deadLettered ?? 0,
        dlqSize: this._dlq.filter((entry) => entry.channel === channel).length,
      };
    }
    return {
      totalAttempts: this._totalAttempts,
      delivered: this._delivered,
      retrying: this._retrying,
      deadLettered: this._deadLettered,
      dlqSize: this._dlq.length,
    };
  }

  /**
   * Permanently close admission and cancel pending retries. Admitted deliveries
   * may finish, but cannot start another attempt. Use close() to drain them.
   */
  dispose(): void {
    this._closed = true;
    const abandoned = this._timers.size;
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this._pending.clear();
    this._retrying = 0;
    for (const tally of this._channelTallies.values()) tally.retrying = 0;
    if (abandoned > 0) {
      // These were reported to their callers as `retrying`; say they will not be.
      logger.warn('DeliveryQueue: closed with deliveries still waiting to retry; they will not be sent', { abandoned });
    }
  }

  /**
   * Stop admission/retries immediately, then await already admitted attempts.
   * A delivery callback must settle itself; this does not cancel its transport.
   * Delivery failures remain observable through their original promises.
   */
  close(): Promise<void> {
    this.dispose();
    return this._closing ??= Promise.allSettled([...this._active]).then(() => {});
  }

  private _describeError(error: unknown): string {
    return this._structuralDiagnostics ? describeStructuralDeliveryError(error) : summarizeError(error);
  }

  private _assertOpen(): void {
    if (this._closed) throw new DeliveryError('Delivery queue is closed.', 'terminal');
  }

  private _startAttempt(entry: PendingEntry<TPayload>): Promise<DeliveryOutcome> {
    return this._own(() => this._attempt(entry));
  }

  private _own<T>(run: () => Promise<T>): Promise<T> {
    if (this._closed) return Promise.reject(new DeliveryError('Delivery queue is closed.', 'terminal'));
    // Register before invocation, including complete replay/restoration work.
    let resolve!: (outcome: T) => void;
    let reject!: (error: unknown) => void;
    const active = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
    this._active.add(active);
    void active.then(() => this._active.delete(active), () => this._active.delete(active));
    try { void run().then(resolve, reject); }
    catch (error) { reject(error); }
    return active;
  }

  private async _attempt(entry: PendingEntry<TPayload>): Promise<DeliveryOutcome> {
    entry.attempts += 1;
    this._totalAttempts += 1;
    this._tally(entry.channel).totalAttempts += 1;

    try {
      await entry.deliver();
      this._delivered += 1;
      this._tally(entry.channel).delivered += 1;
      this._pending.delete(entry.id);
      logger.debug('DeliveryQueue: delivered', {
        channel: entry.channel,
        event: entry.event,
        attempts: entry.attempts,
      });
      return 'delivered';
    } catch (err: unknown) {
      this._assertOpen();
      const errorMsg = this._describeError(err);
      const status = this._structuralDiagnostics ? deliveryHttpStatus(err) : undefined;
      const decided = deliveryTransience(err);
      // Structural queues retain no free-form detail.
      const transience: FailureTransience = this._structuralDiagnostics ? { ...decided, detail: '' } : decided;
      const { failureClass } = transience;

      if (failureClass === 'terminal' || entry.attempts > this._config.maxRetries) {
        return this._moveToDlq(entry, errorMsg, transience, status);
      }

      // Schedule retry
      const delayMs = this._computeDelay(entry.attempts);
      entry.nextAttemptAt = Date.now() + delayMs;
      this._retrying += 1;
      this._tally(entry.channel).retrying += 1;

      logger.warn('DeliveryQueue: retrying', {
        channel: entry.channel,
        event: entry.event,
        attempt: entry.attempts,
        maxRetries: this._config.maxRetries,
        delayMs,
        error: errorMsg,
        ...(status === undefined ? {} : { status }),
        failureClass,
        basis: transience.basis,
        ...(this._structuralDiagnostics ? {} : { reason: transience.detail }),
      });

      const timer = setTimeout(() => {
        this._timers.delete(entry.id);
        this._retrying = Math.max(0, this._retrying - 1);
        this._tally(entry.channel).retrying = Math.max(0, this._tally(entry.channel).retrying - 1);
        if (this._closed) return;
        void this._startAttempt(entry).catch((error: unknown) => {
          logger.warn('DeliveryQueue: retry attempt could not be settled', {
            channel: entry.channel,
            event: entry.event,
            error: this._describeError(error),
          });
        });
      }, delayMs);
      timer.unref?.();
      this._timers.set(entry.id, timer);

      return 'retrying';
    }
  }

  private _moveToDlq(
    entry: PendingEntry<TPayload>,
    finalError: string,
    transience: FailureTransience,
    status?: number,
  ): DeliveryOutcome {
    const { failureClass } = transience;
    const dlqEntry: DeadLetterEntry<TPayload> = {
      id: entry.id,
      channel: entry.channel,
      event: entry.event,
      ...(entry.target !== undefined ? { target: entry.target } : {}),
      payload: entry.payload,
      createdAt: entry.createdAt,
      deadAt: Date.now(),
      attempts: entry.attempts,
      finalError,
      failureClass,
      ...(this._structuralDiagnostics ? { basis: transience.basis, ...(status === undefined ? {} : { status }) } : {}),
    };

    this._retainDeadLetter(dlqEntry);
    this._pending.delete(entry.id);

    if (this._config.sloEnforced) {
      logger.error('DeliveryQueue: dead-lettered (SLO violated)', {
        id: dlqEntry.id,
        channel: dlqEntry.channel,
        event: dlqEntry.event,
        attempts: dlqEntry.attempts,
        finalError: dlqEntry.finalError,
        ...(dlqEntry.status === undefined ? {} : { status: dlqEntry.status }),
        failureClass: dlqEntry.failureClass,
        basis: transience.basis,
        ...(this._structuralDiagnostics ? {} : { reason: transience.detail }),
      });
    } else {
      logger.warn('DeliveryQueue: dead-lettered', {
        id: dlqEntry.id,
        channel: dlqEntry.channel,
        event: dlqEntry.event,
        attempts: dlqEntry.attempts,
        finalError: dlqEntry.finalError,
        ...(dlqEntry.status === undefined ? {} : { status: dlqEntry.status }),
        failureClass: dlqEntry.failureClass,
        basis: transience.basis,
        ...(this._structuralDiagnostics ? {} : { reason: transience.detail }),
      });
    }

    for (const listener of this._listeners) {
      try {
        listener(dlqEntry);
      } catch (err) {
        logger.warn('[delivery] listener error:', {
          error: this._describeError(err),
          entryId: dlqEntry.id,
        });
      }
    }

    return 'dead_letter';
  }

  private _retainDeadLetter(entry: DeadLetterEntry<TPayload>, write = true): void {
    // Bounded DLQ: evict oldest entry when limit exceeded.
    if (this._dlq.length >= this._config.maxDlqSize) {
      const evicted = this._dlq.shift();
      this._deadLettered = Math.max(0, this._deadLettered - 1);
      if (evicted) this._tally(evicted.channel).deadLettered = Math.max(0, this._tally(evicted.channel).deadLettered - 1);
    }
    this._dlq.push(entry);
    this._deadLettered += 1;
    this._tally(entry.channel).deadLettered += 1;
    if (!write) return;
    try {
      this._writeDeadLetters(this._dlq);
    } catch (error) {
      // A delivery that failed is not failed twice: the list in memory is still
      // right and replayable, and the next successful write carries this row.
      logger.warn('DeliveryQueue: the dead-letter file could not be written; failed notifications are kept in memory only until the next successful write', {
        error: summarizeError(error),
      });
    }
  }

  /** Write `list` as the dead-letter file, when there is one. Throws when the write fails. */
  private _writeDeadLetters(list: readonly DeadLetterEntry<TPayload>[]): void {
    const store = this._store;
    if (!store) return;
    const entries: StoredDeadLetter[] = [];
    for (const { payload, ...entry } of list) {
      let encoded: unknown;
      try { encoded = store.codec.encode(payload); } catch { encoded = undefined; }
      if (encoded !== undefined) entries.push({ ...entry, payload: encoded } as StoredDeadLetter);
    }
    writeDocument(store.path, { version: 1, entries }, { indent: null });
  }

  private _computeDelay(attempt: number): number {
    const exponential = this._config.initialDelayMs * Math.pow(2, attempt - 1);
    const jitter = randomInt(0, Math.max(1, Math.floor(this._config.initialDelayMs * 0.5) + 1));
    return Math.min(exponential + jitter, this._config.maxDelayMs);
  }
}

// ---------------------------------------------------------------------------
// Integration diagnostics queue status
// ---------------------------------------------------------------------------

/**
 * Snapshot of a DeliveryQueue for display in integration diagnostics.
 */
export interface IntegrationQueueStatus {
  /** Integration channel identifier. */
  readonly channel: string;
  /** Current delivery metrics. */
  readonly metrics: DeliveryMetrics;
  /** Dead-letter entries (most recent first, capped at 50 for display). */
  readonly dlqEntries: readonly DeadLetterEntry[];
  /** Whether SLO enforcement is active. */
  readonly sloEnforced: boolean;
  /** Epoch ms of this snapshot. */
  readonly capturedAt: number;
}

/**
 * Produce a diagnostics snapshot for a channel's DeliveryQueue.
 */
export function snapshotQueueStatus(
  channel: string,
  queue: DeliveryQueue,
  sloEnforced: boolean,
): IntegrationQueueStatus;
export function snapshotQueueStatus<TPayload>(
  channel: string,
  queue: DeliveryQueue<TPayload>,
  sloEnforced: boolean,
  describePayload: (payload: TPayload) => string,
): IntegrationQueueStatus;
export function snapshotQueueStatus<TPayload>(
  channel: string,
  queue: DeliveryQueue<TPayload>,
  sloEnforced: boolean,
  describePayload?: (payload: TPayload) => string,
): IntegrationQueueStatus {
  // One queue can serve several channels; each snapshot is that channel's share.
  const dlq = queue.getDlq().filter((entry) => entry.channel === channel);
  return {
    channel,
    metrics: queue.getMetrics(channel),
    // The target can be a URL that carries a secret topic or token; it is kept for replay only.
    dlqEntries: [...dlq].reverse().slice(0, 50).map(({ payload, target: _target, ...entry }) => ({
      ...entry,
      payload: describePayload ? describePayload(payload)
        : typeof payload === 'string' ? payload : 'Delivery payload unavailable',
    })),
    sloEnforced,
    capturedAt: Date.now(),
  };
}
