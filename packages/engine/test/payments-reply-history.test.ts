import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedPaymentRequests } from '../sdk/src/platform/payments/host/protected-requests.js';
import { paymentReplyHistoryBinding, type PaymentReplyHistoryEntry } from '../sdk/src/platform/payments/reply-history.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { createTelegramSourceAccountOwner } from '../sdk/src/platform/channels/telegram/source-account.js';
import { tryResolvePaymentReplyFromChannel } from '../sdk/src/platform/daemon/payment-reply.js';
import { configureDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import type { ChannelPolicyDecision } from '../sdk/src/platform/channels/types.js';
import type { ChannelIngressPolicyInput } from '../sdk/src/platform/channels/types.js';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/types.js';
import { processTelegramUpdate } from '../sdk/src/platform/adapters/telegram/index.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities } from '../sdk/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../sdk/src/platform/runtime/self-update.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'payment-reply-history-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'requests'), original = protectedPaymentRequest(), window = protectedPaymentWindow(original);
  let declared = 0;
  const store = new ProtectedPaymentRequests(directory, undefined, () => { declared++; });
  await store.retain(original, () => {}); await store.checkpointWindow(original.purchaseId, original.operationId, window, null, () => {});
  const entry: PaymentReplyHistoryEntry = { accountId: '123', userId: '42', conversationId: '-100123', threadId: null,
    messageId: '52', updateId: '91', replyToMessageId: '51', sentAtMs: 3000, receivedAtMs: 4000, text: 'Do not buy the original item.' };
  const path = join(directory, `${Buffer.from(original.purchaseId).toString('base64url')}.json`), binding = paymentReplyHistoryBinding(window);
  return { root, directory, original, window, store, path, binding, entry, declared: () => declared,
    append: (value = entry) => store.appendReply(original.purchaseId, original.operationId, binding, value, () => {}),
    read: () => new ProtectedPaymentRequests(directory).read(original.purchaseId, original.operationId, () => {}) };
}

test('the actual encrypted request preserves provider time, notice binding and first receipt time across restart/redelivery', async () => {
  const f = await fixture(); await f.append(); const saved = await f.read(), bytes = readFileSync(f.path);
  expect(saved.replyHistory?.windows[0]?.entries).toEqual([f.entry]); expect(saved.replyHistory?.windows[0]?.binding).toEqual(f.binding);
  expect(bytes.toString()).not.toContain(f.entry.text); expect(bytes.toString()).not.toContain(f.window.record.windowNotice ?? '');
  await f.append({ ...f.entry, receivedAtMs: 9000 }); expect(readFileSync(f.path)).toEqual(bytes);
  expect((await f.read()).replyHistory?.windows[0]?.entries[0]?.receivedAtMs).toBe(4000);
});

test.each(['same-message-changed-text', 'wrong-account', 'wrong-notice'] as const)('archive rejects %s without changing the original encrypted evidence', async kind => {
  const f = await fixture(); await f.append(); const bytes = readFileSync(f.path);
  const entry = kind === 'wrong-account' ? { ...f.entry, accountId: '456', messageId: '53' } : { ...f.entry, text: 'Changed meaning' };
  const binding = kind === 'wrong-notice' ? { ...f.binding, notice: 'A different purchase notice' } : f.binding;
  await expect(f.store.appendReply(f.original.purchaseId, f.original.operationId, binding, entry, () => {})).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(bytes); expect((await f.read()).replyHistory?.windows[0]?.entries).toEqual([f.entry]);
});

test('newly delivered windows retain earlier replies without attaching them to the new notice', async () => {
  const f = await fixture(); await f.append();
  const delivery = f.window.record.windowDeliveries?.[0]; if (!delivery?.receipt) throw new Error('Missing receipt');
  const next = { ...f.window, record: { ...f.window.record, updatedAtMs: 5000, windowDeadlineMs: 200_000,
    windowDeliveries: [{ ...delivery, receipt: { ...delivery.receipt, messageId: '60' } }] } };
  await f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, next, null, () => {});
  const history = (await f.read()).replyHistory;
  expect(history?.windows).toHaveLength(2); expect(history?.windows[0]?.entries).toEqual([f.entry]);
  expect(history?.windows[1]?.entries).toEqual([]); expect(history?.windows[1]?.binding.receipts[0]?.messageId).toBe('60');
});

