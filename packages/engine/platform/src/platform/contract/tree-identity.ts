/**
 * The identity of a working tree's content as a git tree id: what a check
 * accepted, saved on the contract so it outlives the process. Two trees with
 * the same id hold the same bytes at the same paths, so a restart can tell an
 * accepted result from a changed one with one comparison of strings instead of
 * judging the work again.
 *
 * Computed with a private copy of the index and a private object directory
 * that borrows the repository's objects (the real index, the owner's staging
 * and the repository's object store are never written): `git add -A` into the
 * copy, then `git write-tree`. Ignored files and the product's own
 * `.goodvibes` area are not part of it. Cost: one index copy, one `git add`
 * (only changed files are hashed, the copied index keeps the stat cache) and
 * one `git write-tree`.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', ...(env === undefined ? {} : { env }) });
  return result.status === 0 ? (result.stdout ?? '').trim() : null;
}

/** The tree id of `root`'s current content, or null when it is not a git work tree or git cannot say. */
export function workingTreeIdentity(root: string): string | null {
  const reportedIndex = git(root, ['rev-parse', '--git-path', 'index']);
  const reportedObjects = git(root, ['rev-parse', '--git-path', 'objects']);
  if (reportedIndex === null || reportedObjects === null) return null;
  const index = isAbsolute(reportedIndex) ? reportedIndex : join(root, reportedIndex);
  const objects = isAbsolute(reportedObjects) ? reportedObjects : join(root, reportedObjects);
  const scratchDir = mkdtempSync(join(tmpdir(), `goodvibes-tree-${randomUUID().slice(0, 8)}-`));
  const scratch = join(scratchDir, 'index');
  try {
    if (existsSync(index)) copyFileSync(index, scratch);
    mkdirSync(join(scratchDir, 'objects'));
    const env = { ...process.env, GIT_INDEX_FILE: scratch, GIT_OBJECT_DIRECTORY: join(scratchDir, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    if (git(root, ['add', '-A', '--', '.', ':(exclude).goodvibes'], env) === null) return null;
    const tree = git(root, ['write-tree'], env);
    return tree !== null && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
