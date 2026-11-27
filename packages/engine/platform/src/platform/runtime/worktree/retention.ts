import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { kindOfProductWorktree, unsettledWorktreeReason, WORKTREE_CREATION_GRACE_MS } from '../../git/product-worktree-marker.js';

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
 * - Uncommitted changes (tracked or untracked), or git state that cannot be
 *   read: never removed automatically; listed at start with the next steps.
 * - Commits on a detached HEAD that no branch holds: saved to the branch
 *   `goodvibes/saved-<first 12 hex of HEAD>` before the directory may go.
 * - No created-by record (made by a version before the record existed): the
 *   same protections; it is removed only once no running owner holds it, git
 *   does not hold it locked, nothing touched it for the creation grace period,
 *   it has no uncommitted or untracked change and every commit on it is held by
 *   a branch or its base. Ignored files of its own delay that by the retention
 *   period after its last use. Removal is never forced; its branch is deleted
 *   only when merged.
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
  /**
   * Commits or refs whose history is already kept outside the worktree, beside
   * the base branch: a contract's captured input (the person's own checkout,
   * which still holds those files) and, for a contract's work-item trees, the
   * contract's branch their work is integrated into. A commit reachable from
   * one of them is not work this worktree alone holds.
   */
  readonly baseCommits?: readonly string[] | undefined;
}

/** What git says is in a worktree. */
export type WorktreeAssessment =
  /** `ignored`: ignored files or folders that are this worktree's own (not copies, not installed dependencies). */
  | { readonly kind: 'nothing-unique'; readonly branch: string | null; readonly head: string; readonly ignored?: number | undefined }
  /** `heldBy`: on a detached HEAD, a branch that already contains HEAD, so its commits stay reachable without this worktree. */
  | { readonly kind: 'unmerged'; readonly branch: string | null; readonly head: string; readonly commits: number; readonly base: string; readonly heldBy?: string | undefined; readonly ignored?: number | undefined }
  | { readonly kind: 'uncommitted'; readonly changes: number; readonly ignored: number }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Why a worktree is on disk, in the words the listing shows. */
export type WorktreeKeepReason =
  | { readonly why: 'running'; readonly detail: string }
  | { readonly why: 'uncommitted'; readonly detail: string }
  /** Commits on a detached HEAD that no branch holds, and a branch to hold them could not be made. */
  | { readonly why: 'detached'; readonly detail: string }
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
 * Product-created worktrees sit under `.goodvibes/.worktrees/` in one of the
 * kinds the product itself creates (git/product-worktree-marker.ts). A
 * directory that merely lives under `.goodvibes` is not one.
 */
export function isProductWorktreePath(path: string, workingDirectory: string): boolean {
  return kindOfProductWorktree(workingDirectory, path) !== null;
}

/**
 * Read what a worktree holds. Never throws; anything git cannot answer is
 * `unreadable`, which every caller treats as "keep".
 *
 * `baseBranch` is the branch the worktree was created from when the caller
 * knows it; otherwise the repository root's current HEAD is the base.
 * `baseCommits` are further commits or refs whose history counts as kept
 * elsewhere (see {@link WorktreeOwnerInfo.baseCommits}); one that no longer
 * resolves is left out, which only makes the assessment keep more.
 */
