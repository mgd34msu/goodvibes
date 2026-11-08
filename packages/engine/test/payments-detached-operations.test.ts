import { afterEach, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurablePaymentOperations, PaymentOperationStoreError } from '../sdk/src/platform/payments/host/operation-store.js';
import { CheckoutOperations } from '../sdk/src/platform/payments/host/checkout-operations.js';
import { DaemonPurchaseLedger } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import { MemoryCheckoutJournal } from '../sdk/src/platform/payments/checkout-registry.js';
import type { BeginCheckoutInput, PaymentBeginResult } from '../sdk/src/platform/payments/payments-gateway-service.js';
import type { PaymentOperationView } from '../sdk/src/platform/payments/operation-view.js';
import { configureDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';

const roots: string[] = [], cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() { const root = mkdtempSync(join(tmpdir(), 'payment-operations-')); roots.push(root); return root; }
function view(purchaseId = 'original-checkout'): PaymentOperationView {
  return { purchaseId, operationId: `operation:${purchaseId}`, state: 'accepted', phase: null, createdAtMs: 1, updatedAtMs: 1,
    outcome: null, totalMinorUnits: null, currency: null };
}
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
const input: BeginCheckoutInput = { sessionId: 'session', pageId: 'page', merchantDomain: 'example.com', checkoutUrl: 'https://example.com/checkout',
  item: 'owner item', cardId: 'fixture-card', requestedLines: [{ label: 'item', quantity: 1 }],
  reading: { lines: [{ label: 'item', quantity: '1', unitPrice: '1.00' }], tax: null, fees: [], shippingOptions: [{ label: 'standard', cost: '0' }], statedTotal: null, currency: 'USD', orderSummaryText: 'page fixture only' },
  controls: { cardFields: [{ field: 'number', ref: 'card' }], placeOrderTarget: 'submit', expirySeparator: undefined } };
function refusal(purchaseId: string): PaymentBeginResult {
  return { outcome: 'refused:no-card', purchaseId, reason: 'No usable card', merchantOrderId: null, totalMinorUnits: null,
    currency: null, shippingTierUsed: null, steppedDown: false, challengeStep: null };
}

test('populated admission is exclusive, immutable by retry and readable after a store restart', () => {
  const path = directory(), store = new DurablePaymentOperations(path), operation = view();
  const writer = store.create(operation, 'pairing:owner', () => {}); cleanup.push(() => writer.release());
  expect(new DurablePaymentOperations(path).get(operation.purchaseId)).toEqual(operation);
  expect(() => new DurablePaymentOperations(path).create({ ...operation, operationId: 'replacement' }, 'pairing:other', () => {})).toThrow(PaymentOperationStoreError);
  expect(new DurablePaymentOperations(path).recover(operation.purchaseId)).toBeNull();
  expect(new DurablePaymentOperations(path).retainRecovery(operation.purchaseId)).toBeNull();
  writer.update({ ...operation, state: 'running', updatedAtMs: 2 });
  writer.release();
  const recovered = new DurablePaymentOperations(path).recover(operation.purchaseId);
  expect(recovered?.read().state).toBe('running'); recovered?.release();
});

test('a lost or unsafe operation index never becomes an empty payment history', () => {
  const path = directory(), store = new DurablePaymentOperations(path), operation = view();
  const writer = store.create(operation, null, () => {}); writer.release();
  unlinkSync(join(path, 'index'));
  expect(() => store.list()).toThrow(PaymentOperationStoreError);
  expect(() => new DurablePaymentOperations(path).list()).toThrow(PaymentOperationStoreError);
  symlinkSync(join(path, 'absent'), join(path, 'index'));
  expect(() => new DurablePaymentOperations(path).list()).toThrow(PaymentOperationStoreError);
  expect(new DurablePaymentOperations(path).get(operation.purchaseId)).toEqual(operation);
});

test('operation evidence replacement retires its writer without replacing the foreign bytes', () => {
  const path = directory(), store = new DurablePaymentOperations(path), operation = view();
  const writer = store.create(operation, null, () => {}); cleanup.push(() => writer.release());
  const row = join(path, `${Buffer.from(operation.purchaseId).toString('base64url')}.json`);
  const bytes = readFileSync(row); writeFileSync(join(path, 'replacement'), bytes); renameSync(join(path, 'replacement'), row);
  expect(() => writer.update({ ...operation, state: 'running' })).toThrow(PaymentOperationStoreError);
  expect(readFileSync(row)).toEqual(bytes);
});

test('bounded recent status keeps open financial uncertainty and old request identities', () => {
  const path = directory(), store = new DurablePaymentOperations(path);
  const uncertain = store.create(view('uncertain'), null, () => {});
  uncertain.update({ ...uncertain.read(), state: 'uncertain', phase: 'submit-pending' }); uncertain.release();
  for (let i = 0; i < 105; i++) {
    const writer = store.create(view(`finished-${i}`), null, () => {});
    writer.update({ ...writer.read(), state: 'refused', outcome: 'refused:no-card' }); writer.release();
  }
  const reopened = new DurablePaymentOperations(path);
  expect(reopened.list()).toHaveLength(101);
  expect(reopened.list().some(entry => entry.purchaseId === 'uncertain')).toBe(true);
  expect(reopened.get('finished-0')?.state).toBe('refused');
  expect(() => reopened.create(view('finished-0'), null, () => {})).toThrow(PaymentOperationStoreError);
  expect(readdirSync(path).filter(file => file.endsWith('.json'))).toHaveLength(106);
});

test('durable acknowledgement survives request abort, uses a root-owned context and drains on stop', async () => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations')), request = new AbortController();
  const context = new AsyncLocalStorage<string>(), entered = barrier(), gate = barrier();
  cleanup.push(gate.release, configureDecisionModelPolicy(() => 'Default - On'));
  let executions = 0, captured: BeginCheckoutInput | undefined, inherited: string | undefined, admitted = 0;
  const operations = new CheckoutOperations(store, new MemoryCheckoutJournal(), new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }), async (owned, id, owner) => {
    executions++; captured = owned; inherited = context.getStore(); entered.release(); await gate.wait; owner.assertCurrent(); return refusal(id);
  });
  cleanup.push(async () => { gate.release(); await operations.close(); }); await operations.recover();
  const body = { ...structuredClone(input) };
  const accepted = context.run('request-only', () => operations.admit('request', body, { principalId: 'pairing:owner', assertCurrent() {} }, () => request.signal.throwIfAborted(), () => { admitted++; }));
  expect(accepted.state).toBe('accepted'); expect(store.get('request')).toEqual(accepted);
  request.abort(); body.item = 'changed after acknowledgement';
  await entered.wait;
  expect(inherited).toBeUndefined(); expect(captured?.item).toBe('owner item'); expect(executions).toBe(1);
  expect(() => operations.admit('request', { ...input, item: 'changed retry' }, { principalId: 'pairing:owner', assertCurrent() {} }, () => {}, () => { admitted++; })).toThrow(PaymentOperationStoreError);
  expect(admitted).toBe(1);
  expect(() => operations.cancel('request', 'different-operation')).toThrow(PaymentOperationStoreError);
  expect(operations.cancel('request', accepted.operationId)).toEqual({ purchaseId: 'request', operationId: accepted.operationId, accepted: true, mayHaveSubmitted: false });
  let drained = false; const closing = operations.close().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  gate.release(); await closing;
  expect(store.get('request')?.state).toBe('cancelled');
  const contents = readFileSync(join(path, 'operations', `${Buffer.from('request').toString('base64url')}.json`), 'utf8');
  expect(contents).not.toContain(input.reading.orderSummaryText); expect(contents).not.toContain(input.checkoutUrl);
});

test('restart status cannot downgrade known submit-pending evidence when its journal is missing', async () => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations'));
  const writer = store.create({ ...view(), state: 'running', phase: 'submit-pending' }, null, () => {}); writer.release();
  let executions = 0;
  const operations = new CheckoutOperations(store, new MemoryCheckoutJournal(), new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }), async (_input, id) => { executions++; return refusal(id); });
  cleanup.push(() => operations.close()); await operations.recover();
  expect(store.get('original-checkout')?.state).toBe('uncertain'); expect(executions).toBe(0);
});
