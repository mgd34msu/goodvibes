/**
 * A shop's confirmation mail settling a submission its landing page did not
 * confirm. The purchase row and the purchase's operation move together, under
 * the operation's lease, so an owner's reconciliation can never start between
 * them and status answers the same as the purchase history.
 */
import type { DaemonPurchaseLedger } from './purchase-ledger.js';
import type { DurablePaymentOperations } from './operation-store.js';

export interface PurchaseConfirmationDeps {
  readonly purchases: Pick<DaemonPurchaseLedger, 'recordConfirmed' | 'get'>;
  readonly operations: Pick<DurablePaymentOperations, 'get' | 'recover'>;
  readonly now?: (() => number) | undefined;
}

/**
 * Move a `submitted-unverified` purchase to `purchased`. True only when this
 * call moved it, so the caller tells the owner once. False
 * when the purchase is not unverified, the owner already recorded or is
 * recording a finding, or its operation is held by another owner right now
 * (a later mail from the shop tries again).
 */
export async function confirmSubmittedPurchase(deps: PurchaseConfirmationDeps, purchaseId: string, merchantOrderId: string | null,
  ownerNotice?: string): Promise<boolean> {
  // A purchase from before operation records existed has only its row.
  if (deps.operations.get(purchaseId) === null) return deps.purchases.recordConfirmed(purchaseId, merchantOrderId, ownerNotice);
  const writer = deps.operations.recover(purchaseId);
  if (writer === null) return false;
  try {
    const operation = writer.read();
    if (writer.reconciliation() !== null || operation.state !== 'completed' || operation.outcome !== 'submitted-unverified') return false;
    const changed = await deps.purchases.recordConfirmed(purchaseId, merchantOrderId, ownerNotice);
    // A row moved by an earlier attempt whose operation write failed (so the
    // owner was never told) still brings its operation along.
    if (!changed && deps.purchases.get(purchaseId)?.outcome !== 'purchased') return false;
    writer.update({ ...operation, outcome: 'purchased', updatedAtMs: (deps.now ?? Date.now)() });
    return true;
  } finally { writer.release(); }
}
