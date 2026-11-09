/** An owner's observation about an existing submission, never permission to
 * submit. Retain the original evidence and exact accounting generation before
 * changing any other file, so interrupted bookkeeping can resume honestly. */
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { captureCheckoutRecord } from '../checkout-record.js';
import { capturePurchaseRecord } from '../purchase-record-codec.js';
import type { InFlightCheckout } from '../checkout-registry.js';
import type { PurchaseRecord } from '../purchase-record.js';
import type { BudgetReservation, SpendRecord } from '../budget.js';

export type PaymentReconciliationOutcome = 'purchased' | 'not-purchased';
export interface PaymentReconciliationCheckpoint {
  readonly purchaseId: string;
  readonly operationId: string;
  readonly outcome: PaymentReconciliationOutcome;
  readonly principalId: string;
  readonly atMs: number;
  readonly journal: InFlightCheckout | null;
  readonly purchase: PurchaseRecord | null;
  readonly reservation: BudgetReservation | null;
  readonly spend: SpendRecord | null;
}
export function capturePaymentReconciliation(value: unknown): PaymentReconciliationCheckpoint {
  const captured = captureOwnedJson(value);
  const fail = (): never => { throw new Error('Original purchase reconciliation evidence is unavailable.'); };
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return fail();
  const row = captured as Record<string, unknown>;
  if (Object.keys(row).length !== 9
    || !['purchaseId', 'operationId', 'principalId'].every(key => typeof row[key] === 'string' && row[key].trim().length > 0)
    || (row.outcome !== 'purchased' && row.outcome !== 'not-purchased')
    || typeof row.atMs !== 'number' || !Number.isSafeInteger(row.atMs) || row.atMs < 0 || row.atMs > 8_640_000_000_000_000) return fail();
  const journal = row.journal === null ? null : captureCheckoutRecord(row.journal);
  const purchase = row.purchase === null ? null : capturePurchaseRecord(row.purchase);
  if ((row.journal !== null && !journal) || (row.purchase !== null && !purchase) || (!journal && !purchase)
    || (journal && (journal.purchaseId !== row.purchaseId || !['submit-pending', 'submitted'].includes(journal.phase)
      || !journal.draw || journal.reservationId !== row.purchaseId || journal.totalMinorUnits === null
      || journal.draw.totalMinorUnits !== journal.totalMinorUnits
      || journal.draw.itemMinorUnits + journal.draw.overageMinorUnits + journal.draw.toleranceMinorUnits !== journal.totalMinorUnits))
    || (purchase && (purchase.purchaseId !== row.purchaseId || !['purchased', 'submitted-unverified', 'refunded'].includes(purchase.outcome)))
    || (journal && purchase && (journal.totalMinorUnits !== purchase.totalMinorUnits || journal.currency !== purchase.currency
      || journal.merchantDomain !== purchase.merchantDomain))) return fail();
  const amount = (item: unknown): boolean => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  for (const key of ['reservation', 'spend'] as const) {
    const entry = row[key];
    if (entry === null) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail();
    const data = entry as Record<string, unknown>;
    if (!['itemMinorUnits', 'overageMinorUnits', 'toleranceMinorUnits'].every(field => amount(data[field]))) return fail();
    if (key === 'reservation') {
      if (data.id !== row.purchaseId || data.retainUntilSettled !== true || typeof data.dayKey !== 'string'
        || !amount(data.createdAtMs) || !amount(data.expiresAtMs)) return fail();
    } else if (data.purchaseId !== row.purchaseId || !amount(data.atMs)) return fail();
    const draw = journal?.draw;
    if (draw && (data.itemMinorUnits !== draw.itemMinorUnits || data.overageMinorUnits !== draw.overageMinorUnits
      || data.toleranceMinorUnits !== draw.toleranceMinorUnits)) return fail();
    if (!draw && purchase && (data.itemMinorUnits !== purchase.itemPoolDraw || data.overageMinorUnits !== purchase.overagePoolDraw
      || data.toleranceMinorUnits !== purchase.tolerancePoolDraw)) return fail();
  }
  if (row.reservation !== null && row.spend !== null) return fail();
  return row as unknown as PaymentReconciliationCheckpoint;
}
