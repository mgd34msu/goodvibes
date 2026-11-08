import { afterEach, expect, test } from 'bun:test';
import { PaymentReplyInbox, PaymentReplyWindowError } from '../sdk/src/platform/payments/reply-inbox.js';
import { parseCommandAuthorityChannel } from '../sdk/src/platform/payments/types.js';
import { readPaymentWindowStatus, readPaymentWindowAnswer } from '../sdk/src/platform/payments/browser.js';
import { purchaseWindowAnswerHandler, purchaseWindowStatusHandler } from '../sdk/src/platform/payments/host/window-handlers.js';
import type { HandlerContextEnvelope } from '../sdk/src/platform/payments/host/handler-plumbing.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../sdk/src/platform/security/http-auth.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings();
const inboxes: PaymentReplyInbox[] = [];
afterEach(async () => { await Promise.all(inboxes.splice(0).map(inbox => inbox.close())); });
function inbox(now?: () => number) { const value = new PaymentReplyInbox(now ? { now } : {}); inboxes.push(value); return value; }
function open(replies: PaymentReplyInbox, kind: 'approval' | 'veto' = 'approval') {
  const wait = replies.waitForAnswer({ purchaseId: 'purchase', kind, notice: 'Owner notice for the selected purchase',
    deadlineMs: Date.now() + 60_000, channels: ['telegram'] });
  const view = replies.inspect()[0];
  if (!view) throw new Error('Fixture did not open its window');
  return { wait, view };
}
function authority() {
  let authorized = true;
  let beforeLock: () => Promise<void> = async () => {};
  const paired: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'device', principalId: 'pairing:device', authorityId: 'pairing:device',
    authorityRevision: 'original-pairing', scopes: ['read:payments', 'write:payments'] };
  const native: NativeExecutionAuthority = {
    current: () => authorized ? paired : null,
    async withCurrent(expected, operation) {
      await beforeLock();
      const current = () => { if (!authorized || expected !== paired) throw new Error('Private pairing diagnostic'); return paired; };
      return operation(current);
    },
  };
  const context: HandlerContextEnvelope = { principalId: paired.principalId, principalKind: 'token', admin: true,
    scopes: [...paired.scopes], explicitUserRequest: true, authToken: 'fixture-not-a-real-token',
    isAuthorized: () => authorized, nativeExecutionAuthority: native };
  return { context, revoke: () => { authorized = false; }, hold: (work: () => Promise<void>) => { beforeLock = work; } };
}
function request(context: HandlerContextEnvelope, view: { purchaseId: string; windowId: string }) {
  return { body: { purchaseId: view.purchaseId, windowId: view.windowId, confirm: true }, query: {}, context };
}
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

test('an explicit operator answer settles the same approval as channel ingress without consulting a model', async () => {
  const replies = inbox(); const { wait, view } = open(replies); const owner = authority();
  const handler = purchaseWindowAnswerHandler({ replies }, 'approve');
  const result = readPaymentWindowAnswer(await handler(request(owner.context, view)));
  expect(result).toEqual({ purchaseId: view.purchaseId, windowId: view.windowId, accepted: true, answer: 'approve' });
  expect(await wait).toEqual({ answer: 'approve', channel: 'operator' });
  await expect(handler(request(owner.context, view))).rejects.toMatchObject({ status: 409 });
  expect(readings.requests).toHaveLength(0);
  expect(parseCommandAuthorityChannel('operator')).toBeNull();
  expect(parseCommandAuthorityChannel('email')).toBeNull();
});

test.each(['approve', 'deny', 'cancel'] as const)('%s applies the veto meaning without changing its silence rule', async action => {
  const replies = inbox(); const { wait, view } = open(replies, 'veto'); const owner = authority();
  await purchaseWindowAnswerHandler({ replies }, action)(request(owner.context, view));
  expect(await wait).toEqual({ answer: action === 'approve' ? 'acknowledge' : 'object', channel: 'operator' });
  expect(readings.requests).toHaveLength(0);
});

test('two competing explicit answers have one winner', async () => {
  const replies = inbox(); const { wait, view } = open(replies); const owner = authority();
  const results = await Promise.allSettled([
    purchaseWindowAnswerHandler({ replies }, 'approve')(request(owner.context, view)),
    purchaseWindowAnswerHandler({ replies }, 'cancel')(request(owner.context, view)),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await wait)?.answer).toBe('approve');
});

test('stale screens cannot answer a replacement window, including a new inbox incarnation', async () => {
  const replies = inbox(); const first = open(replies);
  replies.answer({ ...first.view, action: 'deny' }); await first.wait;
  const next = open(replies);
  expect(next.view.windowId).not.toBe(first.view.windowId);
  expect(() => replies.answer({ ...first.view, action: 'approve' })).toThrow(PaymentReplyWindowError);
  expect(replies.pending).toBe(1);
  const restarted = inbox(); const restored = open(restarted);
  expect(restored.view.windowId).not.toBe(first.view.windowId);
  expect(() => restarted.answer({ ...first.view, action: 'approve' })).toThrow(PaymentReplyWindowError);
});

