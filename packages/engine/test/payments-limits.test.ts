// Proves: The agent spends past a limit the owner set, or without asking when no limit is set.
// Red when: Spend is not read back from the budget file, the ceiling or the card's cap is compared with the item price, tax and fees escape the overage budget, the owner's maximum is ignored or misread, an approved overdraw raises the limit past the shortfall, or a limit of 0 or a typed answer is misread.
// Proves: A checkout priced in another currency meets the budget number for number.
// Red when: A total stated in EUR is compared with a USD budget, or a price written "€99.00" with no currency code is read as 99.00 of the budget currency.
/**
 * The owner's spending limits. Inside them the agent buys without asking; over
 * one it stops and names the limit and the amounts; the per-purchase ceiling is
 * held against the whole total, not the item price; the card's declared cap and
 * the daily budget hold, the daily budget across a restart; and the shipped
 * defaults of 0 ask every time, offering once to set the limit.
 *
 * Real `decide.ts`, `budget.ts` (the daemon's budget file in a temp folder),
 * `gates.ts`, `host/limit-offer.ts`, the daemon's settings manager and the owner
 * inbox over its SQLite store. Nothing is faked.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { OwnerInbox, type OwnerItem } from '../platform/src/platform/control-plane/owner-inbox.ts';
import { QuestionStore } from '../platform/src/platform/control-plane/question-store.ts';
import { admitApprovedItemOverdraw, type BudgetLimits } from '../platform/src/platform/payments/budget.ts';
import { extractCheckout, type RawCheckoutReading } from '../platform/src/platform/payments/checkout-extraction.ts';
import { decidePurchase, type DecisionInput } from '../platform/src/platform/payments/decide.ts';
import { DurableBudgetLedger } from '../platform/src/platform/payments/host/budget-store.ts';
import { createLimitOffers, limitOfferKey, type OfferableLimitSetting } from '../platform/src/platform/payments/host/limit-offer.ts';
import { readBudgetLimits } from '../platform/src/platform/payments/payments-config.ts';
import { parseCurrencyCode, type CurrencyCode } from '../platform/src/platform/payments/types.ts';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const usd = parseCurrencyCode('USD') as CurrencyCode;

let home: string;
let manager: ConfigManager;
let budgetFile: string;
const closers: Array<() => void> = [];
beforeEach(() => {
  home = makeProjectTempDir('gv-payments-limits');
  const configDir = join(home, '.goodvibes', 'goodvibes');
  mkdirSync(configDir, { recursive: true });
  manager = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'goodvibes',
    daemonTierPath: join(home, '.goodvibes', 'daemon', 'settings.json'), ownsDaemonTier: true });
  budgetFile = join(home, 'payments-budget.json');
});
afterEach(() => { for (const close of closers.splice(0)) close(); });

function ledger(): DurableBudgetLedger { return new DurableBudgetLedger(budgetFile, () => NOW); }
function limits(): BudgetLimits { return readBudgetLimits(manager, usd); }

/** Item 10.00, tax 1.00, fee 0.50, standard delivery 2.00: 13.50 in all. `bare` has no tax, fee or delivery charge. */
function quote(itemMinorUnits = 1_000, extra: Partial<DecisionInput> = {}, bare = false): DecisionInput {
  const normal = { rawLabel: 'Standard', costMinorUnits: bare ? 0 : 200 };
  const current = limits();
  return {
    quoted: { itemMinorUnits, taxMinorUnits: bare ? 0 : 100, mandatoryFeesMinorUnits: bare ? 0 : 50, currency: usd,
      shippingOptions: [normal], shippingTiers: new Map([['normal', normal]]) },
    limits: current, pools: ledger().snapshot(current, NOW, 'UTC'), budgetCurrency: usd, preferredTier: 'normal',
    ...extra,
  };
}

function setLimits(values: { dailyItem?: number; dailyOverage?: number; ceiling?: number }): void {
  if (values.dailyItem !== undefined) manager.set('payments.budget.dailyItem', values.dailyItem);
  if (values.dailyOverage !== undefined) manager.set('payments.budget.dailyOverage', values.dailyOverage);
  if (values.ceiling !== undefined) manager.set('payments.budget.perPurchaseCeiling', values.ceiling);
}

