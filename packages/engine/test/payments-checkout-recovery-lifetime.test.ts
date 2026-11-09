import { afterEach, expect, test } from 'bun:test';
import { BudgetLedger } from '../platform/src/platform/payments/budget.js';
import { CheckoutRecovery, type CheckoutRecoveryDeps } from '../platform/src/platform/payments/checkout-recovery.js';
import { CheckoutOwnershipError } from '../platform/src/platform/payments/checkout-ownership.js';
import { CheckoutRegistry, MemoryCheckoutJournal, type InFlightCheckout } from '../platform/src/platform/payments/checkout-registry.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../platform/src/platform/payments/types.js';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const releases: (() => void)[] = [], owners: CheckoutRecovery[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
});
function barrier() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  releases.push(release); return { pending, release };
}
function record(id = 'interrupted', phase: InFlightCheckout['phase'] = 'submit-pending'): InFlightCheckout {
  const currency = parseCurrencyCode('USD'); if (!currency) throw new Error('Fixture currency');
  return { purchaseId: id, sessionId: 'session', pageId: id, merchantDomain: 'bestbuy.com', cardId: 'fixture-card',
    item: unsafeOwnerSuppliedTextForTests('Fixture item'), currency, phase, startedAtMs: 1, updatedAtMs: 2,
    draw: null, reservationId: null, shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null };
}
function fixture(overrides: Partial<CheckoutRecoveryDeps> = {}) {
  const journal = new MemoryCheckoutJournal(), registry = new CheckoutRegistry(journal), notices: unknown[] = [];
  const deps: CheckoutRecoveryDeps = { journal, registry, ledger: new BudgetLedger(),
    purchases: { async record() {}, async has() { return false; } },
    notifier: { async deliver(input) { input.assertCurrent?.(); notices.push(input); return [{ channel: 'telegram', delivered: true, backfillable: false }]; },
      async awaitAnswer() { throw new Error('Recovery cannot open a new approval window'); } },
    isPaymentsLeader: () => true, ...overrides };
  const recovery = new CheckoutRecovery(deps); owners.push(recovery);
  return { recovery, journal, registry, notices };
}

test('concurrent sweeps share their original operation and skip actual live registry records', async () => {
  const entered = barrier(), gate = barrier(); let lookups = 0;
  const f = fixture({ purchases: { async record() {}, async has() { lookups++; entered.release(); await gate.pending; return false; } } });
  await f.registry.open(record('live'));
  await f.journal.put(record('interrupted'));
  const pending = f.recovery.recoverInterruptedCheckouts();
  expect(f.recovery.recoverInterruptedCheckouts()).toBe(pending);
  await entered.pending; gate.release();
  const result = await pending;
  expect(lookups).toBe(1);
  expect(result.settlements.map(entry => entry.purchaseId)).toEqual(['interrupted']);
  expect(f.registry.current('session', 'live')?.purchaseId).toBe('live');
  expect((await f.journal.list()).map(entry => entry.purchaseId).sort()).toEqual(['interrupted', 'live']);
});

test('reporting a lookup timeout does not retire actual I/O or allow another sweep', async () => {
  const entered = barrier(), gate = barrier(); let lookups = 0;
  const f = fixture({ recoveryIoTimeoutMs: 5,
    purchases: { async record() {}, async has() { lookups++; entered.release(); await gate.pending; return true; } } });
  await f.journal.put(record());
  const pending = f.recovery.recoverInterruptedCheckouts(); await entered.pending;
  expect((await pending).settlements[0]).toMatchObject({ action: 'failed', notified: false });
  await expect(f.recovery.recoverInterruptedCheckouts()).rejects.toBeInstanceOf(CheckoutOwnershipError);
  const closing = f.recovery.close(); expect(f.recovery.close()).toBe(closing);
  let drained = false; void closing.then(() => { drained = true; });
  await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
  gate.release(); await closing;
  expect(lookups).toBe(1); expect(f.notices).toEqual([]);
  expect((await f.journal.list())[0]?.phase).toBe('submit-pending');
  await expect(f.recovery.recoverInterruptedCheckouts()).rejects.toBeInstanceOf(CheckoutOwnershipError);
});

