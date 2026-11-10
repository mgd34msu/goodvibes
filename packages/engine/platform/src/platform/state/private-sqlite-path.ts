/** Native local SQLite path ownership. No source/account identity is derived here. */
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
const unavailable = () => new Error('Private SQLite storage path is unavailable');
function synchronous(check: () => void): void { const result: unknown = check(); if (result !== undefined) { drainOwned(result); throw unavailable(); } }
function stamp(stat: BigIntStats): string {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
interface RetainedDirectory { readonly path: string; identity: string; mode: bigint }
function directoryIdentity(stat: BigIntStats): string {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  // Children and shared private writers may change directory metadata. The
  // physical owner, owner access and special bits remain the original facts.
  return [stat.dev, stat.ino, stat.mode & ~0o077n, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}
function retainDirectory(path: string, stat = lstatSync(path, { bigint: true })): RetainedDirectory {
  return { path, identity: directoryIdentity(stat), mode: stat.mode };
}
function assertDirectoryCurrent(entry: RetainedDirectory): void {
  const current = lstatSync(entry.path, { bigint: true });
  if (directoryIdentity(current) !== entry.identity) throw unavailable();
  if (current.mode !== entry.mode) {
    // The real SecretsManager keyfile owner tightens a shared .goodvibes
    // ancestor to0700 on its first write. Accept only that privacy reduction;
    // once observed, widening again cannot recover the earlier permission.
    if ((current.mode & 0o777n) !== 0o700n) throw unavailable();
    entry.mode = current.mode;
  }
}
/** Existing explicitly selected workspace aliases resolve once to their physical
 * root. A missing workspace never traverses an alias while creating ancestors. */
function workspaceRoot(workingDirectory: string, create: boolean, assertCurrent: () => void): string {
  synchronous(assertCurrent);
  try { return realpathSync(workingDirectory); }
  catch (error) { if (!create || !missing(error)) throw error; }
  const selected = resolve(workingDirectory), parsed = parse(selected);
  const parts = selected.slice(parsed.root.length).split(sep).filter(Boolean);
  const paths = [parsed.root]; for (const part of parts) paths.push(join(paths.at(-1) ?? parsed.root, part));
  const existing: RetainedDirectory[] = [], absent: string[] = [];
  for (const path of paths) {
    try { existing.push(retainDirectory(path)); }
    catch (error) { if (!missing(error)) throw error; absent.push(path); }
  }
  const current = () => {
    synchronous(assertCurrent);
    for (const entry of existing) assertDirectoryCurrent(entry);
  };
  for (const path of absent) {
    current(); mkdirSync(path, { mode: 0o700 });
    const original = lstatSync(path, { bigint: true });
    const retained = retainDirectory(path, original); existing.push(retained); current();
    // Explicit permission publication is independent of a restrictive umask.
    chmodSync(path, 0o700); const after = lstatSync(path, { bigint: true });
    if (after.dev !== original.dev || after.ino !== original.ino || !after.isDirectory() || after.isSymbolicLink()) throw unavailable();
    retained.identity = directoryIdentity(after); retained.mode = after.mode; current();
  }
  current(); return realpathSync(selected);
}
/** Missing read-only roots throw ENOENT; cleanup must not create a new workspace. */
export function capturePrivateSqliteDirectory(workingDirectory: string, options: { readonly create: boolean; readonly assertCurrent: () => void }): {
  readonly directory: string; readonly assertCurrent: () => void;
} {
  options = Object.freeze({ ...options, assertCurrent: options.assertCurrent.bind(options) });
  synchronous(options.assertCurrent);
  const root = workspaceRoot(workingDirectory, options.create, options.assertCurrent), directory = join(root, '.goodvibes', 'tui', 'operator');
  const paths = [root, join(root, '.goodvibes'), join(root, '.goodvibes', 'tui'), directory];
  const retained: RetainedDirectory[] = [], absent: string[] = [];
  for (const path of paths) {
    try { retained.push(retainDirectory(path)); }
    catch (error) { if (!options.create || !missing(error)) throw error; absent.push(path); }
  }
  const current = () => {
    synchronous(options.assertCurrent);
    if (realpathSync(workingDirectory) !== root) throw unavailable();
    for (const entry of retained) assertDirectoryCurrent(entry);
  };
  for (const path of absent) {
    current(); mkdirSync(path, { mode: 0o700 });
    const original = lstatSync(path, { bigint: true }); const created = retainDirectory(path, original); retained.push(created); current();
    chmodSync(path, 0o700); const after = lstatSync(path, { bigint: true });
    if (after.dev !== original.dev || after.ino !== original.ino || !after.isDirectory() || after.isSymbolicLink()) throw unavailable();
    created.identity = directoryIdentity(after); created.mode = after.mode; current();
  }
  current();
  const selected = lstatSync(directory, { bigint: true });
  if (process.geteuid && selected.uid !== BigInt(process.geteuid())) throw unavailable();
  if ((selected.mode & 0o777n) !== 0o700n) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      current(); if (stamp(fstatSync(fd, { bigint: true })) !== stamp(selected)) throw unavailable();
      fchmodSync(fd, 0o700);
      const after = fstatSync(fd, { bigint: true });
      if (after.dev !== selected.dev || after.ino !== selected.ino || stamp(lstatSync(directory, { bigint: true })) !== stamp(after)) throw unavailable();
      const retainedDirectory = retained.find(entry => entry.path === directory);
      if (!retainedDirectory) throw unavailable(); retainedDirectory.identity = directoryIdentity(after); retainedDirectory.mode = after.mode;
    } finally { closeSync(fd); }
  }
  current(); return Object.freeze({ directory, assertCurrent: current });
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
