/**
 * One mailbox, one reader: inbound notices and the inbox both get every
 * message from the same reader, exactly once, against a scripted IMAP server.
 *
 * The pieces are the real ones: the supervisor and IMAP watcher, the cursor
 * and record stores, the notice intake, the inbox owner and its SQLite mirror.
 * Only the mail server, the clock and the notice route are stand-ins, and
 * screening runs in its local (Classic) mode so no model is involved.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { imapFixturePort } from './_helpers/imap-semantic-port.ts';
import {
  createInboundMailIntake,
  imapMailboxConnectionPort,
  ImapMailSource,
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  MailboxReaders,
  PersistedExpectationStore,
  resolveWatcherSettings,
  type InboundMailNote,
  type InboundMailSupervisorDeps,
} from '../platform/src/platform/email/inbound/index.ts';
import { holdProcessLock } from '../platform/src/platform/utils/process-lock.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { createEmailInboxOwner } from '../platform/src/platform/intake/providers/email-owner.ts';
import { acquireAccountInboxIdentity } from '../platform/src/platform/intake/providers/account-identity.ts';
import { createOwnedInboxSource, type OwnedInboxSource } from '../platform/src/platform/intake/registration.ts';
import { makeFakeMailbox, openMailboxSocket, type FakeMailboxOptions, type FakeMailboxServer } from './_helpers/fake-imap-mailbox.ts';
import { FakeClock, fixedRandom } from './_helpers/inbound-watcher-harness.ts';

const KEY = 'reader-key';
const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const ON = { 'surfaces.email.inbound.enabled': true, 'surfaces.email.inbound.source': 'imap' };

let dir: string;
let previousPort: ReturnType<typeof installJudgmentPort>;
let retirePolicy: () => void;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-one-reader-'));
  previousPort = installJudgmentPort(imapFixturePort().port);
  retirePolicy = configureDecisionModelPolicy(() => 'Classic - Off');
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  retirePolicy();
  installJudgmentPort(previousPort);
  rmSync(dir, { recursive: true, force: true });
});

/** Everything one machine shares: the server, the stores, the inbox and what the notice route was asked to send. */
async function machine(server: FakeMailboxOptions = {}) {
  const mailbox = await makeFakeMailbox(server);
  cleanups.push(() => mailbox.close());
  const clock = new FakeClock();
  const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), { isAccountConfigured: () => true });
  const records = new InboundMailStore(join(dir, 'records.json'));
  const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'));
  const expectations = new InboundExpectationRegistry({ store: expectationStore });
  const housekeeper = new InboundMailHousekeeper({ cursors, records, expectations: expectationStore, disclosurePath: join(dir, 'housekeeping.json') });
  const notices: string[] = [];
  let holdNotice: { readonly subject: string; readonly reached: () => void; readonly release: Promise<void> } | null = null;
  const intake = createInboundMailIntake({
    expectations: expectations.matcher,
    records,
    notices: {
      resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
      send: async (notice) => {
        const text = JSON.stringify(notice);
        const hold = holdNotice;
        if (hold !== null && text.includes(hold.subject)) { holdNotice = null; hold.reached(); await hold.release; }
        notices.push(text);
        return { delivered: true };
      },
    },
    noticeMode: () => 'all',
    now: () => new Date(),
  });

  // The inbox: its owner, its own SQLite mirror, attached to the reader by key.
  const account = { host: 'imap.example.test', port: 993, username: 'watched@example.test', mailbox: MAILBOX, security: 'tls' as const };
  const identity = await acquireAccountInboxIdentity({ workingDirectory: dir, assertCurrent() {} }, { provider: 'email', account });
  const authority = new AbortController();
  const owner = createEmailInboxOwner({ identity, account, assertCurrent() {},
    screening: { authority: { ownerId: 'fixture-local-services', revision: '1', retention: 'ephemeral-no-log', signal: authority.signal, assertCurrent() {} },
      proposal: { endpoint: 'http://127.0.0.1:9', model: 'fixture-proposer' },
      judgment: { endpoint: 'http://127.0.0.1:9', model: 'jev-1.13.0' }, timeoutMs: 500 } });
  const inbox: OwnedInboxSource = createOwnedInboxSource({ workingDirectory: dir, logger: { info() {}, warn() {}, error() {} } }, {
    adapters: new Map([['email', owner.adapter]]), storeFileName: 'inbox-email-test.sqlite',
    acquireReadLease: () => owner.acquireReadLease(),
  });
  await inbox.ready;
  cleanups.push(async () => { await inbox.close(); await owner.close(); });
  const readers = new MailboxReaders();
  readers.attach(KEY, owner.consumer, { requestHistory: owner.needsHistory() });

  const notes: InboundMailNote[] = [];
  /** One daemon's reader over this machine's stores. */
  const daemon = (): InboundMailSupervisor => {
    const supervisor = new InboundMailSupervisor({
      config: { get: (key: string) => (ON as Record<string, unknown>)[key] } as unknown as InboundMailSupervisorDeps['config'],
      reviveDelayMs: 0,
      leaseRetryMs: 3_600_000,
      account: ACCOUNT,
      mailbox: MAILBOX,
      sources: { create: async (input) => new ImapMailSource({
        settings: resolveWatcherSettings({ account: input.account, mailbox: input.mailbox }),
        connections: imapMailboxConnectionPort({
          connect: () => openMailboxSocket(mailbox.port), username: account.username, password: 'an-app-password', mailbox: MAILBOX, timeoutMs: 2_000,
        }),
        cursors, sink: input.sink, clock, random: fixedRandom(0.5), observer: input.observer,
      }) },
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors, records, expectations, expectationPolicy: expectationStore, housekeeper,
      handle: intake,
      observer: { note: (note) => { notes.push(note); } },
      consumers: () => readers.consumers(KEY),
      readerLease: () => holdProcessLock(join(dir, 'reader.lock')),
    });
    cleanups.push(() => supervisor.stop());
    return supervisor;
  };
  const rows = () => inbox.mirror!.listItems({ providers: ['email'], limit: 1_000 });
  return {
    mailbox, clock, cursors, notices, notes, rows, daemon,
    /** How many notices named this subject. */
    announced: (subject: string) => notices.filter((text) => text.includes(subject)).length,
    /** How many inbox rows show this subject. */
    shown: (subject: string) => rows().filter((row) => row.subjectPreview === subject).length,
    holdNoticeFor(subject: string) {
      let reached!: () => void, release!: () => void;
      const at = new Promise<void>((resolve) => { reached = resolve; });
      holdNotice = { subject, reached, release: new Promise<void>((resolve) => { release = resolve; }) };
      return { at, release };
    },
  };
}

