import { describe, expect, test } from 'bun:test';
import {
  createInboundMailDedup,
  DedupingInboundMailSink,
} from '../platform/src/platform/email/inbound/index.ts';
import type { ImapInboundMessage } from '../platform/src/platform/email/inbound/ports.ts';

function message(): ImapInboundMessage {
  return {
    source: 'imap',
    account: 'primary',
    mailbox: 'INBOX',
    from: 'a@service.test',
    subject: 's',
    claimedDate: 'Tue, 28 Jul 2026 08:59:00 +0000',
    messageId: '<1@service.test>',
    deliveredTo: [],
    unverifiedToHeaderClaim: '',
    uidValidity: 1,
    uid: 7,
    envelope: {} as ImapInboundMessage['envelope'],
    via: 'idle',
  } as ImapInboundMessage;
}

describe('a repeat of a message whose first attempt is still running', () => {
  test('does not let the cursor pass it when the first attempt then fails', async () => {
    let fail: (error: Error) => void = () => undefined;
    let calls = 0;
    const sink = new DedupingInboundMailSink({
      dedup: createInboundMailDedup(60_000),
      handle: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => { fail = reject; });
      },
    });

    const first = sink.deliver(message()).then(() => 'resolved', (error: Error) => error.message);
    const second = sink.deliver(message()).then(() => 'resolved', (error: Error) => error.message);
    fail(new Error('store down'));

    expect(await first).toBe('store down');
    expect(await second).toBe('store down');
    expect(calls).toBe(1);

    // The failed attempt gave its claim back, so the retry is handled afresh.
    await sink.deliver(message());
    expect(calls).toBe(2);
  });

  test('still resolves as a duplicate once the first attempt succeeded', async () => {
    let finish: () => void = () => undefined;
    let calls = 0;
    const sink = new DedupingInboundMailSink({
      dedup: createInboundMailDedup(60_000),
      handle: () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve; }); },
    });
    const first = sink.deliver(message());
    const second = sink.deliver(message());
    finish();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});
