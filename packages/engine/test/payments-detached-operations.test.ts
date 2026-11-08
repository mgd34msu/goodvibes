import { afterEach, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurablePaymentOperations, PaymentOperationStoreError } from '../sdk/src/platform/payments/host/operation-store.js';
import { CheckoutOperations } from '../sdk/src/platform/payments/host/checkout-operations.js';
import { DaemonPurchaseLedger } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import { MemoryCheckoutJournal } from '../sdk/src/platform/payments/checkout-registry.js';
import type { BeginCheckoutInput, PaymentBeginResult } from '../sdk/src/platform/payments/payments-gateway-service.js';
import type { PaymentOperationView } from '../sdk/src/platform/payments/operation-view.js';
import { configureDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { ProtectedPaymentRequests, type PaymentRequestStore } from '../sdk/src/platform/payments/host/protected-requests.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.ts';
import { parseCurrencyCode, ownerSuppliedText } from '../sdk/src/platform/payments/types.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { paymentContinuationBinding } from '../sdk/src/platform/payments/host/continuation-binding.js';
import { PaymentReplyWindowError } from '../sdk/src/platform/payments/reply-inbox.js';
import { readPaymentOperation, paymentOperationDescription } from '../sdk/src/platform/payments/operation-view.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';

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

test('the real detached owner checkpoints its current flushed quote through the original encrypted-store method', async () => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations')),
    requests = new ProtectedPaymentRequests(join(path, 'requests')), original = protectedPaymentRequest(), journal = new MemoryCheckoutJournal();
  const capture = barrier(), resume = barrier(), published = barrier(), finish = barrier();
  cleanup.push(resume.release, finish.release, configureDecisionModelPolicy(() => 'Default - On'));
  let captures = 0, windows = 0;
  const wrapper: PaymentRequestStore = { retain: requests.retain.bind(requests), read: requests.read.bind(requests), remove: requests.remove.bind(requests),
    async checkpointWindow(...args) { windows++; await requests.checkpointWindow(...args); } };
  const operations = new CheckoutOperations(store, journal, new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }), async (owned, id, owner) => {
    const checkpoint = protectedPaymentWindow({ ...original, purchaseId: id, input: owned });
    await journal.put(checkpoint.record);
    if (!owner.retainWindowCheckpoint) throw new Error('Native executor did not receive its window writer');
    await owner.retainWindowCheckpoint(checkpoint);
    published.release(); await finish.wait; return refusal(id);
  }, Date.now, wrapper);
  cleanup.push(async () => { resume.release(); finish.release(); await operations.close(); });
  await operations.recover();
  const source = { principalId: original.principalId, assertCurrent: () => {}, taintEvidence: original.evidence, recoveryFacts: original.host,
    async captureBrowserRecovery() { if (++captures === 2) { capture.release(); await resume.wait; } return null; } };
  const accepted = await operations.admit(original.purchaseId, original.input, source, () => {}, () => {});
  await capture.wait;
  expect((await requests.read(original.purchaseId, accepted.operationId, () => {})).window).toBeUndefined();
  source.captureBrowserRecovery = async () => { throw new Error('Replacement browser reader'); };
  wrapper.checkpointWindow = async () => { throw new Error('Replacement window writer'); };
  resume.release(); await published.wait;
  const saved = await requests.read(original.purchaseId, accepted.operationId, () => {});
  expect(saved.window?.reading.lines[0]?.unitPrice).toBe('20.00'); expect(saved.input.reading.lines[0]?.unitPrice).toBe('10.00');
  expect(saved.window?.record).toEqual((await journal.list())[0]); expect(captures).toBe(2); expect(windows).toBe(1);
  finish.release(); await operations.close();
});

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
  const accepted = await context.run('request-only', () => operations.admit('request', body, { principalId: 'pairing:owner', assertCurrent() {} }, () => request.signal.throwIfAborted(), () => { admitted++; }));
  expect(accepted.state).toBe('accepted'); expect(store.get('request')).toEqual(accepted);
  request.abort(); body.item = 'changed after acknowledgement';
  await entered.wait;
  expect(inherited).toBeUndefined(); expect(captured?.item).toBe('owner item'); expect(executions).toBe(1);
  await expect(operations.admit('request', { ...input, item: 'changed retry' }, { principalId: 'pairing:owner', assertCurrent() {} }, () => {}, () => { admitted++; })).rejects.toBeInstanceOf(PaymentOperationStoreError);
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

