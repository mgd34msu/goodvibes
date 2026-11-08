import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createChannelPaymentNotifier } from '../sdk/src/platform/payments/notice-delivery.js';
import { PaymentReplyInbox, PaymentReplyInboxClosedError, PaymentReplyWindowError } from '../sdk/src/platform/payments/reply-inbox.js';
import type { CommandAuthorityChannel } from '../sdk/src/platform/payments/types.js';
import { paymentsPort, usePaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings();
const inboxes: PaymentReplyInbox[] = [];
afterEach(async () => { await Promise.all(inboxes.splice(0).map(inbox => inbox.close())); });
function inbox(now?: () => number) {
  const value = new PaymentReplyInbox(now === undefined ? {} : { now });
  inboxes.push(value);
  return value;
}
function input(purchaseId: string) {
  return { purchaseId, kind: 'approval' as 'approval' | 'veto', channels: ['telegram'] as CommandAuthorityChannel[], notice: `Notice for ${purchaseId}`, deadlineMs: Date.now() + 60_000 };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}

test('interleaved notices of the same kind retain the exact purchase notice used to interpret each reply', async () => {
  const replies = inbox();
  const notifier = createChannelPaymentNotifier({
    router: { async deliver() { return 'delivered'; } },
    targets: [{ channel: 'telegram', request: {}, backfillable: false }], replies,
  });
  const first = input('purchase-a');
  const second = input('purchase-b');
  await notifier.deliver({ kind: first.kind, message: first.notice });
  await notifier.deliver({ kind: second.kind, message: second.notice });
  const firstWait = notifier.awaitAnswer(first);
  expect(await replies.offer('telegram', 'yes')).toEqual({ consumed: true, answer: 'approve' });
  expect(await firstWait).toEqual({ answer: 'approve', channel: 'telegram' });
  const secondWait = notifier.awaitAnswer(second);
  expect(await replies.offer('telegram', 'no')).toEqual({ consumed: true, answer: 'deny' });
  expect(await secondWait).toEqual({ answer: 'deny', channel: 'telegram' });
  expect(readings.requests.map(request => request.state)).toEqual([
    { proposal: first.notice, reply: 'yes' }, { proposal: second.notice, reply: 'no' },
  ]);
});

test('one purchase cannot silently replace its live window', async () => {
  const replies = inbox();
  const original = input('same-purchase');
  const first = replies.waitForAnswer(original);
  await expect(replies.waitForAnswer({ ...original, notice: 'A different purchase notice' })).rejects.toMatchObject({ kind: 'duplicate' });
  expect(replies.pending).toBe(1);
  expect(await replies.offer('telegram', 'yes')).toEqual({ consumed: true, answer: 'approve' });
  expect((await first)?.answer).toBe('approve');
  expect(readings.requests[0]!.state).toEqual({ proposal: original.notice, reply: 'yes' });
});

test('a wait snapshots its purchase, notice, channels, kind and deadline before later caller edits', async () => {
  const replies = inbox();
  const original = input('captured-purchase');
  const notice = original.notice;
  const wait = replies.waitForAnswer(original);
  original.purchaseId = 'replacement-purchase';
  original.notice = 'Replacement notice';
  original.kind = 'veto';
  original.channels[0] = 'tui';
  original.deadlineMs = 0;
  expect(await replies.offer('telegram', 'yes')).toEqual({ consumed: true, answer: 'approve' });
  expect((await wait)?.answer).toBe('approve');
  expect(readings.requests[0]!.context?.battery).toBe('engine.payments.approval-reply');
  expect(readings.requests[0]!.state).toEqual({ proposal: notice, reply: 'yes' });
});

test('cancellation belongs to the original signal and is never deadline silence', async () => {
  const replies = inbox();
  const owner = new AbortController();
  const replacement = new AbortController();
  const original = { ...input('cancelled-purchase'), signal: owner.signal };
  const wait = replies.waitForAnswer(original);
  original.signal = replacement.signal;
  replacement.abort();
  expect(replies.pending).toBe(1);
  owner.abort(new Error('Private caller detail must not become the window error'));
  await expect(wait).rejects.toBeInstanceOf(PaymentReplyWindowError);
  await expect(wait).rejects.toMatchObject({ kind: 'cancelled' });
  const failure: unknown = await wait.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PaymentReplyWindowError);
  expect((failure as Error).message).not.toContain('Private caller detail');
  expect(replies.pending).toBe(0);
  expect(readings.requests).toHaveLength(0);
});

