import { stat } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';
import { WALK_SKIP_DIRS } from '../../utils/walk-dir.js';

/**
 * The per-project file list every `find` mode shares (files, content,
 * symbols, references, structural): the files a search walk selects under a
 * directory, held between searches so a repeated search walks nothing. Each
 * held directory also records the ignore files (`.gitignore`, `.ignore`) its
 * listing named, so files mode reports nested ignore files without a second
 * walk through hidden entries.
 *
 * Invalidation is by directory stamp, not by walking again. Every directory the
 * walk entered is kept with a stamp (inode, change time, modification time)
 * taken no later than its listing: when its parent's listing names it. A search
 * stats each held directory under its path (one `stat` per directory, no
 * listing, no file opened) and lists again only the directories whose stamp
 * moved: a file created, removed or renamed in a directory changes that
 * directory's stamp, whether the write came from this process's tools (an edit
 * renames a temporary file over its target), a command, the owner's editor or
 * git. A new directory is walked; a removed one is dropped with everything
 * below it. The project-files epoch (intelligence/project-files-epoch.ts) knows
 * only this process's own writes, so it cannot carry an outside change; the
 * stamps carry both.
 *
 * A directory whose change time is within {@link RACY_MS} of its stamp may
 * change again inside the same timestamp tick (coarse file-system clocks), or
 * have changed between the stamp and the listing, so it is listed again at the
 * next search until its stamp is older than that.
 *
 * Cost per search: one `stat` per held directory under the searched path, and
 * a `readdir` per changed directory. Building a list costs one `stat` per
 * directory more than a walk. A list built under a contract's captured input,
 * one cut short by the time budget, one that met a protected directory or the
 * product worktrees, or one over {@link FILE_LIST_MAX_FILES} files is returned
 * but not kept.
 */

/** Projects whose lists one process keeps; the least recently used is dropped first. */
const FILE_LISTS_MAX = 8;
/** A list with more files than this is not kept. */
export const FILE_LIST_MAX_FILES = 250_000;
/** A directory whose change time is this close to the time of its stamp is listed again at the next search. */
const RACY_MS = 2_000;

interface DirNode {
  /** Inode, change time and modification time in nanoseconds; empty when the directory could not be stat-ed. */
  stamp: string;
  /** Changed so recently that a further change may not move the stamp. */
  racy: boolean;
  /** Files directly in this directory that the walk selected. */
  readonly files: string[];
  /** Directories directly below this one that the walk entered (or kept unchanged). */
  readonly dirs: string[];
  /** Ignore files (`.gitignore`, `.ignore`) directly in this directory. */
  readonly ignoreFiles: string[];
}

interface FlatList {
  readonly files: readonly string[];
  readonly ignoreFiles: readonly string[];
}

interface FileTree {
  readonly root: string;
  readonly includeProductWorktrees: boolean;
  readonly nodes: Map<string, DirNode>;
  fileCount: number;
  /** Flattened lists by searched directory, until the tree changes. */
  readonly flat: Map<string, FlatList>;
}

/**
 * The walk a list is built with: the search walk from `start` (no hidden
 * entries, no followed links), which asks `hooks.enter` about every directory
 * its listings name before it decides to descend, passes every ignore file its
 * listings name to `hooks.ignoreFile`, and calls `hooks.notKept` when what it
 * met makes the list unfit to keep.
 */
export type FileListWalk = (start: string, hooks: FileListWalkHooks) => AsyncIterable<string>;

export interface FileListWalkHooks {
  /** False: the walk must not enter this directory (the list holds it unchanged). */
  readonly enter: (directory: string) => boolean;
  /** An ignore file (`.gitignore`, `.ignore`) in a listed directory; it is not a file of the list. */
  readonly ignoreFile: (path: string) => void;
  readonly notKept: () => void;
}

export interface FileListResult {
  readonly files: readonly string[];
  /** The ignore files of the listed directories, in the same order as `files`. */
  readonly ignoreFiles: readonly string[];
  /** The walk stopped at the time budget, so more files exist than are listed. */
  readonly cut: boolean;
}

const trees = new Map<string, FileTree>();
const locks = new Map<string, Promise<void>>();

function treeKey(root: string, includeProductWorktrees: boolean): string {
  return `${includeProductWorktrees ? 1 : 0}\0${root}`;
}

async function directoryStamp(directory: string): Promise<{ stamp: string; racy: boolean } | null> {
  try {
    const info = await stat(directory, { bigint: true });
    if (!info.isDirectory()) return null;
    const changedMs = Number(info.ctimeNs / 1_000_000n);
    return { stamp: `${info.ino}:${info.ctimeNs}:${info.mtimeNs}`, racy: Math.abs(Date.now() - changedMs) < RACY_MS };
  } catch {
    return null;
  }
}