test('a refused reply source reaches real durable status and the shared browser/terminal explanation', async () => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations'));
  const entered = barrier(), release = barrier(); cleanup.push(release.release, configureDecisionModelPolicy(() => 'Default - On'));
  const operations = new CheckoutOperations(store, new MemoryCheckoutJournal(), new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }), async () => {
    entered.release(); await release.wait; throw new PaymentReplyWindowError('source-unavailable');
  });
  cleanup.push(async () => { release.release(); await operations.close(); }); await operations.recover();
  await operations.admit('source-unavailable', input, { principalId: 'pairing:owner', assertCurrent() {} }, () => {}, () => {});
  await entered.wait; release.release();
  const deadline = Date.now() + 2000;
  while (store.get('source-unavailable')?.state !== 'failed') {
    if (Date.now() >= deadline) throw new Error('Source failure was not accounted');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const view = readPaymentOperation(new DurablePaymentOperations(join(path, 'operations')).get('source-unavailable'));
  expect(view.outcome).toBe('reply-source-unavailable');
  expect(paymentOperationDescription(view)).toContain('Telegram polling');
  expect(paymentOperationDescription(view)).toContain('Payments controls');
});

test('browser observation during preparation retains the real execution lease and shutdown ownership', async () => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations'));
  const original = protectedPaymentRequest('browser-preparation'), requests = new ProtectedPaymentRequests(join(path, 'requests'));
  const entered = barrier(), release = barrier(); let executed = false;
  const operations = new CheckoutOperations(store, new MemoryCheckoutJournal(), new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }),
    async (_input, id) => { executed = true; return refusal(id); }, undefined, requests);
  cleanup.push(() => operations.close(), release.release); await operations.recover();
  const preparing = operations.admit(original.purchaseId, original.input, { principalId: original.principalId,
    assertCurrent() {}, taintEvidence: original.evidence, recoveryFacts: original.host,
    async capturePageConnection(captured, owner) {
      expect(captured.sessionId).toBe(original.input.sessionId); expect(captured.pageId).toBe(original.input.pageId);
      entered.release(); await release.wait; owner.assertCurrent(); return null;
    },
  }, () => {}, () => {}).catch(error => error as unknown);
  await entered.wait;
  expect(new DurablePaymentOperations(join(path, 'operations')).recover(original.purchaseId)).toBeNull();
  expect(existsSync(join(path, 'requests'))).toBe(false); expect(executed).toBe(false);
  let drained = false; const closing = operations.close().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  release.release(); expect(await preparing).toBeInstanceOf(Error); await closing;
  expect(drained).toBe(true); expect(executed).toBe(false);
  expect(store.get(original.purchaseId)?.state).toBe('cancelled');
});

