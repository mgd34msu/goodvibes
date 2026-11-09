import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { prepareGatewayScopePolicyOwner, completeGatewayScopePolicyBootstrap, waitForGatewayScopePolicyBootstrap } from '../sdk/src/platform/control-plane/scope-policy-bootstrap.js';
import { createNativeCheckoutWindowRestorer } from '../sdk/src/platform/payments/host/native-window-restoration.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { paymentContinuationBinding } from '../sdk/src/platform/payments/host/continuation-binding.js';
import { createTelegramSourceAccountOwner } from '../sdk/src/platform/channels/telegram/source-account.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { configureDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import type { BrowserCheckoutSeam } from '../sdk/src/platform/control-plane/routes/browser-composition.js';
import type { ChannelDeliveryRequest } from '../sdk/src/platform/channels/delivery/types.js';
import type { CheckoutPageDriver } from '../sdk/src/platform/payments/checkout-page.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';
import { CheckoutOperations } from '../sdk/src/platform/payments/host/checkout-operations.js';
import { DurablePaymentOperations } from '../sdk/src/platform/payments/host/operation-store.js';
import { ProtectedPaymentRequests } from '../sdk/src/platform/payments/host/protected-requests.js';
import { DaemonPurchaseLedger } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import { MemoryCheckoutJournal } from '../sdk/src/platform/payments/checkout-registry.js';
import { paymentReplyHistoryBinding, type PaymentReplyHistory } from '../sdk/src/platform/payments/reply-history.js';
import { withPaymentsReadings } from './helpers/payments-readings.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(needsBoot = false, acknowledgedMessageId = '62') {
  const root = mkdtempSync(join(tmpdir(), 'native-payment-window-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(configureDecisionModelPolicy(() => 'Default - On'));
  const original = protectedPaymentRequest(), catalog = new GatewayMethodCatalog();
  catalog.register({ id: 'payments.fixture', title: 'Fixture payment method', description: 'Fixture registered payment scope',
    category: 'payments', source: 'plugin', pluginId: 'fixture-payment', access: 'admin', transport: ['ws'], scopes: ['write:payments'] }, async () => ({}));
  const scopes = prepareGatewayScopePolicyOwner(catalog, () => {}, needsBoot); cleanup.push(() => scopes.close());
  const pairing = new PairingTokenManager(join(root, 'pairing.json')), paired = pairing.mint({ name: 'Original payment owner' });
  const native = pairing.authenticateNative(paired.token); if (!native) throw new Error('Missing native owner');
  const authority = { ...native, scopes: ['write:payments'] }, binding = paymentContinuationBinding(original.operationId);
  const continuation = pairing.issueNativeContinuation(paired.token, authority, binding, () => {}, binding);
  const connection = { version: 1 as const, endpoint: 'ws://127.0.0.1:9222/devtools/browser/original', targetId: 'original-target',
    browserContextId: 'original-context', frames: [{ id: 'original-frame', loaderId: 'original-document', parentId: null }] };
  const controls = { version: 1 as const, snapshotId: 'old-local-snapshot', url: original.input.checkoutUrl,
    controls: [original.input.controls.cardFields[0]?.ref, original.input.controls.placeOrderTarget].map((ref, index) => {
      if (!ref) throw new Error('Missing selected ref');
      return { ref, role: index ? 'button' : 'textbox', name: index ? 'Place order' : 'Card number', tag: index ? 'button' : 'input',
        selector: index ? '#submit' : '#card', depth: 1, submits: !!index, frameChain: [], metadata: { name: 'Fixture control', documentUrl: original.input.checkoutUrl } };
    }) };
  const request = { ...original, principalId: native.principalId,
    host: { ...original.host, authority, continuation, browser: connection, browserControls: controls }, window: protectedPaymentWindow(original) };
  const abort = new AbortController(); cleanup.push(() => abort.abort());
  const owner = { signal: abort.signal, assertCurrent: () => abort.signal.throwIfAborted() };
  const replies = new PaymentReplyInbox(); cleanup.push(() => replies.close());
  const accounts = createTelegramSourceAccountOwner();
  accounts.attach({ lifetime: abort.signal, isCurrent: async () => true, isCurrentSync: () => true, readIdentity: async () => ({ id: '123', username: 'fixture_bot' }) });
  replies.bindTelegramSource(accounts.reader, abort.signal);
  const sent: ChannelDeliveryRequest[] = []; let restored = 0, released = 0, controlsCurrent = true;
  const driver: CheckoutPageDriver = { identity: () => ({ sessionId: 'new-local-session', pageId: 'new-local-page' }),
    async url() { return request.input.checkoutUrl; }, async verifyTerms() { throw new Error('This source fixture does not execute checkout'); },
    async fill() { throw new Error('Unexpected effect'); }, async choose() { throw new Error('Unexpected effect'); },
    async fillSecrets() { throw new Error('Unexpected effect'); }, async submitOrder() { throw new Error('Unexpected effect'); } };
  const seam: BrowserCheckoutSeam = { cardFieldGuard: new CardMaterialRedactor(), driverFor: () => { throw new Error('Do not create a replacement driver'); },
    async armSubmitApproval() {}, async capturePageConnection() { return connection; },
    async restoreCheckoutRecovery(facts, current) {
      current.assertCurrent?.(); expect(facts).toEqual({ connection, controls }); restored++;
      return { sessionId: 'new-local-session', pageId: 'new-local-page', snapshotId: 'new-local-snapshot', driver,
        assertCurrent: () => current.assertCurrent?.(), assertControlsCurrent: () => { current.assertCurrent?.(); if (!controlsCurrent) throw new Error('Controls replaced'); },
        async release() { released++; } };
    } };
  const restore = createNativeCheckoutWindowRestorer({ pairing, catalog, scopes, config: { get: key => key === 'payments.enabled' ? true : undefined },
    seam: () => seam, replies, isPaymentsLeader: () => true, router: {
      async deliver() { throw new Error('Native notice requires acknowledgement'); },
      async deliverWithReceipt(input) { input.assertCurrent?.(); sent.push(input);
        return { receipt: { surfaceKind: 'telegram', accountId: '123', conversationId: '-100123', messageId: acknowledgedMessageId, threadId: '9' } }; },
    } });
  return { root, catalog, scopes, pairing, continuation, request, owner, abort, restore, sent, replies,
    restored: () => restored, released: () => released, replaceControls: () => { controlsCurrent = false; } };
}

test('native recovery waits for both real host phases before restoring the original page', async () => {
  const f = await fixture(true); const waiting = f.restore(f.request, f.owner); let settled = false;
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  completeGatewayScopePolicyBootstrap(f.catalog); await Promise.resolve();
  expect(settled).toBe(false); expect(f.restored()).toBe(0);
  completeGatewayScopePolicyBootstrap(f.catalog, 'boot');
  const restored = await waiting;
  expect(f.restored()).toBe(1); expect(restored.input.sessionId).toBe('new-local-session');
  expect(restored.source.taintEvidence).toEqual(f.request.evidence);
  restored.source.assertCurrent(); await restored.release(); expect(f.released()).toBe(1);
});

test('native recovered notices preserve exact recipient/topic and wait for a new acknowledged window', async () => {
  const f = await fixture();
  const delivery = f.request.window.record.windowDeliveries?.[0];
  if (!delivery?.receipt) throw new Error('Missing original receipt');
  const request = { ...f.request, window: { ...f.request.window, record: { ...f.request.window.record,
    windowDeliveries: [{ ...delivery, receipt: { ...delivery.receipt, threadId: '9' } }] } } };
  completeGatewayScopePolicyBootstrap(f.catalog);
  const restored = await f.restore(request, f.owner), window = restored.resumption.prepare(f.owner);
  const report = await window.deliveries, deadline = await window.deadlineMs;
  expect(report[0]?.receipt?.messageId).toBe('62');
  expect(deadline).toBeGreaterThan(request.window.record.windowDeadlineMs ?? 0);
  expect(f.sent).toHaveLength(1); expect(f.sent[0]).toMatchObject({ target: { address: '-100123', surfaceKind: 'telegram' }, binding: { threadId: '9' }, allowDuplicate: true });
  expect(f.sent[0]?.body).toBe(request.window.record.windowNotice);
  const answer = window.awaitAnswer(deadline), pending = f.replies.inspect()[0]; if (!pending) throw new Error('Missing operator window');
  f.replies.answer({ purchaseId: pending.purchaseId, windowId: pending.windowId, action: 'approve' });
  expect(await answer).toEqual({ answer: 'approve', channel: 'operator' });
  window.cancel(); await restored.release();
});

test('the actual issuing owner can revoke restoration before or after native page acquisition', async () => {
  const f = await fixture(); completeGatewayScopePolicyBootstrap(f.catalog);
  const restored = await f.restore(f.request, f.owner); restored.source.assertCurrent();
  f.pairing.revokeNativeContinuation(f.continuation);
  expect(() => restored.source.assertCurrent()).toThrow();
  await expect(f.restore(f.request, f.owner)).rejects.toThrow();
  expect(f.restored()).toBe(1); expect(f.sent).toEqual([]); await restored.release();
});

test.each(['@configured-alias', '0', '9007199254740992'])('recovery cannot send an original notice to an unverified chat reference %s', async conversationId => {
  const f = await fixture(); completeGatewayScopePolicyBootstrap(f.catalog);
  const delivery = f.request.window.record.windowDeliveries?.[0]; if (!delivery?.receipt) throw new Error('Missing fixture receipt');
  const request = { ...f.request, window: { ...f.request.window, record: { ...f.request.window.record,
    windowDeliveries: [{ ...delivery, receipt: { ...delivery.receipt, conversationId } }] } } };
  const restored = await f.restore(request, f.owner);
  expect(() => restored.resumption.prepare(f.owner)).toThrow(); expect(f.sent).toEqual([]); await restored.release();
});

test('replaying an old delivery acknowledgement cannot start a new window deadline', async () => {
  const f = await fixture(false, '51'); completeGatewayScopePolicyBootstrap(f.catalog);
  const delivery = f.request.window.record.windowDeliveries?.[0]; if (!delivery?.receipt) throw new Error('Missing fixture receipt');
  const request = { ...f.request, window: { ...f.request.window, record: { ...f.request.window.record,
    windowDeliveries: [{ ...delivery, receipt: { ...delivery.receipt, threadId: '9' } }] } } };
  const restored = await f.restore(request, f.owner), window = restored.resumption.prepare(f.owner);
  await expect(window.deliveries).rejects.toThrow(); await expect(window.deadlineMs).rejects.toThrow();
  expect(f.replies.pending).toBe(0); window.cancel(); await restored.release();
});

test('reconstructed control facts cannot survive replacement of their actual restored snapshot', async () => {
  const f = await fixture(); completeGatewayScopePolicyBootstrap(f.catalog);
  const restored = await f.restore(f.request, f.owner); f.replaceControls();
  const capture = restored.source.captureBrowserRecovery; if (!capture) throw new Error('Missing native capture');
  await expect(capture(restored.input, f.owner)).rejects.toThrow(); expect(f.sent).toEqual([]); await restored.release();
});

test('scope readiness cancellation and graph retirement cannot mint a ready replacement', async () => {
  const f = await fixture(true), pending = waitForGatewayScopePolicyBootstrap(f.catalog, f.abort.signal);
  f.abort.abort(); await expect(pending).rejects.toThrow();
  f.scopes.close(); completeGatewayScopePolicyBootstrap(f.catalog, 'boot');
  await expect(waitForGatewayScopePolicyBootstrap(f.catalog, new AbortController().signal)).rejects.toThrow();
  await expect(waitForGatewayScopePolicyBootstrap(new GatewayMethodCatalog(), new AbortController().signal)).rejects.toThrow();
  expect(f.restored()).toBe(0);
});

test.each(['approval', 'veto'] as const)('native recovery honors an archived %s objection without sending another notice', async kind => {
  const f = await fixture(), request = { ...f.request, window: { ...f.request.window, record: { ...f.request.window.record, windowKind: kind } } };
  completeGatewayScopePolicyBootstrap(f.catalog);
  const history: PaymentReplyHistory = { version: 1, windows: [{ startedAtMs: 2, binding: paymentReplyHistoryBinding(request.window), entries: [{
    accountId: '123', userId: '42', conversationId: '-100123', threadId: null, messageId: '52', updateId: '91', replyToMessageId: '51',
    sentAtMs: 3000, receivedAtMs: 4000, text: 'Do not buy this item.' }] }] };
  await withPaymentsReadings({ approvalReply: () => 'deny', vetoReply: () => 'object' }, async requests => {
    const restored = await f.restore(request, { ...f.owner, readReplyHistory: async () => history }), window = restored.resumption.prepare(f.owner);
    expect(await window.deliveries).toEqual(request.window.record.windowDeliveries ?? []);
    expect(await window.deadlineMs).toBe(request.window.record.windowDeadlineMs ?? 0);
    expect(await window.awaitAnswer(await window.deadlineMs)).toEqual({ answer: kind === 'approval' ? 'deny' : 'object', channel: 'telegram' });
    expect(requests).toHaveLength(1); expect(f.sent).toEqual([]); window.cancel(); await restored.release();
  });
});

test.each(['positive', 'after-deadline'] as const)('an archived %s reply cannot substitute for complete receive coverage', async reason => {
  const f = await fixture(); completeGatewayScopePolicyBootstrap(f.catalog);
  const delivery = f.request.window.record.windowDeliveries?.[0]; if (!delivery?.receipt) throw new Error('Missing original receipt');
  const request = { ...f.request, window: { ...f.request.window, record: { ...f.request.window.record,
    windowDeliveries: [{ ...delivery, receipt: { ...delivery.receipt, threadId: '9' } }] } } };
  const history: PaymentReplyHistory = { version: 1, windows: [{ startedAtMs: 2, binding: paymentReplyHistoryBinding(request.window), entries: [{
    accountId: '123', userId: '42', conversationId: '-100123', threadId: '9', messageId: '52', updateId: '91', replyToMessageId: '51',
    sentAtMs: reason === 'after-deadline' ? request.window.record.windowDeadlineMs ?? 0 : 3000, receivedAtMs: 200_000, text: 'Yes.' }] }] };
  await withPaymentsReadings({ approvalReply: () => 'approve' }, async requests => {
    const restored = await f.restore(request, { ...f.owner, readReplyHistory: async () => history }), window = restored.resumption.prepare(f.owner);
    await window.deliveries; expect(f.sent).toHaveLength(1); expect(requests).toHaveLength(reason === 'positive' ? 1 : 0);
    const waiting = window.awaitAnswer(await window.deadlineMs), pending = f.replies.inspect()[0]; if (!pending) throw new Error('Missing fresh window');
    f.replies.answer({ purchaseId: pending.purchaseId, windowId: pending.windowId, action: 'deny' });
    expect(await waiting).toEqual({ answer: 'deny', channel: 'operator' }); window.cancel(); await restored.release();
  });
});

test.each(['approval', 'veto'] as const)('an original %s window with persisted completed reception keeps its original expiry without another notice', async kind => {
  const f = await fixture(); completeGatewayScopePolicyBootstrap(f.catalog);
  const request = { ...f.request, window: { ...f.request.window, record: { ...f.request.window.record, windowKind: kind } } };
  const binding = paymentReplyHistoryBinding(request.window), receipt = binding.receipts[0]; if (!receipt) throw new Error('Missing original receipt');
  const history: PaymentReplyHistory = { version: 1, windows: [{ startedAtMs: 2, binding, entries: [],
    receiveCoverage: [{ resolution: 'silence', receipt, throughMs: binding.deadlineMs, checkedAtMs: binding.deadlineMs + 1 }] }] };
  const restored = await f.restore(request, { ...f.owner, readReplyHistory: async () => history }), window = restored.resumption.prepare(f.owner);
  expect(await window.deliveries).toEqual(request.window.record.windowDeliveries ?? []);
  expect(await window.deadlineMs).toBe(binding.deadlineMs); expect(await window.awaitAnswer(binding.deadlineMs)).toBeNull();
  expect(f.sent).toEqual([]); expect(f.replies.inspect()).toEqual([]); window.cancel(); await restored.release();
});

test('a new positive interpretation cannot promote the original persisted silence into approval', async () => {
  const f = await fixture(); completeGatewayScopePolicyBootstrap(f.catalog);
  const binding = paymentReplyHistoryBinding(f.request.window), receipt = binding.receipts[0]; if (!receipt) throw new Error('Missing original receipt');
  const history: PaymentReplyHistory = { version: 1, windows: [{ startedAtMs: 2, binding,
    entries: [{ accountId: '123', userId: '42', conversationId: '-100123', threadId: null, messageId: '52', updateId: '91',
      replyToMessageId: '51', sentAtMs: 3000, receivedAtMs: 4000, text: 'Previously unclear owner reply' }],
    receiveCoverage: [{ resolution: 'silence', receipt, throughMs: binding.deadlineMs, checkedAtMs: binding.deadlineMs + 1 }] }] };
  await withPaymentsReadings({ approvalReply: () => 'approve' }, async () => {
    const restored = await f.restore(f.request, { ...f.owner, readReplyHistory: async () => history }), window = restored.resumption.prepare(f.owner);
    await window.deliveries; expect(await window.awaitAnswer(await window.deadlineMs)).toBeNull();
    expect(f.sent).toEqual([]); window.cancel(); await restored.release();
  });
});

test.each(['other-notice', 'partial', 'future-clock'] as const)('a parsed %s marker cannot establish original completed coverage', async reason => {
  const f = await fixture(); completeGatewayScopePolicyBootstrap(f.catalog);
  const binding = paymentReplyHistoryBinding(f.request.window), receipt = binding.receipts[0]; if (!receipt) throw new Error('Missing original receipt');
  const history: PaymentReplyHistory = { version: 1, windows: [{ startedAtMs: 2, binding, entries: [],
    receiveCoverage: [{ resolution: 'silence', receipt: reason === 'other-notice' ? { ...receipt, messageId: '52' } : receipt,
      throughMs: binding.deadlineMs - (reason === 'partial' ? 1 : 0), checkedAtMs: reason === 'future-clock' ? Date.now() + 60_000 : binding.deadlineMs + 1 }] }] };
  const restored = await f.restore(f.request, { ...f.owner, readReplyHistory: async () => history }), window = restored.resumption.prepare(f.owner);
  await expect(window.deliveries).rejects.toMatchObject({ kind: reason === 'future-clock' ? 'clock-unavailable' : 'history-unavailable' });
  expect(f.sent).toEqual([]); window.cancel(); await restored.release();
});

test('the real staged executor hands its original lease to native restoration and remains stoppable after handoff', async () => {
  const f = await fixture(), store = new DurablePaymentOperations(join(f.root, 'operations'));
  const requests = new ProtectedPaymentRequests(join(f.root, 'requests')), journal = new MemoryCheckoutJournal();
  await requests.retain(f.request, () => {}); await journal.put(f.request.window.record);
  const writer = store.create({ purchaseId: f.request.purchaseId, operationId: f.request.operationId, state: 'running', phase: 'awaiting-window',
    createdAtMs: 1, updatedAtMs: 2, outcome: null, currency: 'USD', totalMinorUnits: 2_000 }, f.request.principalId, () => {});
  writer.release();
  let entered!: () => void, finish!: () => void;
  const executing = new Promise<void>(done => { entered = done; }), retired = new Promise<void>(done => { finish = done; });
  const operations = new CheckoutOperations(store, journal, new DaemonPurchaseLedger({ filePath: join(f.root, 'purchases.json') }),
    async () => { throw new Error('Recovery cannot admit a fresh begin'); }, Date.now, requests);
  cleanup.push(async () => { finish(); await operations.close(); });
  await operations.retainInterruptedWindows((request, current) => async () => {
    current(); const actual = await journal.list(); current();
    if (!actual.some(record => record.purchaseId === request.purchaseId && record.phase === 'awaiting-window')) return false;
    await journal.remove(request.purchaseId); current(); f.pairing.revokeNativeContinuation(f.continuation); return true;
  });
  expect(new DurablePaymentOperations(join(f.root, 'operations')).retainRecovery(f.request.purchaseId)).toBeNull();
  await operations.recover();
  operations.resumeInterruptedWindows(async (request, owner) => {
    const restored = await f.restore(request, owner);
    return { source: restored.source, input: restored.input, release: restored.release,
      async execute(_input, id, current) {
        // Both guards must remain usable after pending preparation transfers
        // to active execution; neither may retain a retired preparation scope.
        current.assertCurrent(); restored.source.assertCurrent(); entered(); await retired; current.assertCurrent();
        return { purchaseId: id, outcome: 'refused:no-card', reason: 'Fixture stopped before effects', merchantOrderId: null,
          totalMinorUnits: null, currency: null, shippingTierUsed: null, steppedDown: false, challengeStep: null };
      } };
  });
  expect(f.restored()).toBe(0); completeGatewayScopePolicyBootstrap(f.catalog); await executing;
  expect(operations.cancel(f.request.purchaseId, f.request.operationId)).toMatchObject({ accepted: true, mayHaveSubmitted: false });
  finish(); await operations.close();
  expect(store.get(f.request.purchaseId)?.state).toBe('cancelled'); expect(await journal.list()).toEqual([]);
  expect(f.released()).toBe(1); expect(f.pairing.readNativeContinuation(f.continuation)).toBeNull();
  const released = store.recover(f.request.purchaseId); if (!released) throw new Error('Original lease did not drain'); released.release();
});
