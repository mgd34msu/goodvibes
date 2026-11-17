/**
 * OTLP HTTP span exporter with fail-safe queue and retry.
 *
 * All exports are non-blocking, spans are enqueued immediately and
 * exported asynchronously. Export failures are logged but never thrown.
 * The runtime is never blocked by OTLP connectivity issues.
 *
 * Compatible with the OTLP/HTTP JSON format for traces (v1/traces).
 */
import type { ReadableSpan, SpanExporter } from '../types.js';
import type { OtlpConfig } from './types.js';
import { DEFAULT_OTLP_CONFIG, DEFAULT_QUEUE_CONFIG } from './types.js';
import { ExportQueue } from './queue.js';
import { logger } from '../../../utils/logger.js';
import { instrumentedFetch } from '../../../utils/fetch-with-timeout.js';
import { summarizeError } from '../../../utils/error-display.js';
import { buildOtlpTraceDocumentFromSpans } from '../api-helpers.js';

/** The same OTLP/JSON document the telemetry API serves, so both paths agree on kinds, parents and attributes. */
function serialiseSpans(spans: ReadableSpan[]): string {
  return JSON.stringify(buildOtlpTraceDocumentFromSpans(spans));
}

const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/**
 * Non-blocking OTLP/HTTP span exporter.
 *
 * Spans are batched and exported via an internal fail-safe queue.
 * The exporter never throws, failures are logged and retried per
 * the configured retry policy.
 *
 * @example
 * ```ts
 * const exporter = new OtlpExporter({
 *   endpoint: 'http://localhost:4318/v1/traces',
 *   batchSize: 256,
 *   timeoutMs: 8000,
 *   headers: { 'x-api-key': 'my-token' },
 * });
 * ```
 */
export class OtlpExporter implements SpanExporter {
  readonly name = 'otlp';

  private readonly _config: Required<Omit<OtlpConfig, 'queue' | 'retry' | 'headers' | 'onResult'>> & {
    readonly headers: Record<string, string>;
  };
  private readonly _queue: ExportQueue;
  private readonly _pending: ReadableSpan[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: OtlpConfig) {
    this._config = {
      endpoint: config.endpoint,
      batchSize: config.batchSize ?? DEFAULT_OTLP_CONFIG.batchSize,
      timeoutMs: config.timeoutMs ?? DEFAULT_OTLP_CONFIG.timeoutMs,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      headers: config.headers ?? {},
    };

    const queueConfig = {
      ...DEFAULT_QUEUE_CONFIG,
      ...config.queue,
      retry: {
        ...DEFAULT_QUEUE_CONFIG.retry,
        ...config.queue?.retry,
        ...config.retry,
      },
    };

    this._queue = new ExportQueue(
      (batch) => this._httpExport(batch),
      queueConfig,
      config.onResult,
    );
  }

  /** The collector this exporter sends to. */
  get endpoint(): string {
    return this._config.endpoint;
  }

  /** False while the collector is down (the last batch failed after its retries). */
  get reachable(): boolean {
    return !this._queue.endpointDown;
  }

  /**
   * Accept completed spans.
   *
   * Spans are accumulated into the pending buffer. When the buffer
   * reaches `batchSize`, a batch is enqueued for async export. A smaller
   * remainder is enqueued after `flushIntervalMs`, or on `flush()` or
   * `shutdown()`.
   *
   * Never throws.
   */
  async export(spans: ReadableSpan[]): Promise<void> {
    try {
      this._pending.push(...spans);
      while (this._pending.length >= this._config.batchSize) {
        const batch = this._pending.splice(0, this._config.batchSize);
        this._queue.enqueue(batch);
      }
      this._scheduleFlush();
    } catch (err) {
      // use structured logger, not console
      logger.error('[OtlpExporter] export() failed', { error: summarizeError(err) });
    }
  }

  /**
   * Flush any pending (unbatched) spans and wait for queue to drain.
   * Never throws.
   */
  async flush(): Promise<void> {
    try {
      this._enqueuePending();
      await this._queue.drain();
    } catch (err) {
      // use structured logger, not console
      logger.error('[OtlpExporter] flush() failed', { error: summarizeError(err) });
    }
  }

  /**
   * Flush remaining spans and shut down the export queue.
   * Waits up to drainTimeoutMs for pending queue entries to clear.
   * Never throws.
   */
  async shutdown(): Promise<void> {
    try {
      this._enqueuePending();
      await this._queue.shutdown();
    } catch (err) {
      // use structured logger, not console
      logger.error('[OtlpExporter] shutdown() failed', { error: summarizeError(err) });
    }
  }

  /** Hand every pending span to the queue and stop the pending timer. */
  private _enqueuePending(): void {
    if (this._flushTimer !== undefined) {
      clearTimeout(this._flushTimer);
      this._flushTimer = undefined;
    }
    if (this._pending.length > 0) {
      this._queue.enqueue(this._pending.splice(0));
    }
  }

  private _scheduleFlush(): void {
    if (this._pending.length === 0 || this._flushTimer !== undefined) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = undefined;
      try {
        this._enqueuePending();
      } catch (err) {
        logger.error('[OtlpExporter] timed flush failed', { error: summarizeError(err) });
      }
    }, this._config.flushIntervalMs);
    // Waiting spans must not keep an otherwise finished process alive.
    this._flushTimer.unref?.();
  }

  // ── Private HTTP transport ────────────────────────────────────────────────

  /**
   * Performs the actual HTTP POST to the OTLP endpoint.
   * Called exclusively by the ExportQueue, which records failures and retries.
   */
  private async _httpExport(batch: ReadableSpan[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this._config.timeoutMs,
    );
    timer.unref?.();

    try {
      const body = serialiseSpans(batch);
      const response = await instrumentedFetch(this._config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this._config.headers,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `OTLP endpoint returned HTTP ${response.status}: ${response.statusText}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
