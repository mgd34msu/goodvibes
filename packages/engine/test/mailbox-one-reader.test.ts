// Proves: Inbound mail is lost or announced twice across reconnect, restart mid-batch, mailbox reset, a poison message, or two daemons.
// Red when: The cursor advances before a message is recorded or a restart re-announces one, one unreadable message stops the drain, or both daemons sign in and read.
// Proves: A mail that arrives while the owner's notice channel is failing is never announced, or is forgotten at a restart.
// Red when: The delivery-failed outcome is not written to the record, so nothing is owed when the route returns.
// Proves: A mail whose handling keeps failing holds every later mail behind it, or is dropped with nothing recorded.
// Red when: The sink never sets a message aside after its attempts, or keeps its claim after a failed attempt.
/**
 * One mailbox, one reader: inbound notices and the inbox both get every
 * message from the same reader, exactly once, against a scripted IMAP server.
 *
 * The pieces are the real ones: the supervisor and IMAP watcher, the cursor
 * and record stores, the notice intake (one per daemon, as the daemon builds
 * it), the inbox owner and its SQLite mirror. Only the mail server, the clock
 * and the notice route are stand-ins, and screening runs in its local (no
 * decision model) mode so no model is involved. Where a case needs handling to
 * fail, the handler the supervisor is given throws for one subject.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes/engine/errors';
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
  type InboundMailboxMessage,
  type InboundMailNote,
} from '../platform/src/platform/email/inbound/index.ts';
import { holdProcessLock } from '../platform/src/platform/utils/process-lock.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { createEmailInboxOwner } from '../platform/src/platform/intake/providers/email-owner.ts';
import { acquireAccountInboxIdentity } from '../platform/src/platform/intake/providers/account-identity.ts';
import { createOwnedInboxSource, type OwnedInboxSource } from '../platform/src/platform/intake/registration.ts';
import { makeFakeMailbox, openMailboxSocket, type FakeMailboxOptions, type FakeMailboxServer } from './_helpers/fake-imap-mailbox.ts';
import { FakeClock, fixedRandom } from './_helpers/inbound-watcher-harness.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

const KEY = 'reader-key';
const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const ON = { 'surfaces.email.inbound.enabled': true, 'surfaces.email.inbound.source': 'imap' };

/** This machine's daemon settings, as a daemon reads them from its settings file. */
function daemonSettings(): ConfigManager {
  return new ConfigManager({ configDir: join(dir, 'config'), daemonTierPath: join(dir, 'daemon', 'settings.json'), ownsDaemonTier: true });
}

