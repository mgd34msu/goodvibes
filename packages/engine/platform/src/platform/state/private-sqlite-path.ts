/** Native local SQLite path ownership. No source/account identity is derived here. */
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
const unavailable = () => new Error('Private SQLite storage path is unavailable');
function synchronous(check: () => void): void { const result: unknown = check(); if (result !== undefined) { drainOwned(result); throw unavailable(); } }

/** The store directory was replaced (moved, deleted, recreated) while this process held it. */
export class PrivateSqliteDirectoryMovedError extends Error {
  constructor(readonly directory: string) {
    super(`The private SQLite directory ${directory} was moved or replaced while it was open; restart to re-open the stores at its new location.`);
    this.name = 'PrivateSqliteDirectoryMovedError';
  }
}

/**
 * Locate the workspace's private SQLite directory (`.goodvibes/tui/operator`)
 * once. With `create`, missing directories are made owner-only. The directory
 * must belong to this user and is kept owner-only (0700). Afterwards only that
 * directory's own identity (device and inode) is checked: changing the mode or
 * owner of the workspace, the home directory or any other ancestor does not
 * disable the stores. A missing directory without `create` throws ENOENT, so
 * read-only cleanup never creates a workspace.
 */
export function capturePrivateSqliteDirectory(workingDirectory: string, options: { readonly create: boolean; readonly assertCurrent: () => void }): {
  readonly directory: string; readonly assertCurrent: () => void;
} {
  const assertOwner = options.assertCurrent.bind(options);
  synchronous(assertOwner);
  const selected = join(options.create ? resolve(workingDirectory) : realpathSync(workingDirectory), '.goodvibes', 'tui', 'operator');
  if (options.create) mkdirSync(selected, { recursive: true, mode: 0o700 });
  const directory = realpathSync(selected);
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) {
    throw new Error(`Private SQLite storage directory ${directory} is not a directory owned by this user; fix its owner or remove it, then restart.`);
  }
  // Explicit privacy, independent of the umask the directory was made under.
  if ((stat.mode & 0o777n) !== 0o700n) chmodSync(directory, 0o700);
  const identity = `${stat.dev}:${stat.ino}`;
  const current = () => {
    synchronous(assertOwner);
    let now: BigIntStats;
    try { now = lstatSync(directory, { bigint: true }); } catch { throw new PrivateSqliteDirectoryMovedError(directory); }
    if (`${now.dev}:${now.ino}` !== identity) throw new PrivateSqliteDirectoryMovedError(directory);
  };
  return Object.freeze({ directory, assertCurrent: current });
}


function fileStamp(stat: BigIntStats): string {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) throw unavailable();
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}
/** Admit and tighten the actual original descriptor, never an alias or hardlink. */
export function readPrivateSqliteImage(path: string, assertCurrent: () => void): { readonly bytes: Buffer; readonly physical: string } | undefined {
  synchronous(assertCurrent);
  const selected = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (!selected) return undefined;
  const original = fileStamp(selected);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    synchronous(assertCurrent); if (fileStamp(fstatSync(fd, { bigint: true })) !== original) throw unavailable();
    if ((selected.mode & 0o777n) !== 0o600n) fchmodSync(fd, 0o600);
    const before = fileStamp(fstatSync(fd, { bigint: true }));
    if (fileStamp(lstatSync(path, { bigint: true })) !== before) throw unavailable();
    const bytes = readFileSync(fd); synchronous(assertCurrent);
    if (fileStamp(fstatSync(fd, { bigint: true })) !== before || fileStamp(lstatSync(path, { bigint: true })) !== before) throw unavailable();
    return Object.freeze({ bytes, physical: before });
  } finally { closeSync(fd); }
}
