import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckoutOperations } from '../platform/src/platform/payments/host/checkout-operations.js';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.js';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.js';
import { ProtectedPaymentRequests } from '../platform/src/platform/payments/host/protected-requests.js';
import { paymentContinuationBinding } from '../platform/src/platform/payments/host/continuation-binding.js';
import { MemoryCheckoutJournal } from '../platform/src/platform/payments/checkout-registry.js';
import { BudgetLedger } from '../platform/src/platform/payments/budget.js';
import { retainResumedCheckoutHold } from '../platform/src/platform/payments/resumed-hold.js';
import { PaymentReplyWindowError } from '../platform/src/platform/payments/reply-inbox.js';
import { paymentOperationDescription, type PaymentOperationView } from '../platform/src/platform/payments/operation-view.js';
import type { PaymentBeginResult } from '../platform/src/platform/payments/payments-gateway-service.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
function refusal(purchaseId: string): PaymentBeginResult {
  return { outcome: 'refused:no-card', purchaseId, reason: 'Fixture refusal', merchantOrderId: null, totalMinorUnits: null,
    currency: null, shippingTierUsed: null, steppedDown: false, challengeStep: null };
}

/** Durable stores holding interrupted payment windows, as a crash leaves them. */
function interruptedWindows(ids: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'payment-operation-recovery-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(configureDecisionModelPolicy(() => 'Default - On'));
  const store = new DurablePaymentOperations(join(root, 'operations')), requests = new ProtectedPaymentRequests(join(root, 'requests'));
  const journal = new MemoryCheckoutJournal(), pairing = new PairingTokenManager(join(root, 'pairing.json'));
  const paired = pairing.mint({ name: 'Synthetic recovery owner' }), native = pairing.authenticateNative(paired.token);
  if (!native) throw new Error('Missing native owner');
  const authority = { ...native, scopes: ['write:payments'] };
  const connection = { version: 1 as const, endpoint: 'ws://127.0.0.1:9222/devtools/browser/original', targetId: 'original-target',
    browserContextId: 'original-context', frames: [{ id: 'original-frame', loaderId: 'original-document', parentId: null }] };
  const prepared = async () => Promise.all(ids.map(async id => {
    const original = protectedPaymentRequest(id), binding = paymentContinuationBinding(original.operationId);
    const continuation = pairing.issueNativeContinuation(paired.token, authority, binding, () => {}, binding);
    const browserControls = { version: 1 as const, snapshotId: 'original-snapshot', url: original.input.checkoutUrl,
      controls: [original.input.controls.cardFields[0]?.ref ?? 'card', original.input.controls.placeOrderTarget].map((ref, index) => ({
        ref, role: index ? 'button' : 'textbox', name: index ? 'Place order' : 'Card number', tag: index ? 'button' : 'input',
        selector: index ? '#submit' : '#card', depth: 1, submits: !!index, frameChain: [], metadata: { name: 'Fixture control', documentUrl: original.input.checkoutUrl } })) };
    const request = { ...original, principalId: native.principalId,
      host: { ...original.host, authority, continuation, browser: connection, browserControls }, window: protectedPaymentWindow(original) };
    await requests.retain(request, () => {}); await journal.put(request.window.record);
    store.create({ purchaseId: id, operationId: request.operationId, state: 'running', phase: 'awaiting-window',
      createdAtMs: 1, updatedAtMs: 2, outcome: null, currency: 'USD', totalMinorUnits: 2_000 }, request.principalId, () => {}).release();
    return request;
  }));
  return { root, store, requests, journal, prepared,
    purchases: new DaemonPurchaseLedger({ filePath: join(root, 'purchases.json') }) };
}

test('one window whose hold is gone does not stop boot recovery of the others or later admission', async () => {
  const f = interruptedWindows(['missing-hold', 'intact-window']), [missing, intact] = await f.prepared();
  if (!missing || !intact) throw new Error('Missing fixture windows');
  const operations = new CheckoutOperations(f.store, f.journal, f.purchases, async (_input, id) => refusal(id), Date.now, f.requests);
  cleanup.push(() => operations.close().catch(() => {}));
  await operations.retainInterruptedWindows(request => {
    // The real cleanup retains the original hold, which a crash between hold
    // release and journal removal left behind for only one of the two.
    if (request.purchaseId === missing.purchaseId) retainResumedCheckoutHold(new BudgetLedger(), request.window?.record ?? missing.window.record);
    return async () => true;
  });
  const skipped = f.store.get(missing.purchaseId);
  expect(skipped).toMatchObject({ state: 'interrupted', outcome: 'refused:recovery-unavailable' });
  expect(paymentOperationDescription(skipped as PaymentOperationView)).toContain('could not be restored');
  // The unrestorable one is free for the ordinary sweep; the other stays retained to resume.
  const sweep = new DurablePaymentOperations(join(f.root, 'operations'));
  const lease = sweep.retainRecovery(missing.purchaseId); expect(lease).not.toBeNull(); lease?.release();
  expect(sweep.retainRecovery(intact.purchaseId)).toBeNull();
  await operations.recover();
  const admitted = await operations.admit('after-recovery', missing.input, { principalId: missing.principalId, assertCurrent() {},
    taintEvidence: missing.evidence, recoveryFacts: missing.host }, () => {}, () => {});
  expect(admitted.state).toBe('accepted');
});

