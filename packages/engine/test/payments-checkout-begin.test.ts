// Proves: A purchase skips its window on something only the host may say: a host-only field in the begin body, a missing or mismatched approval while "confirm every purchase" is on, or an approval for a smaller amount.
// Red when: The begin handler takes an approved maximum or a standing authorisation from the request body, admits a begin with no matching owner approval while every purchase must be confirmed, lets a total above the approved amount go without a window, or keeps a scheduled run's maximum instead of its standing authorisation's cap.
// Proves: An order whose submit got no answer is reported to the caller as refused, and the agent begins it again under a new id.
// Red when: The purchase status reports an operation whose checkout may have submitted as refused or cancelled instead of uncertain, or its money hold or its journal record is let go.
/**
 * `payments.checkout.begin` as the daemon's payment host serves it. What lets
 * a purchase go without the owner's window is the host's to say, never the
 * caller's: an approved maximum or a standing authorisation in the request
 * body counts for nothing, "confirm every purchase" refuses a begin the owner
 * did not approve for that shop, item and amount, and an approval covers no
 * more than its amount.
 *
 * Real `registerPaymentsMethods` on a real `GatewayMethodCatalog`, with the
 * daemon's settings manager and its budget, purchase, journal, operation,
 * approval and standing stores over a temp folder. Stand-ins: the merchant (a
 * loopback store that records each order POST), the browser page (the fixture
 * checkout driver), the transport's owner authority, the owner's side of the
 * notices (records each notice; silence answers every window), the card store's
 * secret tier, and Jev's readings (a fixture port).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import type { GatewayMethodInvocation } from '../platform/src/platform/control-plane/method-catalog-shared.ts';
import type { BrowserCheckoutSeam } from '../platform/src/platform/control-plane/routes/browser-composition.ts';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.ts';
import { DaemonApprovalStore } from '../platform/src/platform/payments/host/approval-store.ts';
import { DurableBudgetLedger } from '../platform/src/platform/payments/host/budget-store.ts';
import { DaemonCardStore } from '../platform/src/platform/payments/host/card-store.ts';
import { DurableCheckoutJournal } from '../platform/src/platform/payments/host/checkout-journal-store.ts';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.ts';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.ts';
import { registerPaymentsMethods } from '../platform/src/platform/payments/host/register.ts';
import { DaemonStandingAuthorizations } from '../platform/src/platform/payments/host/standing-store.ts';
import { createJevMerchantJudge } from '../platform/src/platform/payments/merchant-judge-model.ts';
import { isLivePaymentOperation, type PaymentOperationView } from '../platform/src/platform/payments/operation-view.ts';
import type { PaymentNotifier } from '../platform/src/platform/payments/payment-ports.ts';
import { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.ts';
import { parseCurrencyCode, type CurrencyCode, type PostalAddress } from '../platform/src/platform/payments/types.ts';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../platform/src/platform/security/http-auth.ts';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.ts';
import { startFixtureMerchant, type FixtureMerchant } from './helpers/fixture-merchant.ts';
import { FixtureCheckoutDriver, readFixtureCheckout } from './helpers/fixture-checkout-driver.ts';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();

const CHECKOUT_HOST = 'www.bestbuy.com';
const ITEM = 'Mechanical keyboard, tenkeyless';
const ADDRESS: PostalAddress = { name: 'Pat Fixture', line1: '500 Test Street', line2: '', city: 'Detroit', region: 'MI', postalCode: '48226', country: 'US' };

/** The owner's app on the daemon's own machine, as the transport presents it. */
const OWNER_SNAPSHOT: NativePairedSnapshot = { kind: 'local', tokenId: 'local-owner', principalId: 'local-owner',
  authorityId: 'local-owner', authorityRevision: 'fixture', scopes: ['read:payments', 'write:payments'] };