/** Every held directory reachable from `start` (itself included), parents before children. */
function heldDirectories(tree: FileTree, start: string): string[] {
  const out: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const node = tree.nodes.get(directory);
    if (!node) continue;
    out.push(directory);
    for (let i = node.dirs.length - 1; i >= 0; i--) stack.push(node.dirs[i]!);
  }
  return out;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The files (and ignore files) under `start` in a fixed order: a directory's
 * files by name, then its subdirectories by name, each in the same way.
 */
function flatten(tree: FileTree, start: string): FlatList {
  const held = tree.flat.get(start);
  if (held) return held;
  const files: string[] = [];
  const ignoreFiles: string[] = [];
  const visit = (directory: string): void => {
    const node = tree.nodes.get(directory);
    if (!node) return;
    for (const file of [...node.files].sort(byCodeUnit)) files.push(file);
    for (const file of [...node.ignoreFiles].sort(byCodeUnit)) ignoreFiles.push(file);
    for (const child of [...node.dirs].sort(byCodeUnit)) visit(child);
  };
  visit(start);
  const out: FlatList = { files, ignoreFiles };
  tree.flat.set(start, out);
  return out;
}

/**
 * Walks `start` into `tree`: `start` and every directory the walk enters get a
 * new node (stamped when a listing names it), a directory `held` says is
 * unchanged is kept below its re-listed parent without being entered. Returns
 * the directories given new nodes.
 */
async function walkInto(tree: FileTree, start: string, walk: FileListWalk, held: (directory: string) => boolean, notKept: () => void): Promise<Set<string>> {
  const listed = new Set<string>();
  const stamps: Array<Promise<void>> = [];
  const fresh = (directory: string): DirNode => {
    const previous = tree.nodes.get(directory);
    if (previous) tree.fileCount -= previous.files.length;
    const node: DirNode = { stamp: '', racy: true, files: [], dirs: [], ignoreFiles: [] };
    tree.nodes.set(directory, node);
    listed.add(directory);
    stamps.push(directoryStamp(directory).then((stamp) => {
      node.stamp = stamp?.stamp ?? '';
      node.racy = stamp?.racy ?? true;
    }));
    return node;
  };
  fresh(start);
  const hooks: FileListWalkHooks = {
    enter: (directory) => {
      const parent = tree.nodes.get(dirname(directory));
      if (directory !== start && held(directory)) {
        // Still present and unchanged: kept below its re-listed parent, not entered.
        parent?.dirs.push(directory);
        return false;
      }
      // The walk itself skips conventional dependency and output directories.
      if (WALK_SKIP_DIRS.has(basename(directory)) || listed.has(directory)) return true;
      fresh(directory);
      parent?.dirs.push(directory);
      return true;
    },
    ignoreFile: (path) => {
      tree.nodes.get(dirname(path))?.ignoreFiles.push(path);
    },
    notKept,
  };
  try {
    for await (const file of walk(start, hooks)) {
      const node = tree.nodes.get(dirname(file));
      if (!node) continue;
      node.files.push(file);
      tree.fileCount++;
    }
  } finally {
    await Promise.all(stamps);
  }
  return listed;
}

/** Drops held directories in `before` (other than `start`) that are no longer reachable from `start`. */
function dropUnreachable(tree: FileTree, start: string, before: readonly string[]): void {
  const reachable = new Set(heldDirectories(tree, start));
  for (const directory of before) {
    if (directory === start || reachable.has(directory)) continue;
    const node = tree.nodes.get(directory);
    if (!node) continue;
    tree.fileCount -= node.files.length;
    tree.nodes.delete(directory);
  }
}

/** The held tree that covers `basePath`: its own, or one of an ancestor the search walk descends through to it. */
function coveringTree(basePath: string, includeProductWorktrees: boolean): FileTree | undefined {
  const own = trees.get(treeKey(basePath, includeProductWorktrees));
  if (own) return own;
  for (const tree of trees.values()) {
    if (tree.includeProductWorktrees !== includeProductWorktrees || !tree.nodes.has(basePath)) continue;
    const rel = relative(tree.root, basePath);
    if (!rel || rel.startsWith('..')) continue;
    // A directory the walk reaches from that root holds what a walk from it would select.
    if (rel.split(sep).some((part) => part.startsWith('.') || WALK_SKIP_DIRS.has(part))) continue;
    return tree;
  }
  return undefined;
}

function remember(tree: FileTree): void {
  const key = treeKey(tree.root, tree.includeProductWorktrees);
  trees.delete(key);
  if (trees.size >= FILE_LISTS_MAX) {
    const oldest = trees.keys().next().value;
    if (oldest !== undefined) trees.delete(oldest);
  }
  trees.set(key, tree);
}

