import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { CallOptions } from '@goodvibes/judgment/decisions';
import type { WalkDirectoryCandidate } from './directory-reading.js';
import { logger } from './logger.js';
import { summarizeError } from './error-display.js';

/** Conventional generated/dependency directories excluded from recursive discovery. An explicit directory selection may include them. */
export const WALK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
]);

/**
 * True when the path is the product's own worktree directory (`.goodvibes/.worktrees`), or lies
 * inside it. Decided by path, never by the bare name: a project directory that happens to be called
 * `.worktrees` elsewhere is ordinary content.
 */
export function isInsideProductWorktrees(path: string): boolean {
  const parts = resolve(path).split(sep);
  for (let index = 1; index < parts.length; index++) {
    if (parts[index] === '.worktrees' && parts[index - 1] === '.goodvibes') return true;
  }
  return false;
}

/** The product worktree directory itself, not something inside it. */
function isProductWorktreesDirectory(path: string): boolean {
  const parts = resolve(path).split(sep);
  return parts.length >= 2 && parts[parts.length - 1] === '.worktrees' && parts[parts.length - 2] === '.goodvibes';
}

/** @deprecated Optional legacy byte budget. Traversal no longer silently excludes large files. */
export const WALK_MAX_FILE_SIZE = 1024 * 1024;

/**
 * beforeAttempt fences every filesystem checkpoint. beforeAsyncAttempt fences
 * traversal entry/exit and owner access checks, not local stat calls.
 */
export interface WalkDirOptions extends CallOptions {
  readonly includeHidden?: boolean;
  readonly followSymlinks?: boolean;
  readonly maxFileSize?: number;
  /** Explicit caller selection, evaluated before opening a file. */
  readonly selectFile?: (path: string) => boolean;
  /** False prunes a subtree; true explicitly includes it, even if conventionally skipped; undefined keeps the default. */
  readonly selectDirectory?: (path: string) => boolean | undefined;
  /** A bounded caller can stop without publishing files discovered after its deadline. */
  readonly shouldContinue?: () => boolean;
  /** Checked outside filesystem-error catches, before opening each path. */
  readonly assertPath?: (path: string) => void;
  /**
   * Descend into the product's `.goodvibes/.worktrees` directory, which holds full copies of the
   * project for other agents and contracts and would swamp results with duplicates. Skipped by
   * default unless the walk root is already inside it.
   */
  readonly includeProductWorktrees?: boolean;
  /** Called when the product worktree directory was skipped, with its path and how many entries it holds. */
  readonly onSkippedProductWorktrees?: (path: string, entryCount: number | undefined) => void;
}

class WalkStopped extends Error {}

/**
 * A root-owned directory selection cache. Share only within one invocation (for example its
 * ignore-file discovery and glob scan), never between roots or requests.
 */
export class DirectoryWalk {
  readonly root: string;
  private readonly skipped = new Map<string, boolean>();
  private realRoot: string | undefined;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async readDirectories(candidates: readonly WalkDirectoryCandidate[], options: CallOptions): Promise<void> {
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    // Directory discovery is local filesystem work. A probabilistic reading must
    // not veto descent or make a project disappear when Jev is unavailable.
    for (const candidate of candidates) this.skipped.set(candidate.relativePath, WALK_SKIP_DIRS.has(candidate.name));
  }

