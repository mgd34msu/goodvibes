import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetainedFileBytes } from '../sdk/src/platform/utils/retained-file-bytes.js';

const roots: string[] = [];
const bundles = new Set<RetainedFileBytes>();
afterEach(() => {
  try { for (const bundle of bundles) bundle.close(); }
  finally { bundles.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'retained-bytes-test-')); roots.push(root);
  const source = join(root, 'source'), target = join(root, 'target');
  return { root, source, target };
}
function backingDescriptors(): number {
  return readdirSync('/proc/self/fd').filter(name => {
    try { return readlinkSync(`/proc/self/fd/${name}`).includes('/captured-input-bytes-'); }
    catch { return false; }
  }).length;
}

test('one bundle retains exact empty and binary files independently of later source changes', async () => {
  const f = fixture(), empty = join(f.root, 'empty'), tail = join(f.root, 'tail');
  const original = Buffer.alloc(3 * 64 * 1024 + 7, 0x61); original[64 * 1024] = 0xff;
  writeFileSync(f.source, original); writeFileSync(empty, ''); writeFileSync(tail, 'independent tail');
  const retained = await RetainedFileBytes.capture(writer => Promise.all([writer.capture(empty), writer.capture(f.source), writer.capture(tail)] as const));
  bundles.add(retained.files);
  const [zero, binary, last] = retained.value;
  expect(await retained.files.matchesFile(zero, empty)).toBe(true);
  expect(await retained.files.matchesFile(binary, f.source)).toBe(true);
  const changed = Buffer.from(original); changed[64 * 1024] = 0xfe;
  expect(changed.toString('utf8')).toBe(original.toString('utf8'));
  writeFileSync(f.source, changed);
  expect(await retained.files.matchesFile(binary, f.source)).toBe(false);
  await retained.files.copyTo(binary, f.target, 0o600);
  expect(readFileSync(f.target)).toEqual(original);
  await retained.files.copyTo(zero, join(f.root, 'empty-copy'), 0o600);
  expect(readFileSync(join(f.root, 'empty-copy'))).toEqual(Buffer.alloc(0));
  await expect(retained.files.copyTo(binary, f.target, 0o600)).rejects.toThrow();
  retained.files.copyToSync(last, join(f.root, 'tail-copy'), 0o600);
  expect(readFileSync(join(f.root, 'tail-copy'), 'utf8')).toBe('independent tail');
});

test('synchronous publication compares exact bytes and permits replacement only when explicitly selected', async () => {
  const f = fixture(), original = Buffer.alloc(150_001, 0x61); original[70_000] = 0xff;
  writeFileSync(f.source, original);
  const retained = await RetainedFileBytes.capture(writer => writer.capture(f.source)); bundles.add(retained.files);
  expect(retained.files.matchesFileSync(retained.value, f.source)).toBe(true);
  const changed = Buffer.from(original); changed[70_000] = 0xfe;
  writeFileSync(f.source, changed);
  expect(retained.files.matchesFileSync(retained.value, f.source)).toBe(false);
  retained.files.copyToSync(retained.value, f.target, 0o640);
  expect(readFileSync(f.target)).toEqual(original);
  expect(() => retained.files.copyToSync(retained.value, f.target, 0o640)).toThrow();
  retained.files.copyToSync(retained.value, f.target, 0o640, true);
  expect(syncFs.statSync(f.target).mode & 0o777).toBe(0o640);
  retained.files.close();
  expect(() => retained.files.copyToSync(retained.value, join(f.root, 'after-close'), 0o600)).toThrow('unavailable');
  expect(existsSync(join(f.root, 'after-close'))).toBe(false);
});

test('synchronous replacement refuses aliases and hardlinks without truncating their original data', async () => {
  const f = fixture(); writeFileSync(f.source, 'retained'); writeFileSync(f.target, 'keep target');
  const retained = await RetainedFileBytes.capture(writer => writer.capture(f.source)); bundles.add(retained.files);
  const hardlink = join(f.root, 'hardlink'), alias = join(f.root, 'alias');
  syncFs.linkSync(f.target, hardlink); symlinkSync(f.target, alias);
  expect(() => retained.files.copyToSync(retained.value, hardlink, 0o600, true)).toThrow('ordinary owned file');
  expect(() => retained.files.copyToSync(retained.value, alias, 0o600, true)).toThrow();
  expect(readFileSync(f.target, 'utf8')).toBe('keep target');
});

