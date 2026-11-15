/**
 * The first checkpoint of a new contract. Its name is a fresh 128-bit random
 * id that no other process can be creating, so no lock or reservation file is
 * needed: the guarantee is "never overwrite an existing checkpoint, and never
 * show a half-written one", which the staged file plus an exclusive hard link
 * give. The complete bytes are written and synced under a private temporary
 * name, then linked to the final name, which fails on any existing leaf.
 */
import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { createAtomicTempPath, prepareAtomicPublicationDirectory } from '../utils/atomic-json-store.js';

/** Whether nothing (a file, a link, a quarantine leaf) occupies `path`. */
export function contractCreationPathAbsent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

/**
 * Publishes complete bytes if and only if the name is absent. The checkpoint
 * directory (and any directory this call created) is synced so the new name
 * survives a crash; nothing above it is touched.
 */
export function publishInitialContractCheckpoint(directory: string, id: string, text: string, assertCurrent: () => void): { readonly path: string; assertCurrent(): void } {
  const parent = prepareAtomicPublicationDirectory(directory, { assertCurrent });
  const target = join(parent.canonical, `${id}.json`), stage = createAtomicTempPath(target);
  if (!contractCreationPathAbsent(target)) throw new Error('Contract identity is already stored');
  let fd: number | undefined;
  let staged = false;
  try {
    // O_EXCL: an existing leaf under the staging name is someone else's and is left alone.
    fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    staged = true;
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    assertCurrent();
    // The only publication step: link fails on any occupied name, so an existing checkpoint is never replaced.
    linkSync(stage, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (staged) { try { unlinkSync(stage); } catch { /* The staged name is private; a leftover is reaped with other temp files. */ } }
  }
  for (const path of new Set([...parent.durabilityDirectories, parent.canonical])) {
    // The checkpoint is already published; a filesystem that cannot sync a directory cannot be made more
    // durable here, and failing now would report a contract as not created when its file exists.
    try {
      const directoryFd = openSync(path, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch { /* See above. */ }
  }
  const physical = fileObservationIdentity(target);
  return Object.freeze({ path: target, assertCurrent() {
    if (fileObservationIdentity(target) !== physical) throw new Error('Original contract creation publication changed');
  } });
}
