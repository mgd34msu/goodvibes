/**
 * Scheduling for the tool calls of one assistant turn: consecutive parallel-safe
 * calls run together (bounded), every other call is a barrier that runs alone
 * after everything before it has finished.
 */

/** At most this many calls of one turn are in flight at once. */
export const MAX_PARALLEL_TOOL_CALLS = 4;

/** Split a turn's calls into groups: a run of parallel-safe calls, or one call that must run alone. */
export function groupToolCalls<C>(calls: readonly C[], isParallelSafe: (call: C) => boolean): C[][] {
  const groups: C[][] = [];
  let open: C[] | undefined;
  for (const call of calls) {
    if (!isParallelSafe(call)) { groups.push([call]); open = undefined; continue; }
    if (!open) { open = []; groups.push(open); }
    open.push(call);
  }
  return groups;
}

/**
 * Run `work` over `items` with at most `limit` in flight, starting them in order.
 * If any item throws, nothing further is started, the shared `abort` is called so
 * the in-flight siblings wind down through their own abort path, and every item
 * already started is awaited before the first error is rethrown: nothing is left
 * running untracked and nothing settles after this returns.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  abort: () => void,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await work(items[index] as T, index); }
      catch (error) {
        if (!failed) { failed = true; firstError = error; abort(); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failed) throw firstError;
}

/**
 * Serialises the owner-facing permission step of concurrent calls so two asks
 * never interleave. Waiters give up when their signal aborts; the lock is
 * passed on only once the holder ahead of them has finished.
 */
export function createAdmissionLock(): <R>(signal: AbortSignal | undefined, work: () => Promise<R>) => Promise<R> {
  let tail: Promise<void> = Promise.resolve();
  return async <R>(signal: AbortSignal | undefined, work: () => Promise<R>): Promise<R> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
        const onAbort = (): void => reject(signal?.reason ?? new Error('aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        previous.then(() => { signal?.removeEventListener('abort', onAbort); resolve(); });
      });
    } catch (error) {
      void previous.then(release);
      throw error;
    }
    try { return await work(); } finally { release(); }
  };
}
