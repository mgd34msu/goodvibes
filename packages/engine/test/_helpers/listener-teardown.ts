/**
 * Quiesce an `HttpListener` without going through its async `stop()`.
 *
 * The listener's rate limiters own no timer any more, so this has nothing to
 * stop on a current listener; it stays a synchronous no-op hook for tests that
 * register it with `trackDisposables()`.
 */
interface RateLimiterLike {
  stop?(): void;
}

interface ListenerInternals {
  rateLimiter?: RateLimiterLike;
  loginRateLimiter?: RateLimiterLike;
}

export function stopListenerTimers(listener: unknown): void {
  if (listener === null || typeof listener !== 'object') return;
  const internals = listener as ListenerInternals;
  internals.rateLimiter?.stop?.();
  internals.loginRateLimiter?.stop?.();
}

/**
 * Full teardown for a listener that may or may not have been started.
 *
 * `stop()` closes the server when one was bound and clears the sweeps either
 * way; `stopListenerTimers` afterwards is belt-and-braces for a listener whose
 * stop() threw partway. Both are idempotent, so this is correct either way and
 * safe to call twice.
 */
export async function disposeListener(listener: unknown): Promise<void> {
  if (listener === null || typeof listener !== 'object') return;
  const stoppable = listener as { stop?(): Promise<void> | void };
  try {
    await stoppable.stop?.();
  } finally {
    stopListenerTimers(listener);
  }
}
