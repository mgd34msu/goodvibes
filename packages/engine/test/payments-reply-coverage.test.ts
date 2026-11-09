import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedPaymentRequests } from '../platform/src/platform/payments/host/protected-requests.js';
import { CheckoutOperations } from '../platform/src/platform/payments/host/checkout-operations.js';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.js';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.js';
import { MemoryCheckoutJournal } from '../platform/src/platform/payments/checkout-registry.js';
import { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.js';
import { createTelegramSourceAccountOwner } from '../platform/src/platform/channels/telegram/source-account.js';
import { TelegramPollingReceiveProgress } from '../platform/src/platform/channels/telegram/receive-progress.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { paymentReplyHistoryBinding, paymentReplyWindowReceiveCovered, type PaymentReplyReceiveCoverage } from '../platform/src/platform/payments/reply-history.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'payment-reply-coverage-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'requests'), original = protectedPaymentRequest(), window = protectedPaymentWindow(original);
  const store = new ProtectedPaymentRequests(directory, undefined, () => {}, () => {});
  await store.retain(original, () => {}); await store.checkpointWindow(original.purchaseId, original.operationId, window, null, () => {});
  const binding = paymentReplyHistoryBinding(window), receipt = binding.receipts[0]; if (!receipt) throw new Error('Missing fixture notice');
  const coverage: PaymentReplyReceiveCoverage = { resolution: 'silence', receipt, throughMs: binding.deadlineMs, checkedAtMs: binding.deadlineMs + 10 };
  const path = join(directory, `${Buffer.from(original.purchaseId).toString('base64url')}.json`);
  return { root, directory, original, window, store, path, binding, coverage,
    record: (value = coverage) => store.recordReceiveCoverage(original.purchaseId, original.operationId, binding, value, () => {}),
    read: () => new ProtectedPaymentRequests(directory).read(original.purchaseId, original.operationId, () => {}) };
}

test('encrypted coverage survives reopening and duplicate proof preserves the original resolution time', async () => {
  const f = await fixture(); await f.record(); const bytes = readFileSync(f.path), saved = await f.read();
  const window = saved.replyHistory?.windows.at(-1); if (!window) throw new Error('Missing original history');
  expect(window.receiveCoverage).toEqual([f.coverage]); expect(paymentReplyWindowReceiveCovered(window)).toBe(true);
  expect(bytes.toString()).not.toContain('silence'); expect(bytes.toString()).not.toContain(f.binding.notice);
  await f.record({ ...f.coverage, checkedAtMs: f.coverage.checkedAtMs + 10 }); expect(readFileSync(f.path)).toEqual(bytes);
  const delivery = f.window.record.windowDeliveries?.[0]; if (!delivery?.receipt) throw new Error('Missing original receipt');
  await f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, { ...f.window, record: { ...f.window.record,
    windowDeadlineMs: 200_000, updatedAtMs: 110_000,
    windowDeliveries: [{ ...delivery, receipt: { ...delivery.receipt, messageId: '60' } }] } }, null, () => {});
  const next = (await f.read()).replyHistory;
  expect(next?.windows[0]?.receiveCoverage).toEqual([f.coverage]); expect(next?.windows.at(-1)?.receiveCoverage).toBeUndefined();
  const current = next?.windows.at(-1); if (!current) throw new Error('Missing new window'); expect(paymentReplyWindowReceiveCovered(current)).toBe(false);
});

test('retaining imported coverage declares its actual format before the encrypted request is created', async () => {
  const f = await fixture(); await f.record();
  const value = await f.read(), calls: string[] = [], directory = join(f.root, 'imported');
  const store = new ProtectedPaymentRequests(directory, undefined, () => { calls.push('history'); }, () => { calls.push('coverage'); });
  await store.retain(value, () => {});
  expect(calls).toEqual(['history', 'coverage']);
  expect((await store.read(value.purchaseId, value.operationId, () => {})).replyHistory).toEqual(value.replyHistory);
  const unsupported = new ProtectedPaymentRequests(join(f.root, 'unsupported-import'), undefined, () => {});
  await expect(unsupported.retain(value, () => {})).rejects.toThrow();
});

test('retaining imported receive selectors requires their distinct reader floor before publication', async () => {
  const f = await fixture(); await f.record();
  const saved = await f.read(), previous = saved.replyHistory?.windows.at(-1); if (!previous) throw new Error('Missing original history');
  const value = { ...saved, replyHistory: { version: 1 as const, windows: [{ ...previous, receiveSpans: [{
    receipt: f.coverage.receipt,
    selector: { id: 'original-native-span', accountId: '123', purchaseId: saved.purchaseId, sinceMs: 1, registeredAtMs: 1, offsetAtStart: 500 },
    deadlineMs: f.binding.deadlineMs, acceptPositive: true,
  }] }] } };
  const calls: string[] = [], directory = join(f.root, 'imported-spans');
  const leaf = `${Buffer.from(value.purchaseId).toString('base64url')}.json`;
  const store = new ProtectedPaymentRequests(directory, undefined,
    () => { calls.push('history'); }, () => { calls.push('coverage'); }, () => {
      expect(existsSync(join(directory, leaf))).toBe(false); calls.push('spans');
    });
  await store.retain(value, () => {}); expect(calls).toEqual(['history', 'coverage', 'spans']);
  expect((await store.read(value.purchaseId, value.operationId, () => {})).replyHistory).toEqual(value.replyHistory);
  const unsupported = new ProtectedPaymentRequests(join(f.root, 'unsupported-spans'), undefined, () => {}, () => {});
  await expect(unsupported.retain(value, () => {})).rejects.toThrow();
  expect(existsSync(join(f.root, 'unsupported-spans', leaf))).toBe(false);
});