  /** Automatic index maintenance uses the same root-relative directory exclusions. */
  async excludesFile(filePath: string, options: CallOptions = {}): Promise<boolean> {
    const path = relative(this.root, resolve(filePath));
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('File is outside the directory walk root');
    options.signal?.throwIfAborted(); options.beforeAttempt?.();
    const initialRoot = await realpath(this.root);
    options.signal?.throwIfAborted(); options.beforeAttempt?.();
    this.realRoot ??= initialRoot;
    if (this.realRoot !== initialRoot) throw new Error('Directory walk path changed during reading');
    const parts = path.split(sep);
    if (parts.some(part => part.startsWith('.'))) return true;
    const ancestors = parts.slice(0, -1).map((name, index) => ({ name, relativePath: parts.slice(0, index + 1).join('/') }));
    await this.readDirectories(ancestors, { ...options, site: options.site ?? 'utils.walk-directory' });
    if (ancestors.some(candidate => this.skipped.get(candidate.relativePath) === true)) return true;
    // Automatic maintenance follows the full walk's no-symlink boundary, even
    // when a file-writing hook names an alias or an ancestor changed mid-read.
    for (let index = 0; index <= parts.length; index++) {
      const local = join(this.root, ...parts.slice(0, index));
      let info: Awaited<ReturnType<typeof lstat>>;
      let actual: string;
      try { info = await lstat(local); actual = await realpath(local); } catch {
        options.signal?.throwIfAborted(); options.beforeAttempt?.();
        return true;
      }
      options.signal?.throwIfAborted(); options.beforeAttempt?.();
      if ((index > 0 && info.isSymbolicLink()) || (index > 0 && index < parts.length && !info.isDirectory())) return true;
      if (actual !== join(this.realRoot, ...parts.slice(0, index))) throw new Error('Directory walk path changed during reading');
      if (index === parts.length && !info.isFile()) return true;
    }
    return false;
  }

