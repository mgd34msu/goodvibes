/** Regression source intentionally UNRUN during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../sdk/src/platform/config/atomic-write.js';
import { AtomicWriteDurabilityError } from '../sdk/src/platform/utils/atomic-json-store.js';
import { captureFileMutation } from '../sdk/src/platform/utils/file-mutation.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
const restore: Array<() => void> = [];
afterEach(() => { for (const close of restore.splice(0).reverse()) close(); });
function fixture() { const root = makeProjectTempDir('config-owned-atomic'); return { root, file: join(root, 'settings.json') }; }
function failure(operation: () => void): AtomicWriteDurabilityError {
  let caught: unknown; try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AtomicWriteDurabilityError); return caught as AtomicWriteDurabilityError;
}
function temporary(root: string, file: string): string | undefined {
  const found = fs.readdirSync(root).find(name => name.startsWith(`${basename(file)}.tmp-`)); return found ? join(root, found) : undefined;
}

test('real captureFileMutation follows only this writer staging and publication directory effects', () => {
  const f = fixture(); fs.writeFileSync(f.file, 'Old image'); const owner = captureFileMutation(f.file), events: boolean[] = [];
  atomicWriteFileSync(f.file, 'New complete image', { assertCurrent: owner.assertCurrent, onEffect(published = false) {
    events.push(published); owner.onEffect(published);
  } });
  owner.assertCurrent(); expect(fs.readFileSync(f.file, 'utf8')).toBe('New complete image');
  expect(events.filter(Boolean)).toEqual([true]); expect(events[0]).toBe(false); expect(events.at(-1)).toBe(true);
  expect(temporary(f.root, f.file)).toBeUndefined();
});

test('nested parent creation advances native parent clocks before the next guarded effect', () => {
  const f = fixture(), file = join(f.root, 'new', 'nested', 'settings.json'), owner = captureFileMutation(file), events: boolean[] = [];
  atomicWriteFileSync(file, 'Created exact image', { mkdirp: true, assertCurrent: owner.assertCurrent, onEffect(published = false) {
    owner.onEffect(published); events.push(published);
  } });
  owner.assertCurrent(); expect(fs.readFileSync(file, 'utf8')).toBe('Created exact image');
  expect(events.filter(value => !value).length).toBeGreaterThanOrEqual(3); expect(events.filter(Boolean)).toEqual([true]);
});

test('default mkdirp false leaves every missing parent absent and reports no effect', () => {
  const f = fixture(), file = join(f.root, 'absent', 'nested', 'settings.json'), effects: boolean[] = [];
  const error = failure(() => atomicWriteFileSync(file, 'Must stay absent', { onEffect(value = false) { effects.push(value); } }));
  expect(error.phase).toBe('before-publication'); expect(fs.existsSync(join(f.root, 'absent'))).toBe(false); expect(effects).toEqual([]);
});

test('a preexisting colliding temporary file survives the configuration wrapper unchanged', () => {
  const f = fixture(); fs.writeFileSync(f.file, 'Original target'); const actual = fs.openSync; let collision: string | undefined;
  const open = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (!collision && typeof path === 'string' && path.startsWith(f.file + '.tmp-')) { collision = path; fs.writeFileSync(path, 'Foreign retained temp', { mode: 0o644 }); }
    return actual(path, flags, mode);
  }); restore.push(() => open.mockRestore());
  expect(failure(() => atomicWriteFileSync(f.file, 'Rejected image')).phase).toBe('before-publication');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Original target'); expect(fs.readFileSync(collision!, 'utf8')).toBe('Foreign retained temp');
  expect(fs.statSync(collision!).mode & 0o777).toBe(0o644);
});

test.each(['file', 'symlink'] as const)('an effect callback cannot publish or clean a foreign %s replacement', kind => {
  const f = fixture(), outside = join(f.root, 'outside'); fs.writeFileSync(f.file, 'Old image'); fs.writeFileSync(outside, 'Outside source', { mode: 0o644 });
  let replaced: string | undefined;
  expect(failure(() => atomicWriteFileSync(f.file, 'Owned next bytes', { onEffect(published) {
    if (published || replaced) return; const path = temporary(f.root, f.file); if (!path) return;
    replaced = path; fs.unlinkSync(path);
    if (kind === 'file') fs.writeFileSync(path, 'Foreign replacement', { mode: 0o644 }); else fs.symlinkSync(outside, path);
  } })).phase).toBe('before-publication');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Old image'); expect(replaced).toBeDefined();
  expect(fs.lstatSync(replaced!).isSymbolicLink()).toBe(kind === 'symlink');
  expect(fs.readFileSync(replaced!, 'utf8')).toBe(kind === 'file' ? 'Foreign replacement' : 'Outside source');
  expect(fs.readFileSync(outside, 'utf8')).toBe('Outside source'); expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
});

test('published ownership advances before a later durability failure and the image remains visible', () => {
  const f = fixture(); fs.writeFileSync(f.file, 'Old image'); const owner = captureFileMutation(f.file), effects: boolean[] = [], actual = fs.fsyncSync;
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('Directory durability unavailable'); actual(fd); }); restore.push(() => sync.mockRestore());
  const error = failure(() => atomicWriteFileSync(f.file, 'Visible next image', { assertCurrent: owner.assertCurrent, onEffect(published = false) { owner.onEffect(published); effects.push(published); } }));
  expect(error.phase).toBe('published-indeterminate'); expect(effects.filter(Boolean)).toEqual([true]);
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Visible next image'); owner.assertCurrent();
});

test('a rename whose native effect preceded its throw still reports its confirmed original publication once', () => {
  const f = fixture(); fs.writeFileSync(f.file, 'Old image'); const owner = captureFileMutation(f.file), effects: boolean[] = [], actual = fs.renameSync;
  const rename = spyOn(fs, 'renameSync').mockImplementation((...args) => { actual(...args); throw new Error('Native acknowledgment lost'); }); restore.push(() => rename.mockRestore());
  const error = failure(() => atomicWriteFileSync(f.file, 'Published exact image', { assertCurrent: owner.assertCurrent, onEffect(published = false) { owner.onEffect(published); effects.push(published); } }));
  expect(error.phase).toBe('published-indeterminate'); expect(effects.filter(Boolean)).toEqual([true]);
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Published exact image'); owner.assertCurrent();
});

test('a failing post-publication listener cannot cause duplicate notifications or rollback', () => {
  const f = fixture(); fs.writeFileSync(f.file, 'Old image'); let publications = 0;
  const error = failure(() => atomicWriteFileSync(f.file, 'Visible image', { onEffect(published) { if (published) { publications++; throw new Error('Consumer retired after publication'); } } }));
  expect(error.phase).toBe('published-indeterminate'); expect(publications).toBe(1); expect(fs.readFileSync(f.file, 'utf8')).toBe('Visible image');
});

test('stable configured aliases retain their physical target and requested binary modes under umask', () => {
  const f = fixture(), physical = join(f.root, 'physical'), alias = join(f.root, 'alias'); fs.mkdirSync(physical); fs.symlinkSync(physical, alias);
  const previous = process.umask(0o777), input = new Uint8Array([0, 255, 128, 10]);
  try {
    atomicWriteFileSync(join(alias, 'new', 'exact.bin'), input, { mkdirp: true, mode: 0o640, onEffect() { input.fill(42); } });
    const target = join(physical, 'new', 'exact.bin'); expect([...fs.readFileSync(target)]).toEqual([0, 255, 128, 10]); expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  } finally { process.umask(previous); }
});

test('same-length same-inode edits by a publication listener retire the image despite retaining the inode', () => {
  const f = fixture(); fs.writeFileSync(f.file, 'Old image'); let publications = 0;
  const error = failure(() => atomicWriteFileSync(f.file, 'Owned new bytes', { onEffect(published) {
    if (!published) return; publications++;
    const before = fs.statSync(f.file); fs.writeFileSync(f.file, 'Foreign content'); fs.utimesSync(f.file, before.atime, before.mtime);
  } }));
  expect(error.phase).toBe('published-indeterminate'); expect(publications).toBe(1);
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Foreign content');
});
