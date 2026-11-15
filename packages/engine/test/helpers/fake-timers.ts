import { spyOn } from 'bun:test';

/**
 * Runs `run` with setTimeout/clearTimeout replaced by a virtual clock that only
 * moves when the test calls `advance`. Synchronous on purpose: yielding to the
 * event loop with the globals replaced would hand them to unrelated code.
 */
export function withTimers(run: (advance: (ms: number) => void, pending: () => number) => void): void {
  let now = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  const setTimer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const handle = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    timers.set(handle, { at: now + delay, run: () => callback(...args) });
    return handle;
  }) as typeof setTimeout);
  const clearTimer = spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    timers.delete(handle as ReturnType<typeof setTimeout>);
  });
  try {
    run((ms) => {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        timers.delete(handle);
        timer.run();
      }
      now = target;
    }, () => timers.size);
  } finally {
    timers.clear();
    clearTimer.mockRestore();
    setTimer.mockRestore();
  }
}