export async function assessWorktree(path: string, rootDir: string, baseBranch?: string, baseCommits: readonly string[] = []): Promise<WorktreeAssessment> {
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
  // The product's own bookkeeping at the tree's root (a step's verification log) is no change of the person's, ignored or not.
  const ownState = lines.filter((line) => line.startsWith('?? ') && line.slice(3).startsWith(PRODUCT_STATE_DIR)).length;
  const changes = lines.length - ignoredEntries.length - ownState;
  const ignored = ignoredEntries.filter((entry) => !regenerableIgnoredEntry(entry, path, rootDir)).length;
  if (changes > 0) return { kind: 'uncommitted', changes, ignored };

  const head = await runGit(path, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok || head.out.length === 0) return { kind: 'unreadable', reason: 'git could not read HEAD' };
  const baseRef = baseBranch ? `refs/heads/${baseBranch}` : 'HEAD';
  const base = await runGit(rootDir, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`]);
  if (!base.ok || base.out.length === 0) return { kind: 'unreadable', reason: `the base ${baseBranch ? `branch ${baseBranch}` : 'HEAD'} cannot be resolved` };
  const kept: string[] = [];
  for (const extra of baseCommits) {
    const resolved = await runGit(rootDir, ['rev-parse', '--verify', '-q', `${extra}^{commit}`]);
    if (resolved.ok && resolved.out.length > 0) kept.push(resolved.out);
  }
  const count = await runGit(rootDir, ['rev-list', '--count', head.out, '--not', base.out, ...kept]);
  const commits = Number.parseInt(count.out, 10);
  if (!count.ok || !Number.isFinite(commits)) return { kind: 'unreadable', reason: 'git could not compare it with its base' };
  const branchResult = await runGit(path, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = branchResult.ok && branchResult.out.length > 0 ? branchResult.out : null;
  const baseLabel = baseBranch ?? 'the current branch';
  const own = ignored > 0 ? { ignored } : {};
  if (commits === 0) return { kind: 'nothing-unique', branch, head: head.out, ...own };
  if (branch === null) {
    // A detached HEAD: its commits outlive the directory only if some branch already contains them.
    const holders = await runGit(rootDir, ['for-each-ref', '--count=1', '--contains', head.out, '--format=%(refname:short)', 'refs/heads']);
    if (!holders.ok) return { kind: 'unreadable', reason: 'git could not tell whether a branch holds its detached HEAD' };
    if (holders.out.length > 0) return { kind: 'unmerged', branch, head: head.out, commits, base: baseLabel, heldBy: holders.out, ...own };
  }
  return { kind: 'unmerged', branch, head: head.out, commits, base: baseLabel, ...own };
}

/** The branch the sweep saves a detached HEAD's commits to before the directory may go. */
export function savedBranchName(head: string): string {
  return `goodvibes/saved-${head.slice(0, 12)}`;
}

/** A path as one shell word, quoted only when it needs to be. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact next steps for a worktree kept because it needs its owner's
 * decision: save what it holds, keep it as it is (which also ends the notice),
 * or discard it. Each is a git command, so it works from any shell and any of
 * the programs; discarding is the owner's own act.
 */
export function worktreeNextSteps(input: {
  readonly path: string;
  readonly why: WorktreeKeepReason['why'];
  /** The branch checked out there, or null on a detached HEAD. */
  readonly branch: string | null;
  /** HEAD, when it could be read: names the branch a detached HEAD is saved to. */
  readonly head?: string | undefined;
}): string[] {
  const at = shellWord(input.path);
  const name = input.path.split(/[\\/]/).filter(Boolean).pop() ?? 'worktree';
  const newBranch = input.head ? savedBranchName(input.head) : `goodvibes/saved-${name}`;
  const keep = `keep as is: git worktree lock ${at}   (never removed automatically, and no longer listed)`;
  if (input.why === 'uncommitted') {
    const onBranch = input.branch === null ? `git -C ${at} switch -c ${newBranch} && ` : '';
    return [
      `save it:    ${onBranch}git -C ${at} add -A && git -C ${at} commit -m ${shellWord(`Work kept from ${name}`)}   (branch ${input.branch ?? newBranch} then holds the work, and the directory is cleaned up by the usual rules)`,
      keep,
      `discard it: git worktree remove --force ${at}   (deletes the uncommitted changes${input.branch === null ? ', and any commit of its detached HEAD that no branch holds' : ''})`,
    ];
  }
  if (input.why === 'detached') {
    return [
      `save it:    git -C ${at} switch -c ${newBranch}`,
      keep,
      `discard it: git worktree remove --force ${at}   (its commits are then on no branch)`,
    ];
  }
  return [
    `look at it: git -C ${at} status`,
    keep,
    `discard it: git worktree remove --force ${at}   (or git worktree prune when the directory is already gone)`,
  ];
}

/** Keep reasons that need the owner's decision: a terminal app's start tells them once, and /worktree review lists them until it is made. */
export function needsOwnerDecision(reason: WorktreeKeepReason): boolean {
  return reason.why === 'uncommitted' || reason.why === 'detached' || reason.why === 'unreadable';
}

/** Folders the derived setup commands install (bun/npm/pnpm/yarn, uv): rebuilt by running setup again. */
const INSTALLED_DEPENDENCY_DIRS: ReadonlySet<string> = new Set(['node_modules/', '.venv/']);

/** The product's own state folder at a worktree's root: its bookkeeping, and the folder its nested worktrees live in (decided on their own first). */
const PRODUCT_STATE_DIR = '.goodvibes/';

/**
 * An ignored entry that is not this worktree's own state: an installed
 * dependency folder, the product's own state folder at its root, or a file
 * whose bytes equal the main checkout's file at the same path (what setup
 * carried over and nothing changed since). `entry` is as `git status
 * --ignored` prints it, relative to the worktree.
 */
export function regenerableIgnoredEntry(entry: string, worktree: string, rootDir: string): boolean {
  // With --untracked-files=all git names each file inside an ignored folder, so the folder is found among the entry's parents.
  if (entry.startsWith(PRODUCT_STATE_DIR)) return true;
  const folders = entry.split('/').slice(0, -1).map((segment) => `${segment}/`);
  if (folders.some((folder) => INSTALLED_DEPENDENCY_DIRS.has(folder))) return true;
  if (entry.endsWith('/')) return false;
  try {
    // lstat: a link in the worktree is never followed; only a plain file can be a copy.
    const own = lstatSync(join(worktree, entry)), source = statSync(join(rootDir, entry));
    return own.isFile() && source.isFile() && own.size === source.size && readFileSync(join(worktree, entry)).equals(readFileSync(join(rootDir, entry)));
  } catch {
    return false;
  }
}

/** The local state a worktree holds that no commit does, in words: "2 uncommitted change(s) and 1 ignored file(s)". */
export function describeLocalState(changes: number, ignored: number): string {
  const parts: string[] = [];
  if (changes > 0) parts.push(`${changes} uncommitted or untracked change(s)`);
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
   * `remove-all`: directory and branch (the branch only when merged). `prune-directory`: directory only, the branch stays.
   * `remove-unmarked`: a worktree from before the created-by record that holds nothing found nowhere else; its branch is deleted only when merged.
   * `keep`: nothing is touched.
   * Removal is never forced: git's own refusal of a tree with changes is the last check.
   */
  readonly action: 'remove-all' | 'prune-directory' | 'remove-unmarked' | 'keep';
  readonly reason: WorktreeKeepReason;
  readonly assessment: WorktreeAssessment;
  /** The moment retention counts from: when the owner ended, else the last sign of life. */
  readonly sinceMs: number;
  /** A detached HEAD no branch holds: the branch its commits are saved to before the directory goes. */
  readonly saveAs?: string | undefined;
}

/** The branch that holds a worktree's commits once its directory is gone, in words. */
function holderOf(assessment: Extract<WorktreeAssessment, { kind: 'unmerged' }>, saveAs: string | undefined): string {
  return assessment.branch ?? assessment.heldBy ?? saveAs ?? '(none)';
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
    return { action: 'keep', reason: { why: 'running', detail: 'its contract, workstream or agent is still running' }, assessment: { kind: 'unreadable', reason: 'not read while running' }, sinceMs: now };
  }
  const assessment = await assessWorktree(path, rootDir, owner.baseBranch, owner.baseCommits);
  const ended = owner.state === 'ended' && owner.endedAt !== undefined;
  const sinceMs = ended ? owner.endedAt! : await lastWorktreeActivity(path, input.registeredAt);
  const keep = (reason: WorktreeKeepReason): WorktreeEvaluation => ({ action: 'keep', reason, assessment, sinceMs });
  if (assessment.kind === 'uncommitted') {
    return keep({ why: 'uncommitted', detail: `${describeLocalState(assessment.changes, assessment.ignored)}; never removed automatically` });
  }
  if (assessment.kind === 'unreadable') {
    return keep({ why: 'unreadable', detail: `kept because ${assessment.reason}` });
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
  const saveAs = assessment.branch === null && assessment.heldBy === undefined ? savedBranchName(assessment.head) : undefined;
  if (!due) {
    const held = saveAs ? `are on a detached HEAD and are saved to branch ${saveAs} before the directory is pruned in ${pruneInDays} day(s)`
      : `stay on branch ${holderOf(assessment, undefined)}; the directory is pruned in ${pruneInDays} day(s), the branch is kept`;
    return keep({ why: 'unmerged', detail: `${assessment.commits} commit(s) not in ${assessment.base} ${held}`, pruneInDays });
  }
  return { action: 'prune-directory', reason: { why: 'unmerged', detail: `${assessment.commits} commit(s) not in ${assessment.base}; past retention, directory pruned and branch ${holderOf(assessment, saveAs)} kept`, pruneInDays: 0 }, assessment, sinceMs, ...(saveAs ? { saveAs } : {}) };
}

/**
 * Decide on a worktree under `.goodvibes/.worktrees` that carries no created-by
 * record: one made by a version of the product before that record existed.
 * It goes only when it is provably disposable: no running owner, not locked,
 * not in use in the last grace period, no uncommitted or untracked change, and
 * every commit on it held by a branch or its base (a detached HEAD no branch
 * holds is saved to a new branch first). Anything else is kept and listed at
 * start for its owner to decide. Ignored files of its own delay removal by the
 * retention period after its last use.
 */
export async function evaluateUnmarkedWorktree(input: {
  readonly path: string;
  readonly rootDir: string;
  readonly registeredAt: number;
  readonly owner: WorktreeOwnerInfo;
  readonly now: number;
  readonly retentionMs?: number | undefined;
}): Promise<WorktreeEvaluation> {
  const { path, rootDir, owner, now } = input;
  const retentionMs = input.retentionMs ?? DEFAULT_WORKTREE_RETENTION_MS;
  if (owner.state === 'running') {
    return { action: 'keep', reason: { why: 'running', detail: 'its contract, workstream or agent is still running' }, assessment: { kind: 'unreadable', reason: 'not read while running' }, sinceMs: now };
  }
  // Git lists a worktree from the moment its add begins, before the record is written; a lock or a young link keeps it.
  const unsettled = unsettledWorktreeReason(path, now);
  if (unsettled) {
    return { action: 'keep', reason: { why: 'running', detail: `kept because ${unsettled}` }, assessment: { kind: 'unreadable', reason: 'not read while in creation' }, sinceMs: now };
  }
  const lastUse = await lastWorktreeActivity(path, 0);
  // With no owner on record, a program of any version still working there is seen by its HEAD or index moving.
  if (owner.state !== 'ended' && now - lastUse < WORKTREE_CREATION_GRACE_MS) {
    return { action: 'keep', reason: { why: 'running', detail: `kept because git used it ${Math.max(0, Math.round((now - lastUse) / 1000))} s ago, so a program may still be working in it` }, assessment: { kind: 'unreadable', reason: 'not read while in use' }, sinceMs: now };
  }
  const assessment = await assessWorktree(path, rootDir, owner.baseBranch, owner.baseCommits);
  const sinceMs = owner.state === 'ended' && owner.endedAt !== undefined ? owner.endedAt : lastUse > 0 ? lastUse : input.registeredAt;
  const keep = (reason: WorktreeKeepReason): WorktreeEvaluation => ({ action: 'keep', reason, assessment, sinceMs });
  if (assessment.kind === 'unreadable') return keep({ why: 'unreadable', detail: `kept because ${assessment.reason}` });
  if (assessment.kind === 'uncommitted') {
    return keep({ why: 'uncommitted', detail: `created before this release, kept because it holds ${describeLocalState(assessment.changes, assessment.ignored)}; never removed automatically` });
  }
  const local = assessment.ignored ?? 0;
  const pruneInDays = daysUntilPrune(sinceMs, now, retentionMs);
  if (local > 0 && now - sinceMs < retentionMs) {
    return keep({ why: 'ignored', detail: `created before this release; ${describeLocalState(0, local)}; removed in ${pruneInDays} day(s) unless used again`, pruneInDays });
  }
  const saveAs = assessment.kind === 'unmerged' && assessment.branch === null && assessment.heldBy === undefined ? savedBranchName(assessment.head) : undefined;
  const held = assessment.kind !== 'unmerged' ? ''
    : saveAs ? `; its ${assessment.commits} commit(s) on a detached HEAD are saved to new branch ${saveAs} first`
      : `; its ${assessment.commits} commit(s) not in ${assessment.base} stay on branch ${holderOf(assessment, undefined)}`;
  const lost = local > 0 ? `; ${describeLocalState(0, local)} go with the directory` : '';
  return { action: 'remove-unmarked', reason: { why: 'removable', detail: `created before this release; everything in it is also on a branch or in its base, so its directory is removed${held}${lost}` }, assessment, sinceMs, ...(saveAs ? { saveAs } : {}) };
}
