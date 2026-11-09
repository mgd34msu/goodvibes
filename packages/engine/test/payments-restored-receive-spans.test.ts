/** Native cursor, account, ingress and encrypted archive are real; only the
 * Telegram wire and judgment answers are synthetic. Not executed in coding phase. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramOffsetStore } from '../sdk/src/platform/channels/telegram/offset-store.js';
import { TelegramPollingReceiveProgress } from '../sdk/src/platform/channels/telegram/receive-progress.js';
import { TelegramBotApi } from '../sdk/src/platform/channels/telegram/api.js';
import { TelegramIngressSupervisor } from '../sdk/src/platform/channels/telegram/ingress.js';
import { createTelegramSourceAccountOwner } from '../sdk/src/platform/channels/telegram/source-account.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { ProtectedPaymentRequests } from '../sdk/src/platform/payments/host/protected-requests.js';
import { prepareRestoredPaymentReplyWindow } from '../sdk/src/platform/payments/host/restored-reply-window.js';
import { daemonNoticeRouter } from '../sdk/src/platform/payments/host/notifier.js';
import { paymentReplyHistoryBinding } from '../sdk/src/platform/payments/reply-history.js';
import { tryResolvePaymentReplyFromChannel } from '../sdk/src/platform/daemon/payment-reply.js';
import { configureDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import type { ChannelIngressPolicyInput, ChannelPolicyDecision } from '../sdk/src/platform/channels/types.js';
import type { ChannelDeliveryRequest } from '../sdk/src/platform/channels/delivery/types.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';
import { withPaymentsReadings } from './helpers/payments-readings.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(partial = false, future = false) {
  const root = mkdtempSync(join(tmpdir(), 'payment-native-span-restart-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let clock = 1000; const mockedClock = spyOn(Date, 'now').mockImplementation(() => clock); cleanup.push(() => mockedClock.mockRestore());
  cleanup.push(configureDecisionModelPolicy(() => 'Default - On'));
  const original = protectedPaymentRequest(), base = protectedPaymentWindow(original, 1000), first = base.record.windowDeliveries?.[0];
  if (!first?.receipt) throw new Error('Missing actual fixture receipt');
  const window = { ...base, record: { ...base.record, windowDeadlineMs: future ? 20_000 : 9000,
    windowDeliveries: partial ? [{ ...first, receipt: first.receipt }, { ...first, receipt: { ...first.receipt, conversationId: '-100456' } }] : [{ ...first, receipt: first.receipt }] } };
  const offsetPath = join(root, 'cursor.json'), beforeCursor = new TelegramOffsetStore(offsetPath, '123', () => {}, () => {}).retainPolling();
  const beforeLife = new AbortController(), before = new TelegramPollingReceiveProgress(beforeLife.signal, () => clock, beforeCursor);
  const pinned = before.retain(original.purchaseId, clock), selector = pinned.selector; if (!selector) throw new Error('Missing pre-notice native span');
  beforeCursor.save(500, () => {});
  if (partial) before.gap({ conversationId: '-100456' });
  beforeLife.abort(); beforeCursor.release();
  const store = new ProtectedPaymentRequests(join(root, 'requests'), () => {}, () => {}, () => {}, () => {}, () => {});
  await store.retain(original, () => {});
  await store.checkpointWindow(original.purchaseId, original.operationId, window, null, () => {}, window.record.windowDeliveries.map(delivery => ({
    receipt: delivery.receipt, selector, deadlineMs: window.record.windowDeadlineMs, acceptPositive: true,
  })));
  clock = 10_000;
  const accounts = createTelegramSourceAccountOwner(), lifetime = new AbortController(), inbox = new PaymentReplyInbox({ now: () => clock });
  inbox.bindTelegramSource(accounts.reader, lifetime.signal);
  const binding = paymentReplyHistoryBinding(window), order: string[] = [];
  const history = inbox.retainReplyHistory(original.purchaseId, window, async (entry, current) => {
    order.push('archive-start');
    await store.appendReply(original.purchaseId, original.operationId, binding, entry, current); order.push('archive');
  }, () => lifetime.signal.throwIfAborted(), (coverage, current) => store.recordReceiveCoverage(original.purchaseId, original.operationId, binding, coverage, current));
  const polls: { offset: unknown; finish(updates: unknown[]): void }[] = [], arrivals: ReturnType<typeof deferred<void>>[] = [];
  const waitPoll = async (index: number) => {
    const entry = arrivals[index] ??= deferred<void>(); if (polls[index]) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entry.promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Missing poll ${index}; observed ${order.join(',')}; status ${JSON.stringify(supervisor.status)}`)), 2000); })]); }
    finally { clearTimeout(timer); }
  };
  const values: Record<string, unknown> = { 'surfaces.telegram.enabled': true, 'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123:synthetic-token', 'surfaces.telegram.botUsername': 'fixture_bot' };
  const policy = { allowed: true, reason: 'owner', policy: { allowlistUserIds: ['42'] } } as unknown as ChannelPolicyDecision;
  const supervisor = new TelegramIngressSupervisor({ now: () => clock, offsetFilePath: offsetPath, telegramSourceAccounts: accounts,
    beforeCursorWrite() {}, beforeReceiveSpanWrite() {},
    configManager: { get: (key: string) => values[key] } as never,
    serviceRegistry: { get: () => null, resolveSecret: async () => null } as never,
    secretsManager: { get: () => null, getGlobalHome: () => undefined, onDidChange: () => () => {}, resolveLocalSecretSync: () => ({ state: 'absent' }) } as never,
    createApi: token => new TelegramBotApi(token, async (url, init) => {
      const method = url.split('/').pop();
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 123, username: 'fixture_bot', is_bot: true, first_name: 'Fixture' } });
      if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: '', pending_update_count: 0 } });
      if (method === 'getUpdates') return new Promise<Response>((resolve, reject) => {
        const index = polls.length, body = JSON.parse(String(init.body)) as Record<string, unknown>;
        order.push(`poll:${String(body['offset'])}`);
        const abort = () => { init.signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')); };
        polls.push({ offset: body['offset'], finish(updates) { init.signal?.removeEventListener('abort', abort); resolve(Response.json({ ok: true, result: updates })); } });
        init.signal?.addEventListener('abort', abort, { once: true }); if (init.signal?.aborted) abort();
        (arrivals[index] ??= deferred<void>()).resolve();
      });
      return Response.json({ ok: true, result: true });
    }),
    buildSurfaceAdapterContext: () => ({ configManager: { get: (key: string) => values[key] },
      hasPaymentReplyWindow: () => inbox.pending > 0,
      async authorizeSurfaceIngress(input: ChannelIngressPolicyInput) {
        const reply = await tryResolvePaymentReplyFromChannel(input, policy, inbox, accounts.reader);
        return { ...policy, allowed: false, reason: 'reason' in reply && reply.reason === 'recorded' ? 'payment-reply-recorded' : 'payment-reply-consumed' };
      },
    }) as never,
  });
  cleanup.push(async () => { lifetime.abort(); await supervisor.stop(); await inbox.close(); await history.retire(); });
  await supervisor.start(); await waitPoll(0);
  const sent: ChannelDeliveryRequest[] = [], router = daemonNoticeRouter({ async deliver() { throw new Error('Acknowledgement required'); },
    async deliverWithReceipt(request) { request.assertCurrent?.(); sent.push(request);
      return { receipt: { surfaceKind: 'telegram', accountId: '123', conversationId: request.target.address ?? '', messageId: '62' } }; },
  });
  const recipients = window.record.windowDeliveries.map(delivery => ({ delivery, receipt: delivery.receipt,
    target: { channel: 'telegram' as const, backfillable: false, request: { target: { kind: 'surface', surfaceKind: 'telegram', address: delivery.receipt.conversationId } } } }));
  const prepare = () => prepareRestoredPaymentReplyWindow({ purchaseId: original.purchaseId, checkpoint: window, recipients,
    readHistory: async () => (await store.read(original.purchaseId, original.operationId, () => lifetime.signal.throwIfAborted())).replyHistory,
    replies: inbox, router, signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted(), renewMinutes: 60 });
  return { original, window, inbox, store, prepare, polls, sent, order, waitPoll, lifetime, at: (time: number) => { clock = time; } };
}

test('actual startup backlog archives the original approval before confirming its cursor and preserves the original deadline', async () => {
  const f = await fixture();
  await withPaymentsReadings({ approvalReply: () => 'approve' }, async requests => {
    const restored = f.prepare();
    f.polls[0]?.finish([{ update_id: 500, message: { message_id: 52, date: 7, from: { id: 42 }, chat: { id: -100123, type: 'private' }, reply_to_message: { message_id: 51 }, text: 'Yes.' } }]);
    await f.waitPoll(1); expect(f.polls[1]?.offset).toBe(501); expect(f.order.indexOf('archive')).toBeLessThan(f.order.indexOf('poll:501'));
    f.polls[1]?.finish([]); await restored.deliveries;
    expect(await restored.deadlineMs).toBe(9000); expect(await restored.awaitAnswer(9000)).toEqual({ answer: 'approve', channel: 'telegram' });
    expect(requests).toHaveLength(1); expect(f.sent).toEqual([]); restored.cancel();
  });
});

test('partial original coverage re-notifies only the uncovered actual recipient and persists the other original cutoff', async () => {
  const f = await fixture(true), restored = f.prepare(); f.polls[0]?.finish([]);
  const report = await restored.deliveries, deadline = await restored.deadlineMs;
  expect(f.sent.map(request => request.target.address)).toEqual(['-100456']);
  expect(report.map(delivery => delivery.receipt?.conversationId)).toEqual(['-100456']); expect(deadline).toBe(3_610_000);
  const saved = await f.store.read(f.original.purchaseId, f.original.operationId, () => {});
  expect(saved.replyHistory?.windows.at(-1)?.receiveCoverage).toMatchObject([{ throughMs: 9000, receipt: { conversationId: '-100123', messageId: '51' } }]);
  const waiting = restored.awaitAnswer(deadline), pending = f.inbox.inspect()[0]; if (!pending) throw new Error('Fresh recipient reception missing');
  f.inbox.answer({ purchaseId: pending.purchaseId, windowId: pending.windowId, action: 'deny' }); expect(await waiting).toMatchObject({ answer: 'deny' }); restored.cancel();
});

test('a fully covered still-open original window keeps its same acknowledged notice without another send', async () => {
  const f = await fixture(false, true), restored = f.prepare(); f.polls[0]?.finish([]);
  expect(await restored.deliveries).toEqual(f.window.record.windowDeliveries); expect(await restored.deadlineMs).toBe(20_000); expect(f.sent).toEqual([]);
  const waiting = restored.awaitAnswer(20_000), pending = f.inbox.inspect()[0]; if (!pending) throw new Error('Original live reception missing');
  f.inbox.answer({ purchaseId: pending.purchaseId, windowId: pending.windowId, action: 'approve' }); expect(await waiting).toMatchObject({ answer: 'approve' }); restored.cancel();
});