const OWNER_AUTHORITY: NativeExecutionAuthority = {
  current: () => OWNER_SNAPSHOT,
  async withCurrent(_expected, operation) { return operation(() => OWNER_SNAPSHOT); },
  issueContinuation: (binding) => ({ id: `continuation-${randomUUID()}`, binding }),
  revokeContinuation: () => {},
};
function asOwner(body: Record<string, unknown>, explicitUserRequest = true): GatewayMethodInvocation {
  return { body, nativeExecutionAuthority: OWNER_AUTHORITY, isAuthorized: () => true,
    context: { principalId: 'local-owner', principalKind: 'token', admin: true, scopes: ['read:payments', 'write:payments'],
      authToken: 'fixture-local-owner', metadata: { explicitUserRequest } } } as GatewayMethodInvocation;
}

let dir: string;
let merchant: FixtureMerchant;
const closers: Array<() => Promise<void> | void> = [];
beforeEach(async () => {
  dir = makeProjectTempDir('gv-payments-begin');
  merchant = await startFixtureMerchant('alpha');
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await merchant.close();
});

/** The daemon's settings manager over the temp folder. */
function settings(values: Record<string, unknown>): ConfigManager {
  const configDir = join(dir, '.goodvibes', 'goodvibes');
  mkdirSync(configDir, { recursive: true });
  const manager = new ConfigManager({ configDir, homeDir: dir, surfaceRoot: 'goodvibes',
    daemonTierPath: join(dir, '.goodvibes', 'daemon', 'settings.json'), ownsDaemonTier: true });
  for (const [key, value] of Object.entries({ 'payments.enabled': true, 'payments.currency': 'USD', 'daemon.timezone': 'UTC',
    'payments.budget.dailyOverage': 1_000, 'payments.budget.perPurchaseCeilingEnabled': false, ...values })) {
    manager.set(key as ConfigKey, value as never);
  }
  return manager;
}

/** One start of the payment host over the files in `dir`. */
async function paymentHost(config: ConfigManager, options: { failSubmit?: boolean } = {}) {
  const notices: string[] = [];
  const notifier: PaymentNotifier = {
    deliver: async input => { notices.push(input.kind); return [{ channel: 'tui', delivered: true, backfillable: false }]; },
    awaitAnswer: async () => null,
  };
  const driver = new FixtureCheckoutDriver({ merchant, pageUrl: `https://${CHECKOUT_HOST}/checkout`, ...(options.failSubmit ? { failSubmit: true } : {}) });
  const seam: BrowserCheckoutSeam = { cardFieldGuard: new CardMaterialRedactor(), driverFor: () => driver, async armSubmitApproval() {} };
  const secrets = new Map<string, string>();
  const operations = new DurablePaymentOperations(join(dir, 'payments-operations'));
  const purchases = new DaemonPurchaseLedger({ filePath: join(dir, 'payments-purchases.json') });
  const cards = new DaemonCardStore({ filePath: join(dir, 'payments-cards.json'), cvvHandling: () => 'stored', secrets: {
    async get(key) { return secrets.get(key) ?? null; }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); },
  } });
  const approvals = new DaemonApprovalStore(join(dir, 'payments-approvals.json'));
  const budget = new DurableBudgetLedger(join(dir, 'payments-budget.json'));
  const journal = new DurableCheckoutJournal(join(dir, 'payments-checkout-journal.json'));
  const standing = new DaemonStandingAuthorizations(join(dir, 'payments-standing.json'));
  const replies = new PaymentReplyInbox();
  closers.push(() => replies.close());
  const catalog = new GatewayMethodCatalog();
  const registration = registerPaymentsMethods(catalog, {
    cards, purchases, config, isPaymentsLeader: () => true,
    budget,
    checkout: {
      seam: () => seam, addresses: { async read() { return ADDRESS; } }, notifier, replies,
      merchantJudge: createJevMerchantJudge(), untrusted: new UntrustedContentLedger(), approvals, standing, operations,
      journal,
    },
  });
  closers.push(() => registration.close());
  await registration.ready;
  const card = await cards.create({ label: 'Test card', kind: 'virtual', number: '4012888888881881', expiryMonth: 7, expiryYear: 2029,
    cvv: '318', cardholderName: 'Pat Fixture', issuerCapMinorUnits: null });
  const invoke = (id: string, body: Record<string, unknown>, explicit = true) => catalog.invoke(id, asOwner(body, explicit));
  /** The refusal code a call ends in, or 'accepted'. */
  const outcome = async (id: string, body: Record<string, unknown>, explicit = true): Promise<string> => {
    try { const answer = await invoke(id, body, explicit) as { outcome?: string; approved?: boolean }; return answer.outcome ?? (answer.approved ? 'approved' : 'answered'); }
    catch (error) { return String((error as { code?: unknown }).code ?? error); }
  };
  /** Follow a begun purchase through payments.purchase.status until it has ended; bounded in turns, never in time. */
  const settled = async (purchaseId: string): Promise<PaymentOperationView> => {
    for (let turn = 0; turn < 200_000; turn += 1) {
      const status = await invoke('payments.purchase.status', { purchaseId }) as { operations: readonly PaymentOperationView[] };
      const row = status.operations.find(operation => operation.purchaseId === purchaseId);
      if (row !== undefined && !isLivePaymentOperation(row.state)) return row;
      await new Promise<void>(resolve => { setImmediate(resolve); });
    }
    throw new Error(`purchase ${purchaseId} did not end`);
  };
  return { invoke, outcome, settled, notices, approvals, standing, purchases, budget, journal, cardId: card.id, close: () => registration.close() };
}

