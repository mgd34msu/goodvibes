import { existsSync, readdirSync, statSync, watch, watchFile, unwatchFile, type Stats } from 'fs';
import type { FSWatcher } from 'fs';
import { join, resolve, sep } from 'path';
import { logger } from '../utils/logger.js';
import type { FileStateCache } from './file-cache.js';
import type { ProjectIndex } from './project-index.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEvent } from '../hooks/types.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * FileWatcher, watches key project files and invalidates caches on change.
 *
 * Watches regular project-root files, the platform directory and indexed
 * files. Cache invalidation does not require interpreting a filename.
 *
 * Uses Node.js/Bun-native `fs.watch`. Debounces events per-file (100ms).
 * On change:
 *   1. Invalidates FileStateCache entry
 *   2. Upserts ProjectIndex with new token estimate
 *   3. Fires Change:file:external hook via HookDispatcher (if provided)
 */
export class FileWatcher {
  private readonly fileCache: FileStateCache;
  private readonly projectIndex: ProjectIndex;
  private readonly hookDispatcher?: HookDispatcher | undefined;
  private readonly projectRoot: string;

  /** Absolute paths currently being watched */
  private watchedPaths: Set<string> = new Set();
  /** Active FSWatcher instances keyed by absolute path */
  private watchers: Map<string, FSWatcher> = new Map();
  /** Pending debounce timers keyed by absolute path */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** watchFile listeners keyed by absolute path for reliable polling mode */
  private pollListeners: Map<string, (curr: Stats, prev: Stats) => void> = new Map();

  private watching = false;

  /** Debounce window in milliseconds */
  private static readonly DEBOUNCE_MS = 100;

  constructor(
    fileCache: FileStateCache,
    projectIndex: ProjectIndex,
    options: { projectRoot: string },
    hookDispatcher?: HookDispatcher,
  ) {
    this.fileCache = fileCache;
    this.projectIndex = projectIndex;
    this.hookDispatcher = hookDispatcher;
    this.projectRoot = options.projectRoot;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start watching all registered paths.
   * Adds every regular project-root file,
   * and .goodvibes/**. Also watches all files currently in ProjectIndex.
   */
  async start(): Promise<void> {
    if (this.watching) return;
    this.watching = true;

    let rootFiles: string[];
    try {
      rootFiles = await this.readRootFiles();
    } catch (err) {
      this.watching = false;
      throw err;
    }
    // stop() ran while the root was being read.
    if (!this.watching) return;

    for (const name of rootFiles) {
      this.addPath(join(this.projectRoot, name));
    }

    // Watch .goodvibes/ directory tree (recursive)
    this.addPath(join(this.projectRoot, '.goodvibes'));

    // Watch all files currently in ProjectIndex (cap at MAX_WATCHERS to avoid unbounded growth)
    const MAX_WATCHERS = 500;
    for (const entry of this.projectIndex.getFiles()) {
      if (this.watchedPaths.size >= MAX_WATCHERS) {
        logger.warn('FileWatcher: MAX_WATCHERS cap reached, skipping remaining files', { cap: MAX_WATCHERS });
        break;
      }
      const absPath = entry.path.startsWith('/')
        ? entry.path
        : join(this.projectRoot, entry.path);
      this.addPath(absPath);
    }

    this.watchRootForNewFiles();

    logger.debug('FileWatcher: started', { watched: this.watchedPaths.size });
  }

  /**
   * A file created in the root after start() (and a `.goodvibes` that did not
   * exist yet) is picked up here: the root directory is watched without
   * recursion, only to register new regular files and to retry paths that
   * were missing when they were added.
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

  /** Root entries are watched as files; directories retain their separate policy. */
  private async readRootFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = readdirSync(this.projectRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      logger.warn('FileWatcher: project root listing failed', { projectRoot: this.projectRoot, error: summarizeError(err) });
      return [];
    }
    return names;
  }

  /**
   * Stop watching all paths and clear all watchers.
   */
  stop(): void {
    if (!this.watching) return;
    this.watching = false;

    // Cancel pending debounces
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close all watchers
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch (err) { logger.warn('FileWatcher: watcher close failed', { error: summarizeError(err) }); }
    }
    this.watchers.clear();
    for (const [absPath, listener] of this.pollListeners) {
      try { unwatchFile(absPath, listener); } catch (err) { logger.warn('FileWatcher: unwatchFile failed', { absPath, error: summarizeError(err) }); }
    }
    this.pollListeners.clear();
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
   * Add a path to the watch list.
   * If already watching, opens a watcher immediately.
   * Missing paths remain registered and are opened if they appear later.
   */
  addPath(inputPath: string): void {
    const absPath = resolve(inputPath);
    if (!absPath.startsWith(this.projectRoot + '/') && absPath !== this.projectRoot) {
      logger.debug('FileWatcher: rejecting path outside project root', { absPath });
      return;
    }
    if (this.watchedPaths.has(absPath)) return;
    this.watchedPaths.add(absPath);

    if (this.watching) {
      this._openWatcher(absPath);
    }
  }

