/**
 * The identity of an uncommitted path, from git and the file system, without
 * holding its bytes: a regular file is its git blob id (`git hash-object
 * --no-filters --stdin-paths`, one child process for every path asked at once),
 * a symbolic link the sha256 of its target, a deleted path `null`. Anything
 * else (a nested repository, a path git cannot name on one line) is `other`,
 * which a comparison treats as uncertain, so it is never swept into a commit.
 *
 * Everything here runs off the event loop: git runs as a child process and the
 * file system is read through its promise API.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, type Stats } from 'node:fs';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** `file:<oid>`, `executable:<oid>`, `symlink:<sha256 of the target>`, `other`, or null for a path that does not exist. */
export type DirtyPathId = string | null;

/** The id that stands for a path whose content cannot be named. */
export const OTHER_PATH_ID = 'other';

/** Whether a path is one this module names: relative, inside the tree, outside `.git` and `.goodvibes`. */
export function isOrdinaryProjectPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\0')
    && !path.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git' || part === '.goodvibes');
}

async function run(args: readonly string[], cwd: string, stdin?: string, signal?: AbortSignal): Promise<{ readonly code: number; readonly stdout: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  signal?.throwIfAborted();
  return { code, stdout };
}

/** Blob ids of regular files, in one git process; a path git could not hash (gone meanwhile) is retried alone. */
async function blobIds(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<Map<string, string | undefined>> {
  const ids = new Map<string, string | undefined>();
  if (paths.length === 0) return ids;
  const batch = await run(['hash-object', '--no-filters', '--stdin-paths'], cwd, `${paths.join('\n')}\n`, signal);
  const lines = batch.stdout.split('\n').filter((line) => line.length > 0);
  if (batch.code === 0 && lines.length === paths.length) {
    paths.forEach((path, index) => ids.set(path, lines[index]));
    return ids;
  }
  for (const path of paths) {
    const one = await run(['hash-object', '--no-filters', '--', path], cwd, undefined, signal);
    ids.set(path, one.code === 0 ? one.stdout.trim() || undefined : undefined);
  }
  return ids;
}

/**
 * The current id of each path under `cwd`. One `lstat` per path and one git
 * process for all regular files; nothing is kept but the ids.
 */
export async function dirtyPathIds(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<Map<string, DirtyPathId>> {
  const result = new Map<string, DirtyPathId>();
  const files: string[] = [];
  const executable = new Set<string>();
  await Promise.all(paths.map(async (path) => {
    if (!isOrdinaryProjectPath(path) || path.includes('\n')) { result.set(path, OTHER_PATH_ID); return; }
    const absolute = join(cwd, path);
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute, { encoding: 'buffer' });
        result.set(path, `symlink:${createHash('sha256').update(target).digest('hex')}`);
      } else if (stat.isFile()) {
        files.push(path);
        if ((stat.mode & 0o111) !== 0) executable.add(path);
      } else {
        result.set(path, OTHER_PATH_ID);
      }
    } catch (error) {
      result.set(path, (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : OTHER_PATH_ID);
    }
  }));
  signal?.throwIfAborted();
  const ids = await blobIds(cwd, files, signal);
  for (const path of files) {
    const id = ids.get(path);
    result.set(path, id === undefined || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(id) ? OTHER_PATH_ID : `${executable.has(path) ? 'executable' : 'file'}:${id}`);
  }
  return result;
}

function idOf(stat: Stats, target: () => Buffer): DirtyPathId | 'file' {
  if (stat.isSymbolicLink()) return `symlink:${createHash('sha256').update(target()).digest('hex')}`;
  return stat.isFile() ? 'file' : OTHER_PATH_ID;
}

/**
 * The same ids, synchronously, for a caller that cannot wait (a session turn
 * that found no baseline): still one git process for every file and no bytes kept.
 */
export function dirtyPathIdsSync(cwd: string, paths: readonly string[]): Map<string, DirtyPathId> {
  const result = new Map<string, DirtyPathId>();
  const files: string[] = [];
  const executable = new Set<string>();
  for (const path of paths) {
    if (!isOrdinaryProjectPath(path) || path.includes('\n')) { result.set(path, OTHER_PATH_ID); continue; }
    const absolute = join(cwd, path);
    try {
      const stat = lstatSync(absolute);
      const id = idOf(stat, () => readlinkSync(absolute, { encoding: 'buffer' }));
      if (id !== 'file') { result.set(path, id); continue; }
      files.push(path);
      if ((stat.mode & 0o111) !== 0) executable.add(path);
    } catch (error) {
      result.set(path, (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : OTHER_PATH_ID);
    }
  }
  if (files.length === 0) return result;
  const hashed = Bun.spawnSync(['git', 'hash-object', '--no-filters', '--stdin-paths'], { cwd, stdin: new TextEncoder().encode(`${files.join('\n')}\n`), env: { ...process.env, LC_ALL: 'C' } });
  const lines = hashed.exitCode === 0 ? new TextDecoder().decode(hashed.stdout).split('\n').filter((line) => line.length > 0) : [];
  files.forEach((path, index) => {
    const id = lines.length === files.length ? lines[index] : undefined;
    result.set(path, id === undefined || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(id) ? OTHER_PATH_ID : `${executable.has(path) ? 'executable' : 'file'}:${id}`);
  });
  return result;
}

/**
 * The sha256 commitment an older baseline saved for a path (`file:`,
 * `executable:` or `symlink:` plus the sha256 of the bytes), read now; null
 * when the path is gone, undefined when it cannot be read. Only resumed
 * contracts with such a baseline read file bytes, one file at a time.
 */
export async function legacyPathCommitment(cwd: string, path: string): Promise<string | null | undefined> {
  if (!isOrdinaryProjectPath(path)) return undefined;
  const absolute = join(cwd, path);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return `symlink:${createHash('sha256').update(await readlink(absolute, { encoding: 'buffer' })).digest('hex')}`;
    if (!stat.isFile()) return undefined;
    const digest = createHash('sha256').update(await readFile(absolute)).digest('hex');
    return `${(stat.mode & 0o111) !== 0 ? 'executable' : 'file'}:${digest}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

/** Two ids name the same content: equal and not `other`. Undefined when either cannot be compared. */
export function sameDirtyPathId(left: DirtyPathId | undefined, right: DirtyPathId | undefined): boolean | undefined {
  if (left === undefined || right === undefined || left === OTHER_PATH_ID || right === OTHER_PATH_ID) return undefined;
  return left === right;
}
