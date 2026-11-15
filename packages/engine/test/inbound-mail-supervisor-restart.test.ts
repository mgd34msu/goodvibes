/**
 * What the supervisor reports and does across a restart or a dead run loop.
 * Every source is a stand-in that records what it was asked to do.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  type InboundMailSourceFactory,
  type InboundMailSupervisorDeps,
} from '../platform/src/platform/email/inbound/index.ts';
import type { InboundMailSource, SourceLatency } from '../platform/src/platform/email/inbound/source.ts';
import type { InboundCapabilityVerdict } from '../platform/src/platform/email/inbound/ports.ts';

const T0 = new Date('2026-07-27T12:00:00.000Z');
const HEALTHY: InboundCapabilityVerdict = { state: 'healthy', reason: 'idle-push', detail: 'pushing', fix: '' };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-inbound-restart-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A source whose run loop ends by itself when `die()` is called. */
class Source implements InboundMailSource {
  readonly kind = 'imap' as const;
  readonly latency: SourceLatency = { kind: 'push' };
  recheckCalls = 0;
  private end: (() => void) | null = null;
  async start(): Promise<InboundCapabilityVerdict> { return HEALTHY; }
  run(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      this.end = resolve;
      signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
  }
  async stop(): Promise<void> {}
  recheckNow(): void { this.recheckCalls += 1; }
  die(): void { this.end?.(); }
}

function build(config: Record<string, unknown>, sources: InboundMailSourceFactory): InboundMailSupervisor {
  const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), { isAccountConfigured: () => true });
  const records = new InboundMailStore(join(dir, 'records.json'), { now: () => T0.getTime() });
  const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => T0 });
  const expectations = new InboundExpectationRegistry({ store: expectationStore, now: () => T0 });
  const housekeeper = new InboundMailHousekeeper({
    cursors, records, expectations: expectationStore, disclosurePath: join(dir, 'housekeeping.json'),
  });
  return new InboundMailSupervisor({
    config: { get: (key: string) => config[key] } as unknown as InboundMailSupervisorDeps['config'],
    reviveDelayMs: 0,
    account: 'primary',
    mailbox: 'INBOX',
    sources,
    selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
    cursors, records, expectations, expectationPolicy: expectationStore, housekeeper,
    handle: async () => {},
  });
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50_000 && !predicate(); i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
  if (!predicate()) throw new Error(`gave up waiting for ${what}`);
}

const ON = { 'surfaces.email.inbound.enabled': true, 'surfaces.email.inbound.source': 'imap' };

describe('a run loop that ended on its own', () => {
  test('is rebuilt by the next settings change instead of being asked to recheck', async () => {
    const made: Source[] = [];
    const supervisor = build({ ...ON }, { create: async () => { const s = new Source(); made.push(s); return s; } });
    await supervisor.start();
    expect(made).toHaveLength(1);

    made[0]?.die();
    await until(() => !supervisor.status.running, 'the loop end to be noticed');

    supervisor.recheckNow();
    await until(() => made.length === 2, 'a second source');
    await until(() => supervisor.status.running, 'the rebuilt source to run');
    expect(made[0]?.recheckCalls).toBe(0);
    await supervisor.stop();
  });

  test('a healthy running source is still only asked to recheck', async () => {
    const made: Source[] = [];
    const supervisor = build({ ...ON }, { create: async () => { const s = new Source(); made.push(s); return s; } });
    await supervisor.start();
    supervisor.recheckNow();
    expect(made).toHaveLength(1);
    expect(made[0]?.recheckCalls).toBe(1);
    await supervisor.stop();
  });
});

describe('a restart with inbound switched off', () => {
  test('does not keep reporting the previous run\'s capability, source or terminal failure', async () => {
    const config: Record<string, unknown> = { ...ON };
    const made: Source[] = [];
    const supervisor = build(config, { create: async () => { const s = new Source(); made.push(s); return s; } });
    await supervisor.start();
    made[0]?.die();
    await until(() => supervisor.terminalFailure !== null, 'the terminal failure');
    expect(supervisor.capability).not.toBeNull();

    config['surfaces.email.inbound.enabled'] = false;
    await supervisor.start();

    expect(supervisor.capability).toBeNull();
    expect(supervisor.terminalFailure).toBeNull();
    const snapshot = await supervisor.describeStatus();
    expect(snapshot.capability).toBeNull();
    expect(snapshot.source.kind).toBeNull();
    await supervisor.stop();
  });
});

describe('a change of the watched mailbox on a running source', () => {
  test('rebuilds the source so the factory can answer it, instead of being ignored', async () => {
    const config: Record<string, unknown> = { ...ON, 'surfaces.email.user': 'a@example.test' };
    const made: Source[] = [];
    const supervisor = build(config, { create: async () => { const s = new Source(); made.push(s); return s; } });
    await supervisor.start();

    config['surfaces.email.user'] = 'b@example.test';
    supervisor.recheckNow();
    await until(() => made.length === 2, 'a rebuild');
    expect(made[0]?.recheckCalls).toBe(0);
    await supervisor.stop();
  });

  test('rebuilds the source when the IMAP host changes, because the host decides which source an auto install picks', async () => {
    const config: Record<string, unknown> = { ...ON, 'surfaces.email.imap.host': 'imap.gmail.com' };
    const made: Source[] = [];
    const supervisor = build(config, { create: async () => { const s = new Source(); made.push(s); return s; } });
    await supervisor.start();

    config['surfaces.email.imap.host'] = 'mail.example.test';
    supervisor.recheckNow();
    await until(() => made.length === 2, 'a rebuild');
    expect(made[0]?.recheckCalls).toBe(0);
    await supervisor.stop();
  });
});