  /**
   * Remove a path from the watch list and close its watcher.
   */
  removePath(inputPath: string): void {
    const absPath = resolve(inputPath);
    this.watchedPaths.delete(absPath);

    // Cancel any pending debounce for this path
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
    const pollListener = this.pollListeners.get(absPath);
    if (pollListener) {
      try { unwatchFile(absPath, pollListener); } catch (err) { logger.warn('FileWatcher: unwatchFile failed', { absPath, error: summarizeError(err) }); }
      this.pollListeners.delete(absPath);
    }
  }

  /** Return a snapshot of all watched absolute paths. */
  getWatchedPaths(): ReadonlySet<string> {
    return new Set(this.watchedPaths);
  }

  private _openWatcher(absPath: string): void {
    if (!existsSync(absPath)) {
      logger.debug('FileWatcher: watch path does not exist yet', { path: absPath });
      return;
    }

    // Already watching this path
    if (this.watchers.has(absPath)) return;

    try {
      let isDir = false;
      try {
        isDir = statSync(absPath).isDirectory();
      } catch (error) {
        logger.warn('FileWatcher: stat before watch failed', {
          path: absPath,
          error: summarizeError(error),
        });
      }

      const watcher = watch(
        absPath,
        { recursive: isDir },
        (_event: string, filename: string | null) => {
          // For directories, reconstruct the changed file path
          const changedPath = isDir && filename
            ? join(absPath, filename)
            : absPath;
          this._scheduleChange(changedPath);
        },
      );

      watcher.on('error', (err) => {
        logger.warn('FileWatcher: watcher error', { absPath, error: summarizeError(err) });
        // Closed and released, so the path can be opened again; the path stays registered.
        try { watcher.close(); } catch { /* already closed */ }
        this.watchers.delete(absPath);
        const poll = this.pollListeners.get(absPath);
        if (poll) {
          try { unwatchFile(absPath, poll); } catch { /* not polled */ }
          this.pollListeners.delete(absPath);
        }
      });

      this.watchers.set(absPath, watcher);

      if (!isDir && !this.pollListeners.has(absPath)) {
        const pollListener = (curr: Stats, prev: Stats) => {
          if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
            this._scheduleChange(absPath);
          }
        };
        watchFile(absPath, { interval: FileWatcher.DEBOUNCE_MS }, pollListener);
        this.pollListeners.set(absPath, pollListener);
      }
    } catch (err) {
      logger.warn('FileWatcher: failed to open watcher', { absPath, error: summarizeError(err) });
    }
  }

  private _scheduleChange(absPath: string): void {
    // Cancel existing debounce for this path
    const existing = this.debounceTimers.get(absPath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(absPath);
      this._handleChange(absPath);
    }, FileWatcher.DEBOUNCE_MS);
    timer.unref?.();

    this.debounceTimers.set(absPath, timer);
  }

  private _handleChange(absPath: string): void {
    const platformDir = join(this.projectRoot, '.goodvibes') + sep;
    const insidePlatformDir = absPath.startsWith(platformDir);
    // The index writes its own file (and a temp file next to it) under
    // `.goodvibes`; reacting to those would write the index again, forever.
    if (insidePlatformDir && absPath.slice(platformDir.length).startsWith('project-index.json')) return;

    logger.debug('FileWatcher: file changed', { absPath });

    // 1. Invalidate the file cache entry
    this.fileCache.invalidate(absPath);

    // 2. Keep ProjectIndex in step: a deleted file leaves it, any other change
    // refreshes its token estimate. Platform state under `.goodvibes` is not
    // project content and is not indexed.
    if (!insidePlatformDir) {
      try {
        // Rough heuristic: ~4 bytes per token (same as ReadTool/ProjectIndex)
        this.projectIndex.upsertFile(absPath, Math.ceil(statSync(absPath).size / 4));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.projectIndex.removeFile(absPath);
        else this.projectIndex.upsertFile(absPath);
      }
    }

    // 3. Fire Change:file:external hook (fire-and-forget)
    if (this.hookDispatcher) {
      const event: HookEvent = {
        path: 'Change:file:external',
        phase: 'Change',
        category: 'file',
        specific: 'external',
        sessionId: 'file-watcher',
        timestamp: Date.now(),
        payload: { filePath: absPath },
      };
      this.hookDispatcher.fire(event).catch((err) => {
        logger.warn('FileWatcher: hook fire failed', { absPath, error: summarizeError(err) });
      });
    }
  }
}
