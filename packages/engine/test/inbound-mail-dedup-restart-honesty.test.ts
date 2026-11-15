/**
 * inbound-mail-dedup-restart-honesty.test.ts
 *
 * Three places in the tree used to assert that `dedupTtlMinutes` "must exceed a
 * restart cycle", that "an hour covers the auto-update restart", and that the
 * value "has a correctness floor". None of it was true, and no setting could
 * have made it true: `InboundMailSupervisor.runStart()` builds a brand new
 * `createInboundMailDedup(...)`, so a restart DESTROYS the cache rather than
 * expiring it, and `runStart()` runs on a config change and a cluster-gate
 * handoff as well as on a process restart.
 *
 * The live sequence that made it matter: UID 205 is announced, the daemon's
 * hourly auto-update restarts it before the cursor advance lands, the cursor is
 * still at 204, the message is fetched again into an empty cache, and the owner
 * is told a second time.
 *
 * What covers the restart is the mechanism below: the intake asks the record
 * store whether this exact message was already announced, and that store is on
 * disk. The failure direction is checked as carefully as the success one,
 * anything the store cannot answer leads to announcing, because §6's ruling is
 * that a duplicate beats silence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInboundMailIntake,
  InboundExpectationRegistry,
  InboundMailStore,
  PersistedExpectationStore,
} from '../platform/src/platform/email/inbound/index.ts';
import type { ImapInboundMessage } from '../platform/src/platform/email/inbound/ports.ts';

const NOW = new Date('2026-07-28T09:00:00.000Z');
const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-dedup-restart-'));
  dirs.push(dir);
  return dir;
}

function mail(uid = 205, overrides: Partial<ImapInboundMessage> = {}): ImapInboundMessage {
  return {
    source: 'imap',
    account: ACCOUNT,
    mailbox: MAILBOX,
    from: 'verify@service.test',
    subject: 'Confirm your account',
    claimedDate: 'Tue, 28 Jul 2026 08:59:00 +0000',
    messageId: `<${String(uid)}@service.test>`,
    deliveredTo: ['signup-9f31@his-catchall.test'],
    unverifiedToHeaderClaim: 'signup-9f31@his-catchall.test',
    uidValidity: 1000,
    uid,
    envelope: {} as ImapInboundMessage['envelope'],
    via: 'idle',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// What covers a restart: the record store
// ---------------------------------------------------------------------------

function intakeOver(store: InboundMailStore, dir: string, sent: unknown[]) {
  const expectationStore = new PersistedExpectationStore(join(dir, `expect-${String(sent.length)}-${String(Math.random())}.json`), {
    now: () => NOW,
  });
  return createInboundMailIntake({
    expectations: new InboundExpectationRegistry({ store: expectationStore, now: () => NOW }).matcher,
    records: store,
    notices: {
      resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
      send: async (notice) => { sent.push(notice); return { delivered: true }; },
    },
    noticeMode: () => 'all',
    now: () => NOW,
  });
}

describe('a message already announced is not announced again after a restart', () => {
  test('the second process sends nothing for a message its record says was delivered', async () => {
    const dir = scratch();
    const path = join(dir, 'records.json');

    // --- daemon run #1: announced, recorded, and then killed before the
    // cursor advance landed, which is why the message comes back at all.
    const first: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, first)(mail(205));
    expect(first).toHaveLength(1);

    // --- daemon run #2: a new process. New dedup cache, new intake, same
    // message above the same unadvanced cursor.
    const second: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, second)(mail(205));

    expect(second).toHaveLength(0);
    const stored = await new InboundMailStore(path, { now: () => NOW.getTime() }).list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.noticeStatus).toBe('delivered');
  });

  test('a record left at `pending` DOES get announced, because silence is the worse failure', async () => {
    // The safe direction, and the assertion that stops the guard turning into
    // a way to lose mail. A record that never reached `delivered` is not
    // evidence the owner was told, so the message is announced.
    const dir = scratch();
    const path = join(dir, 'records.json');
    const store = new InboundMailStore(path, { now: () => NOW.getTime() });
    await store.record({
      source: 'imap',
      account: ACCOUNT,
      mailbox: MAILBOX,
      uidValidity: 1000,
      uid: 205,
      senderDisplay: 'verify@service.test',
      subject: 'Confirm your account',
      deliveredToAddress: 'signup-9f31@his-catchall.test',
      deliveryEvidenceSource: 'delivered-to-header',
      links: [],
      outcome: 'no-expectation',
      noticeStatus: 'pending',
      body: '',
      receivedAt: NOW.toISOString(),
    });

    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, sent)(mail(205));
    expect(sent).toHaveLength(1);
    expect((await new InboundMailStore(path, { now: () => NOW.getTime() }).list())[0]!.noticeStatus).toBe('delivered');
  });

  test('a record file that cannot be read leads to announcing, not to silence', async () => {
    const dir = scratch();
    const path = join(dir, 'records.json');
    writeFileSync(path, '{ this is not json', 'utf-8');
    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, sent)(mail(205));
    expect(sent).toHaveLength(1);
  });

  test('a delivered record for a DIFFERENT mailbox does not suppress this one', async () => {
    // The key is scoped to the mailbox as well as the server-assigned id, and
    // a UID is only unique within its own UIDVALIDITY generation in its own
    // mailbox. A key that ignored either would let one mailbox silence another.
    const dir = scratch();
    const path = join(dir, 'records.json');
    const seed: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, seed)(
      mail(205, { mailbox: 'Archive' }),
    );
    expect(seed).toHaveLength(1);

    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, sent)(mail(205));
    expect(sent).toHaveLength(1);
    expect(await new InboundMailStore(path, { now: () => NOW.getTime() }).list()).toHaveLength(2);
  });

  test('a delivered record whose UIDVALIDITY generation changed does not suppress the new one', async () => {
    const dir = scratch();
    const path = join(dir, 'records.json');
    const seed: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, seed)(mail(205));
    expect(seed).toHaveLength(1);

    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path, { now: () => NOW.getTime() }), dir, sent)(
      mail(205, { uidValidity: 1001 }),
    );
    expect(sent).toHaveLength(1);
  });
});