test.each(['notice', 'account', 'thread', 'deadline', 'future-span', 'unchecked', 'answer'] as const)(
  'coverage cannot be moved to a different or unconfirmed binding (%s)', async reason => {
    const f = await fixture(), bytes = readFileSync(f.path);
    const receipt = { ...f.coverage.receipt,
      ...(reason === 'notice' ? { messageId: '52' } : {}), ...(reason === 'account' ? { accountId: '456' } : {}),
      ...(reason === 'thread' ? { threadId: '9' } : {}) };
    const value = { ...f.coverage, receipt,
      throughMs: f.coverage.throughMs + (reason === 'deadline' ? -1 : reason === 'future-span' ? 1 : 0),
      checkedAtMs: reason === 'unchecked' ? f.coverage.throughMs - 1 : f.coverage.checkedAtMs,
      resolution: reason === 'answer' ? 'approve' : 'silence' };
    await expect(f.record(value as PaymentReplyReceiveCoverage)).rejects.toThrow(); expect(readFileSync(f.path)).toEqual(bytes);
    expect((await f.read()).replyHistory?.windows.at(-1)?.receiveCoverage).toBeUndefined();
  },
);

test('old history has no invented coverage, and an empty recipient set cannot prove a window received', async () => {
  const f = await fixture(), saved = await f.read(), window = saved.replyHistory?.windows.at(-1);
  if (!window) throw new Error('Missing history'); expect(paymentReplyWindowReceiveCovered(window)).toBe(false);
  expect(paymentReplyWindowReceiveCovered({ ...window, binding: { ...window.binding, receipts: [] }, receiveCoverage: [] })).toBe(false);
  const oldWriter = new ProtectedPaymentRequests(f.directory, undefined, () => {}), bytes = readFileSync(f.path);
  await expect(oldWriter.recordReceiveCoverage(f.original.purchaseId, f.original.operationId, f.binding, f.coverage, () => {})).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(bytes);
});

test('coverage for one actual delivered notice cannot cover a second recipient', async () => {
  const f = await fixture(), saved = await f.read(), window = saved.replyHistory?.windows.at(-1);
  if (!window) throw new Error('Missing original window');
  expect(paymentReplyWindowReceiveCovered({ ...window,
    binding: { ...window.binding, receipts: [...window.binding.receipts, { ...f.coverage.receipt, conversationId: '-100456' }] },
    receiveCoverage: [f.coverage] })).toBe(false);
});

test('retirement before storage starts preserves the original file and leaves bookkeeping cleanup usable', async () => {
  const f = await fixture(), bytes = readFileSync(f.path);
  await expect(f.store.recordReceiveCoverage(f.original.purchaseId, f.original.operationId, f.binding, f.coverage,
    () => { throw new Error('Retired original source'); })).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(bytes);
  expect((await f.store.read(f.original.purchaseId, f.original.operationId, () => {})).replyHistory?.windows.at(-1)?.receiveCoverage).toBeUndefined();
  await f.store.remove(f.original.purchaseId, f.original.operationId, () => {});
});

test('the actual native reader requirement is declared before publishing completed coverage', async () => {
  const f = await fixture(), execPath = join(f.root, 'goodvibes-daemon'), bytes = readFileSync(f.path);
  const native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  const store = new ProtectedPaymentRequests(f.directory, undefined, () => {}, () => {
    expect(readFileSync(f.path)).toEqual(bytes); native.declare('payment-reply-coverage-v1');
    const reader = nativeReaderCapabilities('3.1.2');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
      { ...reader, formats: reader.formats.filter(format => format !== 'payment-reply-coverage-v1') })).toThrow();
  });
  await store.recordReceiveCoverage(f.original.purchaseId, f.original.operationId, f.binding, f.coverage, () => {});
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
});