async function beginBody(requestId: string, cardId: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const reading = await readFixtureCheckout(merchant);
  return {
    requestId, sessionId: 'session-1', pageId: 'page-1', merchantDomain: CHECKOUT_HOST, checkoutUrl: `https://${CHECKOUT_HOST}/checkout`,
    item: ITEM, cardId, requestedLines: [{ label: ITEM, quantity: 1 }],
    lines: reading.lines, tax: reading.tax, fees: reading.fees, shippingOptions: reading.shippingOptions,
    statedTotal: reading.statedTotal, currency: reading.currency, orderSummaryText: reading.orderSummaryText,
    cardFields: [{ field: 'number', ref: 'ccnum' }, { field: 'expiry', ref: 'ccexp' }, { field: 'cvv', ref: 'cccvv' }, { field: 'cardholderName', ref: 'ccname' }],
    shippingTargets: ['ship-standard', 'ship-two-day', 'ship-overnight'], placeOrderTarget: 'place',
    ...extra,
  };
}

test('nothing in the request body, and no approval for another shop, item or a smaller amount, lets a purchase skip its window', async () => {
  // Over the daily budget: only the owner's approval window may let this one through.
  const over = await paymentHost(settings({ 'payments.budget.dailyItem': 10 }));
  const forged = await beginBody('forged-1', over.cardId, { ownerApprovedMaxMinorUnits: 99_999_999, standingAuthorizationId: 'standing-1a2b3c4d' });
  expect(await over.outcome('payments.checkout.begin', forged)).toBe('accepted');
  expect((await over.settled('forged-1')).state).toBe('refused');
  expect(over.notices.filter(kind => kind !== 'notice')).toEqual(['approval']);
  expect(merchant.submissions).toHaveLength(0);
  await over.close();

  // Every purchase confirmed: the begin needs the owner's approval for exactly this shop, item and amount.
  const confirm = await paymentHost(settings({ 'payments.budget.dailyItem': 1_000, 'payments.confirmEveryPurchase': true }));
  const total = (await readFixtureCheckout(merchant)).statedTotal!.replace(/[^0-9.]/g, '');
  expect(await confirm.outcome('payments.checkout.begin', await beginBody('unapproved', confirm.cardId, { requestedMax: total }))).toBe('OWNER_APPROVAL_REQUIRED');
  expect(await confirm.outcome('payments.checkout.approve', { merchantDomain: CHECKOUT_HOST, item: ITEM, amount: total, confirm: true }, false)).not.toBe('approved');
  expect(await confirm.outcome('payments.checkout.approve', { merchantDomain: 'jeffsgadgets.biz', item: ITEM, amount: total, confirm: true })).toBe('approved');
  expect(await confirm.outcome('payments.checkout.begin', await beginBody('other-shop', confirm.cardId, { requestedMax: total }))).toBe('OWNER_APPROVAL_REQUIRED');
  expect(await confirm.outcome('payments.checkout.approve', { merchantDomain: CHECKOUT_HOST, item: ITEM, amount: total, confirm: true })).toBe('approved');
  expect(await confirm.outcome('payments.checkout.begin', await beginBody('approved', confirm.cardId, { requestedMax: total }))).toBe('accepted');
  expect((await confirm.settled('approved')).state).toBe('completed');
  expect(confirm.notices.filter(kind => kind !== 'notice')).toEqual([]);
  expect(merchant.submissions).toHaveLength(1);
  expect(await confirm.outcome('payments.checkout.begin', await beginBody('approved-again', confirm.cardId, { requestedMax: total }))).toBe('OWNER_APPROVAL_REQUIRED');
  await confirm.close();

  // An approval one cent under the page's total covers none of it: the window opens and silence buys nothing.
  const under = await paymentHost(settings({ 'payments.budget.dailyItem': 1_000, 'payments.confirmEveryPurchase': false }));
  const cents = Math.round(Number(total) * 100) - 1;
  const short = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  expect(await under.outcome('payments.checkout.approve', { merchantDomain: CHECKOUT_HOST, item: ITEM, amount: short, confirm: true })).toBe('approved');
  expect(await under.outcome('payments.checkout.begin', await beginBody('short', under.cardId, { requestedMax: short }))).toBe('accepted');
  expect((await under.settled('short')).state).toBe('refused');
  expect(under.notices.filter(kind => kind !== 'notice')).toEqual(['approval']);
  expect(merchant.submissions).toHaveLength(1);

  // A standing authorisation binds the begin to its own item and maximum, whatever the scheduled run sent; removed, it starts nothing.
  const entry = under.standing.add({ item: ITEM, merchants: ['bestbuy.com'], maxPerPurchase: '10', maxPerPeriod: '100', periodDays: 30 },
    parseCurrencyCode('USD') as CurrencyCode);
  const scheduled = await beginBody('standing-1', under.cardId, { standingId: entry.id, requestedMax: '5000', item: ITEM.toUpperCase() });
  expect(await under.outcome('payments.checkout.begin', scheduled, false)).toBe('accepted');
  expect((await under.settled('standing-1')).state).toBe('refused');
  expect(under.notices.filter(kind => kind !== 'notice')).toEqual(['approval', 'approval']);
  expect(under.standing.remove(entry.id)).toBe(true);
  expect(await under.outcome('payments.checkout.begin', { ...scheduled, requestId: 'standing-2' }, false)).toBe('FORBIDDEN');
  expect(merchant.submissions).toHaveLength(1);
});

test('an order whose submit got no answer is reported as uncertain, with its money still held and its record kept', async () => {
  const host = await paymentHost(settings({ 'payments.budget.dailyItem': 1_000, 'payments.confirmEveryPurchase': false }), { failSubmit: true });
  expect(await host.outcome('payments.checkout.begin', await beginBody('no-answer', host.cardId))).toBe('accepted');
  expect((await host.settled('no-answer')).state).toBe('uncertain');
  expect(host.budget.state().reservations.map(row => row.id)).toEqual(['no-answer']);
  expect((await host.journal.list()).map(row => row.purchaseId)).toEqual(['no-answer']);
});
