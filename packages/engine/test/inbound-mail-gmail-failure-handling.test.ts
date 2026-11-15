/**
 * What the Gmail source concludes from a failed call, and how quickly it asks
 * again.
 *
 * Google answers a per-user rate limit with a 403 as well as a 429, so a 403
 * alone cannot mean "the grant was refused": reading it that way closes every
 * open signup and stops the mailbox for an hour. A grant Google reports as
 * dead, on the other hand, must reach the owner instead of polling for ever.
 * Google is a scripted function and time is a fake clock.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxCursorStore } from '../platform/src/platform/email/inbound/cursor-store.ts';
import { GmailMailSource } from '../platform/src/platform/email/inbound/gmail-source.ts';
import type {
  InboundMailNote,
  InboundMailSink,
  InboundMailTerminalFailure,
  InboundMailboxMessage,
} from '../platform/src/platform/email/inbound/ports.ts';
import {
  MAIL_CONTENT_PROVENANCE,
  type GmailMessageBody,
  type GoogleApiFailure,
  type GoogleApiResult,
} from '../platform/src/platform/google/api-client.ts';
import { FakeClock, flush, waitFor } from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const LABEL = 'INBOX';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const UNCLASSIFIED_403: GoogleApiFailure = {
  ok: false,
  status: 403,
  reason: 'unclassified',
  problem: 'Google returned HTTP 403; the cause could not be established.',
  fix: 'Check the account and project access settings before retrying.',
};

const DEAD_GRANT: GoogleApiFailure = {
  ok: false,
  status: null,
  reason: 'grant-invalid',
  problem: 'Google no longer accepts the stored authorization.',
  fix: 'Reconnect the Google account.',
};

function message(id: string): GmailMessageBody {
  return {
    id,
    threadId: `thread-${id}`,
    from: 'noreply@service.test',
    to: 'owner@example.test',
    subject: `subject ${id}`,
    date: 'Sun, 27 Jul 2026 10:00:00 +0000',
    snippet: id,
    unread: true,
    provenance: MAIL_CONTENT_PROVENANCE,
    body: `body of ${id}`,
    deliveredTo: ['owner+signup@example.test'],
  };
}

function historyPage(historyId: string, ids: readonly string[]): GoogleApiResult<unknown> {
  return {
    ok: true,
    value: { historyId, history: ids.map((id) => ({ messagesAdded: [{ message: { id } }] })) },
  };
}

class ScriptedSink implements InboundMailSink {
  readonly delivered: string[] = [];
  /** Ids that always throw. */
  readonly poison = new Set<string>();
  async deliver(message: InboundMailboxMessage): Promise<void> {
    const id = message.source === 'gmail' ? message.resourceId : String(message.uid);
    if (this.poison.has(id)) throw new Error(`the sink refused ${id}`);
    this.delivered.push(id);
  }
}

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.();
});

