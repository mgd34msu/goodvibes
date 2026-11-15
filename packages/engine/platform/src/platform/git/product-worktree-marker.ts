import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The durable fact that this product created a worktree: a small file in the
 * worktree's own git administrative directory, written when it is added. Git
 * deletes that directory with the worktree, so the fact cannot outlive it or
 * be inherited by a different worktree at the same path. A worktree without it
 * (made by hand, or by an earlier version) is never removed automatically.
 */
const MARKER_FILE = 'goodvibes-created';

function administrativeDirectory(worktreePath: string): string | null {
  try {
    const dotGit = join(worktreePath, '.git');
    if (!lstatSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return match?.[1] ? resolve(worktreePath, match[1].trim()) : null;
  } catch { return null; }
}

/** True when `path` lies under `<root>/.goodvibes/.worktrees`. */
export function isInsideProductWorktreeDirectory(root: string, path: string): boolean {
  const rel = relative(join(root, '.goodvibes', '.worktrees'), isAbsolute(path) ? path : resolve(root, path));
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Record that this product created the worktree. Returns false when the administrative directory cannot be written. */
export function markProductWorktree(worktreePath: string): boolean {
  const directory = administrativeDirectory(worktreePath);
  if (!directory) return false;
  try { writeFileSync(join(directory, MARKER_FILE), '1\n', { mode: 0o600 }); return true; }
  catch { return false; }
}

export function isMarkedProductWorktree(worktreePath: string): boolean {
  const directory = administrativeDirectory(worktreePath);
  if (!directory) return false;
  try { return lstatSync(join(directory, MARKER_FILE)).isFile(); }
  catch { return false; }
}
