import { expect, test } from 'bun:test';
import { checkPaymentGates } from '../platform/src/platform/payments/gates.js';
import { paymentOperationDescription } from '../platform/src/platform/payments/operation-view.js';

const passing = { enabled: true, hasUsableCard: true, hasShippingAddress: true, isOwnerDirectRequest: true, isPaymentsLeader: true };

test('a clustered daemon is refused with the reason and the way out, not an election that does not exist', () => {
  const refusal = checkPaymentGates({ ...passing, isPaymentsLeader: false });
  expect(refusal?.code).toBe('disabled');
  expect(refusal?.reason).toContain('cluster');
  expect(refusal?.reason).toContain('cluster.enabled');
  expect(refusal?.reason).not.toContain('elected');
});

test('a card withheld by cvvHandling prompt is refused naming that setting', () => {
  const refusal = checkPaymentGates({ ...passing, hasUsableCard: false, cardWithheldByCvvPrompt: true });
  expect(refusal?.code).toBe('no-card');
  expect(refusal?.reason).toContain('payments.cvvHandling');
});

test('a missing card still gets the plain refusal when the prompt setting is not the cause', () => {
  expect(checkPaymentGates({ ...passing, hasUsableCard: false })?.reason).not.toContain('cvvHandling');
});

test('the stored status of a no-card refusal names the cvv setting as a possible cause', () => {
  const text = paymentOperationDescription({ purchaseId: 'p', operationId: 'o', state: 'refused', phase: null, createdAtMs: 1,
    updatedAtMs: 1, outcome: 'refused:no-card', totalMinorUnits: null, currency: null });
  expect(text).toContain('payments.cvvHandling');
});
