/**
 * control-plane-compositions-hardening.test.ts
 *
 * Compositions that decide, once or per call, which backend or which record a
 * verb uses: the calendar backend, the mail send path and its taint check, the
 * cost-ingest binding, the pre-split store sweep and the contract coverage
 * count. Each case uses an in-memory seam; nothing opens a socket.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOccasionCalendarMirror } from '../platform/src/platform/control-plane/routes/occasions-composition.ts';
import type { Occasion } from '../platform/src/platform/occasions/types.ts';
import { createDaemonCalendarGatewayService } from '../platform/src/platform/control-plane/routes/calendar-composition.ts';
import {
  createServiceBackedGateway,
  registerDaemonEmailVerbs,
} from '../platform/src/platform/control-plane/routes/email-composition.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import { bindCostAttributionIngest } from '../platform/src/platform/control-plane/routes/attribution-ingest.ts';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.ts';
import { PRE_SPLIT_QUARANTINE_PREFIX, sweepPreSplitControlPlaneStore } from '../platform/src/platform/control-plane/pre-split-control-plane-sweep.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { mailFixture } from './_helpers/mail-subject-source.ts';

const context = { principalId: 'op-1', admin: true } as const;

// ── calendar backend is chosen per call ─────────────────────────────────────

describe('the calendar backend follows the settings without a restart', () => {
  test('CalDAV keys entered after the daemon started are used by the next call', async () => {
    const values: Record<string, unknown> = {};
    const requests: string[] = [];
    const service = createDaemonCalendarGatewayService({
      configManager: {
        get: (key) => {
          const name = key as unknown as string;
          if (!(name in values)) throw new Error(`Invalid config path: ${name}`);
          return values[name];
        },
      },
      secretsManager: { get: async (key: string) => (key === 'GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD' ? 'hunter2' : null) },
      homeDirectory: mkdtempSync(join(tmpdir(), 'cal-home-')),
      caldavHttp: { request: async (input) => { requests.push(input.url); throw new Error('stop after the first request'); } },
    });
    expect(service).not.toBeNull();

    values['surfaces.calendar.caldavUrl'] = 'https://dav.example.com/cal/avery/';
    values['surfaces.calendar.caldavUser'] = 'avery';
    values['surfaces.calendar.caldavPassword'] = 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD';
    await service!.listEvents({}).catch(() => undefined);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]).toContain('dav.example.com');
  });

  test('with no home directory and no CalDAV server the verbs stay unregistered', () => {
    const service = createDaemonCalendarGatewayService({
      configManager: { get: () => { throw new Error('absent'); } },
      secretsManager: { get: async () => null },
    });
    expect(service).toBeNull();
  });

  test('a CalDAV server removed from the settings stops being used and says what to set', async () => {
    const values: Record<string, unknown> = {
      'surfaces.calendar.caldavUrl': 'https://dav.example.com/cal/avery/',
      'surfaces.calendar.caldavUser': 'avery',
    };
    const service = createDaemonCalendarGatewayService({
      configManager: { get: (key) => values[key as unknown as string] },
      secretsManager: { get: async () => null },
      caldavHttp: { request: async () => { throw new Error('unreachable'); } },
    });
    expect(service).not.toBeNull();
    values['surfaces.calendar.caldavUrl'] = '';
    const error = await service!.listEvents({}).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayVerbError);
    expect((error as GatewayVerbError).code).toBe('CALENDAR_NOT_CONFIGURED');
  });
});

// ── mail send ───────────────────────────────────────────────────────────────

describe('email.send', () => {
  test('a reply hands its inReplyTo to the mail service so the message is threaded', async () => {
    const sent: Array<{ inReplyTo?: string }> = [];
    const gateway = createServiceBackedGateway({ sendMail: async (input: { inReplyTo?: string }) => { sent.push(input); return { messageId: 'm', sentAt: 1 }; } } as never);
    await gateway.send({ to: 'a@example.com', subject: 'Re: hi', body: 'ok', inReplyTo: '<id@example.com>' });
    expect(sent.map((input) => input.inReplyTo)).toEqual(['<id@example.com>']);
  });

  test('a send without inReplyTo still goes through', async () => {
    const sent: unknown[] = [];
    const gateway = createServiceBackedGateway({ sendMail: async (input: unknown) => { sent.push(input); return { messageId: 'm', sentAt: 1 }; } } as never);
    await gateway.send({ to: 'a@example.com', subject: 'hi', body: 'ok' });
    expect(sent).toHaveLength(1);
  });

  function daemon(ledger: UntrustedContentLedger, config: Record<string, unknown>) {
    const mail = mailFixture({
      plans: [{}],
      overrides: { smtpSocketFactory: async () => { throw new Error('no smtp in this test'); } },
    });
    const catalog = new GatewayMethodCatalog();
    registerDaemonEmailVerbs(catalog, {
      emailServiceDeps: mail.deps,
      untrustedContentLedger: ledger,
      configManager: { get: (key: never) => config[key as unknown as string] },
    });
    return catalog;
  }

  /** A send to `to`; the recipient is checked by exact containment in what was read. */
  async function sendAfterReading(
    catalog: GatewayMethodCatalog,
    to: string,
  ): Promise<{ status?: number; code?: string } | null> {
    try {
      await catalog.invoke('email.send', { context, body: { to, subject: 'hello', body: 'fine', confirm: true } });
      return null;
    } catch (error) {
      return error as { status?: number; code?: string };
    }
  }

  test('the taint check sees what the mailbox read recorded into the supplied ledger', async () => {
    const ledger = new UntrustedContentLedger();
    const catalog = daemon(ledger, {});
    await catalog.invoke('email.inbox.read', { context, query: { uid: '42' } });
    expect(ledger.hasIngestedThisTurn()).toBe(true);
    // An ingest with no retained text is the coarse case: any outward send is refused until the owner reviews it.
    ledger.record({ surface: 'email', origin: 'email:example.invalid (claimed)', at: new Date(0).toISOString() });
    const refused = await sendAfterReading(catalog, 'friend@example.invalid');
    expect(refused?.code).toBe('UNTRUSTED_CONTENT_DERIVED');
    expect(refused?.status).toBe(403);
  });

  test('the owner addresses are read at each send, so a changed setting takes effect at once', async () => {
    const ledger = new UntrustedContentLedger();
    const config: Record<string, unknown> = { 'surfaces.email.from': 'someone-else@example.invalid' };
    const catalog = daemon(ledger, config);
    ledger.record({ surface: 'email', origin: 'email:example.invalid (claimed)', at: new Date(0).toISOString() });
    expect((await sendAfterReading(catalog, 'friend@example.invalid'))?.code).toBe('UNTRUSTED_CONTENT_DERIVED');

    config['surfaces.email.from'] = 'friend@example.invalid';
    // Now exempt as the owner's own address: it gets past the taint check and
    // fails later, at the transport, instead of being refused as tainted.
    expect((await sendAfterReading(catalog, 'friend@example.invalid'))?.code).not.toBe('UNTRUSTED_CONTENT_DERIVED');

    config['surfaces.email.from'] = 'someone-else@example.invalid';
    expect((await sendAfterReading(catalog, 'friend@example.invalid'))?.code).toBe('UNTRUSTED_CONTENT_DERIVED');
  });
});

