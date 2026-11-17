import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Retention policy for product-created worktrees under `.goodvibes/.worktrees`.
 *
 * - Nothing unique (clean, every commit already in the base): removed as soon as the owner ended.
 * - Clean but carrying commits the base does not have: kept until the retention
 *   period after the owner ended, then the DIRECTORY is removed and the branch
 *   stays, so the commits remain reachable.
 * - Ignored files only (`.env`, local databases, build output: removing a
 *   worktree deletes them and git keeps no copy): they delay removal, they do not
 *   forbid it. The worktree is kept for the retention period after its owner
 *   ended, listed with its size, then removed. Files that are copies of the main
 *   checkout's (a carried-over `.env` that still matches) and the dependency
 *   folders setup installs (`node_modules`, `.venv`) are not local state at all.
 * - Uncommitted changes, or git state that cannot be read: never removed here.
 * - No created-by record (made by a version before the record existed): removed
 *   once no running owner holds it, whatever it holds; its branch is kept unless
 *   every commit on it is already in its base.
 */
export const DEFAULT_WORKTREE_RETENTION_DAYS = 14;
export const DEFAULT_WORKTREE_RETENTION_MS = DEFAULT_WORKTREE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Total size of kept worktrees above which startup prints its one-line notice. */
export const DEFAULT_KEPT_WORKTREE_NOTICE_BYTES = 1024 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Who owns a worktree right now. `unknown` is never treated as ended on its own. */
export interface WorktreeOwnerInfo {
  readonly state: 'running' | 'ended' | 'unknown';
  /** When the owner ended; present for `ended`. */
  readonly endedAt?: number | undefined;
  /** The branch the worktree was created from, when the owner recorded it. */
  readonly baseBranch?: string | undefined;
}

/** What git says is in a worktree. */
export type WorktreeAssessment =
  /** `ignored`: ignored files or folders that are this worktree's own (not copies, not installed dependencies). */
  | { readonly kind: 'nothing-unique'; readonly branch: string | null; readonly ignored?: number | undefined }
  | { readonly kind: 'unmerged'; readonly branch: string | null; readonly commits: number; readonly base: string; readonly ignored?: number | undefined }
  | { readonly kind: 'uncommitted'; readonly changes: number; readonly ignored: number }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Why a worktree is on disk, in the words the listing shows. */
export type WorktreeKeepReason =
  | { readonly why: 'running'; readonly detail: string }
  | { readonly why: 'uncommitted'; readonly detail: string }
  | { readonly why: 'unmerged'; readonly detail: string; readonly pruneInDays: number | null }
  /** Only ignored files of its own: kept for the retention period, then removed. */
  | { readonly why: 'ignored'; readonly detail: string; readonly pruneInDays: number | null }
  | { readonly why: 'unreadable'; readonly detail: string }
  | { readonly why: 'protected'; readonly detail: string }
  | { readonly why: 'owner-unknown'; readonly detail: string; readonly pruneInDays: number | null }
  | { readonly why: 'removable'; readonly detail: string };

interface GitResult { readonly ok: boolean; readonly out: string }