async function build(input: {
  readonly page?: () => GoogleApiResult<unknown>;
  readonly ids?: readonly string[];
  readonly idleMs?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-gmail-failure-'));
  const store = new MailboxCursorStore(join(dir, 'cursors.json'));
  await store.resolveGmail({ account: ACCOUNT, mailbox: LABEL, currentHistoryId: '100' });
  const clock = new FakeClock();
  const sink = new ScriptedSink();
  const terminals: InboundMailTerminalFailure[] = [];
  const notes: InboundMailNote[] = [];
  const open = { value: false };
  const polls = { count: 0 };
  const messages = new Map((input.ids ?? []).map((id) => [id, message(id)]));
  const source = new GmailMailSource({
    account: ACCOUNT,
    mailbox: LABEL,
    history: {
      scopes: () => [READONLY_SCOPE],
      fetchHistoryPage: async () => {
        polls.count += 1;
        return (input.page ?? (() => historyPage('100', [])))();
      },
      getMessage: async (id) => {
        const found = messages.get(id);
        return found === undefined
          ? { ok: false, status: 404, problem: `no message ${id}`, fix: '' }
          : { ok: true, value: found };
      },
      readMessageMetadata: async (id) => ({ ok: false, status: 404, problem: `no message ${id}`, fix: '' }),
    },
    currentHistoryId: async () => ({ ok: true, value: '900' }),
    cursors: store,
    sink,
    clock,
    expectationOpen: () => open.value,
    pollExpectingMs: 5_000,
    pollIdleMs: input.idleMs ?? 60_000,
    observer: {
      note: (note) => { notes.push(note); },
      terminalFailure: (failure) => { terminals.push(failure); },
    },
  });
  running.push(() => source.stop());
  return { source, clock, sink, terminals, notes, open, polls };
}

describe('a 403 from Google', () => {
  test('whose cause is not named is a rate limit to wait out, not a refused grant', async () => {
    const harness = await build({ page: () => UNCLASSIFIED_403 });
    harness.open.value = true;

    const verdict = await harness.source.start(new AbortController().signal);

    expect(verdict.state).toBe('degraded');
    expect(verdict.reason).toBe('server-unavailable');
    expect(harness.terminals).toEqual([]);
    // The next ask is the poll interval, not the hour a refused grant waits.
    const controller = new AbortController();
    const loop = harness.source.run(controller.signal);
    await harness.clock.waitForSleepers(1, 'the poll wait');
    expect(harness.clock.nextDueIn).toBe(5_000);
    controller.abort();
    await loop;
  });

  test('that keeps coming with no cause for ten minutes is taken as a refusal, and the owner is told once', async () => {
    const harness = await build({ page: () => UNCLASSIFIED_403 });

    const verdicts = [];
    verdicts.push(await harness.source.start(new AbortController().signal));
    await harness.clock.advance(9 * 60_000);
    verdicts.push(await harness.source.start(new AbortController().signal));
    await harness.clock.advance(60_000);
    verdicts.push(await harness.source.start(new AbortController().signal));

    expect(verdicts.map((verdict) => verdict.state)).toEqual(['degraded', 'degraded', 'insufficient']);
    expect(verdicts[2]?.reason).toBe('credentials-rejected');
    expect(harness.terminals).toHaveLength(1);
    expect(harness.source.terminalFailure?.reason).toBe('credentials-rejected');
  });

  test('that lasts many expecting-interval polls, as a rate limit does, stays degraded', async () => {
    const harness = await build({ page: () => UNCLASSIFIED_403 });

    for (let poll = 0; poll < 12; poll += 1) {
      const verdict = await harness.source.start(new AbortController().signal);
      expect(verdict.state).toBe('degraded');
      await harness.clock.advance(5_000);
    }

    expect(harness.terminals).toEqual([]);
  });

  test('is not counted across a different failure between two of them', async () => {
    const answers: GoogleApiResult<unknown>[] = [
      UNCLASSIFIED_403,
      { ...UNCLASSIFIED_403, status: 503, problem: 'Google is unavailable.' },
      UNCLASSIFIED_403,
    ];
    const harness = await build({ page: () => answers.shift() ?? UNCLASSIFIED_403 });

    await harness.source.start(new AbortController().signal);
    await harness.clock.advance(6 * 60_000);
    await harness.source.start(new AbortController().signal);
    await harness.clock.advance(6 * 60_000);
    const verdict = await harness.source.start(new AbortController().signal);

    expect(verdict.state).toBe('degraded');
    expect(harness.terminals).toEqual([]);
  });

  test('that names a missing scope is a refusal at once', async () => {
    const harness = await build({
      page: () => ({ ...UNCLASSIFIED_403, reason: 'missing-scopes', problem: 'The credential lacks permissions.' }),
    });
    const verdict = await harness.source.start(new AbortController().signal);
    expect(verdict.state).toBe('insufficient');
    expect(harness.terminals).toHaveLength(1);
  });
});

describe('a grant Google no longer accepts', () => {
  test('is a refusal whatever the status, and reaches the owner', async () => {
    const harness = await build({ page: () => DEAD_GRANT });

    const verdict = await harness.source.start(new AbortController().signal);

    expect(verdict.state).toBe('insufficient');
    expect(verdict.reason).toBe('credentials-rejected');
    expect(verdict.fix).toBe('Reconnect the Google account.');
    expect(harness.terminals).toHaveLength(1);
    expect(harness.terminals[0]?.fix).toBe('Reconnect the Google account.');
    // Asked about again, it is the same condition: no second announcement.
    await harness.source.start(new AbortController().signal);
    expect(harness.terminals).toHaveLength(1);
  });

  test('stops being reported as terminal once a poll succeeds again', async () => {
    let failing = true;
    const harness = await build({ page: () => (failing ? DEAD_GRANT : historyPage('100', [])) });

    await harness.source.start(new AbortController().signal);
    expect(harness.source.terminalFailure).not.toBeNull();

    failing = false;
    const verdict = await harness.source.start(new AbortController().signal);
    expect(verdict.state).toBe('healthy');
    expect(harness.source.terminalFailure).toBeNull();
  });
});

describe('the wait between polls', () => {
  test('a signup opened during a long idle sleep is polled within the expecting interval', async () => {
    const harness = await build({ idleMs: 3_600_000 });
    const controller = new AbortController();
    const loop = harness.source.run(controller.signal);
    await harness.clock.waitForSleepers(1, 'the idle wait');
    expect(harness.polls.count).toBe(0);

    harness.open.value = true;
    await harness.clock.advance(5_000);
    await waitFor(() => harness.polls.count === 1, 'the poll after the expectation opened');

    controller.abort();
    await loop;
  });

  test('with nothing open, the idle interval is still waited out in full', async () => {
    const harness = await build({ idleMs: 3_600_000 });
    const controller = new AbortController();
    const loop = harness.source.run(controller.signal);
    await harness.clock.waitForSleepers(1, 'the idle wait');

    await harness.clock.advance(3_600_000 - 1_000);
    await flush();
    expect(harness.polls.count).toBe(0);
    await harness.clock.advance(1_000);
    await waitFor(() => harness.polls.count === 1, 'the idle poll');

    controller.abort();
    await loop;
  });
});

describe('a message the sink keeps refusing', () => {
  test('stops reading as healthy once the same delivery has failed repeatedly', async () => {
    let call = 0;
    const harness = await build({
      ids: ['m1', 'm2'],
      page: () => { call += 1; return call === 1 ? historyPage('100', []) : historyPage('200', ['m1', 'm2']); },
    });
    harness.sink.poison.add('m2');

    const states: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      states.push((await harness.source.start(new AbortController().signal)).state);
    }

    // The first poll is clean; two refusals are not yet a pattern; the third is.
    expect(states).toEqual(['healthy', 'healthy', 'healthy', 'degraded']);
    const verdict = harness.source.verdict;
    expect(verdict.detail).toContain('m2');
    expect(verdict.detail).toContain('3 times in a row');
  });
});
