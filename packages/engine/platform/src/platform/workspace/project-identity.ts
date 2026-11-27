/**
 * project-identity.ts, which project a folder belongs to: ONE answer for every part of the product that keys
 * something by project (permission rules and trust, "this project" memory, work, hooks, tool servers, the call
 * context a program sends, change notices).
 *
 * A project is, for a folder:
 *   1. the project of a worktree the product made (`<root>/.goodvibes/.worktrees/...`): `<root>`;
 *   2. else the NEAREST enclosing root among the registered workspaces (`<home>/.goodvibes/shared/
 *      workspace-registrations.json`) and the repository roots (a folder holding `.git`, a directory or a file):
 *      a program opened in a subfolder of a project is in that project, and a repository nested inside another is its
 *      own project;
 *   3. else the folder itself.
 * The answer is the real path (symbolic links resolved), so one folder reached by two paths is one project. A folder
 * that does not exist (yet) is taken as written, resolved. Nothing here writes or spawns; a few `stat` calls walk up.
 *
 * The registered workspaces are ALWAYS read (this process's home, `resolveGoodVibesHome`, read again only when the
 * register file changed), whoever asks: the caller check, the facilities, the settings view, the checkpoint store,
 * the reach rule for daemon turns, Work and every program's records folder give one folder one project. So two
 * projects registered inside one repository are two projects everywhere, and a registered folder that is no
 * repository, opened in a subfolder, is that folder's project. A program records the folder it is first opened in by
 * registering its project (runtime/workspace-registration.ts), never a subfolder of a repository.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { PRODUCT_WORKTREE_DIR_SEGMENTS } from '../git/product-worktree-marker.js';
import { resolveGoodVibesHome } from '../config/goodvibes-home.js';

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function covers(ancestor: string, path: string): boolean {
  return ancestor === path || path.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`);
}

/** The roots registered as workspaces in this home (any shape of the shared file that lists roots), real paths. */
export function registeredWorkspaceRoots(homeDirectory: string | undefined): readonly string[] {
  if (!homeDirectory) return [];
  const roots = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith(sep)) roots.add(real(value));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      for (const key of ['root', 'roots', 'registered', 'workspaces']) if (key in row) collect(row[key]);
    }
  };
  try { collect(JSON.parse(readFileSync(join(homeDirectory, '.goodvibes', 'shared', 'workspace-registrations.json'), 'utf-8'))); } catch { /* none */ }
  return [...roots];
}

let registerRead: { readonly path: string; readonly stamp: string; readonly roots: readonly string[] } | undefined;

/**
 * The registered workspace roots of this process's home ({@link registeredWorkspaceRoots} of `resolveGoodVibesHome()`),
 * parsed again only when the register file changed (its size, time and inode); one `stat` otherwise.
 */
export function homeRegisteredRoots(): readonly string[] {
  const home = resolveGoodVibesHome();
  const path = join(home, '.goodvibes', 'shared', 'workspace-registrations.json');
  let stamp = 'none';
  try { const s = statSync(path); stamp = `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { /* no register: no roots */ }
  if (registerRead?.path === path && registerRead.stamp === stamp) return registerRead.roots;
  const roots = stamp === 'none' ? [] : registeredWorkspaceRoots(home);
  registerRead = { path, stamp, roots };
  return roots;
}

/**
 * How far a tool working in `folder` may read and write: the project it is in ({@link projectIdentityOf}), so a
 * program opened in a subfolder works anywhere in its project; except that a worktree the product made for a piece of
 * work is bounded by itself, never the project it was made from.
 */
export function projectWriteRootOf(folder: string): string {
  const path = real(folder);
  const marker = `${sep}${PRODUCT_WORKTREE_DIR_SEGMENTS.join(sep)}${sep}`;
  const at = `${path}${sep}`.indexOf(marker);
  if (at > 0) {
    const worktree = path.slice(at + marker.length).split(sep)[0];
    return worktree ? path.slice(0, at + marker.length) + worktree : path;
  }
  return projectIdentityOf(path);
}

/**
 * The project a folder belongs to (see the file's comment). `registered`: the registered workspace roots
 * ({@link registeredWorkspaceRoots}) of a home the caller names; without them this process's home's
 * ({@link homeRegisteredRoots}).
 */
export function projectIdentityOf(folder: string, registered: readonly string[] = homeRegisteredRoots()): string {
  const path = real(folder);
  const marker = `${sep}${PRODUCT_WORKTREE_DIR_SEGMENTS.join(sep)}${sep}`;
  const inWorktree = `${path}${sep}`.indexOf(marker);
  if (inWorktree > 0) return path.slice(0, inWorktree);
  let repository: string | undefined;
  // The walk stops below the home folder: a repository at the home itself (kept dotfiles) is nobody's project, or
  // every folder under it without a repository of its own would be one project.
  const home = real(homedir());
  for (let at = path; at !== home && dirname(at) !== at; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) { repository = at; break; }
  }
  const registeredRoot = registered.filter((root) => covers(root, path)).sort((a, b) => b.length - a.length)[0];
  const nearest = [repository, registeredRoot].filter((root): root is string => root !== undefined).sort((a, b) => b.length - a.length)[0];
  return nearest ?? path;
}
