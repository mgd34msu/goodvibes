/**
 * A read that fails is not a file that is corrupt.
 *
 * Both inbound stores treat an unparseable file as discarded-and-disclosed, and
 * that rule is right for content that does not parse. It must not extend to a
 * `readFile` that failed for an I/O reason: the next write would replace a file
 * of good positions with an empty one, and the mailbox would resume from the
 * high-water mark, skipping everything in between.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxCursorStore } from '../platform/src/platform/email/inbound/cursor-store.ts';
import { InboundMailStore, type InboundMailRecordInput } from '../platform/src/platform/email/inbound/record-store.ts';
import { PersistedExpectationStore } from '../platform/src/platform/email/inbound/expectation-store.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';

type CursorBacking = Exclude<ConstructorParameters<typeof MailboxCursorStore>[0], string>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-store-read-'));
  dirs.push(dir);
  return dir;
}

const RESOLVE = {
  account: 'primary',
  mailbox: 'INBOX',
  serverUidValidity: 7,
  currentHighestUid: 500,
  currentMessageCount: 500,
} as const;

/** Seed a real position of UID 42, then hand back the path and a store reading it. */
async function seeded(): Promise<{ path: string; backing: CursorBacking }> {
  const path = join(scratch(), 'cursors.json');
  const seed = new MailboxCursorStore(path);
  await seed.resolve({ ...RESOLVE, currentHighestUid: 42 });
  const backing: CursorBacking = new PersistentStore(path);
  return { path, backing };
}

describe('a cursor file whose read failed for an I/O reason', () => {
  test('is left as it was, and the change is refused rather than made on an empty set', async () => {
    const { path, backing } = await seeded();
    const before = readFileSync(path, 'utf8');
    // The read "fails" and names a path that cannot be read back either.
    const unreadable = join(scratch(), 'a-directory');
    mkdirSync(unreadable);
    backing.loadOrDiscard = async () => ({
      data: null,
      corruption: { filePath: unreadable, detail: 'EIO: i/o error, read', detectedAt: 0 },
    });
    const store = new MailboxCursorStore(backing);

    await expect(store.resolve(RESOLVE)).rejects.toThrow('left as it is');

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('that clears on the second look resumes from the stored position', async () => {
    const { backing, path } = await seeded();
    const real = backing.loadOrDiscard.bind(backing);
    let calls = 0;
    backing.loadOrDiscard = async () => {
      calls += 1;
      return calls === 1
        ? { data: null, corruption: { filePath: path, detail: 'EMFILE: too many open files', detectedAt: 0 } }
        : real();
    };
    const store = new MailboxCursorStore(backing);

    const resolution = await store.resolve(RESOLVE);

    expect(resolution.kind).toBe('resumed');
    expect(resolution.cursor.lastSeenUid).toBe(42);
    expect(store.getCorruption()).toBeNull();
  });

  test('content that really does not parse is still discarded and disclosed', async () => {
    const path = join(scratch(), 'cursors.json');
    writeFileSync(path, '{ not json');
    const store = new MailboxCursorStore(path);

    const resolution = await store.resolve(RESOLVE);

    expect(resolution.kind).toBe('first-run');
    expect(store.getCorruption()).not.toBeNull();
  });
});

describe('a cursor for an account that is no longer configured', () => {
  test('is hidden from readers but still resumed by the source that is running for it', async () => {
    const path = join(scratch(), 'cursors.json');
    const store = new MailboxCursorStore(path, { isAccountConfigured: () => false });
    await store.resolve({ ...RESOLVE, currentHighestUid: 42 });

    expect(await store.get('primary', 'INBOX')).toBeNull();
    // Resuming from the real position, not re-establishing at the high-water
    // mark: a source mid-reload must not skip mail because config lagged it.
    const resolution = await store.resolve(RESOLVE);
    expect(resolution.kind).toBe('resumed');
    expect(resolution.cursor.lastSeenUid).toBe(42);
  });
});

type RecordBacking = Exclude<ConstructorParameters<typeof InboundMailStore>[0], string>;
type ExpectationBacking = Exclude<ConstructorParameters<typeof PersistedExpectationStore>[0], string>;

const RECORD: Extract<InboundMailRecordInput, { source: 'imap' }> = {
  source: 'imap',
  account: 'acct-1',
  mailbox: 'INBOX',
  uidValidity: 100,
  uid: 1,
  senderDisplay: 'orders@shop.example',
  subject: 'Your order is confirmed',
  deliveredToAddress: 'owner+alias@example.com',
  deliveryEvidenceSource: 'alias-mailbox',
  links: [],
  outcome: 'matched-expectation',
  noticeStatus: 'delivered',
  body: 'hello world',
  receivedAt: new Date().toISOString(),
};

/** A backing whose first read reports an I/O failure naming `failingPath`, then reads normally. */
function failFirstRead<T extends Record<string, unknown>>(backing: PersistentStore<T>, failingPath: string): void {
  const real = backing.loadOrDiscard.bind(backing);
  let calls = 0;
  backing.loadOrDiscard = async () => {
    calls += 1;
    return calls === 1
      ? { data: null, corruption: { filePath: failingPath, detail: 'EIO: i/o error, read', detectedAt: 0 } }
      : real();
  };
}

describe('a record file whose read failed for an I/O reason', () => {
  test('keeps its history: the write is refused, not made on an empty set', async () => {
    const path = join(scratch(), 'records.json');
    await new InboundMailStore(path).record(RECORD);
    const before = readFileSync(path, 'utf8');
    const backing: RecordBacking = new PersistentStore(path);
    const unreadable = join(scratch(), 'a-directory');
    mkdirSync(unreadable);
    backing.loadOrDiscard = async () => ({
      data: null,
      corruption: { filePath: unreadable, detail: 'EIO: i/o error, read', detectedAt: 0 },
    });
    const store = new InboundMailStore(backing);

    await expect(store.record({ ...RECORD, uid: 2 })).rejects.toThrow('left as it is');
    await expect(store.sweep()).rejects.toThrow('left as it is');

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('that clears on the second look appends to the stored history', async () => {
    const path = join(scratch(), 'records.json');
    await new InboundMailStore(path).record(RECORD);
    const backing: RecordBacking = new PersistentStore(path);
    failFirstRead(backing, path);
    const store = new InboundMailStore(backing);

    await store.record({ ...RECORD, uid: 2 });

    expect((await store.list()).length).toBe(2);
    expect(store.getCorruption()).toBeNull();
  });

  test('content that really does not parse is still discarded and disclosed', async () => {
    const path = join(scratch(), 'records.json');
    writeFileSync(path, '{ not json');
    const store = new InboundMailStore(path);

    await store.record(RECORD);

    expect(store.getCorruption()).not.toBeNull();
    expect((await store.list()).length).toBe(1);
  });
});

describe('an expectation file whose read failed for an I/O reason', () => {
  test('is left as it was and the write is refused', async () => {
    const path = join(scratch(), 'expectations.json');
    writeFileSync(path, JSON.stringify({ version: 1, expectations: [] }));
    const before = readFileSync(path, 'utf8');
    const backing: ExpectationBacking = new PersistentStore(path);
    const unreadable = join(scratch(), 'a-directory');
    mkdirSync(unreadable);
    backing.loadOrDiscard = async () => ({
      data: null,
      corruption: { filePath: unreadable, detail: 'EIO: i/o error, read', detectedAt: 0 },
    });
    const store = new PersistedExpectationStore(backing);

    await expect(store.replaceAll([])).rejects.toThrow('left as it is');

    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
