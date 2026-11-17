/**
 * An order cannot be placed around the spending limits. A merchant's saved
 * payment method lets one click on "Place order" charge the card, so the
 * ordinary `browser` tool refuses any action that would take the order: a
 * click on a control whose label places one (button, scripted role=button,
 * link), Enter pressed in the order form, and text typed with submit. Only the
 * payment flow's own submit, which runs under the owner's limits, presses it.
 *
 * This file: a click on each order label. Enter, submit and the payment flow's
 * own submit are in payments-unbudgeted-keys.test.ts.
 *
 * Real path: the settings manager with the owner's mode set to yolo, so the
 * gate admits every browser call and asks no one; the permission manager,
 * tool registry and tool-batch executor; the `browser` tool over the daemon's
 * own browser composition; a real headless Chromium. The merchant is a
 * loopback server that records every POST, so "no order was placed" is read
 * from what arrived. Jev answers through a fixture port that reads no page as
 * a sign-in page.
 *
 * The one arrangement outside the product: the machine's installed Chromium is
 * linked where the product's browser cache expects its own build, so the
 * product finds a browser without downloading one (the suite has no network).
 */
import { expect, test } from 'bun:test';
import { useCheckoutBrowser } from './payments-unbudgeted-support.ts';

const checkout = useCheckoutBrowser();

test.each(['Place order', 'Pay now', 'Buy now', 'Zahlungspflichtig bestellen'])(
  'a click on "%s" through the browser tool is refused although the gate admitted it, and no order reaches the merchant',
  async name => {
    const refs = await checkout.openCheckout();
    expect(refs.get(name)).toBeDefined();
    checkout.expectOrderRefusal(await checkout.call({ action: 'click', ref: refs.get(name) }));
    await checkout.expectNoOrderReachedTheMerchant(refs);
    expect(checkout.ownerAsked()).toBe(0);
  },
);
