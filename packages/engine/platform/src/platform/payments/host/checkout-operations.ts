/** Detached checkout ownership. Durable admission is an acknowledgement of one
 * operation, never a successful purchase. Actual work and its execution lease
 * outlive the request and remain drained by the registration owner. */
import { JudgmentError } from '@goodvibes/judgment';
import { DecisionModelsDisabledError, JudgmentPortMissingError } from '@goodvibes/engine/errors';
import { isDeepStrictEqual } from 'node:util';
import { AsyncResource } from 'node:async_hooks';
import { withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { OwnedScope } from '../../utils/owned-work.js';
import { logger } from '../../utils/logger.js';
import { CheckoutOwnershipError } from '../checkout-ownership.js';
import { CheckoutPageClaimedError, type CheckoutJournal, type CheckoutPhase, type InFlightCheckout } from '../checkout-registry.js';
import type { BeginCheckoutInput, PaymentBeginResult } from '../payments-gateway-service.js';
import { isLivePaymentOperation, paymentOperationDescription, purchaseDisposition, readPurchaseOutcome, unsubmittedEndState, type PaymentOperationLimit, type PaymentOperationState, type PaymentOperationView, type PaymentOperationCancellation } from '../operation-view.js';
import { sanitizeNoticeField } from '../../security/notice-text.js';
import type { PaymentStoreStop } from '../payment-host-health.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import { DurablePaymentOperations, PaymentOperationStoreError, checkoutRequestId, type PaymentOperationWriter } from './operation-store.js';
import type { PaymentUnreadableOperation } from '../window-view.js';
import type { DaemonPurchaseLedger } from './purchase-ledger.js';
import type { RetainedTaintEvidence } from '../../security/untrusted-content.js';
import type { PaymentRequestHostFacts, PaymentRequestStore, PaymentRequestVerdict, ProtectedPaymentRequest, RetireContinuation } from './protected-requests.js';
import type { NativeContinuationGrant } from '../../pairing/pairing-token-store.js';
import { capturePaymentContinuation } from './continuation-binding.js';
import { PaymentReplyWindowError, type PaymentReplyInbox } from '../reply-inbox.js';
import type { RetainedPaymentReplyHistory } from '../reply-history-owner.js';
import { paymentReplyHistoryBinding, type PaymentReplyHistory } from '../reply-history.js';
import { captureBrowserPageConnection, type BrowserPageConnection } from '../../browser/browser-page-connection-data.js';
import { captureBrowserCheckoutRecovery, type BrowserCheckoutRecovery } from '../../browser/browser-checkout-recovery-data.js';
import { captureCheckoutWindowCheckpoint, type CheckoutWindowCheckpoint } from '../checkout-window-checkpoint.js';

export interface DetachedCheckoutSource {
  readonly principalId: string;
  readonly assertCurrent: () => void;
  readonly taintEvidence?: RetainedTaintEvidence | undefined;
  readonly recoveryFacts?: Pick<PaymentRequestHostFacts, 'authority' | 'configuration'> | undefined;
  readonly issueContinuation?: ((operationId: string, assertCurrent: () => void) => NativeContinuationGrant) | undefined;
  readonly revokeContinuation?: ((grant: NativeContinuationGrant) => void | Promise<void>) | undefined;
  readonly capturePageConnection?: ((input: BeginCheckoutInput, owner: DetachedCheckoutOwner) => Promise<BrowserPageConnection | null>) | undefined;
  readonly captureBrowserRecovery?: ((input: BeginCheckoutInput, owner: DetachedCheckoutOwner) => Promise<BrowserCheckoutRecovery | null>) | undefined;
}
export interface DetachedCheckoutOwner {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly taintEvidence?: RetainedTaintEvidence | undefined;
  readonly retainWindowCheckpoint?: ((checkpoint: CheckoutWindowCheckpoint) => Promise<void>) | undefined;
  /** True only while the host is stopping and this window is durably saved as its journal record reads. */
  readonly keepWindowOnStop?: (() => boolean) | undefined;
  readonly readReplyHistory?: (() => Promise<PaymentReplyHistory | undefined>) | undefined;
}
interface ActiveOperation {
  readonly writer: PaymentOperationWriter;
  readonly abort: AbortController;
  readonly source: DetachedCheckoutSource;
  protectedRequest: boolean;
  continuation: NativeContinuationGrant | undefined;
  history?: RetainedPaymentReplyHistory | undefined;
  /** The owner asked to stop it; a host shutdown aborts the same signal. */
  cancelRequested: boolean;
  /** Admission was acknowledged and the checkout itself started. */
  launched: boolean;
  /** The window checkpoint's durable write is in flight; a stop waits for it. */
  saving: boolean;
  abortWhenSaved: boolean;
  /** The journal record the last durable checkpoint matches, while the journal still reads exactly that. */
  savedWindow: InFlightCheckout | undefined;
  /** A purchase notice reached the owner on some channel, so an unbought end is told to them too. */
  noticeDelivered: boolean;
  /** What the owner was told about, from the journal record, to name the purchase in a closing message. */
  subject: { readonly item: string; readonly merchantDomain: string } | undefined;
}
/** Host hooks for the end of a purchase. */
export interface CheckoutOperationHooks {
  /** Sends the owner one message on the payment notice channels. */
  readonly notify?: ((message: string) => Promise<void>) | undefined;
  /** Retires a continuation grant whose purchase can no longer use it. */
  readonly retire?: RetireContinuation | undefined;
}
export interface RecoveredCheckoutExecution {
  readonly source: DetachedCheckoutSource;
  readonly input: BeginCheckoutInput;
  execute(input: BeginCheckoutInput, id: string, owner: DetachedCheckoutOwner): Promise<PaymentBeginResult>;
  release(): Promise<void>;
}
export type CheckoutWindowRestorer = (request: ProtectedPaymentRequest, owner: DetachedCheckoutOwner) => Promise<RecoveredCheckoutExecution>;
interface PreparingRecovery {
  readonly writer: PaymentOperationWriter;
  readonly abort: AbortController;
  readonly request: ProtectedPaymentRequest;
  started: boolean;
  readonly releaseOriginalWindow: () => Promise<boolean>;
  history?: RetainedPaymentReplyHistory | undefined;
  cancelRequested: boolean;
}

/**
 * Every state a purchase operation can move to. Refused, cancelled and failed
 * are final: once one is recorded, later cleanup cannot relabel it, and in
 * particular cannot erase the `cancelled` outcome that stops a cancelled
 * window resuming after restart. `completed` moves only by an owner's
 * merchant-history reconciliation of an unverified submission.
 */
const operationLifecycle = defineLifecycle<PaymentOperationState>('purchase operation', {
  accepted: ['running', 'cancelling', 'completed', 'refused', 'cancelled', 'attention', 'interrupted', 'uncertain', 'failed'],
  running: ['running', 'cancelling', 'completed', 'refused', 'cancelled', 'attention', 'interrupted', 'uncertain', 'failed'],
  cancelling: ['cancelling', 'completed', 'refused', 'cancelled', 'attention', 'interrupted', 'uncertain', 'failed'],
  attention: ['attention', 'uncertain', 'completed'],
  uncertain: ['uncertain', 'interrupted', 'completed'],
  interrupted: ['interrupted', 'running', 'uncertain', 'refused', 'cancelled'],
  completed: ['completed', 'uncertain'],
  refused: [],
  cancelled: [],
  failed: [],
});

/** Recorded when a daemon stop, not the owner, ended a purchase before submission. */
const DAEMON_STOPPED = 'refused:daemon-stopped';

/** Status text is bounded; the full sentence went to the owner already. */
function clip(text: string): string { return text.length <= 4_000 ? text : `${text.slice(0, 3_999)}…`; }

function operationLimit(value: PaymentBeginResult['exceeded']): PaymentOperationLimit | undefined {
  if (!value) return undefined;
  return { limit: value.limit, ...(value.setting ? { setting: value.setting } : {}), availableMinorUnits: value.availableMinorUnits,
    neededMinorUnits: value.neededMinorUnits, excessMinorUnits: value.excessMinorUnits, unset: value.unset };
}

function mayHaveSubmitted(phase: CheckoutPhase | null | undefined): boolean {
  return phase === 'submit-pending' || phase === 'submitted';
}

/** Failures whose meaning holds whatever the journal says. */
function failureOutcome(error: unknown): string | null {
  if (error instanceof JudgmentPortMissingError || error instanceof JudgmentError && error.kind === 'unavailable') return 'decision-unavailable';
  if (error instanceof DecisionModelsDisabledError) return 'decision-disabled';
  if (!(error instanceof PaymentReplyWindowError)) return null;
  switch (error.kind) {
    case 'source-unavailable': return 'reply-source-unavailable';
    case 'receive-uncovered': return 'refused:receive-uncovered';
    case 'coverage-unrecorded': return 'refused:receive-unrecorded';
    case 'history-unavailable': return 'refused:reply-history-unavailable';
    default: return null;
  }
}

/** Why a purchase stopped before any submission, when the journal proves it never reached one. */
function stoppedOutcome(error: unknown): string | null {
  if (error instanceof PaymentReplyWindowError) {
    switch (error.kind) {
      case 'unsettled-reply': return 'refused:reply-unsettled';
      case 'reading-failed': return 'refused:reply-unreadable';
      case 'clock-unavailable': return 'refused:clock-unavailable';
      case 'invalid': case 'duplicate': case 'stale': return 'refused:window-unavailable';
      default: return null;
    }
  }
  if (error instanceof CheckoutPageClaimedError) return 'refused:page-in-use';
  return error instanceof CheckoutOwnershipError ? 'refused:owner-changed' : null;
}
function mismatchedOperation(id: string): PaymentOperationStoreError {
  return new PaymentOperationStoreError('invalid', `That operationId is not purchase ${id}'s current operation. Read payments.purchase.status for the operationId to stop.`);
}
function finishedOperation(operation: PaymentOperationView): PaymentOperationStoreError {
  return new PaymentOperationStoreError('invalid', `Purchase ${operation.purchaseId} is ${operation.state} and can no longer be stopped. ${paymentOperationDescription(operation)}`);
}

export class CheckoutOperations {
  // Constructed with the registration, before request dispatch. Background
  // work must not inherit a request's tool proof, signal or notice sink.
  private readonly execution = new AsyncResource('GoodVibesPaymentOperations', { requireManualDestroy: true });
  private readonly work = new OwnedScope('checkout operations');
  private readonly active = new Map<string, ActiveOperation>();
  /** Each launched operation's run, by purchase, until it has settled; `ended()` hands it out. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly preparingRecovery = new Map<string, PreparingRecovery>();
  private readonly errors: unknown[] = [];
  private closed = false;
  /** Set before anything is aborted, so a release point can tell a host stop from an owner cancel. */
  private stopping = false;
  private recovered = false;
  private readonly reserved = new Set<string>();
  private readonly requests: Pick<PaymentRequestStore, 'retain' | 'read' | 'remove' | 'checkpointWindow' | 'appendReply' | 'recordReceiveCoverage'> | undefined;
  private readonly history: Pick<PaymentReplyInbox, 'retainReplyHistory'> | undefined;
  private readonly captureReceiveSpans: PaymentReplyInbox['captureReceiveSpans'] | undefined;
  private closing: Promise<void> | undefined;
  private readonly notify: CheckoutOperationHooks['notify'];
  private readonly retire: CheckoutOperationHooks['retire'];
  private readonly discardRequest: PaymentRequestStore['discard'];
  private readonly sweepRequests: PaymentRequestStore['sweep'];
  constructor(private readonly store: DurablePaymentOperations, private readonly journal: CheckoutJournal,
    private readonly purchases: DaemonPurchaseLedger,
    private readonly execute: (input: BeginCheckoutInput, id: string, owner: DetachedCheckoutOwner) => Promise<PaymentBeginResult>,
    private readonly now: () => number = Date.now,
    requests?: PaymentRequestStore, replies?: Pick<PaymentReplyInbox, 'retainReplyHistory'> & Partial<Pick<PaymentReplyInbox, 'bindDurableOperationReader' | 'captureReceiveSpans'>>,
    hooks: CheckoutOperationHooks = {}) {
    this.notify = hooks.notify; this.retire = hooks.retire;
    this.discardRequest = requests?.discard?.bind(requests); this.sweepRequests = requests?.sweep?.bind(requests);
    // Retain the original host methods, rather than consulting a mutable
    // embed wrapper again after admission or during asynchronous cleanup.
    this.requests = requests ? Object.freeze({ retain: requests.retain.bind(requests), read: requests.read.bind(requests), remove: requests.remove.bind(requests),
      ...(requests.checkpointWindow ? { checkpointWindow: requests.checkpointWindow.bind(requests) } : {}),
      ...(requests.supportsReplyHistory && requests.appendReply ? { appendReply: requests.appendReply.bind(requests) } : {}),
      ...(requests.supportsReplyReceiveCoverage && requests.recordReceiveCoverage ? { recordReceiveCoverage: requests.recordReceiveCoverage.bind(requests) } : {}) }) : undefined;
    this.history = this.requests?.appendReply && replies ? Object.freeze({ retainReplyHistory: replies.retainReplyHistory.bind(replies) }) : undefined;
    this.captureReceiveSpans = requests?.supportsReplyReceiveSpans ? replies?.captureReceiveSpans?.bind(replies) : undefined;
    const readStatus = store.get.bind(store);
    replies?.bindDurableOperationReader?.(readStatus, () => { if (this.closed) throw new CheckoutOwnershipError(); });
  }

  private retainHistory(writer: PaymentOperationWriter, checkpoint: CheckoutWindowCheckpoint): RetainedPaymentReplyHistory | undefined {
    const append = this.requests?.appendReply; if (!this.history || !append) return undefined;
    const current = () => {
      if (this.closed || !(this.active.get(writer.purchaseId)?.writer === writer || this.preparingRecovery.get(writer.purchaseId)?.writer === writer)) throw new CheckoutOwnershipError();
      writer.assertCurrent();
    };
    const binding = paymentReplyHistoryBinding(checkpoint);
    const recordCoverage = this.requests?.recordReceiveCoverage;
    return this.history.retainReplyHistory(writer.purchaseId, checkpoint, (entry, receivedCurrent) => this.work.run('append', () =>
      append(writer.purchaseId, writer.read().operationId, binding, entry, () => { current(); receivedCurrent(); })), current,
      recordCoverage ? (coverage, receivedCurrent) => this.work.run('record coverage', () => recordCoverage(writer.purchaseId, writer.read().operationId,
        binding, coverage, () => { current(); receivedCurrent(); })) : undefined);
  }

  /** Take actual execution leases before the conservative journal sweep.
   * Reading a checkpoint does not start a model, browser or merchant action. */
  retainInterruptedWindows(retainCleanup: (request: ProtectedPaymentRequest, assertEvidenceCurrent: () => void) => () => Promise<boolean>): Promise<void> {
    return this.work.run('checkout operation', async () => {
      if (this.closed) throw new CheckoutOwnershipError();
      const requests = this.requests; if (!requests) return;
      const entries = await this.journal.list();
      if (this.closed) throw new CheckoutOwnershipError();
      for (const record of entries) {
        if (record.phase !== 'awaiting-window' || this.preparingRecovery.has(record.purchaseId) || this.active.has(record.purchaseId)) continue;
        if (this.closed) throw new CheckoutOwnershipError();
        // One unreadable or unrestorable record must not stop boot recovery
        // for every other purchase. It is never resumed; the ordinary journal
        // sweep that follows settles it as not submitted under its own lease.
        try { await this.retainInterruptedWindow(record, requests, retainCleanup); }
        catch (error) {
          if (this.closed) throw error;
          try { logger.warn('A payment window could not be prepared to resume after restart. Boot recovery settles it as not submitted; read payments.purchase.status for its outcome.'); }
          catch { /* Keep recovering the remaining records. */ }
        }
      }
    });
  }

  private async retainInterruptedWindow(record: InFlightCheckout, requests: Pick<PaymentRequestStore, 'read'>,
    retainCleanup: (request: ProtectedPaymentRequest, assertEvidenceCurrent: () => void) => () => Promise<boolean>): Promise<void> {
    const status = this.store.get(record.purchaseId);
    // A graceful stop ended its window and revoked its continuation; only a
    // crash leaves a window to resume.
    if (!status || !purchaseDisposition(status).resumable) return;
    if (this.purchases.get(record.purchaseId)) return;
    const writer = this.store.recover(record.purchaseId); if (!writer) return;
    let retained = false;
    try {
      const current = () => { if (this.closed) throw new CheckoutOwnershipError(); writer.assertCurrent(); };
      current(); if (!isDeepStrictEqual(writer.read(), status)) return;
      const request = await requests.read(record.purchaseId, status.operationId, current); current();
      if (request.principalId !== writer.principalId || status.currency !== record.currency || status.totalMinorUnits !== record.totalMinorUnits
        || !request.host.continuation || !request.host.browser || !request.host.browserControls || !request.window
        || !isDeepStrictEqual(request.window.record, record)) return;
      const latest = await this.journal.list(); current();
      if (!isDeepStrictEqual(latest.find(row => row.purchaseId === record.purchaseId), record)) return;
      const releaseOriginalWindow = retainCleanup(request, () => writer.assertCurrent());
      const recovery: PreparingRecovery = { writer, request, abort: new AbortController(), started: false, releaseOriginalWindow, cancelRequested: false };
      this.preparingRecovery.set(record.purchaseId, recovery);
      recovery.history = this.retainHistory(writer, request.window); retained = true;
    } catch (error) {
      // Say why it will not resume while the lease is still held.
      if (!this.closed) {
        try {
          const latest = writer.read();
          if (isLivePaymentOperation(latest.state) || latest.state === 'interrupted') {
            this.transition(writer, { ...latest, state: 'interrupted', outcome: 'refused:recovery-unavailable', updatedAtMs: this.now() });
          }
        } catch { /* The record stays exactly as found. */ }
      }
      throw error;
    } finally { if (!retained) { this.preparingRecovery.delete(record.purchaseId); writer.release(); } }
  }

  /** Launch only after the ordinary sweep has finished. Preparation may await
   * later facade/boot registration; registration.ready must not await it. */
  resumeInterruptedWindows(restore: CheckoutWindowRestorer): void {
    const prepare = restore.bind(undefined);
    for (const recovery of this.preparingRecovery.values()) {
      if (recovery.started || this.closed) continue;
      recovery.started = true;
      this.execution.runInAsyncScope(() => {
        const pending = this.work.run('checkout operation', async () => {
          const { writer, abort, request } = recovery;
          let restored: RecoveredCheckoutExecution | undefined, operation: ActiveOperation | undefined, failure: unknown;
          const current = () => {
            const active = this.active.get(writer.purchaseId);
            if (this.closed || this.preparingRecovery.get(writer.purchaseId) !== recovery
              && !(active?.writer === writer && active.abort === abort)) throw new CheckoutOwnershipError();
            abort.signal.throwIfAborted(); writer.assertCurrent();
          };
          try {
            current();
            if (!this.transition(writer, { ...writer.read(), state: 'running', outcome: null, updatedAtMs: this.now() })) throw new PaymentOperationStoreError('unavailable');
            await withConfiguredDecisionModelPolicy(async () => {
              await Promise.resolve(); current();
              restored = await prepare(request, { signal: abort.signal, assertCurrent: current,
                readReplyHistory: async () => {
                  current(); const latest = await this.requests?.read(writer.purchaseId, request.operationId, current); current();
                  if (!latest?.window || !request.window || !isDeepStrictEqual(paymentReplyHistoryBinding(latest.window), paymentReplyHistoryBinding(request.window))) throw new CheckoutOwnershipError();
                  return latest.replyHistory;
                } }); current();
              restored.source.assertCurrent();
              if (restored.source.principalId !== request.principalId) throw new CheckoutOwnershipError();
              operation = { writer, abort, source: restored.source, protectedRequest: true, continuation: request.host.continuation, history: recovery.history,
                cancelRequested: recovery.cancelRequested, launched: true, saving: false, abortWhenSaved: false, savedWindow: request.window?.record,
                noticeDelivered: request.window?.record.windowDeliveries?.some(delivery => delivery.delivered) === true,
                subject: request.window ? { item: request.window.record.item, merchantDomain: request.window.record.merchantDomain } : undefined };
              this.active.set(writer.purchaseId, operation); this.preparingRecovery.delete(writer.purchaseId);
              await this.run(restored.input, operation, restored.execute.bind(restored));
            });
          } catch (error) {
            failure = error;
            if (operation) await this.settleFailure(operation, error);
            // Stopped before the resumed checkout took over: its original window
            // is untouched and stays resumable, as after a crash.
            else if (!(this.stopping && !recovery.cancelRequested)) this.transition(writer, { ...writer.read(), state: 'interrupted', updatedAtMs: this.now(),
              outcome: recovery.cancelRequested ? 'cancelled' : abort.signal.aborted ? DAEMON_STOPPED : 'refused:recovery-unavailable' });
          } finally {
            const keeping = operation ? this.keeping(operation) : this.stopping && !recovery.cancelRequested;
            try {
              await (operation?.history ?? recovery.history)?.retire();
              if (operation) operation.history = undefined;
              if (!keeping) {
                let released: boolean;
                try { released = await recovery.releaseOriginalWindow(); }
                catch (error) {
                  // Cleanup failure leaves evidence to inspect, but never relabels
                  // a settled result or drops its outcome.
                  const latest = writer.read();
                  if (isLivePaymentOperation(latest.state) || latest.state === 'interrupted') {
                    this.transition(writer, { ...latest, state: 'uncertain', updatedAtMs: this.now() });
                  }
                  throw error;
                }
                if (!operation && released) {
                  const ended = recovery.cancelRequested ? 'cancelled' : abort.signal.aborted ? 'interrupted' : 'refused';
                  this.transition(writer, { ...writer.read(), updatedAtMs: this.now(), state: ended });
                  await this.requests?.remove(writer.purchaseId, request.operationId, () => writer.assertCurrent());
                  if (ended === 'refused') await this.tellOwnerNotResumed(request, failure);
                }
              }
              if (operation) await this.releaseProtectedRequest(operation);
            }
            finally {
              try { await restored?.release(); }
              finally { this.active.delete(writer.purchaseId); this.preparingRecovery.delete(writer.purchaseId); writer.release(); }
            }
          }
        });
        void pending.catch(error => { this.errors.push(error);
          try { logger.error('Checkout recovery could not settle its original evidence. Inspect purchase status before retrying.'); } catch { /* Keep the original failure. */ }
        });
      });
    }
  }

  /**
   * `admitInput` runs once the read-only admission steps have passed and
   * immediately before the durable admission write, and may return the input
   * to admit instead: it is where the host spends an owner approval, if there
   * is one.
   */
  admit(id: string, input: BeginCheckoutInput, source: DetachedCheckoutSource, admissionCurrent: () => void,
    admitInput: (input: BeginCheckoutInput) => BeginCheckoutInput | void): Promise<PaymentOperationView> {
    if (this.closed) return Promise.reject(new CheckoutOwnershipError());
    return this.work.run('prepare admission', () => this.prepareAdmission(id, input, source, admissionCurrent, admitInput));
  }

  private assertIdentityFree(id: string): void {
    if (this.reserved.has(id) || this.active.has(id) || this.preparingRecovery.has(id)) throw new PaymentOperationStoreError('exists');
    // Existing identities never create another executor, even after restart or
    // when a retry sends different input. The caller must query that exact ID.
    if (this.store.get(id) || this.purchases.get(id)) throw new PaymentOperationStoreError('exists');
  }

  private async prepareAdmission(id: string, input: BeginCheckoutInput, source: DetachedCheckoutSource, admissionCurrent: () => void,
    admitInput: (input: BeginCheckoutInput) => BeginCheckoutInput | void): Promise<PaymentOperationView> {
    checkoutRequestId(id);
    if (this.closed) throw new CheckoutOwnershipError();
    if (!this.recovered) throw new PaymentOperationStoreError('unavailable', 'New purchases wait until boot recovery of earlier purchases has finished on this payment host, '
      + 'and only the elected payment host recovers them. If this persists, look for "payments boot recovery failed" in the daemon log, fix its cause, then restart the daemon.');
    const stop = this.stopped();
    if (stop) throw new PaymentOperationStoreError('unavailable', `New purchases are paused: ${stop.reason}. Read payments.purchase.status, then restart the daemon.`);
    if (this.active.size + this.preparingRecovery.size >= 128) throw new PaymentOperationStoreError('busy');
    this.assertIdentityFree(id);
    let captured = captureOwnedJson(input) as unknown as BeginCheckoutInput;
    // Copy host facts and bind the original reader before the handoff. An
    // embed mutating its source wrapper cannot replace evidence or a guard on
    // a later background tick. Native source factories already freeze theirs.
    source = Object.freeze({ principalId: source.principalId, assertCurrent: source.assertCurrent.bind(source),
      taintEvidence: source.taintEvidence === undefined ? undefined : captureOwnedJson(source.taintEvidence) as RetainedTaintEvidence,
      recoveryFacts: source.recoveryFacts === undefined ? undefined : captureOwnedJson(source.recoveryFacts) as Pick<PaymentRequestHostFacts, 'authority' | 'configuration'>,
      issueContinuation: source.issueContinuation?.bind(source), revokeContinuation: source.revokeContinuation?.bind(source),
      capturePageConnection: source.capturePageConnection?.bind(source), captureBrowserRecovery: source.captureBrowserRecovery?.bind(source) });
    if (source.issueContinuation && !source.revokeContinuation) throw new PaymentOperationStoreError('unavailable');
    if (this.requests && (!source.taintEvidence || !source.recoveryFacts)) throw new PaymentOperationStoreError('unavailable');
    const current = () => {
      if (this.closed) throw new CheckoutOwnershipError();
      source.assertCurrent(); admissionCurrent();
      if (this.closed) throw new CheckoutOwnershipError();
    };
    current();
    // Read-only admission: the page this purchase runs on is captured before
    // anything is spent or written, so a stale page refuses with the owner's
    // approval (when one was given) still unspent.
    const abort = new AbortController();
    const capturing = () => { current(); abort.signal.throwIfAborted(); };
    let originalRecovery: BrowserCheckoutRecovery | null = null, browser: BrowserPageConnection | null = null;
    if (this.requests) {
      const recovery = source.captureBrowserRecovery
        ? await source.captureBrowserRecovery(captured, { signal: abort.signal, assertCurrent: capturing }) : null;
      capturing();
      originalRecovery = recovery === null ? null : captureBrowserCheckoutRecovery(recovery);
      const observed = source.captureBrowserRecovery ? originalRecovery?.connection ?? null : source.capturePageConnection
        ? await source.capturePageConnection(captured, { signal: abort.signal, assertCurrent: capturing }) : null;
      capturing();
      browser = observed === null ? null : captureBrowserPageConnection(observed);
    }
    // Another admission may have taken this identity during the capture.
    this.assertIdentityFree(id);
    current();
    const admitted = admitInput(captured);
    if (admitted) captured = captureOwnedJson(admitted) as unknown as BeginCheckoutInput;
    current();
    const now = this.now();
    const operation: PaymentOperationView = Object.freeze({ purchaseId: id, operationId: `payment-operation:${crypto.randomUUID()}`,
      state: 'accepted', phase: null, createdAtMs: now, updatedAtMs: now, outcome: null, totalMinorUnits: null, currency: null });
    const writer = this.store.create(operation, source.principalId, current);
    const active: ActiveOperation = { writer, source, abort, protectedRequest: false, continuation: undefined,
      cancelRequested: false, launched: false, saving: false, abortWhenSaved: false, savedWindow: undefined, noticeDelivered: false, subject: undefined };
    this.active.set(id, active);
    let launched = false;
    try {
      const preparing = () => { current(); active.abort.signal.throwIfAborted(); writer.assertCurrent(); };
      if (source.issueContinuation) active.continuation = capturePaymentContinuation(source.issueContinuation(operation.operationId, preparing), operation.operationId);
      preparing();
      if (this.requests) {
        const recoveryFacts = source.recoveryFacts, taintEvidence = source.taintEvidence;
        if (!taintEvidence || !recoveryFacts) throw new PaymentOperationStoreError('unavailable');
        await this.requests.retain({ version: 1, purchaseId: id, operationId: operation.operationId, principalId: source.principalId,
          input: captured, evidence: taintEvidence,
          host: { authority: recoveryFacts.authority, configuration: recoveryFacts.configuration,
            ...(active.continuation ? { continuation: active.continuation } : {}), ...(browser ? { browser } : {}),
            ...(originalRecovery ? { browserControls: originalRecovery.controls } : {}) } }, preparing);
        active.protectedRequest = true;
      }
      preparing();
      // Only now can admission acknowledge durable original facts. Launch has
      // no request signal/context, admission callback or approval-spend closure.
      this.launch(captured, active); launched = true;
      return operation;
    } catch (error) {
      await this.settleFailure(active, error);
      throw error;
    } finally {
      if (!launched) {
        try { await this.releaseProtectedRequest(active); }
        catch (error) { this.errors.push(error); throw error; }
        finally { this.active.delete(id); writer.release(); }
      }
    }
  }

  private launch(input: BeginCheckoutInput, operation: ActiveOperation): void {
    const { writer } = operation;
    operation.launched = true;
    this.execution.runInAsyncScope(() => {
      const pending = this.work.run('checkout operation', async () => {
        try {
          await withConfiguredDecisionModelPolicy(async () => {
            await Promise.resolve();
            await this.run(input, operation);
          });
        } catch (error) { await this.settleFailure(operation, error); }
        finally {
          try { await operation.history?.retire(); operation.history = undefined; await this.releaseProtectedRequest(operation); }
          finally { this.active.delete(writer.purchaseId); writer.release(); }
        }
      });
      const ending = pending.catch(error => {
        this.errors.push(error);
        try { logger.error('Purchase operation did not settle its metadata cleanly. Inspect its original payment evidence.'); } catch { /* Preserve owned settlement failure. */ }
      }).finally(() => { if (this.running.get(writer.purchaseId) === ending) this.running.delete(writer.purchaseId); });
      this.running.set(writer.purchaseId, ending);
    });
  }

  /**
   * Resolves once the operation this host launched for the purchase has
   * ended: its final state, its owner notice and its cleanup are written.
   * Resolves at once when no operation for it is running here. Never rejects;
   * payments.purchase.status says how it ended.
   */
  ended(purchaseId: string): Promise<void> {
    return this.running.get(purchaseId) ?? Promise.resolve();
  }
  private async releaseProtectedRequest(operation: ActiveOperation): Promise<void> {
    // Request and continuation are the evidence the next boot resumes from.
    if (this.keeping(operation)) return;
    const { writer } = operation;
    const status = writer.read();
    const settled = purchaseDisposition(status).final;
    // A stop can race an unknown merchant result. Retire future authority
    // while retaining the original evidence needed to reconcile that result:
    // once the run has ended, nothing in this process acts on the grant again.
    if (operation.continuation && (settled || operation.abort.signal.aborted || !isLivePaymentOperation(status.state))) {
      if (!operation.source.revokeContinuation) throw new PaymentOperationStoreError('unavailable');
      await operation.source.revokeContinuation(operation.continuation);
      operation.continuation = undefined;
    }
    if (!settled || !this.requests || !operation.protectedRequest) return;
    await this.requests.remove(writer.purchaseId, status.operationId, () => writer.assertCurrent());
    operation.protectedRequest = false;
  }
  private current(operation: ActiveOperation): void {
    // A stop lets a window checkpoint's own write finish, so what the next boot
    // resumes is exactly what was saved. That write only persists an already
    // captured checkpoint; the next boot re-validates its authority and settings.
    const finishing = this.closed && operation.saving;
    if (this.closed && !finishing || this.active.get(operation.writer.purchaseId) !== operation) throw new CheckoutOwnershipError();
    operation.abort.signal.throwIfAborted(); operation.writer.assertCurrent();
    if (finishing) return;
    operation.source.assertCurrent();
    operation.abort.signal.throwIfAborted();
  }
  private async run(input: BeginCheckoutInput, operation: ActiveOperation, execute = this.execute): Promise<void> {
    const { writer } = operation;
    try {
      this.current(operation);
      if (!this.transition(writer, { ...writer.read(), state: 'running', updatedAtMs: this.now() })) throw new PaymentOperationStoreError('unavailable');
      const result = await execute(input, writer.purchaseId, { signal: operation.abort.signal,
        assertCurrent: () => this.current(operation), taintEvidence: operation.source.taintEvidence,
        keepWindowOnStop: () => this.keeping(operation),
        ...(this.requests ? { retainWindowCheckpoint: checkpoint => this.checkpointWindow(input, operation, checkpoint) } : {}) });
      if (this.keeping(operation)) return;
      // Completion records facts even after owner cancellation; it grants no
      // further act. Actual journal phase wins over a generic refusal string.
      // The recorded phase is cleared only when this checkout's own journal
      // record was removed before any click (see released), so a clean
      // pre-click refusal settles as refused rather than uncertain.
      const entries = await this.journal.list(), retained = entries.find(row => row.purchaseId === writer.purchaseId);
      const previous = writer.read();
      const recorded = this.purchases.get(writer.purchaseId);
      const state: PaymentOperationState = recorded ? 'completed' : mayHaveSubmitted(retained?.phase) || mayHaveSubmitted(previous.phase)
        ? readPurchaseOutcome(result.outcome)?.kind === 'challenge' ? 'attention' : 'uncertain'
        : operation.cancelRequested ? 'cancelled'
          : operation.abort.signal.aborted && result.outcome !== 'cancelled' ? 'interrupted'
            : unsubmittedEndState(result.outcome);
      const exceeded = operationLimit(result.exceeded);
      const settled = this.transition(writer, { ...previous, state, updatedAtMs: this.now(),
        outcome: recorded?.outcome ?? (state === 'cancelled' ? 'cancelled' : state === 'interrupted' ? DAEMON_STOPPED : result.outcome),
        totalMinorUnits: recorded?.totalMinorUnits ?? result.totalMinorUnits ?? previous.totalMinorUnits,
        currency: recorded?.currency ?? result.currency ?? previous.currency,
        ...(state !== 'completed' && result.reason ? { reason: clip(result.reason) } : {}),
        ...(result.challengeStep ? { challengeStep: clip(result.challengeStep) } : {}),
        ...(state === 'refused' && exceeded ? { exceeded } : {}) });
      if (settled) await this.tellOwnerOfEnd(operation, result.ownerMessage);
    } catch (error) { await this.settleFailure(operation, error); }
  }

  /**
   * One closing message for a purchase the owner was sent a notice about and
   * that ended without being bought: the specific reason, the cancellation
   * report, or the verification step waiting on them. A completed purchase
   * has its own report, and a host stop is told by the next start's recovery.
   */
  private async tellOwnerOfEnd(operation: ActiveOperation, message: string | undefined): Promise<void> {
    const notify = this.notify;
    if (!notify || !operation.noticeDelivered) return;
    let ended: PaymentOperationView;
    try { ended = operation.writer.read(); } catch { return; }
    if (ended.state === 'completed' || ended.state === 'interrupted' || isLivePaymentOperation(ended.state)) return;
    const what = operation.subject ? `${sanitizeNoticeField(operation.subject.item)} from ${sanitizeNoticeField(operation.subject.merchantDomain)}` : `purchase ${ended.purchaseId}`;
    const text = message ?? paymentOperationDescription(ended);
    const body = ended.state === 'cancelled' && message !== undefined ? text
      : ended.state === 'attention' ? `The purchase of ${what} is waiting on you. ${text}`
        : ended.state === 'uncertain' ? `The purchase of ${what} may or may not have gone through. ${text}`
          : `The purchase of ${what} did not go through. ${text}`;
    try { await notify(body); }
    catch {
      try { logger.warn('The closing message for a purchase that did not complete could not be delivered. Its status keeps the reason.', { purchaseId: ended.purchaseId }); }
      catch { /* The status record keeps the reason. */ }
    }
  }
  /**
   * A window the restart could not take back ends unbought; the owner, who was
   * sent its notice before the restart, hears that once, here. The boot sweep
   * skipped this record because its lease was held, and the record is gone now.
   */
  private async tellOwnerNotResumed(request: ProtectedPaymentRequest, failure: unknown): Promise<void> {
    const notify = this.notify, record = request.window?.record;
    if (!notify || !record?.windowDeliveries?.some(delivery => delivery.delivered)) return;
    const why = failure instanceof DecisionModelsDisabledError || failure instanceof JudgmentPortMissingError
      || failure instanceof JudgmentError && failure.kind === 'unavailable'
      ? 'decision models were off or unavailable when it restarted'
      : failure instanceof PaymentReplyWindowError
        ? 'the replies sent to its notice could not be read back after the restart'
        : 'its browser page, pairing or payment settings were not as they were before the restart';
    const what = `${sanitizeNoticeField(record.item)} from ${sanitizeNoticeField(record.merchantDomain)}`;
    try {
      await notify(`The purchase of ${what} was waiting for your answer when the daemon restarted, and it could not be resumed: ${why}. `
        + 'Nothing was bought and its hold is released. Start the purchase again if you still want it.');
    } catch {
      try { logger.warn('The message for a purchase that could not resume after a restart was not delivered. Its status keeps the reason.', { purchaseId: request.purchaseId }); }
      catch { /* The status record keeps the reason. */ }
    }
  }
  /** Part of the same owned executor, not a detached publication. Only the
   * actual latest flushed journal record can advance this request's window. */
  private async checkpointWindow(input: BeginCheckoutInput, operation: ActiveOperation, value: CheckoutWindowCheckpoint): Promise<void> {
    const checkpoint = captureCheckoutWindowCheckpoint(value), { writer } = operation;
    const current = () => this.current(operation);
    current();
    const save = this.requests?.checkpointWindow;
    if (!save || !operation.protectedRequest || checkpoint.record.purchaseId !== writer.purchaseId) throw new PaymentOperationStoreError('unavailable');
    const records = await this.journal.list(); current();
    if (!isDeepStrictEqual(records.find(record => record.purchaseId === writer.purchaseId), checkpoint.record)) throw new PaymentOperationStoreError('unavailable');
    const browser = operation.source.captureBrowserRecovery
      ? await operation.source.captureBrowserRecovery(input, { signal: operation.abort.signal, assertCurrent: current }) : null;
    current();
    const latest = await this.journal.list(); current();
    if (!isDeepStrictEqual(latest.find(record => record.purchaseId === writer.purchaseId), checkpoint.record)) throw new PaymentOperationStoreError('unavailable');
    // Stop and drain the old window's admitted archive writes before the
    // encrypted binding changes. Same-window page-coordinate refreshes retain it.
    if (operation.history && !isDeepStrictEqual(operation.history.binding, paymentReplyHistoryBinding(checkpoint))) {
      await operation.history.retire(); operation.history = undefined; current();
    }
    // Recapture the exact selected native controls for this quote, rather than
    // keep the admission snapshot after a reprice or intervening native read.
    const receiveSpans = await this.captureReceiveSpans?.(writer.purchaseId, checkpoint, current); current();
    operation.saving = true;
    try {
      await save(writer.purchaseId, writer.read().operationId, checkpoint, browser, current, receiveSpans);
      operation.savedWindow = checkpoint.record;
    } finally {
      operation.saving = false;
      // A stop that landed during the write was held back until it finished.
      if (operation.abortWhenSaved) operation.abort.abort(new CheckoutOwnershipError());
    }
    current();
    operation.history ??= this.retainHistory(writer, checkpoint);
  }

  private async settleFailure(operation: ActiveOperation, error: unknown): Promise<void> {
    // A stop that left a durably saved window settles nothing: that window is
    // the state a crash would leave, and the next boot resumes or settles it.
    if (this.keeping(operation)) return;
    const { writer } = operation, previous = writer.read();
    let state: PaymentOperationState = 'uncertain';
    let outcome: string | null = previous.outcome ?? failureOutcome(error);
    try {
      const entries = await this.journal.list(), retained = entries.find(row => row.purchaseId === writer.purchaseId);
      const recorded = this.purchases.get(writer.purchaseId);
      if (recorded) { state = 'completed'; outcome = recorded.outcome; }
      else if (mayHaveSubmitted(retained?.phase) || mayHaveSubmitted(previous.phase)) state = 'uncertain';
      else if (operation.cancelRequested) { state = 'cancelled'; outcome = 'cancelled'; }
      // A shutdown is not the owner's stop. Before launch the begin call itself
      // reports the failure, so only a running checkout records the stop.
      else if (operation.abort.signal.aborted) {
        if (operation.launched) { state = 'interrupted'; outcome = DAEMON_STOPPED; } else state = 'cancelled';
      } else { outcome ??= stoppedOutcome(error); state = unsubmittedEndState(outcome); }
    } catch { /* Unreadable financial evidence remains uncertain. */ }
    if (this.transition(writer, { ...previous, state, outcome, updatedAtMs: this.now() })) await this.tellOwnerOfEnd(operation, undefined);
  }
  /** Called only after the real journal put is durably confirmed. */
  progress(record: InFlightCheckout): void {
    const operation = this.active.get(record.purchaseId); if (!operation) return;
    // Any later journal write means the saved window no longer matches it.
    if (operation.savedWindow && !isDeepStrictEqual(operation.savedWindow, record)) operation.savedWindow = undefined;
    if (record.windowDeliveries?.some(delivery => delivery.delivered)) operation.noticeDelivered = true;
    operation.subject = { item: record.item, merchantDomain: record.merchantDomain };
    const previous = operation.writer.read();
    this.transition(operation.writer, { ...previous, phase: record.phase, totalMinorUnits: record.totalMinorUnits,
      currency: record.currency, updatedAtMs: this.now() });
  }
  /** Called only after this registry's own journal removal is durably
   * confirmed. A checkout removes its own record only before the click or
   * after its purchase is recorded, so with no purchase record nothing of it
   * remains in flight and its last phase no longer describes it. */
  released(purchaseId: string): void {
    const operation = this.active.get(purchaseId); if (!operation) return;
    operation.savedWindow = undefined;
    try {
      if (this.purchases.get(purchaseId)) return;
      const previous = operation.writer.read();
      if (previous.phase !== null) this.transition(operation.writer, { ...previous, phase: null, updatedAtMs: this.now() });
    } catch { /* The last phase stays; a stale submit phase only ever reads as uncertain. */ }
  }
  /** Whether this host is running, or preparing to resume, that purchase. */
  isActive(purchaseId: string): boolean {
    return this.active.has(purchaseId) || this.preparingRecovery.has(purchaseId);
  }

  /** One owner for every state write here: a refused move is logged and the
   * stored state is left as it was. */
  private transition(writer: PaymentOperationWriter, next: PaymentOperationView): boolean {
    const move = operationLifecycle.check(writer.read().state, next.state);
    if (!move.ok) {
      try { logger.warn(`Purchase operation status was kept: ${move.reason}.`); } catch { /* Keep the original state. */ }
      return false;
    }
    writer.update(next);
    return true;
  }

  /** Mark a host stop before anything aborts. Idempotent; owner cancels are unaffected. */
  beginStop(): void { this.stopping = true; }
  /** A host stop (never an owner cancel) found this window durably saved as its journal reads. */
  private keeping(operation: ActiveOperation): boolean {
    return this.stopping && !operation.cancelRequested && operation.savedWindow !== undefined;
  }

  status(id?: string): readonly PaymentOperationView[] { return this.store.list(id); }
  /** The listing degrades per record: readable rows plus the records that could not be read. */
  statusReport(id?: string): { readonly operations: readonly PaymentOperationView[]; readonly unreadable: readonly PaymentUnreadableOperation[] } {
    return id === undefined ? this.store.report() : { operations: this.store.list(id), unreadable: [] };
  }
  /**
   * The owner's "no" to an open purchase window (a veto, a denied approval),
   * written to the operation's record before the answer is reported accepted:
   * the operation says `cancelling` on disk, so a daemon that stops right after
   * never resumes that window (a cancelling operation is not resumable) and
   * never buys on it. Unlike {@link cancel} it does not abort: the window's own
   * answer ends the purchase with its report. Throws when the record could not
   * be written; null when this host runs no such live purchase. The returned
   * `abort` stops the purchase outright, for an answer that then could not be
   * applied to its window (the record already says it is stopping).
   */
  recordOwnerStop(id: string): { readonly abort: () => void } | null {
    const operation = this.active.get(id); if (!operation) return null;
    const previous = operation.writer.read();
    if (!isLivePaymentOperation(previous.state)) return null;
    if (previous.state !== 'cancelling') {
      operation.cancelRequested = true;
      if (!this.transition(operation.writer, { ...previous, state: 'cancelling', updatedAtMs: this.now() })) return null;
    }
    return { abort: () => operation.abort.abort(new CheckoutOwnershipError()) };
  }

  cancel(id: string, operationId: string): PaymentOperationCancellation {
    if (this.closed) throw new PaymentOperationStoreError('busy', 'This payment host is shutting down and no longer takes stop requests. '
      + `Read payments.purchase.status for purchase ${id} once the daemon is running again.`);
    const operation = this.active.get(id) ?? this.preparingRecovery.get(id); if (!operation) throw this.cancelRefusal(id, operationId);
    const previous = operation.writer.read();
    if (previous.operationId !== operationId) throw mismatchedOperation(id);
    if (!isLivePaymentOperation(previous.state)) throw finishedOperation(previous);
    operation.cancelRequested = true;
    this.transition(operation.writer, { ...previous, state: 'cancelling', updatedAtMs: this.now() });
    operation.abort.abort(new CheckoutOwnershipError());
    return Object.freeze({ purchaseId: id, operationId, accepted: true, mayHaveSubmitted: mayHaveSubmitted(previous.phase) });
  }
  private cancelRefusal(id: string, operationId: string): PaymentOperationStoreError {
    let existing: PaymentOperationView | null;
    try { existing = this.store.get(id); }
    catch (error) { return error instanceof PaymentOperationStoreError ? error : new PaymentOperationStoreError('unavailable'); }
    if (!existing) return new PaymentOperationStoreError('invalid', `No purchase ${id} exists on this payment host. `
      + 'Read payments.purchase.status for the purchaseId and operationId to stop.');
    if (existing.operationId !== operationId) return mismatchedOperation(id);
    if (isLivePaymentOperation(existing.state)) return new PaymentOperationStoreError('busy', `Purchase ${id} is ${existing.state} on another payment host. Stop it on that host.`);
    return finishedOperation(existing);
  }

  /** No receipt/status can resurrect an executor. Reconcile evidence after the
   * ordinary recovery sweep, retaining unknown submissions for inspection. */
  async recover(): Promise<void> {
    if (this.closed) throw new CheckoutOwnershipError();
    const entries = await this.journal.list();
    for (const entry of entries) this.reserved.add(entry.purchaseId);
    for (const previous of this.store.list()) {
      if (this.closed) throw new CheckoutOwnershipError();
      if (!purchaseDisposition(previous).recheckAtStart) continue;
      const writer = this.store.recover(previous.purchaseId); if (!writer) continue;
      try {
        const current = writer.read();
        if (!isDeepStrictEqual(current, previous)) continue;
        if (writer.reconciliation()) continue;
        const retained = entries.find(row => row.purchaseId === current.purchaseId);
        let state: PaymentOperationState = 'uncertain', outcome = current.outcome;
        let total = current.totalMinorUnits, currency = current.currency;
        try {
          const recorded = this.purchases.get(current.purchaseId);
          if (recorded) { state = 'completed'; outcome = recorded.outcome; total = recorded.totalMinorUnits; currency = recorded.currency; }
          else if (!mayHaveSubmitted(current.phase) && !mayHaveSubmitted(retained?.phase)) {
            // Nothing was submitted and no executor took it back: it is over.
            // An owner's stop that a restart overtook is still the owner's stop.
            if (current.state === 'cancelling') { state = 'cancelled'; outcome = 'cancelled'; }
            else { state = 'interrupted'; outcome ??= DAEMON_STOPPED; }
          }
        } catch { /* Unknown evidence is never absence or permission to resubmit. */ }
        this.transition(writer, { ...current, state, outcome, totalMinorUnits: total, currency, updatedAtMs: this.now() });
      } finally { writer.release(); }
    }
    if (this.closed) throw new CheckoutOwnershipError();
    this.recovered = true;
  }

  /**
   * Boot housekeeping, after `recover` and after resumable windows were
   * prepared: a stored request whose purchase is settled or has no status is
   * removed with its continuation retired; one kept as evidence for an owner
   * finding keeps its file and loses its continuation. One directory listing
   * and one decryption per stored request, at start only.
   */
  async sweepSettledRequests(): Promise<number> {
    const sweep = this.sweepRequests; if (!sweep) return 0;
    return this.work.run('sweep', () => sweep((purchaseId, operationId) => this.requestVerdict(purchaseId, operationId), this.retire));
  }
  private requestVerdict(purchaseId: string, operationId: string): PaymentRequestVerdict {
    if (this.closed || this.active.has(purchaseId) || this.preparingRecovery.has(purchaseId)) return 'keep';
    let status: PaymentOperationView | null;
    try { status = this.store.get(purchaseId); } catch { return 'keep'; }
    if (!status || status.operationId !== operationId) return 'remove';
    const disposition = purchaseDisposition(status);
    if (disposition.final) return 'remove';
    return disposition.live ? 'keep' : 'retire';
  }

  /** The same end-of-purchase cleanup for a purchase settled outside an executor (an owner's reconciliation). */
  async settledElsewhere(purchaseId: string, operationId: string): Promise<void> {
    const discard = this.discardRequest; if (!discard || this.active.has(purchaseId)) return;
    await discard(purchaseId, operationId, this.retire);
  }

  /** Why this host takes no new purchase until it restarts, or null. */
  stopped(): PaymentStoreStop | null {
    return this.errors.length > 0
      ? { store: 'purchase operation records', reason: 'an earlier purchase did not settle its records cleanly' }
      : null;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.beginStop(); this.closed = true;
    for (const operation of this.active.values()) {
      // An owner cancel has already aborted; a window checkpoint mid-write is
      // allowed to finish first so a restart resumes what is actually saved.
      if (operation.saving && !operation.cancelRequested) operation.abortWhenSaved = true;
      else operation.abort.abort(new CheckoutOwnershipError());
    }
    for (const operation of this.preparingRecovery.values()) operation.abort.abort(new CheckoutOwnershipError());
    // Prepared leases not yet launched also belong to this registration.
    for (const [id, operation] of this.preparingRecovery) if (!operation.started) {
      this.preparingRecovery.delete(id);
      const cleanup = this.work.run('checkout operation', async () => { try { await operation.history?.retire(); } finally { operation.writer.release(); } });
      void cleanup.catch(error => this.errors.push(error));
    }
    void this.work.join().then(() => {
      this.execution.emitDestroy();
      if (this.errors.length) reject(new AggregateError(this.errors, 'Purchase operation metadata did not settle cleanly'));
      else resolve();
    }, reject);
    return this.closing;
  }
}
