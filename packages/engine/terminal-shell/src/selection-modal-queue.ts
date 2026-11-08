/** One picker queue per terminal input owner. Overlapping requests settle FIFO;
 * shutdown cancels both active and queued owners. Drain on a microtask because
 * input dispatch writes its callback slot back after invoking the chosen action.
 */
import type { SelectionItem, SelectionResult, SelectionModal, SelectionOpenOptions } from './selection-modal.js';

export type SelectionModalCallback = (result: SelectionResult | null) => void;

export type SelectionOpenOpts = SelectionOpenOptions;

export interface PendingSelectionRequest {
  readonly title: string;
  readonly items: SelectionItem[];
  readonly opts: SelectionOpenOpts | undefined;
  readonly callback: SelectionModalCallback;
}

/**
 * Maximum number of openSelection() calls held while one is already showing.
 * In practice at most two calls ever race in production (the liveness-confirm
 * modal vs. the recovery offer's 0ms macrotask), so 8 is generous headroom
 * for any future chained-picker sequence without letting a misbehaving
 * caller queue without bound. Once full, the overflowing call is resolved
 * with `null` immediately, a bounded queue must still give every caller a
 * definite answer, never silently drop one.
 */
export const MAX_QUEUED_SELECTIONS = 8;

/** Dependencies the queue needs from InputHandler, kept minimal and explicit. */
export interface SelectionQueueHost {
  readonly selectionModal: Pick<SelectionModal, 'active' | 'open' | 'close'>;
  /** Assigns InputHandler.selectionCallback (the live resolution slot). */
  setSelectionCallback(callback: SelectionModalCallback | null): void;
  /** Mirrors the callback into the in-flight feed context, when a feed() call is in progress (no-op otherwise). */
  syncFeedSelectionCallback(callback: SelectionModalCallback | null): void;
  modalOpened(name: string): void;
  modalClosed?(name: string): void;
  requestRender(): void;
}

/** Owns the FIFO of pending openSelection() requests for one InputHandler instance. */
export class SelectionModalQueue {
  private readonly pending: PendingSelectionRequest[] = [];
  private active: PendingSelectionRequest | undefined;
  private readonly cancellations = new Map<PendingSelectionRequest, () => void>();
  private closed = false;

  constructor(private readonly host: SelectionQueueHost) {}

  /** Number of requests currently queued (excludes whichever modal is actively showing, if any). */
  public get size(): number {
    return this.pending.length;
  }

  /**
   * Open `request` immediately if no selection modal is currently showing;
   * otherwise queue it FIFO. If the queue is already at MAX_QUEUED_SELECTIONS,
   * the request is resolved with `null` right away instead of being queued.
   */
  public request(request: PendingSelectionRequest): void {
    if (this.closed || request.opts?.signal?.aborted) { request.callback(null); return; }
    if (this.active || this.host.selectionModal.active) {
      if (this.pending.length >= MAX_QUEUED_SELECTIONS) {
        request.callback(null);
        return;
      }
      this.pending.push(request);
      this.watchCancellation(request);
      return;
    }
    this.watchCancellation(request);
    this.openNow(request);
  }

