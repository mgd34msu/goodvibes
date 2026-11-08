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
import type { PaymentRequestHostFacts, PaymentRequestStore } from './protected-requests.js';

export interface DetachedCheckoutSource {
  readonly principalId: string;
  readonly assertCurrent: () => void;
  readonly taintEvidence?: RetainedTaintEvidence | undefined;
  readonly recoveryFacts?: PaymentRequestHostFacts | undefined;
}
export interface DetachedCheckoutOwner {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly taintEvidence?: RetainedTaintEvidence | undefined;
}
interface ActiveOperation {
  readonly writer: PaymentOperationWriter;
  readonly abort: AbortController;
  readonly source: DetachedCheckoutSource;
  protectedRequest: boolean;
}
export class CheckoutOperations {
  // Constructed with the registration, before request dispatch. Background
  // work must not inherit a request's tool proof, signal or notice sink.
  private readonly execution = new AsyncResource('GoodVibesPaymentOperations', { requireManualDestroy: true });
  private readonly work = new OwnedWork();
  private readonly active = new Map<string, ActiveOperation>();
  private readonly errors: unknown[] = [];
  private closed = false;
  private recovered = false;
  private readonly reserved = new Set<string>();
  private readonly requests: Pick<PaymentRequestStore, 'retain' | 'remove'> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly store: DurablePaymentOperations, private readonly journal: CheckoutJournal,
    private readonly purchases: DaemonPurchaseLedger,
    private readonly execute: (input: BeginCheckoutInput, id: string, owner: DetachedCheckoutOwner) => Promise<PaymentBeginResult>,
    private readonly now: () => number = Date.now,
    requests?: PaymentRequestStore) {
    // Retain the original host methods, rather than consulting a mutable
    // embed wrapper again after admission or during asynchronous cleanup.
    this.requests = requests ? Object.freeze({ retain: requests.retain.bind(requests), remove: requests.remove.bind(requests) }) : undefined;
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
    if (this.active.size >= 128) throw new PaymentOperationStoreError('busy');
    // Existing identities never create another executor, even after restart or
    // when a retry sends different input. The caller must query that exact ID.
    if (this.store.get(id) || this.purchases.get(id)) throw new PaymentOperationStoreError('exists');
    const captured = captureOwnedJson(input) as unknown as BeginCheckoutInput;
    // Copy host facts and bind the original reader before the handoff. An
    // embed mutating its source wrapper cannot replace evidence or a guard on
    // a later background tick. Native source factories already freeze theirs.
    source = Object.freeze({ principalId: source.principalId, assertCurrent: source.assertCurrent.bind(source),
      taintEvidence: source.taintEvidence === undefined ? undefined : captureOwnedJson(source.taintEvidence) as RetainedTaintEvidence,
      recoveryFacts: source.recoveryFacts === undefined ? undefined : captureOwnedJson(source.recoveryFacts) as PaymentRequestHostFacts });
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
    const active: ActiveOperation = { writer, source, abort: new AbortController(), protectedRequest: false };
    this.active.set(id, active);
    let launched = false;
    try {
      const preparing = () => { current(); active.abort.signal.throwIfAborted(); writer.assertCurrent(); };
      if (this.requests) {
        if (!source.taintEvidence || !source.recoveryFacts) throw new PaymentOperationStoreError('unavailable');
        await this.requests.retain({ version: 1, purchaseId: id, operationId: operation.operationId, principalId: source.principalId,
          input: captured, evidence: source.taintEvidence, host: source.recoveryFacts }, preparing);
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
          try { await this.releaseProtectedRequest(operation); }
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
    if (!this.requests || !operation.protectedRequest) return;
    const status = writer.read();
    const settled = ['refused', 'cancelled', 'failed'].includes(status.state)
      || status.state === 'completed' && (status.outcome === 'purchased' || status.outcome === 'refunded');
    if (!settled) return;
    await this.requests.remove(writer.purchaseId, status.operationId, () => writer.assertCurrent());
    operation.protectedRequest = false;
  }
  private current(operation: ActiveOperation): void {
    if (this.closed || this.active.get(operation.writer.purchaseId) !== operation) throw new CheckoutOwnershipError();
    operation.abort.signal.throwIfAborted(); operation.writer.assertCurrent(); operation.source.assertCurrent();
    requireDecisionFeature('automated checkout cart and merchant interpretation');
    operation.abort.signal.throwIfAborted();
  }
  private async run(input: BeginCheckoutInput, operation: ActiveOperation): Promise<void> {
    const { writer } = operation;
    try {
      this.current(operation);
      writer.update({ ...writer.read(), state: 'running', updatedAtMs: this.now() });
      const result = await this.execute(input, writer.purchaseId, { signal: operation.abort.signal,
        assertCurrent: () => this.current(operation), taintEvidence: operation.source.taintEvidence });
      // Completion records facts even after owner cancellation; it grants no
      // further act. Actual journal phase wins over a generic refusal string.
      const entries = await this.journal.list(), retained = entries.find(row => row.purchaseId === writer.purchaseId);
      const previous = writer.read();
      const recorded = this.purchases.get(writer.purchaseId);
      const state = recorded ? 'completed' : retained?.phase === 'submit-pending' || retained?.phase === 'submitted' || previous.phase === 'submit-pending' || previous.phase === 'submitted'
        ? result.outcome.startsWith('challenge:') ? 'attention' : 'uncertain'
        : result.outcome === 'cancelled' ? 'cancelled' : result.outcome.startsWith('refused') ? 'refused' : 'failed';
      writer.update({ ...previous, state, updatedAtMs: this.now(), outcome: recorded?.outcome ?? result.outcome,
        totalMinorUnits: recorded?.totalMinorUnits ?? result.totalMinorUnits ?? previous.totalMinorUnits,
        currency: recorded?.currency ?? result.currency ?? previous.currency });
    } catch (error) { await this.settleFailure(operation, error); }
  }
  private async settleFailure(operation: ActiveOperation, error: unknown): Promise<void> {
    const { writer } = operation, previous = writer.read();
    let state: PaymentOperationView['state'] = 'uncertain';
    let outcome: string | null = previous.outcome ?? (error instanceof JudgmentPortMissingError || error instanceof JudgmentError && error.kind === 'unavailable'
      ? 'decision-unavailable' : error instanceof DecisionModelsDisabledError ? 'decision-disabled' : null);
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
    const operation = this.active.get(id); if (!operation) throw new PaymentOperationStoreError('busy');
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
    void this.work.join().then(() => {
      this.execution.emitDestroy();
      if (this.errors.length) reject(new AggregateError(this.errors, 'Purchase operation metadata did not settle cleanly'));
      else resolve();
    }, reject);
    return this.closing;
  }
}
