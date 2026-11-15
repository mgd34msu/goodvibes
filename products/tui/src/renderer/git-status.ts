import { GitService } from '@goodvibes-jev/engine/platform/platform/git';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

/** Git state shown in the header bar. */
export interface GitHeaderInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

const FALLBACK: GitHeaderInfo = { branch: '?', dirty: false, ahead: 0, behind: 0 };

function sameHeaderInfo(a: GitHeaderInfo, b: GitHeaderInfo): boolean {
  return a.branch === b.branch && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind;
}

/**
 * GitStatusProvider, Fetches git state for the header bar.
 *
 * Results are cached for 2 seconds (TTL). The next call after expiry triggers
 * a fresh fetch and returns the cached value immediately (stale-while-revalidate).
 * Never throws, returns FALLBACK on any error.
 */
export class GitStatusProvider {
  private cache: GitHeaderInfo = { ...FALLBACK };
  private lastFetch = 0;
  private readonly ttlMs = 2000;
  private fetching = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly workingDirectory: string) {}

  /** Returns cached info immediately; refreshes in background if TTL expired. */
  async getStatus(): Promise<GitHeaderInfo> {
    const now = Date.now();
    if (now - this.lastFetch < this.ttlMs) {
      return this.cache;
    }
    // Fetch synchronously on first call (no cache yet), otherwise return stale
    if (this.lastFetch === 0) {
      await this._fetch().catch(() => {
        // Ensure fallback is set if _fetch failed before setting lastFetch
        if (this.lastFetch === 0) {
          this.lastFetch = Date.now();
        }
      });
    } else if (!this.fetching) {
      this._fetch().catch(err => { logger.debug('GitStatusProvider: background refresh failed', { error: summarizeError(err) }); });
    }
    return this.cache;
  }

  /** Force a fresh fetch and update the cache. Returns updated info. */
  async refresh(): Promise<GitHeaderInfo> {
    await this._fetch();
    return this.cache;
  }

  /**
   * Keep the header current while the app is idle: every tick runs the same
   * non-blocking fetch as refresh(), so a branch switch, commit, newly dirty
   * tree, `git init` or removed `.git` made in another terminal shows within
   * one interval. onChange fires only when the reading differs from the one
   * already shown. A tick is skipped while a fetch is in flight, so a stalled
   * git never stacks processes or blocks input.
   */
  startPolling(intervalMs: number, onChange: (info: GitHeaderInfo) => void): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      if (this.fetching) return;
      const shown = this.cache;
      this.refresh().then((info) => {
        if (!sameHeaderInfo(shown, info)) onChange(info);
      }).catch((err) => {
        logger.debug('GitStatusProvider: poll refresh failed', { error: summarizeError(err) });
      });
    }, intervalMs);
  }

  /** Stop the poll started by startPolling(). No-op if not polling. */
  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async _fetch(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const git = new GitService(this.workingDirectory);
      const [statusResult, branchResult] = await Promise.all([
        git.status(),
        git.branch(),
      ]);
      const dirty =
        statusResult.modified.length > 0 ||
        statusResult.created.length > 0 ||
        statusResult.deleted.length > 0 ||
        statusResult.renamed.length > 0 ||
        statusResult.conflicted.length > 0 ||
        statusResult.not_added.length > 0;
      this.cache = {
        // Empty `current` means an unborn HEAD, a repo with no commits yet.
        // Show "new" instead of an unfriendly "?" for that first-run case. (5a)
        branch: branchResult.current || 'new',
        dirty,
        ahead: statusResult.ahead ?? 0,
        behind: statusResult.behind ?? 0,
      };
      this.lastFetch = Date.now();
    } catch {
      // Never throw. A failure after an earlier success (the repo was removed, git broke) must not leave the old branch and dirty marker standing as current; and the failure is throttled like a success.
      this.cache = { ...FALLBACK };
      this.lastFetch = Date.now();
    } finally {
      this.fetching = false;
    }
  }
}