/**
 * Let the reader run: real socket turns, and the fake clock moved to the next
 * scheduled wait (a reconnect backoff, an IDLE re-issue) whenever nothing else
 * is moving. Bounded in steps, never in milliseconds.
 */
async function pump(clock: FakeClock, done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let step = 0; step < 40_000; step += 1) {
    if (await done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    // Scheduled waits are moved only after the sockets have had their turns.
    if (step % 200 === 199 && clock.pending > 0) await clock.advance(Math.max(1, clock.nextDueIn));
  }
  if (!await done()) throw new Error(`Gave up waiting for: ${what}`);
}

const idleCount = (mailbox: FakeMailboxServer) => mailbox.commands.filter((line) => /^\S+ IDLE$/.test(line)).length;

test('every message reaches notices and the inbox exactly once across a reconnect, a restart mid-batch and a UIDVALIDITY change', async () => {
  const m = await machine({ initial: [
    { uid: 101, from: 'old@sender.test', subject: 'already here', deliveredTo: 'watched@example.test' },
  ] });
  const first = m.daemon();
  await first.start();
  // First run: the message already there is kept as history for the inbox and announced to nobody.
  await pump(m.clock, () => m.shown('already here') === 1 && idleCount(m.mailbox) >= 1, 'the history window and IDLE');
  expect(m.announced('already here')).toBe(0);

  // Arriving while connected.
  m.mailbox.deliver('live one');
  await pump(m.clock, () => m.shown('live one') === 1, 'live mail');

  // Arriving while the connection is down: found by the first drain after the reconnect.
  m.mailbox.dropConnections();
  m.mailbox.deliverQuietly('while down a');
  m.mailbox.deliverQuietly('while down b');
  await pump(m.clock, () => m.shown('while down a') === 1 && m.shown('while down b') === 1, 'mail from while the connection was down');

  // A restart part-way through one batch: the daemon stops while the third
  // notice of five is being sent, and a new daemon takes over the same stores.
  await pump(m.clock, () => idleCount(m.mailbox) >= 2, 'IDLE after the reconnect');
  const held = m.holdNoticeFor('batch 3');
  for (const n of [1, 2, 3, 4, 5]) m.mailbox.deliverQuietly(`batch ${n}`);
  m.mailbox.push(`* ${m.mailbox.uids.length} EXISTS`);
  await held.at;
  const stopping = first.stop();
  held.release();
  await stopping;
  const second = m.daemon();
  await second.start();
  await pump(m.clock, () => [1, 2, 3, 4, 5].every((n) => m.shown(`batch ${n}`) === 1), 'the whole batch after the restart');

  // A UIDVALIDITY change: every stored row named the old generation; the inbox
  // now shows the mailbox under the new one, and nothing old is announced again.
  m.mailbox.setUidValidity(77);
  m.mailbox.dropConnections();
  await pump(m.clock, () => m.rows().length > 0 && m.rows().every((row) => row.id.includes(':0000000077:')), 'the new generation');
  m.mailbox.deliver('after reset');
  await pump(m.clock, () => m.shown('after reset') === 1, 'mail after the reset');

  const announcedOnce = ['live one', 'while down a', 'while down b', 'batch 1', 'batch 2', 'batch 3', 'batch 4', 'batch 5', 'after reset'];
  for (const subject of announcedOnce) expect({ subject, notices: m.announced(subject) }).toEqual({ subject, notices: 1 });
  expect(m.announced('already here')).toBe(0);
  for (const subject of ['already here', ...announcedOnce]) expect({ subject, rows: m.shown(subject) }).toEqual({ subject, rows: 1 });
  expect(m.rows()).toHaveLength(m.mailbox.uids.length);
  expect(new Set(m.rows().map((row) => row.id)).size).toBe(m.rows().length);
  expect((await m.cursors.get(ACCOUNT, MAILBOX))?.uidValidity).toBe(77);
});