// ── cost ingest ─────────────────────────────────────────────────────────────

describe('bindCostAttributionIngest', () => {
  function turnEvent() {
    return {
      type: 'LLM_RESPONSE_RECEIVED', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1,
    };
  }

  test('binding twice on one bus records each response once, and the returned function unbinds', () => {
    const listeners = new Map<string, Set<(envelope: unknown) => void>>();
    const bus = {
      onDomain(domain: string, callback: (envelope: unknown) => void) {
        const set = listeners.get(domain) ?? new Set();
        set.add(callback);
        listeners.set(domain, set);
        return () => { set.delete(callback); };
      },
    };
    const recorded: unknown[] = [];
    const cost = { record: (entry: unknown) => { recorded.push(entry); } };
    const quota = { record: () => {} };
    bindCostAttributionIngest(bus as never, cost as never, quota as never);
    const unbind = bindCostAttributionIngest(bus as never, cost as never, quota as never);
    for (const callback of listeners.get('turn') ?? []) callback({ payload: turnEvent(), sessionId: 's' });
    expect(recorded).toHaveLength(1);

    unbind();
    for (const callback of listeners.get('turn') ?? []) callback({ payload: turnEvent(), sessionId: 's' });
    expect(recorded).toHaveLength(1);
  });

  test('the real bus accepts the binding and hands back its unsubscribe', () => {
    const bus = new RuntimeEventBus();
    const unbind = bindCostAttributionIngest(bus, { record: () => {} } as never, { record: () => {} } as never);
    expect(typeof unbind).toBe('function');
    unbind();
  });
});

// ── pre-split sweep ─────────────────────────────────────────────────────────

