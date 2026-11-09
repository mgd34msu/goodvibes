/** Actual asynchronous JSON body writes/fsyncs on retained original native FDs.
 * Namespace creation/rename/unlink stays synchronous with its final ownership
 * check, avoiding a queued pathname operation against a substituted tree.
 */
import { closeSync, constants, fchmodSync, fstatSync, fsync, lstatSync, openSync, renameSync, unlinkSync, writeFile, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { AtomicWriteDurabilityError, createAtomicTempPath, prepareAtomicPublicationDirectory, type AtomicJsonWriteOptions } from './atomic-json-store.js';
export type AsyncAtomicJsonWriteOptions = Pick<AtomicJsonWriteOptions, 'mkdirp' | 'mode' | 'indent' | 'trailingNewline' | 'assertCurrent' | 'onEffect'>;
const stamp = (value: BigIntStats) => [value.dev, value.ino, value.mode, value.uid, value.gid, value.nlink, value.size, value.mtimeNs, value.ctimeNs, value.birthtimeNs].join(':');
const sameFile = (value: BigIntStats | undefined, original: BigIntStats | undefined) => !!value && !!original && value.isFile() && !value.isSymbolicLink() && value.nlink === 1n
  && value.dev === original.dev && value.ino === original.ino && value.uid === original.uid && value.gid === original.gid && value.birthtimeNs === original.birthtimeNs;
const directoryStamp = (value: BigIntStats) => {
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('Original atomic directory is unavailable.');
  return [value.dev, value.ino, value.mode, value.uid, value.gid, value.birthtimeNs].join(':');
};
const nativeThen = Promise.prototype.then, nativeApply = Reflect.apply;
function invoke(callback: (() => void) | undefined): void {
  const result: unknown = callback?.(); if (result !== undefined) { if (nodeTypes.isPromise(result)) nativeApply(nativeThen, result, [undefined, () => {}]); throw new Error('Atomic JSON owner callbacks must complete synchronously.'); }
}
const sync = (fd: number) => new Promise<void>((resolve, reject) => { fsync(fd, error => { if (error) reject(error); else resolve(); }); });
export async function writeJsonFileAtomicAsync(filePath: string, value: unknown, options: AsyncAtomicJsonWriteOptions = {}): Promise<void> {
  const guard = options.assertCurrent?.bind(options), notification = options.onEffect?.bind(options), mode = options.mode ?? 0o600;
  const mkdirp = options.mkdirp !== false, indent = options.indent === undefined ? 2 : options.indent, newline = options.trailingNewline !== false;
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`, leaf = basename(absolute);
  let parent: ReturnType<typeof prepareAtomicPublicationDirectory> | undefined, temporary: string | undefined, target: string | undefined;
  let fd: number | undefined, original: BigIntStats | undefined, prepared: BigIntStats | undefined, publishedImage: BigIntStats | undefined;
  let attempted = false, published = false, publicationNotified = false, modeReady = false;
  const current = () => { invoke(guard); parent?.assertCurrent(); };
  const effect = (isPublished = false) => {
    if (isPublished) { if (publicationNotified) return; publicationNotified = true; }
    invoke(notification ? () => notification(isPublished) : undefined);
  };
  const temporaryCurrent = () => {
    parent?.assertCurrent(); if (fd === undefined || !original || !temporary) throw new Error('Original atomic temporary is unavailable.');
    const descriptor = fstatSync(fd, { bigint: true }), entry = lstatSync(temporary, { bigint: true });
    if (!sameFile(descriptor, original) || !sameFile(entry, original) || stamp(descriptor) !== stamp(entry)
      || (modeReady && (descriptor.mode & 0o7777n) !== BigInt(mode & 0o7777))
      || (prepared && stamp(descriptor) !== stamp(prepared))) throw new Error('Original atomic temporary changed.');
  };
  const observePublished = () => {
    parent?.assertCurrent(); if (fd === undefined || !original || !target) throw new Error('Original atomic publication is unavailable.');
    const descriptor = fstatSync(fd, { bigint: true }), entry = lstatSync(target, { bigint: true });
    if (!sameFile(descriptor, original) || !sameFile(entry, original) || stamp(descriptor) !== stamp(entry)) throw new Error('Original atomic publication changed.');
    return descriptor;
  };
  const publishedCurrent = () => { if (!publishedImage || stamp(observePublished()) !== stamp(publishedImage)) throw new Error('Atomic published image changed.'); };
  try {
    if (!leaf || leaf === '.' || leaf === '..' || absolute.endsWith(sep) || absolute.includes('\0')) throw new Error('Atomic JSON publication requires a file target.');
    parent = prepareAtomicPublicationDirectory(dirname(absolute), { mkdirp, assertCurrent: current, onEffect: notification ? () => effect() : undefined }); current();
    target = join(parent.canonical, leaf);
    // Capture the selected parent before invoking a borrowed serializer.
    const json = indent === null ? JSON.stringify(value) : JSON.stringify(value, null, indent);
    if (json === undefined) throw new TypeError('Atomic JSON value did not serialize to a document.');
    const content = newline ? `${json}\n` : json, length = Buffer.byteLength(content, 'utf8'); current();
    temporary = createAtomicTempPath(target); current();
    fd = openSync(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    original = fstatSync(fd, { bigint: true }); temporaryCurrent();
    if (notification) { effect(); temporaryCurrent(); }
    current(); fchmodSync(fd, mode); modeReady = true; current(); temporaryCurrent();
    const writing = fd;
    await new Promise<void>((resolve, reject) => { writeFile(writing, content, 'utf8', error => {
      if (error) { reject(error); return; }
      try {
        // Capture completion in the actual native callback before resolving to
        // another microtask/borrowed continuation. No reread or digest is needed.
        prepared = fstatSync(writing, { bigint: true });
        if (prepared.size !== BigInt(length)) throw new Error('Atomic JSON temporary has an unexpected length.');
        resolve();
      } catch (failure) { reject(failure); }
    }); });
    current(); temporaryCurrent(); await sync(fd); current(); temporaryCurrent();
    // No await or borrowed callback separates this proof from native rename.
    attempted = true; renameSync(temporary, target); published = true;
    publishedImage = observePublished(); if (notification) { effect(true); publishedCurrent(); }
    current(); publishedCurrent();
    for (const directory of parent.durabilityDirectories) {
      current(); publishedCurrent(); const expected = directoryStamp(lstatSync(directory, { bigint: true }));
      const owner = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        current(); publishedCurrent(); if (directoryStamp(fstatSync(owner, { bigint: true })) !== expected || directoryStamp(lstatSync(directory, { bigint: true })) !== expected) throw new Error('Original durability directory changed.');
        await sync(owner); current(); publishedCurrent();
        if (directoryStamp(fstatSync(owner, { bigint: true })) !== expected || directoryStamp(lstatSync(directory, { bigint: true })) !== expected) throw new Error('Original durability directory changed during sync.');
      } finally { closeSync(owner); }
      current(); publishedCurrent();
    }
    current(); publishedCurrent(); const completed = fd; fd = undefined; closeSync(completed);
  } catch (error) {
    if (!published && attempted) {
      try { temporaryCurrent(); } catch { published = true; }
      if (published && notification && !publicationNotified) {
        try { publishedImage = observePublished(); effect(true); publishedCurrent(); } catch { /* Unknown/foreign bytes supply no acknowledgement. */ }
      }
    }
    // Every native async operation has actually drained; close is attempted once
    // even if its acknowledgement fails, never retried on a reusable FD number.
    if (fd !== undefined) { const failed = fd; fd = undefined; try { closeSync(failed); } catch { /* Preserve the original failure diagnostic. */ } }
    if (!published && parent && temporary && original) {
      try { parent.assertPhysicalCurrent(); if (sameFile(lstatSync(temporary, { bigint: true, throwIfNoEntry: false }), original)) { unlinkSync(temporary); if (notification) effect(); } }
      catch { /* Foreign, retired or uncertain paths remain untouched. */ }
    }
    if (error instanceof AtomicWriteDurabilityError) throw error;
    throw new AtomicWriteDurabilityError(filePath, published ? 'published-indeterminate' : 'before-publication', error);
  }
}