test('an unreadable message is stepped over and reported, and the messages after it still arrive', async () => {
  // UIDs start at 101; the server never answers readably for 102.
  const m = await machine({ unreadableUids: [102] });
  const reader = m.daemon();
  await reader.start();
  await pump(m.clock, () => idleCount(m.mailbox) >= 1, 'IDLE');
  m.mailbox.deliverQuietly('before');
  m.mailbox.deliverQuietly('unreadable');
  m.mailbox.deliverQuietly('after');
  m.mailbox.push('* 3 EXISTS');
  await pump(m.clock, async () => m.shown('after') === 1 && (await m.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid === 103,
    'the message after the unreadable one, and the cursor past it');

  expect(m.announced('before')).toBe(1);
  expect(m.announced('after')).toBe(1);
  // Reported: the reader's own note, and a row in the inbox saying it exists.
  expect(m.notes.some((note) => note.kind === 'message-stepped-over')).toBe(true);
  const ids = m.rows().map((row) => row.id);
  expect(ids.some((id) => id.endsWith(':0000000102'))).toBe(true);
  expect(m.rows()).toHaveLength(3);
  expect((await m.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(103);
});

test('with two daemons for the same account only one signs in and reads', async () => {
  const m = await machine();
  const a = m.daemon();
  const b = m.daemon();
  await a.start();
  await b.start();
  await pump(m.clock, () => idleCount(m.mailbox) >= 1, 'the first daemon in IDLE');
  expect(a.status.running).toBe(true);
  expect(b.status.running).toBe(false);
  const logins = () => m.mailbox.commands.filter((line) => /^\S+ LOGIN /.test(line)).length;
  expect(logins()).toBe(1);

  m.mailbox.deliver('to one reader');
  await pump(m.clock, () => m.shown('to one reader') === 1, 'mail through the one reader');

  // The holder stops; the other takes over and reads from where it left off.
  await a.stop();
  await b.start();
  await pump(m.clock, () => b.status.running && idleCount(m.mailbox) >= 2, 'the second daemon in IDLE');
  m.mailbox.deliver('after handover');
  await pump(m.clock, () => m.shown('after handover') === 1, 'mail after the handover');

  expect(logins()).toBe(2);
  expect(m.announced('to one reader')).toBe(1);
  expect(m.announced('after handover')).toBe(1);
  expect(m.rows()).toHaveLength(2);
});
