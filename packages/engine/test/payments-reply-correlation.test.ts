import { afterEach, expect, test } from 'bun:test';
import { PaymentReplyInbox, PaymentReplyWindowError } from '../sdk/src/platform/payments/reply-inbox.js';
import { channelBackedPaymentNotifier } from '../sdk/src/platform/payments/host/notifier.js';
import { tryResolvePaymentReplyFromChannel } from '../sdk/src/platform/daemon/payment-reply.js';
import { createTelegramSourceAccountOwner } from '../sdk/src/platform/channels/telegram/source-account.js';
import { TelegramBotApi } from '../sdk/src/platform/channels/telegram/api.js';
import { processTelegramUpdate } from '../sdk/src/platform/adapters/telegram/index.js';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/types.js';
import type { ChannelPolicyDecision, ChannelIngressPolicyInput } from '../sdk/src/platform/channels/types.js';
import { usePaymentsReadings, withPaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings(), cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const decision = { allowed: true, reason: 'owner', policy: { allowlistUserIds: ['42'] } } as unknown as ChannelPolicyDecision;
const receipt = { surfaceKind: 'telegram' as const, conversationId: '-100123', messageId: '51', threadId: '7', accountId: '123' };

function source(id = '123') {
  const owner = createTelegramSourceAccountOwner(), lifetime = new AbortController();
  let verifies = 0;
  const api = new TelegramBotApi(`${id}:synthetic-fixture-only`, async () => {
    verifies++; return Response.json({ ok: true, result: { id: Number(id), username: 'fixture_bot', is_bot: true, first_name: 'Fixture' } });
  });
  const lease = owner.attach({ lifetime: lifetime.signal, isCurrent: async () => !lifetime.signal.aborted,
    isCurrentSync: () => !lifetime.signal.aborted, readIdentity: signal => api.getVerifiedIdentity(signal) });
  cleanup.push(() => lifetime.abort());
  return { owner, lifetime, lease, verifies: () => verifies };
}
async function window(purchaseId = 'original', noticeReceipt: typeof receipt | null = receipt, deadlineMs = Date.now() + 60_000,
  kind: 'approval' | 'veto' = 'approval', inbox = new PaymentReplyInbox()) {
  cleanup.push(() => inbox.close());
  const notifier = channelBackedPaymentNotifier({ get: key => key === 'payments.notifyChannels' ? 'telegram' : undefined }, {
    async deliver() { throw new Error('Detailed receipt must not send twice'); },
    async deliverWithReceipt() { return noticeReceipt ? { receipt: noticeReceipt } : {}; },
  }, inbox);
  if (!notifier.prepareWindow) throw new Error('Missing native reception');
  const prepared = notifier.prepareWindow({ purchaseId, kind, notice: 'Approve the original exact purchase?' });
  await prepared.deliveries;
  return { inbox, prepared, waiting: prepared.awaitAnswer(deadlineMs) };
}
function message(account: ReturnType<typeof source>, overrides: Partial<ChannelIngressPolicyInput> = {}): ChannelIngressPolicyInput {
  return { surface: 'telegram', userId: '42', channelId: '-100123', threadId: '7', text: 'yes',
    metadata: { messageId: '52', replyToMessageId: '51' }, acquireTelegramAccount: account.lease.acquire, ...overrides };
}

test.each([
  { channelId: '-100999' }, { threadId: '8' }, { threadId: undefined },
  { metadata: { messageId: '52', replyToMessageId: '50' } },
  { metadata: { messageId: '51' } }, { metadata: { messageId: '50' } },
  { metadata: { messageId: '9007199254740993' } },
] as Partial<ChannelIngressPolicyInput>[])('foreign or stale ingress %j does no model or identity I/O', async other => {
  const account = source(), f = await window();
  expect(await tryResolvePaymentReplyFromChannel(message(account, other), decision, f.inbox, account.owner.reader)).toEqual({ consumed: false, reason: 'no-window' });
  expect(account.verifies()).toBe(0); expect(readings.requests).toEqual([]);
  expect(f.inbox.pending).toBe(1);
  f.prepared.cancel(); await expect(f.waiting).rejects.toBeInstanceOf(PaymentReplyWindowError);
});

test('a different authenticated bot in the same chat cannot answer the notice', async () => {
  const account = source('456'), f = await window();
  expect(await tryResolvePaymentReplyFromChannel(message(account), decision, f.inbox, account.owner.reader)).toEqual({ consumed: false, reason: 'no-window' });
  expect(account.verifies()).toBe(1); expect(readings.requests).toEqual([]); expect(f.inbox.pending).toBe(1);
  f.prepared.cancel(); await expect(f.waiting).rejects.toBeInstanceOf(PaymentReplyWindowError);
});

test('the actual Telegram normalizer passes only its private poller account capability into the original window', async () => {
  const account = source(), f = await window();
  let normalized: ChannelIngressPolicyInput | undefined;
  const context = {
    configManager: { get: () => 'fixture_bot' }, hasPaymentReplyWindow: () => f.inbox.pending > 0,
    async authorizeSurfaceIngress(input: ChannelIngressPolicyInput) {
      normalized = input;
      const result = await tryResolvePaymentReplyFromChannel(input, decision, f.inbox, account.owner.reader);
      return { ...decision, allowed: false, reason: result.consumed ? `payment-reply-${result.answer}` : 'no-payment-reply' };
    },
  } as unknown as SurfaceAdapterContext;
  const response = await processTelegramUpdate({ update_id: 81, message: { message_id: 52, message_thread_id: 7,
    from: { id: 42 }, chat: { id: -100123, type: 'supergroup' }, reply_to_message: { message_id: 51 }, text: 'yes' } }, context,
    { acquireSourceAccount: account.lease.acquire });
  expect(normalized?.metadata).toMatchObject({ updateId: '81', messageId: '52', replyToMessageId: '51' });
  expect(typeof normalized?.acquireTelegramAccount).toBe('function');
  expect(await f.waiting).toEqual({ answer: 'approve', channel: 'telegram' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, consumed: true, outcome: 'payment-reply', answer: 'approve' });
  expect(account.verifies()).toBe(1); expect(readings.requests).toHaveLength(1);
});

test('JSON account claims cannot replace the private verified transport owner', async () => {
  const account = source(), f = await window();
  await expect(tryResolvePaymentReplyFromChannel(message(account, { acquireTelegramAccount: undefined,
    metadata: { messageId: '52', replyToMessageId: '51', accountId: '123', token: 'not-a-capability' } }), decision, f.inbox, account.owner.reader)).rejects.toMatchObject({ kind: 'source-unavailable' });
  await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
  expect(readings.requests).toEqual([]); expect(account.verifies()).toBe(0);
});

test('retiring the poller during semantic reading cannot settle its late answer', async () => {
  const account = source(), f = await window();
  await withPaymentsReadings({ approvalReply() { account.lifetime.abort(); return 'approve'; } }, async requests => {
    await expect(tryResolvePaymentReplyFromChannel(message(account), decision, f.inbox, account.owner.reader)).rejects.toThrow();
    await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
    expect(requests).toHaveLength(1);
  });
});

test('identity verification still in flight at the deadline is not owner silence and remains owned until drained', async () => {
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), admitted = new Promise<void>(resolve => { entered = resolve; });
  let clock = 1;
  const account = source(), f = await window('identity-pending', receipt, 1000, 'veto', new PaymentReplyInbox({ now: () => clock }));
  cleanup.push(release);
  const offer = tryResolvePaymentReplyFromChannel(message(account, { async acquireTelegramAccount() { entered(); await pending; return account.lease.acquire(); } }), decision, f.inbox, account.owner.reader);
  const observedOffer = offer.catch(error => error as unknown);
  await admitted;
  clock = 1000; f.inbox.inspect();
  await expect(f.waiting).rejects.toMatchObject({ kind: 'unsettled-reply' });
  let drained = false; const closing = f.inbox.close().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  release(); await observedOffer; await closing; expect(drained).toBe(true);
  expect(readings.requests).toEqual([]);
});