  /** Traverse selected directories under the caller’s cancellation and access checks. */
  async *files(options: WalkDirOptions = {}): AsyncGenerator<string> {
    const root = this.root;
    const skipped = this.skipped;
    const owner = this;
    const maxFileSize = options.maxFileSize;
    const assertCurrent = (): void => {
      options.signal?.throwIfAborted();
      options.beforeAttempt?.();
      if (options.shouldContinue?.() === false) throw new WalkStopped();
    };
    // Resolved promises keep running in the microtask queue: a long scan gives
    // stdin and timers a turn about every 4 ms.
    let yieldAt = performance.now() + 4;
    const yieldTurn = async (): Promise<void> => {
      if (performance.now() < yieldAt) return;
      await new Promise<void>(resolve => setImmediate(resolve));
      yieldAt = performance.now() + 4;
    };
    const checkCurrent = async (): Promise<void> => { await yieldTurn(); assertCurrent(); };
    const checkReadAccess = async (): Promise<void> => {
      assertCurrent();
      await options.beforeAsyncAttempt?.();
      assertCurrent();
    };
    // The directory-selection step runs inside a visit that already checked the caller.
    const readingOptions: CallOptions = { site: options.site ?? 'utils.walk-directory' };

    /**
     * The per-directory real-path anchor of a no-follow walk: a directory
     * listed as a directory must still resolve under the initial real root, so
     * a directory swapped for a symlink between listing and reading cannot take
     * the walk outside it. One `realpath` per directory; files are trusted by
     * the listing's entry type and never resolved one by one.
     */
    async function anchored(dir: string): Promise<boolean> {
      let actual: string;
      try { actual = await realpath(dir); } catch (err) {
        logger.warn('walkDir skipped unreadable directory', { path: dir, error: summarizeError(err) });
        return false;
      }
      owner.realRoot ??= actual;
      if (actual !== resolve(owner.realRoot, relative(root, dir))) {
        throw new Error('Directory walk path changed during reading');
      }
      return true;
    }

    async function* visit(dir: string, ancestors = new Set<string>()): AsyncGenerator<string> {
      // The caller's currency check runs once per directory, not per file.
      await checkCurrent();
      options.assertPath?.(dir);
      let descendants = ancestors;
      if (options.followSymlinks) {
        let actual: string;
        try { actual = await realpath(dir); } catch (err) {
          logger.warn('walkDir skipped unreadable directory', { path: dir, error: summarizeError(err) });
          return;
        }
        options.assertPath?.(actual);
        if (ancestors.has(actual)) return;
        descendants = new Set([...ancestors, actual]);
      } else if (!await anchored(dir)) return;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        logger.warn('walkDir skipped unreadable directory', { path: dir, error: summarizeError(err) });
        return;
      }
      // The leading-dot convention is explicit policy, not a meaning guess.
      const visible = entries.filter(entry => {
        if (!options.includeHidden && entry.name.startsWith('.')) return false;
        const fullPath = join(dir, entry.name);
        if (entry.isFile()) return options.selectFile?.(fullPath) !== false;
        if (entry.isDirectory()) return options.selectDirectory?.(fullPath) !== false;
        // A followed alias has unknown type until stat. Only skip it when
        // neither possible type is in the caller's explicit selection.
        return entry.isSymbolicLink() && options.followSymlinks
          && (options.selectFile?.(fullPath) !== false || options.selectDirectory?.(fullPath) !== false);
      });
      const directories: Dirent[] = [];
      const files: Dirent[] = [];
      for (const entry of visible) {
        if (entry.isDirectory()) directories.push(entry);
        else if (entry.isFile()) files.push(entry);
        else if (entry.isSymbolicLink() && options.followSymlinks) {
          options.assertPath?.(join(dir, entry.name));
          let info: Awaited<ReturnType<typeof stat>>;
          try {
            info = await stat(join(dir, entry.name));
          } catch (err) {
            logger.warn('walkDir skipped unreadable file', { path: join(dir, entry.name), error: summarizeError(err) });
            continue;
          }
          // Caller selection failures are not suppressible filesystem errors.
          if (info.isDirectory() && options.selectDirectory?.(join(dir, entry.name)) !== false) directories.push(entry);
          else if (info.isFile() && options.selectFile?.(join(dir, entry.name)) !== false) files.push(entry);
        }
      }
      const candidates = directories.map(entry => ({
        name: entry.name, relativePath: relative(root, join(dir, entry.name)).split(sep).join('/'),
      }));
      await owner.readDirectories(candidates, readingOptions);
      const fileNames = new Set(files.map(entry => entry.name));
      const directoryNames = new Set(directories.map(entry => entry.name));
      let seen = 0;
      for (const entry of visible) {
        if ((++seen & 255) === 0) await yieldTurn();
        if (options.shouldContinue?.() === false) throw new WalkStopped();
        const fullPath = join(dir, entry.name);
        options.assertPath?.(fullPath);
        if (directoryNames.has(entry.name)) {
          if (isProductWorktreesDirectory(fullPath) && !options.includeProductWorktrees && !isInsideProductWorktrees(root)
            && options.selectDirectory?.(fullPath) !== true) {
            let entryCount: number | undefined;
            try { entryCount = (await readdir(fullPath)).length; } catch { entryCount = undefined; }
            options.onSkippedProductWorktrees?.(fullPath, entryCount);
            continue;
          }
          const identity = relative(root, fullPath).split(sep).join('/');
          if (!skipped.get(identity) || options.selectDirectory?.(fullPath) === true) yield* visit(fullPath, descendants);
        } else if (fileNames.has(entry.name)) {
          // A size limit needs the size: the one per-file stat the walk makes.
          if (maxFileSize !== undefined) {
            try {
              const info = options.followSymlinks ? await stat(fullPath) : await lstat(fullPath);
              if (!info.isFile() || info.size > maxFileSize) continue;
            } catch (err) {
              logger.warn('walkDir skipped unreadable file', { path: fullPath, error: summarizeError(err) });
              continue;
            }
          }
          yield fullPath;
        }
      }
    }

    try {
      await checkReadAccess();
      yield* visit(root);
    } catch (error) {
      if (!(error instanceof WalkStopped)) throw error;
    } finally {
      // Async-generator return (limit/cap/break) is a publication boundary too.
      // Do not use shouldContinue here: reaching a bound is not lost authority.
      options.signal?.throwIfAborted();
      options.beforeAttempt?.();
      await options.beforeAsyncAttempt?.();
      options.signal?.throwIfAborted();
      options.beforeAttempt?.();
    }
  }
}

/** Hidden entries and symlinks follow caller options; file size is unrestricted by default. */
export async function* walkDir(dirPath: string, options: WalkDirOptions = {}): AsyncGenerator<string> {
  yield* new DirectoryWalk(dirPath).files(options);
}
