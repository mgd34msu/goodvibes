import { afterEach, expect, test } from 'bun:test';
import { createTelegramSourceAccountOwner, type TelegramSourceAccountReader } from '../platform/src/platform/channels/telegram/source-account.js';
import { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.js';
import { channelBackedPaymentNotifier } from '../platform/src/platform/payments/host/notifier.js';
import { DaemonSurfaceActionHelper } from '../platform/src/platform/daemon/surface-actions.js';
import { PaymentReplySourceOwner } from '../platform/src/platform/payments/reply-source-owner.js';
import { TelegramPollingReceiveProgress } from '../platform/src/platform/channels/telegram/receive-progress.js';
import { withPaymentsReadings } from './helpers/payments-readings.js';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { tryResolvePaymentReplyFromChannel } from '../platform/src/platform/daemon/payment-reply.js';
import type { ChannelPolicyDecision } from '../platform/src/platform/channels/types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function source(id = '123', pending?: Promise<void>) {
  const owner = createTelegramSourceAccountOwner(), lifetime = new AbortController(), verified = deferred(), read = deferred();
  let receiveClock = 0;
  const progress = new TelegramPollingReceiveProgress(lifetime.signal, () => receiveClock);
  let identityReads = 0, handleReads = 0, valid = true;
  const attach = () => owner.attach({ lifetime: lifetime.signal, receiveProgress: progress, isCurrent: async () => valid,
    isCurrentSync: () => valid, readIdentity: async () => {
      identityReads++; verified.resolve(); await pending;
      return { id, username: 'fixture_bot' };
    } });
  attach(); cleanup.push(() => lifetime.abort());
  const reader: TelegramSourceAccountReader = { ...owner.reader, async read(handle) {
    handleReads++; const result = await owner.reader.read(handle); read.resolve(); return result;
  } };
  return { owner, lifetime, reader, attach, verified, revoke: () => { valid = false; }, identityReads: () => identityReads,
    cover(throughMs = 1000) { receiveClock = throughMs + 1; const started = progress.beginRequest(); receiveClock++; progress.completeRequest(started, true); },
    gap() { progress.gap({ conversationId: '-100123' }); },
    handleReads: () => handleReads, async ready() { await read.promise; await Promise.resolve(); await Promise.resolve(); } };
}
async function window(account?: ReturnType<typeof source>, receiptAccount = '123', deadlineMs = 1000) {
  let clock = 1;
  const inbox = new PaymentReplyInbox({ now: () => clock }), facade = new AbortController();
  cleanup.push(() => inbox.close()); cleanup.push(() => facade.abort());
  const helper = account ? new DaemonSurfaceActionHelper({ paymentReplies: inbox, telegramSourceAccounts: account.reader } as unknown as
    ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]) : undefined;
  if (helper) cleanup.push(() => helper.closeDelegatedTelegram());
  const notifier = channelBackedPaymentNotifier({ get: () => 'telegram' }, {
    async deliver() { throw new Error('The native receipt route must send once'); },
    async deliverWithReceipt() { return { receipt: { surfaceKind: 'telegram', conversationId: '-100123', messageId: '51', accountId: receiptAccount } }; },
  }, inbox);
  if (!notifier.prepareWindow) throw new Error('Missing native reception');
  const reception = notifier.prepareWindow({ purchaseId: 'source-expiry', kind: 'veto', notice: 'Original notice' });
  await reception.deliveries;
  const waiting = reception.awaitAnswer(deadlineMs);
  return { inbox, waiting, facade, retireFacade: () => helper?.closeDelegatedTelegram(), at(value: number) { clock = value; },
    expire() { clock = deadlineMs; inbox.inspect(); } };
}

function reply(account: ReturnType<typeof source>, sentAtMs?: number) {
  const source = account.owner.reader;
  return { conversationId: '-100123', messageId: '52', replyToMessageId: '51', userId: '42', updateId: '91', sentAtMs,
    async verifyAccount() {
      const handle = await source.acquire(); if (!handle) throw new Error('Missing original account');
      const value = await source.read(handle); if (!value) throw new Error('Missing original account identity');
      return { accountId: value.id, assertCurrent() { source.assertCurrent(handle); } };
    } };
}

