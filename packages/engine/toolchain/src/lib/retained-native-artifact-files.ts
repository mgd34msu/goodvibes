import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { captureExistingDirectory, fileObservationIdentity, readFileObservation } from '@goodvibes-jev/engine/platform/platform/utils';

export interface NativeArtifactMember {
  readonly path: string;
  readonly mode?: number;
  readonly executable?: boolean;
  /** False only for metadata/archive bytes with no checksum consumer. */
  readonly pin?: boolean;
}
export interface RetainedNativeArtifactFile {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
  /** A new, original-file-guarded read; modifying it cannot alter this owner. */
  readonly bytes: Buffer;
}
export interface RetainedNativeArtifactFiles {
  readonly files: readonly RetainedNativeArtifactFile[];
  readonly assertCurrent: () => void;
}
interface FileState { readonly path: string; readonly full: string; readonly parent: ReturnType<typeof captureExistingDirectory>;
  readonly identity: string; readonly mode: number; readonly size: number; readonly directories: string; readonly sha256?: string }
interface Owner { readonly selectedRoot: string; readonly root: ReturnType<typeof captureExistingDirectory>; readonly directoryRevisions: boolean; readonly files: readonly FileState[] }
const owners = new WeakMap<object, Owner>();
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
const apply = Reflect.apply;
const frozen = Object.freeze;
function ownerOf(handle: RetainedNativeArtifactFiles): Owner {
  const owner = apply(weakGet, owners, [handle]) as Owner | undefined;
  assert(owner, 'Native artifact proof must be its original retained owner');
  return owner;
}
function directoryRevisionsOf(parent: string, root: string): string {
  const states: string[] = [];
  for (let path = parent; path === root || path.startsWith(root + sep); path = dirname(path)) {
    const stat = lstatSync(path, { bigint: true });
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Native artifact parent must be a regular directory');
    states.push(`${path}:${stat.ctimeNs}:${stat.mtimeNs}`);
    if (path === root) break;
  }
  return states.join('|');
}
function assertFile(owner: Owner, file: FileState): void {
  owner.root.assertCurrent(); file.parent.assertCurrent();
  assert.equal(fileObservationIdentity(file.full), file.identity, 'Retained native artifact owner changed');
  if (owner.directoryRevisions) assert.equal(directoryRevisionsOf(file.parent.canonical, owner.root.canonical),
    file.directories, 'Retained native artifact parent changed');
}
/** Only genuine original handles can use the metadata-only currentness path.
 * A copied descriptor or a subclass/overridden method never grants this proof. */
export function assertNativeArtifactFilesCurrent(handle: RetainedNativeArtifactFiles): void {
  const owner = ownerOf(handle);
  for (const file of owner.files) assertFile(owner, file);
}
/** Actual pin projection for a fixed product reader catalog. Never consume
 * public handle properties or trust a detached pin DTO as original evidence. */
export function nativeArtifactPins(handle: RetainedNativeArtifactFiles, directory: string, paths: readonly string[]):
  readonly { readonly path: string; readonly sha256: string; readonly mode: number; readonly size: number }[] {
  const owner = ownerOf(handle);
  assert.equal(resolve(directory), owner.selectedRoot, 'Native artifact proof belongs to another selected root');
  assertNativeArtifactFilesCurrent(handle);
  const seen = new Set<string>();
  return frozen(paths.map(path => {
    assert(!seen.has(path), 'Native artifact reader member is repeated'); seen.add(path);
    const file = owner.files.find(file => file.path === path);
    assert(file && typeof file.sha256 === 'string', 'Native artifact reader member has no original pin');
    return frozen({ path: file.path, sha256: file.sha256, mode: file.mode, size: file.size });
  }));
}
export function readNativeArtifactFile(handle: RetainedNativeArtifactFiles, path: string): Buffer {
  const owner = ownerOf(handle), file = owner.files.find(file => file.path === path);
  assert(file, 'Native artifact member was not retained');
  assertFile(owner, file);
  const read = readFileObservation(file.full);
  assert.equal(read.physical, file.identity, 'Retained native artifact descriptor changed');
  const bytes = read.bytes;
  assertFile(owner, file);
  assert.equal(bytes.length, file.size, 'Retained native artifact size changed');
  return bytes;
}
function pinOriginalFile(full: string, original: BigIntStats): string {
  const matches = (stat: BigIntStats) => stat.isFile() && !stat.isSymbolicLink()
    && (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const)
      .every(key => stat[key] === original[key]);
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(matches(fstatSync(fd, { bigint: true })), 'Native artifact descriptor changed before pinning');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024);
    const expectedSize = Number(original.size);
    let length = 0;
    while (length < expectedSize) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, expectedSize - length), null);
      assert(count > 0, 'Native artifact payload truncated while pinning');
      hash.update(chunk.subarray(0, count)); length += count;
    }
    // A growing writer cannot extend work indefinitely beyond the captured
    // original size. One extra byte proves growth, then original guards refuse.
    assert.equal(readSync(fd, chunk, 0, 1, null), 0, 'Native artifact payload grew while pinning');
    assert(matches(fstatSync(fd, { bigint: true })) && matches(lstatSync(full, { bigint: true }))
      && BigInt(length) === original.size, 'Native artifact payload changed while pinning');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
