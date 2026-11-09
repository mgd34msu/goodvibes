/** Regression source intentionally unrun during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { AtomicWriteDurabilityError, captureExistingDirectory, STALE_TEMP_FILE_MIN_AGE_MS, writeFileAtomic, writeJsonFileAtomic } from '../platform/src/platform/utils/atomic-json-store.js';
const restore: Array<() => void> = [];
afterEach(() => { for (const close of restore.splice(0).reverse()) close(); });
function fixture() { const root = makeProjectTempDir('atomic-owned-file'); return { root, file: join(root, 'state.json') }; }
function temp(root: string, file: string): string | undefined {
  const name = fs.readdirSync(root).find(value => value.startsWith(`${basename(file)}.tmp-`)); return name ? join(root, name) : undefined;
}
function durableFailure(operation: () => void): AtomicWriteDurabilityError {
  let caught: unknown; try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AtomicWriteDurabilityError); return caught as AtomicWriteDurabilityError;
}

test.each(['file', 'symlink'] as const)('an exclusive temp %s collision preserves the preexisting source and target', kind => {
  const f = fixture(), foreign = join(f.root, 'foreign'); fs.writeFileSync(foreign, 'Foreign original', { mode: 0o644 });
  writeFileAtomic(f.file, 'Previous image'); const previous = fs.readFileSync(f.file);
  const actual = fs.openSync; let collision: string | undefined;
  const open = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (!collision && typeof path === 'string' && path.startsWith(`${f.file}.tmp-`)) {
      collision = path;
      if (kind === 'symlink') fs.symlinkSync(foreign, path); else fs.writeFileSync(path, 'Preexisting staging source', { mode: 0o644 });
    }
    return actual(path, flags, mode);
  }); restore.push(() => open.mockRestore());
  expect(() => writeFileAtomic(f.file, 'Must not replace foreign staging', { cleanupStaleTemps: false })).toThrow();
  expect(fs.readFileSync(f.file)).toEqual(previous); expect(collision).toBeDefined();
  expect(fs.lstatSync(collision!).isSymbolicLink()).toBe(kind === 'symlink');
  expect(fs.readFileSync(collision!, 'utf8')).toBe(kind === 'symlink' ? 'Foreign original' : 'Preexisting staging source');
  expect(fs.readFileSync(foreign, 'utf8')).toBe('Foreign original'); expect(fs.statSync(foreign).mode & 0o777).toBe(0o644);
});

test('a borrowed guard cannot replace the owned stage with a foreign file and have it published or cleaned', () => {
  const f = fixture(); writeFileAtomic(f.file, 'Previous image');
  const retained = join(f.root, 'retained-original-stage'); let replacement: string | undefined;
  expect(() => writeFileAtomic(f.file, 'Requested next bytes', { cleanupStaleTemps: false, assertCurrent() {
    if (replacement) return;
    const path = temp(f.root, f.file);
    if (path && fs.statSync(path).size > 0) {
      replacement = path; fs.renameSync(path, retained); fs.writeFileSync(path, 'Foreign replacement', { mode: 0o644 });
    }
  } })).toThrow('staging');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Previous image'); expect(replacement).toBeDefined();
  expect(fs.readFileSync(replacement!, 'utf8')).toBe('Foreign replacement'); expect(fs.statSync(replacement!).mode & 0o777).toBe(0o644);
  expect(fs.readFileSync(retained, 'utf8')).toBe('Requested next bytes');
});

test('same-inode staging edits cannot become the requested atomic image', () => {
  const f = fixture(); writeFileAtomic(f.file, 'Previous image'); let mutated = false;
  expect(() => writeFileAtomic(f.file, 'Requested bytes', { cleanupStaleTemps: false, assertCurrent() {
    if (mutated) return; const path = temp(f.root, f.file);
    if (path && fs.statSync(path).size > 0) { mutated = true; fs.writeFileSync(path, 'Incorrect bytes'); }
  } })).toThrow();
  expect(mutated).toBe(true); expect(fs.readFileSync(f.file, 'utf8')).toBe('Previous image');
});

test('retargeting an existing configured alias in the first guard creates nothing in the replacement tree', () => {
  const f = fixture(), first = join(f.root, 'first'), second = join(f.root, 'second'), alias = join(f.root, 'alias');
  fs.mkdirSync(first); fs.mkdirSync(second); fs.symlinkSync(first, alias); let changed = false;
  expect(() => writeFileAtomic(join(alias, 'new', 'nested', 'state.json'), 'Private bytes', { assertCurrent() {
    if (!changed) { changed = true; fs.unlinkSync(alias); fs.symlinkSync(second, alias); }
  } })).toThrow('parent');
  expect(fs.existsSync(join(first, 'new'))).toBe(false); expect(fs.existsSync(join(second, 'new'))).toBe(false);
});

test('stable configured alias chains and symlink-aware parent traversal keep their actual destination', () => {
  const f = fixture(), outside = join(f.root, 'physical'), aliases = join(f.root, 'aliases');
  fs.mkdirSync(join(outside, 'child'), { recursive: true }); fs.mkdirSync(aliases);
  fs.symlinkSync('../physical/child', join(aliases, 'selected'));
  const file = `${join(aliases, 'selected')}/../new/state.json`;
  writeJsonFileAtomic(file, { originalPhysicalParent: true }, { durable: true });
  expect(JSON.parse(fs.readFileSync(join(outside, 'new', 'state.json'), 'utf8'))).toEqual({ originalPhysicalParent: true });
  expect(fs.existsSync(join(aliases, 'new'))).toBe(false);
});

test('read-only alias dot-dot capture keeps the actual parent and rejects replacement even with the same target', () => {
  const f = fixture(), physical = join(f.root, 'physical'), alias = join(f.root, 'alias');
  fs.mkdirSync(join(physical, 'child'), { recursive: true }); fs.symlinkSync(join(physical, 'child'), alias);
  const selected = captureExistingDirectory(`${alias}/..`);
  expect(selected.canonical).toBe(physical); selected.assertCurrent();
  fs.unlinkSync(alias); fs.symlinkSync(join(physical, 'child'), alias);
  expect(() => selected.assertCurrent()).toThrow('alias changed');
  // Retiring configured lookup does not transfer or destroy the original tree;
  // physical-only compensation still refers to that unchanged physical parent.
  expect(() => selected.assertPhysicalCurrent()).not.toThrow();
  expect(fs.readdirSync(physical)).toEqual(['child']);
});

test('a dangling parent alias never grants creation of its outside target', () => {
  const f = fixture(), outside = join(f.root, 'unselected-outside'), alias = join(f.root, 'dangling');
  fs.symlinkSync(outside, alias);
  expect(() => writeFileAtomic(join(alias, 'new', 'state.json'), 'Private bytes')).toThrow();
  expect(fs.existsSync(outside)).toBe(false);
});

test('failed publication preserves a foreign temp replacement installed while throwing', () => {
  const f = fixture(); writeFileAtomic(f.file, 'Previous image'); let replacement: string | undefined;
  expect(() => writeFileAtomic(f.file, 'Next image', { cleanupStaleTemps: false, assertCurrent() {
    if (replacement) return; const path = temp(f.root, f.file);
    if (path) { replacement = path; fs.unlinkSync(path); fs.writeFileSync(path, 'Foreign retained evidence'); throw new Error('Owner retired'); }
  } })).toThrow('retired');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Previous image'); expect(fs.readFileSync(replacement!, 'utf8')).toBe('Foreign retained evidence');
});

test('a rename that took effect before throwing remains published-indeterminate and retains the visible image', () => {
  const f = fixture(); writeFileAtomic(f.file, 'Previous image'); const actual = fs.renameSync;
  const rename = spyOn(fs, 'renameSync').mockImplementation((...args) => { actual(...args); throw new Error('Lost native rename acknowledgment'); });
  restore.push(() => rename.mockRestore());
  const error = durableFailure(() => writeFileAtomic(f.file, 'Visible next image', { durable: true }));
  expect(error.phase).toBe('published-indeterminate'); expect(fs.readFileSync(f.file, 'utf8')).toBe('Visible next image');
});

test('actual pre-effect rename failure remains before-publication with the old image intact', () => {
  const f = fixture(); writeFileAtomic(f.file, 'Previous image');
  const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Native rename was refused'); }); restore.push(() => rename.mockRestore());
  expect(durableFailure(() => writeFileAtomic(f.file, 'Next image', { durable: true })).phase).toBe('before-publication');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Previous image'); expect(temp(f.root, f.file)).toBeUndefined();
});

test('live and unknown writer identities are not swept merely because their files are old', () => {
  const f = fixture(), live = `${f.file}.tmp-${process.pid}-older-live`, unknown = `${f.file}.tmp-unknown-writer`;
  fs.writeFileSync(live, 'Live owned work'); fs.writeFileSync(unknown, 'Unknown owner');
  const old = new Date(Date.now() - STALE_TEMP_FILE_MIN_AGE_MS - 60_000); fs.utimesSync(live, old, old); fs.utimesSync(unknown, old, old);
  writeFileAtomic(f.file, 'Current image'); expect(fs.readFileSync(live, 'utf8')).toBe('Live owned work'); expect(fs.readFileSync(unknown, 'utf8')).toBe('Unknown owner');
});

test('a proven-dead native writer can have its old regular staging file reclaimed', () => {
  const f = fixture(), child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  expect(child.status).toBe(0); const dead = `${f.file}.tmp-${child.pid}-crash-source`;
  fs.writeFileSync(dead, 'Old crashed write'); const old = new Date(Date.now() - STALE_TEMP_FILE_MIN_AGE_MS - 60_000); fs.utimesSync(dead, old, old);
  writeFileAtomic(f.file, 'Current image'); expect(fs.existsSync(dead)).toBe(false);
});

test('private binary bytes and public text modes remain exact under restrictive umask', () => {
  const f = fixture(), binary = Buffer.from([0, 255, 128, 10, 0]), expected = Buffer.from(binary), previous = process.umask(0o777);
  try {
    writeFileAtomic(f.file, binary, { durable: true, assertCurrent() { binary.fill(42); } });
    expect(fs.readFileSync(f.file)).toEqual(expected); expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    writeFileAtomic(join(f.root, 'nested', 'wrapper.sh'), '#!/bin/sh\\necho exact\\n', { mode: 0o755, durable: true });
    expect(fs.statSync(join(f.root, 'nested', 'wrapper.sh')).mode & 0o777).toBe(0o755);
  } finally { process.umask(previous); }
});

test('non-values cannot serialize to invalid JSON and overwrite an existing store', () => {
  const f = fixture(); writeJsonFileAtomic(f.file, { previous: true }); const before = fs.readFileSync(f.file);
  expect(durableFailure(() => writeJsonFileAtomic(f.file, undefined, { durable: true })).phase).toBe('before-publication');
  expect(fs.readFileSync(f.file)).toEqual(before);
});


test('a guard-created temp symlink cannot change the outside file or its permissions', () => {
  const f = fixture(), outside = join(f.root, 'outside'); fs.writeFileSync(outside, 'Outside original', { mode: 0o644 });
  writeFileAtomic(f.file, 'Previous image'); let replaced: string | undefined;
  expect(() => writeFileAtomic(f.file, 'Requested bytes', { assertCurrent() {
    if (replaced) return; const path = temp(f.root, f.file);
    if (path && fs.statSync(path).size > 0) { replaced = path; fs.unlinkSync(path); fs.symlinkSync(outside, path); }
  } })).toThrow('staging');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Previous image'); expect(fs.readFileSync(outside, 'utf8')).toBe('Outside original');
  expect(fs.statSync(outside).mode & 0o777).toBe(0o644); expect(fs.lstatSync(replaced!).isSymbolicLink()).toBe(true);
});

test('physical parent replacement cannot publish or remove files in the replacement directory', () => {
  const f = fixture(), original = join(f.root, 'original'), retained = join(f.root, 'retained'); fs.mkdirSync(original);
  const file = join(original, 'state.json'); writeFileAtomic(file, 'Original target'); let foreign: string | undefined;
  expect(() => writeFileAtomic(file, 'Must not enter replacement', { assertCurrent() {
    if (foreign) return; const path = temp(original, file);
    if (path) {
      fs.renameSync(original, retained); fs.mkdirSync(original); foreign = join(original, basename(path));
      fs.writeFileSync(foreign, 'Foreign stage'); fs.writeFileSync(file, 'Foreign target');
    }
  } })).toThrow('parent');
  expect(fs.readFileSync(file, 'utf8')).toBe('Foreign target'); expect(fs.readFileSync(foreign!, 'utf8')).toBe('Foreign stage');
  expect(fs.readFileSync(join(retained, 'state.json'), 'utf8')).toBe('Original target');
});

test('retiring only a configured alias still cleans the original owned temp in its unchanged physical directory', () => {
  const f = fixture(), first = join(f.root, 'first'), second = join(f.root, 'second'), alias = join(f.root, 'alias');
  fs.mkdirSync(first); fs.mkdirSync(second); fs.symlinkSync(first, alias);
  const file = join(alias, 'state.json'); writeFileAtomic(file, 'Original target'); let changed = false;
  expect(() => writeFileAtomic(file, 'Next target', { assertCurrent() {
    if (!changed && temp(first, file)) { changed = true; fs.unlinkSync(alias); fs.symlinkSync(second, alias); }
  } })).toThrow('parent');
  expect(fs.readFileSync(join(first, 'state.json'), 'utf8')).toBe('Original target');
  expect(temp(first, file)).toBeUndefined(); expect(fs.readdirSync(second)).toEqual([]);
});