test('a native deadline waits for original receive progress without doing another identity provider read', async () => {
  const account = source(); expect(account.identityReads()).toBe(0);
  const f = await window(account); await account.ready();
  expect(account.identityReads()).toBe(1); expect(account.handleReads()).toBe(1);
  f.expire(); expect(f.inbox.inspect()).toEqual([]); account.cover(); expect(await f.waiting).toBeNull();
  expect(account.identityReads()).toBe(1); expect(account.handleReads()).toBe(1);
});

test('a receipt account ID alone cannot turn an unavailable native source into silence', async () => {
  const f = await window(); f.expire();
  await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
});

test('an unavailable native source leaves the authenticated operator answer path usable before expiry', async () => {
  const f = await window(), view = f.inbox.inspect()[0]; if (!view) throw new Error('Missing operator window');
  f.inbox.answer({ purchaseId: view.purchaseId, windowId: view.windowId, action: 'deny' });
  expect(await f.waiting).toEqual({ answer: 'object', channel: 'operator' });
});

test('a different live bot cannot establish silence for the sending bot receipt', async () => {
  const account = source('456'), f = await window(account); await account.ready(); f.expire();
  await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
});

test.each(['stop', 'replacement', 'facade', 'rebind', 'credential'] as const)(
  'original source retirement (%s) cannot borrow a later session with the same bot ID', async reason => {
    const account = source(), f = await window(account); await account.ready();
    if (reason === 'stop') account.owner.invalidate();
    if (reason === 'replacement') account.attach();
    if (reason === 'facade') f.retireFacade();
    if (reason === 'rebind') f.inbox.bindTelegramSource(account.reader, new AbortController().signal);
    if (reason === 'credential') account.revoke();
    f.expire(); await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
    expect(account.identityReads()).toBe(1);
  },
);

test('binding a source after sending cannot retrofit custody onto the old notice', async () => {
  const f = await window(), account = source();
  f.inbox.bindTelegramSource(account.reader, f.facade.signal); f.expire();
  await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
  expect(account.identityReads()).toBe(0);
});

test('deadline refuses an unresolved original verification and close drains its actual late completion', async () => {
  const gate = deferred(), account = source('123', gate.promise), f = await window(account);
  cleanup.push(gate.resolve); await account.verified.promise;
  f.expire(); await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
  let drained = false;
  const closing = f.inbox.close().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  gate.resolve(); await closing; expect(drained).toBe(true); expect(f.inbox.pending).toBe(0);
  expect(account.handleReads()).toBe(0);
});

test('mutating a borrowed reader wrapper cannot replace the source retained before delivery', async () => {
  const account = source(), f = await window(account); await account.ready();
  account.reader.assertCurrent = () => ({ id: '123', revision: 'fabricated', username: 'fixture_bot' });
  account.owner.invalidate(); f.expire();
  await expect(f.waiting).rejects.toMatchObject({ kind: 'source-unavailable' });
});

