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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { PRODUCT_WORKTREE_DIR_SEGMENTS } from '../git/product-worktree-marker.js';
import { resolveGoodVibesHome } from '../config/goodvibes-home.js';

/**
 * The path as the filesystem itself names it (`realpathSync.native`): links resolved, and on a case-insensitive disk the
 * spelling the disk keeps, so `~/Projects/Alpha` and `~/projects/alpha` are one project there (two on a disk that tells
 * them apart).
 */
function real(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/**
 * One spelling per folder on disk: a disk that does not tell case apart (or a Linux folder with case folding on, whose
 * real path keeps the spelling it was given) can name one folder two ways; the folder's device and inode say it is
 * one, and the first spelling this process saw for it is the one every later answer gives.
 */
const spellingOf = new Map<string, string>();
const SPELLING_CACHE_BOUND = 4096;
function oneSpelling(path: string): string {
  let id: string;
  try { const s = statSync(path); id = `${s.dev}:${s.ino}`; } catch { return path; }
  const known = spellingOf.get(id);
  if (known !== undefined) {
    if (known === path) return path;
    // The inode may have been reused by another folder since: the known spelling counts only while it is this folder.
    try { const s = statSync(known); if (`${s.dev}:${s.ino}` === id) return known; } catch { /* gone */ }
  }
  if (spellingOf.size >= SPELLING_CACHE_BOUND) {
    const oldest = spellingOf.keys().next().value;
    if (oldest !== undefined) spellingOf.delete(oldest);
  }
  spellingOf.set(id, path);
  return path;
}

function covers(ancestor: string, path: string): boolean {
  return ancestor === path || path.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`);
}

/** The roots registered as workspaces in this home (any shape of the shared file that lists roots), real paths. */
export function registeredWorkspaceRoots(homeDirectory: string | undefined): readonly string[] {
  if (!homeDirectory) return [];
  const roots = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith(sep)) roots.add(oneSpelling(real(value)));
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
  const path = oneSpelling(real(folder));
  const marker = `${sep}${PRODUCT_WORKTREE_DIR_SEGMENTS.join(sep)}${sep}`;
  const inWorktree = `${path}${sep}`.indexOf(marker);
  if (inWorktree > 0) return path.slice(0, inWorktree);
  // A folder something holds keeps the project it had when it was first held (see `holdProjectIdentity`).
  const pinned = pins.get(path);
  if (pinned) return pinned.identity;
  const computed = computedIdentityOf(path, registered);
  // A register change that would merge a held project into a wider one (its parent registered) waits for every holder
  // of the held project to let go: until then, folders in it are still that project.
  let keep: string | undefined;
  for (const { identity } of pins.values()) {
    if (identity === computed || !covers(identity, path) || !covers(computed, identity)) continue;
    if (keep === undefined || identity.length > keep.length) keep = identity;
  }
  return keep ?? computed;
}

/** The folders something holds (a running turn, a project's facilities or Work), with the project each had then. */
const pins = new Map<string, { readonly identity: string; count: number }>();

/**
 * Holds `folder`'s project as it is now: while held, the folder (and any folder of that project a register change would
 * merge into a wider one) answers the same project, whatever is registered meanwhile. The returned release lets go
 * (once); when the last holder of a folder lets go, the folder is answered from the register again, so what is kept per
 * project is made again under the new answer only after nothing holds the old one. Held by the daemon's project
 * facilities for as long as a turn, a run or a project's Work uses them.
 */
export function holdProjectIdentity(folder: string): () => void {
  const path = oneSpelling(real(folder));
  const entry = pins.get(path) ?? { identity: projectIdentityOf(path), count: 0 };
  entry.count += 1;
  pins.set(path, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.count -= 1;
    if (entry.count <= 0 && pins.get(path) === entry) pins.delete(path);
  };
}

/**
 * The projects that exist inside `root` that registering `root` must not take into it (runtime registration, the
 * register's `add`): each folder below `root` that is its own project now (no repository or registered root nearer
 * than itself) and holds a project's records, and each project something
 * holds now. Registered as projects of their own beside `root`, they keep their identity; `root` becomes the project
 * only of folders that were none. "Holds a project's records": its `.goodvibes` folder holds anything (only a project's
 * root keeps one: a folder inside a project keeps its records at the project). Bounded walk (6 levels, 20 000
 * folders), skipping repositories' insides, dependency folders and hidden folders.
 */
export function projectsKeptInside(root: string, registered: readonly string[]): readonly string[] {
  const base = oneSpelling(real(root));
  const kept = new Set<string>();
  for (const { identity } of pins.values()) {
    if (identity !== base && covers(base, identity) && computedIdentityOf(identity, registered) === identity) kept.add(identity);
  }
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || visited > 20_000) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const child = join(dir, name);
      visited += 1;
      try { if (!statSync(child).isDirectory()) continue; } catch { continue; }
      // A repository below is its own project already (the nearest root): nothing inside it changes.
      if (existsSync(join(child, '.git'))) continue;
      if (holdsProjectRecords(join(child, '.goodvibes'))
        && computedIdentityOf(oneSpelling(real(child)), registered) === oneSpelling(real(child))) kept.add(oneSpelling(real(child)));
      walk(child, depth + 1);
    }
  };
  walk(base, 1);
  return [...kept];
}

/** Whether a folder's `.goodvibes` holds anything (records a project keeps there: sessions, checkpoints, settings). */
function holdsProjectRecords(records: string): boolean {
  try { return statSync(records).isDirectory() && readdirSync(records).length > 0; } catch { return false; }
}

function computedIdentityOf(path: string, registered: readonly string[]): string {
  let repository: string | undefined;
  // The walk stops below the home folder: a repository at the home itself (kept dotfiles) is nobody's project, or
  // every folder under it without a repository of its own would be one project.
  const home = real(homedir());
  const goodvibesHome = real(resolveGoodVibesHome());
  for (let at = path; at !== home && at !== goodvibesHome && dirname(at) !== at; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) { repository = at; break; }
  }
  const registeredRoot = registered.filter((root) => covers(root, path)).sort((a, b) => b.length - a.length)[0];
  const nearest = [repository, registeredRoot].filter((root): root is string => root !== undefined).sort((a, b) => b.length - a.length)[0];
  return oneSpelling(nearest ?? path);
}
