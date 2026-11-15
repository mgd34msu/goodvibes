import { samePaymentEvidence } from '../evidence-equality.js';
import { OwnedWork } from '../../utils/owned-work.js';
import { CheckoutOwnershipError } from '../checkout-ownership.js';
import { canReconcilePaymentOperation, type PaymentOperationView } from '../operation-view.js';
import type { BudgetLedger, CheckoutBudgetSettlement, CheckoutBudgetSettlementOwner } from '../budget.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import type { CheckoutJournal } from '../checkout-registry.js';
import { PaymentOperationStoreError, type DurablePaymentOperations, type PaymentOperationWriter } from './operation-store.js';
import { capturePaymentReconciliation, type PaymentReconciliationOutcome, type PaymentReconciliationCheckpoint } from './reconciliation-checkpoint.js';
import type { DaemonPurchaseLedger } from './purchase-ledger.js';

interface ReconciliationDeps {
  readonly operations: DurablePaymentOperations;
  readonly journal: CheckoutJournal;
  readonly purchases: DaemonPurchaseLedger;
  readonly budget: BudgetLedger;
  readonly isPaymentsLeader: () => boolean;
  readonly now?: (() => number) | undefined;
  /** The end-of-purchase cleanup every settled purchase gets: its stored request and continuation go. */
  readonly settled?: ((purchaseId: string, operationId: string) => Promise<void>) | undefined;
}
function settlementReceipt(checkpoint: PaymentReconciliationCheckpoint): CheckoutBudgetSettlement {
  return { operationId: checkpoint.operationId, purchaseId: checkpoint.purchaseId, outcome: checkpoint.outcome,
    atMs: checkpoint.journal?.updatedAtMs ?? Date.parse(checkpoint.purchase?.atUtc ?? ''),
    reservation: checkpoint.reservation, spend: checkpoint.spend };
}
/** JSON equality validates disk facts; object identity retains the actual live
 * generation across awaits. Only the ledger's own synchronous transition may
 * replace these pins, using the exact objects it just created. */
function retainEvidence(deps: ReconciliationDeps, purchaseId: string, operationId: string, checkpoint: PaymentReconciliationCheckpoint | null) {
  const budget = deps.budget, state = budget.state, settle = budget.settleReconciliation, flush = budget.flush;
  const journal = deps.journal, list = journal.list, remove = journal.remove;
  const purchases = deps.purchases, get = purchases.get, record = purchases.recordOwnerReconciliation;
  const selection = () => {
    const current = state.call(budget);
    return { reservation: current.reservations.find(row => row.id === purchaseId) ?? null,
      spend: current.spend.find(row => row.purchaseId === purchaseId) ?? null,
      receipt: current.reconciliations?.find(row => row.operationId === operationId) ?? null };
  };
  let pinned = selection();
  if (checkpoint && (pinned.receipt ? !samePaymentEvidence(pinned.receipt, settlementReceipt(checkpoint))
    : !samePaymentEvidence({ reservation: pinned.reservation, spend: pinned.spend }, { reservation: checkpoint.reservation, spend: checkpoint.spend }))) {
    throw new PurchaseReconciliationError();
  }
  if (checkpoint && pinned.receipt) {
    const held = checkpoint.reservation;
    const expectedSpend = held ? (checkpoint.outcome === 'purchased' ? { purchaseId, atMs: settlementReceipt(checkpoint).atMs,
      itemMinorUnits: held.itemMinorUnits, overageMinorUnits: held.overageMinorUnits, toleranceMinorUnits: held.toleranceMinorUnits } : null) : checkpoint.spend;
    // A receipt proves the original once-only transition even after spend
    // pruning. It cannot adopt a new hold or a different current spend.
    if (pinned.reservation || (pinned.spend && !samePaymentEvidence(pinned.spend, expectedSpend))) throw new PurchaseReconciliationError();
  }
  let snapshot = captureOwnedJson(pinned);
  const methods = () => {
    if (budget.state !== state || budget.settleReconciliation !== settle || budget.flush !== flush
      || journal.list !== list || journal.remove !== remove || purchases.get !== get || purchases.recordOwnerReconciliation !== record) throw new PurchaseReconciliationError();
  };
  const assertCurrent = () => {
    methods(); const actual = selection(); methods();
    if (actual.reservation !== pinned.reservation || actual.spend !== pinned.spend || actual.receipt !== pinned.receipt
      || !samePaymentEvidence(actual, snapshot)) throw new PurchaseReconciliationError();
  };
  return Object.freeze({ assertCurrent,
    settle(receipt: CheckoutBudgetSettlement, current: () => void) {
      current();
      const owner: CheckoutBudgetSettlementOwner = { assertCurrent: current,
        settled(reservation, spend, recorded) {
          methods();
          if (!samePaymentEvidence(recorded, receipt) || reservation !== null
            || (!receipt.reservation && spend !== pinned.spend)) throw new PurchaseReconciliationError();
          pinned = { reservation, spend, receipt: recorded }; snapshot = captureOwnedJson(pinned);
          assertCurrent();
        } };
      settle.call(budget, receipt, owner); current();
    },
    flush(current: () => void) { current(); flush.call(budget, current); current(); },
  });
}
export class PurchaseReconciliationError extends Error {
  override readonly name = 'PurchaseReconciliationError';
  /** `reason` names what in the current evidence stops this finding; it
   * never quotes the evidence itself. */
  constructor(reason?: string) {
    super(`${reason ?? 'This purchase cannot be reconciled from its current payment evidence, which changed or does not match. Refresh its status and inspect the merchant history.'} No new order was submitted.`);
  }
}

