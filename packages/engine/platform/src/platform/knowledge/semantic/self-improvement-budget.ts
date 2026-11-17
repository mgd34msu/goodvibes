import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';

/** Constructed by the owned timer, never inferred from an error message or name. */
export class KnowledgeRepairBudgetError extends Error {
  override readonly name = 'KnowledgeRepairBudgetError';
  constructor() { super('Semantic gap repair exhausted its run budget.'); }
}

/** A support hold that only the owned timer of a supporting pass constructs,
 * so a run-budget expiry is told apart from a `budget` hold raised elsewhere
 * by its class alone. */
export class KnowledgeSupportBudgetError extends KnowledgeGeneratedFactSupportHeldError {
  constructor() { super('budget'); }
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

/** How a budgeted run reports its own stop: what to throw when the timer
 * expires, and what to throw when the parent signal aborts. */
export interface RunBudgetErrors {
  readonly expired: () => unknown;
  readonly aborted?: ((parentReason: unknown) => unknown) | undefined;
}
const REPAIR_BUDGET_ERRORS: RunBudgetErrors = {
  expired: () => new KnowledgeRepairBudgetError(),
  aborted: (reason) => reason ?? new DOMException('Repair cancelled', 'AbortError'),
};
/** Supporting semantic passes (enrichment of a repair source, document readings)
 * stop with a support hold, which their callers already treat as final. */
export const SUPPORT_BUDGET_ERRORS: RunBudgetErrors = {
  expired: () => new KnowledgeSupportBudgetError(),
  aborted: () => new KnowledgeGeneratedFactSupportHeldError('aborted'),
};

/**
 * One owned timer cancels cooperative work and bounds uncooperative work.
 * `Infinity` (or a finite value too long for a timer) is the only "no bound";
 * zero, a negative value or NaN is a budget already spent, refused before the
 * work starts.
 */
export async function runWithBudget<T>(
  work: (signal: AbortSignal) => Promise<T>, remainingMs: number, parent?: AbortSignal, errors: RunBudgetErrors = REPAIR_BUDGET_ERRORS,
): Promise<T> {
  const aborted = () => errors.aborted ? errors.aborted(parent?.reason) : parent?.reason ?? new DOMException('Run cancelled', 'AbortError');
  if (parent?.aborted) throw aborted();
  remainingMs = timerBudgetMs(remainingMs);
  if (!(remainingMs > 0)) throw errors.expired();
  const controller = new AbortController();
  let rejectStop: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  // Settle the owned cause before cooperative abort handlers can substitute
  // their generic cancellation error for the timer that stopped the run.
  const stop = (error: unknown) => { rejectStop(error); controller.abort(error); };
  const abort = () => stop(aborted());
  parent?.addEventListener('abort', abort, { once: true });
  const timer = Number.isFinite(remainingMs) ? setTimeout(() => stop(errors.expired()), remainingMs) : undefined;
  timer?.unref?.();
  try {
    return await Promise.race([stopped, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}
