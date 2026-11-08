import { afterEach, expect, test } from 'bun:test';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramOffsetStore } from '../sdk/src/platform/channels/telegram/offset-store.js';
import { TelegramCursorMigration } from '../sdk/src/platform/channels/telegram/cursor-migration.js';
import { readTelegramCursorPreview } from '../sdk/src/platform/channels/telegram/cursor-migration-data.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const at = '2026-11-08T12:00:00.000Z';
function fixture() {
  const file = join(makeProjectTempDir('telegram-cursor-migration'), 'cursor.json');
  const original = JSON.stringify({ version: 1, offset: 501, updatedAt: at }); writeFileSync(file, original);
  let active = true, now = 1000, publications = 0;
  const assertCurrent = () => { if (!active) throw new Error('Credential owner changed'); };
  const migration = new TelegramCursorMigration({ filePath: file, now: () => now,
    identity: async owner => { owner.assertCurrent(); assertCurrent(); return { id: '111', username: 'original_bot', assertCurrent }; },
    beforeWrite: () => { expect(readFileSync(file, 'utf8')).toBe(original); publications++; },
  });
  cleanups.push(() => migration.close());
  return { file, original, migration, retire: () => { active = false; }, time: (value: number) => { now = value; }, publications: () => publications };
}

test('explicit migration preserves the exact position/time and does not publish during preview', async () => {
  const f = fixture(), preview = readTelegramCursorPreview(await f.migration.preview());
  if (preview.state !== 'unbound') throw new Error('Expected original unbound cursor');
  expect(preview).toMatchObject({ accountId: '111', username: 'original_bot', offset: 501, updatedAt: at });
  expect(readFileSync(f.file, 'utf8')).toBe(f.original); expect(f.publications()).toBe(0);
  const result = await f.migration.commit({ previewId: preview.previewId, confirm: true });
  expect(result).toEqual({ accountId: '111', offset: 501 }); expect(f.publications()).toBe(1);
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ version: 2, accounts: [{ accountId: '111', offset: 501, updatedAt: at }] });
  expect(new TelegramOffsetStore(f.file, '111').load()).toEqual({ mode: 'resume', offset: 501 });
  expect(new TelegramOffsetStore(f.file, '222').load()).toEqual({ mode: 'fresh' });
  await expect(f.migration.commit({ previewId: preview.previewId, confirm: true })).rejects.toThrow('invalid');
});

test.each(['credential', 'expired', 'clock-regressed', 'same-bytes-replaced', 'changed-position'] as const)(
  'a %s change cannot adopt the earlier preparation', async change => {
    const f = fixture(), preview = await f.migration.preview(); if (preview.state !== 'unbound') throw new Error();
    if (change === 'credential') f.retire();
    if (change === 'expired') f.time(preview.expiresAtMs);
    if (change === 'clock-regressed') f.time(999);
    if (change === 'same-bytes-replaced') { writeFileSync(`${f.file}.new`, f.original); renameSync(`${f.file}.new`, f.file); }
    if (change === 'changed-position') writeFileSync(f.file, JSON.stringify({ version: 1, offset: 700, updatedAt: at }));
    const before = readFileSync(f.file, 'utf8');
    await expect(f.migration.commit({ previewId: preview.previewId, confirm: true })).rejects.toThrow();
    expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.publications()).toBe(0);
  },
);

test('two confirmations of one preview have one publisher', async () => {
  const f = fixture(), preview = await f.migration.preview(); if (preview.state !== 'unbound') throw new Error();
  const results = await Promise.allSettled([f.migration.commit({ previewId: preview.previewId, confirm: true }),
    f.migration.commit({ previewId: preview.previewId, confirm: true })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(f.publications()).toBe(1);
});

test('a copied/fabricated storage handle and a second original-file owner cannot retarget the cursor', () => {
  const f = fixture(), a = new TelegramOffsetStore(f.file, '111'), b = new TelegramOffsetStore(f.file, '222');
  const first = a.prepareLegacyMigration(), second = b.prepareLegacyMigration(); if (!first || !second) throw new Error();
  expect(() => a.migrateLegacy(JSON.parse('{}') as typeof first.handle, () => {})).toThrow('invalid');
  a.migrateLegacy(first.handle, () => {});
  const retained = readFileSync(f.file, 'utf8');
  expect(() => b.migrateLegacy(second.handle, () => {})).toThrow();
  expect(readFileSync(f.file, 'utf8')).toBe(retained);
  expect(new TelegramOffsetStore(f.file, '222').load()).toEqual({ mode: 'fresh' });
});

test('closing owns an uncooperative identity read and rejects its late result', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
  const owner = new TelegramCursorMigration({ filePath: f.file, identity: async () => {
    entered(); await gate; return { id: '111', username: 'original_bot', assertCurrent() {} };
  } });
  cleanups.push(async () => { release(); await owner.close(); });
  const pending = owner.preview().catch(error => error as unknown); await started;
  let closed = false; const closing = owner.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  release(); expect(await pending).toBeInstanceOf(Error); await closing;
  expect(closed).toBe(true); expect(readFileSync(f.file, 'utf8')).toBe(f.original);
});