test('admission waits for durable original facts and binds original storage methods and request values', async () => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations'));
  const requests = new ProtectedPaymentRequests(join(path, 'requests')), fixture = protectedPaymentRequest('durable-admission');
  const pairing = new PairingTokenManager(join(path, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic operation owner' });
  const native = pairing.authenticateNative(paired.token); if (!native) throw new Error('Missing original paired owner');
  const authority = { ...native, scopes: ['write:payments'] };
  const original = { ...fixture, principalId: native.principalId, host: { ...fixture.host, authority } };
  const retained = barrier(), releaseStorage = barrier(), entered = barrier(), releaseExecutor = barrier();
  cleanup.push(releaseStorage.release, releaseExecutor.release, configureDecisionModelPolicy(() => 'Default - On'));
  let acknowledgements = 0, executions = 0, sourceChecks = 0, removals = 0;
  const wrapper: PaymentRequestStore = {
    async retain(value, current) { await requests.retain(value, current); retained.release(); await releaseStorage.wait; },
    read: requests.read.bind(requests),
    async remove(id, operationId, current) { removals++; await requests.remove(id, operationId, current); },
  };
  const operations = new CheckoutOperations(store, new MemoryCheckoutJournal(), new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }), async (owned, id, owner) => {
    executions++; expect(owned.item).toBe(original.input.item); expect(owner.taintEvidence).toEqual(original.evidence);
    entered.release(); await releaseExecutor.wait; owner.assertCurrent(); return refusal(id);
  }, Date.now, wrapper);
  cleanup.push(async () => { releaseStorage.release(); releaseExecutor.release(); await operations.close(); });
  await operations.recover();
  const body = structuredClone(original.input), source = { principalId: original.principalId, taintEvidence: structuredClone(original.evidence),
    recoveryFacts: structuredClone(original.host), assertCurrent() { sourceChecks++; },
    issueContinuation(operationId: string, current: () => void) { const binding = paymentContinuationBinding(operationId);
      return pairing.issueNativeContinuation(paired.token, authority, binding, current, binding); },
    revokeContinuation: pairing.revokeNativeContinuation.bind(pairing) };
  const pending = operations.admit(original.purchaseId, body, source, () => {}, () => {}).then(value => { acknowledgements++; return value; });
  await retained.wait;
  expect(acknowledgements).toBe(0); expect(executions).toBe(0);
  const accepted = store.get(original.purchaseId); if (!accepted) throw new Error('Expected retained operation');
  expect(new DurablePaymentOperations(join(path, 'operations')).recover(original.purchaseId)).toBeNull();
  const saved = await new ProtectedPaymentRequests(join(path, 'requests')).read(original.purchaseId, accepted.operationId, () => {});
  expect(saved.input.item).toBe(original.input.item); expect(saved.evidence).toEqual(original.evidence);
  if (!saved.host.continuation) throw new Error('Original grant was not durably retained');
  expect(pairing.readNativeContinuation(saved.host.continuation)).toEqual(authority);
  body.item = 'changed during persistence'; source.assertCurrent = () => { throw new Error('replacement callback'); };
  source.issueContinuation = () => { throw new Error('replacement issuer'); };
  source.revokeContinuation = () => { throw new Error('replacement revoker'); };
  wrapper.retain = async () => { throw new Error('replacement retain'); }; wrapper.remove = async () => { throw new Error('replacement remove'); };
  releaseStorage.release(); await pending; await entered.wait;
  expect(acknowledgements).toBe(1); expect(executions).toBe(1); expect(sourceChecks).toBeGreaterThan(0);
  releaseExecutor.release(); await operations.close();
  expect(removals).toBe(1);
  expect(pairing.readNativeContinuation(saved.host.continuation)).toBeNull();
  expect(existsSync(join(path, 'requests', `${Buffer.from(original.purchaseId).toString('base64url')}.json`))).toBe(false);
});