test('a first late attachment can verify identity but cannot retroactively cover the notice interval', async () => {
  const owner = createTelegramSourceAccountOwner(), lifetime = new AbortController(), verified = deferred();
  const read = deferred(); let identityReads = 0;
  const reader: TelegramSourceAccountReader = { ...owner.reader, async read(handle) {
    const account = await owner.reader.read(handle); read.resolve(); return account;
  } };
  let clock = 1;
  const inbox = new PaymentReplyInbox({ now: () => clock }); cleanup.push(() => inbox.close()); cleanup.push(() => lifetime.abort());
  const helper = new DaemonSurfaceActionHelper({ paymentReplies: inbox, telegramSourceAccounts: reader } as unknown as
    ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]); cleanup.push(() => helper.closeDelegatedTelegram());
  const notifier = channelBackedPaymentNotifier({ get: () => 'telegram' }, {
    async deliver() { throw new Error('Native delivery must return a receipt'); },
    async deliverWithReceipt() { return { receipt: { surfaceKind: 'telegram', conversationId: '-100123', messageId: '51', accountId: '123' } }; },
  }, inbox);
  if (!notifier.prepareWindow) throw new Error('Missing native reception');
  const reception = notifier.prepareWindow({ purchaseId: 'startup-window', kind: 'veto', notice: 'Original notice' });
  await reception.deliveries; const waiting = reception.awaitAnswer(1000);
  expect(identityReads).toBe(0);
  owner.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true,
    readIdentity: async () => { identityReads++; verified.resolve(); return { id: '123', username: 'fixture_bot' }; } });
  await verified.promise; await read.promise; await Promise.resolve(); await Promise.resolve();
  clock = 1000; inbox.inspect(); await expect(waiting).rejects.toMatchObject({ kind: 'receive-uncovered' }); expect(identityReads).toBe(1);
});

test('an expired operator view cannot approve or acknowledge while native receive coverage is pending', async () => {
  const account = source(), f = await window(account); await account.ready();
  const original = f.inbox.inspect()[0]; if (!original) throw new Error('Missing operator window');
  f.expire(); expect(f.inbox.pending).toBe(1); expect(f.inbox.inspect()).toEqual([]);
  expect(() => f.inbox.answer({ purchaseId: original.purchaseId, windowId: original.windowId, action: 'approve' })).toThrow();
  account.cover(); expect(await f.waiting).toBeNull();
});

test('a same-account processing gap cannot become quiet expiry after later successful polling', async () => {
  const account = source(), f = await window(account); await account.ready(); account.gap();
  f.expire(); account.cover(); await expect(f.waiting).rejects.toMatchObject({ kind: 'receive-uncovered' });
});

test('an on-time provider objection queued past expiry settles the original native window before quiet coverage', async () => {
  await withPaymentsReadings({}, async requests => {
    const account = source(), f = await window(account, '123', 5000); await account.ready();
    f.expire(); f.at(6000);
    expect(await f.inbox.offer('telegram', 'stop', reply(account, 3000))).toEqual({ consumed: true, answer: 'object' });
    expect(await f.waiting).toEqual({ answer: 'object', channel: 'telegram' });
    expect(requests.filter(request => request.context?.battery === 'engine.payments.veto-reply')).toHaveLength(1);
    account.cover(5000); expect(f.inbox.pending).toBe(0);
  });
});

test.each([undefined, 4000] as const)('a queued reply with missing or deadline-overlapping provider time (%s) cannot become silence', async sentAtMs => {
  await withPaymentsReadings({}, async requests => {
    const account = source(), f = await window(account, '123', 4500); await account.ready();
    f.expire(); f.at(6000);
    expect(await f.inbox.offer('telegram', 'stop', reply(account, sentAtMs))).toEqual({ consumed: false, reason: 'no-window' });
    await expect(f.waiting).rejects.toMatchObject({ kind: 'unsettled-reply' });
    expect(requests).toHaveLength(0); account.cover(4500);
  });
});

test('a wholly post-deadline reply is excluded from the original window without pretending it was archived', async () => {
  await withPaymentsReadings({}, async requests => {
    const account = source(), f = await window(account, '123', 5000); await account.ready();
    f.expire(); f.at(6000);
    expect(await f.inbox.offer('telegram', 'stop', reply(account, 5000))).toEqual({ consumed: false, reason: 'no-window' });
    expect(requests).toHaveLength(0); expect(f.inbox.pending).toBe(1); account.cover(5000); expect(await f.waiting).toBeNull();
  });
});

