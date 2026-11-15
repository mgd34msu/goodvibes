/**
 * Release-builder-local publication. A file is written into a private staging
 * directory beside its destination and then moved to its final name with
 * `link` + `unlink`, so a final name is never replaced implicitly (`link`
 * refuses an existing name, symlinks included) and never holds a partial file.
 * The build host owns its output directory; nothing here re-proves that.
 */
import { chmodSync, closeSync, constants, fchmodSync, linkSync, lstatSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { captureExistingDirectory, prepareAtomicPublicationDirectory, fileObservationIdentity } from '@goodvibes-jev/engine/platform/platform/utils';

export interface PublishedReleaseFile {
  readonly path: string;
  /** One `lstat`: throws when the published file was edited or replaced since publication. */
  assertCurrent(): void;
  /** Removes the published file only when it is still the one this stage published. */
  removeOwned(): void;
}

function filename(name: string): void {
  if (!name || name === '.' || name === '..' || name.length > 240 || !/^[A-Za-z0-9._+-]+$/.test(name)) throw new Error('Release output requires one bounded filename.');
}

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
  const parent = prepareAtomicPublicationDirectory(outDir).canonical;
  const path = mkdtempSync(join(parent, prefix));
  // mkdtemp honours the process umask; a restrictive one would leave the stage
  // unwritable to its own builder.
  chmodSync(path, 0o700);
  let cleaned = false;
  const assertCurrent = (): void => { if (cleaned) throw new Error('Release staging has closed.'); };
  const cleanup = (): void => {
    if (cleaned) return;
    rmSync(path, { recursive: true, force: true }); cleaned = true;
  };
  const publish = (member: string, name: string): PublishedReleaseFile => {
    filename(member); filename(name); assertCurrent();
    const source = join(path, member), selected = join(parent, name);
    linkSync(source, selected); // EEXIST is a refusal, including symlinks.
    let identity: string;
    try {
      unlinkSync(source);
      identity = fileObservationIdentity(selected);
    } catch (error) {
      // The final name is ours until this point; leave no half-published name behind.
      try { unlinkSync(selected); } catch { /* the primary failure stands */ }
      throw error;
    }
    let removed = false;
    const check = (): void => {
      if (removed || fileObservationIdentity(selected) !== identity) throw new Error(`Published release file ${name} changed after publication.`);
    };
    return Object.freeze({ path: selected, assertCurrent: check, removeOwned() { if (removed) return; check(); unlinkSync(selected); removed = true; } });
  };
  const publishBytes = (name: string, bytes: Uint8Array, mode = 0o644): PublishedReleaseFile => {
    filename(name); assertCurrent();
    const fd = openSync(join(path, name), 'wx', mode);
    try { fchmodSync(fd, mode); writeFileSync(fd, bytes); } finally { closeSync(fd); }
    return publish(name, name);
  };
  /**
   * Publish what `producer` writes into an exclusive staging descriptor. The
   * producer returns only after every writer has drained; `beforePublish` is a
   * synchronous last check the caller owns (for example its own inputs).
   */
  const publishFile = async (member: string, name: string, producer: (fd: number) => Promise<void>, mode = 0o644,
    beforePublish?: () => void): Promise<PublishedReleaseFile> => {
    filename(member); filename(name); assertCurrent();
    const fd = openSync(join(path, member), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      fchmodSync(fd, mode);
      await producer(fd);
    } finally { closeSync(fd); }
    beforePublish?.();
    return publish(member, name);
  };
  return Object.freeze({ path, assertCurrent, cleanup, publish, publishBytes, publishFile });
}