/** Cold capture computes each real portable pin once. Subsequent local guards
 * use original physical file/parent observations, not another digest or body
 * cache. This captures files, not CI source/reader authorization: the product
 * verifier must still validate its fixed catalog and recorded source manifest. */
export function retainNativeArtifactFiles(root: string, members: readonly NativeArtifactMember[],
  { directoryRevisions = true }: { readonly directoryRevisions?: boolean } = {}): RetainedNativeArtifactFiles {
  root = resolve(root);
  const rootOwner = captureExistingDirectory(root);
  const seen = new Set<string>();
  const files: FileState[] = members.map(member => {
    const { path, mode, executable, pin } = member;
    assert(typeof path === 'string' && path.length && !isAbsolute(path) && !path.includes('\\')
      && path.split('/').every(part => part.length && part !== '.' && part !== '..') && !seen.has(path), 'Native artifact member path is invalid or repeated');
    seen.add(path);
    rootOwner.assertCurrent();
    const parent = captureExistingDirectory(dirname(join(root, path))), full = join(parent.canonical, basename(path));
    assert.equal(parent.canonical, resolve(rootOwner.canonical, dirname(path)), 'Native artifact member parent is outside its physical cohort');
    const identity = fileObservationIdentity(full), stat = lstatSync(full, { bigint: true });
    const actualMode = Number(stat.mode & 0o7777n), size = Number(stat.size);
    assert(Number.isSafeInteger(size), 'Native artifact payload size is not representable');
    if (mode !== undefined) assert.equal(actualMode, mode, 'Native artifact payload mode differs');
    if (executable) assert((actualMode & 0o111) !== 0, 'Native artifact binary is not executable');
    const directories = directoryRevisions ? directoryRevisionsOf(parent.canonical, rootOwner.canonical) : '';
    let sha256: string | undefined;
    if (pin !== false) {
      // Actual portable CI/release member pin, independently checked after
      // archive restoration. Stream the original FD once; no raw-body cache.
      sha256 = pinOriginalFile(full, stat);
    }
    const file = frozen({ path, full, parent, mode: actualMode, size, identity, directories,
      ...(sha256 === undefined ? {} : { sha256 }) });
    assertFile({ selectedRoot: root, root: rootOwner, directoryRevisions, files: [] }, file);
    return file;
  });
  const owner: Owner = frozen({ selectedRoot: root, root: rootOwner, directoryRevisions, files: frozen(files) });
  const handle: RetainedNativeArtifactFiles = frozen({ files: frozen(files.map(file => frozen({ path: file.path,
    mode: file.mode, size: file.size, ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
    get bytes() { return readNativeArtifactFile(handle, file.path); } }))),
    assertCurrent: () => assertNativeArtifactFilesCurrent(handle) });
  apply(weakSet, owners, [handle, owner]);
  assertNativeArtifactFilesCurrent(handle);
  return handle;
}
