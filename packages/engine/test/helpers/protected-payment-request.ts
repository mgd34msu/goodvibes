import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { readPaymentsServiceConfig } from '../../sdk/src/platform/payments/payments-config.js';
import type { ProtectedPaymentRequest } from '../../sdk/src/platform/payments/host/protected-requests.js';
import { retainTaintEvidence, UntrustedContentLedger } from '../../sdk/src/platform/security/untrusted-content.js';

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
