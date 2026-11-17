import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The durable fact that this product created a worktree: a small file in the
 * worktree's own git administrative directory, written when it is added. Git
 * deletes that directory with the worktree, so the fact cannot outlive it or
 * be inherited by a different worktree at the same path. The retention sweep
 * removes a worktree in the product's own location that lacks it (one made by
 * an earlier version) once no running owner holds it and its creation has
 * settled; worktrees elsewhere are never removed automatically.
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

/**
 * How long after `git worktree add` began an unmarked worktree is still taken
 * to be in creation: git lists it as soon as the add starts, and the marker is
 * written only after the checkout returns.
 */
export const WORKTREE_CREATION_GRACE_MS = 10 * 60_000;

/**
 * Why an unmarked worktree may still be in creation, or null once it has
 * settled. Git holds `locked` in the administrative directory for the whole
 * add (and a person's `git worktree lock` keeps it too); the `.git` link file is
 * written once at the start of the add, so its age is the worktree's age.
 */
export function unsettledWorktreeReason(worktreePath: string, now: number, graceMs = WORKTREE_CREATION_GRACE_MS): string | null {
  const directory = administrativeDirectory(worktreePath);
  if (!directory) return 'its git link is not written yet, so it may still be in creation';
  if (existsSync(join(directory, 'locked'))) return 'git holds it locked (being created, or locked by hand)';
  try {
    const age = now - lstatSync(join(worktreePath, '.git')).mtimeMs;
    return age < graceMs ? `it was created ${Math.max(0, Math.round(age / 1000))} s ago and may still be in creation` : null;
  } catch { return 'its git link could not be read'; }
}

export function isMarkedProductWorktree(worktreePath: string): boolean {
  const directory = administrativeDirectory(worktreePath);
  if (!directory) return false;
  try { return lstatSync(join(directory, MARKER_FILE)).isFile(); }
  catch { return false; }
}