test('closing during preparation owns delayed grant retirement before dropping protected facts or the execution lease', async () => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations')), requests = new ProtectedPaymentRequests(join(path, 'requests'));
  const fixture = protectedPaymentRequest('pending-private-grant'), pairing = new PairingTokenManager(join(path, 'pairing.json'));
  const paired = pairing.mint({ name: 'Synthetic delayed-revocation owner' }), native = pairing.authenticateNative(paired.token);
  if (!native) throw new Error('Missing original pairing');
  const authority = { ...native, scopes: ['write:payments'] };
  const retained = barrier(), releaseStore = barrier(), retiring = barrier(), releaseRevocation = barrier();
  cleanup.push(releaseStore.release, releaseRevocation.release, configureDecisionModelPolicy(() => 'Default - On'));
  let executions = 0;
  const operations = new CheckoutOperations(store, new MemoryCheckoutJournal(), new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }), async (_owned, id) => { executions++; return refusal(id); }, Date.now, {
    async retain(value, current) { await requests.retain(value, current); retained.release(); await releaseStore.wait; },
    read: requests.read.bind(requests), remove: requests.remove.bind(requests),
  });
  cleanup.push(async () => { releaseStore.release(); releaseRevocation.release(); await operations.close(); }); await operations.recover();
  const pending = operations.admit(fixture.purchaseId, fixture.input, {
    principalId: native.principalId, assertCurrent() {}, taintEvidence: fixture.evidence, recoveryFacts: { ...fixture.host, authority },
    issueContinuation(operationId, current) { const binding = paymentContinuationBinding(operationId);
      return pairing.issueNativeContinuation(paired.token, authority, binding, current, binding); },
    async revokeContinuation(grant) { retiring.release(); await releaseRevocation.wait; pairing.revokeNativeContinuation(grant); },
  }, () => {}, () => {}).then(() => null, error => error as unknown);
  await retained.wait;
  const admitted = store.get(fixture.purchaseId); if (!admitted) throw new Error('Missing owned operation');
  const saved = await new ProtectedPaymentRequests(join(path, 'requests')).read(fixture.purchaseId, admitted.operationId, () => {});
  if (!saved.host.continuation) throw new Error('Missing actual issued grant');
  let drained = false; const closing = operations.close().then(() => { drained = true; });
  releaseStore.release(); await retiring.wait;
  expect(drained).toBe(false); expect(executions).toBe(0);
  expect(new DurablePaymentOperations(join(path, 'operations')).recover(fixture.purchaseId)).toBeNull();
  expect(pairing.readNativeContinuation(saved.host.continuation)).toEqual(authority);
  expect(existsSync(join(path, 'requests', `${Buffer.from(fixture.purchaseId).toString('base64url')}.json`))).toBe(true);
  releaseRevocation.release(); expect(await pending).not.toBeNull(); await closing;
  expect(pairing.readNativeContinuation(saved.host.continuation)).toBeNull();
  expect(existsSync(join(path, 'requests', `${Buffer.from(fixture.purchaseId).toString('base64url')}.json`))).toBe(false);
});

test.each(['cancel', 'close', 'request-abort'] as const)('%s during durable preparation drains storage and never launches the checkout', async stop => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations')), requests = new ProtectedPaymentRequests(join(path, 'requests'));
  const original = protectedPaymentRequest('pending-original'), retained = barrier(), release = barrier(), request = new AbortController();
  cleanup.push(release.release, configureDecisionModelPolicy(() => 'Default - On'));
  let executions = 0, acknowledge = false;
  const operations = new CheckoutOperations(store, new MemoryCheckoutJournal(), new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') }), async (_owned, id) => { executions++; return refusal(id); }, Date.now, {
    async retain(value, current) { await requests.retain(value, current); retained.release(); await release.wait; },
    read: requests.read.bind(requests), remove: requests.remove.bind(requests),
  });
  cleanup.push(async () => { release.release(); await operations.close(); }); await operations.recover();
  const pending = operations.admit(original.purchaseId, original.input,
    { principalId: original.principalId, assertCurrent() {}, taintEvidence: original.evidence, recoveryFacts: original.host },
    () => request.signal.throwIfAborted(), () => {}).then(() => { acknowledge = true; return null; }, error => error as unknown);
  await retained.wait;
  const accepted = store.get(original.purchaseId); if (!accepted) throw new Error('Missing original operation');
  let drained = false, closing: Promise<void> | undefined;
  if (stop === 'cancel') operations.cancel(original.purchaseId, accepted.operationId);
  else if (stop === 'request-abort') request.abort(new Error('request gone during admission'));
  else { closing = operations.close().then(() => { drained = true; }); }
  await Promise.resolve(); expect(drained).toBe(false); expect(acknowledge).toBe(false);
  expect(new DurablePaymentOperations(join(path, 'operations')).recover(original.purchaseId)).toBeNull();
  release.release(); expect(await pending).not.toBeNull(); await closing;
  expect(executions).toBe(0); expect(acknowledge).toBe(false);
  expect(store.get(original.purchaseId)?.state).toBe(stop === 'request-abort' ? 'failed' : 'cancelled');
  expect(existsSync(join(path, 'requests', `${Buffer.from(original.purchaseId).toString('base64url')}.json`))).toBe(false);
});