test('a reply admitted before expiry remains on time across slow account verification even without a provider timestamp', async () => {
  await withPaymentsReadings({}, async () => {
    const account = source(), f = await window(account, '123', 5000); await account.ready();
    const entered = deferred(), resume = deferred(); cleanup.push(resume.resolve);
    const original = reply(account);
    const offering = f.inbox.offer('telegram', 'stop', { ...original, async verifyAccount() {
      entered.resolve(); await resume.promise; return original.verifyAccount();
    } });
    await entered.promise; f.expire(); f.at(6000); resume.resolve();
    expect(await offering).toEqual({ consumed: true, answer: 'object' });
    expect(await f.waiting).toEqual({ answer: 'object', channel: 'telegram' });
  });
});

test('completed original receive coverage cannot turn an in-flight owner reply into quiet expiry and close drains it', async () => {
  await withPaymentsReadings({}, async requests => {
    const account = source(), f = await window(account, '123', 5000); await account.ready();
    const entered = deferred(), resume = deferred(); cleanup.push(resume.resolve);
    const original = reply(account);
    const offering = f.inbox.offer('telegram', 'stop', { ...original, async verifyAccount() {
      entered.resolve(); await resume.promise; return original.verifyAccount();
    } });
    // Observe eventual cancellation immediately; the borrowed verifier remains
    // owned even after the original native receive barrier completes.
    const observed = offering.catch(error => error as unknown);
    await entered.promise; f.expire(); account.cover(5000);
    await expect(f.waiting).rejects.toMatchObject({ kind: 'unsettled-reply' });
    let drained = false;
    const closing = f.inbox.close().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    resume.resolve(); await observed; await closing;
    expect(drained).toBe(true); expect(f.inbox.pending).toBe(0);
    expect(requests).toHaveLength(0);
  });
});

test('decision-model exhaustion survives a queued reply and cannot be converted to quiet expiry', async () => {
  const account = source(), f = await window(account, '123', 5000); await account.ready();
  const failure = new JudgmentError('unavailable', 'No decision models are currently available');
  const previous = installJudgmentPort({ model: 'synthetic-unavailable', async ask() { throw failure; } });
  try {
    f.expire(); f.at(6000);
    await expect(f.inbox.offer('telegram', 'stop', reply(account, 3000))).rejects.toBe(failure);
    await expect(f.waiting).rejects.toBe(failure); account.cover(5000); expect(f.inbox.pending).toBe(0);
  } finally { installJudgmentPort(previous); }
});

test('a Classic owner message cannot become silence for an existing native semantic purchase', async () => {
  const account = source(), f = await window(account); await account.ready();
  cleanup.push(configureDecisionModelPolicy(() => 'Classic - Off'));
  const policy = { allowed: true, reason: 'owner', policy: { allowlistUserIds: ['42'] } } as unknown as ChannelPolicyDecision;
  const result = await tryResolvePaymentReplyFromChannel({ surface: 'telegram', userId: '42', channelId: '-100123', text: 'stop',
    metadata: { messageId: '52', updateId: '91', messageSentAtMs: 0 } }, policy, f.inbox, account.reader);
  expect(result).toEqual({ consumed: false, reason: 'decision-model-required' });
  await expect(f.waiting).rejects.toMatchObject({ code: 'decision-models-disabled' });
  f.expire(); account.cover(); expect(f.inbox.pending).toBe(0);
});

test.each(['close', 'rebind', 'window', 'facade'] as const)('pending startup source acquisition drains on %s without waiting for ingress', async reason => {
  const native = createTelegramSourceAccountOwner(), source = new PaymentReplySourceOwner();
  const facade = new AbortController(), window = new AbortController();
  source.bindTelegram(native.reader, facade.signal);
  const guard = source.reserveTelegram(window.signal);
  await Promise.resolve();
  if (reason === 'close') void source.close();
  if (reason === 'rebind') source.bindTelegram(native.reader, new AbortController().signal);
  if (reason === 'window') window.abort();
  if (reason === 'facade') facade.abort();
  await expect(guard.ready).rejects.toThrow(); await source.close();
  expect(() => guard.assertReceiptCurrent({ surfaceKind: 'telegram', conversationId: '1', messageId: '2', accountId: '123' })).toThrow();
});