test('native receipt loss fails at the deadline while authenticated operator buttons remain usable', async () => {
  let clock = 1;
  const first = await window('missing-receipt', null, 1000, 'veto', new PaymentReplyInbox({ now: () => clock }));
  clock = 1000; first.inbox.inspect();
  await expect(first.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
  const second = await window('operator-reply', null);
  const selected = second.inbox.inspect()[0]; if (!selected) throw new Error('Missing native operator window');
  second.inbox.answer({ purchaseId: selected.purchaseId, windowId: selected.windowId, action: 'approve' });
  expect(await second.waiting).toEqual({ answer: 'approve', channel: 'operator' });
});

test('an exact reply reference selects its purchase while another window shares the same chat and topic', async () => {
  const account = source(), first = await window('first-notice');
  const second = await window('second-notice', { ...receipt, messageId: '71' }, Date.now() + 60_000, 'approval', first.inbox);
  expect(await tryResolvePaymentReplyFromChannel(message(account, { metadata: { messageId: '72' } }), decision, first.inbox, account.owner.reader))
    .toEqual({ consumed: false, reason: 'several-windows' });
  expect(account.verifies()).toBe(0); expect(readings.requests).toEqual([]);
  expect(await tryResolvePaymentReplyFromChannel(message(account, { metadata: { messageId: '72', replyToMessageId: '51' } }), decision, first.inbox, account.owner.reader))
    .toEqual({ consumed: true, answer: 'approve' });
  expect(await first.waiting).toEqual({ answer: 'approve', channel: 'telegram' });
  expect(first.inbox.inspect()[0]?.purchaseId).toBe('second-notice');
  second.prepared.cancel(); await expect(second.waiting).rejects.toBeInstanceOf(PaymentReplyWindowError);
});