/** Independent of sockets and browser drivers. The real execution lease must
 * be free before an owner can settle anything; bookkeeping never calls submit,
 * reserves replacement money, or converts a missing receipt into a no-charge. */
export class PurchaseReconciliations {
  private readonly work = new OwnedWork();
  private closed = false;
  private readonly deps: ReconciliationDeps;
  constructor(deps: ReconciliationDeps) { this.deps = Object.freeze({ ...deps }); }
  private current(): void {
    if (this.closed || !this.deps.isPaymentsLeader()) throw new CheckoutOwnershipError();
  }
  close(): Promise<void> { this.closed = true; return this.work.join(); }

  reconcile(purchaseId: string, operationId: string, outcome: PaymentReconciliationOutcome, principalId: string, authorized: () => void): Promise<PaymentOperationView> {
    return this.work.run(async () => {
      this.current(); authorized();
      const writer = this.deps.operations.recover(purchaseId);
      if (!writer) throw new PaymentOperationStoreError('busy');
      try {
        const operation = writer.read();
        if (operation.operationId !== operationId) throw new PurchaseReconciliationError(
          `That operationId is not purchase ${purchaseId}'s current operation. Read payments.purchase.status for the operationId to reconcile.`);
        let checkpoint = writer.reconciliation();
        if (checkpoint && checkpoint.outcome !== outcome) throw new PurchaseReconciliationError(
          `Your earlier finding for purchase ${purchaseId} (${checkpoint.outcome}) is already saved. Repeat that same finding to finish settling it.`);
        // Already settled: the spend and receipt may have been pruned since, so the evidence
        // pins below would fail a repeat of the same finding that should simply answer again.
        if (checkpoint && operation.outcome === `owner-confirmed-${checkpoint.outcome}`) return operation;
        const evidence = retainEvidence(this.deps, purchaseId, operationId, checkpoint);
        const current = () => { this.current(); authorized(); writer.assertCurrent(); evidence.assertCurrent(); };
        current();
        if (!checkpoint) {
          if (!canReconcilePaymentOperation(operation)) throw new PurchaseReconciliationError(
            `Purchase ${purchaseId} is ${operation.state}; only an uncertain, verification-pending or unverified submission can be reconciled.`);
          const records = await this.deps.journal.list(); current();
          const journal = records.find(row => row.purchaseId === purchaseId) ?? null;
          const purchase = this.deps.purchases.get(purchaseId);
          if (journal && !['submit-pending', 'submitted'].includes(journal.phase)) throw new PurchaseReconciliationError(
            `Purchase ${purchaseId}'s checkout journal shows it never reached submission, so there is no merchant order to confirm.`);
          if (!journal && !purchase) throw new PurchaseReconciliationError(
            `Purchase ${purchaseId} has neither a checkout journal entry nor a purchase record, so there is no submission to reconcile. Inspect the merchant history directly.`);
          const state = this.deps.budget.state(), reservation = state.reservations.find(row => row.id === purchaseId) ?? null;
          const spend = state.spend.find(row => row.purchaseId === purchaseId) ?? null;
          if ((!journal && !purchase) || (reservation && spend) || (!reservation && !spend && !purchase)) throw new PurchaseReconciliationError();
          // Saving this finding first would lock the owner to 'purchased' while settlement can never
          // charge the budget: neither a hold nor a spend exists to convert.
          if (outcome === 'purchased' && !reservation && !spend) throw new PurchaseReconciliationError(
            `Purchase ${purchaseId} has no budget hold and no recorded spend, so it cannot be settled as bought without leaving the budget uncharged. Nothing was saved.`);
          const draw = journal?.draw;
          if (reservation && (!draw || journal?.reservationId !== purchaseId || reservation.retainUntilSettled !== true
            || reservation.itemMinorUnits !== draw.itemMinorUnits || reservation.overageMinorUnits !== draw.overageMinorUnits
            || reservation.toleranceMinorUnits !== draw.toleranceMinorUnits)) throw new PurchaseReconciliationError();
          if (purchase && journal && (purchase.merchantDomain !== journal.merchantDomain || purchase.currency !== journal.currency
            || purchase.totalMinorUnits !== journal.totalMinorUnits)) throw new PurchaseReconciliationError();
          checkpoint = capturePaymentReconciliation({ purchaseId, operationId, outcome, principalId,
            atMs: (this.deps.now ?? Date.now)(), journal, purchase, reservation, spend });
          current(); writer.beginReconciliation(checkpoint, current); current();
        }
        return await this.settle(writer, checkpoint, current, evidence);
      } finally { writer.release(); }
    });
  }

