import { expect, test } from 'bun:test';
import { BudgetLedger, MAX_RESERVATIONS, type BudgetLimits } from '../platform/src/platform/payments/budget.js';
import { CheckoutRegistry, CheckoutRegistryError, MemoryCheckoutJournal, type InFlightCheckout } from '../platform/src/platform/payments/checkout-registry.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../platform/src/platform/payments/types.js';

function record(purchaseId = 'purchase', sessionId = 'session', pageId = 'page'): InFlightCheckout {
  const currency = parseCurrencyCode('USD');
  if (!currency) throw new Error('Invalid fixture currency');
  return { purchaseId, sessionId, pageId, merchantDomain: 'example.com', cardId: 'card',
    item: unsafeOwnerSuppliedTextForTests('Fixture item'), currency, phase: 'deciding', startedAtMs: 1, updatedAtMs: 1,
    draw: { itemMinorUnits: 100, overageMinorUnits: 10, toleranceMinorUnits: 0, totalMinorUnits: 110 },
    reservationId: purchaseId, shippingTierRequested: 'normal', shippingTierUsed: 'normal', stepDown: null, totalMinorUnits: 110 };
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

class ControlledJournal extends MemoryCheckoutJournal {
  hold: { readonly wait: Promise<void> } | undefined;
  fail = false;
  override async put(value: InFlightCheckout): Promise<void> {
    await this.hold?.wait;
    if (this.fail) throw new Error('Fixture flush failed');
    await super.put(value);
  }
  override async remove(id: string): Promise<void> {
    await this.hold?.wait;
    if (this.fail) throw new Error('Fixture flush failed');
    await super.remove(id);
  }
}

test('session/page pairs remain distinct even when concatenating their IDs would collide', async () => {
  const journal = new MemoryCheckoutJournal();
  const registry = new CheckoutRegistry(journal);
  await registry.open(record('first', 'a:b', 'c'));
  await registry.open(record('second', 'a', 'b:c'));
  expect(registry.current('a:b', 'c')?.purchaseId).toBe('first');
  expect(registry.current('a', 'b:c')?.purchaseId).toBe('second');
  await registry.close('first');
  expect(registry.current('a:b', 'c')).toBeNull();
  expect(registry.current('a', 'b:c')?.purchaseId).toBe('second');
  expect((await journal.list()).map(entry => entry.purchaseId)).toEqual(['second']);
});

test('one purchase ID cannot overwrite the journal of its original page', async () => {
  const journal = new MemoryCheckoutJournal();
  const registry = new CheckoutRegistry(journal);
  await registry.open(record());
  await expect(registry.open(record('purchase', 'another-session', 'another-page'))).rejects.toBeInstanceOf(CheckoutRegistryError);
  expect(registry.current('session', 'page')?.purchaseId).toBe('purchase');
  expect(registry.current('another-session', 'another-page')).toBeNull();
  expect(await journal.list()).toHaveLength(1);
});

test('failed open releases its exact page reservation without publishing an unflushed checkout', async () => {
  const journal = new ControlledJournal();
  const registry = new CheckoutRegistry(journal);
  const gate = barrier(); journal.hold = gate; journal.fail = true;
  const opening = registry.open(record());
  void opening.catch(() => {});
  expect(registry.current('session', 'page')).toBeNull();
  await expect(registry.open(record('second'))).rejects.toThrow('already in flight');
  await expect(registry.advance('purchase', 'arming-payment')).rejects.toThrow('write in progress');
  await expect(registry.close('purchase')).rejects.toThrow('write in progress');
  gate.release();
  await expect(opening).rejects.toThrow('Fixture flush failed');
  journal.hold = undefined; journal.fail = false;
  await registry.open(record('second'));
  expect(registry.current('session', 'page')?.purchaseId).toBe('second');
  expect((await journal.list()).map(entry => entry.purchaseId)).toEqual(['second']);
});

test('a phase is visible only after its write completes; failure restores the last durable phase', async () => {
  const journal = new ControlledJournal();
  const registry = new CheckoutRegistry(journal);
  await registry.open(record());
  const original = registry.current('session', 'page');
  const gate = barrier(); journal.hold = gate; journal.fail = true;
  const advancing = registry.advance('purchase', 'arming-payment');
  void advancing.catch(() => {});
  expect(registry.current('session', 'page')).toBeNull();
  expect((await journal.list())[0]?.phase).toBe('deciding');
  await expect(registry.advance('purchase', 'submit-pending')).rejects.toThrow('write in progress');
  await expect(registry.close('purchase')).rejects.toThrow('write in progress');
  gate.release();
  await expect(advancing).rejects.toThrow('Fixture flush failed');
  expect(registry.current('session', 'page')).toBe(original);
  journal.hold = undefined; journal.fail = false;
  await registry.advance('purchase', 'arming-payment');
  expect(registry.current('session', 'page')?.phase).toBe('arming-payment');
  expect((await journal.list())[0]?.phase).toBe('arming-payment');
});

test('a failed close retains its page and cannot erase a later open', async () => {
  const journal = new ControlledJournal();
  const registry = new CheckoutRegistry(journal);
  await registry.open(record());
  const gate = barrier(); journal.hold = gate; journal.fail = true;
  const closing = registry.close('purchase');
  void closing.catch(() => {});
  expect(registry.current('session', 'page')).toBeNull();
  await expect(registry.open(record('replacement'))).rejects.toThrow('already in flight');
  gate.release();
  await expect(closing).rejects.toThrow('Fixture flush failed');
  expect(registry.current('session', 'page')?.purchaseId).toBe('purchase');
  journal.hold = undefined; journal.fail = false;
  await registry.close('purchase');
  await registry.open(record('replacement'));
  expect(registry.current('session', 'page')?.purchaseId).toBe('replacement');
});

test('recovery does not settle a journal row whose open has not finished flushing', async () => {
  const gate = barrier();
  const journal = new MemoryCheckoutJournal();
  const put = journal.put.bind(journal);
  journal.put = async value => { await put(value); await gate.wait; };
  const registry = new CheckoutRegistry(journal);
  const opening = registry.open(record());
  expect(registry.current('session', 'page')).toBeNull();
  expect(await journal.list()).toHaveLength(1);
  expect(await registry.interrupted()).toEqual([]);
  gate.release();
  await opening;
  expect(registry.current('session', 'page')?.purchaseId).toBe('purchase');
});

test('caller edits and returned records cannot retarget a checkout or rewrite its draw and window evidence', async () => {
  const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
  const draw = { itemMinorUnits: 100, overageMinorUnits: 10, toleranceMinorUnits: 0, totalMinorUnits: 110 };
  const delivery = { channel: 'telegram' as const, delivered: true, backfillable: true };
  const supplied = { ...record(), draw, windowDeliveries: [delivery] };
  const owned = await registry.open(supplied);
  supplied.sessionId = 'changed'; supplied.purchaseId = 'changed'; draw.itemMinorUnits = 999; delivery.delivered = false;
  expect(registry.current('session', 'page')).toBe(owned);
  expect(registry.current('changed', 'page')).toBeNull();
  expect(owned.purchaseId).toBe('purchase'); expect(owned.draw?.itemMinorUnits).toBe(100);
  expect(owned.windowDeliveries?.[0]?.delivered).toBe(true);
  expect(Reflect.set(owned, 'purchaseId', 'forged')).toBe(false);
  expect(Reflect.set(owned.draw!, 'itemMinorUnits', 999)).toBe(false);
  const changed = await registry.advance('purchase', 'awaiting-window', { purchaseId: 'forged', sessionId: 'forged', pageId: 'forged' } as unknown as Parameters<CheckoutRegistry['advance']>[2]);
  expect(changed.purchaseId).toBe('purchase'); expect(changed.sessionId).toBe('session'); expect(changed.pageId).toBe('page');
});

const limits: BudgetLimits = { dailyItemMinorUnits: 1_000_000, dailyOverageMinorUnits: 1000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
const reservationTime = Date.UTC(2026, 10, 8, 12);
function reservation(id: string) { return { id, itemMinorUnits: 1, overageMinorUnits: 0, toleranceMinorUnits: 0, limits, nowMs: reservationTime, timezone: 'UTC' }; }

test('duplicate reservation IDs cannot make a failed attempt release another purchase hold', () => {
  const ledger = new BudgetLedger();
  expect(ledger.reserve(reservation('original'))).not.toBeNull();
  expect(ledger.reserve(reservation('original'))).toBeNull();
  expect(ledger.state().reservations).toHaveLength(1);
  expect(ledger.release('original')).toBe(true);
  expect(ledger.state().reservations).toHaveLength(0);
});

test('reservation capacity refuses new work instead of silently evicting live holds', () => {
  const ledger = new BudgetLedger();
  for (let i = 0; i < MAX_RESERVATIONS; i++) expect(ledger.reserve(reservation(`purchase-${i}`))).not.toBeNull();
  expect(ledger.reserve(reservation('overflow'))).toBeNull();
  expect(ledger.state().reservations.map(entry => entry.id)).toEqual(Array.from({ length: MAX_RESERVATIONS }, (_, i) => `purchase-${i}`));
  expect(ledger.snapshot(limits, reservationTime, 'UTC').item.reserved).toBe(MAX_RESERVATIONS);
  expect(ledger.release('purchase-0')).toBe(true);
  expect(ledger.reserve(reservation('after-release'))).not.toBeNull();
});
