import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { assertNativeArtifactFilesCurrent, nativeArtifactPins, readNativeArtifactFile, retainNativeArtifactFiles, type RetainedNativeArtifactFiles } from '@goodvibes-jev/engine/toolchain';
import { createNativeDataWriteOwner, NATIVE_READER_REQUIREMENT_FILE } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { makeProjectTempDir } from '../_helpers/project-temp.ts';

function fixture() {
  const root = makeProjectTempDir('retained-native-artifact-');
  fs.writeFileSync(join(root, 'program'), 'alpha', { mode: 0o755 });
  fs.writeFileSync(join(root, 'metadata.json'), '{"actual":"metadata"}', { mode: 0o644 });
  const members = [{ path: 'program', mode: 0o755 }, { path: 'metadata.json', mode: 0o644, pin: false }];
  return { root, members };
}

test('one cold portable pin, then native original guards without hashing or rereading file bodies', () => {
  const f = fixture(), hash = spyOn(crypto, 'createHash');
  try {
    const original = retainNativeArtifactFiles(f.root, f.members);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(original.files[0]!.sha256).toBe('8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8');
    expect(Object.hasOwn(original.files[1]!, 'sha256')).toBe(false);
    const read = spyOn(fs, 'readFileSync');
    try {
      original.assertCurrent(); assertNativeArtifactFilesCurrent(original); original.assertCurrent();
      expect(read).not.toHaveBeenCalled(); expect(hash).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
    const detachedBytes = readNativeArtifactFile(original, 'program'); detachedBytes.fill(0);
    original.assertCurrent();
    expect(original.files[0]!.bytes.toString()).toBe('alpha');
    expect(hash).toHaveBeenCalledTimes(1);
    const cold = retainNativeArtifactFiles(f.root, f.members);
    expect(cold).not.toBe(original); expect(hash).toHaveBeenCalledTimes(2);
    expect(cold.files[0]!.sha256).toBe(original.files[0]!.sha256);
  } finally { hash.mockRestore(); }
});

for (const mutation of ['changed-bytes', 'same-byte-replacement', 'parent-replacement', 'metadata-replacement'] as const) {
  test(`warm original proof refuses ${mutation}`, () => {
    const f = fixture(), original = retainNativeArtifactFiles(f.root, f.members.map(member => ({ ...member, pin: false })));
    if (mutation === 'changed-bytes') fs.writeFileSync(join(f.root, 'program'), 'other');
    if (mutation === 'same-byte-replacement') {
      fs.renameSync(join(f.root, 'program'), join(f.root, 'program.old'));
      fs.writeFileSync(join(f.root, 'program'), 'alpha', { mode: 0o755 });
    }
    if (mutation === 'parent-replacement') {
      fs.renameSync(f.root, f.root + '.original'); fs.mkdirSync(f.root);
      fs.writeFileSync(join(f.root, 'program'), 'alpha', { mode: 0o755 });
      fs.writeFileSync(join(f.root, 'metadata.json'), '{"actual":"metadata"}', { mode: 0o644 });
    }
    if (mutation === 'metadata-replacement') {
      fs.renameSync(join(f.root, 'metadata.json'), join(f.root, 'metadata.original'));
      fs.writeFileSync(join(f.root, 'metadata.json'), '{"actual":"metadata"}', { mode: 0o644 });
    }
    expect(() => assertNativeArtifactFilesCurrent(original)).toThrow();
    expect(() => original.files[0]!.bytes).toThrow();
  });
}

test('copies, inherited handles, subclasses and overridden methods cannot manufacture private original proof', () => {
  const f = fixture(), original = retainNativeArtifactFiles(f.root, f.members);
  class Forged { readonly files = original.files; assertCurrent(): void {} }
  for (const copy of [{ ...original }, Object.create(original), new Forged(), { files: original.files, assertCurrent() {} }]) {
    const foreign = copy as RetainedNativeArtifactFiles;
    expect(() => assertNativeArtifactFilesCurrent(foreign)).toThrow('original retained owner');
    expect(() => readNativeArtifactFile(foreign, 'program')).toThrow('original retained owner');
    expect(() => nativeArtifactPins(foreign, f.root, ['program'])).toThrow('original retained owner');
  }
  expect(Reflect.set(original, 'assertCurrent', () => {})).toBe(false);
  expect(Reflect.set(original.files[0]!, 'sha256', '0'.repeat(64))).toBe(false);
  const oldGet = WeakMap.prototype.get;
  WeakMap.prototype.get = function <K extends WeakKey, V>(this: WeakMap<K, V>, _key: K): V | undefined { return undefined; };
  try { assertNativeArtifactFilesCurrent(original); }
  finally { WeakMap.prototype.get = oldGet; }
});

test('an original directory alias is supported, while retargeting it invalidates its actual owner', () => {
  const f = fixture(), container = makeProjectTempDir('native-alias-'), alias = join(container, 'original');
  fs.symlinkSync(f.root, alias, 'dir');
  const original = retainNativeArtifactFiles(alias, f.members.map(member => ({ ...member, pin: false })));
  expect(original.files[0]!.bytes.toString()).toBe('alpha'); original.assertCurrent();
  fs.unlinkSync(alias); fs.symlinkSync(f.root, alias, 'dir');
  expect(() => original.assertCurrent()).toThrow();
});

for (const path of ['../program', '/program', 'nested/../program', 'program\\other', 'program//other']) {
  test(`capture refuses non-cohort path ${path}`, () => {
    const f = fixture(); expect(() => retainNativeArtifactFiles(f.root, [{ path }])).toThrow('path');
  });
}


test('an internal symlink cannot redirect a fixed member outside the retained cohort', () => {
  const f = fixture(); fs.symlinkSync(f.root, join(f.root, 'external'), 'dir');
  expect(() => retainNativeArtifactFiles(f.root, [{ path: 'external/program' }])).toThrow('physical cohort');
});


test('a continuously appending source is refused after its original size and one EOF probe', () => {
  const f = fixture(), path = join(f.root, 'program'), inode = fs.statSync(path).ino, originalRead = fs.readSync;
  let sourceReads = 0;
  function tappedRead(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number;
  function tappedRead(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadSyncOptions): number;
  function tappedRead(fd: number, buffer: NodeJS.ArrayBufferView, offsetOrOptions?: number | fs.ReadSyncOptions, length?: number, position?: fs.ReadPosition | null): number {
    const selected = fs.fstatSync(fd).ino === inode;
    if (selected && ++sourceReads > 3) throw new Error('Fixture stopped unbounded source reader');
    let count: number;
    if (typeof offsetOrOptions === 'number') {
      if (length === undefined) throw new Error('Fixture numeric read omitted its length');
      count = originalRead(fd, buffer, offsetOrOptions, length, position ?? null);
    } else count = originalRead(fd, buffer, offsetOrOptions);
    if (selected) fs.appendFileSync(path, 'x');
    return count;
  }
  const tap = spyOn(fs, 'readSync').mockImplementation(tappedRead);
  try {
    expect(() => retainNativeArtifactFiles(f.root, [{ path: 'program', mode: 0o755 }])).toThrow('grew while pinning');
    expect(sourceReads).toBe(2);
  } finally { tap.mockRestore(); }
});


test('a relocated runtime keeps original files and physical parents through actual native reader-floor sibling publications', () => {
  const f = fixture();
  // This regression tests currentness, not a new portable checksum consumer.
  const members = f.members.map(member => ({ ...member, pin: false }));
  const immutable = retainNativeArtifactFiles(f.root, members);
  const runtime = retainNativeArtifactFiles(f.root, members, { directoryRevisions: false });
  const writer = createNativeDataWriteOwner({ execPath: join(f.root, 'program'), version: '3.1.2',
    assertCurrent: () => assertNativeArtifactFilesCurrent(runtime) });
  const hashing = spyOn(crypto, 'createHash');
  try {
    writer.declare('configuration-policy-epochs-v2');
    writer.declare('knowledge-schema-v17');
    const requirements: unknown = JSON.parse(fs.readFileSync(join(f.root, NATIVE_READER_REQUIREMENT_FILE), 'utf8'));
    expect(requirements).toEqual({ schema: 1, minimumReader: '3.1.2', formats: ['configuration-policy-epochs-v2', 'knowledge-schema-v17'] });
    expect(fs.existsSync(join(f.root, `${NATIVE_READER_REQUIREMENT_FILE}.lock`))).toBe(false);
    assertNativeArtifactFilesCurrent(runtime);
    expect(readNativeArtifactFile(runtime, 'program').toString()).toBe('alpha');
    expect(Object.hasOwn(runtime.files[0]!, 'sha256')).toBe(false);
    expect(hashing).not.toHaveBeenCalled();
    // Strict archives still reject namespace mutation. Only the selected live
    // runtime has declared that its native data-floor writer owns sibling work.
    expect(() => immutable.assertCurrent()).toThrow('parent changed');
  } finally { hashing.mockRestore(); }
});

for (const mutation of ['same-byte-replacement', 'parent-replacement', 'alias-replacement'] as const) {
  test(`runtime sibling publication mode still refuses actual ${mutation}`, () => {
    const f = fixture(), container = makeProjectTempDir('native-runtime-alias-'), alias = join(container, 'selected');
    fs.symlinkSync(f.root, alias, 'dir');
    const runtime = retainNativeArtifactFiles(alias, f.members.map(member => ({ ...member, pin: false })), { directoryRevisions: false });
    if (mutation === 'same-byte-replacement') {
      fs.renameSync(join(f.root, 'program'), join(f.root, 'program.original'));
      fs.writeFileSync(join(f.root, 'program'), 'alpha', { mode: 0o755 });
    } else if (mutation === 'parent-replacement') {
      fs.renameSync(f.root, f.root + '.original'); fs.mkdirSync(f.root);
      fs.writeFileSync(join(f.root, 'program'), 'alpha', { mode: 0o755 });
      fs.writeFileSync(join(f.root, 'metadata.json'), '{"actual":"metadata"}', { mode: 0o644 });
    } else {
      fs.unlinkSync(alias); fs.symlinkSync(f.root, alias, 'dir');
    }
    expect(() => assertNativeArtifactFilesCurrent(runtime)).toThrow();
    expect(() => readNativeArtifactFile(runtime, 'program')).toThrow();
  });
}
