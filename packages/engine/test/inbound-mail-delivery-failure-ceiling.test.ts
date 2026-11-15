/**
 * A sink that keeps failing must not leave a mailbox reading "healthy" while
 * every message behind the stuck one waits. Nothing opens a socket; the
 * connection port is scripted and every wait uses the injected clock.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  InboundMailboxWatcher,
  resolveWatcherSettings,
  type InboundMailSink,
  type MailboxConnection,
  type MailboxConnectionPort,
  type MailboxReader,
  type MailboxWire,
} from '../platform/src/platform/email/inbound/index.ts';
import { InboundNoticeTransportError } from '../platform/src/platform/email/inbound/intake.ts';
import type { ImapEnvelope, ImapEnvelopeBatch } from '../platform/src/platform/email/imap-client.ts';
import {
  FakeClock,
  RecordingObserver,
  cleanupInboundScratch,
  fixedRandom,
  makeCursorStore,
  waitFor,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const UID_VALIDITY = 900;

function envelope(uid: number): ImapEnvelope {
  return {
    uid,
    from: 'sender@sender.test',
    subject: `Message ${String(uid)}`,
    date: 'Mon, 27 Jul 2026 09:00:00 +0000',
    messageId: `<uid-${String(uid)}@example.test>`,
    mailbox: MAILBOX,
    deliveredTo: ['watched@example.test'],
    deliveryEvidence: [{ address: 'watched@example.test', rawValue: 'watched@example.test', source: 'delivered-to' }],
    unverifiedToHeaderClaim: 'watched@example.test',
    authenticationResults: [],
  };
}

class Mailbox implements MailboxConnectionPort {
  constructor(private readonly uids: readonly number[]) {}
  async open(): Promise<MailboxConnection> {
    const uids = this.uids;
    const reader: MailboxReader = {
      capabilities: async () => ['IMAP4REV1'],
      fetchEnvelopes: async (wanted) => (await reader.fetchEnvelopeBatch(wanted)).envelopes as ImapEnvelope[],
      fetchEnvelopeBatch: async (wanted): Promise<ImapEnvelopeBatch> => ({
        envelopes: wanted.filter((uid) => uids.includes(uid)).map(envelope),
        unreadable: [],
      }),
    };
    const wire = {
      onUntagged: () => () => undefined,
      sendCommand: async () => 'A001',
      sendRawLine: async () => undefined,
      awaitContinuation: async () => undefined,
      awaitTag: async () => [`* SEARCH ${uids.join(' ')}`, 'A001 OK SEARCH completed'],
      waitForUntagged: async () => '',
    } as unknown as MailboxWire;
    return {
      report: {
        advertisedCapabilities: ['IMAP4REV1'],
        idle: { known: true, supported: false },
        mailbox: { name: MAILBOX, exists: uids.length, uidValidity: UID_VALIDITY, uidNext: Math.max(...uids) + 1, readOnly: true },
      },
      reader,
      wire,
      bodyCapability: { outcome: 'unproven', detail: 'A stub connection.' },
      close: async () => undefined,
    };
  }
}

const running: InboundMailboxWatcher[] = [];
afterAll(() => { cleanupInboundScratch(); });
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

async function build(sink: InboundMailSink) {
  const clock = new FakeClock();
  const { store: cursors } = await makeCursorStore({
    account: ACCOUNT, mailbox: MAILBOX, uidValidity: UID_VALIDITY, lastSeenUid: 101,
  });
  const observer = new RecordingObserver();
  const watcher = new InboundMailboxWatcher({
    settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX, mode: 'poll' }),
    connections: new Mailbox([102, 103]),
    cursors, sink, clock, random: fixedRandom(1), observer,
  });
  running.push(watcher);
  return { watcher, clock, observer };
}

async function pumpUntil(clock: FakeClock, predicate: () => boolean, what: string, maxSteps = 400): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    if (predicate()) return;
    const due = clock.nextDueIn;
    if (Number.isFinite(due)) await clock.advance(due);
    else await waitFor(() => predicate() || Number.isFinite(clock.nextDueIn), `a scheduled wait or ${what}`);
  }
  throw new Error(`Gave up waiting for: ${what}`);
}

describe('a sink that keeps throwing', () => {
  test('moves the verdict off healthy and ends in a terminal report the owner is told about', async () => {
    const attempts: number[] = [];
    const { watcher, clock, observer } = await build({
      deliver: async (message) => {
        attempts.push((message as { uid: number }).uid);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      },
    });
    watcher.start();

    await pumpUntil(clock, () => attempts.length >= 1 && watcher.status.verdict.state !== 'healthy', 'a degraded verdict');
    expect(watcher.status.verdict.state).not.toBe('healthy');

    await pumpUntil(clock, () => observer.terminals.length > 0, 'a terminal report');
    expect(observer.terminals).toHaveLength(1);
    expect(watcher.status.terminalFailure).not.toBeNull();
    // Only UID 102 was ever offered: nothing behind it got past.
    expect(new Set(attempts)).toEqual(new Set([102]));
  });

  test('a notice route that is down keeps retrying and never becomes terminal', async () => {
    let calls = 0;
    const { watcher, clock, observer } = await build({
      deliver: async () => { calls += 1; throw new InboundNoticeTransportError('route down'); },
    });
    watcher.start();

    await pumpUntil(clock, () => calls >= 30, 'thirty failed attempts');
    expect(observer.terminals).toHaveLength(0);
    expect(watcher.status.terminalFailure).toBeNull();
  });
});