export async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const child = Bun.spawn(['git', '-C', cwd, ...args], {
      stdout: 'pipe', stderr: 'ignore', stdin: 'ignore',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { ok: code === 0, out: out.trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Product-created worktrees sit directly under `.goodvibes/.worktrees/` in one
 * of the shapes the product itself creates. A directory that merely lives
 * under `.goodvibes` is not one.
 */
const PRODUCT_WORKTREE_SEGMENT = /^(?:agent-.+|contract|contract-planner|contract-input|ws|ws-ns|ws-owned)$/;

export function isProductWorktreePath(path: string, workingDirectory: string): boolean {
  const rel = relative(join(workingDirectory, '.goodvibes', '.worktrees'), path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return false;
  return PRODUCT_WORKTREE_SEGMENT.test(rel.split(sep)[0]!);
}

/**
 * Read what a worktree holds. Never throws; anything git cannot answer is
 * `unreadable`, which every caller treats as "keep".
 *
 * `baseBranch` is the branch the worktree was created from when the caller
 * knows it; otherwise the repository root's current HEAD is the base.
 */
export async function assessWorktree(path: string, rootDir: string, baseBranch?: string): Promise<WorktreeAssessment> {
  if (!existsSync(path)) return { kind: 'unreadable', reason: 'the directory is missing' };
  try {
    // A linked worktree has a `.git` FILE; a directory there is a whole repository, never ours to remove.
    if (!lstatSync(join(path, '.git')).isFile()) return { kind: 'unreadable', reason: 'it is not a linked git worktree' };
    const top = await runGit(path, ['rev-parse', '--show-toplevel']);
    if (!top.ok || realpathSync(top.out) !== realpathSync(path)) return { kind: 'unreadable', reason: 'git does not recognise it as a worktree root' };
  } catch {
    return { kind: 'unreadable', reason: 'it is not a readable git worktree' };
  }
  const status = await runGit(path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']);
  if (!status.ok) return { kind: 'unreadable', reason: 'git status failed' };
  const lines = status.out.length > 0 ? status.out.split('\n') : [];
  const ignoredEntries = lines.filter((line) => line.startsWith('!! ')).map((line) => line.slice(3));
  const changes = lines.length - ignoredEntries.length;
  const ignored = ignoredEntries.filter((entry) => !regenerable(entry, path, rootDir)).length;
  if (changes > 0) return { kind: 'uncommitted', changes, ignored };

  const head = await runGit(path, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok || head.out.length === 0) return { kind: 'unreadable', reason: 'git could not read HEAD' };
  const baseRef = baseBranch ? `refs/heads/${baseBranch}` : 'HEAD';
  const base = await runGit(rootDir, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`]);
  if (!base.ok || base.out.length === 0) return { kind: 'unreadable', reason: `the base ${baseBranch ? `branch ${baseBranch}` : 'HEAD'} cannot be resolved` };
  const count = await runGit(rootDir, ['rev-list', '--count', head.out, '--not', base.out]);
  const commits = Number.parseInt(count.out, 10);
  if (!count.ok || !Number.isFinite(commits)) return { kind: 'unreadable', reason: 'git could not compare it with its base' };
  const branchResult = await runGit(path, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = branchResult.ok && branchResult.out.length > 0 ? branchResult.out : null;
  const baseLabel = baseBranch ?? 'the current branch';
  const own = ignored > 0 ? { ignored } : {};
  if (commits === 0) return { kind: 'nothing-unique', branch, ...own };
  return { kind: 'unmerged', branch, commits, base: baseLabel, ...own };
}

/** Folders the derived setup commands install (bun/npm/pnpm/yarn, uv): rebuilt by running setup again. */
const INSTALLED_DEPENDENCY_DIRS: ReadonlySet<string> = new Set(['node_modules/', '.venv/']);

/**
 * An ignored entry that is not this worktree's own state: an installed
 * dependency folder, or a file whose bytes equal the main checkout's file at
 * the same path (what setup carried over and nothing changed since).
 */
function regenerable(entry: string, worktree: string, rootDir: string): boolean {
  if (INSTALLED_DEPENDENCY_DIRS.has(entry) || [...INSTALLED_DEPENDENCY_DIRS].some((dir) => entry.endsWith(`/${dir}`))) return true;
  if (entry.endsWith('/')) return false;
  try {
    const own = statSync(join(worktree, entry)), source = statSync(join(rootDir, entry));
    return own.isFile() && source.isFile() && own.size === source.size && readFileSync(join(worktree, entry)).equals(readFileSync(join(rootDir, entry)));
  } catch {
    return false;
  }
}

/** The local state a worktree holds that no commit does, in words: "2 uncommitted change(s) and 1 ignored file(s)". */
export function describeLocalState(changes: number, ignored: number): string {
  const parts: string[] = [];
  if (changes > 0) parts.push(`${changes} uncommitted change(s)`);
  if (ignored > 0) parts.push(`${ignored} ignored file(s) or folder(s) (not in git, deleted with the directory)`);
  return parts.join(' and ');
}

/** Whole days left before a kept worktree is pruned; 0 once it is due. */
export function daysUntilPrune(endedAt: number, now: number, retentionMs: number): number {
  return Math.max(0, Math.ceil((endedAt + retentionMs - now) / DAY_MS));
}

/** Most recent sign of life in a worktree: its HEAD or index touched by git. */
export async function lastWorktreeActivity(path: string, fallback: number): Promise<number> {
  const gitDir = await runGit(path, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok) return fallback;
  let latest = fallback;
  for (const name of ['HEAD', 'index']) {
    try { latest = Math.max(latest, statSync(join(gitDir.out, name)).mtimeMs); } catch { /* a missing file is no activity */ }
  }
  return latest;
}

/** Size on disk in bytes, or undefined when it cannot be measured. */
export async function worktreeSizeBytes(path: string): Promise<number | undefined> {
  try {
    const child = Bun.spawn(['du', '-sk', path], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const kib = Number.parseInt(out.split(/\s/)[0] ?? '', 10);
    return code === 0 && Number.isFinite(kib) ? kib * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return hours >= 1 ? `${hours}h` : '<1h';
}

/** What the policy does with one worktree. */
export interface WorktreeEvaluation {
  /**
   * `remove-all`: directory and branch. `prune-directory`: directory only, the branch stays.
   * `remove-unmarked`: a worktree from before the created-by record, removed with whatever it holds.
   * `keep`: nothing is touched.
   */
  readonly action: 'remove-all' | 'prune-directory' | 'remove-unmarked' | 'keep';
  readonly reason: WorktreeKeepReason;
  readonly assessment: WorktreeAssessment;
  /** The moment retention counts from: when the owner ended, else the last sign of life. */
  readonly sinceMs: number;
}

/**
 * Apply the retention policy to one worktree. Pure decision, no mutation.
 * A running owner, uncommitted changes or unreadable git state always keep it.
 */
export async function evaluateWorktree(input: {
  readonly path: string;
  readonly rootDir: string;
  readonly registeredAt: number;
  readonly owner: WorktreeOwnerInfo;
  readonly now: number;
  readonly retentionMs: number;
}): Promise<WorktreeEvaluation> {
  const { path, rootDir, owner, now, retentionMs } = input;
  if (owner.state === 'running') {
    return { action: 'keep', reason: { why: 'running', detail: 'its contract or agent is still running' }, assessment: { kind: 'unreadable', reason: 'not read while running' }, sinceMs: now };
  }
  const assessment = await assessWorktree(path, rootDir, owner.baseBranch);
  const ended = owner.state === 'ended' && owner.endedAt !== undefined;
  const sinceMs = ended ? owner.endedAt! : await lastWorktreeActivity(path, input.registeredAt);
  const keep = (reason: WorktreeKeepReason): WorktreeEvaluation => ({ action: 'keep', reason, assessment, sinceMs });
  if (assessment.kind === 'uncommitted') {
    return keep({ why: 'uncommitted', detail: `${describeLocalState(assessment.changes, assessment.ignored)}; never removed automatically` });
  }
  if (assessment.kind === 'unreadable') {
    return keep({ why: 'unreadable', detail: `kept because ${assessment.reason}` });
  }
  if (assessment.kind === 'unmerged' && assessment.branch === null) {
    return keep({ why: 'unreadable', detail: `${assessment.commits} commit(s) exist only in this detached worktree; create a branch to keep them` });
  }
  const due = now - sinceMs >= retentionMs;
  if (!ended && !due) {
    return keep({ why: 'owner-unknown', detail: 'its owner is not known to have ended; considered again once it has been idle for the retention period', pruneInDays: daysUntilPrune(sinceMs, now, retentionMs) });
  }
  const pruneInDays = daysUntilPrune(sinceMs, now, retentionMs);
  if (assessment.kind === 'nothing-unique') {
    const local = assessment.ignored ?? 0;
    if (local === 0) return { action: 'remove-all', reason: { why: 'removable', detail: 'clean, and every commit is already in its base' }, assessment, sinceMs };
    // Ignored files delay removal for the retention period; they do not forbid it.
    if (!ended || !due) return keep({ why: 'ignored', detail: `${describeLocalState(0, local)}; removed in ${pruneInDays} day(s)`, pruneInDays });
    return { action: 'remove-all', reason: { why: 'removable', detail: `every commit is in its base; past retention, removed with ${describeLocalState(0, local)}` }, assessment, sinceMs };
  }
  if (!due) {
    return keep({ why: 'unmerged', detail: `${assessment.commits} commit(s) not in ${assessment.base}; the directory is pruned in ${pruneInDays} day(s), the branch is kept`, pruneInDays });
  }
  return { action: 'prune-directory', reason: { why: 'unmerged', detail: `${assessment.commits} commit(s) not in ${assessment.base}; past retention, directory pruned and branch ${assessment.branch ?? ''} kept`, pruneInDays: 0 }, assessment, sinceMs };
}

/**
 * Decide on a worktree under `.goodvibes/.worktrees` that carries no created-by
 * record: one made by a version of the product before that record existed. The
 * owner's rule is that these go, uncommitted changes included; only a running
 * owner keeps one. What it held is read so the removal can say what was lost.
 */
export async function evaluateUnmarkedWorktree(input: {
  readonly path: string;
  readonly rootDir: string;
  readonly registeredAt: number;
  readonly owner: WorktreeOwnerInfo;
  readonly now: number;
}): Promise<WorktreeEvaluation> {
  const { path, rootDir, owner, now } = input;
  if (owner.state === 'running') {
    return { action: 'keep', reason: { why: 'running', detail: 'its contract or agent is still running' }, assessment: { kind: 'unreadable', reason: 'not read while running' }, sinceMs: now };
  }
  const assessment = await assessWorktree(path, rootDir, owner.baseBranch);
  const sinceMs = owner.state === 'ended' && owner.endedAt !== undefined ? owner.endedAt : input.registeredAt;
  // Git cannot remove a tree it does not recognise as its worktree; say why it stays rather than fail the removal.
  if (assessment.kind === 'unreadable') return { action: 'keep', reason: { why: 'unreadable', detail: `kept because ${assessment.reason}` }, assessment, sinceMs };
  const held = assessment.kind === 'uncommitted' ? `; ${describeLocalState(assessment.changes, assessment.ignored)} removed with it`
    : assessment.kind === 'unmerged' ? `; ${assessment.commits} commit(s) not in ${assessment.base} stay on branch ${assessment.branch ?? '(detached)'}`
      : '';
  return { action: 'remove-unmarked', reason: { why: 'removable', detail: `created before this release (no created-by record), so it is removed${held}` }, assessment, sinceMs };
}
