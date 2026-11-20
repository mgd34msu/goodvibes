/**
 * The one mailbox reader (email/inbound/supervisor.ts over the IMAP watcher),
 * composed as daemon/facade-inbound-mail.ts composes it, against a scripted
 * IMAP server on loopback: the stores are the real ones under the isolated
 * home; only the mail server, the watcher's clock and the notice route are
 * stand-ins. Measured: one wake of the held IDLE connection with nothing new.
 */
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  createInboundMailIntake,
  imapMailboxConnectionPort,
  ImapMailSource,
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  resolveWatcherSettings,
  type InboundMailSupervisorDeps,
} from '../../../platform/src/platform/email/inbound/index.ts';
import { holdProcessLock } from '../../../platform/src/platform/utils/process-lock.ts';
import { imapFixturePort } from '../../../test/_helpers/imap-semantic-port.ts';
import { makeFakeMailbox, openMailboxSocket, type FakeMailboxServer } from '../../../test/_helpers/fake-imap-mailbox.ts';
import { FakeClock, fixedRandom } from '../../../test/_helpers/inbound-watcher-harness.ts';
import { countingPort } from '../fakes.ts';
import { allowFixturePort } from '../instrument.ts';
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';

const P = 'packages/engine/platform/src/platform';
const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const SETTINGS: Readonly<Record<string, unknown>> = { 'surfaces.email.inbound.enabled': true, 'surfaces.email.inbound.source': 'imap' };
/** Waits shorter than this are moved on the watcher's clock while waiting for it (a reconnect backoff); the IDLE re-issue timer never is. */
const SHORT_WAIT_MS = 60_000;

const idles = (server: FakeMailboxServer): number => server.commands.filter((line) => /^\S+ IDLE$/.test(line)).length;

/** Socket turns until `done`, moving only short waits on the watcher's clock. Bounded in steps, never in milliseconds. */
async function until(clock: FakeClock, done: () => boolean, what: string): Promise<void> {
  for (let step = 0; step < 40_000; step++) {
    if (done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    if (step % 200 === 199 && clock.pending > 0 && clock.nextDueIn < SHORT_WAIT_MS) await clock.advance(Math.max(1, clock.nextDueIn));
  }
  if (!done()) throw new Error(`gave up waiting for ${what}`);
}

const mailboxPoll: Scenario = {
  name: 'mailbox-poll-nothing-new',
  drives: 'The mailbox reader idling on its held IMAP connection is woken by the server (`* n EXISTS` with the same count) and reads the mailbox above its cursor: nothing new. Counted at the server: commands, LOGINs and new connections during the wake; on disk: writes (the cursor must not be rewritten).',
  entries: [`${P}/email/inbound/supervisor.ts InboundMailSupervisor`, `${P}/email/inbound/idle-watcher.ts (wake on EXISTS, DONE, drain, IDLE again)`, `${P}/email/inbound/poll-loop.ts (UID SEARCH above the cursor)`, `${P}/daemon/facade-inbound-mail.ts (product composition)`],
  async setup(env: MeasureEnv): Promise<Instance> {
    const restorePort = installJudgmentPort(countingPort(imapFixturePort().port));
    const server = await makeFakeMailbox({ initial: [{ uid: 101, from: 'old@sender.test', subject: 'already here', deliveredTo: 'watched@example.test' }] });
    allowFixturePort(server.port);
    const dir = join(env.home, '.goodvibes', 'daemon');
    const clock = new FakeClock();
    const cursors = new MailboxCursorStore(join(dir, 'email-inbound-cursors.json'), { isAccountConfigured: () => true });
    const records = new InboundMailStore(join(dir, 'email-inbound-records.json'));
    const expectationStore = new PersistedExpectationStore(join(dir, 'email-inbound-expectations.json'));
    const expectations = new InboundExpectationRegistry({ store: expectationStore });
    const housekeeper = new InboundMailHousekeeper({ cursors, records, expectations: expectationStore, disclosurePath: join(dir, 'email-inbound-housekeeping.json') });
    const notices: string[] = [];
    const intake = createInboundMailIntake({
      expectations: expectations.matcher, records,
      notices: { resolveBinding: () => ({ kind: 'bound', binding: { id: 'measure-telegram', surfaceKind: 'telegram' } }), send: async (notice) => { notices.push(JSON.stringify(notice)); return { delivered: true }; } },
      noticeMode: () => 'all', now: () => new Date(),
    });
    const supervisor = new InboundMailSupervisor({
      config: { get: (key: string) => SETTINGS[key] } as unknown as InboundMailSupervisorDeps['config'],
      reviveDelayMs: 0, leaseRetryMs: 3_600_000, account: ACCOUNT, mailbox: MAILBOX,
      sources: { create: async (input) => new ImapMailSource({
        settings: resolveWatcherSettings({ account: input.account, mailbox: input.mailbox }),
        connections: imapMailboxConnectionPort({ connect: () => openMailboxSocket(server.port), username: 'watched@example.test', password: 'an-app-password', mailbox: MAILBOX, timeoutMs: 2_000 }),
        cursors, sink: input.sink, clock, random: fixedRandom(0.5), observer: input.observer,
      }) },
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors, records, expectations, expectationPolicy: expectationStore, housekeeper, handle: intake,
      consumers: () => [],
      readerLease: () => holdProcessLock(join(dir, 'email-inbound-reader.lock')),
    });
    await supervisor.start();
    await until(clock, () => idles(server) >= 1, 'the reader to sign in, establish its cursor and IDLE');
    let before = { commands: 0, connections: 0, idles: 0 };
    let cursorBefore = '';
    return {
      async prepare() {
        before = { commands: server.commands.length, connections: server.connectionCount, idles: idles(server) };
        cursorBefore = JSON.stringify(await cursors.get(ACCOUNT, MAILBOX));
      },
      async op() {
        server.push(`* ${server.uids.length} EXISTS`);
        await until(clock, () => idles(server) > before.idles, 'the reader to read the mailbox and IDLE again');
        const sent = server.commands.slice(before.commands);
        const imapLogins = sent.filter((line) => /^\S+ LOGIN /.test(line)).length;
        const imapConnections = server.connectionCount - before.connections;
        assertOutcome(imapLogins === 0 && imapConnections === 0, `the wake signed in again: ${imapLogins} LOGIN, ${imapConnections} new connections`);
        assertOutcome(sent.some((line) => /^\S+ UID SEARCH /.test(line)), `the wake did not read the mailbox: ${sent.join(' | ')}`);
        return { imapCommands: sent.length, imapLogins, imapConnections };
      },
      async verify() {
        const cursor = JSON.stringify(await cursors.get(ACCOUNT, MAILBOX));
        assertOutcome(cursor === cursorBefore, `the cursor moved with nothing new: ${cursorBefore} -> ${cursor}`);
        assertOutcome(notices.length === 0, `${notices.length} notices were sent for a mailbox with nothing new`);
        assertOutcome(supervisor.status.running, 'the reader stopped');
      },
      async dispose() { await supervisor.stop(); server.close(); installJudgmentPort(restorePort); },
    };
  },
};

export const scenarios: Scenario[] = [mailboxPoll];