test('adding history to an older window begins custody at actual receipt time, without inventing prior coverage', async () => {
  const f = await fixture(), old = { ...f.original, window: f.window }, directory = join(f.root, 'older');
  const store = new ProtectedPaymentRequests(directory, undefined, () => {});
  await store.retain(old, () => {});
  await store.appendReply(old.purchaseId, old.operationId, f.binding, f.entry, () => {});
  const history = (await new ProtectedPaymentRequests(directory).read(old.purchaseId, old.operationId, () => {})).replyHistory;
  expect(history?.windows[0]?.startedAtMs).toBe(f.entry.receivedAtMs); expect(history?.windows[0]?.entries).toEqual([f.entry]);
});

test('a full archive refuses another message instead of evicting an earlier owner reply', async () => {
  const f = await fixture(), directory = join(f.root, 'full'), store = new ProtectedPaymentRequests(directory, undefined, () => {});
  const entries = Array.from({ length: 256 }, (_value, index) => ({ ...f.entry, messageId: String(52 + index), updateId: String(91 + index) }));
  await store.retain({ ...f.original, window: f.window, replyHistory: { version: 1,
    windows: [{ startedAtMs: 2, binding: f.binding, entries }] } }, () => {});
  const path = join(directory, `${Buffer.from(f.original.purchaseId).toString('base64url')}.json`), bytes = readFileSync(path);
  await expect(store.appendReply(f.original.purchaseId, f.original.operationId, f.binding, { ...f.entry, messageId: '308', updateId: '347' }, () => {})).rejects.toThrow();
  expect(readFileSync(path)).toEqual(bytes);
  const saved = await new ProtectedPaymentRequests(directory).read(f.original.purchaseId, f.original.operationId, () => {});
  expect(saved.replyHistory?.windows[0]?.entries).toEqual(entries);
});

test('native reply history declares its actual reader format before publishing encrypted data', async () => {
  const f = await fixture(), execPath = join(f.root, 'goodvibes-daemon');
  const native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} }), bytes = readFileSync(f.path);
  const store = new ProtectedPaymentRequests(f.directory, undefined, () => {
    expect(readFileSync(f.path)).toEqual(bytes); native.declare('payment-reply-history-v1');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
      { schema: 1, version: '3.1.2', formats: nativeReaderCapabilities('3.1.2').formats.filter(value => value !== 'payment-reply-history-v1') })).toThrow();
  });
  await store.appendReply(f.original.purchaseId, f.original.operationId, f.binding, f.entry, () => {});
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
});

test('actual verified owner ingress durably records an old-window reply in Classic without claiming it was interpreted', async () => {
  const f = await fixture(); let clock = f.entry.receivedAtMs;
  const inbox = new PaymentReplyInbox({ now: () => clock }); cleanup.push(() => inbox.close());
  cleanup.push(configureDecisionModelPolicy(() => 'Classic - Off'));
  const accounts = createTelegramSourceAccountOwner(), lifetime = new AbortController(); cleanup.push(() => lifetime.abort());
  let identityReads = 0;
  const lease = accounts.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true,
    readIdentity: async () => { identityReads++; return { id: '123', username: 'fixture_bot' }; } });
  const retained = inbox.retainReplyHistory(f.original.purchaseId, f.window, (entry, current) =>
    f.store.appendReply(f.original.purchaseId, f.original.operationId, f.binding, entry, current), () => {});
  const policy = { allowed: true, reason: 'owner', policy: { allowlistUserIds: ['42'] } } as unknown as ChannelPolicyDecision;
  const context = { configManager: { get: () => 'fixture_bot' }, hasPaymentReplyWindow: () => inbox.pending > 0,
    async authorizeSurfaceIngress(input: ChannelIngressPolicyInput) {
      const result = await tryResolvePaymentReplyFromChannel(input, policy, inbox, accounts.reader);
      expect(result).toEqual({ consumed: false, reason: 'recorded' });
      return { ...policy, allowed: false, reason: 'payment-reply-recorded' };
    } } as unknown as SurfaceAdapterContext;
  const response = await processTelegramUpdate({ update_id: 91, message: { message_id: 52, date: 3, from: { id: 42 },
    chat: { id: -100123, type: 'private' }, reply_to_message: { message_id: 51 }, text: f.entry.text } }, context, { acquireSourceAccount: lease.acquire });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ acknowledged: true, recorded: true, consumed: true, queued: false });
  expect(identityReads).toBe(1); expect(inbox.inspect()).toEqual([]);
  expect((await f.read()).replyHistory?.windows[0]?.entries).toEqual([f.entry]);
  clock = 6000;
  const edited = await processTelegramUpdate({ update_id: 92, edited_message: { message_id: 52, date: 3, edit_date: 5, from: { id: 42 },
    chat: { id: -100123, type: 'private' }, reply_to_message: { message_id: 51 }, text: 'Still do not buy the item.' } }, context, { acquireSourceAccount: lease.acquire });
  expect(edited.status).toBe(200);
  expect((await f.read()).replyHistory?.windows[0]?.entries).toEqual([f.entry,
    { ...f.entry, updateId: '92', sentAtMs: 5000, receivedAtMs: 6000, text: 'Still do not buy the item.' }]);
  expect(identityReads).toBe(1); await retained.retire(); expect(inbox.pending).toBe(0);
});

