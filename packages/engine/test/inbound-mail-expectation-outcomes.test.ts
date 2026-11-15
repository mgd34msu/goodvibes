/**
 * An expectation that ends is reported, whichever path noticed it and whatever
 * state the disk is in.
 *
 * The registry exists so a signup never ends in silence. These cover the paths
 * that used to drop the outcome: a window that ran out while the daemon was
 * down, a late message that found its expectation already expired, an
 * expectation reaped as another is opened, and a store write that fails at
 * exactly the moment the report is owed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundExpectationRegistry,
  type ExpectationExpiryReport,
} from '../platform/src/platform/email/inbound/expectation-registry.ts';
import { PersistedExpectationStore } from '../platform/src/platform/email/inbound/expectation-store.ts';
import { capabilityVerdict } from '../platform/src/platform/email/inbound/capability.ts';
import { deliveredRecipientFromAliasMailbox } from '../platform/src/platform/google/delivery-evidence.ts';
import type { CandidateEmail } from '../platform/src/platform/google/verification-expectations.ts';

const START = Date.parse('2026-07-28T09:00:00.000Z');
const WINDOW = 15 * 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-expectation-outcomes-'));
  dirs.push(dir);
  return join(dir, 'expectations.json');
}

function build(path: string, startMs: number) {
  let current = startMs;
  const now = (): Date => new Date(current);
  const store = new PersistedExpectationStore(path, { now });
  const reports: ExpectationExpiryReport[] = [];
  const registry = new InboundExpectationRegistry({
    store,
    now,
    onExpired: (report) => { reports.push(report); },
  });
  return { registry, store, reports, advance: (ms: number) => { current += ms; } };
}

async function open(registry: InboundExpectationRegistry, recipient = 'signup-a1@alias.test') {
  return registry.open({
    serviceDomain: 'example.com',
    recipientAddress: recipient,
    purpose: 'confirm the account',
    windowMs: WINDOW,
  });
}

function arrival(recipient: string): CandidateEmail {
  return {
    messageId: 'msg-1',
    from: 'no-reply@example.com',
    deliveredTo: deliveredRecipientFromAliasMailbox(recipient),
    toHeaderClaim: recipient,
    subject: 'Confirm',
    body: 'Click to confirm.',
  };
}

describe('a window that ran out while the daemon was down', () => {
  test('is reported as elapsed when the registry is brought back', async () => {
    const path = storePath();
    const first = build(path, START);
    const opened = await open(first.registry);

    const second = build(path, START + 20 * 60_000);
    await second.registry.hydrate();

    expect(second.reports).toHaveLength(1);
    expect(second.reports[0]?.id).toBe(opened.id);
    expect(second.reports[0]?.reason).toBe('window-elapsed');
  });

  test('is still reported when the boot recovery sweep reaped the row first, and only once', async () => {
    const path = storePath();
    const first = build(path, START);
    const opened = await open(first.registry);

    const second = build(path, START + 20 * 60_000);
    // What the supervisor does before it hydrates: the sweep deletes the row.
    const sweep = await second.store.runRecoverySweep();
    expect(sweep.removed.map((row) => row.reason)).toEqual(['expired']);
    await second.registry.hydrate();
    await second.registry.hydrate();

    expect(second.reports.map((report) => report.id)).toEqual([opened.id]);
  });
});

describe('a late message that names an expectation already past its window', () => {
  test('reports the expiry instead of dropping the expectation silently', async () => {
    const harness = build(storePath(), START);
    const opened = await open(harness.registry);
    harness.advance(WINDOW + 1_000);

    const match = await harness.registry.matcher.matchCandidate(
      arrival('signup-a1@alias.test'),
      new Date(START + WINDOW + 1_000),
    );

    expect(match.kind).toBe('expired');
    expect(harness.reports.map((report) => [report.id, report.reason])).toEqual([[opened.id, 'window-elapsed']]);
    // The sweep that comes later finds nothing left to tell again.
    await harness.registry.sweep();
    expect(harness.reports).toHaveLength(1);
  });

  test('opening another expectation reports the one it reaps', async () => {
    const harness = build(storePath(), START);
    const lapsed = await open(harness.registry, 'signup-a1@alias.test');
    harness.advance(WINDOW + 1_000);

    await open(harness.registry, 'signup-b2@alias.test');

    expect(harness.reports.map((report) => report.id)).toEqual([lapsed.id]);
  });
});

describe('when the store cannot be written', () => {
  const diskFull = new Error('ENOSPC: no space left on device');

  test('an expiry found by the sweep is still reported', async () => {
    const harness = build(storePath(), START);
    const opened = await open(harness.registry);
    harness.advance(WINDOW + 1_000);
    harness.store.replaceAll = async () => { throw diskFull; };

    await expect(harness.registry.sweep()).rejects.toThrow('ENOSPC');

    expect(harness.reports.map((report) => report.id)).toEqual([opened.id]);
  });

  test('a capability loss is still reported to the workstream', async () => {
    const harness = build(storePath(), START);
    const opened = await open(harness.registry);
    harness.store.replaceAll = async () => { throw diskFull; };

    await expect(harness.registry.capabilityChanged(capabilityVerdict('mailbox-unreadable', 'x'))).rejects.toThrow('ENOSPC');

    expect(harness.reports.map((report) => [report.id, report.reason])).toEqual([[opened.id, 'capability-lost']]);
  });

  test('an expectation whose registration failed does not stay live to match mail', async () => {
    const harness = build(storePath(), START);
    const working = harness.store.replaceAll.bind(harness.store);
    harness.store.replaceAll = async () => { throw diskFull; };

    await expect(open(harness.registry)).rejects.toThrow('ENOSPC');
    harness.store.replaceAll = working;

    expect(harness.registry.hasOpen()).toBe(false);
    const match = await harness.registry.matcher.matchCandidate(arrival('signup-a1@alias.test'), new Date(START));
    expect(match.kind).not.toBe('matched');
  });
});