  private watchCancellation(request: PendingSelectionRequest): void {
    const signal = request.opts?.signal;
    if (!signal) return;
    const cancel = () => {
      const index = this.pending.indexOf(request);
      if (index >= 0) this.pending.splice(index, 1);
      else if (this.active !== request) return;
      this.unwatch(request);
      if (this.active === request) {
        this.active = undefined;
        this.host.setSelectionCallback(null);
        this.host.syncFeedSelectionCallback(null);
        this.host.selectionModal.close();
        this.host.modalClosed?.('selection');
      }
      try { request.callback(null); }
      finally { queueMicrotask(() => this.drain()); this.host.requestRender(); }
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.cancellations.set(request, () => signal.removeEventListener('abort', cancel));
  }

  private unwatch(request: PendingSelectionRequest): void {
    this.cancellations.get(request)?.();
    this.cancellations.delete(request);
  }

  /**
   * Resolve every still-queued request with `null`. Active picker ownership
   * remains intact; close() additionally stops admission and cancels it.
   */
  public clear(): void {
    const errors: unknown[] = [];
    for (const request of this.pending.splice(0)) {
      this.unwatch(request);
      try { request.callback(null); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Selection callbacks failed during cancellation');
  }

  /** Stop admission before callbacks run, and resolve the active owner too.
   * Old or reentrant callbacks cannot reopen a picker after terminal exit. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    this.active = undefined;
    if (active) this.unwatch(active);
    const errors: unknown[] = [];
    for (const cleanup of [
      () => this.host.setSelectionCallback(null),
      () => this.host.syncFeedSelectionCallback(null),
      () => this.host.selectionModal.close(),
      () => this.host.modalClosed?.('selection'),
      () => active?.callback(null),
      () => this.clear(),
    ]) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Selection callbacks failed during terminal close');
  }

  private openNow(request: PendingSelectionRequest): void {
    if (request.opts?.signal?.aborted) {
      this.unwatch(request); request.callback(null); queueMicrotask(() => this.drain()); return;
    }
    this.active = request;
    const wrapped: SelectionModalCallback = (result) => {
      if (this.closed || this.active !== request) return;
      const terminal = result === null || !['toggle', 'increment', 'decrement'].includes(result.action);
      if (terminal) { this.active = undefined; this.unwatch(request); }
      try { request.callback(result); }
      finally {
        if (terminal && !this.host.selectionModal.active) queueMicrotask(() => this.drain());
      }
    };
    this.host.modalOpened('selection');
    if (this.active !== request) return;
    this.host.selectionModal.open(request.title, request.items, request.opts);
    if (this.active !== request) return;
    this.host.setSelectionCallback(wrapped);
    this.host.syncFeedSelectionCallback(wrapped);
    this.host.requestRender();
  }

  private drain(): void {
    // Something else already opened a modal in the meantime (e.g. a
    // synchronously chained openSelection call from inside the resolving
    // callback), leave the queue alone; that modal's own resolution will
    // drain it in turn.
    if (this.closed || this.active || this.host.selectionModal.active) return;
    const next = this.pending.shift();
    if (!next) return;
    this.openNow(next);
  }
}

/** InputHandler's actual field/method shape, satisfies this structurally, no import needed. */
export interface SelectionQueueOwner {
  readonly selectionModal: Pick<SelectionModal, 'active' | 'open' | 'close'>;
  readonly modalStack?: string[];
  selectionCallback: SelectionModalCallback | null;
  syncFeedSelectionCallback: ((callback: SelectionModalCallback | null) => void) | null;
  modalOpened(name: string): void;
  requestRender(): void;
  exitApp: () => void;
}

/**
 * Builds the queue for one InputHandler and wires teardown: wraps
 * `owner.exitApp` (the one path guaranteed to run when the handler is torn
 * down) so active and queued selection requests resolve with `null`
 * instead of being left pending. Keeps this bookkeeping out of handler.ts,
 * which only needs `this.selectionQueue = attachSelectionModalQueue(this);`.
 */
export function attachSelectionModalQueue(owner: SelectionQueueOwner): SelectionModalQueue {
  const queue = new SelectionModalQueue({
    selectionModal: owner.selectionModal,
    setSelectionCallback: (callback) => { owner.selectionCallback = callback; },
    syncFeedSelectionCallback: (callback) => { owner.syncFeedSelectionCallback?.(callback); },
    modalOpened: (name) => owner.modalOpened(name),
    modalClosed: (name) => {
      const index = owner.modalStack?.lastIndexOf(name) ?? -1;
      if (index >= 0) owner.modalStack?.splice(index, 1);
    },
    requestRender: () => owner.requestRender(),
  });
  const suppliedExitApp = owner.exitApp;
  owner.exitApp = () => {
    try { queue.close(); } finally { suppliedExitApp(); }
  };
  return queue;
}
