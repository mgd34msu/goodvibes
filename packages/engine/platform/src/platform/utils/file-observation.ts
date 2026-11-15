/** Exact private file snapshots for local operations, never wire identifiers or authority. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';

export interface FileObservation {
  readonly physical: string;
  readonly bytes: Buffer;
  readonly mtimeMs: number;
}

function identity(stat: BigIntStats, allowLinks = false): string {
  if (!stat.isFile() || stat.isSymbolicLink() || (!allowLinks && stat.nlink !== 1n)) throw new Error('Expected a single-link regular file source');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink,
    stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

/** Native source incarnation without rereading its contents. Callers that
 * already retained/validated bytes can fence later cleanup by the same stamp. */
export function fileObservationIdentity(path: string, options: { readonly allowLinks?: boolean } = {}): string {
  return identity(lstatSync(path, { bigint: true }), options.allowLinks);
}

/** Caller owns the returned bytes and their lifetime. Missing files throw ENOENT.
 * Check both the descriptor and selected path, so replacement during a read
 * cannot associate another file's bytes with the selected physical source.
 * `allowLinks` admits a hard-linked file, for a reader that keys what it keeps
 * on the bytes (a cache) rather than on which file they came from.
 */
export function readFileObservation(path: string, options: { readonly maxBytes?: number; readonly allowLinks?: boolean } = {}): FileObservation {
  const allowLinks = options.allowLinks === true;
  const stat = lstatSync(path, { bigint: true }), selected = identity(stat, allowLinks);
  const maxBytes = options.maxBytes ?? Infinity;
  if (Number.isNaN(maxBytes) || maxBytes < 0 || stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    || (Number.isFinite(maxBytes) && stat.size > BigInt(Math.floor(maxBytes)))) throw new Error('File source exceeds read budget');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(fstatSync(fd, { bigint: true }), allowLinks) !== selected) throw new Error('File source changed before reading');
    let bytes: Buffer;
    if (options.maxBytes === undefined) bytes = readFileSync(fd);
    else {
      // Read at most the admitted original size plus one growth sentinel. A
      // growing source cannot exceed the caller's admitted read allocation.
      const buffer = Buffer.alloc(Number(stat.size) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      if (offset !== Number(stat.size)) throw new Error('File source changed while reading');
      bytes = buffer.subarray(0, offset);
    }
    if (identity(fstatSync(fd, { bigint: true }), allowLinks) !== selected
      || identity(lstatSync(path, { bigint: true }), allowLinks) !== selected) throw new Error('File source changed while reading');
    return Object.freeze({ physical: selected, bytes, mtimeMs: Number(stat.mtimeNs) / 1_000_000 });
  } finally { closeSync(fd); }
}
