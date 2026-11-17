/**
 * An order cannot be placed around the spending limits by keyboard: Enter
 * pressed in the order form and text typed with submit are refused by the
 * ordinary `browser` tool, and only the payment flow's own submit, which runs
 * under the owner's limits, places the order. Clicks on order labels are in
 * payments-unbudgeted-path.test.ts; the real path is described in
 * payments-unbudgeted-support.ts.
 */
import { expect, test } from 'bun:test';
import { markPaymentCheckoutAction } from '../platform/src/platform/security/order-submission.ts';
import { useCheckoutBrowser } from './payments-unbudgeted-support.ts';

const checkout = useCheckoutBrowser();

test('Enter in the order form and text typed with submit are refused, and no order reaches the merchant', async () => {
  const refs = await checkout.openCheckout();
  checkout.expectOrderRefusal(await checkout.call({ action: 'press', ref: refs.get('Gift note'), key: 'Enter' }));
  checkout.expectOrderRefusal(await checkout.call({ action: 'type', ref: refs.get('Gift note'), text: 'Happy birthday', submit: true }));
  checkout.expectOrderRefusal(await checkout.call({ action: 'type', ref: refs.get('Gift note'), text: 'Happy birthday\n', replace: false }));
  await checkout.expectNoOrderReachedTheMerchant(refs);
  expect(checkout.ownerAsked()).toBe(0);
});

test('the payment flow\'s own submit is the one path that places the order', async () => {
  const refs = await checkout.openCheckout();
  const ordered = checkout.merchant().next('/order');
  const ownership = { assertCurrent: () => {} };
  markPaymentCheckoutAction(ownership);
  await checkout.browser().click({}, { ref: refs.get('Pay now')! }, ownership);
  await ordered;
  expect(checkout.merchant().orders()).toEqual([{ path: '/order', body: 'pay-now' }]);
});
