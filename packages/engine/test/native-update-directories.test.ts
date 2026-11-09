/** Native filesystem regression source. Execution is deferred until coding finishes. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { prepareNativeDirectoryRollback, prepareNativeUpdateDirectory, retainNativeUpdateTree,
  NATIVE_UPDATE_DIRECTORY_RELEASE_FILE, NativeDirectoryUpdateError } from '../platform/src/platform/runtime/update-directories.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'native-directory-update-')), target = join(root, 'webui');
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(target); fs.writeFileSync(join(target, 'index.html'), 'old');
  return { root, target, previous: `${target}.previous`, claim: `${target}.directory-update.lock` };
}
function archive(entries: readonly { path: string; data?: string; kind?: string; mode?: number }[], terminated = true): Buffer {
  const blocks: Buffer[] = [];
  for (const value of entries) {
    const data = Buffer.from(value.data ?? ''), header = Buffer.alloc(512);
    header.write(value.path, 0, 100); header.write((value.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); header.fill(32, 148, 156);
    header.write(value.kind ?? '0', 156, 1); header.write('ustar\0', 257, 6);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (terminated) blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const next = () => archive([{ path: 'dist/index.html', data: 'new' }, { path: 'dist/assets/run.sh', data: 'run', mode: 0o755 }]);
const options = { stripComponents: 1, expectedRoot: 'dist', requiredFiles: ['index.html'], sourceVersion: '3.1.3' } as const;
const content = (path: string) => fs.readFileSync(join(path, 'index.html'), 'utf8');

test('stage first, commit reversibly, preserve unknown previous/incoming and report saved history', () => {
  const f = fixture(); fs.mkdirSync(f.previous); fs.writeFileSync(join(f.previous, 'index.html'), 'unknown older');
  fs.mkdirSync(`${f.target}.incoming`); fs.writeFileSync(join(`${f.target}.incoming`, 'keep'), 'foreign');
  const retainedTarget = retainNativeUpdateTree(f.target), handle = prepareNativeUpdateDirectory(f.target, next(), { ...options, retainedTarget });
  expect(content(f.target)).toBe('old'); expect(content(f.previous)).toBe('unknown older'); expect(fs.existsSync(f.claim)).toBe(true);
  expect(() => prepareNativeUpdateDirectory(f.target, next(), options)).toThrow();
  handle.commit(); expect(content(f.target)).toBe('new'); expect(content(f.previous)).toBe('old');
  handle.restore(); expect(content(f.target)).toBe('old'); expect(content(f.previous)).toBe('unknown older');
  handle.commit(); const finished = handle.finish();
  expect(finished.preservedPaths).toHaveLength(1); expect(content(finished.preservedPaths[0]!)).toBe('unknown older');
  expect(fs.readFileSync(join(`${f.target}.incoming`, 'keep'), 'utf8')).toBe('foreign'); expect(fs.existsSync(f.claim)).toBe(false);
  expect(JSON.parse(fs.readFileSync(join(f.target, NATIVE_UPDATE_DIRECTORY_RELEASE_FILE), 'utf8'))).toEqual({ schema: 1, version: '3.1.3' });
});

test('a failed final rename compensates both original live and old previous without deleting either', () => {
  const f = fixture(); fs.mkdirSync(f.previous); fs.writeFileSync(join(f.previous, 'index.html'), 'older');
  const handle = prepareNativeUpdateDirectory(f.target, next(), options), rename = fs.renameSync;
  const failure = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from).endsWith('/incoming') && String(to) === f.target) throw new Error('Synthetic final rename failure');
    return rename(from, to);
  });
  try { expect(() => handle.commit()).toThrow(NativeDirectoryUpdateError); }
  finally { failure.mockRestore(); }
  expect(handle.recoveryRequired).toBe(false); expect(content(f.target)).toBe('old'); expect(content(f.previous)).toBe('older');
  handle.dispose(); expect(fs.existsSync(f.claim)).toBe(false);
});

test('blocked compensation keeps its actual claim until original paths can be restored', () => {
  const f = fixture(), handle = prepareNativeUpdateDirectory(f.target, next(), options), rename = fs.renameSync;
  const failure = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === f.target) throw new Error('Synthetic commit and compensation failure'); return rename(from, to);
  });
  try { expect(() => handle.commit()).toThrow(); expect(handle.recoveryRequired).toBe(true); expect(() => handle.dispose()).toThrow(); }
  finally { failure.mockRestore(); }
  expect(fs.existsSync(f.claim)).toBe(true); expect(content(f.previous)).toBe('old');
  handle.restore(); handle.dispose(); expect(content(f.target)).toBe('old'); expect(fs.existsSync(f.claim)).toBe(false);
});

test('pre-network target observations reject an identical-byte replacement before staging', () => {
  const f = fixture(), retainedTarget = retainNativeUpdateTree(f.target);
  fs.renameSync(f.target, join(f.root, 'retired')); fs.mkdirSync(f.target); fs.writeFileSync(join(f.target, 'index.html'), 'old');
  expect(() => prepareNativeUpdateDirectory(f.target, next(), { ...options, retainedTarget })).toThrow();
  expect(content(f.target)).toBe('old'); expect(fs.existsSync(f.claim)).toBe(false);
});

test('disposal preserves altered private staging and releases the claim when original live slots remain proven', () => {
  const f = fixture(), handle = prepareNativeUpdateDirectory(f.target, next(), options);
  const work = join(f.root, fs.readdirSync(f.root).find(name => name.startsWith('.webui.update-'))!), leaf = join(work, 'incoming', 'index.html');
  fs.unlinkSync(leaf); fs.writeFileSync(leaf, 'foreign replacement');
  expect(() => handle.assertCurrent()).toThrow(); const discarded = handle.dispose();
  expect(discarded.preservedPaths).toContain(work); expect(handle.recoveryRequired).toBe(false);
  expect(fs.readFileSync(leaf, 'utf8')).toBe('foreign replacement'); expect(content(f.target)).toBe('old'); expect(fs.existsSync(f.claim)).toBe(false);
});

test('original physical parents prevent cleanup or claim release through a replacement directory', () => {
  const f = fixture(), handle = prepareNativeUpdateDirectory(f.target, next(), options), retired = `${f.root}-retired`;
  cleanup.push(() => fs.rmSync(retired, { recursive: true, force: true }));
  const claim = fs.readFileSync(f.claim); fs.renameSync(f.root, retired); fs.mkdirSync(f.root);
  fs.writeFileSync(f.claim, claim); fs.writeFileSync(join(f.root, 'foreign'), 'keep');
  expect(() => handle.dispose()).toThrow(); expect(fs.readFileSync(f.claim)).toEqual(claim);
  expect(fs.readFileSync(join(f.root, 'foreign'), 'utf8')).toBe('keep');
});

test('failed extraction never follows a substituted staging parent into another directory', () => {
  const f = fixture(), outside = join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'index.html'), 'outside'); let replaced = false;
  expect(() => prepareNativeUpdateDirectory(f.target, next(), { ...options, assertCurrent() {
    const work = fs.readdirSync(f.root).find(name => name.startsWith('.webui.update-'));
    if (!work || replaced) return; const path = join(f.root, work, 'incoming'); if (!fs.existsSync(path)) return;
    fs.rmdirSync(path); fs.symlinkSync(outside, path, 'dir'); replaced = true;
  } })).toThrow();
  expect(replaced).toBe(true); expect(fs.readFileSync(join(outside, 'index.html'), 'utf8')).toBe('outside'); expect(content(f.target)).toBe('old');
});

for (const [name, bytes] of [
  ['traversal', archive([{ path: 'dist/../escape', data: 'bad' }])],
  ['link', archive([{ path: 'dist/alias', kind: '2' }])],
  ['duplicate', archive([{ path: 'dist/index.html', data: 'one' }, { path: 'dist/index.html', data: 'two' }])],
  ['unterminated', archive([{ path: 'dist/index.html', data: 'bad' }], false)],
  ['wrong root', archive([{ path: 'wrong/index.html', data: 'bad' }])],
  ['missing required file', archive([{ path: 'dist/other', data: 'bad' }])],
  ['reserved marker', archive([{ path: `dist/${NATIVE_UPDATE_DIRECTORY_RELEASE_FILE}`, data: '{}' }])],
] as const) test(`reject ${name} before claims/staging or live modification`, () => {
  const f = fixture(); expect(() => prepareNativeUpdateDirectory(f.target, bytes, options)).toThrow();
  expect(content(f.target)).toBe('old'); expect(fs.readdirSync(f.root)).toEqual(['webui']);
});

test('release-bound rollback is reversible and leaves the rolled-forward tree as previous', () => {
  const f = fixture(); fs.writeFileSync(join(f.target, NATIVE_UPDATE_DIRECTORY_RELEASE_FILE), JSON.stringify({ schema: 1, version: '3.1.2' }));
  const update = prepareNativeUpdateDirectory(f.target, next(), options); update.commit(); update.finish();
  const rollback = prepareNativeDirectoryRollback(f.target); expect(rollback.previousVersion).toBe('3.1.2');
  rollback.commit(); expect(content(f.target)).toBe('old'); expect(content(f.previous)).toBe('new');
  rollback.restore(); expect(content(f.target)).toBe('new'); expect(content(f.previous)).toBe('old');
  rollback.commit(); rollback.finish(); expect(content(f.target)).toBe('old'); expect(content(f.previous)).toBe('new');
});

test('archive permissions remain usable and exact under a restrictive umask', () => {
  const f = fixture(), before = process.umask(0o777);
  try {
    const handle = prepareNativeUpdateDirectory(f.target, next(), options); handle.commit(); handle.finish();
    expect(fs.statSync(join(f.target, 'index.html')).mode & 0o777).toBe(0o644);
    expect(fs.statSync(join(f.target, 'assets', 'run.sh')).mode & 0o777).toBe(0o755);
  } finally { process.umask(before); }
});

test('a file replacement after native byte writing is not adopted as staged release content or cleaned up', () => {
  const f = fixture(), write = fs.writeFileSync; let replaced: string | undefined;
  const injection = spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
    const result = write(path, data, options);
    if (typeof path === 'number' && !replaced) {
      const work = fs.readdirSync(f.root).find(name => name.startsWith('.webui.update-'));
      if (work) {
        const leaf = join(f.root, work, 'incoming', 'index.html');
        if (fs.existsSync(leaf)) { fs.renameSync(leaf, join(f.root, 'retired-created-leaf')); write(leaf, 'foreign bytes'); replaced = leaf; }
      }
    }
    return result;
  });
  try { expect(() => prepareNativeUpdateDirectory(f.target, next(), options)).toThrow(); }
  finally { injection.mockRestore(); }
  expect(replaced).toBeDefined(); expect(fs.readFileSync(replaced!, 'utf8')).toBe('foreign bytes');
  expect(content(f.target)).toBe('old'); expect(fs.existsSync(f.claim)).toBe(false);
});

test('unknown staged children are preserved and never silently included in the selected release', () => {
  const f = fixture(); let foreign: string | undefined;
  expect(() => prepareNativeUpdateDirectory(f.target, next(), { ...options, assertCurrent() {
    if (foreign) return;
    const work = fs.readdirSync(f.root).find(name => name.startsWith('.webui.update-')); if (!work) return;
    const destination = join(f.root, work, 'incoming'); if (!fs.existsSync(join(destination, 'index.html'))) return;
    foreign = join(destination, 'unknown.txt'); fs.writeFileSync(foreign, 'keep');
  } })).toThrow();
  expect(foreign).toBeDefined(); expect(fs.readFileSync(foreign!, 'utf8')).toBe('keep'); expect(content(f.target)).toBe('old');
});