test('synchronous comparison refuses pathname replacement after opening its candidate', async () => {
  const f = fixture(); writeFileSync(f.source, Buffer.alloc(130_000, 0x61)); writeFileSync(f.target, readFileSync(f.source));
  const retained = await RetainedFileBytes.capture(writer => writer.capture(f.source)); bundles.add(retained.files);
  const inode = syncFs.statSync(f.target).ino, read = syncFs.readSync;
  let replaced = false;
  const tap = spyOn(syncFs, 'readSync').mockImplementation((...args: Parameters<typeof read>) => {
    if (!replaced && syncFs.fstatSync(args[0]).ino === inode) {
      replaced = true; renameSync(f.target, join(f.root, 'old-candidate')); writeFileSync(f.target, readFileSync(f.source));
    }
    return Reflect.apply(read, syncFs, args);
  });
  try { expect(() => retained.files.matchesFileSync(retained.value, f.target)).toThrow('changed while comparing'); }
  finally { tap.mockRestore(); }
  expect(replaced).toBe(true);
});

test('slices cannot be forged, copied or moved to another bundle, and closed owners cannot be revived', async () => {
  const f = fixture(); writeFileSync(f.source, 'original');
  const a = await RetainedFileBytes.capture(writer => writer.capture(f.source));
  const b = await RetainedFileBytes.capture(writer => writer.capture(f.source));
  bundles.add(a.files); bundles.add(b.files);
  for (const slice of [{ kind: 'retained-file-slice' as const }, { ...a.value }, b.value]) {
    await expect(a.files.copyTo(slice, f.target, 0o600)).rejects.toThrow('unavailable');
    expect(existsSync(f.target)).toBe(false);
  }
  a.files.close(); a.files.close();
  await expect(a.files.matchesFile(a.value, f.source)).rejects.toThrow('unavailable');
  expect(await b.files.matchesFile(b.value, f.source)).toBe(true);
});

test('source and comparison aliases cannot substitute another file', async () => {
  const f = fixture(); writeFileSync(f.source, 'original'); symlinkSync(f.source, f.target);
  await expect(RetainedFileBytes.capture(writer => writer.capture(f.target))).rejects.toThrow();
  const retained = await RetainedFileBytes.capture(writer => writer.capture(f.source)); bundles.add(retained.files);
  await expect(retained.files.matchesFile(retained.value, f.target)).rejects.toThrow();
});

test('replacing the named comparison file during its read cannot pass using the old open descriptor', async () => {
  const f = fixture(); writeFileSync(f.source, Buffer.alloc(128 * 1024, 0x61));
  const retained = await RetainedFileBytes.capture(writer => writer.capture(f.source)); bundles.add(retained.files);
  writeFileSync(f.target, readFileSync(f.source));
  const open = asyncFs.open;
  const restores: (() => void)[] = [];
  let replaced = false;
  const tap = spyOn(asyncFs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === f.target) {
      const read = handle.read;
      const readTap = spyOn(handle, 'read').mockImplementation((...params) => {
        if (!replaced) { replaced = true; renameSync(f.target, join(f.root, 'old')); writeFileSync(f.target, readFileSync(f.source)); }
        return Reflect.apply(read, handle, params);
      });
      restores.push(() => readTap.mockRestore());
    }
    return handle;
  });
  try { await expect(retained.files.matchesFile(retained.value, f.target)).rejects.toThrow('changed while comparing'); }
  finally { tap.mockRestore(); for (const restore of restores) restore(); }
  expect(replaced).toBe(true);
});

test.skipIf(process.platform !== 'linux')('a bundle holds one unlinked backing descriptor and releases it on close or collection failure', async () => {
  const f = fixture(); writeFileSync(f.source, Buffer.alloc(200_000, 0x61));
  const before = backingDescriptors();
  const retained = await RetainedFileBytes.capture(async writer => {
    for (let index = 0; index < 50; index++) await writer.capture(f.source);
  });
  bundles.add(retained.files);
  expect(backingDescriptors()).toBe(before + 1);
  const backings = readdirSync('/proc/self/fd').flatMap(name => {
    try { const path = readlinkSync(`/proc/self/fd/${name}`); return path.includes('/captured-input-bytes-') ? [path] : []; }
    catch { return []; }
  });
  expect(backings.every(path => path.endsWith(' (deleted)') && !existsSync(path.slice(0, -' (deleted)'.length)))).toBe(true);
  retained.files.close();
  expect(backingDescriptors()).toBe(before);
  const stopped = new Error('stop snapshot collection'), controller = new AbortController();
  await expect(RetainedFileBytes.capture(async writer => {
    await writer.capture(f.source); controller.abort(stopped);
    await writer.capture(f.source);
  }, controller.signal)).rejects.toBe(stopped);
  expect(backingDescriptors()).toBe(before);
  await expect(RetainedFileBytes.capture(async writer => {
    void writer.capture(f.source);
    throw new Error('collector failed');
  })).rejects.toThrow('collector failed');
  expect(backingDescriptors()).toBe(before);
});
