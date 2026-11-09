/** Synthetic owner request/window data for actual payment boundary tests.
 * These objects are fixtures, never native pairing/browser/continuation proof.
 * The explicit fixture owner-text cast retains exact original bytes; real
 * consumers must independently establish their normal owner/provenance guards.
 */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { readPaymentsServiceConfig, parseCurrencyCode, type ProtectedPaymentRequest,
  type CheckoutWindowCheckpoint, type OwnerSuppliedText } from '@goodvibes-jev/engine/platform/platform/payments';
import { retainTaintEvidence, UntrustedContentLedger } from '@goodvibes-jev/engine/platform/platform/security';

export function protectedPaymentRequest(purchaseId = 'original-owner-request'): ProtectedPaymentRequest {
  const ledger = new UntrustedContentLedger();
  ledger.record({ surface: 'web-page', origin: 'https://fixture.invalid/item', at: '2026-11-08T00:00:00Z', content: 'Original private page evidence.' });
  return {
    version: 1, purchaseId, operationId: `payment-operation:${opaqueUuid()}`, principalId: 'pairing:fixture-owner',
    input: { sessionId: 'original-session', pageId: 'original-page', merchantDomain: 'fixture.invalid',
      checkoutUrl: 'https://fixture.invalid/checkout', item: 'Original private owner instruction', cardId: 'card-reference-only',
      requestedLines: [{ label: 'owner item', quantity: 1 }], requestedMax: '0.00', preferredTier: undefined,
      reading: { lines: [{ label: 'owner item', quantity: '1', unitPrice: '10.00' }], tax: null, fees: [],
        shippingOptions: [{ label: 'normal', cost: '0.00' }], statedTotal: null, currency: 'USD', orderSummaryText: 'Original private checkout summary' },
      controls: { cardFields: [{ field: 'number', ref: 'original-card-field' }], addressFields: undefined,
        placeOrderTarget: 'original-submit', expirySeparator: '', twoDigitYear: false } },
    evidence: retainTaintEvidence(ledger),
    host: { authority: { kind: 'pairing-token', principalId: 'pairing:fixture-owner', tokenId: 'fixture-owner', authorityId: 'fixture-authority',
      authorityRevision: 'original-pairing-revision', scopes: ['read:payments', 'write:payments'] },
      configuration: readPaymentsServiceConfig({ get: () => undefined }) },
  };
}

export function protectedPaymentWindow(request: ProtectedPaymentRequest, updatedAtMs = 2): CheckoutWindowCheckpoint {
  const currency = parseCurrencyCode('USD'); if (!currency) throw new Error('Fixture currency');
  return {
    reading: { ...request.input.reading, lines: [{ label: 'owner item', quantity: '1', unitPrice: '20.00' }], statedTotal: '20.00' },
    record: { purchaseId: request.purchaseId, sessionId: request.input.sessionId, pageId: request.input.pageId,
      merchantDomain: request.input.merchantDomain, cardId: request.input.cardId, item: request.input.item as OwnerSuppliedText,
      currency, phase: 'awaiting-window', startedAtMs: 1, updatedAtMs,
      draw: { itemMinorUnits: 2_000, overageMinorUnits: 0, toleranceMinorUnits: 0, totalMinorUnits: 2_000 },
      reservationId: request.purchaseId, shippingTierRequested: 'normal', shippingTierUsed: 'normal', stepDown: null,
      totalMinorUnits: 2_000, windowKind: 'approval', windowDeadlineMs: 100_000, windowNotice: 'Approve the actual twenty dollar quote.',
      windowDeliveries: [{ channel: 'telegram', delivered: true, backfillable: false,
        receipt: { surfaceKind: 'telegram', conversationId: '-100123', messageId: '51', accountId: '123' } }] },
  };
}
