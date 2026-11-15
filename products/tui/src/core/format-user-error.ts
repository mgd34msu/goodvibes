/**
 * Error meaning and wording belong to the public routing reader. The product
 * owns only delivery: a bounded ordered queue that cannot outlive its caller.
 */
import { readUserFacingError, type UserFacingError } from '@goodvibes-jev/engine/platform/platform/routing';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

export { readUserFacingError, readUserFacingErrorLine } from '@goodvibes-jev/engine/platform/platform/routing';
export type { ErrorClass, UserFacingError } from '@goodvibes-jev/engine/platform/platform/routing';

/** A deadline limits narration latency, never decides what an error means. */
export const ERROR_NOTICE_TIMEOUT_MS = 1500;
export function unavailableErrorLine(error: unknown): string {
  return `Error details unavailable. Original error: ${summarizeError(error)}`;
}
export function userErrorLine(reading: UserFacingError): string {
  return `${reading.message} ${reading.action}`;
}

interface NoticeDelivery {
  readonly isCurrent: () => boolean;
  readonly deliver: (reading: UserFacingError | null) => void;
  readonly discard?: () => void;
  /** Related narration joins this same queue/deadline; it never runs after delivery. */
  readonly prepare?: (signal: AbortSignal) => Promise<void>;
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
  errorReady: boolean;
  preparationReady: boolean;
  readonly controller: AbortController;
  reading: UserFacingError | null;
}

/**
 * Start reads together, deliver in arrival order. Cancel/close clears timers
 * and releases delivery closures immediately, including a reader that never
 * settles (the shared public reader has no AbortSignal parameter). Both reader
 * and delivery failures are contained here, never unhandled rejections.
 * `null` explicitly means unavailable interpretation; there is no classifier
 * fallback and no fabricated generic reading.
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
    item.controller.abort();
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
      const item: PendingNotice = {
        delivery, timer: undefined, ready: false, reading: null,
        errorReady: false, preparationReady: delivery.prepare === undefined,
        controller: new AbortController(),
      };
      pending.push(item);
      const update = (): void => {
        if (!item.delivery || item.ready) return;
        if (!item.errorReady || !item.preparationReady) return;
        item.ready = true;
        if (item.timer !== undefined) timers.clearTimeout(item.timer);
        flush();
      };
      const settleError = (reading: UserFacingError | null): void => {
        if (!item.delivery || item.ready) return;
        item.reading = reading; item.errorReady = true; update();
      };
      const settlePreparation = (): void => {
        if (!item.delivery || item.ready) return;
        item.preparationReady = true; update();
      };
      item.timer = timers.setTimeout(() => {
        if (!item.delivery || item.ready) return;
        // Preserve an error already read successfully if only setup facts stalled.
        item.controller.abort(); item.ready = true; flush();
      }, timeoutMs);
      void readUserFacingError(error, site).then(settleError, () => settleError(null));
      if (delivery.prepare) void Promise.resolve().then(() => {
        if (!item.controller.signal.aborted) return item.delivery?.prepare?.(item.controller.signal);
      }).then(settlePreparation, settlePreparation);
    },
    cancel,
    dispose(): void { closed = true; cancel(); },
  };
}
