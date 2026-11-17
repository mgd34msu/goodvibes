// Proves: The Gmail history position moves past a message Google failed to hand over, so it is never announced.
// Red when: GmailMailSource advances the stored position over an unreadable message.
/**
 * Gmail's history is forward-only: a position stored past a record is never
 * handed out again. When Google lists new mail but will not hand over one of
 * the messages (a rate limit), the stored position stays below that message,
 * so the next poll reads it; every message is announced once, and a source
 * opened afterwards over the same files announces nothing again.
 *
 * Real Gmail source, cursor store, deduping sink, notice intake, record store
 * and expectation registry over their files. Google is the stand-in behind the
 * source's history port; the clock is the harness's fake one and the notice
 * route records what it was asked to send.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInboundMailDedup,
  createInboundMailIntake,
  DedupingInboundMailSink,
  GmailMailSource,
  InboundExpectationRegistry,
  InboundMailStore,
  MailboxCursorStore,
  PersistedExpectationStore,
} from '../platform/src/platform/email/inbound/index.ts';
import { createInboundMailSetAside } from '../platform/src/platform/email/inbound/intake.ts';
import { MAIL_CONTENT_PROVENANCE, type GmailMessageBody } from '../platform/src/platform/google/api-client.ts';
import type { HistoryDeltaDeps } from '../platform/src/platform/google/history-delta.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { FakeClock } from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const LABEL = 'INBOX';
const dirs: string[] = [];
const retire: Array<() => void> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const done of retire.splice(0)) done();
});

/** Google, as the history port sees it: history records after a start id, and messages by id. */
function google() {
  const records: Array<{ id: string; messagesAdded: Array<{ message: { id: string } }> }> = [];
  const refuseNext = new Map<string, number>();
  const message = (id: string): GmailMessageBody => ({
    id, threadId: id, from: 'Sender <sender@service.example>', to: 'owner@example.test', subject: `subject ${id}`,
    date: 'Mon, 17 Nov 2026 10:00:00 +0000', snippet: '', unread: true, provenance: MAIL_CONTENT_PROVENANCE,
    deliveredTo: ['owner@example.test'], body: `the body of ${id}`,
  });
  const port: HistoryDeltaDeps = {
    scopes: () => ['https://www.googleapis.com/auth/gmail.readonly'],
    fetchHistoryPage: async (params) => {
      const start = BigInt(params.get('startHistoryId') ?? '0');
      const after = records.filter((record) => BigInt(record.id) > start);
      return { ok: true, value: { history: after, historyId: records.at(-1)?.id ?? '100' } };
    },
    getMessage: async (id) => {
      const left = refuseNext.get(id) ?? 0;
      if (left > 0) {
        refuseNext.set(id, left - 1);
        return { ok: false, status: 429, reason: 'rate-limited', problem: 'Gmail answered 429: user rate limit exceeded.', fix: 'Wait and poll again.' };
      }
      return { ok: true, value: message(id) };
    },
    readMessageMetadata: async (id) => {
      const { body: _body, ...metadata } = message(id);
      return { ok: true, value: metadata };
    },
  };
  return {
    port,
    add(id: string, recordId: string) { records.push({ id: recordId, messagesAdded: [{ message: { id } }] }); },
    refuse(id: string, times: number) { refuseNext.set(id, times); },
  };
}

test('a message Google would not hand over keeps the position below it, is read on the next poll, and every message is announced once', async () => {
  retire.push(configureDecisionModelPolicy(() => 'No Decision Model'));
  const dir = mkdtempSync(join(tmpdir(), 'gv-gmail-position-'));
  dirs.push(dir);
  const gmail = google();
  const notices: string[] = [];
  const records = new InboundMailStore(join(dir, 'records.json'));
  const expectations = new InboundExpectationRegistry({ store: new PersistedExpectationStore(join(dir, 'expectations.json')) });
  const clock = new FakeClock();

  /** One daemon's Gmail reader over the files in `dir`. */
  const reader = () => {
    const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), { isAccountConfigured: () => true });
    const intake = createInboundMailIntake({
      expectations: expectations.matcher, records,
      notices: {
        resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
        send: async (notice) => { notices.push(JSON.stringify(notice)); return { delivered: true }; },
      },
      noticeMode: () => 'all',
      now: () => new Date(clock.now()),
    });
    const sink = new DedupingInboundMailSink({
      dedup: createInboundMailDedup(),
      handle: intake,
      setAside: createInboundMailSetAside({ records, now: () => new Date(clock.now()) }),
    });
    const source = new GmailMailSource({
      account: ACCOUNT, mailbox: LABEL, history: gmail.port,
      currentHistoryId: async () => ({ ok: true, value: '100' }),
      cursors, sink, clock,
      expectationOpen: () => false, expectationOpened: () => () => undefined,
      pollExpectingMs: 5_000, pollIdleMs: 60_000,
    });
    retire.push(() => { intake.stop(); void source.stop(); });
    return { source, cursors };
  };
  const announced = (id: string) => notices.filter((text) => text.includes(`subject ${id}`)).length;
  const signal = new AbortController().signal;

  const first = reader();
  // The first poll establishes the position at Google's current history id.
  await first.source.start(signal);
  expect((await first.cursors.getGmail(ACCOUNT, LABEL))?.historyId).toBe('100');

  // Three messages arrive; Google lists all three and refuses to hand over the second.
  gmail.add('m1', '101');
  gmail.add('m2', '102');
  gmail.add('m3', '103');
  gmail.refuse('m2', 1);
  await first.source.start(signal);
  expect((await first.cursors.getGmail(ACCOUNT, LABEL))?.historyId).toBe('101');
  expect({ m1: announced('m1'), m2: announced('m2'), m3: announced('m3') }).toEqual({ m1: 1, m2: 0, m3: 1 });

  // The next poll reads it.
  await first.source.start(signal);
  expect((await first.cursors.getGmail(ACCOUNT, LABEL))?.historyId).toBe('103');
  expect({ m1: announced('m1'), m2: announced('m2'), m3: announced('m3') }).toEqual({ m1: 1, m2: 1, m3: 1 });

  // A reader opened afterwards over the same files announces nothing again.
  await reader().source.start(signal);
  expect({ m1: announced('m1'), m2: announced('m2'), m3: announced('m3') }).toEqual({ m1: 1, m2: 1, m3: 1 });
});