/** Decide, and on a within-budget answer take the hold and commit it as a purchase would. */
function buy(id: string, itemMinorUnits: number): ReturnType<typeof decidePurchase> {
  const decision = decidePurchase(quote(itemMinorUnits));
  if (decision.kind !== 'within-budget') return decision;
  const book = ledger();
  const held = book.reserve({ id, itemMinorUnits: decision.draw.itemMinorUnits, overageMinorUnits: decision.draw.overageMinorUnits,
    toleranceMinorUnits: decision.draw.toleranceMinorUnits, limits: limits(), nowMs: NOW, timezone: 'UTC', retainUntilSettled: true });
  if (held === null) throw new Error('the decided purchase could not be held');
  book.commit(id, NOW);
  return decision;
}

test('over the daily item budget it stops and names the budget, what is left and the shortfall, across a restart', () => {
  setLimits({ dailyItem: 100, dailyOverage: 20, ceiling: 100 });
  expect(buy('first', 6_000).kind).toBe('within-budget');
  // A new ledger over the same file is the daemon after a restart.
  expect(decidePurchase(quote(5_000))).toMatchObject({
    kind: 'needs-approval', approvalReasons: ['daily-item-budget'],
    exceeded: { limit: 'daily-item-budget', setting: 'payments.budget.dailyItem', availableMinorUnits: 4_000,
      neededMinorUnits: 5_000, excessMinorUnits: 1_000, unset: false },
  });
  // A spend two hours ago is yesterday in Pago Pago; changing the zone there must not hand it back.
  const earlier = NOW - 2 * 60 * 60_000, book = ledger();
  book.reserve({ id: 'earlier', itemMinorUnits: 1_000, overageMinorUnits: 0, toleranceMinorUnits: 0, limits: limits(), nowMs: earlier, timezone: 'UTC', retainUntilSettled: true });
  book.commit('earlier', earlier);
  expect(ledger().snapshot(limits(), NOW, 'Pacific/Pago_Pago').item.spent).toBe(7_000);
});

test('the per-purchase ceiling holds the whole total, not the item price', () => {
  setLimits({ dailyItem: 100, dailyOverage: 20, ceiling: 12 });
  // The item alone (10.00) fits a 12.00 ceiling; with tax, fee and delivery it is 13.50.
  expect(decidePurchase(quote())).toMatchObject({
    kind: 'needs-approval', approvalReasons: ['per-purchase-ceiling'],
    exceeded: { limit: 'per-purchase-ceiling', availableMinorUnits: 1_200, neededMinorUnits: 1_350, excessMinorUnits: 150 },
  });
});

test('a total over the card\'s declared cap is refused outright with the amounts', () => {
  setLimits({ dailyItem: 100, dailyOverage: 20, ceiling: 50 });
  expect(decidePurchase(quote(1_000, { cardLimitMinorUnits: 1_300 }))).toMatchObject({
    kind: 'refuse', code: 'card-limit-exceeded',
    exceeded: { limit: 'card-limit', availableMinorUnits: 1_300, neededMinorUnits: 1_350, excessMinorUnits: 50 },
  });
  expect(decidePurchase(quote(1_000, { cardLimitMinorUnits: 1_350 })).kind).toBe('within-budget');
});

test('tax, fees and delivery the daily overage budget cannot cover are refused, and no maximum can turn that into an approval', () => {
  setLimits({ dailyItem: 100, dailyOverage: 1, ceiling: 50 });
  expect(decidePurchase(quote(1_000, { requestedMaximumMinorUnits: 0 }))).toMatchObject({
    kind: 'refuse', code: 'overage-pool-exhausted', exceeded: { limit: 'daily-overage-budget', neededMinorUnits: 350, availableMinorUnits: 100 },
  });
});

