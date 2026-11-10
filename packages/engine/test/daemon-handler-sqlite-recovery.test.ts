/**
 * sqlite-store-recovery.test.ts, the daemon SQLite base opens a store by
 * validating its CONTENT, not by `existsSync`.
 *
 * The defect this covers: `init()` did
 * `const existing = existsSync(path) ? readFileSync(path) : undefined;
 *  this.db = existing ? new SQL.Database(existing) : new SQL.Database();`
 * so a file that exists but holds no usable database, zero bytes from an
 * interrupted write, a truncated restore, a filesystem that recovered the inode
 * but not the data, was handed straight to sql.js, which threw out of `init()`
 * and took every daemon store built on this class down with it (inbox,
 * channel routes, drafts, peer registry, triage, email drafts). There was no
 * way back short of a human deleting the file.
 *
 * The fix: check the SQLite file header, try the open, and on failure move the
 * unusable file aside (never delete it, an operator may be able to salvage it),
 * start a clean database, and SAY SO. The quarantine copies are themselves
 * bounded by an age TTL and a keep-newest count, reaped on the next init.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../platform/src/platform/utils/logger.ts';
import { quarantineCorruptFile } from '../platform/src/platform/utils/atomic-json-store.ts';
import { HandlerSqliteStore } from '../platform/src/platform/state/daemon-handler-sqlite-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const FILE_NAME = 'recovery-probe.sqlite';
const SCHEMA = ['CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, value TEXT)'];

let tmpDir: string;

beforeEach(() => { tmpDir = makeProjectTempDir('gv-sqlite-store-recovery'); });
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function makeStore(): HandlerSqliteStore {
  return new HandlerSqliteStore({ workingDirectory: tmpDir, fileName: FILE_NAME, schema: SCHEMA });
}

function storeDir(): string {
  return join(tmpDir, '.goodvibes', 'tui', 'operator');
}

function storePath(): string {
  return join(storeDir(), FILE_NAME);
}

/** Write raw bytes to the store path, standing in for whatever a crash left behind. */
function seedRawStoreFile(contents: Buffer | string): void {
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(storePath(), contents);
}

function quarantineFiles(): string[] {
  try {
    return readdirSync(storeDir()).filter((name) => name.startsWith(`${FILE_NAME}.corrupt-`) && !name.endsWith('.why'));
  } catch {
    return [];
  }
}

function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{
  result: T;
  infos: Array<{ message: string; data?: Record<string, unknown> | undefined }>;
  warns: Array<{ message: string; data?: Record<string, unknown> | undefined }>;
}> {
  const infos: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const warns: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const infoSpy = spyOn(logger, 'info').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    infos.push({ message, data });
  }) as never);
  const warnSpy = spyOn(logger, 'warn').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    warns.push({ message, data });
  }) as never);
  return fn()
    .then((result) => ({ result, infos, warns }))
    .finally(() => { infoSpy.mockRestore(); warnSpy.mockRestore(); });
}

describe('a healthy store round-trips', () => {
  test('rows written before a restart are read back after it', async () => {
    const first = makeStore();
    await first.init();
    first.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['a', 'kept']);
    await first.save();
    first.close();

    const second = makeStore();
    await second.init();
    expect(second.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['a'])?.value).toBe('kept');
    second.close();
    // A clean open quarantines nothing.
    expect(quarantineFiles()).toEqual([]);
  });
});

