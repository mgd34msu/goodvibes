/**
 * The durable writer used for settings, secrets, ledgers and offsets: a
 * document is replaced whole or not at all, a writer that lost its right to
 * write between staging and publication leaves the current document alone, and
 * what it writes is readable by the owner only unless the caller says otherwise.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../platform/src/platform/config/atomic-write.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-atomic-write-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('a write replaces the document whole, exact to the byte, readable by the owner only', () => {
  const path = join(dir, 'secret.json');
  atomicWriteFileSync(path, 'first version, longer than the second');
  atomicWriteFileSync(path, 'second');
  expect(readFileSync(path, 'utf8')).toBe('second');
  expect(statSync(path).mode & 0o777).toBe(0o600);

  const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f, 0xde, 0xad, 0xbe, 0xef]);
  atomicWriteFileSync(path, bytes);
  expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
});

test('a write that fails before publication leaves the original document untouched', () => {
  // A name near NAME_MAX fits, but its staging name does not: the write fails before anything replaces it.
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const path = join(sub, `${'a'.repeat(240)}.json`);
  writeFileSync(path, 'original content');
  expect(() => atomicWriteFileSync(path, 'new content that must not land')).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('original content');
});

test('a writer whose operation stopped being current while it staged does not replace the document', () => {
  const path = join(dir, 'settings.json');
  atomicWriteFileSync(path, 'written by the current owner');
  let checks = 0;
  // Current when the write starts; superseded by the time it would publish.
  const assertCurrent = (): void => { checks += 1; if (checks > 1) throw new Error('superseded'); };
  expect(() => atomicWriteFileSync(path, 'stale writer', { assertCurrent })).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('written by the current owner');
});