test.each(['unknown', 'submitted-unverified'] as const)('a %s merchant submission retains its original encrypted facts after executor drainage', async outcome => {
  const path = directory(), store = new DurablePaymentOperations(join(path, 'operations')), requests = new ProtectedPaymentRequests(join(path, 'requests'));
  const original = protectedPaymentRequest('unknown-submission'), entered = barrier(), release = barrier();
  const journal = new MemoryCheckoutJournal(), currency = parseCurrencyCode('USD'), item = ownerSuppliedText(original.input.item, 'owner-direct');
  const purchases = new DaemonPurchaseLedger({ filePath: join(path, 'purchases.json') });
  if (!currency || !item) throw new Error('Invalid fixture');
  cleanup.push(release.release, configureDecisionModelPolicy(() => 'Default - On'));
  const operations = new CheckoutOperations(store, journal, purchases, async (_owned, id) => {
    // Actual journal publication is the progress source; uncertainty must not
    // become a generic safe failure when the executor then loses its response.
    const record = { purchaseId: id, phase: 'submit-pending' as const, totalMinorUnits: 1000, currency, item,
      sessionId: original.input.sessionId, pageId: original.input.pageId, merchantDomain: original.input.merchantDomain,
      cardId: original.input.cardId, startedAtMs: Date.now(), updatedAtMs: Date.now(), draw: null, reservationId: null,
      shippingTierRequested: 'normal' as const, shippingTierUsed: 'normal' as const, stepDown: null };
    await journal.put(record); operations.progress(record);
    entered.release(); await release.wait;
    if (outcome === 'submitted-unverified') {
      await purchases.record({ purchaseId: id, atUtc: '2026-11-08T00:00:00Z', dayKey: '2026-11-08', timezone: 'UTC',
        merchantDomain: original.input.merchantDomain, item, currency, itemMinorUnits: 1000, taxMinorUnits: 0,
        feesMinorUnits: 0, shippingMinorUnits: 0, totalMinorUnits: 1000, shippingTierRequested: 'normal', shippingTierUsed: 'normal',
        steppedDown: false, itemPoolDraw: 1000, overagePoolDraw: 0, tolerancePoolDraw: 0, cardLast4: '1111',
        windowKind: 'approval', windowOutcome: 'approved', answeredBy: 'operator', outcome,
        refusalReason: null, merchantOrderId: null, refundedAt: null, merchantRecognised: true, merchantQualifier: 'major-retailer', merchantDiscovered: false });
    }
    throw new Error('merchant confirmation unavailable');
  }, Date.now, requests);
  cleanup.push(async () => { release.release(); await operations.close(); }); await operations.recover();
  const accepted = await operations.admit(original.purchaseId, original.input,
    { principalId: original.principalId, assertCurrent() {}, taintEvidence: original.evidence, recoveryFacts: original.host }, () => {}, () => {});
  await entered.wait; release.release(); await operations.close();
  expect(store.get(original.purchaseId)?.state).toBe(outcome === 'unknown' ? 'uncertain' : 'completed');
  const saved = await new ProtectedPaymentRequests(join(path, 'requests')).read(original.purchaseId, accepted.operationId, () => {});
  expect(saved.input.item).toBe(original.input.item);
});
