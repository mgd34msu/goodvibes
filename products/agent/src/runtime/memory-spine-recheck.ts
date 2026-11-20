import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** The cadence used when `watchers.heartbeatIntervalMs` is unset or not a usable number. */
export const MEMORY_SPINE_RECHECK_DEFAULT_MS = 30_000;
/** A floor so a tiny configured value cannot turn the reachability probe into a hot loop. */
export const MEMORY_SPINE_RECHECK_MIN_MS = 1_000;

/** Interval for the reachability recheck: the configured value when finite, floored; the default otherwise. */
export function resolveMemorySpineRecheckMs(configured: unknown): number {
  const value = typeof configured === 'number' ? configured : typeof configured === 'string' && configured.trim() !== '' ? Number(configured) : NaN;
  if (!Number.isFinite(value)) return MEMORY_SPINE_RECHECK_DEFAULT_MS;
  return Math.max(MEMORY_SPINE_RECHECK_MIN_MS, value);
}

export interface MemorySpineRecheck {
  /** Arms the recurring recheck once; a no-op when already armed or after `take()`. */
  arm(): void;
  /** Disarms for good and returns the timer so the caller can clear it; a later `arm()` does nothing. */
  take(): ReturnType<typeof setInterval> | null;
}

/**
 * The recurring memory-spine reachability recheck. Arming happens inside a
 * deferred task that can resume after shutdown has already taken the timer, so
 * the latch lives here: once taken, nothing is armed again.
 */
export function createMemorySpineRecheck(options: {
  readonly intervalMs: () => number;
  readonly reconcile: () => Promise<unknown>;
  readonly setIntervalFn?: typeof setInterval;
}): MemorySpineRecheck {
  const schedule = options.setIntervalFn ?? setInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  return {
    arm(): void {
      if (closed || timer !== null) return;
      timer = schedule(() => {
        options.reconcile().catch((error: unknown) => {
          logger.debug('Memory-spine reachability recheck failed', { error: summarizeError(error) });
        });
      }, options.intervalMs());
      timer.unref?.();
    },
    take(): ReturnType<typeof setInterval> | null {
      closed = true;
      const taken = timer;
      timer = null;
      return taken;
    },
  };
}
