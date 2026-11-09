/** Detached checkout ownership. Durable admission is an acknowledgement of one
 * operation, never a successful purchase. Actual work and its execution lease
 * outlive the request and remain drained by the registration owner. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { DecisionModelsDisabledError, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { isDeepStrictEqual } from 'node:util';
import { AsyncResource } from 'node:async_hooks';
import { requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { OwnedWork } from '../../utils/owned-work.js';
import { logger } from '../../utils/logger.js';
import { CheckoutOwnershipError } from '../checkout-ownership.js';
import type { CheckoutJournal, InFlightCheckout } from '../checkout-registry.js';
import type { BeginCheckoutInput, PaymentBeginResult } from '../payments-gateway-service.js';
import { isLivePaymentOperation, type PaymentOperationView, type PaymentOperationCancellation } from '../operation-view.js';
import { DurablePaymentOperations, PaymentOperationStoreError, checkoutRequestId, type PaymentOperationWriter } from './operation-store.js';
import type { DaemonPurchaseLedger } from './purchase-ledger.js';
import type { RetainedTaintEvidence } from '../../security/untrusted-content.js';
import type { PaymentRequestHostFacts, PaymentRequestStore, ProtectedPaymentRequest } from './protected-requests.js';
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
  readonly readReplyHistory?: (() => Promise<PaymentReplyHistory | undefined>) | undefined;
}
interface ActiveOperation {
  readonly writer: PaymentOperationWriter;
  readonly abort: AbortController;
  readonly source: DetachedCheckoutSource;
  protectedRequest: boolean;
  continuation: NativeContinuationGrant | undefined;
  history?: RetainedPaymentReplyHistory | undefined;
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
}
export class CheckoutOperations {
  // Constructed with the registration, before request dispatch. Background
  // work must not inherit a request's tool proof, signal or notice sink.
  private readonly execution = new AsyncResource('GoodVibesPaymentOperations', { requireManualDestroy: true });
  private readonly work = new OwnedWork();
  private readonly active = new Map<string, ActiveOperation>();
  private readonly preparingRecovery = new Map<string, PreparingRecovery>();
  private readonly errors: unknown[] = [];
  private closed = false;
  private recovered = false;
  private readonly reserved = new Set<string>();
  private readonly requests: Pick<PaymentRequestStore, 'retain' | 'read' | 'remove' | 'checkpointWindow' | 'appendReply'> | undefined;
  private readonly history: Pick<PaymentReplyInbox, 'retainReplyHistory'> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly store: DurablePaymentOperations, private readonly journal: CheckoutJournal,
    private readonly purchases: DaemonPurchaseLedger,
    private readonly execute: (input: BeginCheckoutInput, id: string, owner: DetachedCheckoutOwner) => Promise<PaymentBeginResult>,
    private readonly now: () => number = Date.now,
    requests?: PaymentRequestStore, replies?: Pick<PaymentReplyInbox, 'retainReplyHistory'>) {
    // Retain the original host methods, rather than consulting a mutable
    // embed wrapper again after admission or during asynchronous cleanup.
    this.requests = requests ? Object.freeze({ retain: requests.retain.bind(requests), read: requests.read.bind(requests), remove: requests.remove.bind(requests),
      ...(requests.checkpointWindow ? { checkpointWindow: requests.checkpointWindow.bind(requests) } : {}),
      ...(requests.supportsReplyHistory && requests.appendReply ? { appendReply: requests.appendReply.bind(requests) } : {}) }) : undefined;
    this.history = this.requests?.appendReply && replies ? Object.freeze({ retainReplyHistory: replies.retainReplyHistory.bind(replies) }) : undefined;
  }

  private retainHistory(writer: PaymentOperationWriter, checkpoint: CheckoutWindowCheckpoint): RetainedPaymentReplyHistory | undefined {
    const append = this.requests?.appendReply; if (!this.history || !append) return undefined;
    const current = () => {
      if (this.closed || !(this.active.get(writer.purchaseId)?.writer === writer || this.preparingRecovery.get(writer.purchaseId)?.writer === writer)) throw new CheckoutOwnershipError();
      writer.assertCurrent();
    };
    const binding = paymentReplyHistoryBinding(checkpoint);
    return this.history.retainReplyHistory(writer.purchaseId, checkpoint, (entry, receivedCurrent) => this.work.run(() =>
      append(writer.purchaseId, writer.read().operationId, binding, entry, () => { current(); receivedCurrent(); })), current);
  }

  /** Take actual execution leases before the conservative journal sweep.
   * Reading a checkpoint does not start a model, browser or merchant action. */
  retainInterruptedWindows(retainCleanup: (request: ProtectedPaymentRequest, assertEvidenceCurrent: () => void) => () => Promise<boolean>): Promise<void> {
    return this.work.run(async () => {
      if (this.closed) throw new CheckoutOwnershipError();
      const requests = this.requests; if (!requests) return;
      const entries = await this.journal.list();
      if (this.closed) throw new CheckoutOwnershipError();
      for (const record of entries) {
        if (record.phase !== 'awaiting-window' || this.preparingRecovery.has(record.purchaseId) || this.active.has(record.purchaseId)) continue;
        if (this.closed) throw new CheckoutOwnershipError();
        const status = this.store.get(record.purchaseId);
        if (!status || status.state === 'cancelling' || status.outcome === 'cancelled' || status.phase !== 'awaiting-window'
          || !(isLivePaymentOperation(status.state) || status.state === 'interrupted')) continue;
        if (this.purchases.get(record.purchaseId)) continue;
        const writer = this.store.recover(record.purchaseId); if (!writer) continue;
        let retained = false;
        try {
          const current = () => { if (this.closed) throw new CheckoutOwnershipError(); writer.assertCurrent(); };
          current(); if (!isDeepStrictEqual(writer.read(), status)) continue;
          const request = await requests.read(record.purchaseId, status.operationId, current); current();
          if (request.principalId !== writer.principalId || status.currency !== record.currency || status.totalMinorUnits !== record.totalMinorUnits
            || !request.host.continuation || !request.host.browser || !request.host.browserControls || !request.window
            || !isDeepStrictEqual(request.window.record, record)) continue;
          const latest = await this.journal.list(); current();
          if (!isDeepStrictEqual(latest.find(row => row.purchaseId === record.purchaseId), record)) continue;
          const releaseOriginalWindow = retainCleanup(request, () => writer.assertCurrent());
          const recovery: PreparingRecovery = { writer, request, abort: new AbortController(), started: false, releaseOriginalWindow };
          this.preparingRecovery.set(record.purchaseId, recovery);
          recovery.history = this.retainHistory(writer, request.window); retained = true;
        } finally { if (!retained) { this.preparingRecovery.delete(record.purchaseId); writer.release(); } }
      }
    });
  }

  /** Launch only after the ordinary sweep has finished. Preparation may await
   * later facade/boot registration; registration.ready must not await it. */
  resumeInterruptedWindows(restore: CheckoutWindowRestorer): void {
    const prepare = restore.bind(undefined);
    for (const recovery of this.preparingRecovery.values()) {
      if (recovery.started || this.closed) continue;
      recovery.started = true;
      this.execution.runInAsyncScope(() => {
        const pending = this.work.run(async () => {
          const { writer, abort, request } = recovery;
          let restored: RecoveredCheckoutExecution | undefined, operation: ActiveOperation | undefined;
          const current = () => {
            const active = this.active.get(writer.purchaseId);
            if (this.closed || this.preparingRecovery.get(writer.purchaseId) !== recovery
              && !(active?.writer === writer && active.abort === abort)) throw new CheckoutOwnershipError();
            abort.signal.throwIfAborted(); writer.assertCurrent();
          };
          try {
            current(); writer.update({ ...writer.read(), state: 'running', outcome: null, updatedAtMs: this.now() });
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
              operation = { writer, abort, source: restored.source, protectedRequest: true, continuation: request.host.continuation, history: recovery.history };
              this.active.set(writer.purchaseId, operation); this.preparingRecovery.delete(writer.purchaseId);
              await this.run(restored.input, operation, restored.execute.bind(restored));
            });
          } catch (error) {
            if (operation) await this.settleFailure(operation, error);
            else writer.update({ ...writer.read(), state: 'interrupted', outcome: abort.signal.aborted ? 'cancelled' : 'refused:recovery-unavailable', updatedAtMs: this.now() });
          } finally {
            try {
              await (operation?.history ?? recovery.history)?.retire();
              if (operation) operation.history = undefined;
              let released: boolean;
              try { released = await recovery.releaseOriginalWindow(); }
              catch (error) {
                writer.update({ ...writer.read(), state: 'uncertain', outcome: null, updatedAtMs: this.now() }); throw error;
              }
              if (!operation && released) {
                writer.update({ ...writer.read(), state: abort.signal.aborted ? 'cancelled' : 'refused', updatedAtMs: this.now() });
                await this.requests?.remove(writer.purchaseId, request.operationId, () => writer.assertCurrent());
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

  admit(id: string, input: BeginCheckoutInput, source: DetachedCheckoutSource, admissionCurrent: () => void,
    consumeApproval: () => void): Promise<PaymentOperationView> {
    if (this.closed) return Promise.reject(new CheckoutOwnershipError());
    return this.work.run(() => this.prepareAdmission(id, input, source, admissionCurrent, consumeApproval));
  }

  private async prepareAdmission(id: string, input: BeginCheckoutInput, source: DetachedCheckoutSource, admissionCurrent: () => void,
    consumeApproval: () => void): Promise<PaymentOperationView> {
    checkoutRequestId(id);
    if (this.closed) throw new CheckoutOwnershipError();
    if (!this.recovered || this.errors.length > 0) throw new PaymentOperationStoreError('unavailable');
    if (this.reserved.has(id)) throw new PaymentOperationStoreError('exists');
    if (this.active.size + this.preparingRecovery.size >= 128) throw new PaymentOperationStoreError('busy');
    // Existing identities never create another executor, even after restart or
    // when a retry sends different input. The caller must query that exact ID.
    if (this.store.get(id) || this.purchases.get(id)) throw new PaymentOperationStoreError('exists');
    const captured = captureOwnedJson(input) as unknown as BeginCheckoutInput;
    // Copy host facts and bind the original reader before the handoff. An
    // embed mutating its source wrapper cannot replace evidence or a guard on
    // a later background tick. Native source factories already freeze theirs.
    source = Object.freeze({ principalId: source.principalId, assertCurrent: source.assertCurrent.bind(source),
      taintEvidence: source.taintEvidence === undefined ? undefined : captureOwnedJson(source.taintEvidence) as RetainedTaintEvidence,
      recoveryFacts: source.recoveryFacts === undefined ? undefined : captureOwnedJson(source.recoveryFacts) as Pick<PaymentRequestHostFacts, 'authority' | 'configuration'>,
      issueContinuation: source.issueContinuation?.bind(source), revokeContinuation: source.revokeContinuation?.bind(source),
      capturePageConnection: source.capturePageConnection?.bind(source), captureBrowserRecovery: source.captureBrowserRecovery?.bind(source) });
    if (source.issueContinuation && !source.revokeContinuation) throw new PaymentOperationStoreError('unavailable');
    const current = () => {
      if (this.closed) throw new CheckoutOwnershipError();
      source.assertCurrent(); admissionCurrent();
      if (this.closed) throw new CheckoutOwnershipError();
    };
    current(); consumeApproval(); current();
    const now = this.now();
    const operation: PaymentOperationView = Object.freeze({ purchaseId: id, operationId: `payment-operation:${opaqueUuid()}`,
      state: 'accepted', phase: null, createdAtMs: now, updatedAtMs: now, outcome: null, totalMinorUnits: null, currency: null });
    const writer = this.store.create(operation, source.principalId, current);
    const active: ActiveOperation = { writer, source, abort: new AbortController(), protectedRequest: false, continuation: undefined };
    this.active.set(id, active);
    let launched = false;
    try {
      const preparing = () => { current(); active.abort.signal.throwIfAborted(); writer.assertCurrent(); };
      if (source.issueContinuation) active.continuation = capturePaymentContinuation(source.issueContinuation(operation.operationId, preparing), operation.operationId);
      preparing();
      if (this.requests) {
        if (!source.taintEvidence || !source.recoveryFacts) throw new PaymentOperationStoreError('unavailable');
        const recovery = source.captureBrowserRecovery
          ? await source.captureBrowserRecovery(captured, { signal: active.abort.signal, assertCurrent: preparing }) : null;
        preparing();
        const originalRecovery = recovery === null ? null : captureBrowserCheckoutRecovery(recovery);
        const observed = source.captureBrowserRecovery ? originalRecovery?.connection ?? null : source.capturePageConnection
          ? await source.capturePageConnection(captured, { signal: active.abort.signal, assertCurrent: preparing }) : null;
        preparing();
        const browser = observed === null ? null : captureBrowserPageConnection(observed);
        await this.requests.retain({ version: 1, purchaseId: id, operationId: operation.operationId, principalId: source.principalId,
          input: captured, evidence: source.taintEvidence,
          host: { authority: source.recoveryFacts.authority, configuration: source.recoveryFacts.configuration,
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
    this.execution.runInAsyncScope(() => {
      const pending = this.work.run(async () => {
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
      void pending.catch(error => {
        this.errors.push(error);
        try { logger.error('Purchase operation did not settle its metadata cleanly. Inspect its original payment evidence.'); } catch { /* Preserve owned settlement failure. */ }
      });
    });
  }
  private async releaseProtectedRequest(operation: ActiveOperation): Promise<void> {
    const { writer } = operation;
    const status = writer.read();
    const settled = ['refused', 'cancelled', 'failed'].includes(status.state)
      || status.state === 'completed' && (status.outcome === 'purchased' || status.outcome === 'refunded');
    // A stop can race an unknown merchant result. Retire future authority
    // while retaining the original evidence needed to reconcile that result.
    if (operation.continuation && (settled || operation.abort.signal.aborted)) {
      if (!operation.source.revokeContinuation) throw new PaymentOperationStoreError('unavailable');
      await operation.source.revokeContinuation(operation.continuation);
      operation.continuation = undefined;
    }
    if (!settled || !this.requests || !operation.protectedRequest) return;
    await this.requests.remove(writer.purchaseId, status.operationId, () => writer.assertCurrent());
    operation.protectedRequest = false;
  }
  private current(operation: ActiveOperation): void {
    if (this.closed || this.active.get(operation.writer.purchaseId) !== operation) throw new CheckoutOwnershipError();
    operation.abort.signal.throwIfAborted(); operation.writer.assertCurrent(); operation.source.assertCurrent();
    requireDecisionFeature('automated checkout cart and merchant interpretation');
    operation.abort.signal.throwIfAborted();
  }
  private async run(input: BeginCheckoutInput, operation: ActiveOperation, execute = this.execute): Promise<void> {
    const { writer } = operation;
    try {
      this.current(operation);
      writer.update({ ...writer.read(), state: 'running', updatedAtMs: this.now() });
      const result = await execute(input, writer.purchaseId, { signal: operation.abort.signal,
        assertCurrent: () => this.current(operation), taintEvidence: operation.source.taintEvidence,
        ...(this.requests ? { retainWindowCheckpoint: checkpoint => this.checkpointWindow(input, operation, checkpoint) } : {}) });
      // Completion records facts even after owner cancellation; it grants no
      // further act. Actual journal phase wins over a generic refusal string.
      const entries = await this.journal.list(), retained = entries.find(row => row.purchaseId === writer.purchaseId);
      const previous = writer.read();
      const recorded = this.purchases.get(writer.purchaseId);
      const state = recorded ? 'completed' : retained?.phase === 'submit-pending' || retained?.phase === 'submitted' || previous.phase === 'submit-pending' || previous.phase === 'submitted'
        ? result.outcome.startsWith('challenge:') ? 'attention' : 'uncertain'
        : operation.abort.signal.aborted || result.outcome === 'cancelled' ? 'cancelled' : result.outcome.startsWith('refused') ? 'refused' : 'failed';
      writer.update({ ...previous, state, updatedAtMs: this.now(), outcome: recorded?.outcome ?? (state === 'cancelled' ? 'cancelled' : result.outcome),
        totalMinorUnits: recorded?.totalMinorUnits ?? result.totalMinorUnits ?? previous.totalMinorUnits,
        currency: recorded?.currency ?? result.currency ?? previous.currency });
    } catch (error) { await this.settleFailure(operation, error); }
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
    await save(writer.purchaseId, writer.read().operationId, checkpoint, browser, current);
    current();
    operation.history ??= this.retainHistory(writer, checkpoint);
  }

  private async settleFailure(operation: ActiveOperation, error: unknown): Promise<void> {
    const { writer } = operation, previous = writer.read();
    let state: PaymentOperationView['state'] = 'uncertain';
    let outcome: string | null = previous.outcome ?? (error instanceof JudgmentPortMissingError || error instanceof JudgmentError && error.kind === 'unavailable'
      ? 'decision-unavailable' : error instanceof DecisionModelsDisabledError ? 'decision-disabled'
        : error instanceof PaymentReplyWindowError && error.kind === 'source-unavailable' ? 'reply-source-unavailable'
          : error instanceof PaymentReplyWindowError && error.kind === 'history-unavailable' ? 'refused:reply-history-unavailable' : null);
    try {
      const entries = await this.journal.list(), retained = entries.find(row => row.purchaseId === writer.purchaseId);
      const recorded = this.purchases.get(writer.purchaseId);
      if (recorded) { state = 'completed'; outcome = recorded.outcome; }
      else if (retained?.phase === 'submit-pending' || retained?.phase === 'submitted' || previous.phase === 'submit-pending' || previous.phase === 'submitted') state = 'uncertain';
      else state = operation.abort.signal.aborted ? 'cancelled' : 'failed';
    } catch { /* Unreadable financial evidence remains uncertain. */ }
    writer.update({ ...previous, state, outcome, updatedAtMs: this.now() });
  }
  /** Called only after the real journal put is durably confirmed. */
  progress(record: InFlightCheckout): void {
    const operation = this.active.get(record.purchaseId); if (!operation) return;
    const previous = operation.writer.read();
    operation.writer.update({ ...previous, phase: record.phase, totalMinorUnits: record.totalMinorUnits,
      currency: record.currency, updatedAtMs: this.now() });
  }

  status(id?: string): readonly PaymentOperationView[] { return this.store.list(id); }
  cancel(id: string, operationId: string): PaymentOperationCancellation {
    if (this.closed) throw new CheckoutOwnershipError();
    const operation = this.active.get(id) ?? this.preparingRecovery.get(id); if (!operation) throw new PaymentOperationStoreError('busy');
    const previous = operation.writer.read();
    if (previous.operationId !== operationId || !isLivePaymentOperation(previous.state)) throw new PaymentOperationStoreError('invalid');
    operation.writer.update({ ...previous, state: 'cancelling', updatedAtMs: this.now() });
    operation.abort.abort(new CheckoutOwnershipError());
    return Object.freeze({ purchaseId: id, operationId, accepted: true,
      mayHaveSubmitted: previous.phase === 'submit-pending' || previous.phase === 'submitted' });
  }

  /** No receipt/status can resurrect an executor. Reconcile evidence after the
   * ordinary recovery sweep, retaining unknown submissions for inspection. */
  async recover(): Promise<void> {
    if (this.closed) throw new CheckoutOwnershipError();
    const entries = await this.journal.list();
    for (const entry of entries) this.reserved.add(entry.purchaseId);
    for (const previous of this.store.list()) {
      if (this.closed) throw new CheckoutOwnershipError();
      if (!isLivePaymentOperation(previous.state) && previous.state !== 'attention' && previous.state !== 'uncertain') continue;
      const writer = this.store.recover(previous.purchaseId); if (!writer) continue;
      try {
        const current = writer.read();
        if (!isDeepStrictEqual(current, previous)) continue;
        const retained = entries.find(row => row.purchaseId === current.purchaseId);
        let state: PaymentOperationView['state'] = 'uncertain', outcome = current.outcome;
        let total = current.totalMinorUnits, currency = current.currency;
        try {
          const recorded = this.purchases.get(current.purchaseId);
          if (recorded) { state = 'completed'; outcome = recorded.outcome; total = recorded.totalMinorUnits; currency = recorded.currency; }
          else if (current.phase !== 'submit-pending' && current.phase !== 'submitted'
            && (!retained || (retained.phase !== 'submit-pending' && retained.phase !== 'submitted'))) state = 'interrupted';
        } catch { /* Unknown evidence is never absence or permission to resubmit. */ }
        writer.update({ ...current, state, outcome, totalMinorUnits: total, currency, updatedAtMs: this.now() });
      } finally { writer.release(); }
    }
    if (this.closed) throw new CheckoutOwnershipError();
    this.recovered = true;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.closed = true;
    for (const operation of this.active.values()) operation.abort.abort(new CheckoutOwnershipError());
    for (const operation of this.preparingRecovery.values()) operation.abort.abort(new CheckoutOwnershipError());
    // Prepared leases not yet launched also belong to this registration.
    for (const [id, operation] of this.preparingRecovery) if (!operation.started) {
      this.preparingRecovery.delete(id);
      const cleanup = this.work.run(async () => { try { await operation.history?.retire(); } finally { operation.writer.release(); } });
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