let dir: string;
let previousPort: ReturnType<typeof installJudgmentPort>;
let retirePolicy: () => void;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-one-reader-'));
  previousPort = installJudgmentPort(imapFixturePort().port);
  retirePolicy = configureDecisionModelPolicy(() => 'No Decision Model');
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
  // The owner turns inbound mail on, over IMAP.
  expect(daemonSettings().setMany(Object.entries(ON).map(([key, value]) => ({ key: key as ConfigKey, value })), localOwnerActor()).ok).toBe(true);
  const clock = new FakeClock();
  const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), { isAccountConfigured: () => true });
  const records = new InboundMailStore(join(dir, 'records.json'));
  const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'));
  const expectations = new InboundExpectationRegistry({ store: expectationStore });
  const housekeeper = new InboundMailHousekeeper({ cursors, records, expectations: expectationStore, disclosurePath: join(dir, 'housekeeping.json') });
  const notices: string[] = [];
  let holdNotice: { readonly subject: string; readonly reached: () => void; readonly release: Promise<void> } | null = null;
  /** The owner's notice channel; while `down` it refuses every notice as a transport failure. */
  const route = { down: false };
  const noticeRoute: Parameters<typeof createInboundMailIntake>[0]['notices'] = {
    resolveBinding: () => ({ kind: 'bound', binding: { id: 'binding-owner', surfaceKind: 'telegram' } }),
    send: async (notice) => {
      if (route.down) return { delivered: false, reason: 'delivery-failed', error: 'the notice channel is down' };
      const text = JSON.stringify(notice);
      const hold = holdNotice;
      if (hold !== null && text.includes(hold.subject)) { holdNotice = null; hold.reached(); await hold.release; }
      notices.push(text);
      return { delivered: true };
    },
  };
  /** How many more times handling throws for a subject. */
  const failHandling = new Map<string, number>();

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
  /** One daemon's reader and notice intake over this machine's stores; a restart starts with nothing in memory. */
  const daemon = () => {
    const intake = createInboundMailIntake({ expectations: expectations.matcher, records, notices: noticeRoute, noticeMode: () => 'all', now: () => new Date() });
    const handle = Object.assign(async (message: InboundMailboxMessage): Promise<void> => {
      const left = failHandling.get(message.subject) ?? 0;
      if (left > 0) {
        failHandling.set(message.subject, left - 1);
        throw new Error(`handling ${message.subject} failed`);
      }
      await intake(message);
    }, { takeSpentOutcome: (message: InboundMailboxMessage) => intake.takeSpentOutcome(message) });
    const supervisor: InboundMailSupervisor = new InboundMailSupervisor({
      config: daemonSettings(),
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
      handle,
      observer: { note: (note) => { notes.push(note); } },
      consumers: () => readers.consumers(KEY),
      readerLease: () => holdProcessLock(join(dir, 'reader.lock')),
    });
    const stop = async () => { await supervisor.stop(); intake.stop(); };
    cleanups.push(stop);
    return {
      // As the daemon does once its reader runs: notices held before a restart are still owed.
      async start() { await supervisor.start(); void intake.sendHeldNotices(); },
      stop,
      get status() { return supervisor.status; },
      whenQuiet: () => supervisor.whenQuiet(),
      nextQuiet: () => supervisor.nextQuiet(),
    };
  };
  const rows = () => inbox.mirror!.listItems({ providers: ['email'], limit: 1_000 });
  return {
    mailbox, clock, cursors, records, notices, notes, rows, daemon, route, failHandling,
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

/** A reader that says when the step a push or a clock move caused is done (see InboundMailSupervisor.nextQuiet). */
interface QuietReader { whenQuiet(): Promise<void>; nextQuiet(): Promise<void> }

/** Do `act` (a push, a dropped connection, a clock move) and return once the reader is quiet again: the step it caused is done. */
async function after(reader: QuietReader, act: () => unknown): Promise<void> {
  const quiet = reader.nextQuiet();
  await act();
  await quiet;
}

/** Move the fake clock to the reader's next scheduled wait (a reconnect backoff) and return once the step it caused is done. */
async function tick(reader: QuietReader, clock: FakeClock): Promise<void> {
  await after(reader, () => clock.advance(Math.max(1, clock.nextDueIn)));
}

const idleCount = (mailbox: FakeMailboxServer) => mailbox.commands.filter((line) => /^\S+ IDLE$/.test(line)).length;

test('every message reaches notices and the inbox exactly once across a reconnect, a restart mid-batch and a UIDVALIDITY change', async () => {
  const m = await machine({ initial: [
    { uid: 101, from: 'old@sender.test', subject: 'already here', deliveredTo: 'watched@example.test' },
  ] });
  const first = m.daemon();
  await first.start();
  // First run: the message already there is kept as history for the inbox and announced to nobody.
  await first.whenQuiet();
  expect(m.shown('already here')).toBe(1);
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(1);
  expect(m.announced('already here')).toBe(0);

  // Arriving while connected.
  await after(first, () => m.mailbox.deliver('live one'));
  expect(m.shown('live one')).toBe(1);

  // Arriving while the connection is down: found by the first drain after the reconnect.
  await after(first, () => {
    m.mailbox.dropConnections();
    m.mailbox.deliverQuietly('while down a');
    m.mailbox.deliverQuietly('while down b');
  });
  // Quiet in the reconnect backoff; moving the clock past it reconnects and drains.
  await tick(first, m.clock);
  expect([m.shown('while down a'), m.shown('while down b')]).toEqual([1, 1]);

  // A restart part-way through one batch: the daemon stops while the third
  // notice of five is being sent, and a new daemon takes over the same stores.
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(2);
  const held = m.holdNoticeFor('batch 3');
  for (const n of [1, 2, 3, 4, 5]) m.mailbox.deliverQuietly(`batch ${n}`);
  m.mailbox.push(`* ${m.mailbox.uids.length} EXISTS`);
  await held.at;
  const stopping = first.stop();
  held.release();
  await stopping;
  const second = m.daemon();
  await second.start();
  await second.whenQuiet();
  expect([1, 2, 3, 4, 5].map((n) => m.shown(`batch ${n}`))).toEqual([1, 1, 1, 1, 1]);

  // A UIDVALIDITY change: every stored row named the old generation; the inbox
  // now shows the mailbox under the new one, and nothing old is announced again.
  m.mailbox.setUidValidity(77);
  await after(second, () => m.mailbox.dropConnections());
  await tick(second, m.clock);
  expect(m.rows().length).toBeGreaterThan(0);
  expect(m.rows().filter((row) => !row.id.includes(':0000000077:'))).toEqual([]);
  await after(second, () => m.mailbox.deliver('after reset'));
  expect(m.shown('after reset')).toBe(1);

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
  await reader.whenQuiet();
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(1);
  m.mailbox.deliverQuietly('before');
  m.mailbox.deliverQuietly('unreadable');
  m.mailbox.deliverQuietly('after');
  await after(reader, () => m.mailbox.push('* 3 EXISTS'));
  // The unreadable message holds the cursor while it is read again after 0.5 and 1 second; the second miss steps over it.
  expect(m.clock.nextDueIn).toBe(500);
  await tick(reader, m.clock);
  expect(m.clock.nextDueIn).toBe(1_000);
  await tick(reader, m.clock);
  expect(m.shown('after')).toBe(1);

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
  await a.whenQuiet();
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(1);
  expect(a.status.running).toBe(true);
  expect(b.status.running).toBe(false);
  const logins = () => m.mailbox.commands.filter((line) => /^\S+ LOGIN /.test(line)).length;
  expect(logins()).toBe(1);

  await after(a, () => m.mailbox.deliver('to one reader'));
  expect(m.shown('to one reader')).toBe(1);

  // The holder stops; the other takes over and reads from where it left off.
  await a.stop();
  await b.start();
  await b.whenQuiet();
  expect(b.status.running).toBe(true);
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(2);
  await after(b, () => m.mailbox.deliver('after handover'));
  expect(m.shown('after handover')).toBe(1);

  expect(logins()).toBe(2);
  expect(m.announced('to one reader')).toBe(1);
  expect(m.announced('after handover')).toBe(1);
  expect(m.rows()).toHaveLength(2);
});

test('a mail that arrives while the notice channel is down is announced once when it works again, also across a restart', async () => {
  const m = await machine();
  const first = m.daemon();
  await first.start();
  await first.whenQuiet();
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(1);

  // The notice channel is down: the mail is read and recorded, the cursor passes it, nobody is told yet.
  m.route.down = true;
  await after(first, () => m.mailbox.deliver('during the outage'));
  expect(m.shown('during the outage')).toBe(1);
  expect((await m.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(101);
  expect(m.announced('during the outage')).toBe(0);

  // The daemon restarts while the channel is still down; nothing of the held notice is in memory any more.
  await first.stop();
  const second = m.daemon();
  await second.start();
  await second.whenQuiet();
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(2);
  expect(m.announced('during the outage')).toBe(0);

  // The channel works again and the next mail's notice gets through: the held one follows it.
  m.route.down = false;
  await after(second, () => m.mailbox.deliver('after the outage'));
  const held = (await m.records.list()).find((record) => record.subject === 'during the outage');
  expect(held?.noticeStatus).toBe('delivered');
  expect({ held: m.announced('during the outage'), after: m.announced('after the outage') }).toEqual({ held: 1, after: 1 });
});

test('a mail whose handling keeps failing is set aside and reported once, one that failed once is handled on the next pass, and the mail after them arrives', async () => {
  const m = await machine();
  m.failHandling.set('keeps failing', Number.POSITIVE_INFINITY);
  m.failHandling.set('fails once', 1);
  const reader = m.daemon();
  await reader.start();
  await reader.whenQuiet();
  expect(idleCount(m.mailbox)).toBeGreaterThanOrEqual(1);
  m.mailbox.deliverQuietly('keeps failing');
  m.mailbox.deliverQuietly('fails once');
  m.mailbox.deliverQuietly('after them');
  await after(reader, () => m.mailbox.push('* 3 EXISTS'));
  expect(m.shown('after them')).toBe(1);
  // The failing mail holds the cursor while its handling is retried after 0.5, 1 and 2 seconds; the third failure sets it aside.
  expect(m.clock.nextDueIn).toBe(500);
  await tick(reader, m.clock);
  expect(m.clock.nextDueIn).toBe(1_000);
  await tick(reader, m.clock);
  expect(m.clock.nextDueIn).toBe(2_000);
  await tick(reader, m.clock);
  expect((await m.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(103);

  expect({ failing: m.announced('keeps failing'), once: m.announced('fails once'), after: m.announced('after them') })
    .toEqual({ failing: 0, once: 1, after: 1 });
  // Recorded as set aside, and the owner told once.
  const setAside = (await m.records.list()).filter((record) => record.subject === 'keeps failing');
  expect(setAside.map((record) => record.noticeFailureReason?.startsWith('Set aside') ?? false)).toEqual([true]);
  expect(m.notes.filter((note) => note.detail.startsWith('set aside'))).toHaveLength(1);
});
