import type { ProtectedPaymentRequest } from '../../sdk/src/platform/payments/host/protected-requests.js';
import type { CheckoutWindowCheckpoint } from '../../sdk/src/platform/payments/checkout-window-checkpoint.js';
import { unsafeOwnerSuppliedTextForTests, parseCurrencyCode } from '../../sdk/src/platform/payments/types.js';

export function protectedPaymentWindow(request: ProtectedPaymentRequest, updatedAtMs = 2): CheckoutWindowCheckpoint {
  const currency = parseCurrencyCode('USD'); if (!currency) throw new Error('Fixture currency');
  return {
    reading: { ...request.input.reading, lines: [{ label: 'owner item', quantity: '1', unitPrice: '20.00' }], statedTotal: '20.00' },
    record: { purchaseId: request.purchaseId, sessionId: request.input.sessionId, pageId: request.input.pageId,
      merchantDomain: request.input.merchantDomain, cardId: request.input.cardId, item: unsafeOwnerSuppliedTextForTests(request.input.item),
      currency, phase: 'awaiting-window', startedAtMs: 1, updatedAtMs,
      draw: { itemMinorUnits: 2_000, overageMinorUnits: 0, toleranceMinorUnits: 0, totalMinorUnits: 2_000 },
      reservationId: request.purchaseId, shippingTierRequested: 'normal', shippingTierUsed: 'normal', stepDown: null,
      totalMinorUnits: 2_000, windowKind: 'approval', windowDeadlineMs: 100_000, windowNotice: 'Approve the actual twenty dollar quote.',
      windowDeliveries: [{ channel: 'telegram', delivered: true, backfillable: false,
        receipt: { surfaceKind: 'telegram', conversationId: '-100123', messageId: '51', accountId: '123' } }] },
  };
}