function forget(tree: FileTree): void {
  const key = treeKey(tree.root, tree.includeProductWorktrees);
  if (trees.get(key) === tree) trees.delete(key);
}

/** Runs `operation` after every earlier operation on `key` has finished. */
async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => mine);
  locks.set(key, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

/**
 * The files the search walk selects under `basePath`, from the held list when
 * there is one (checked by directory stamps and brought up to date by listing
 * only the directories that changed), else from one walk that is then kept.
 * `isProtected` says whether a held directory has since become a protected
 * captured-input directory; the list is then walked again under the caller's
 * own checks. `isCut` says whether the walk stopped at the time budget.
 */
export async function projectFileList(
  basePath: string,
  includeProductWorktrees: boolean,
  walk: FileListWalk,
  isProtected: (directory: string) => boolean,
  isCut: () => boolean,
): Promise<FileListResult> {
  const covering = coveringTree(basePath, includeProductWorktrees);
  if (covering) {
    const refreshed = await withLock(treeKey(covering.root, includeProductWorktrees), () => refresh(covering, basePath, walk, isProtected, isCut));
    if (refreshed) return refreshed;
  }
  return withLock(treeKey(basePath, includeProductWorktrees), () => build(basePath, includeProductWorktrees, walk, isCut));
}

async function build(basePath: string, includeProductWorktrees: boolean, walk: FileListWalk, isCut: () => boolean): Promise<FileListResult> {
  const tree: FileTree = { root: basePath, includeProductWorktrees, nodes: new Map(), fileCount: 0, flat: new Map() };
  let keep = true;
  await walkInto(tree, basePath, walk, () => false, () => { keep = false; });
  const cut = isCut();
  const stale = trees.get(treeKey(basePath, includeProductWorktrees));
  if (!keep || cut || tree.nodes.get(basePath)?.stamp === '' || tree.fileCount > FILE_LIST_MAX_FILES) {
    if (stale) forget(stale);
  } else {
    remember(tree);
  }
  return { ...flatten(tree, basePath), cut };
}

/**
 * Brings the held directories under `start` up to date: one stat each, and a
 * listing of each one whose stamp moved (or that was racy). Null when the list
 * cannot serve this search (it was dropped, the searched directory is gone, or
 * a held directory became protected); the caller then walks.
 */
async function refresh(tree: FileTree, start: string, walk: FileListWalk, isProtected: (directory: string) => boolean, isCut: () => boolean): Promise<FileListResult | null> {
  if (trees.get(treeKey(tree.root, tree.includeProductWorktrees)) !== tree || !tree.nodes.has(start)) return null;
  const held = heldDirectories(tree, start);
  if (held.some(isProtected)) { forget(tree); return null; }
  const stamps = await Promise.all(held.map(directoryStamp));
  if (stamps[0] === null) { forget(tree); return null; }
  const changed = new Set<string>();
  for (const [index, directory] of held.entries()) {
    const now = stamps[index];
    const node = tree.nodes.get(directory)!;
    if (!now || node.racy || now.stamp !== node.stamp) changed.add(directory);
  }
  if (changed.size === 0) {
    remember(tree);
    return { ...flatten(tree, start), cut: false };
  }
  tree.flat.clear();
  let keep = true;
  const listed = new Set<string>();
  try {
    // Parents first. A re-listed directory enters its changed and new
    // subdirectories, keeps its unchanged ones without entering them, and drops
    // what is gone; a changed directory below an unchanged one is re-listed on
    // its own when the loop reaches it.
    for (const [index, directory] of held.entries()) {
      if (!changed.has(directory) || listed.has(directory) || !tree.nodes.has(directory)) continue;
      const before = heldDirectories(tree, directory);
      if (stamps[index] === null) {
        // Gone, and its parent was not re-listed (a removal moves the parent's stamp, so this is a race): unlink it here.
        const parent = tree.nodes.get(dirname(directory));
        const at = parent ? parent.dirs.indexOf(directory) : -1;
        if (parent && at >= 0) parent.dirs.splice(at, 1);
        dropUnreachable(tree, start, before);
        continue;
      }
      const entered = await walkInto(tree, directory, walk, (child) => tree.nodes.has(child) && !changed.has(child), () => { keep = false; });
      for (const each of entered) listed.add(each);
      dropUnreachable(tree, directory, before);
      if (isCut()) break;
    }
  } catch (error) {
    forget(tree);
    throw error;
  }
  const cut = isCut();
  if (!keep || cut || tree.fileCount > FILE_LIST_MAX_FILES) forget(tree);
  else remember(tree);
  return { ...flatten(tree, start), cut };
}
