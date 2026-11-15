/**
 * A server that answers a FETCH with a bare `NO` and no response code: the
 * watcher retries it a bounded number of times before the mailbox is reported
 * as refusing to hand over messages.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  InboundMailboxWatcher,
  resolveWatcherSettings,
  type MailboxConnection,
  type MailboxConnectionPort,
  type MailboxReader,
  type MailboxWire,
} from '../platform/src/platform/email/inbound/index.ts';
import type { ImapEnvelope } from '../platform/src/platform/email/imap-client.ts';
import {
  FakeClock,
  cleanupInboundScratch,
  makeCursorStore,
  RecordingObserver,
  RecordingSink,
  fixedRandom,
  waitFor,
} from './_helpers/inbound-watcher-harness.ts';

import { imapFixturePort } from './_helpers/imap-semantic-port.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(imapFixturePort().port); });
afterEach(() => { installJudgmentPort(previousPort); });

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const UID_VALIDITY = 900;

class RefusingMailbox implements MailboxConnectionPort {
  opens = 0;
  constructor(private readonly refusal: string) {}

  async open(): Promise<MailboxConnection> {
    this.opens += 1;
    const refusal = this.refusal;
    const reader: MailboxReader = {
      capabilities: async () => ['IMAP4REV1'],
      fetchEnvelopes: async () => { throw new Error(refusal); },
      fetchEnvelopeBatch: async () => { throw new Error(refusal); },
    };
    const wire = {
      onUntagged: () => () => undefined,
      sendCommand: async () => 'A001',
      sendRawLine: async () => undefined,
      awaitContinuation: async () => undefined,
      awaitTag: async () => ['* SEARCH 102', 'A001 OK SEARCH completed'],
      waitForUntagged: async () => '',
    } as unknown as MailboxWire;
    return {
      report: {
        advertisedCapabilities: ['IMAP4REV1'],
        idle: { known: true, supported: false },
        mailbox: { name: MAILBOX, exists: 1, uidValidity: UID_VALIDITY, uidNext: 103, readOnly: true },
      },
      reader,
      wire,
      bodyCapability: { outcome: 'unproven', detail: 'A stub connection: nothing is proven.' },
      close: async () => undefined,
    };
  }
}

const watchers: InboundMailboxWatcher[] = [];
afterAll(() => { cleanupInboundScratch(); });
afterEach(async () => {
  while (watchers.length > 0) await watchers.pop()?.stop();
});

async function run(refusal: string) {
  const clock = new FakeClock();
  const { store: cursors } = await makeCursorStore({
    account: ACCOUNT, mailbox: MAILBOX, uidValidity: UID_VALIDITY, lastSeenUid: 101,
  });
  const observer = new RecordingObserver();
  const connections = new RefusingMailbox(refusal);
  const watcher = new InboundMailboxWatcher({
    settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX, mode: 'poll' }),
    connections,
    cursors,
    sink: new RecordingSink(),
    clock,
    random: fixedRandom(1),
    observer,
  });
  watchers.push(watcher);
  watcher.start();
  for (let step = 0; step < 200 && observer.terminals.length === 0; step += 1) {
    const due = clock.nextDueIn;
    if (Number.isFinite(due)) await clock.advance(due);
    else await waitFor(() => observer.terminals.length > 0 || Number.isFinite(clock.nextDueIn), 'a wait or the terminal report');
  }
  return { observer, connections };
}

describe('an uncoded refusal of a FETCH', () => {
  test('is retried on new connections and only then reported as a refusal', async () => {
    const { observer, connections } = await run('IMAP command failed: A0007 NO Request failed');
    expect(observer.terminals).toHaveLength(1);
    expect(observer.terminals[0]?.reason).toBe('fetch-refused');
    expect(connections.opens).toBeGreaterThan(1);
  });

  test('a refusal that names its cause is reported at once', async () => {
    const { observer, connections } = await run('IMAP command failed: A0007 NO [NONEXISTENT] no such mailbox');
    expect(observer.terminals[0]?.reason).toBe('mailbox-unreadable');
    expect(connections.opens).toBe(1);
  });
});
