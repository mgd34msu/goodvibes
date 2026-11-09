import { afterEach, expect, test } from 'bun:test';
import { lstatSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramOffsetStore } from '../platform/src/platform/channels/telegram/offset-store.js';
import { tryAcquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const releases: Array<() => void> = [];
afterEach(() => { for (const release of releases.splice(0).reverse()) release(); });
function path() { return join(makeProjectTempDir('telegram-offset-owner'), 'offset.json'); }

test('independently opened stores refresh before mutation and retain distinct account cursors', () => {
  const file = path(), a = new TelegramOffsetStore(file, '111'), b = new TelegramOffsetStore(file, '222');
  expect(a.load()).toEqual({ mode: 'fresh' }); expect(b.load()).toEqual({ mode: 'fresh' });
  expect(a.save(501)).toBe(501); expect(b.load()).toEqual({ mode: 'fresh' }); expect(b.save(8)).toBe(8);
  expect(a.load()).toEqual({ mode: 'resume', offset: 501 }); expect(b.load()).toEqual({ mode: 'resume', offset: 8 });
  expect(a.save(500)).toBe(501);
  expect(new TelegramOffsetStore(file, '111').load()).toEqual({ mode: 'resume', offset: 501 });
  expect(new TelegramOffsetStore(file, '222').load()).toEqual({ mode: 'resume', offset: 8 });
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
});

test('another live writer cannot be overwritten and a busy caller can retry after release', () => {
  const file = path(), store = new TelegramOffsetStore(file, '111'); store.save(7);
  const before = readFileSync(file), release = tryAcquireCrossProcessLock(`${file}.mutation.lock`);
  if (!release) throw new Error('Fixture did not acquire cursor mutation'); releases.push(release);
  expect(() => store.save(99)).toThrow('Another Telegram owner'); expect(readFileSync(file)).toEqual(before);
  release(); expect(store.save(8)).toBe(8);
});

test('deleting previously observed state cannot turn this owner into a fresh cursor', () => {
  const file = path(), store = new TelegramOffsetStore(file, '111'); store.save(20); unlinkSync(file);
  expect(store.load()).toMatchObject({ mode: 'blocked', kind: 'unavailable' });
  expect(() => store.save(21)).toThrow('could not be confirmed');
  expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
});

test('unsafe and unsupported cursor evidence is preserved verbatim', () => {
  const file = path();
  for (const bytes of ['{', JSON.stringify({ version: 99, accounts: [] }),
    JSON.stringify({ version: 2, accounts: [{ accountId: '111', offset: -1, updatedAt: new Date().toISOString() }] }),
    JSON.stringify({ version: 2, accounts: [{ accountId: '111', offset: 1, updatedAt: 'invalid' }] })]) {
    writeFileSync(file, bytes); const store = new TelegramOffsetStore(file, '111');
    expect(store.load().mode).toBe('blocked'); expect(() => store.save(30)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  }
  const target = `${file}.target`; writeFileSync(target, '{"version":2,"accounts":[]}'); unlinkSync(file); symlinkSync(target, file);
  expect(new TelegramOffsetStore(file, '111').load().mode).toBe('blocked');
  expect(lstatSync(file).isSymbolicLink()).toBe(true); expect(readFileSync(target, 'utf8')).toBe('{"version":2,"accounts":[]}');
});

test('uncertain post-publication ownership does not pretend to roll back confirmation', () => {
  const file = path(), store = new TelegramOffsetStore(file, '111'); store.save(7);
  expect(() => store.save(8, () => {
    if (readFileSync(file, 'utf8').includes('"offset":8')) throw new Error('Original polling owner retired');
  })).toThrow('could not be confirmed');
  expect(new TelegramOffsetStore(file, '111').load()).toEqual({ mode: 'resume', offset: 8 });
  expect(() => store.save(9)).toThrow('could not be confirmed');
});

test.each(['', 'unknown', '0', '00111', '-1', '1.5', '9999999999999999'])(
  'invalid account partition %s never creates state', account => {
    const file = path(); expect(() => new TelegramOffsetStore(file, account)).toThrow('invalid');
    expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
  },
);
