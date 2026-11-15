/**
 * A message announced once keeps saying so when it is handed over again.
 * The redelivery arrives after the expectation it matched was spent, so a
 * rewrite of the record from that pass would describe it as unmatched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
const ALIAS = 'signup-9f31@his-catchall.test';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function message(): ImapInboundMessage {
  return {
    source: 'imap',
    account: 'primary',
    mailbox: 'INBOX',
    from: 'verify@service.test',
    subject: 'Confirm your account',
    claimedDate: 'Tue, 28 Jul 2026 08:59:00 +0000',
    messageId: '<205@service.test>',
    deliveredTo: [ALIAS],
    unverifiedToHeaderClaim: ALIAS,
    uidValidity: 1000,
    uid: 205,
    envelope: {} as ImapInboundMessage['envelope'],
    via: 'idle',
  };
}

describe('a redelivery after the notice went out', () => {
  test('under expected-only the record stays delivered and matched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-redelivery-'));
    dirs.push(dir);
    const registry = new InboundExpectationRegistry({
      store: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => NOW }),
      now: () => NOW,
    });
    await registry.open({ serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account' });
    const records = new InboundMailStore(join(dir, 'records.json'), { now: () => NOW.getTime() });
    const sent: unknown[] = [];
    const intake = createInboundMailIntake({
      expectations: registry.matcher,
      records,
      notices: {
        resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
        send: async (notice) => { sent.push(notice); return { delivered: true }; },
      },
      noticeMode: () => 'expected-only',
      now: () => NOW,
    });

    await intake(message());
    expect(sent).toHaveLength(1);
    expect(registry.list()).toHaveLength(0);

    // The cursor advance never landed, so the same message comes back; the
    // grant is gone, so it no longer matches anything.
    await intake(message());
    await intake(message());

    expect(sent).toHaveLength(1);
    const stored = await records.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.noticeStatus).toBe('delivered');
    expect(stored[0]!.outcome).toBe('matched-expectation');
  });
});