test('a total above the owner\'s stated maximum asks; a malformed maximum refuses', () => {
  setLimits({ dailyItem: 100, dailyOverage: 20, ceiling: 50 });
  expect(decidePurchase(quote(1_000, { requestedMaximumMinorUnits: 1_349 }))).toMatchObject({
    kind: 'needs-approval', approvalReasons: ['requested-maximum'], exceeded: { limit: 'requested-maximum', excessMinorUnits: 1 } });
  expect(decidePurchase(quote(1_000, { requestedMaximumMinorUnits: 1_350 })).kind).toBe('within-budget');
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(decidePurchase(quote(1_000, { requestedMaximumMinorUnits: bad }))).toMatchObject({ kind: 'refuse', code: 'invalid-requested-maximum' });
  }
});

test('an approved overdraw raises only the item budget, and only by the shortfall', () => {
  const base = limits();
  const raised = admitApprovedItemOverdraw({ ...base, dailyItemMinorUnits: 50_000 }, 60_000, 20_000);
  expect(raised).toEqual({ ...base, dailyItemMinorUnits: 90_000 });
  expect(admitApprovedItemOverdraw({ ...base, dailyItemMinorUnits: 50_000 }, 20_000, 20_000).dailyItemMinorUnits).toBe(50_000);
});

test('the shipped defaults ask every time, offer once to set the limit, and the answer becomes the limit', async () => {
  // Nothing set: the defaults of 0 send even a one-cent item to the owner,
  // and refuse any tax, fee or delivery charge, naming the unset overage budget.
  expect(decidePurchase(quote(1, {}, true))).toMatchObject({ kind: 'needs-approval',
    exceeded: { limit: 'daily-item-budget', setting: 'payments.budget.dailyItem', unset: true } });
  expect(decidePurchase(quote(1))).toMatchObject({ kind: 'refuse',
    exceeded: { limit: 'daily-overage-budget', setting: 'payments.budget.dailyOverage', unset: true } });

  const questions = new QuestionStore({ path: join(home, 'owner-questions.sqlite') });
  const inbox = new OwnerInbox({ questions });
  closers.push(() => inbox.dispose());
  const offers = createLimitOffers(inbox, {
    get: (key: OfferableLimitSetting) => manager.get(key),
    set: (key: OfferableLimitSetting, value: number) => manager.set(key, value),
  }, () => 'USD');
  closers.push(() => offers.close());

  const first = decidePurchase(quote(1, {}, true));
  if (first.kind !== 'needs-approval') throw new Error('an unset budget did not ask');
  offers.observe(first.exceeded);
  const second = decidePurchase(quote(2, {}, true));
  if (second.kind !== 'needs-approval') throw new Error('an unset budget did not ask the second time');
  offers.observe(second.exceeded);
  const asked = inbox.listNow().filter((item: OwnerItem) => item.key === limitOfferKey('payments.budget.dailyItem'));
  expect(asked).toHaveLength(1);

  const answered = await inbox.answer(asked[0]!.id, { text: '50' });
  expect(answered.applied).toBe(true);
  expect(manager.get('payments.budget.dailyItem')).toBe(50);
  setLimits({ dailyOverage: 20, ceiling: 50 });
  expect(decidePurchase(quote(1_000)).kind).toBe('within-budget');
});

test('a checkout in another currency, by its code or only by its sign, is never counted against the budget', () => {
  setLimits({ dailyItem: 1_000, dailyOverage: 100, ceiling: 1_000 });
  const eur = parseCurrencyCode('EUR') as CurrencyCode;
  const inEuros = quote();
  expect(decidePurchase({ ...inEuros, quoted: { ...inEuros.quoted, currency: eur } })).toMatchObject({ kind: 'refuse', code: 'currency-mismatch' });
  const page = (unitPrice: string): RawCheckoutReading => ({ lines: [{ label: 'Kettle', quantity: '1', unitPrice }], tax: null, fees: [],
    shippingOptions: [{ label: 'Standard', cost: '0.00' }], statedTotal: null, currency: null, orderSummaryText: 'Kettle' });
  expect(extractCheckout(page('€99.00'), usd)).toMatchObject({ ok: false, field: 'currency' });
  expect(extractCheckout(page('$99.00'), usd)).toMatchObject({ ok: true, checkout: { currency: 'USD', itemMinorUnits: 9_900 } });
});