describe('a crash-damaged database is rejected rather than served', () => {
  test('a ZERO-BYTE file does not throw out of init; it is set aside and a clean store starts', async () => {
    seedRawStoreFile('');
    const store = makeStore();
    const { warns } = await withCapturedLogs(async () => { await store.init(); });

    // init survived, and the schema is usable.
    store.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['fresh', 'ok']);
    expect(store.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['fresh'])?.value).toBe('ok');
    store.close();

    // The unusable file was preserved, not deleted...
    expect(quarantineFiles()).toHaveLength(1);
    // ...and the loss was disclosed.
    const disclosure = warns.find((entry) => entry.message.includes('could not be opened'));
    expect(disclosure).toBeDefined();
    expect(String(disclosure?.data?.reason)).toContain('zero-byte');
    expect(disclosure?.data?.store).toBe(FILE_NAME);
  });

  test('a file with no SQLite header is set aside instead of being handed to sql.js', async () => {
    seedRawStoreFile('this is definitely not a database\n');
    const store = makeStore();
    const { warns } = await withCapturedLogs(async () => { await store.init(); });
    store.close();

    expect(quarantineFiles()).toHaveLength(1);
    expect(String(warns.find((e) => e.message.includes('could not be opened'))?.data?.reason))
      .toContain('SQLite file header');
  });

  test('a TRUNCATED database (valid header, cut-off body) is set aside', async () => {
    // Build a real database first, then cut it in half, exactly what a crash
    // partway through a copy or a restore leaves.
    const seeded = makeStore();
    await seeded.init();
    for (let index = 0; index < 40; index += 1) {
      seeded.run('INSERT INTO probe (id, value) VALUES (?, ?)', [`row-${index}`, 'x'.repeat(64)]);
    }
    await seeded.save();
    seeded.close();

    const { readFileSync } = await import('node:fs');
    const full = readFileSync(storePath());
    expect(full.length).toBeGreaterThan(1024);
    seedRawStoreFile(full.subarray(0, Math.floor(full.length / 3)));

    const store = makeStore();
    const { warns } = await withCapturedLogs(async () => { await store.init(); });
    // The store is usable rather than dead.
    expect(store.all('SELECT * FROM probe')).toEqual([]);
    store.close();

    expect(quarantineFiles()).toHaveLength(1);
    expect(warns.some((entry) => entry.message.includes('could not be opened'))).toBe(true);
  });

  test('the damaged file is preserved, never deleted', async () => {
    seedRawStoreFile('salvageable-by-hand');
    const store = makeStore();
    await store.init();
    store.close();

    const [quarantine] = quarantineFiles();
    expect(quarantine).toBeDefined();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(storeDir(), quarantine!), 'utf-8')).toBe('salvageable-by-hand');
  });
});

