/** Exact private file snapshots for local operations, never wire identifiers or authority. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';

export interface FileObservation {
  readonly physical: string;
  readonly bytes: Buffer;
}

function identity(stat: BigIntStats): string {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Expected a single-link regular file source');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink,
    stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

/** Native source incarnation without rereading its contents. Callers that
 * already retained/validated bytes can fence later cleanup by the same stamp. */
export function fileObservationIdentity(path: string): string {
  return identity(lstatSync(path, { bigint: true }));
}

/** Caller owns the returned bytes and their lifetime. Missing files throw ENOENT.
 * Check both the descriptor and selected path, so replacement during a read
 * cannot associate another file's bytes with the selected physical source.
 */
export function readFileObservation(path: string): FileObservation {
  const selected = identity(lstatSync(path, { bigint: true }));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(fstatSync(fd, { bigint: true })) !== selected) throw new Error('File source changed before reading');
    const bytes = readFileSync(fd);
    if (identity(fstatSync(fd, { bigint: true })) !== selected
      || identity(lstatSync(path, { bigint: true })) !== selected) throw new Error('File source changed while reading');
    return Object.freeze({ physical: selected, bytes });
  } finally { closeSync(fd); }
}
