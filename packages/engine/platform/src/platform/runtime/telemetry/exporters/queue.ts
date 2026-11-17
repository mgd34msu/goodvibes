/**
 * Fail-safe, bounded export queue with exponential-backoff retry.
 *
 * Guarantees:
 * - Never blocks the caller, all export work is dequeued asynchronously.
 * - Never throws, all errors are caught and logged.
 * - Drops oldest entries when full (back-pressure relief).
 * - Shutdown drain waits up to the configured timeout before returning, and
 *   cuts short any retry wait in progress.
 * - Remembers the endpoint's state: once a batch fails after all its retries
 *   the endpoint is down, the following batches are tried once each with no
 *   retry, and the change is logged once each way (down, then recovered).
 */
import { randomInt } from 'node:crypto';
import type { ReadableSpan } from '../types.js';
import type {
  ExportQueueConfig,
  ExportResult,
  ExportResultCallback,
  ExportFn,
  RetryConfig,
} from './types.js';
import { DEFAULT_QUEUE_CONFIG } from './types.js';
import { summarizeError } from '../../../utils/error-display.js';
import { logger } from '../../../utils/logger.js';
import { sleep } from '../../../utils/concurrency.js';

/** Entry held in the ring buffer. */
interface QueueEntry {
  readonly batch: ReadableSpan[];
  readonly enqueuedAt: number;
}

/**
 * Computes the delay in milliseconds for a given retry attempt using
 * exponential backoff with jitter (±10%).
 */
function computeDelay(attempt: number, config: RetryConfig): number {
  const base = config.baseDelayMs * Math.pow(config.backoffFactor, attempt);
  const capped = Math.min(base, config.maxDelayMs);
  // Add ±10% jitter to avoid thundering-herd
  const jitterWindow = Math.max(1, Math.floor(capped * 0.1));
  const jitter = randomInt(-jitterWindow, jitterWindow + 1);
  return Math.max(0, Math.round(capped + jitter));
}



/**
 * Bounded in-memory export queue with retry and overflow protection.
 *
 * @example
 * ```ts
 * const queue = new ExportQueue(
 *   async (batch) => {
 *     await fetch('http://localhost:4318/v1/traces', {
 *       method: 'POST',
 *       body: JSON.stringify(batch),
 *     });
 *   },
 *   { maxSize: 64, drainTimeoutMs: 3000, retry: { maxRetries: 2, baseDelayMs: 50, backoffFactor: 2, maxDelayMs: 1000 } },
 * );
 *
 * queue.enqueue(spans);
 * await queue.drain();
 * ```
 */
export class ExportQueue {
  private readonly _config: ExportQueueConfig;
  private readonly _exportFn: ExportFn<ReadableSpan>;
  private readonly _onResult?: ExportResultCallback | undefined;

  /** Ring buffer holding pending batches. */
  private readonly _ring: Array<QueueEntry | undefined>;
  private _head = 0;
  private _tail = 0;
  private _size = 0;

  /** True while a drain loop is running. */
  private _draining = false;
  /** True after shutdown() is called, no new enqueues accepted. */
  private _shutdown = false;
  /** Aborted by shutdown() so a retry wait does not hold the exit. */
  private readonly _stopRetries = new AbortController();
  /** A batch failed after all its retries and none has succeeded since. */
  private _endpointDown = false;
  /** Batches lost (failed or dropped) since the endpoint went down. */
  private _lostWhileDown = 0;
  /** Overflow is logged once until the queue empties again. */
  private _overflowLogged = false;

  /**
   * @param exportFn - The actual export implementation. Must not throw.
   * @param config - Queue configuration. Merged with defaults.
   * @param onResult - Optional callback invoked after each export attempt.
   */
  constructor(
    exportFn: ExportFn<ReadableSpan>,
    config?: Partial<ExportQueueConfig>,
    onResult?: ExportResultCallback,
  ) {
    this._config = {
      ...DEFAULT_QUEUE_CONFIG,
      ...config,
      retry: { ...DEFAULT_QUEUE_CONFIG.retry, ...config?.retry },
    };
    this._exportFn = exportFn;
    this._onResult = onResult;
    this._ring = new Array<QueueEntry | undefined>(this._config.maxSize);
  }

  /** Number of batches currently in the queue. */
  get size(): number {
    return this._size;
  }

  /** Whether the queue is currently draining. */
  get draining(): boolean {
    return this._draining;
  }

  /** Whether the endpoint is down: the last batch tried failed after its retries. */
  get endpointDown(): boolean {
    return this._endpointDown;
  }

