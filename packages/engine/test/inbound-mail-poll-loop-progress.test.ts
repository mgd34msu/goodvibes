/**
 * A poll pass that delivers some mail and then fails on one message made
 * progress; the result must say how many it delivered so the watcher does not
 * count the pass toward its consecutive local-failure ceiling.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { resolveWatcherSettings, runPollLoop, type MailboxWire } from '../platform/src/platform/email/inbound/index.ts';
import type { ImapEnvelope } from '../platform/src/platform/email/imap-types.ts';
import {
  FakeClock,
  RecordingObserver,
  cleanupInboundScratch,
  makeCursorStore,
} from './_helpers/inbound-watcher-harness.ts';

afterAll(cleanupInboundScratch);

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

function envelopeFor(uid: number): ImapEnvelope {
  return {
    uid,
    from: `s${String(uid)}@sender.test`,
    subject: `Message ${String(uid)}`,
    date: 'Mon, 27 Jul 2026 12:00:00 +0000',
    messageId: `<m${String(uid)}@sender.test>`,
  } as ImapEnvelope;
}

describe('a poll loop that ends on a delivery failure', () => {
  test('reports the messages it delivered before the failing one', async () => {
    const { store: cursors } = await makeCursorStore({
      account: ACCOUNT, mailbox: MAILBOX, uidValidity: 42, lastSeenUid: 101,
    });
    const cursor = await cursors.get(ACCOUNT, MAILBOX);
    if (cursor === null) throw new Error('the seeded cursor did not persist');
    const uids = [102, 103, 104];

    const result = await runPollLoop({
      settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX, mode: 'poll' }),
      reader: {
        capabilities: async () => ['IMAP4REV1'],
        searchCompleteUids: async () => [], readCompleteMessageDetail: async () => ({ outcome: 'gone' as const }),
        fetchEnvelopes: async () => uids.map(envelopeFor),
        fetchEnvelopeBatch: async () => ({ envelopes: uids.map(envelopeFor), unreadable: [] }),
      },
      wire: {
        onUntagged: () => () => undefined,
        sendCommand: async () => 'A001',
        sendRawLine: async () => undefined,
        awaitContinuation: async () => undefined,
        awaitTag: async () => [`* SEARCH ${uids.join(' ')}`, 'A001 OK'],
        waitForUntagged: async () => '',
      } as unknown as MailboxWire,
      cursors,
      sink: {
        deliver: async (message) => {
          if ('uid' in message && message.uid === 104) throw new Error('record store is locked');
        },
      },
      clock: new FakeClock(),
      observer: new RecordingObserver(),
      cursor,
      via: 'poll',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('delivery-failed');
    expect(result.delivered).toBe(2);
    expect(result.cursor.lastSeenUid).toBe(103);
  });
});
