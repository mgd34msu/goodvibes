import { afterEach, expect, test } from 'bun:test';
import { createTelegramSourceAccountOwner, type TelegramSourceAccountReader } from '../sdk/src/platform/channels/telegram/source-account.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { channelBackedPaymentNotifier } from '../sdk/src/platform/payments/host/notifier.js';
import { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function source(id = '123', pending?: Promise<void>) {
  const owner = createTelegramSourceAccountOwner(), lifetime = new AbortController(), verified = deferred(), read = deferred();
  let identityReads = 0, handleReads = 0, valid = true;
  const attach = () => owner.attach({ lifetime: lifetime.signal, isCurrent: async () => valid,
    isCurrentSync: () => valid, readIdentity: async () => {
      identityReads++; verified.resolve(); await pending;
      return { id, username: 'fixture_bot' };
    } });
  attach(); cleanup.push(() => lifetime.abort());
  const reader: TelegramSourceAccountReader = { ...owner.reader, async read(handle) {
    handleReads++; const result = await owner.reader.read(handle); read.resolve(); return result;
  } };
  return { owner, lifetime, reader, attach, verified, revoke: () => { valid = false; }, identityReads: () => identityReads,
    handleReads: () => handleReads, async ready() { await read.promise; await Promise.resolve(); await Promise.resolve(); } };
}
async function window(account?: ReturnType<typeof source>, receiptAccount = '123') {
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
  const waiting = reception.awaitAnswer(1000);
  return { inbox, waiting, facade, retireFacade: () => helper?.closeDelegatedTelegram(), expire() { clock = 1000; inbox.inspect(); } };
}

test('a native deadline checks the private original live account without doing provider I/O at expiry', async () => {
  const account = source(); expect(account.identityReads()).toBe(0);
  const f = await window(account); await account.ready();
  expect(account.identityReads()).toBe(1); expect(account.handleReads()).toBe(1);
  f.expire(); expect(await f.waiting).toBeNull();
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