describe('the pre-split store sweep', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function layout() {
    const home = mkdtempSync(join(tmpdir(), 'presplit-'));
    dirs.push(home);
    const legacy = join(home, '.goodvibes', 'control-plane');
    const scoped = join(home, '.goodvibes', 'tui', 'control-plane');
    mkdirSync(legacy, { recursive: true });
    return { home, legacy, scoped };
  }

  test('an adoptable legacy file arrives whole, the old name is gone, and the scoped copy is never replaced', async () => {
    const { legacy, scoped } = layout();
    writeFileSync(join(legacy, 'occasions-state.json'), '{"v":1}');
    const report = await sweepPreSplitControlPlaneStore({ legacyDirectory: legacy, scopedDirectory: scoped });
    expect(report.status).toBe('swept');
    expect(report.adoptedFiles).toContain('occasions-state.json');
    expect(readFileSync(join(scoped, 'occasions-state.json'), 'utf8')).toBe('{"v":1}');
    expect(existsSync(join(legacy, 'occasions-state.json'))).toBe(false);
  });

  test('a file in both places with different content is left alone in both and reported as conflicted', async () => {
    const { legacy, scoped } = layout();
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(legacy, 'occasions-state.json'), '{"v":"old"}');
    writeFileSync(join(scoped, 'occasions-state.json'), '{"v":"new"}');
    const report = await sweepPreSplitControlPlaneStore({ legacyDirectory: legacy, scopedDirectory: scoped });
    expect(report.status).toBe('conflicted');
    expect(readFileSync(join(scoped, 'occasions-state.json'), 'utf8')).toBe('{"v":"new"}');
    expect(readFileSync(join(legacy, 'occasions-state.json'), 'utf8')).toBe('{"v":"old"}');
  });

  test('a pass that could not retire a redundant file is incomplete, not clean', async () => {
    const { legacy, scoped } = layout();
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(legacy, 'occasions-state.json'), '{"v":1}');
    writeFileSync(join(scoped, 'occasions-state.json'), '{"v":1}');
    // A regular file where the quarantine directory has to be made.
    const now = 1_700_000_000_000;
    const pid = 4242;
    writeFileSync(join(legacy, '..', `${PRE_SPLIT_QUARANTINE_PREFIX}${String(now)}-${String(pid)}`), 'in the way');
    const report = await sweepPreSplitControlPlaneStore({ legacyDirectory: legacy, scopedDirectory: scoped, now, pid });
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.status).toBe('incomplete');
    expect(existsSync(join(legacy, 'occasions-state.json'))).toBe(true);
  });
});

// ── operator contract coverage ──────────────────────────────────────────────

describe('the operator contract coverage count', () => {
  test('a method with no schemas is counted as generic, not typed', async () => {
    const { buildOperatorContract } = await import('../platform/src/platform/control-plane/operator-contract.ts');
    const catalog = new GatewayMethodCatalog();
    const before = buildOperatorContract(catalog).operator.schemaCoverage;
    catalog.register({
      id: 'test.schemaless', title: 'Schemaless', description: 'A method with no schemas at all.',
      category: 'test', access: 'public', scopes: [], transport: ['ws'],
    } as never);
    const after = buildOperatorContract(catalog).operator.schemaCoverage;
    expect(after.methods).toBe(before.methods + 1);
    expect(after.genericInputs).toBe(before.genericInputs + 1);
    expect(after.genericOutputs).toBe(before.genericOutputs + 1);
  });
});

describe('occasions.calendarMirror writes to the connected calendar', () => {
  const occasion = { id: 'mums-birthday', title: "Mum's birthday", person: 'Mum', kind: 'birthday' } as unknown as Occasion;

  test('an occurrence becomes one all-day event carrying only its title', async () => {
    const created: unknown[] = [];
    const mirror = createOccasionCalendarMirror({
      createEvent: async (input) => { created.push(input); return { eventId: 'evt-1', uid: 'u', createdAt: 't' }; },
    });
    const id = await mirror.mirror({ occasion, occurrence: '2026-12-31' });
    expect(id).toBe('evt-1');
    expect(created).toEqual([{ title: "Mum's birthday", start: '2026-12-31', end: '2027-01-01' }]);
  });

  test('an occurrence that already has an external id is not written again', async () => {
    let calls = 0;
    const mirror = createOccasionCalendarMirror({
      createEvent: async () => { calls += 1; return { eventId: 'evt-2', uid: 'u', createdAt: 't' }; },
    });
    expect(await mirror.mirror({ occasion, occurrence: '2026-12-31', existingExternalId: 'evt-1' })).toBe('evt-1');
    expect(calls).toBe(0);
  });
});
