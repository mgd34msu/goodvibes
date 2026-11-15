/**
 * Holds every `setTimeout` made with one exact delay so a test fires it on
 * demand instead of racing the wall clock. Other timers (including
 * `setTimeout(0)` flushes) run normally. Pick a delay no other code uses.
 */
export interface HeldTimers {
  /** Runs every held callback that has not been cleared, in creation order. */
  fire(): void;
  /** Number of held timers that are still armed. */
  readonly armed: number;
  restore(): void;
}

export function holdTimers(delayMs: number): HeldTimers {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held = new Map<ReturnType<typeof setTimeout>, () => void>();
  const patch: { setTimeout: unknown; clearTimeout: unknown } = globalThis;
  patch.setTimeout = (handler: () => void, ms?: number) => {
    if (ms !== delayMs) return realSet(handler, ms);
    // A real far-future timer is the handle, so unref() and clearTimeout() keep working.
    const handle = realSet(() => {}, 2 ** 31 - 1);
    handle.unref?.();
    held.set(handle, handler);
    return handle;
  };
  patch.clearTimeout = (handle?: ReturnType<typeof setTimeout>) => {
    if (handle !== undefined) held.delete(handle);
    realClear(handle);
  };
  return {
    fire() {
      for (const [handle, handler] of [...held]) {
        held.delete(handle);
        realClear(handle);
        handler();
      }
    },
    get armed() { return held.size; },
    restore() {
      for (const handle of held.keys()) realClear(handle);
      held.clear();
      patch.setTimeout = realSet;
      patch.clearTimeout = realClear;
    },
  };
}
