/**
 * An order cannot be placed around the spending limits. A merchant's saved
 * payment method lets one click on "Place order" charge the card, so the
 * ordinary browser tools refuse a click on any control whose label places an
 * order, whatever its markup, and name the budgeted path instead; only the
 * payment flow's own submit may press it.
 *
 * Real `BrowserEngine` admission (snapshot, ref resolution, the order check
 * and the outward-effect check). The browser page is the stand-in: it serves
 * the merchant's controls and records every effect that would reach the
 * merchant, so "nothing was clicked" is read from what arrived.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { BrowserEngine } from '../platform/src/platform/browser/browser-engine.ts';
import type { resolveRef } from '../platform/src/platform/browser/browser-snapshot.ts';
import type { CardFieldGuard } from '../platform/src/platform/browser/browser-types.ts';
import { BrowserSessionError, type BrowserSessionManager } from '../platform/src/platform/browser/browser-sessions.ts';
import { markPaymentCheckoutAction, ORDER_SUBMIT_REFUSAL_FIX } from '../platform/src/platform/security/order-submission.ts';

type Page = Parameters<typeof resolveRef>[0];

let previous: ReturnType<typeof installJudgmentPort>;
// Jev reads no page here as a sign-in page; the order check is code and asks nothing.
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port); });
afterEach(() => { installJudgmentPort(previous); });

/** One checkout page with one control; `effects` is everything that reached the merchant. */
function checkoutPage(control: { readonly tag: string; readonly role: string; readonly name: string; readonly submits: boolean }) {
  const url = 'https://shop.example/checkout';
  const effects: string[] = [];
  const descriptor = { tag: control.tag, name: control.name, submits: control.submits, type: '', disabled: false, role: null, documentUrl: url,
    attributes: { name: null, id: '', autocomplete: null, ariaLabel: null, labelledBy: null, labelText: '', placeholder: null, title: null } };
  const locator = {
    first: () => locator,
    count: async () => 1,
    evaluate: async (fn: { readonly name: string }) => fn.name === 'describeElement' ? { ...descriptor } : undefined,
    click: async () => { effects.push('click'); }, fill: async () => { effects.push('fill'); },
    pressSequentially: async () => { effects.push('type'); }, press: async (key: string) => { effects.push(`press ${key}`); },
    selectOption: async () => { effects.push('select'); return []; }, scrollIntoViewIfNeeded: async () => {},
  };
  const attributes = { type: '', autocomplete: '', name: '', id: '', placeholder: '', ariaLabel: '', label: '' };
  const raw = () => [{ tag: control.tag, role: control.role, name: control.name, selector: '#control', value: null, disabled: false, checked: null, depth: 1, submits: control.submits }];
  const rows = () => raw().map(row => ({ ...row, documentUrl: url, control: attributes }));
  const frame = { parentFrame: () => null, evaluate: async (_fn: unknown, arg?: unknown) =>
    arg && typeof arg === 'object' && 'identityOnly' in arg && arg.identityOnly === true ? { url, title: 'Checkout', elements: rows() } : raw() };
  const page = { url: () => url, locator: () => locator, title: async () => 'Checkout', frames: () => [frame], mainFrame: () => frame,
    waitForLoadState: async () => {}, frameLocator: () => page, close: async () => {}, on: () => page, off: () => page } as unknown as Page;
  const lifetime = new AbortController();
  const sessions = {
    defaultSessionId: () => 'b1',
    page: async () => ({ pageId: 'p1', page }),
    pageList: async () => [],
    provisionReport: () => null,
    async withPage<T>(_sessionId: string, _pageId: string, read: (selected: Page, assertCurrent: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
      return read(page, () => lifetime.signal.throwIfAborted(), lifetime.signal);
    },
    async closePage(): Promise<void> { lifetime.abort(); },
  } as unknown as BrowserSessionManager;
  const guard: CardFieldGuard = { disarm: () => {}, hasLiveMaterial: () => false, redact: (_s: string, _p: string, text: string) => text };
  const engine = new BrowserEngine(sessions, { screenshotDirectory: '/nonexistent', cardFieldGuard: guard, untrusted: {
    rule: 'test', originOf: () => 'shop.example', recordIngest: () => {},
    label: input => ({ trust: 'untrusted', surface: 'web-page', origin: input.origin, retrievedAt: 'synthetic', text: input.text, truncated: input.truncated === true, rule: 'test' }),
    evaluateOutwardEffect: async () => ({ allowed: true, reason: null, fix: null, untrustedOrigins: [] }),
  } });
  return { engine, effects };
}

test.each([
  { tag: 'button', role: 'button', name: 'Place order', submits: true },
  { tag: 'div', role: 'button', name: 'Pay now', submits: false },
  { tag: 'a', role: 'link', name: 'Buy now', submits: false },
  { tag: 'button', role: 'button', name: 'Zahlungspflichtig bestellen', submits: true },
])('a click on "$name" through the browser tools is refused and reaches nothing', async control => {
  const page = checkoutPage(control);
  await page.engine.snapshot({});
  const refused = await page.engine.click({}, { ref: 'e1' }).then(() => null, (error: unknown) => error);
  // Refused for placing an order, with the budgeted path as the way forward.
  expect(refused).toBeInstanceOf(BrowserSessionError);
  expect((refused as BrowserSessionError).fix).toBe(ORDER_SUBMIT_REFUSAL_FIX);
  expect(page.effects).toEqual([]);
});

test('the payment flow\'s own submit is the one path that presses it', async () => {
  const page = checkoutPage({ tag: 'button', role: 'button', name: 'Place order', submits: true });
  await page.engine.snapshot({});
  const ownership = {};
  markPaymentCheckoutAction(ownership);
  await page.engine.click({}, { ref: 'e1' }, ownership);
  expect(page.effects).toEqual(['click']);
});

test('a control that does not place an order is clicked as usual', async () => {
  const page = checkoutPage({ tag: 'button', role: 'button', name: 'Apply coupon', submits: false });
  await page.engine.snapshot({});
  await page.engine.click({}, { ref: 'e1' });
  expect(page.effects).toEqual(['click']);
});
