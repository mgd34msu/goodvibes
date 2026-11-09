/** Release-builder-local publication. Final names are never replaced implicitly. */
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { captureExistingDirectory, prepareAtomicPublicationDirectory, fileObservationIdentity } from '@goodvibes-jev/engine/platform/platform/utils';

export interface PublishedReleaseFile {
  readonly path: string;
  assertCurrent(): void;
  removeOwned(): void;
}

function filename(name: string): void {
  if (!name || name === '.' || name === '..' || name.length > 240 || !/^[A-Za-z0-9._+-]+$/.test(name)) throw new Error('Release output requires one bounded filename.');
}

// A link/unlink transfer changes nlink/ctime itself; all other original file
// facts must remain the same while the retained native descriptor is open.
function sameTransferSource(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.birthtimeNs === right.birthtimeNs;
}
const stamp = (value: BigIntStats): string => [value.dev, value.ino, value.mode, value.uid, value.gid, value.nlink,
  value.size, value.mtimeNs, value.ctimeNs, value.birthtimeNs].join(':');

/** Resolve a not-yet-created release destination without filesystem effects. */
export function planReleaseDirectory(path: string): string {
  const tail: string[] = []; let nearest = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  for (;;) {
    try { lstatSync(nearest); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; tail.unshift(basename(nearest)); nearest = dirname(nearest); }
  }
  return resolve(captureExistingDirectory(nearest).canonical, ...tail);
}

export function createReleaseStage(outDir: string, prefix: string) {
  filename(prefix);
  const parent = prepareAtomicPublicationDirectory(outDir);
  parent.assertCurrent();
  const path = mkdtempSync(join(parent.canonical, prefix));
  const created = lstatSync(path, { bigint: true });
  chmodSync(path, 0o700);
  const ready = lstatSync(path, { bigint: true });
  if (created.dev !== ready.dev || created.ino !== ready.ino || created.birthtimeNs !== ready.birthtimeNs) throw new Error('Release staging directory changed during creation.');
  const original = captureExistingDirectory(path);
  let cleaned = false;
  const assertCurrent = (): void => { parent.assertCurrent(); original.assertCurrent(); if (cleaned) throw new Error('Release staging has closed.'); };
  const cleanup = (): void => {
    if (cleaned) return;
    // Compensation may use only the original canonical tree, never a replaced
    // configured alias or a directory that now occupies our temporary name.
    original.assertPhysicalCurrent(); rmSync(path, { recursive: true }); cleaned = true;
  };
  const publish = (member: string, name: string, writtenSource?: string): PublishedReleaseFile => {
    filename(member); filename(name); assertCurrent();
    const source = join(path, member), selected = join(parent.canonical, name);
    const selectedSource = fileObservationIdentity(source);
    if (writtenSource !== undefined && selectedSource !== writtenSource) throw new Error('Release stage member changed after writing.');
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let linked: string | undefined;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (stamp(before) !== selectedSource) throw new Error('Release stage member changed before publication.');
      assertCurrent();
      linkSync(source, selected); // EEXIST is a refusal, including symlinks.
      const after = fstatSync(fd, { bigint: true });
      if (!sameTransferSource(before, after) || after.nlink !== 2n) throw new Error('Release stage member changed during publication.');
      linked = stamp(after);
      if (stamp(lstatSync(source, { bigint: true })) !== linked
        || stamp(lstatSync(selected, { bigint: true })) !== linked) throw new Error('Release stage member changed during publication.');
      assertCurrent(); unlinkSync(source);
      const transferred = fstatSync(fd, { bigint: true });
      if (!sameTransferSource(before, transferred) || transferred.nlink !== 1n) throw new Error('Release stage member changed during publication.');
      linked = stamp(transferred);
      if (fileObservationIdentity(selected) !== linked) throw new Error('Release output changed during publication.');
      parent.assertCurrent();
      let removed = false;
      const check = (): void => {
        parent.assertCurrent();
        if (removed || fileObservationIdentity(selected) !== linked) throw new Error('Published release file changed.');
        parent.assertCurrent();
      };
      return Object.freeze({ path: selected, assertCurrent: check, removeOwned() { if (removed) return; check(); unlinkSync(selected); removed = true; } });
    } catch (error) {
      // Only the exact original link we just created can be compensated. If
      // another publisher replaced/edited it, leave that file untouched.
      try { parent.assertPhysicalCurrent(); if (linked && stamp(lstatSync(selected, { bigint: true })) === linked) unlinkSync(selected); } catch { /* preserve primary failure and foreign output */ }
      throw error;
    } finally { closeSync(fd); }
  };
  const publishBytes = (name: string, bytes: Uint8Array, mode = 0o644): PublishedReleaseFile => {
    filename(name); assertCurrent();
    const selected = join(path, name), fd = openSync(selected, 'wx', mode);
    let written: string;
    try {
      fchmodSync(fd, mode); writeFileSync(fd, bytes);
      written = stamp(fstatSync(fd, { bigint: true }));
      if (written !== stamp(lstatSync(selected, { bigint: true }))) throw new Error('Release stage member changed while writing.');
    } finally { closeSync(fd); }
    return publish(name, name, written);
  };
  return Object.freeze({ path, assertCurrent, cleanup, publish: (member: string, name: string) => publish(member, name), publishBytes });
}
