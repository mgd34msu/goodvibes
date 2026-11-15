import { afterEach, expect, spyOn, test } from 'bun:test';
import { createSingleUseReferenceTable } from '../daemon-api/src/single-use-reference-table.js';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
const freeze = (now: number): void => { const clock = spyOn(Date, 'now').mockReturnValue(now); restores.push(() => clock.mockRestore()); };

type Entry = { lifetime: object; expiresAt: number; tag: string };
const newTable = () => createSingleUseReferenceTable<Entry>();

test('a reference is usable once and a second take reports it spent', () => {
  const lifetime = {}; const table = newTable(); table.synchronize(lifetime);
  const { reference } = table.issue({ lifetime, tag: 'a' });
  expect(table.take(reference)).toMatchObject({ entry: { tag: 'a' }, spent: false });
  expect(table.take(reference)).toEqual({ entry: undefined, spent: true });
});

test('an unknown reference is stale, not spent', () => {
  const table = newTable(); table.synchronize({});
  expect(table.take('never-issued')).toEqual({ entry: undefined, spent: false });
});

test('a reference past its lifetime is dropped on the next synchronize', () => {
  freeze(1_000);
  const lifetime = {}; const table = newTable(); table.synchronize(lifetime);
  const { reference, expiresAt } = table.issue({ lifetime, tag: 'a' });
  freeze(expiresAt);
  table.synchronize(lifetime);
  expect(table.take(reference).entry).toBeUndefined();
});

test('a new serving lifetime drops every reference and the spent record', () => {
  const first = {}; const table = newTable(); table.synchronize(first);
  const { reference } = table.issue({ lifetime: first, tag: 'a' });
  table.take(reference);
  table.synchronize({});
  expect(table.take(reference)).toEqual({ entry: undefined, spent: false });
});

test('references past the cap evict the oldest first', () => {
  const lifetime = {}; const table = newTable(); table.synchronize(lifetime);
  const refs = Array.from({ length: 257 }, (_, i) => table.issue({ lifetime, tag: String(i) }).reference);
  expect(table.take(refs[0]!).entry).toBeUndefined();
  expect(table.take(refs[256]!).entry?.tag).toBe('256');
});

test('the spent record is bounded so the oldest spent reference reads as stale again', () => {
  const lifetime = {}; const table = newTable(); table.synchronize(lifetime);
  const first = table.issue({ lifetime, tag: 'first' }).reference;
  table.take(first);
  for (let i = 0; i < 256; i++) table.take(`other-${i}`);
  expect(table.take(first).spent).toBe(false);
});