test('a long deadline is not shortened by setTimeout overflow', async () => {
  const replies = inbox();
  let settled = false;
  const wait = replies.waitForAnswer({ ...input('long-deadline'), deadlineMs: Date.now() + 0x7fff_ffff + 1000 });
  const outcome = wait.then(() => { settled = true; return null; }, error => { settled = true; return error as unknown; });
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  expect(settled).toBe(false);
  expect(replies.pending).toBe(1);
  await replies.close();
  expect(await outcome).toBeInstanceOf(PaymentReplyInboxClosedError);
});

test('an invalid or failed host clock cannot establish deadline silence or leave a pending window behind', async () => {
  for (const clock of [() => Number.NaN, () => { throw new Error('Private clock failure'); }]) {
    const replies = inbox(clock);
    await expect(replies.waitForAnswer(input('unknown-clock'))).rejects.toMatchObject({ kind: 'clock-unavailable' });
    expect(replies.pending).toBe(0);
    expect(await replies.offer('telegram', 'yes')).toEqual({ consumed: false, reason: 'no-window' });
  }
  expect(readings.requests).toHaveLength(0);
});

test('an unresolved owner reply at the deadline fails a veto instead of converting it into silence', async () => {
  let clock = 100;
  const replies = inbox(() => clock);
  const entered = deferred();
  const release = deferred();
  const fake = paymentsPort();
  let signal: AbortSignal | undefined;
  const previous = installJudgmentPort({ model: fake.port.model, async ask(request) {
    signal = request.signal;
    entered.resolve();
    await release.promise;
    return fake.port.ask(request);
  } });
  try {
    const wait = replies.waitForAnswer({ ...input('unsettled-veto'), kind: 'veto', deadlineMs: 200 });
    const offer = replies.offer('telegram', 'stop');
    await entered.promise;
    clock = 201;
    expect(await replies.offer('telegram', 'another message')).toEqual({ consumed: false, reason: 'no-window' });
    await expect(wait).rejects.toMatchObject({ kind: 'unsettled-reply' });
    expect(signal?.aborted).toBe(true);
    let closed = false;
    const closing = replies.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect(await offer).toEqual({ consumed: false, reason: 'no-window' });
    await closing;
  } finally {
    release.resolve();
    await replies.close();
    installJudgmentPort(previous);
  }
});

test('a late reply from an earlier wait cannot settle a new wait with the same purchase ID', async () => {
  const replies = inbox();
  const owner = new AbortController();
  const entered = deferred();
  const release = deferred();
  const fake = paymentsPort();
  let held = true;
  const previous = installJudgmentPort({ model: fake.port.model, async ask(request) {
    if (held) { entered.resolve(); await release.promise; }
    return fake.port.ask(request);
  } });
  try {
    const original = input('same-id-after-cancel');
    const wait = replies.waitForAnswer({ ...original, signal: owner.signal });
    const offer = replies.offer('telegram', 'yes');
    await entered.promise;
    owner.abort();
    await expect(wait).rejects.toMatchObject({ kind: 'cancelled' });
    const replacement = replies.waitForAnswer({ ...original, notice: 'A fresh notice' });
    release.resolve();
    expect(await offer).toEqual({ consumed: false, reason: 'no-window' });
    expect(replies.pending).toBe(1);
    held = false;
    expect(await replies.offer('telegram', 'no')).toEqual({ consumed: true, answer: 'deny' });
    expect((await replacement)?.answer).toBe('deny');
  } finally {
    release.resolve();
    await replies.close();
    installJudgmentPort(previous);
  }
});
