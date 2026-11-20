import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GitService } from '@goodvibes/engine/platform/platform/git';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';

/** Git state shown on the status bar (`branch main, changed`); shared by both terminal programs. */
export interface GitHeaderInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

const FALLBACK: GitHeaderInfo = { branch: '?', dirty: false, ahead: 0, behind: 0 };
/** A header read that produces nothing for this long is ended; the header shows '?' until a read succeeds. */
const GIT_READ_TIMEOUT_MS = 10_000;

function sameHeaderInfo(a: GitHeaderInfo, b: GitHeaderInfo): boolean {
  return a.branch === b.branch && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind;
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : '-';
  } catch {
    return '?';
  }
}

/** The repository's `.git` entry, its git directory and its common directory (they differ in a linked worktree). */
function locateGitDir(workingDirectory: string): { readonly entry: string; readonly gitDir: string; readonly commonDir: string } | null {
  let dir = resolve(workingDirectory);
  for (;;) {
    const entry = join(dir, '.git');
    try {
      const stat = statSync(entry, { throwIfNoEntry: false });
      if (stat?.isDirectory()) return { entry, gitDir: entry, commonDir: entry };
      if (stat?.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(entry, 'utf-8'))?.[1]?.trim();
        if (!pointer) return null;
        const gitDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
        let commonDir = gitDir;
        try {
          const common = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim();
          if (common) commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
        } catch { /* not a linked worktree */ }
        return { entry, gitDir, commonDir };
      }
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A few stats that change whenever what the header shows can change through
 * git: HEAD (branch switch), the index (stage, commit, checkout, reset), the
 * reflog (commit, rebase), packed refs, FETCH_HEAD and the remote-tracking
 * directories (fetch, pull, push: ahead/behind), and the `.git` entry itself
 * (`git init`, a removed repository).
 */
function gitStateStamp(workingDirectory: string): string {
  const located = locateGitDir(workingDirectory);
  if (!located) return 'none';
  const { entry, gitDir, commonDir } = located;
  const parts = [
    entry,
    fileStamp(entry),
    fileStamp(join(gitDir, 'HEAD')),
    fileStamp(join(gitDir, 'index')),
    fileStamp(join(gitDir, 'logs', 'HEAD')),
    fileStamp(join(commonDir, 'packed-refs')),
    fileStamp(join(commonDir, 'FETCH_HEAD')),
  ];
  try {
    const remotes = join(commonDir, 'refs', 'remotes');
    for (const remote of readdirSync(remotes)) parts.push(fileStamp(join(remotes, remote)));
  } catch { /* no remotes */ }
  return parts.join('|');
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
  private polledStamp: string | null = null;
  private polledFocus: boolean | null = null;
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
   * Keep the header current while the app is idle. A tick costs a few file
   * stats (gitStateStamp); git itself runs only when one of them moved (a
   * branch switch, commit, stage, fetch, push, `git init` or removed `.git`
   * made in another terminal) or when the terminal has just regained focus
   * (files edited in another app leave git's own files alone). onChange fires
   * only when the reading differs from the one already shown. A tick is skipped
   * while a fetch is in flight, so a stalled git never stacks processes or
   * blocks input. Turn and tool events refresh after the agent's own work.
   */
  startPolling(intervalMs: number, onChange: (info: GitHeaderInfo) => void, isFocused?: () => boolean | null): void {
    if (this.pollTimer !== null) return;
    this.polledStamp = gitStateStamp(this.workingDirectory);
    this.polledFocus = isFocused?.() ?? null;
    this.pollTimer = setInterval(() => {
      if (this.fetching) return;
      const stamp = gitStateStamp(this.workingDirectory);
      const focused = isFocused?.() ?? null;
      const regainedFocus = focused === true && this.polledFocus === false;
      this.polledFocus = focused;
      if (stamp === this.polledStamp && !regainedFocus) return;
      this.polledStamp = stamp;
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
      // A background read: it never takes .git/index.lock (an owner's or the
      // agent's own git command would fail on it), and a stalled git is ended
      // so `fetching` clears and the next tick reads again.
      const git = new GitService(this.workingDirectory, undefined, { noOptionalLocks: true, timeoutMs: GIT_READ_TIMEOUT_MS });
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