describe('the quarantine directory is bounded and the reap is disclosed', () => {
  /** Real factory receipts are the retention proof; a matching name is not. */
  function seedQuarantines(count: number, ageDays: number): string[] {
    mkdirSync(storeDir(), { recursive: true });
    const made: string[] = [];
    const base = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    for (let index = 0; index < count; index += 1) {
      seedRawStoreFile(`old-${index}`);
      made.push(quarantineCorruptFile(storePath(), {
        label: 'recovery fixture', reason: 'invalid SQLite image', recovery: 'Preserved for the retention test.',
        now: base + index * 60_000, maxFiles: 64,
      }).quarantinePath);
    }
    return made;
  }

  test('quarantines past the age TTL are reclaimed on the next init, and the count is disclosed', async () => {
    seedQuarantines(2, 30); // well past the 14-day TTL
    const store = makeStore();
    const { infos } = await withCapturedLogs(async () => { await store.init(); });
    store.close();

    expect(quarantineFiles()).toEqual([]);
    const disclosure = infos.find((entry) => entry.message.includes('reclaimed quarantined copies'));
    expect(disclosure).toBeDefined();
    expect(disclosure?.data?.reclaimedFiles).toBe(2);
    expect(disclosure?.data?.ttlDays).toBe(14);
  });

  test('recent quarantines survive the TTL but are still capped by count, newest kept', async () => {
    const seeded = seedQuarantines(6, 1); // one day old: inside the TTL, over the keep-newest cap
    const store = makeStore();
    await store.init();
    store.close();

    const remaining = quarantineFiles();
    expect(remaining).toHaveLength(3);
    expect(seeded.slice(0, 3).every((path) => !existsSync(path) && !existsSync(`${path}.why`))).toBe(true);
    expect(seeded.slice(3).every((path) => existsSync(path) && existsSync(`${path}.why`))).toBe(true);
  });

  test.each(['expired', 'over-cap'] as const)('another supported healthy store survives %s retention despite its quarantine-like filename', async (policy) => {
    const secondary = new HandlerSqliteStore({ workingDirectory: tmpDir, fileName: `${FILE_NAME}.corrupt-secondary.sqlite`, schema: SCHEMA });
    await secondary.init();
    secondary.run('INSERT INTO probe VALUES (?, ?)', ['owned', 'healthy secondary']);
    await secondary.save(); secondary.close();
    const original = readFileSync(secondary.dbPath);
    const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (policy === 'expired') utimesSync(secondary.dbPath, aged, aged);
    const quarantines = seedQuarantines(policy === 'expired' ? 2 : 6, policy === 'expired' ? 30 : 1);
    const primary = makeStore(); await primary.init(); primary.close();
    expect(readFileSync(secondary.dbPath)).toEqual(original);
    expect(quarantines.filter(existsSync)).toHaveLength(policy === 'expired' ? 0 : 3);
    const reopened = new HandlerSqliteStore({ workingDirectory: tmpDir, fileName: `${FILE_NAME}.corrupt-secondary.sqlite`, schema: SCHEMA });
    await reopened.init();
    expect(reopened.get('SELECT value FROM probe WHERE id = ?', ['owned'])).toEqual({ value: 'healthy secondary' });
    reopened.close();
  });

  test('unattributed historical recovery files are preserved even when expired and over cap', async () => {
    mkdirSync(storeDir(), { recursive: true });
    const names = Array.from({ length: 5 }, (_, index) => `${FILE_NAME}.corrupt-${1_000_000 + index}`);
    const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const name of names) { const path = join(storeDir(), name); writeFileSync(path, 'old salvage'); utimesSync(path, aged, aged); }
    const primary = makeStore(); await primary.init(); primary.close();
    expect(quarantineFiles().sort()).toEqual(names.sort());
    for (const name of names) expect(readFileSync(join(storeDir(), name), 'utf8')).toBe('old salvage');
  });

  test('a reap with nothing to reclaim says nothing', async () => {
    seedQuarantines(2, 1);
    const store = makeStore();
    const { infos } = await withCapturedLogs(async () => { await store.init(); });
    store.close();
    expect(infos.some((entry) => entry.message.includes('reclaimed quarantined copies'))).toBe(false);
  });

  test('the reap is idempotent; a second init reclaims nothing further', async () => {
    seedQuarantines(5, 30);
    const first = makeStore();
    await first.init();
    first.close();
    expect(quarantineFiles()).toEqual([]);

    const second = makeStore();
    const { infos } = await withCapturedLogs(async () => { await second.init(); });
    second.close();
    expect(infos.some((entry) => entry.message.includes('reclaimed quarantined copies'))).toBe(false);
  });

  test('a missing archive leaves its unmatched receipt intact without blocking other owned retention', async () => {
    const seeded = seedQuarantines(3, 30);
    // Simulate the race: the file is gone before this process gets to unlink it.
    rmSync(seeded[1]!, { force: true });

    const store = makeStore();
    await store.init(); // must not throw
    store.close();
    expect(quarantineFiles()).toEqual([]);
    expect(existsSync(`${seeded[1]}.why`)).toBe(true);
  });
});

describe('saving is crash-safe', () => {
  test('a save leaves no temp file behind and the result opens cleanly', async () => {
    const store = makeStore();
    await store.init();
    store.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['x', 'y']);
    await store.save();
    store.close();

    const leftovers = readdirSync(storeDir()).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);

    const reopened = makeStore();
    await reopened.init();
    expect(reopened.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['x'])?.value).toBe('y');
    reopened.close();
    expect(quarantineFiles()).toEqual([]);
  });

  test('concurrent saves of one store all succeed; the temp path is not shared', async () => {
    // The defect: the temp filename was `<path>.<pid>.<Date.now()>.tmp`, so two
    // saves in the same millisecond in the same process picked the SAME path.
    // Both wrote it, the first rename moved it away, and the second failed with
    // ENOENT on a file it had just written itself. The inbox poller flushes once
    // per provider and polls every provider concurrently, so an ordinary
    // two-provider startup hit it, and the read verb reported a filesystem error
    // as that provider's feed status.
    const store = makeStore();
    await store.init();
    store.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['concurrent', 'yes']);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.save()),
    );
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(
      rejected.map((result) => String((result as PromiseRejectedResult).reason)),
    ).toEqual([]);
    store.close();

    expect(readdirSync(storeDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const reopened = makeStore();
    await reopened.init();
    expect(reopened.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['concurrent'])?.value).toBe('yes');
    reopened.close();
  });
});
