import { randomInt } from 'node:crypto';
import { structuredTransience } from '@goodvibes-jev/engine/errors';
import { AppError } from '../types/errors.js';
import { summarizeError } from './error-display.js';
import { sleep } from './concurrency.js';

/** Configuration for retry behaviour with exponential backoff. */
export interface RetryConfig {
  /** Host-owned admission fence. A failure is final even if its error looks retryable. */
  beforeAttempt?: (() => void | Promise<void>) | undefined;
  /**
   * Host-owned veto asked after a retryable failure. Return false once the
   * attempt has already delivered output a consumer cannot take back (a streamed
   * delta, a sent HTTP chunk): the error is then final, because a second attempt
   * would deliver the answer again after the first one's text.
   */
  canRetry?: (() => boolean) | undefined;
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /**
   * Cancellation for the backoff between attempts.
   *
   * Without it the backoff is unreachable once armed: a caller that has been
   * cancelled, an agent killed, a turn abandoned, still sits out the full
   * wait, up to `maxDelayMs` per attempt, before it can even discover it was
   * cancelled. The wait is where nearly all of a failing retry's wall time
   * goes, so leaving it uncancellable made cancellation approximate.
   *
   * When it fires the sleep ends immediately and the last error is thrown,
   * which is what the surrounding code already does with a spent retry budget.
   */
  signal?: AbortSignal | undefined;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/** Type guard: checks if an unknown value has a numeric `statusCode` property. */
export function hasStatusCode(err: unknown): err is { statusCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as Record<string, unknown>).statusCode === 'number'
  );
}

/** Type guard: checks if an unknown value has a numeric `status` property. */
export function hasStatus(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number'
  );
}

/**
 * Determines whether an error should trigger a retry: what its structure says
 * (structuredTransience, the one owner of that answer): a recoverability its
 * creator stated, a Retry-After, the HTTP status (`status` or `statusCode`, on
 * any throwable), a connection-failure code, a timeout, its category. A
 * failure none of those places is not retried here.
 */
export function isRetryableError(error: unknown): boolean {
  return structuredTransience(error)?.failureClass === 'retryable';
}

/**
 * The longest wait a provider's own Retry-After is honoured for. A longer wait
 * is not slept through: the turn would look hung, so the error is surfaced with
 * its structured wait and the caller decides.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 60_000;

function retryAfterOf(err: unknown): number | undefined {
  if (!(err instanceof AppError)) return undefined;
  const wait = err.retryAfterMs;
  return typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? wait : undefined;
}

/** A spent account does not recover by retrying; the wait only delays the explanation. */
function isBillingFailure(err: unknown): boolean {
  return err instanceof AppError && (err.category === 'billing' || err.statusCode === 402);
}

function computeDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff: initialDelay * 2^attempt, with jitter
  const exponential = initialDelayMs * Math.pow(2, attempt);
  const jitter = randomInt(0, Math.max(1, Math.floor(initialDelayMs) + 1));
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Wraps an async function with retry logic using exponential backoff.
 * Retries when `isRetryableError` returns true for the thrown error.
 *
 * @param fn - Async function to execute.
 * @param config - Optional overrides for retry behaviour.
 * @param onRetry - Optional callback invoked before each retry. Argument order
 *   (attempt, maxAttempts, delayMs, error) matches `ChatRequest.onRetry` so
 *   providers can pass it straight through without an adapter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: Error) => void
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    // Outside the retry catch: denied/stale authority never spends transport retries.
    if (cfg.beforeAttempt) await cfg.beforeAttempt();
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(summarizeError(err));

      if (attempt === cfg.maxRetries) {
        break;
      }

      if (!isRetryableError(err) || isBillingFailure(err) || cfg.canRetry?.() === false) {
        throw lastError;
      }

      const retryAfterMs = retryAfterOf(err);
      if (retryAfterMs !== undefined && retryAfterMs > MAX_HONOURED_RETRY_AFTER_MS) {
        throw lastError;
      }

      // A cancelled caller does not get a retry, and does not get a backoff to
      // sit through before learning that.
      if (cfg.signal?.aborted) {
        throw lastError;
      }

      const backoffMs = computeDelay(attempt, cfg.initialDelayMs, cfg.maxDelayMs);
      const delayMs = retryAfterMs === undefined ? backoffMs : Math.max(backoffMs, retryAfterMs);
      onRetry?.(attempt + 1, cfg.maxRetries, delayMs, lastError);
      await sleep(delayMs, cfg.signal ? { signal: cfg.signal } : {});
      // sleep() resolves early on abort, so the wait ending is not by itself
      // permission to try again.
      if (cfg.signal?.aborted) {
        throw lastError;
      }
    }
  }

  throw lastError;
}