  /**
   * Enqueue a batch of spans for export.
   *
   * - If the queue is full, the oldest entry is dropped to make room.
   * - Starts the drain loop if not already running.
   * - No-op after shutdown().
   */
  enqueue(batch: ReadableSpan[]): void {
    if (this._shutdown) return;
    if (batch.length === 0) return;

    if (this._size >= this._config.maxSize) {
      // Drop oldest, advance head
      const dropped = this._ring[this._head];
      this._head = (this._head + 1) % this._config.maxSize;
      this._size--;
      if (dropped) {
        if (this._endpointDown) this._lostWhileDown++;
        this._emitResult({
          code: 'dropped',
          spanCount: dropped.batch.length,
          attempts: 0,
          endpoint: this._endpointDown ? 'down' : 'up',
          completedAt: Date.now(),
        });
      }
      if (!this._overflowLogged) {
        this._overflowLogged = true;
        logger.warn('[ExportQueue] Queue full, dropping the oldest batches until it drains', { maxSize: this._config.maxSize });
      }
    }

    this._ring[this._tail] = { batch, enqueuedAt: Date.now() };
    this._tail = (this._tail + 1) % this._config.maxSize;
    this._size++;

    this._startDrainLoop();
  }

  /**
   * Wait until no queued entries remain and no batch is still being exported,
   * or drainTimeoutMs elapses. A batch leaves the ring before its export
   * runs, so an empty ring alone does not mean the last spans were sent.
   */
  async drain(): Promise<void> {
    if (this._size === 0 && !this._draining) return;

    const deadline = Date.now() + this._config.drainTimeoutMs;
    while ((this._size > 0 || this._draining) && Date.now() < deadline) {
      await sleep(10);
    }
    if (this._size > 0 || this._draining) {
      logger.warn('[ExportQueue] Drain timed out with batches still queued or exporting', {
        remainingBatches: this._size,
        exporting: this._draining,
        drainTimeoutMs: this._config.drainTimeoutMs,
      });
    }
  }

  /**
   * Stop accepting new entries and drain remaining batches.
   * Returns after drain completes or drainTimeoutMs elapses.
   */
  async shutdown(): Promise<void> {
    this._shutdown = true;
    this._stopRetries.abort();
    await this.drain();
  }

  // ── Private drain loop ───────────────────────────────────────────────────

  /** Starts the async drain loop if not already running. */
  private _startDrainLoop(): void {
    if (this._draining) return;
    this._draining = true;
    // _drainLoop clears _draining in its own finally (and may already have
    // restarted itself), so the failure handler must not touch the flag.
    void this._drainLoop().catch((error: unknown) => {
      logger.error('[ExportQueue] Drain loop failed outside batch processing', {
        error: summarizeError(error),
      });
    });
  }

  /** Continuously drains entries until the queue is empty. */
  private async _drainLoop(): Promise<void> {
    try {
      while (this._size > 0) {
        const entry = this._dequeue();
        if (entry === undefined) break;
        await this._processEntry(entry);
      }
    } finally {
      this._draining = false;
      if (this._size === 0) this._overflowLogged = false;
      // If more entries arrived during the final iteration, restart
      if (this._size > 0) {
        this._startDrainLoop();
      }
    }
  }

  /** Dequeues and returns the oldest entry, or undefined if empty. */
  private _dequeue(): QueueEntry | undefined {
    if (this._size === 0) return undefined;
    const entry = this._ring[this._head];
    this._ring[this._head] = undefined;
    this._head = (this._head + 1) % this._config.maxSize;
    this._size--;
    return entry;
  }

  /**
   * Attempts to export a single batch, with retry/backoff while the endpoint
   * is up and a single try while it is down. Never throws.
   */
  private async _processEntry(entry: QueueEntry): Promise<void> {
    const maxRetries = this._endpointDown ? 0 : this._config.retry.maxRetries;
    let lastError: string | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++;
      try {
        await this._exportFn(entry.batch);
        if (this._endpointDown) {
          logger.info('[ExportQueue] Export endpoint reachable again', { batchesLost: this._lostWhileDown });
          this._endpointDown = false;
          this._lostWhileDown = 0;
        }
        this._emitResult({
          code: 'success',
          spanCount: entry.batch.length,
          attempts,
          endpoint: 'up',
          completedAt: Date.now(),
        });
        return;
      } catch (err) {
        lastError = summarizeError(err);
        if (attempt < maxRetries && !this._stopRetries.signal.aborted) {
          const delay = computeDelay(attempt, this._config.retry);
          logger.debug('[ExportQueue] Export attempt failed, retrying', { attempt: attempts, delayMs: delay, error: lastError });
          await sleep(delay, { signal: this._stopRetries.signal });
        }
        // A shutdown during the wait ends this batch's retries: exit does not wait on a dead endpoint.
        if (this._stopRetries.signal.aborted) break;
      }
    }

    if (!this._endpointDown) {
      this._endpointDown = true;
      logger.warn('[ExportQueue] Export endpoint unreachable; spans are dropped and each later batch is tried once until one succeeds', {
        attempts,
        spanCount: entry.batch.length,
        error: lastError,
      });
    }
    this._lostWhileDown++;
    this._emitResult({
      code: 'failure',
      spanCount: entry.batch.length,
      attempts,
      endpoint: 'down',
      error: lastError,
      completedAt: Date.now(),
    });
  }

  /** Safely invokes the result callback without throwing. */
  private _emitResult(result: ExportResult): void {
    if (this._onResult === undefined) return;
    try {
      this._onResult(result);
    } catch (error) {
      logger.warn('[ExportQueue] Result callback failed', {
        error: summarizeError(error),
      });
    }
  }
}