test('cleanup failing after an owner cancel keeps the cancelled result and its outcome', async () => {
  const f = interruptedWindows(['cancelled-window']), [original] = await f.prepared();
  if (!original) throw new Error('Missing fixture window');
  const entered = barrier(), finish = barrier(); cleanup.push(finish.release);
  const operations = new CheckoutOperations(f.store, f.journal, f.purchases, async () => { throw new Error('Recovery cannot admit a fresh begin'); }, Date.now, f.requests);
  await operations.retainInterruptedWindows(() => async () => { throw new Error('Fixture journal removal failed'); });
  await operations.recover();
  operations.resumeInterruptedWindows(async request => ({
    source: { principalId: request.principalId, assertCurrent() {} }, input: request.input, release: async () => {},
    async execute(_input, id) { entered.release(); await finish.wait; return refusal(id); },
  }));
  await entered.wait;
  expect(operations.cancel(original.purchaseId, original.operationId)).toMatchObject({ accepted: true, mayHaveSubmitted: false });
  finish.release(); await operations.close().catch(() => {});
  expect(f.store.get(original.purchaseId)).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
});

test('a reply still being read when its window closes is recorded as that, with nothing submitted', async () => {
  const f = interruptedWindows([]);
  const operations = new CheckoutOperations(f.store, f.journal, f.purchases, async () => { throw new PaymentReplyWindowError('unsettled-reply'); });
  cleanup.push(() => operations.close());
  await operations.recover();
  const original = protectedPaymentRequest('late-reading');
  await operations.admit(original.purchaseId, original.input, { principalId: original.principalId, assertCurrent() {} }, () => {}, () => {});
  const deadline = Date.now() + 2000;
  while (f.store.get(original.purchaseId)?.state !== 'refused') {
    if (Date.now() > deadline) throw new Error('The late reading was not accounted');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const operation = f.store.get(original.purchaseId) as PaymentOperationView;
  expect(operation.outcome).toBe('refused:reply-unsettled');
  expect(paymentOperationDescription(operation)).toContain('still being read when it closed');
});

test.each(['invalid', 'duplicate', 'stale'] as const)('a reply window that could not be opened (%s) is reported as that, not as a generic stop', async kind => {
  const f = interruptedWindows([]);
  const operations = new CheckoutOperations(f.store, f.journal, f.purchases, async () => { throw new PaymentReplyWindowError(kind); });
  cleanup.push(() => operations.close());
  await operations.recover();
  const original = protectedPaymentRequest(`window-${kind}`);
  await operations.admit(original.purchaseId, original.input, { principalId: original.principalId, assertCurrent() {} }, () => {}, () => {});
  const deadline = Date.now() + 2000;
  while (f.store.get(original.purchaseId)?.state !== 'refused') {
    if (Date.now() > deadline) throw new Error('The window failure was not accounted');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const operation = f.store.get(original.purchaseId) as PaymentOperationView;
  expect(operation.outcome).toBe('refused:window-unavailable');
  expect(paymentOperationDescription(operation)).toContain('could not be opened');
});

test('boot recovery keeps its phase fallback: a possible submission with no journal record stays uncertain, never interrupted', async () => {
  const f = interruptedWindows([]);
  const create = (id: string, phase: 'submit-pending' | 'awaiting-window') => f.store.create({ purchaseId: id, operationId: `operation:${id}`, state: 'running', phase,
    createdAtMs: 1, updatedAtMs: 2, outcome: null, currency: 'USD', totalMinorUnits: 2_000 }, 'principal', () => {}).release();
  create('possibly-submitted', 'submit-pending'); create('not-submitted', 'awaiting-window');
  const operations = new CheckoutOperations(f.store, f.journal, f.purchases, async (_input, id) => refusal(id));
  cleanup.push(() => operations.close());
  await operations.recover();
  expect(f.store.get('possibly-submitted')).toMatchObject({ state: 'uncertain', phase: 'submit-pending' });
  expect(f.store.get('not-submitted')).toMatchObject({ state: 'interrupted', phase: 'awaiting-window', outcome: 'refused:daemon-stopped' });
});

test('admission before boot recovery names boot recovery, not unavailable evidence', async () => {
  const f = interruptedWindows([]);
  const operations = new CheckoutOperations(f.store, f.journal, f.purchases, async (_input, id) => refusal(id));
  cleanup.push(() => operations.close());
  const original = protectedPaymentRequest('before-recovery');
  await expect(operations.admit(original.purchaseId, original.input, { principalId: original.principalId, assertCurrent() {} }, () => {}, () => {}))
    .rejects.toThrow('boot recovery');
  expect(f.store.get(original.purchaseId)).toBeNull();
});

test('purchase status lists the readable records and names the unreadable one, while the strict listing still refuses', () => {
  const f = interruptedWindows([]);
  for (const id of ['readable', 'damaged']) f.store.create({ purchaseId: id, operationId: `operation:${id}`, state: 'refused', phase: null,
    createdAtMs: 1, updatedAtMs: 1, outcome: 'refused:no-card', totalMinorUnits: null, currency: null }, null, () => {}).release();
  writeFileSync(join(f.root, 'operations', `${Buffer.from('damaged').toString('base64url')}.json`), '{"not":"an operation"}\n');
  const store = new DurablePaymentOperations(join(f.root, 'operations'));
  const report = store.report();
  expect(report.operations.map(operation => operation.purchaseId)).toEqual(['readable']);
  expect(report.unreadable).toEqual([{ purchaseId: 'damaged', reason: expect.stringContaining('purchase damaged is unreadable or missing') }]);
  // Boot recovery keeps the strict listing: it must not act on a partial view of live operations.
  expect(() => store.list()).toThrow('purchase damaged');
});
