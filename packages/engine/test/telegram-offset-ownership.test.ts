import { expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindEarlierTelegramCursor, TelegramOffsetStore } from '../platform/src/platform/channels/telegram/offset-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function path() { return join(makeProjectTempDir('telegram-offset-owner'), 'offset.json'); }
const earlier = (offset: number) => JSON.stringify({ version: 1, offset, updatedAt: '2026-11-08T12:00:00.000Z' });

test('each bot keeps its own offset, an offset never moves back, and the file is private', () => {
  const file = path();
  const a = new TelegramOffsetStore(file, '111').retainPolling();
  expect(a.capture().observation).toEqual({ accountId: '111', offset: null });
  expect(a.save(501)).toBe(501);
  const b = new TelegramOffsetStore(file, '222').retainPolling();
  expect(b.save(8)).toBe(8);
  expect(b.save(5)).toBe(8);
  expect(new TelegramOffsetStore(file, '111').load()).toEqual({ mode: 'resume', offset: 501 });
  expect(new TelegramOffsetStore(file, '222').load()).toEqual({ mode: 'resume', offset: 8 });
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
});

test('a damaged cursor file is moved aside and the bot starts without an offset', () => {
  const file = path();
  writeFileSync(file, '{"version":2,"accounts":');
  const store = new TelegramOffsetStore(file, '111');
  expect(store.load()).toEqual({ mode: 'fresh' });
  expect(store.retainPolling().save(9)).toBe(9);
  expect(new TelegramOffsetStore(file, '111').load()).toEqual({ mode: 'resume', offset: 9 });
});

test('a cursor saved by an earlier version is bound to the recorded bot, and waits for review when none is recorded', () => {
  const bound = path();
  writeFileSync(bound, earlier(700));
  expect(bindEarlierTelegramCursor(bound, '111')).toBe('bound');
  expect(new TelegramOffsetStore(bound, '111').load()).toEqual({ mode: 'resume', offset: 700 });
  expect(new TelegramOffsetStore(bound, '222').load()).toEqual({ mode: 'fresh' });
  expect(bindEarlierTelegramCursor(bound, '111')).toBe('none');

  const held = path();
  writeFileSync(held, earlier(700));
  expect(bindEarlierTelegramCursor(held, '')).toBe('held');
  const store = new TelegramOffsetStore(held, '111');
  expect(store.load()).toMatchObject({ mode: 'blocked', kind: 'unbound' });
  expect(() => store.retainPolling()).toThrow('/channels telegram-cursor');
  expect(readFileSync(held, 'utf8')).toBe(earlier(700));
  const prepared = store.prepareLegacyMigration();
  if (!prepared) throw new Error('Expected the earlier cursor to be offered for review');
  expect(store.migrateLegacy(prepared.handle, () => {})).toBe(700);
  expect(new TelegramOffsetStore(held, '111').load()).toEqual({ mode: 'resume', offset: 700 });
});

test.each(['', 'unknown', '0', '00111', '-1', '1.5', '9999999999999999'])(
  'invalid account partition %s never creates state', account => {
    const file = path(); expect(() => new TelegramOffsetStore(file, account)).toThrow('invalid');
    expect(existsSync(file)).toBe(false);
  },
);
