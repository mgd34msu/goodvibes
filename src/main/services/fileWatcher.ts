// ============================================================================
// FILE WATCHER SERVICE (P3) - Enhanced File System Watching
// ============================================================================

import fs from 'fs/promises';
import { existsSync, watch, FSWatcher, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { Logger } from './logger.js';

const logger = new Logger('FileWatcher');

// ============================================================================
// TYPES
// ============================================================================

export interface WatchConfig {
  path: string;
  recursive?: boolean;
  filter?: (filename: string) => boolean;
  debounceMs?: number;
  persistent?: boolean;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  watchId: string;
  timestamp: number;
  stats?: {
    size: number;
    mtime: number;
  };
}

export interface WatchedPath {
  id: string;
  config: WatchConfig;
  watcher: FSWatcher | null;
  lastActivity: number;
  eventCount: number;
}

// ============================================================================
// FILE WATCHER SERVICE
// ============================================================================

class FileWatcherService extends EventEmitter {
  private readonly MAX_FILE_CACHE_SIZE = 5000;
  private watchers: Map<string, WatchedPath> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private fileCache: Map<string, { size: number; mtime: number }> = new Map();
  private watchIdCounter = 0;
  // Track watchId -> listener function associations for proper cleanup
  private callbackListeners: Map<string, (event: FileChangeEvent) => void> = new Map();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Add entry to file cache with LRU eviction.
   */
  private addToFileCache(path: string, stats: { size: number; mtime: number }): void {
    if (this.fileCache.size >= this.MAX_FILE_CACHE_SIZE) {
      const firstKey = this.fileCache.keys().next().value;
      if (firstKey) this.fileCache.delete(firstKey);
    }
    this.fileCache.set(path, stats);
  }

  // ============================================================================
  // WATCH MANAGEMENT
  // ============================================================================

  /**
   * Start watching a path
   */
  watch(config: WatchConfig): string {
    const watchId = `watch-${++this.watchIdCounter}`;

    if (!existsSync(config.path)) {
      logger.warn(`Path does not exist: ${config.path}`);
      throw new Error(`Path does not exist: ${config.path}`);
    }

    const isDirectory = statSync(config.path).isDirectory();

    try {
      const watcher = watch(
        config.path,
        {
          recursive: config.recursive ?? isDirectory,
          persistent: config.persistent ?? true,
        },
        (eventType, filename) => {
          if (filename) {
            this.handleFsEvent(watchId, eventType, filename, config);
          }
        }
      );

      watcher.on('error', (error) => {
        logger.error(`Watch error for ${config.path}:`, error);
        this.emit('error', { watchId, path: config.path, error });
      });

      const watchedPath: WatchedPath = {
        id: watchId,
        config,
        watcher,
        lastActivity: Date.now(),
        eventCount: 0,
      };

      this.watchers.set(watchId, watchedPath);

      logger.info(`Started watching: ${config.path} (${watchId})`);
      this.emit('watch:start', { watchId, path: config.path });

      return watchId;
    } catch (error) {
      logger.error(`Failed to watch: ${config.path}`, error);
      throw error;
    }
  }

  /**
   * Stop watching a path
   */
  unwatch(watchId: string): boolean {
    const watched = this.watchers.get(watchId);
    if (!watched) {
      return false;
    }

    if (watched.watcher) {
      watched.watcher.close();
    }

    // Clear any pending debounce timers
    for (const [key, timer] of this.debounceTimers) {
      if (key.startsWith(`${watchId}:`)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }

    // Remove the callback listener if one was registered for this watchId
    const listener = this.callbackListeners.get(watchId);
    if (listener) {
      this.removeListener('change', listener);
      this.callbackListeners.delete(watchId);
    }

    this.watchers.delete(watchId);

    logger.info(`Stopped watching: ${watched.config.path} (${watchId})`);
    this.emit('watch:stop', { watchId, path: watched.config.path });

    return true;
  }

  /**
   * Stop all watchers
   */
  unwatchAll(): void {
    for (const watchId of this.watchers.keys()) {
      this.unwatch(watchId);
    }
  }

  /**
   * Get all watched paths
   */
  getWatchedPaths(): WatchedPath[] {
    return Array.from(this.watchers.values());
  }

  /**
   * Check if a path is being watched
   */
  isWatching(pathToCheck: string): boolean {
    for (const watched of this.watchers.values()) {
      if (watched.config.path === pathToCheck) {
        return true;
      }
    }
    return false;
  }

  // ============================================================================
  // EVENT HANDLING
  // ============================================================================

  /**
   * Handle raw filesystem events
   */
  private handleFsEvent(
    watchId: string,
    eventType: string,
    filename: string,
    config: WatchConfig
  ): void {
    const fullPath = path.isAbsolute(filename)
      ? filename
      : path.join(config.path, filename);

    // Apply filter if provided
    if (config.filter && !config.filter(filename)) {
      return;
    }

    // Get debounce key
    const debounceKey = `${watchId}:${fullPath}`;

    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(debounceKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const debounceMs = config.debounceMs ?? 100;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(debounceKey);
      this.processEvent(watchId, fullPath);
    }, debounceMs);

    this.debounceTimers.set(debounceKey, timer);
  }

  /**
   * Process debounced event
   */
  private async processEvent(watchId: string, fullPath: string): Promise<void> {
    const watched = this.watchers.get(watchId);
    if (!watched) return;

    watched.lastActivity = Date.now();
    watched.eventCount++;

    try {
      const exists = existsSync(fullPath);
      const cached = this.fileCache.get(fullPath);

      let event: FileChangeEvent;

      if (!exists) {
        // File/dir was deleted
        const wasDir = cached === undefined; // Can't know for sure, assume file
        event = {
          type: wasDir ? 'unlinkDir' : 'unlink',
          path: fullPath,
          watchId,
          timestamp: Date.now(),
        };
        this.fileCache.delete(fullPath);
      } else {
        const stats = await fs.stat(fullPath);
        const isDir = stats.isDirectory();

        if (!cached) {
          // New file/dir
          event = {
            type: isDir ? 'addDir' : 'add',
            path: fullPath,
            watchId,
            timestamp: Date.now(),
            stats: {
              size: stats.size,
              mtime: stats.mtimeMs,
            },
          };
        } else {
          // Changed file/dir
          event = {
            type: 'change',
            path: fullPath,
            watchId,
            timestamp: Date.now(),
            stats: {
              size: stats.size,
              mtime: stats.mtimeMs,
            },
          };
        }

        // Update cache
        this.addToFileCache(fullPath, {
          size: stats.size,
          mtime: stats.mtimeMs,
        });
      }

      logger.debug(`File event: ${event.type} - ${fullPath}`);
      this.emit('change', event);
      this.emit(`change:${event.type}`, event);
    } catch (error) {
      logger.warn(`Error processing file event for ${fullPath}:`, error);
    }
  }

  // ============================================================================
  // SPECIALIZED WATCHERS
  // ============================================================================

  /**
   * Watch Claude session files
   */
  watchClaudeSessions(callback?: (event: FileChangeEvent) => void): string {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');

    if (!existsSync(claudeDir)) {
      logger.warn(`Claude directory not found: ${claudeDir}`);
      // Create it so we can watch for future sessions
      fs.mkdir(claudeDir, { recursive: true }).catch((error) => {
        logger.error(`Failed to create Claude sessions directory: ${claudeDir}`, error);
      });
    }

    const watchId = this.watch({
      path: claudeDir,
      recursive: true,
      filter: (filename) => filename.endsWith('.jsonl'),
      debounceMs: 500,
    });

    if (callback) {
      // Store listener reference for cleanup in unwatch()
      const listener = (event: FileChangeEvent) => {
        if (event.watchId === watchId) {
          callback(event);
        }
      };
      this.callbackListeners.set(watchId, listener);
      this.on('change', listener);
    }

    return watchId;
  }

  /**
   * Watch Claude settings files
   */
  watchClaudeSettings(callback?: (event: FileChangeEvent) => void): string[] {
    const watchIds: string[] = [];

    // Watch user settings
    const userSettingsDir = path.join(os.homedir(), '.claude');
    if (existsSync(userSettingsDir)) {
      const id = this.watch({
        path: userSettingsDir,
        recursive: false,
        filter: (filename) => filename.endsWith('.json'),
        debounceMs: 300,
      });
      watchIds.push(id);
    }

    if (callback && watchIds.length > 0) {
      // Store listener reference for cleanup in unwatch()
      // For multiple watchIds, we register the same listener for each
      const listener = (event: FileChangeEvent) => {
        if (watchIds.includes(event.watchId)) {
          callback(event);
        }
      };
      // Associate this listener with all watchIds so any unwatch() call removes it
      for (const watchId of watchIds) {
        this.callbackListeners.set(watchId, listener);
      }
      this.on('change', listener);
    }

    return watchIds;
  }

  /**
   * Watch project for changes
   */
  watchProject(projectPath: string, callback?: (event: FileChangeEvent) => void): string {
    const watchId = this.watch({
      path: projectPath,
      recursive: true,
      filter: (filename) => {
        // Ignore common non-essential files
        const ignoredPatterns = [
          /node_modules/,
          /\.git\//,
          /\.vscode/,
          /\.idea/,
          /dist\//,
          /build\//,
          /coverage\//,
          /\.DS_Store/,
          /Thumbs\.db/,
        ];
        return !ignoredPatterns.some((pattern) => pattern.test(filename));
      },
      debounceMs: 200,
    });

    if (callback) {
      // Store listener reference for cleanup in unwatch()
      const listener = (event: FileChangeEvent) => {
        if (event.watchId === watchId) {
          callback(event);
        }
      };
      this.callbackListeners.set(watchId, listener);
      this.on('change', listener);
    }

    return watchId;
  }

  /**
   * Watch CLAUDE.md files
   */
  watchClaudeMd(projectPath: string, callback?: (event: FileChangeEvent) => void): string {
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');

    // If CLAUDE.md doesn't exist, watch the directory for it to be created
    const watchPath = existsSync(claudeMdPath) ? claudeMdPath : projectPath;

    const watchId = this.watch({
      path: watchPath,
      recursive: false,
      filter: (filename) => filename === 'CLAUDE.md' || filename.endsWith('/CLAUDE.md'),
      debounceMs: 300,
    });

    if (callback) {
      // Store listener reference for cleanup in unwatch()
      const listener = (event: FileChangeEvent) => {
        if (event.watchId === watchId) {
          callback(event);
        }
      };
      this.callbackListeners.set(watchId, listener);
      this.on('change', listener);
    }

    return watchId;
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Poll a file for changes (fallback for systems where watch doesn't work well)
   */
  startPolling(
    filePath: string,
    intervalMs: number = 1000,
    callback: (changed: boolean, stats?: { size: number; mtime: number }) => void
  ): () => void {
    let lastMtime = 0;
    let lastSize = 0;

    const checkFile = async () => {
      try {
        if (!existsSync(filePath)) {
          if (lastMtime !== 0) {
            callback(true, undefined);
            lastMtime = 0;
            lastSize = 0;
          }
          return;
        }

        const stats = await fs.stat(filePath);
        const changed = stats.mtimeMs !== lastMtime || stats.size !== lastSize;

        if (changed) {
          lastMtime = stats.mtimeMs;
          lastSize = stats.size;
          callback(true, { size: stats.size, mtime: stats.mtimeMs });
        }
      } catch (error) {
        logger.debug(`Polling error for ${filePath}:`, error);
      }
    };

    const interval = setInterval(checkFile, intervalMs);
    checkFile(); // Initial check

    return () => clearInterval(interval);
  }

  /**
   * Get file stats with caching
   */
  async getFileStats(filePath: string): Promise<{ size: number; mtime: number } | null> {
    const cached = this.fileCache.get(filePath);
    if (cached) {
      return cached;
    }

    try {
      const stats = await fs.stat(filePath);
      const result = { size: stats.size, mtime: stats.mtimeMs };
      this.addToFileCache(filePath, result);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Clear file cache
   */
  clearCache(): void {
    this.fileCache.clear();
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Shutdown the service
   */
  shutdown(): void {
    this.unwatchAll();

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear callback listener tracking (already removed by unwatchAll, but ensure cleanup)
    this.callbackListeners.clear();

    this.fileCache.clear();
    this.removeAllListeners();

    logger.info('File Watcher service shut down');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let fileWatcher: FileWatcherService | null = null;

export function getFileWatcher(): FileWatcherService {
  if (!fileWatcher) {
    fileWatcher = new FileWatcherService();
  }
  return fileWatcher;
}

export function shutdownFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.shutdown();
    fileWatcher = null;
  }
}

// Export the class for testing
export { FileWatcherService };
