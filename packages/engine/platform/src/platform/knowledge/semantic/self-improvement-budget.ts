/** Constructed by the owned timer, never inferred from an error message or name. */
export class KnowledgeRepairBudgetError extends Error {
  override readonly name = 'KnowledgeRepairBudgetError';
  constructor() { super('Semantic gap repair exhausted its run budget.'); }
}

/** The longest delay a timer honours; `setTimeout` clamps anything longer to 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * One rule for every run budget: a finite budget too long for a timer is no
 * budget at all, so it never becomes a 1 ms timer that kills the work at once.
 */
export function timerBudgetMs(ms: number): number {
  return Number.isFinite(ms) && ms > MAX_TIMER_MS ? Infinity : ms;
}

/**
 * Upper bound for one judgment-reading batch when its caller gives no deadline.
 * A hung judgment port would otherwise hold a background run forever; a caller
 * that wants no bound passes `timeoutMs: 0` explicitly.
 */
export const REPAIR_READER_DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** One owned timer cancels cooperative repairers and bounds uncooperative ones. */
export async function runWithRepairBudget<T>(work: (signal: AbortSignal) => Promise<T>, remainingMs: number, parent?: AbortSignal): Promise<T> {
  remainingMs = timerBudgetMs(remainingMs);
  const controller = new AbortController();
  let rejectStop: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const stop = (error: unknown) => { rejectStop(error); controller.abort(error); };
  const abort = () => stop(parent?.reason ?? new DOMException('Repair cancelled', 'AbortError'));
  parent?.addEventListener('abort', abort, { once: true });
  const timer = Number.isFinite(remainingMs) ? setTimeout(() => stop(new KnowledgeRepairBudgetError()), Math.max(1, remainingMs)) : undefined;
  timer?.unref?.();
  try {
    if (parent?.aborted) { abort(); return await stopped; }
    return await Promise.race([stopped, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}