test.each(['finish', 'close', 'write-failure'] as const)(
  'the real detached executor owns and drains original receive-proof persistence before silence (%s)', async outcome => {
    const f = await fixture(); cleanup.push(configureDecisionModelPolicy(() => 'Default - On'));
    // Use a new admitted identity; the setup record above is independent.
    const original = protectedPaymentRequest('actual-detached-coverage'), checkpoint = protectedPaymentWindow(original);
    const store = new DurablePaymentOperations(join(f.root, 'operations')), journal = new MemoryCheckoutJournal();
    const entered = deferred<void>(), publish = deferred<void>(), armed = deferred<void>(), answered = deferred<null>(), finish = deferred<void>();
    const sourceRead = deferred<void>(), lifetime = new AbortController(); let clock = 1;
    const accounts = createTelegramSourceAccountOwner(), progress = new TelegramPollingReceiveProgress(lifetime.signal, () => clock);
    accounts.attach({ lifetime: lifetime.signal, receiveProgress: progress, isCurrent: async () => true, isCurrentSync: () => true,
      readIdentity: async () => ({ id: '123', username: 'fixture_bot' }) });
    const inbox = new PaymentReplyInbox({ now: () => clock });
    inbox.bindTelegramSource({ ...accounts.reader, async read(handle) { const account = await accounts.reader.read(handle); sourceRead.resolve(); return account; } }, lifetime.signal);
    const requests = new ProtectedPaymentRequests(join(f.root, 'actual-requests'), undefined, () => {}, () => {});
    const record = requests.recordReceiveCoverage.bind(requests);
    requests.recordReceiveCoverage = async (...args) => {
      entered.resolve(); await publish.promise;
      if (outcome === 'write-failure') throw new Error('Synthetic private write failure');
      return record(...args);
    };
    let resolved = false;
    const operations = new CheckoutOperations(store, journal, new DaemonPurchaseLedger({ filePath: join(f.root, 'purchases.json') }),
      async (_input, id, owner) => {
        const reception = inbox.prepareAnswer({ purchaseId: id, kind: 'approval', notice: checkpoint.record.windowNotice ?? '',
          channels: ['telegram'], requireDeliveryReceipt: true, signal: owner.signal });
        await journal.put(checkpoint.record); owner.assertCurrent(); operations.progress(checkpoint.record);
        if (!owner.retainWindowCheckpoint) throw new Error('Missing actual checkpoint owner');
        await owner.retainWindowCheckpoint(checkpoint); owner.assertCurrent();
        const answer = reception.waitForAnswer({ deadlineMs: checkpoint.record.windowDeadlineMs ?? 0, channels: ['telegram'], deliveries: checkpoint.record.windowDeliveries });
        armed.resolve(); expect(await answer).toBeNull(); resolved = true; answered.resolve(null);
        await finish.promise; owner.assertCurrent(); await journal.remove(id);
        return { purchaseId: id, outcome: 'refused:item-budget-exceeded-expired', reason: null, merchantOrderId: null,
          totalMinorUnits: 2000, currency: 'USD', shippingTierUsed: 'normal', steppedDown: false, challengeStep: null };
      }, () => clock, requests, inbox);
    cleanup.push(async () => { publish.resolve(); finish.resolve(); await operations.close(); await inbox.close(); lifetime.abort(); });
    // Replacing the wrapper after construction cannot replace its retained writer.
    requests.recordReceiveCoverage = async () => { throw new Error('Replacement method must not run'); };
    await operations.recover();
    const accepted = await operations.admit(original.purchaseId, original.input, { principalId: original.principalId, assertCurrent() {},
      taintEvidence: original.evidence, recoveryFacts: original.host }, () => {}, () => {});
    await armed.promise; await sourceRead.promise; await Promise.resolve(); await Promise.resolve();
    clock = checkpoint.record.windowDeadlineMs ?? 0; inbox.inspect(); const started = progress.beginRequest(); clock++;
    progress.completeRequest(started, true); await entered.promise;
    expect(resolved).toBe(false); expect(store.get(original.purchaseId)?.state).toBe('running');
    if (outcome === 'close') {
      let closed = false; const closing = operations.close().then(() => { closed = true; });
      await Promise.resolve(); expect(closed).toBe(false); publish.resolve(); finish.resolve(); await closing;
      expect(resolved).toBe(false); expect(store.get(original.purchaseId)?.state).toBe('cancelled');
    } else {
      publish.resolve();
      if (outcome === 'finish') {
        await answered.promise;
        const saved = await new ProtectedPaymentRequests(join(f.root, 'actual-requests')).read(original.purchaseId, accepted.operationId, () => {});
        const window = saved.replyHistory?.windows.at(-1); if (!window) throw new Error('Missing actual persisted coverage');
        expect(paymentReplyWindowReceiveCovered(window)).toBe(true); expect(window.receiveCoverage?.[0]?.resolution).toBe('silence');
      }
      if (outcome === 'write-failure') {
        const deadline = Date.now() + 2000;
        while (store.get(original.purchaseId)?.state !== 'failed') {
          if (Date.now() >= deadline) throw new Error('The failed original coverage write did not settle its operation');
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
      finish.resolve(); await operations.close();
      if (outcome === 'write-failure') expect(store.get(original.purchaseId)).toMatchObject({ state: 'failed', outcome: 'refused:receive-unrecorded' });
    }
  },
);
