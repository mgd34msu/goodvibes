/**
 * Error meaning and wording belong to the public routing reader. The product
 * owns only delivery: a bounded ordered queue that cannot outlive its caller.
 */
import { describeUserError, readUserFacingError, type UserFacingError } from '@goodvibes/engine/platform/platform/routing';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

export { readUserFacingError, readUserFacingErrorLine } from '@goodvibes/engine/platform/platform/routing';
export type { ErrorClass, UserFacingError } from '@goodvibes/engine/platform/platform/routing';

/** A deadline limits narration latency; past it the line structure fixes is shown. */
export const ERROR_NOTICE_TIMEOUT_MS = 1500;
export function unavailableErrorLine(error: unknown): string {
  return `Error details unavailable. Original error: ${summarizeError(error)}`;
}
export function userErrorLine(reading: UserFacingError): string {
  return `${reading.message} ${reading.action}`;
}

interface NoticeDelivery {
  readonly isCurrent: () => boolean;
  /** Always given a line: the reading, or the line structure fixes when the reading missed its deadline or failed. */
  readonly deliver: (reading: UserFacingError) => void;
  readonly discard?: () => void;
}
/** Deadline timers; tests substitute their own so the deadline needs no real waiting. */
export interface ErrorNoticeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: ErrorNoticeTimers = {
  setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
interface PendingNotice {
  delivery: NoticeDelivery | undefined;
  timer: unknown;
  ready: boolean;
  /** The structural line until a reading replaces it. */
  reading: UserFacingError;
}

/**
 * Start reads together, deliver in arrival order. Cancel/close clears timers
 * and releases delivery closures immediately, including a reader that never
 * settles (the shared public reader has no AbortSignal parameter). Both reader
 * and delivery failures are contained here, never unhandled rejections.
 * A reading that misses the deadline or fails is replaced by the line the
 * error's status and errno fix on their own (`describeUserError` without a
 * reading), so what code already knows is never thrown away.
 */
export function createErrorNoticeOwner(timeoutMs = ERROR_NOTICE_TIMEOUT_MS, timers: ErrorNoticeTimers = realTimers) {
  const pending: PendingNotice[] = [];
  let closed = false;
  const safely = (work: () => void): void => {
    try { work(); } catch (error) {
      try { logger.debug('Error notice delivery failed', { error: summarizeError(error) }); } catch { /* diagnostics cannot recurse */ }
    }
  };
  const release = (item: PendingNotice): NoticeDelivery | undefined => {
    if (item.timer !== undefined) timers.clearTimeout(item.timer);
    const delivery = item.delivery;
    item.delivery = undefined;
    item.timer = undefined;
    return delivery;
  };
  const flush = (): void => {
    while (pending[0]?.ready) {
      const item = pending.shift()!;
      const delivery = release(item);
      if (delivery) safely(() => {
        if (!closed && delivery.isCurrent()) delivery.deliver(item.reading);
        else delivery.discard?.();
      });
    }
  };
  const cancel = (): void => {
    for (const item of pending.splice(0)) {
      const delivery = release(item);
      if (delivery?.discard) safely(delivery.discard);
    }
  };
  return {
    enqueue(error: unknown, site: string, delivery: NoticeDelivery): void {
      if (closed) { if (delivery.discard) safely(delivery.discard); return; }
      const item: PendingNotice = { delivery, timer: undefined, ready: false, reading: describeUserError(error) };
      pending.push(item);
      const settle = (reading: UserFacingError): void => {
        if (!item.delivery || item.ready) return;
        item.reading = reading;
        item.ready = true;
        flush();
      };
      item.timer = timers.setTimeout(() => settle(item.reading), timeoutMs);
      void readUserFacingError(error, site).then(settle, () => settle(item.reading));
    },
    cancel,
    dispose(): void { closed = true; cancel(); },
  };
}