test('retiring a window drains its admitted native identity read and archive write before releasing its writer', async () => {
  const f = await fixture(), inbox = new PaymentReplyInbox({ now: () => 4000 }), gate = deferred<void>(), entered = deferred<void>();
  const lifetime = new AbortController(), accounts = createTelegramSourceAccountOwner();
  cleanup.push(async () => { gate.resolve(); await inbox.close(); lifetime.abort(); }); cleanup.push(configureDecisionModelPolicy(() => 'Classic - Off'));
  const lease = accounts.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true,
    readIdentity: async () => { entered.resolve(); await gate.promise; return { id: '123', username: 'fixture_bot' }; } });
  const retained = inbox.retainReplyHistory(f.original.purchaseId, f.window, (entry, current) =>
    f.store.appendReply(f.original.purchaseId, f.original.operationId, f.binding, entry, current), () => {});
  const policy = { allowed: true, reason: 'owner', policy: { allowlistUserIds: ['42'] } } as unknown as ChannelPolicyDecision;
  const offering = tryResolvePaymentReplyFromChannel({ surface: 'telegram', userId: '42', channelId: '-100123', text: f.entry.text,
    acquireTelegramAccount: lease.acquire, metadata: { updateId: '91', messageId: '52', replyToMessageId: '51', messageSentAtMs: 3000 } }, policy, inbox, accounts.reader);
  await entered.promise; let drained = false; const retiring = retained.retire().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); gate.resolve();
  expect(await offering).toEqual({ consumed: false, reason: 'recorded' }); await retiring;
  expect((await f.read()).replyHistory?.windows[0]?.entries).toEqual([f.entry]);
});

test('Classic preserves an unaddressed owner message for the original notice without suppressing its chat turn', async () => {
  const f = await fixture(), inbox = new PaymentReplyInbox({ now: () => 4000 });
  const lifetime = new AbortController(), accounts = createTelegramSourceAccountOwner();
  cleanup.push(async () => { await inbox.close(); lifetime.abort(); }); cleanup.push(configureDecisionModelPolicy(() => 'Classic - Off'));
  const lease = accounts.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true,
    readIdentity: async () => ({ id: '123', username: 'fixture_bot' }) });
  const retained = inbox.retainReplyHistory(f.original.purchaseId, f.window, (entry, current) =>
    f.store.appendReply(f.original.purchaseId, f.original.operationId, f.binding, entry, current), () => {});
  const policy = { allowed: true, reason: 'owner', policy: { allowlistUserIds: ['42'] } } as unknown as ChannelPolicyDecision;
  const result = await tryResolvePaymentReplyFromChannel({ surface: 'telegram', userId: '42', channelId: '-100123', text: 'stop',
    acquireTelegramAccount: lease.acquire, metadata: { updateId: '91', messageId: '52', messageSentAtMs: 3000 } }, policy, inbox, accounts.reader);
  expect(result).toEqual({ consumed: false, reason: 'decision-model-required' });
  expect((await f.read()).replyHistory?.windows[0]?.entries).toEqual([{ ...f.entry, replyToMessageId: null, text: 'stop' }]);
  await retained.retire();
});
