/** Explicit owner findings settle original funds without another submission. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.js';
import { DurableBudgetLedger } from '../platform/src/platform/payments/host/budget-store.js';
import { DurableCheckoutJournal } from '../platform/src/platform/payments/host/checkout-journal-store.js';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.js';
import { PurchaseReconciliations } from '../platform/src/platform/payments/host/purchase-reconciliation.js';
import { purchaseReconciliationHandler } from '../platform/src/platform/payments/host/reconciliation-handler.js';
import { registerCatalogHandlers } from '../platform/src/platform/payments/host/handler-plumbing.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { CheckoutRecovery } from '../platform/src/platform/payments/checkout-recovery.js';
import { CheckoutRegistry } from '../platform/src/platform/payments/checkout-registry.js';
import type { CheckoutJournal } from '../platform/src/platform/payments/checkout-registry.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.ts';
import { protectedPaymentWindow } from './helpers/protected-payment-window.ts';
import type { PaymentOperationView } from '../platform/src/platform/payments/operation-view.js';
import type { PurchaseRecord } from '../platform/src/platform/payments/purchase-record.js';
import { dayKey } from '../platform/src/platform/payments/day.js';

const roots: string[] = [], closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const NOW = Date.parse('2026-11-08T15:00:00Z');
const LIMITS = { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 1000, perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
function gate() { let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); closers.push(release); return { pending, release }; }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'payment-owner-reconciliation-')); roots.push(root);
  const request = protectedPaymentRequest(), quote = protectedPaymentWindow(request, NOW - 100);
  const record = { ...quote.record, phase: 'submit-pending' as const, startedAtMs: NOW - 1000 };
  const view: PaymentOperationView = { purchaseId: request.purchaseId, operationId: request.operationId, state: 'uncertain',
    phase: 'submit-pending', createdAtMs: NOW - 1000, updatedAtMs: NOW - 100, outcome: null, totalMinorUnits: 2000, currency: 'USD' };
  let declarations = 0, beforePublication: () => void = () => {};
  const reopen = (journal?: CheckoutJournal, now = NOW) => {
    const operations = new DurablePaymentOperations(join(root, 'operations'), () => { declarations++; beforePublication(); });
    const budget = new DurableBudgetLedger(join(root, 'budget.json'), () => now, undefined, () => { declarations++; },
      id => operations.get(id)?.outcome?.startsWith('owner-reconciliation-pending-') === true);
    const original = new DurableCheckoutJournal(join(root, 'journal.json'));
    const purchases = new DaemonPurchaseLedger({ filePath: join(root, 'purchases.json'), beforeReconciliationWrite: () => { declarations++; } });
    const reconciliations = new PurchaseReconciliations({ operations, budget, journal: journal ?? original, purchases, isPaymentsLeader: () => true, now: () => now });
    closers.push(() => reconciliations.close());
    return { operations, budget, journal: original, purchases, reconciliations };
  };
  const f = reopen();
  f.operations.create(view, request.principalId, () => {}).release();
  await f.journal.put(record);
  f.budget.reserve({ id: request.purchaseId, itemMinorUnits: 2000, overageMinorUnits: 0, toleranceMinorUnits: 0,
    limits: LIMITS, nowMs: NOW - 1000, timezone: 'UTC', retainUntilSettled: true });
  return { ...f, root, request, record, view, reopen, declarations: () => declarations,
    beforePublication: (callback: () => void) => { beforePublication = callback; },
    reconcile: (outcome: 'purchased' | 'not-purchased') => f.reconciliations.reconcile(view.purchaseId, view.operationId, outcome, 'pairing:current-admin', () => {}) };
}
function receipt(f: Awaited<ReturnType<typeof fixture>>): PurchaseRecord {
  return { purchaseId: f.view.purchaseId, atUtc: new Date(NOW - 50).toISOString(), dayKey: dayKey(NOW, 'UTC'), timezone: 'UTC',
    merchantDomain: f.record.merchantDomain, item: String(f.record.item), currency: 'USD', itemMinorUnits: 2000, taxMinorUnits: 0,
    feesMinorUnits: 0, shippingMinorUnits: 0, totalMinorUnits: 2000, shippingTierRequested: 'normal', shippingTierUsed: 'normal',
    steppedDown: false, itemPoolDraw: 2000, overagePoolDraw: 0, tolerancePoolDraw: 0, cardLast4: '????', windowKind: 'approval',
    windowOutcome: 'approved', answeredBy: 'operator', outcome: 'submitted-unverified', refusalReason: null, merchantOrderId: null,
    refundedAt: null, merchantRecognised: false, merchantQualifier: null, merchantDiscovered: false };
}

test.each(['purchased', 'not-purchased'] as const)('explicit %s settles only the original hold once across restart', async outcome => {
  const f = await fixture();
  const result = await f.reconcile(outcome);
  expect(result).toMatchObject({ purchaseId: f.view.purchaseId, operationId: f.view.operationId, state: 'completed', outcome: `owner-confirmed-${outcome}` });
  expect(await f.journal.list()).toHaveLength(0);
  expect(f.budget.state().reservations).toHaveLength(0);
  expect(f.budget.state().spend).toHaveLength(outcome === 'purchased' ? 1 : 0);
  expect(f.budget.state().reconciliations).toHaveLength(1);
  expect(f.purchases.list({ limit: 100, dayKey: undefined })).toMatchObject({ purchases: [], total: 0,
    reconciliations: [{ purchaseId: f.view.purchaseId, operationId: f.view.operationId, outcome, principalId: 'pairing:current-admin' }] });
  // An owner finding is not a manufactured merchant receipt.
  expect(f.purchases.get(f.view.purchaseId)).toBeNull();
  expect(f.declarations()).toBeGreaterThan(0);
  const restarted = f.reopen();
  expect(await restarted.reconciliations.reconcile(f.view.purchaseId, f.view.operationId, outcome, 'pairing:new-admin', () => {})).toEqual(result);
  expect(restarted.budget.state().reconciliations).toHaveLength(1);
  expect(restarted.purchases.list({ limit: 100, dayKey: undefined }).reconciliations).toHaveLength(1);
  await expect(restarted.reconciliations.reconcile(f.view.purchaseId, f.view.operationId, outcome === 'purchased' ? 'not-purchased' : 'purchased', 'pairing:new-admin', () => {})).rejects.toThrow();
});

test('a live executor retains the real cross-process lease and cannot be reconciled even through another store', async () => {
  const f = await fixture(), writer = f.operations.recover(f.view.purchaseId);
  if (!writer) throw new Error('Fixture lease unavailable');
  try { await expect(f.reopen().reconciliations.reconcile(f.view.purchaseId, f.view.operationId, 'not-purchased', 'pairing:admin', () => {})).rejects.toMatchObject({ kind: 'busy' }); }
  finally { writer.release(); }
  expect(f.budget.state().reservations).toHaveLength(1);
  expect(f.purchases.list({ limit: 100, dayKey: undefined }).reconciliations).toHaveLength(0);
});

test('socket cancellation after durable owner choice preserves its finding and hold until bookkeeping resumes', async () => {
  const f = await fixture(), entered = gate(), resume = gate(), abort = new AbortController();
  const original = f.purchases.recordOwnerReconciliation.bind(f.purchases);
  f.purchases.recordOwnerReconciliation = async (checkpoint, current) => { entered.release(); await resume.pending; current(); await original(checkpoint, current); };
  const work = f.reconciliations.reconcile(f.view.purchaseId, f.view.operationId, 'purchased', 'pairing:admin', () => abort.signal.throwIfAborted());
  await entered.pending; abort.abort(); resume.release(); await expect(work).rejects.toThrow();
  expect(f.operations.get(f.view.purchaseId)?.outcome).toBe('owner-reconciliation-pending-purchased');
  expect(f.budget.state().reservations).toHaveLength(1);
  expect((await f.journal.list())).toHaveLength(1);
  const restored = f.reopen(); await restored.reconciliations.recover();
  expect(restored.operations.get(f.view.purchaseId)?.outcome).toBe('owner-confirmed-purchased');
  expect(restored.budget.state().spend).toHaveLength(1);
});

test('an identical-value hold reissued while the ledger append awaits is not the original live generation', async () => {
  const f = await fixture(), entered = gate(), resume = gate();
  const original = f.purchases.recordOwnerReconciliation.bind(f.purchases);
  f.purchases.recordOwnerReconciliation = async (checkpoint, current) => { entered.release(); await resume.pending; current(); await original(checkpoint, current); };
  const initial = f.budget.state().reservations[0]; if (!initial) throw new Error('Missing original hold');
  const pending = f.reconcile('purchased');
  await entered.pending;
  f.budget.release(initial.id);
  const replacement = f.budget.reserve({ id: initial.id, itemMinorUnits: initial.itemMinorUnits, overageMinorUnits: initial.overageMinorUnits,
    toleranceMinorUnits: initial.toleranceMinorUnits, limits: LIMITS, nowMs: initial.createdAtMs,
    timezone: 'UTC', ttlMs: initial.expiresAtMs - initial.createdAtMs, retainUntilSettled: true });
  if (!replacement) throw new Error('Missing replacement hold');
  expect(replacement).toEqual(initial); expect(replacement).not.toBe(initial);
  resume.release(); await expect(pending).rejects.toThrow();
  expect(f.budget.state().reservations[0]).toBe(replacement);
  expect(f.budget.state().spend).toHaveLength(0);
  expect(f.budget.state().reconciliations).toBeUndefined();
  expect((await f.journal.list())).toHaveLength(1);
  expect(f.operations.get(f.view.purchaseId)?.outcome).toBe('owner-reconciliation-pending-purchased');
});

test('an identical-value budget file replacement during the ledger await cannot be overwritten or reconciled', async () => {
  const f = await fixture(), entered = gate(), resume = gate();
  const original = f.purchases.recordOwnerReconciliation.bind(f.purchases);
  f.purchases.recordOwnerReconciliation = async (checkpoint, current) => { entered.release(); await resume.pending; current(); await original(checkpoint, current); };
  const pending = f.reconcile('not-purchased'); await entered.pending;
  const budgetPath = join(f.root, 'budget.json'), bytes = readFileSync(budgetPath), replacement = join(f.root, 'foreign-budget.json');
  writeFileSync(replacement, bytes); renameSync(replacement, budgetPath);
  resume.release(); await expect(pending).rejects.toThrow();
  expect(readFileSync(budgetPath)).toEqual(bytes);
  expect(f.operations.get(f.view.purchaseId)?.outcome).toBe('owner-reconciliation-pending-not-purchased');
  expect((await f.journal.list())).toHaveLength(1);
});

test('replacing a retained journal method during the ledger await refuses before accounting or cleanup', async () => {
  const f = await fixture(), entered = gate(), resume = gate();
  const original = f.purchases.recordOwnerReconciliation.bind(f.purchases);
  f.purchases.recordOwnerReconciliation = async (checkpoint, current) => { entered.release(); await resume.pending; current(); await original(checkpoint, current); };
  const pending = f.reconcile('not-purchased'); await entered.pending;
  f.journal.remove = async () => { throw new Error('A substituted cleanup must never be entered'); };
  resume.release(); await expect(pending).rejects.toThrow();
  expect(f.budget.state().reservations).toHaveLength(1);
  expect(f.budget.state().reconciliations).toBeUndefined();
});

test('an asynchronous native format hook is drained and rejected before owner audit publication', async () => {
  const f = await fixture();
  const purchases = new DaemonPurchaseLedger({ filePath: join(f.root, 'purchases.json'),
    beforeReconciliationWrite: () => Promise.reject(new Error('Synthetic asynchronous publication hook')) });
  const owner = new PurchaseReconciliations({ operations: f.operations, budget: f.budget, journal: f.journal,
    purchases, isPaymentsLeader: () => true, now: () => NOW }); closers.push(() => owner.close());
  await expect(owner.reconcile(f.view.purchaseId, f.view.operationId, 'not-purchased', 'pairing:admin', () => {})).rejects.toThrow();
  expect(existsSync(join(f.root, 'purchases.json'))).toBe(false);
  expect(f.budget.state().reservations).toHaveLength(1);
  expect((await f.journal.list())).toHaveLength(1);
});

test('a publisher callback cannot revoke the live owner and still publish its initial finding', async () => {
  const f = await fixture(), abort = new AbortController();
  f.beforePublication(() => abort.abort());
  await expect(f.reconciliations.reconcile(f.view.purchaseId, f.view.operationId, 'not-purchased', 'pairing:admin', () => abort.signal.throwIfAborted())).rejects.toThrow();
  f.beforePublication(() => {});
  expect(f.operations.get(f.view.purchaseId)?.outcome).toBeNull();
  expect(f.budget.state().reservations).toHaveLength(1);
  expect(existsSync(join(f.root, 'purchases.json'))).toBe(false);
});

test('close drains a journal dependency that ignores cancellation and retains the original lease until it settles', async () => {
  const f = await fixture(), entered = gate(), resume = gate();
  let block = false;
  const journal: CheckoutJournal = { list: () => f.journal.list(), put: row => f.journal.put(row), async remove(id) {
    if (block) { entered.release(); await resume.pending; }
    await f.journal.remove(id);
  } };
  const owner = f.reopen(journal); block = true;
  const pending = owner.reconciliations.reconcile(f.view.purchaseId, f.view.operationId, 'not-purchased', 'pairing:admin', () => {});
  await entered.pending;
  let closed = false; const closing = owner.reconciliations.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  expect(f.operations.recover(f.view.purchaseId)).toBeNull();
  resume.release(); await expect(pending).rejects.toThrow(); await closing;
  const restarted = f.reopen(); await restarted.reconciliations.recover();
  expect(restarted.operations.get(f.view.purchaseId)?.outcome).toBe('owner-confirmed-not-purchased');
  expect(restarted.budget.state().reconciliations).toHaveLength(1);
});

test('accounting receipt survives spend pruning when a crash prevented journal closure', async () => {
  const f = await fixture();
  const checkpointJournal: CheckoutJournal = { list: () => f.journal.list(), put: row => f.journal.put(row), async remove() { throw new Error('Injected journal failure'); } };
  const owner = f.reopen(checkpointJournal);
  await expect(owner.reconciliations.reconcile(f.view.purchaseId, f.view.operationId, 'purchased', 'pairing:admin', () => {})).rejects.toThrow();
  owner.budget.prune(NOW + 4 * 24 * 60 * 60 * 1000);
  expect(owner.budget.state().spend).toHaveLength(0);
  expect(owner.budget.state().reconciliations).toHaveLength(1);
  const restored = f.reopen(); await restored.reconciliations.recover();
  expect(restored.operations.get(f.view.purchaseId)?.outcome).toBe('owner-confirmed-purchased');
  expect(restored.budget.state().spend).toHaveLength(0);
  expect(restored.purchases.list({ limit: 100, dayKey: undefined }).reconciliations).toHaveLength(1);
});

test('native restart retains a pending checkpoint’s committed spend until its once-only accounting receipt is durable', async () => {
  const f = await fixture(), prior = receipt(f), entered = gate(), resume = gate(), abort = new AbortController();
  f.budget.commit(f.view.purchaseId, NOW - 50); await f.purchases.record(prior);
  const original = f.purchases.recordOwnerReconciliation.bind(f.purchases);
  f.purchases.recordOwnerReconciliation = async (checkpoint, current) => { entered.release(); await resume.pending; current(); await original(checkpoint, current); };
  const pending = f.reconciliations.reconcile(f.view.purchaseId, f.view.operationId, 'not-purchased', 'pairing:admin', () => abort.signal.throwIfAborted());
  await entered.pending; abort.abort(); resume.release(); await expect(pending).rejects.toThrow();
  expect(f.budget.state().reconciliations).toBeUndefined();
  const later = NOW + 4 * 24 * 60 * 60 * 1000, restarted = f.reopen(undefined, later);
  // The real composition consults original operation metadata before pruning.
  expect(restarted.budget.state().spend).toHaveLength(1);
  await restarted.reconciliations.recover();
  expect(restarted.operations.get(f.view.purchaseId)?.outcome).toBe('owner-confirmed-not-purchased');
  expect(restarted.budget.state().reconciliations).toHaveLength(1);
  expect(restarted.purchases.get(f.view.purchaseId)).toEqual(prior);
  restarted.budget.prune(later);
  expect(restarted.budget.state().spend).toHaveLength(0);
  expect(restarted.budget.state().reconciliations).toHaveLength(1);
});

test('an unverified receipt stays unverified and a no-order observation never credits already committed spend', async () => {
  const f = await fixture(), prior = receipt(f);
  f.budget.commit(f.view.purchaseId, NOW - 50); await f.purchases.record(prior);
  await f.journal.remove(f.view.purchaseId);
  const writer = f.operations.recover(f.view.purchaseId); if (!writer) throw new Error('Fixture lease');
  writer.update({ ...writer.read(), state: 'completed', outcome: 'submitted-unverified' }); writer.release();
  await f.reconcile('not-purchased');
  expect(f.purchases.get(f.view.purchaseId)).toEqual(prior);
  expect(f.budget.state().spend).toHaveLength(1);
  expect(f.budget.snapshot(LIMITS, NOW, 'UTC').item.remaining).toBe(8000);
});

test('the actual paired daemon dispatcher requires an explicit inspected-history confirmation and refuses shared credentials', async () => {
  const f = await fixture(), catalog = new GatewayMethodCatalog(), pairing = new PairingTokenManager(join(f.root, 'pairing.json'));
  const paired = pairing.mint({ name: 'Payment reconciliation owner' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared',
    userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
  closers.push(registerCatalogHandlers(catalog, [{ id: 'payments.purchase.reconcile', handler: purchaseReconciliationHandler(f.reconciliations), options: { confirm: true } }]));
  const body = { purchaseId: f.view.purchaseId, operationId: f.view.operationId, outcome: 'purchased', inspectedMerchantHistory: true, confirm: true };
  const call = (authToken: string, explicitUserRequest: boolean, input: Record<string, unknown> = body) => helper.invokeGatewayMethodCall({ methodId: 'payments.purchase.reconcile', body: input, authToken,
    context: { ...helper.describeAuthenticatedPrincipal(authToken), explicitUserRequest } });
  expect((await call('synthetic-shared', true)).status).toBe(403);
  expect((await call(paired.token, false)).status).not.toBe(200);
  expect((await call(paired.token, true, { ...body, inspectedMerchantHistory: false })).status).toBe(400);
  expect((await call(paired.token, true)).status).toBe(200);
  expect(f.operations.get(f.view.purchaseId)?.outcome).toBe('owner-confirmed-purchased');
});

test('recorded-submit recovery finishes the original durable hold before closing its crash journal', async () => {
  const f = await fixture(); await f.purchases.record(receipt(f));
  const registry = new CheckoutRegistry(f.journal);
  const recovery = new CheckoutRecovery({ registry, journal: f.journal, ledger: f.budget, purchases: f.purchases,
    retainInterrupted: id => f.operations.retainRecovery(id), isPaymentsLeader: () => true, now: () => NOW,
    notifier: { async deliver() { return []; }, async awaitAnswer() { return null; } } });
  closers.push(() => recovery.close());
  await recovery.recoverInterruptedCheckouts();
  expect(f.budget.state().reservations).toHaveLength(0);
  expect(f.budget.state().spend).toHaveLength(1);
  expect(await f.journal.list()).toHaveLength(0);
  const disk: unknown = JSON.parse(readFileSync(join(f.root, 'budget.json'), 'utf8'));
  expect(disk).toMatchObject({ reservations: [], spend: [{ purchaseId: f.view.purchaseId }] });
});
