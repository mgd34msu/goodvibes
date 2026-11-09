import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureUpdateFileIo, realUpdateFileIo } from '../platform/src/platform/runtime/self-update.ts';
import { retainDaemonNativeFiles, createDaemonNativeRenameGuard } from '../platform/src/platform/runtime/daemon-native-cohort.ts';
import { nativeMemoryIo } from './_helpers/daemon-native-cohort.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-file-owner-')); roots.push(root);
  const directory = join(root, 'installation'); mkdirSync(directory);
  const path = join(directory, 'goodvibes-daemon'); writeFileSync(path, 'original payload');
  const target = { path, label: 'daemon', assetName: 'daemon', executable: false };
  return { root, directory, path, target };
}

for (const captureDepth of [0, 1, 2]) test(`actual native retention keeps file/parent revisions across ${captureDepth} I/O captures`, () => {
  const f = fixture(); let io = realUpdateFileIo;
  for (let index = 0; index < captureDepth; index++) io = captureUpdateFileIo(io);
  const current = retainDaemonNativeFiles([f.target], io);
  expect(() => current()).not.toThrow();
  const original = statSync(f.path);
  writeFileSync(f.path, 'modified payload'); utimesSync(f.path, original.atime, original.mtime);
  expect(() => current()).toThrow('changed');
});

test('equal-byte native replacement and directory replacement retire their original observations', () => {
  const f = fixture(); const io = captureUpdateFileIo(realUpdateFileIo);
  const current = retainDaemonNativeFiles([f.target], io);
  const replacement = f.path + '.replacement'; writeFileSync(replacement, readFileSync(f.path)); renameSync(replacement, f.path);
  expect(() => current()).toThrow('changed');
  const afterFileReplacement = retainDaemonNativeFiles([f.target], io);
  renameSync(f.directory, f.directory + '.retained'); mkdirSync(f.directory); writeFileSync(f.path, 'original payload');
  expect(() => afterFileReplacement()).toThrow('changed');
});

const permissionsTest = process.platform !== 'win32' && process.getuid?.() !== 0 ? test : test.skip;
permissionsTest('native retention observes revisions without reopening binary contents', () => {
  const f = fixture(); chmodSync(f.path, 0);
  try {
    expect(() => readFileSync(f.path)).toThrow();
    const io = captureUpdateFileIo(captureUpdateFileIo(realUpdateFileIo));
    const current = retainDaemonNativeFiles([f.target], io);
    expect(() => current()).not.toThrow();
    // Wrapping the native reader is not proof that an adapter's metadata is
    // trustworthy; its fallback must still try to retain the original bytes.
    expect(() => retainDaemonNativeFiles([f.target], captureUpdateFileIo({ ...io, readFile: path => readFileSync(path) }))).toThrow();
  } finally { chmodSync(f.path, 0o600); }
});

test('frozen borrowed I/O with stable metadata still detects changed shared bytes', () => {
  const path = '/native-adapter/daemon'; const memory = nativeMemoryIo({ [path]: Buffer.from('original') });
  const shared = Buffer.from('original'); let reads = 0;
  const io = captureUpdateFileIo(captureUpdateFileIo(Object.freeze({ ...memory.io, readFile: () => { reads++; return shared; } })));
  const current = retainDaemonNativeFiles([{ path, label: 'daemon', assetName: 'daemon', executable: true }], io);
  expect(() => current()).not.toThrow(); const before = reads;
  shared.write('modified');
  expect(() => current()).toThrow('changed'); expect(reads).toBeGreaterThan(before);
});

test('borrowed mutable observation objects cannot rewrite their retained original identity', () => {
  const path = '/native-adapter/daemon'; const memory = nativeMemoryIo({ [path]: Buffer.from('same bytes') });
  const stat = { identity: 'original', ownerIdentity: 'original', mode: 0o755 };
  const io = captureUpdateFileIo({ ...memory.io, observe: target => target === path ? stat : null });
  const current = retainDaemonNativeFiles([{ path, label: 'daemon', assetName: 'daemon', executable: true }], io);
  stat.identity = 'foreign'; stat.ownerIdentity = 'foreign';
  expect(() => current()).toThrow('changed');
});

test('borrowed rename destinations must retain exact original bytes despite stable metadata', () => {
  const path = '/native-adapter/daemon'; const memory = nativeMemoryIo({ [path]: Buffer.from('original') });
  const io = captureUpdateFileIo(memory.io);
  const guard = createDaemonNativeRenameGuard([{ path, label: 'daemon', assetName: 'daemon', executable: true }], io);
  guard.beforeRename(path, path + '.previous', false);
  io.rename(path, path + '.previous'); memory.files.set(path + '.previous', Buffer.from('modified'));
  expect(() => guard.afterRename(path, path + '.previous', false)).toThrow('rename result is unknown');
});

test('real rename observations advance only after exact bytes and physical ownership match', () => {
  const f = fixture(); const io = captureUpdateFileIo(realUpdateFileIo);
  const guard = createDaemonNativeRenameGuard([f.target], io);
  guard.beforeRename(f.path, f.path + '.previous', false); io.rename(f.path, f.path + '.previous');
  guard.afterRename(f.path, f.path + '.previous', false);
  guard.beforeRename(f.path + '.previous', f.path, true); io.rename(f.path + '.previous', f.path);
  guard.afterRename(f.path + '.previous', f.path, true);
  expect(readFileSync(f.path, 'utf8')).toBe('original payload');
});
