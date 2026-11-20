// Proves: A declined payment is recorded as an order, a card number is stored as an order number, or an unreadable page turns a submitted purchase into a failed one.
// Red when: The decline check runs after the order-number match, a card-shaped number is taken as the order id, or a page read that throws turns a charged purchase into a failed submit.
import { describe, expect, test } from 'bun:test';
import { describeCheckoutLanding, readOrderConfirmation, type CheckoutLandingEngine } from '../platform/src/platform/payments/checkout-landing.ts';

describe('the page a submitted checkout landed on', () => {
  test('a decline names no order, whatever else the page says', () => {
    expect(readOrderConfirmation('Thank you for your order! Order number: AB-10293. Your payment was declined, please try again.', true)).toEqual({ orderId: null, challenge: null });
  });

  test('a card-shaped number is never taken as the order number', () => {
    expect(readOrderConfirmation('Order confirmed. Order number 4111111111111111', true)).toEqual({ orderId: null, challenge: null, confirmed: true, totalShown: false });
  });

  test('a page that cannot be read leaves the purchase unverified rather than failing the submit', async () => {
    const engine = {
      readText: async () => { throw new Error('the card is still on this page'); },
      snapshot: async () => { throw new Error('the page is gone'); },
    } as unknown as CheckoutLandingEngine;
    const describe = describeCheckoutLanding(async () => engine);
    expect(await describe({ url: 'https://shop.example/thanks', navigated: true, target: {} })).toEqual({ orderId: null, challenge: null });
  });
});
