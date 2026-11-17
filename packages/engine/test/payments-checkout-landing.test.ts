import { describe, expect, test } from 'bun:test';
import { describeCheckoutLanding, readOrderConfirmation, type CheckoutLandingEngine } from '../platform/src/platform/payments/checkout-landing.ts';

describe('the page a submitted checkout landed on', () => {
  test('a thank-you page with an order number verifies the purchase with that number', () => {
    expect(readOrderConfirmation('Thank you for your order!\nOrder number: AB-10293', true)).toEqual({ orderId: 'AB-10293', challenge: null });
  });

  test('a decline names no order, whatever else the page says', () => {
    expect(readOrderConfirmation('Thank you for your order! Order number: AB-10293. Your payment was declined, please try again.', true)).toEqual({ orderId: null, challenge: null });
  });

  test('a card-shaped number is never taken as the order number', () => {
    expect(readOrderConfirmation('Order confirmed. Order number 4111111111111111', true)).toEqual({ orderId: null, challenge: null, confirmed: true });
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