test('close during delivery drains the ignored signal and forbids a late notification stamp', async () => {
  const entered = barrier(), gate = barrier(); let signal: AbortSignal | undefined;
  const f = fixture({ notifier: {
    async deliver(input) { signal = input.signal; entered.release(); await gate.pending; return [{ channel: 'telegram', delivered: true, backfillable: false }]; },
    async awaitAnswer() { throw new Error('Unexpected window'); },
  } });
  await f.journal.put(record());
  const pending = f.recovery.recoverInterruptedCheckouts(), handled = pending.catch(error => error);
  await entered.pending;
  const closing = f.recovery.close(); expect(signal?.aborted).toBe(true);
  let drained = false; void closing.then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  gate.release(); expect(await handled).toBeInstanceOf(CheckoutOwnershipError); await closing;
  expect((await f.journal.list())[0]?.recoveryNotifiedAtMs).toBeUndefined();
});

test('leadership retirement during a lookup cannot settle or notify the old purchase', async () => {
  const entered = barrier(), gate = barrier(); let leader = true;
  const f = fixture({ isPaymentsLeader: () => leader,
    purchases: { async record() {}, async has() { entered.release(); await gate.pending; return true; } } });
  await f.journal.put(record());
  const pending = f.recovery.recoverInterruptedCheckouts(), handled = pending.catch(error => error);
  await entered.pending; leader = false; gate.release();
  expect(await handled).toBeInstanceOf(CheckoutOwnershipError);
  expect((await f.journal.list())[0]?.phase).toBe('submit-pending'); expect(f.notices).toEqual([]);
});

test('a second host cannot settle another process-owned checkout as interrupted', async () => {
  const operations = new DurablePaymentOperations(makeProjectTempDir('recovery-payment-lease'));
  const writer = operations.create({ purchaseId: 'interrupted', operationId: 'original-operation', state: 'running', phase: 'awaiting-window',
    createdAtMs: 1, updatedAtMs: 2, outcome: null, totalMinorUnits: null, currency: null }, null, () => {});
  releases.push(() => writer.release());
  const f = fixture({ retainInterrupted: id => operations.retainRecovery(id) });
  await f.journal.put(record('interrupted', 'awaiting-window'));
  expect((await f.recovery.recoverInterruptedCheckouts()).settlements).toEqual([]);
  expect(f.notices).toEqual([]); expect(await f.journal.list()).toHaveLength(1);
  writer.release();
  expect((await f.recovery.recoverInterruptedCheckouts()).settlements[0]?.action).toBe('released');
  expect(await f.journal.list()).toHaveLength(0);
});

test('a timeout keeps the real cross-process recovery lease until ignored I/O has drained', async () => {
  const operations = new DurablePaymentOperations(makeProjectTempDir('recovery-payment-timeout'));
  const entered = barrier(), gate = barrier();
  const f = fixture({ recoveryIoTimeoutMs: 5, retainInterrupted: id => operations.retainRecovery(id),
    purchases: { async record() {}, async has() { entered.release(); await gate.pending; return true; } } });
  await f.journal.put(record());
  const recovery = f.recovery.recoverInterruptedCheckouts(); await entered.pending;
  expect((await recovery).settlements[0]?.action).toBe('failed');
  expect(operations.retainRecovery('interrupted')).toBeNull();
  const closing = f.recovery.close(); gate.release(); await closing;
  const released = operations.retainRecovery('interrupted'); expect(released).not.toBeNull(); released?.release();
  expect((await f.journal.list())[0]?.phase).toBe('submit-pending');
  expect(f.notices).toEqual([]);
});
