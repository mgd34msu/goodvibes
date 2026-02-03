// ============================================================================
// GIT WATCHER SERVICE - Watch for git status changes
// ============================================================================

import path from 'path';
import { existsSync, watch, FSWatcher } from 'fs';
import { Logger } from './logger.js';
import { sendToRenderer } from '../window.js';

const logger = new Logger('GitWatcher');

// ============================================================================
// GIT WATCHER SERVICE
// ============================================================================

class GitWatcherService {
  private watchers: Map<string, FSWatcher[]> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 300;

  /**
   * Start watching a git repository for changes
   */
  watchRepo(repoPath: string): boolean {
    const gitDir = path.join(repoPath, '.git');

    if (!existsSync(gitDir)) {
      logger.debug(`Not a git repo: ${repoPath}`);
      return false;
    }

    // Don't watch twice
    if (this.watchers.has(repoPath)) {
      return true;
    }

    const repoWatchers: FSWatcher[] = [];

    // Files/dirs that indicate git status changes
    const watchTargets = [
      path.join(gitDir, 'index'),        // Staging changes
      path.join(gitDir, 'HEAD'),         // Branch changes
      path.join(gitDir, 'refs', 'heads'), // Local branch updates
      path.join(gitDir, 'COMMIT_EDITMSG'), // Commit in progress
    ];

    for (const target of watchTargets) {
      if (existsSync(target)) {
        try {
          const watcher = watch(target, { persistent: false }, () => {
            this.handleChange(repoPath);
          });

          watcher.on('error', (err) => {
            logger.debug(`Watch error for ${target}:`, err);
          });

          repoWatchers.push(watcher);
        } catch (err) {
          logger.debug(`Failed to watch ${target}:`, err);
        }
      }
    }

    if (repoWatchers.length > 0) {
      this.watchers.set(repoPath, repoWatchers);
      logger.info(`Watching git repo: ${repoPath}`);
      return true;
    }

    return false;
  }

  /**
   * Stop watching a repository
   */
  unwatchRepo(repoPath: string): void {
    const repoWatchers = this.watchers.get(repoPath);
    if (repoWatchers) {
      for (const watcher of repoWatchers) {
        watcher.close();
      }
      this.watchers.delete(repoPath);

      // Clear any pending debounce
      const timer = this.debounceTimers.get(repoPath);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(repoPath);
      }

      logger.info(`Stopped watching git repo: ${repoPath}`);
    }
  }

  /**
   * Handle file change with debouncing
   */
  private handleChange(repoPath: string): void {
    // Clear existing timer
    const existingTimer = this.debounceTimers.get(repoPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(repoPath);
      logger.debug(`Git changed: ${repoPath}`);
      sendToRenderer('git-changed', { path: repoPath });
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(repoPath, timer);
  }

  /**
   * Shutdown all watchers
   */
  shutdown(): void {
    for (const repoPath of this.watchers.keys()) {
      this.unwatchRepo(repoPath);
    }
    logger.info('Git watcher service shut down');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let gitWatcher: GitWatcherService | null = null;

export function getGitWatcher(): GitWatcherService {
  if (!gitWatcher) {
    gitWatcher = new GitWatcherService();
  }
  return gitWatcher;
}

export function shutdownGitWatcher(): void {
  if (gitWatcher) {
    gitWatcher.shutdown();
    gitWatcher = null;
  }
}

export { GitWatcherService };