test.each(['admin', 'principalKind', 'principalId', 'scopes', 'explicitUserRequest', 'nativeExecutionAuthority', 'isAuthorized'] as const)(
  'an answer cannot obtain missing %s from its body', async field => {
    const replies = inbox(); const { view } = open(replies); const owner = authority();
    const invalid = { ...owner.context, [field]: field === 'scopes' ? [] : field === 'admin' || field === 'explicitUserRequest' ? false : undefined } as unknown as HandlerContextEnvelope;
    const input = request(invalid, view);
    const forged = { ...input, body: { ...input.body, admin: true, scopes: ['*'], explicitUserRequest: true, nativeExecutionAuthority: owner.context.nativeExecutionAuthority } };
    await expect(purchaseWindowAnswerHandler({ replies }, 'approve')(forged)).rejects.toMatchObject({ status: 403 });
    expect(replies.pending).toBe(1);
    expect(readings.requests).toHaveLength(0);
  },
);

test('revocation while awaiting the native owner lock cannot answer a purchase', async () => {
  const replies = inbox(); const { view } = open(replies); const owner = authority(); const entered = barrier(), gate = barrier();
  owner.hold(async () => { entered.release(); await gate.wait; });
  const answer = purchaseWindowAnswerHandler({ replies }, 'approve')(request(owner.context, view)); void answer.catch(() => {});
  await entered.wait; owner.revoke(); gate.release();
  await expect(answer).rejects.toMatchObject({ status: 409 });
  expect(replies.pending).toBe(1);
});

test('context edits or cancellation while awaiting the native lock do not retarget the original answer', async () => {
  for (const abort of [true, false]) {
    const replies = inbox(); const { view } = open(replies); const owner = authority(); const entered = barrier(), gate = barrier();
    const signal = new AbortController(); const context = { ...owner.context, signal: signal.signal };
    owner.hold(async () => { entered.release(); await gate.wait; });
    const input = request(context, view);
    const answer = purchaseWindowAnswerHandler({ replies }, 'approve')(input); void answer.catch(() => {});
    await entered.wait;
    if (abort) signal.abort(new Error('Private cancellation diagnostic')); else context.scopes.splice(0);
    input.body.purchaseId = 'another-purchase'; input.body.windowId = 'another-window';
    gate.release(); await expect(answer).rejects.toBeInstanceOf(Error);
    expect(replies.pending).toBe(1);
  }
});

test('status is read-scoped, immutable and does not extend a deadline or invent a delivery', async () => {
  let clock = 10;
  const replies = inbox(() => clock);
  const wait = replies.waitForAnswer({ purchaseId: 'purchase', kind: 'approval', notice: 'Exact owner notice', deadlineMs: 20, channels: ['telegram'] });
  const owner = authority();
  const context = { ...owner.context, admin: false, scopes: ['read:payments'] };
  const handler = purchaseWindowStatusHandler({ replies });
  const first = readPaymentWindowStatus(await handler({ body: {}, query: {}, context }));
  expect(first.windows[0]?.deadlineMs).toBe(20);
  expect(Object.isFrozen(first.windows[0])).toBe(true);
  expect(readPaymentWindowStatus(await handler({ body: {}, query: { purchaseId: 'another' }, context })).windows).toEqual([]);
  clock = 21;
  expect(readPaymentWindowStatus(await handler({ body: {}, query: {}, context })).windows).toEqual([]);
  expect(await wait).toBeNull();
  expect(readings.requests).toHaveLength(0);
  await expect(handler({ body: {}, query: {}, context: { ...context, scopes: [] } })).rejects.toMatchObject({ status: 403 });
});

test('surface decoders reject mismatched/extra/private fields and invalid deadlines without echoing them', () => {
  const valid = { purchaseId: 'purchase', windowId: 'window', kind: 'approval', notice: 'Owner notice', deadlineMs: 1 };
  expect(readPaymentWindowStatus({ windows: [valid] }).windows).toEqual([valid]);
  for (const value of [{ windows: [{ ...valid, deadlineMs: Infinity }] }, { windows: [{ ...valid, cardNumber: 'Private fixture content' }] }, { windows: [valid, valid] }]) {
    expect(() => readPaymentWindowStatus(value)).toThrow('invalid purchase-window response');
  }
  expect(() => readPaymentWindowAnswer({ purchaseId: 'purchase', windowId: 'window', accepted: false, answer: 'approve' })).toThrow('invalid purchase-window response');
});
