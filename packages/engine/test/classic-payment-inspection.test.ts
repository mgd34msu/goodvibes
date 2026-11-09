import { afterEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { isCardFieldDescriptor, type FormControlDescriptor } from '../platform/src/platform/security/card-fields.js';
import { evaluateCardEntry, scanForCardDetails } from '../platform/src/platform/payments/entry-surface.js';
import { assertCartMatchesRequest, detectRecurringCharge } from '../platform/src/platform/payments/cart.js';
import { readShippingTiers, walkShippingLadder } from '../platform/src/platform/payments/shipping.js';
import { judgeMerchant } from '../platform/src/platform/payments/merchant-judge-model.js';
import { readPaymentReply } from '../platform/src/platform/payments/notice-delivery.js';
import { correlatePurchaseMail, extractConfirmationFacts } from '../platform/src/platform/payments/order-correlation.js';

let prior: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(prior); installed = false; });
function install(port: JudgmentPort) { prior = installJudgmentPort(port); installed = true; }
function control(tag = 'input'): FormControlDescriptor {
  return { tag, type: 'text', autocomplete: '', name: 'query', id: 'query', placeholder: 'Search', ariaLabel: '', label: 'Search' };
}

test('Classic browser value protection and card entry need no decision model metadata or requests', async () => {
  let metadata = 0, requests = 0;
  install({ get model(): never { metadata++; throw new Error('Unexpected model metadata'); },
    get recorder(): never { metadata++; throw new Error('Unexpected semantic recorder'); },
    async ask() { requests++; throw new Error('Unexpected decision request'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    // The boolean means suppress this value; it does not certify what the field means.
    expect(await isCardFieldDescriptor(control())).toBe(true);
    expect(await isCardFieldDescriptor(control('textarea'))).toBe(true);
    expect(await isCardFieldDescriptor(control('select'))).toBe(true);
    expect(await isCardFieldDescriptor(control('button'))).toBe(false);
    expect(await scanForCardDetails('482', { expectingCvv: true })).toEqual({ looksLikeCardDetails: true, matched: ['cvv'] });
    expect(await scanForCardDetails('482')).toEqual({ looksLikeCardDetails: false, matched: [] });
    expect(await evaluateCardEntry({ surface: 'telegram', text: '482', expectingCvv: true })).toMatchObject({
      allowed: false, matched: ['cvv'],
    });
    expect(await evaluateCardEntry({ surface: 'tui', text: '482', expectingCvv: true })).toMatchObject({
      allowed: true, matched: ['cvv'],
    });
  });
  expect({ metadata, requests }).toEqual({ metadata: 0, requests: 0 });
});

test('Preferred form-value inspection falls back only on actual availability exhaustion', async () => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    expect(await isCardFieldDescriptor(control())).toBe(true);
    expect(decisionModelPolicyState().operation).toBe('classic');
    expect(await isCardFieldDescriptor(control('textarea'))).toBe(true);
  });
  expect(fake.requests).toHaveLength(1);
});

test.each(['rejected', 'invalid-request', 'invalid-response', 'aborted'] as const)(
  'Preferred form-value inspection preserves %s without changing policy', async kind => {
    const failure = new JudgmentError(kind, 'Synthetic terminal decision failure');
    const fake = fakePort(() => { throw failure; }); install(fake.port);
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await expect(isCardFieldDescriptor(control())).rejects.toBe(failure);
      expect(decisionModelPolicyState().operation).toBe('decision');
    });
  },
);

test('Classic exposes semantic payment limits before interpretation while retaining native budget arithmetic', async () => {
  const fake = fakePort(() => { throw new Error('Must not ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const mail = { senderAddress: 'shop@example.com', receivedAtMs: 0, subject: 'Order', body: 'Untrusted mail' };
    for (const operation of [
      () => assertCartMatchesRequest([], []),
      () => detectRecurringCharge('Checkout'),
      () => readShippingTiers([{ rawLabel: 'Delivery', costMinorUnits: 100 }], 'USD'),
      () => judgeMerchant({ registrableDomain: 'example.com' }),
      () => readPaymentReply('yes', 'approval', 'Purchase notice'),
      () => correlatePurchaseMail(mail, []),
      () => extractConfirmationFacts(mail),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'decision-models-disabled' });
    const option = { rawLabel: 'Explicit owner-selected delivery', costMinorUnits: 100 };
    expect(walkShippingLadder({ preferred: 'normal', tiers: new Map([['normal', option]]),
      fixedUnavoidableMinorUnits: 50, budgetForOverageMinorUnits: 150 })).toMatchObject({ option, rungsTried: 1 });
  });
  expect(fake.requests).toHaveLength(0);
});