  /** Resume only a durable, explicit owner finding. This grants no merchant
   * effect, and original execution remains excluded by the same strict lease. */
  async recover(): Promise<void> {
    this.current();
    for (const operation of this.deps.operations.list()) {
      if (!operation.outcome?.startsWith('owner-reconciliation-pending-')) continue;
      await this.work.run(async () => {
        this.current(); const writer = this.deps.operations.recover(operation.purchaseId); if (!writer) return;
        try {
          const checkpoint = writer.reconciliation();
          if (checkpoint) {
            const evidence = retainEvidence(this.deps, operation.purchaseId, operation.operationId, checkpoint);
            const current = () => { this.current(); writer.assertCurrent(); evidence.assertCurrent(); };
            await this.settle(writer, checkpoint, current, evidence);
          }
        } catch { /* Keep the durable finding and original hold/evidence unresolved. */ }
        finally { writer.release(); }
      });
    }
  }

  private async settle(writer: PaymentOperationWriter, checkpoint: PaymentReconciliationCheckpoint, current: () => void,
    evidence: ReturnType<typeof retainEvidence>): Promise<PaymentOperationView> {
    current();
    if (writer.read().outcome === `owner-confirmed-${checkpoint.outcome}`) return writer.read();
    const originals = await this.deps.journal.list(); current();
    const original = originals.find(row => row.purchaseId === checkpoint.purchaseId) ?? null;
    const settled = this.deps.budget.state().reconciliations?.some(row => row.operationId === checkpoint.operationId) === true;
    if ((original && !samePaymentEvidence(original, checkpoint.journal)) || (!original && checkpoint.journal && !settled)
      || !samePaymentEvidence(this.deps.purchases.get(checkpoint.purchaseId), checkpoint.purchase)) throw new PurchaseReconciliationError();
    // The owner's observation is a distinct append-only audit event. Original
    // receipts and their unverified/verified provenance remain untouched.
    await this.deps.purchases.recordOwnerReconciliation(checkpoint, current); current();
    evidence.settle(settlementReceipt(checkpoint), current);
    // The settlement and its once-only receipt share one durable budget write.
    // Its receipt survives spend pruning and reconnect/restart retries.
    evidence.flush(current);
    const records = await this.deps.journal.list(); current();
    const journal = records.find(row => row.purchaseId === checkpoint.purchaseId);
    if (journal) {
      if (!samePaymentEvidence(journal, checkpoint.journal)) throw new PurchaseReconciliationError();
      await this.deps.journal.remove(checkpoint.purchaseId); current();
    }
    const operation: PaymentOperationView = { ...writer.read(), state: 'completed',
      outcome: `owner-confirmed-${checkpoint.outcome}`, updatedAtMs: (this.deps.now ?? Date.now)(),
      totalMinorUnits: (checkpoint.journal ?? checkpoint.purchase)?.totalMinorUnits ?? null,
      currency: (checkpoint.journal ?? checkpoint.purchase)?.currency ?? null };
    writer.update(operation, current); current();
    const settled = writer.read();
    // Settled by the owner's finding: the request kept as evidence until now
    // has no further use. A failed removal leaves it for the next start's sweep.
    try { await this.deps.settled?.(settled.purchaseId, settled.operationId); }
    catch { /* The boot sweep removes it. */ }
    return settled;
  }
}
