// Proves: One reply settles the wrong purchase window, a reply that could not be read or a shutdown ends a veto window as silence, or an answer for a window that closed or was replaced is applied to the current one.
// Red when: `PaymentReplyInbox` settles one of two windows waiting on a channel with one reply, resolves a window as silence after its reply could not be read or when the inbox closes, or `answer` applies an answer to a replaced window or after the deadline.
/**
 * The inbox that turns the owner's replies into answers for open purchase
 * windows. Silence on a veto window buys, so every way of not knowing what the
 * owner said must end the window as a failure, never as silence; and an answer
 * reaches only the window it was given for.
 *
 * Real `PaymentReplyInbox`. Stand-ins: the clock, and the reading of a reply
 * (the payments readings fixture port).
 */
import { expect, test } from 'bun:test';
import { PaymentReplyInbox, PaymentReplyInboxClosedError, PaymentReplyWindowError } from '../platform/src/platform/payments/reply-inbox.ts';
import { usePaymentsReadings, withPaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();

const START = Date.parse('2026-11-17T12:00:00Z');
const DEADLINE = START + 10 * 60_000;

function inbox(): { replies: PaymentReplyInbox; at: (ms: number) => void } {
  let now = START;
  return { replies: new PaymentReplyInbox({ now: () => now }), at: (ms) => { now = ms; } };
}

function open(replies: PaymentReplyInbox, purchaseId: string, kind: 'approval' | 'veto') {
  const wait = replies.waitForAnswer({ purchaseId, kind, deadlineMs: DEADLINE, channels: ['tui'], notice: `Buy ${purchaseId}?` });
  const outcome = wait.then(answer => ({ answer }), (error: unknown) => ({ error }));
  return { wait, outcome };
}

test('one reply while two purchases wait on a channel settles neither; with one waiting it settles that one', async () => {
  const { replies } = inbox();
  const first = open(replies, 'p-1', 'approval');
  const second = open(replies, 'p-2', 'approval');
  expect(await replies.offer('tui', 'yes')).toEqual({ consumed: false, reason: 'several-windows' });
  expect(replies.inspect().map(window => window.purchaseId)).toEqual(['p-1', 'p-2']);

  // Control: once only one is waiting, the same reply answers it.
  const firstWindow = replies.inspect().find(window => window.purchaseId === 'p-1')!;
  replies.answer({ purchaseId: 'p-1', windowId: firstWindow.windowId, action: 'deny' });
  expect(await first.outcome).toEqual({ answer: { answer: 'deny', channel: 'operator' } });
  expect(await replies.offer('tui', 'yes')).toEqual({ consumed: true, answer: 'approve' });
  expect(await second.outcome).toEqual({ answer: { answer: 'approve', channel: 'tui' } });
  await replies.close();
});

test('a veto reply that could not be read, or the inbox closing, ends the window as a failure, never as silence', async () => {
  const { replies, at } = inbox();
  const unread = open(replies, 'p-unread', 'veto');
  await withPaymentsReadings({ vetoReply: () => { throw new Error('the reading is unavailable'); } }, async () => {
    await expect(replies.offer('tui', 'stop')).rejects.toThrow();
  });
  at(DEADLINE + 1);
  replies.inspect();
  expect(await unread.outcome).toMatchObject({ error: expect.any(Error) });

  const { replies: closing } = inbox();
  const shutDown = open(closing, 'p-closing', 'veto');
  await closing.close();
  expect(await shutDown.outcome).toMatchObject({ error: expect.any(PaymentReplyInboxClosedError) });
  await replies.close();
});

test('an answer for a window that was replaced, or given after the deadline, is not applied', async () => {
  const { replies, at } = inbox();
  const replaced = open(replies, 'p-1', 'approval');
  const oldWindow = replies.inspect()[0]!.windowId;
  replies.answer({ purchaseId: 'p-1', windowId: oldWindow, action: 'deny' });
  expect(await replaced.outcome).toEqual({ answer: { answer: 'deny', channel: 'operator' } });

  // The purchase is put to the owner again: the earlier window's id answers nothing.
  const reopened = open(replies, 'p-1', 'approval');
  expect(() => replies.answer({ purchaseId: 'p-1', windowId: oldWindow, action: 'approve' })).toThrow(PaymentReplyWindowError);
  expect(replies.inspect().filter(window => window.purchaseId === 'p-1')).toHaveLength(1);

  // Past the deadline an approval is not taken: the window ends in silence, which refuses.
  const current = replies.inspect().find(window => window.purchaseId === 'p-1')!.windowId;
  at(DEADLINE);
  expect(() => replies.answer({ purchaseId: 'p-1', windowId: current, action: 'approve' })).toThrow(PaymentReplyWindowError);
  expect(await reopened.outcome).toEqual({ answer: null });
  await replies.close();
});
