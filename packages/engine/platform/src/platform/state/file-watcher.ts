import { existsSync, readdirSync, statSync, watch } from 'fs';
import type { FSWatcher } from 'fs';
import { join, resolve, sep } from 'path';
import { logger } from '../utils/logger.js';
import type { ProjectIndex } from './project-index.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEvent } from '../hooks/types.js';
import { summarizeError } from '../utils/error-display.js';

/** Most paths one watcher holds a kernel watch on, root files and indexed files together. */
export const FILE_WATCHER_MAX_PATHS = 500;

/** The watcher that follows each project index, so a tool that indexes a file can have it watched without holding the watcher. */
const watcherByIndex = new WeakMap<ProjectIndex, FileWatcher>();
/** Watchers that are started, so a tool write is told only to those that could see it. */
const liveWatchers = new Set<FileWatcher>();

/** What a path holds now, precise enough to tell one write from the next: inode, size and nanosecond mtime, or 'absent'. */
function fileStamp(absPath: string): string {
  const stat = statSync(absPath, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}` : 'absent';
}

/**
 * The product's own tools just wrote (or removed) these paths. A watcher that
 * then sees the file in exactly that state knows the change is not an outside
 * one and fires no `Change:file:external` hook for it. Free when nothing is
 * watched; otherwise one `stat` per path.
 */
export function noteToolWrites(paths: Iterable<string>): void {
  if (liveWatchers.size === 0) return;
  for (const path of paths) {
    const absPath = resolve(path);
    let stamp: string | undefined;
    for (const watcher of liveWatchers) {
      if (!watcher.covers(absPath)) continue;
      stamp ??= fileStamp(absPath);
      watcher.noteOwnWrite(absPath, stamp);
    }
  }
}

/**
 * A tool just put `path` into `projectIndex` (a read or a write): watch it, so
 * a later change or deletion outside the tools is noticed. One map lookup; a
 * no-op when no watcher follows that index.
 */
export function watchIndexedFile(projectIndex: ProjectIndex, path: string): void {
  watcherByIndex.get(projectIndex)?.addPath(path);
}

/**
 * FileWatcher: notices project files changed outside the write and edit tools
 * (by the user's editor, git, a formatter, a shell command).
 *
 * Watches the project root's regular files and the files in the ProjectIndex,
 * at most FILE_WATCHER_MAX_PATHS of them, each with one kernel watch
 * (`fs.watch`); nothing is polled. Platform state under `.goodvibes/` is not
 * project content and is not watched. Events are debounced per file (100 ms).
 * On a change:
 *   1. The ProjectIndex is kept in step: a deleted file leaves it, any other
 *      change refreshes its token estimate.
 *   2. The `Change:file:external` hook fires (when a dispatcher is given).
 *
 * The file-state cache needs no notice: it compares the bytes a tool reads
 * with what the session last saw, so an outside change is a stale file there.
 *
 * The product's own writes are told apart by state, not by time: the write and
 * edit tools report what they left (noteToolWrites), and a change that finds
 * the file exactly so keeps the index current without firing the hook.
 * A file replaced by rename (editors, git, atomic writes) is watched again on
 * its new inode, so later changes and its deletion are still seen.
 *
 * Cost: one kernel watch per watched path; per change one timer, one or two
 * `stat` calls and, for an outside change, one hook dispatch. Per tool write,
 * one `stat` per watched path written.
 */
export class FileWatcher {
  private readonly projectIndex: ProjectIndex;
  private readonly hookDispatcher?: HookDispatcher | undefined;
  private projectRoot: string;

  /** Absolute paths currently being watched */
  private watchedPaths: Set<string> = new Set();
  /** Active FSWatcher instances keyed by absolute path */
  private watchers: Map<string, FSWatcher> = new Map();
  /** Pending debounce timers keyed by absolute path */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private watching = false;
  private capReported = false;
  /** What the product's own tools last left at a path (see noteToolWrites); bounded by FILE_WATCHER_MAX_PATHS. */
  private readonly ownWrites = new Map<string, string>();

  /** Debounce window in milliseconds */
  private static readonly DEBOUNCE_MS = 100;

  constructor(
    projectIndex: ProjectIndex,
    options: { projectRoot: string },
    hookDispatcher?: HookDispatcher,
  ) {
    this.projectIndex = projectIndex;
    this.hookDispatcher = hookDispatcher;
    this.projectRoot = resolve(options.projectRoot);
    watcherByIndex.set(projectIndex, this);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start watching: every regular file in the project root, then the files in
   * the ProjectIndex, up to FILE_WATCHER_MAX_PATHS. Files the read and write
   * tools index later join through watchIndexedFile.
   */
  async start(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    liveWatchers.add(this);

    const rootFiles = this.readRootFiles();
    for (const name of rootFiles) this.addPath(join(this.projectRoot, name));

    for (const entry of this.projectIndex.getFiles()) {
      if (this.watchedPaths.size >= FILE_WATCHER_MAX_PATHS) break;
      this.addPath(entry.path.startsWith('/') ? entry.path : join(this.projectRoot, entry.path));
    }

    this.watchRootForNewFiles();

    logger.debug('FileWatcher: started', { watched: this.watchedPaths.size });
  }

  /** Follow a workspace swap: stop watching the old tree and watch the new one. */
  async reroot(newProjectRoot: string): Promise<void> {
    const wasWatching = this.watching;
    this.stop();
    this.projectRoot = resolve(newProjectRoot);
    this.capReported = false;
    if (wasWatching) await this.start();
  }

  /**
   * A file created in the root after start() is picked up here: the root
   * directory is watched without recursion, only to register new regular files
   * and to retry paths that were missing when they were added.
   */
  private watchRootForNewFiles(): void {
    try {
      const watcher = watch(this.projectRoot, { recursive: false }, (_event: string, filename: string | null) => {
        if (!this.watching) return;
        if (filename) {
          const created = join(this.projectRoot, filename);
          try {
            if (!this.watchedPaths.has(created) && statSync(created).isFile()) {
              this.addPath(created);
              this._scheduleChange(created);
            }
          } catch { /* gone again, or not a file: nothing to watch */ }
        }
        this.retryMissingPaths();
      });
      watcher.on('error', (err) => {
        logger.warn('FileWatcher: root watcher error', { projectRoot: this.projectRoot, error: summarizeError(err) });
        try { watcher.close(); } catch { /* already closed */ }
        this.watchers.delete(this.projectRoot);
      });
      this.watchers.set(this.projectRoot, watcher);
    } catch (err) {
      logger.warn('FileWatcher: could not watch the project root for new files', { projectRoot: this.projectRoot, error: summarizeError(err) });
    }
  }

  /** Open a watcher for every registered path that has none yet (it did not exist, or its watcher failed). */
  private retryMissingPaths(): void {
    for (const absPath of this.watchedPaths) {
      if (!this.watchers.has(absPath)) this._openWatcher(absPath);
    }
  }

  /** Regular files directly in the project root. */
  private readRootFiles(): string[] {
    try {
      return readdirSync(this.projectRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      logger.warn('FileWatcher: project root listing failed', { projectRoot: this.projectRoot, error: summarizeError(err) });
      return [];
    }
  }

  /**
   * Stop watching all paths and clear all watchers.
   */
  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    liveWatchers.delete(this);
    this.ownWrites.clear();

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();

    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch (err) { logger.warn('FileWatcher: watcher close failed', { error: summarizeError(err) }); }
    }
    this.watchers.clear();
    this.watchedPaths.clear();

    logger.debug('FileWatcher: stopped');
  }

  /** Returns true if the watcher has been started and not stopped. */
  isWatching(): boolean {
    return this.watching;
  }

  // ---------------------------------------------------------------------------
  // Path management
  // ---------------------------------------------------------------------------

  /**
   * Add a file to the watch list, within FILE_WATCHER_MAX_PATHS.
   * If already watching, opens a watcher immediately.
   * Missing paths remain registered and are opened if they appear later.
   */
  addPath(inputPath: string): void {
    const absPath = resolve(inputPath);
    if (!absPath.startsWith(this.projectRoot + sep) || this.isPlatformState(absPath)) {
      logger.debug('FileWatcher: not watching a path outside the project or inside .goodvibes', { absPath });
      return;
    }
    if (this.watchedPaths.has(absPath)) return;
    if (this.watchedPaths.size >= FILE_WATCHER_MAX_PATHS) {
      if (!this.capReported) {
        this.capReported = true;
        logger.warn('FileWatcher: watch cap reached; later files are not watched', { cap: FILE_WATCHER_MAX_PATHS });
      }
      return;
    }
    this.watchedPaths.add(absPath);

    if (this.watching) this._openWatcher(absPath);
  }

  /**
   * Remove a path from the watch list and close its watcher.
   */
  removePath(inputPath: string): void {
    const absPath = resolve(inputPath);
    this.watchedPaths.delete(absPath);

    const timer = this.debounceTimers.get(absPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.debounceTimers.delete(absPath);
    }

    const watcher = this.watchers.get(absPath);
    if (watcher) {
      try { watcher.close(); } catch (err) { logger.warn('FileWatcher: watcher close failed', { absPath, error: summarizeError(err) }); }
      this.watchers.delete(absPath);
    }
  }

  /** Return a snapshot of all watched absolute paths. */
  getWatchedPaths(): ReadonlySet<string> {
    return new Set(this.watchedPaths);
  }

  /** Whether a change at `absPath` could reach this watcher: a watched file, or a new file in the project root. */
  covers(absPath: string): boolean {
    if (this.watchedPaths.has(absPath)) return true;
    return absPath.startsWith(this.projectRoot + sep) && !absPath.slice(this.projectRoot.length + 1).includes(sep) && !this.isPlatformState(absPath);
  }

  /** The product's own tools left `stamp` at `absPath`; a change that finds exactly that is not an outside one. */
  noteOwnWrite(absPath: string, stamp: string): void {
    this.ownWrites.delete(absPath);
    if (this.ownWrites.size >= FILE_WATCHER_MAX_PATHS) {
      const oldest = this.ownWrites.keys().next().value;
      if (oldest !== undefined) this.ownWrites.delete(oldest);
    }
    this.ownWrites.set(absPath, stamp);
  }

  private isPlatformState(absPath: string): boolean {
    const platformDir = join(this.projectRoot, '.goodvibes');
    return absPath === platformDir || absPath.startsWith(platformDir + sep);
  }

  private _openWatcher(absPath: string): void {
    if (this.watchers.has(absPath) || !existsSync(absPath)) return;
    try {
      const watcher = watch(absPath, { recursive: false }, (eventType: string) => {
        // A rename means the name now points elsewhere (an editor's or git's
        // replace, an atomic write) or nowhere: this watch follows the old
        // inode and would see nothing more, so it is dropped and reopened on
        // the path when the change is handled.
        if (eventType === 'rename') this._dropWatcher(absPath, watcher);
        this._scheduleChange(absPath);
      });
      watcher.on('error', (err) => {
        logger.warn('FileWatcher: watcher error', { absPath, error: summarizeError(err) });
        // Closed and released, so the path can be opened again; the path stays registered.
        try { watcher.close(); } catch { /* already closed */ }
        this.watchers.delete(absPath);
      });
      this.watchers.set(absPath, watcher);
    } catch (err) {
      logger.warn('FileWatcher: failed to open watcher', { absPath, error: summarizeError(err) });
    }
  }

  private _dropWatcher(absPath: string, watcher: FSWatcher): void {
    if (this.watchers.get(absPath) !== watcher) return;
    try { watcher.close(); } catch { /* already closed */ }
    this.watchers.delete(absPath);
  }

  private _scheduleChange(absPath: string): void {
    const existing = this.debounceTimers.get(absPath);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(absPath);
      this._handleChange(absPath);
    }, FileWatcher.DEBOUNCE_MS);
    timer.unref?.();

    this.debounceTimers.set(absPath, timer);
  }

  private _handleChange(absPath: string): void {
    if (!this.watching || this.isPlatformState(absPath)) return;
    logger.debug('FileWatcher: file changed', { absPath });

    let deleted = false;
    try {
      // Rough heuristic: ~4 bytes per token (same as ReadTool/ProjectIndex)
      this.projectIndex.upsertFile(absPath, Math.ceil(statSync(absPath).size / 4));
      // A file replaced by rename gets its watch back on the new inode.
      if (this.watchedPaths.has(absPath)) this._openWatcher(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        deleted = true;
        this.projectIndex.removeFile(absPath);
        // A file that comes back is a new incarnation; the root watcher or a
        // later addPath opens it again.
        const watcher = this.watchers.get(absPath);
        if (watcher) { try { watcher.close(); } catch { /* already closed */ } this.watchers.delete(absPath); }
      } else {
        this.projectIndex.upsertFile(absPath);
      }
    }

    // The product's own write, found exactly as the tool left it: the index is
    // current and there is nothing outside to report. The note stays for
    // further events of the same write; any other state retires it.
    const own = this.ownWrites.get(absPath);
    if (own !== undefined) {
      if (own === fileStamp(absPath)) return;
      this.ownWrites.delete(absPath);
    }

    if (this.hookDispatcher) {
      const event: HookEvent = {
        path: 'Change:file:external',
        phase: 'Change',
        category: 'file',
        specific: 'external',
        sessionId: 'file-watcher',
        timestamp: Date.now(),
        payload: { filePath: absPath, change: deleted ? 'deleted' : 'changed' },
      };
      this.hookDispatcher.fire(event).catch((err) => {
        logger.warn('FileWatcher: hook fire failed', { absPath, error: summarizeError(err) });
      });
    }
  }
}
