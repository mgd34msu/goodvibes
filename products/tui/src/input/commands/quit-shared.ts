import type { StatusResult } from 'simple-git';
import { basename } from 'path';
import type { CommandContext } from '../command-registry.ts';
import { GitService } from '@goodvibes/engine/platform/platform/git';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { RefusalError, refusal } from '@goodvibes/engine/errors';

type GitLike = Pick<GitService, 'addAll' | 'status' | 'commit'>;

export type GitChange = {
  action: 'add' | 'update' | 'delete' | 'rename';
  path: string;
  from?: string;
  to?: string;
};

type GitStatusLike = Pick<StatusResult, 'staged' | 'modified' | 'not_added' | 'deleted' | 'created' | 'renamed'> & {
  isClean?: () => boolean;
};

export function collectGitChanges(status: GitStatusLike): GitChange[] {
  const changes = new Map<string, GitChange>();

  for (const rename of status.renamed ?? []) {
    const to = rename.to || rename.from;
    if (!to) continue;
    changes.set(to, { action: 'rename', path: to, from: rename.from, to: rename.to });
  }

  for (const path of status.created ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'add', path });
  }

  for (const path of status.not_added ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'add', path });
  }

  for (const path of status.deleted ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'delete', path });
  }

  for (const path of status.modified ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'update', path });
  }

  for (const path of status.staged ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'update', path });
  }

  return Array.from(changes.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function topLevelScope(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized) return 'root';
  const [first] = normalized.split('/');
  return first && first.length > 0 ? first : 'root';
}

function summarizeScopes(changes: GitChange[]): string | null {
  const scopes = Array.from(new Set(changes.map((change) => topLevelScope(change.path)).filter(Boolean)));
  if (scopes.length === 0) return null;
  if (scopes.length <= 3) {
    return scopes.length === 1 ? `${scopes[0]} files` : `${formatList(scopes)} files`;
  }
  return `${changes.length} files`;
}

function shortPath(path: string): string {
  return path.length > 42 ? basename(path) : path;
}

export function buildWriteQuitCommitMessage(changes: GitChange[]): string {
  if (changes.length === 0) return 'Update working tree';

  if (changes.length === 1) {
    const [change] = changes;
    if (!change) return 'Update working tree';
    if (change.action === 'rename') {
      return `Rename ${shortPath(change.from ?? change.path)} to ${shortPath(change.to ?? change.path)}`;
    }
    const verb = change.action === 'add'
      ? 'Add'
      : change.action === 'delete'
        ? 'Delete'
        : 'Update';
    return `${verb} ${shortPath(change.path)}`;
  }

  const uniqueActions = Array.from(new Set(changes.map((change) => change.action)));
  if (uniqueActions.length === 1) {
    const [action] = uniqueActions;
    const verb = action === 'add'
      ? 'Add'
      : action === 'delete'
        ? 'Delete'
        : action === 'rename'
          ? 'Rename'
          : 'Update';
    const scopeLabel = summarizeScopes(changes);
    if (scopeLabel) return `${verb} ${scopeLabel}`;
    return `${verb} ${changes.length} files`;
  }

  const scopeLabel = summarizeScopes(changes);
  if (scopeLabel) return `Update ${scopeLabel}`;
  return `Update ${changes.length} files`;
}

export type ExecuteCommitAllOptions = {
  cwd?: string;
  isGitRepo?: (cwd: string) => boolean;
  getRepoRoot?: (cwd: string) => string | null;
  gitFactory?: (cwd: string) => GitLike;
};

/** What a working tree holds, counted from one `git status`: what is staged, what is not, what git does not track. */
export interface WorkingTreeCounts {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export function countWorkingTree(status: Pick<StatusResult, 'files'>): WorkingTreeCounts {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const file of status.files ?? []) {
    if (file.index === '?' || file.working_dir === '?') { untracked.push(file.path); continue; }
    if (file.index && file.index !== ' ') staged.push(file.path);
    if (file.working_dir && file.working_dir !== ' ') unstaged.push(file.path);
  }
  return { staged, unstaged, untracked };
}

const UNTRACKED_SHOWN = 10;

/**
 * "Commit every change" (`git.commit`; without `--yes`, the preview "See what changed" ends with):
 * commit the working tree of the repository this session runs in.
 *
 * Without `--yes` it changes nothing: it prints the repository root (which may
 * be above the working directory), the counts of staged, unstaged and
 * untracked files, the untracked ones by name, and the commit it would make.
 * `--yes` makes it.
 * A set staged by hand is never added to: `--yes` then commits exactly that set
 * and leaves everything else as it is. Without a hand-staged set, `--yes`
 * stages every change, untracked files included, and commits it.
 */
export async function executeCommitAll(
  ctx: Pick<CommandContext, 'print'> & {
    workspace?: CommandContext['workspace'];
    invokedByModel?: boolean | undefined;
  },
  args: readonly string[],
  options: ExecuteCommitAllOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? ctx.workspace?.shellPaths?.workingDirectory;
  if (!cwd) {
    throw new RefusalError(refusal({ code: 'NO_WORKSPACE', state: 'nothing was committed', reason: 'This session has no working directory' }));
  }
  const isGitRepo = options.isGitRepo ?? ((dir: string) => GitService.isGitRepo(dir));
  if (!isGitRepo(cwd)) {
    throw new RefusalError(refusal({ code: 'NOT_A_REPOSITORY', state: 'nothing was committed', reason: `${cwd} is not inside a git repository` }));
  }
  const confirmed = args.includes('--yes') || args.includes('-y');
  if (confirmed && ctx.invokedByModel === true) {
    throw new RefusalError(refusal({
      code: 'OWNER_ONLY', state: 'nothing was committed',
      reason: '"Commit every change" commits the owner\'s whole working tree and runs only when the owner asks for it',
      next: ['Use the git tools to stage and commit the files this task changed'],
    }));
  }

  const repoRoot = options.getRepoRoot?.(cwd) ?? GitService.getRepoRoot(cwd) ?? cwd;
  const git = options.gitFactory?.(repoRoot) ?? new GitService(repoRoot);
  const before = await git.status();
  const counts = countWorkingTree(before);
  const total = counts.staged.length + counts.unstaged.length + counts.untracked.length;
  if (total === 0) {
    ctx.print(`${repoRoot}: nothing to commit, the working tree is clean.`);
    return;
  }
  const handStaged = counts.staged.length > 0;
  if (!confirmed) {
    const shown = counts.untracked.slice(0, UNTRACKED_SHOWN);
    ctx.print([
      `Committing every change in ${repoRoot}:`,
      `  staged ${counts.staged.length}, unstaged ${counts.unstaged.length}, untracked ${counts.untracked.length}`,
      ...(shown.length > 0 ? [`  untracked: ${shown.join(', ')}${counts.untracked.length > shown.length ? `, and ${counts.untracked.length - shown.length} more` : ''}`] : []),
      handStaged
        ? `  commits only the ${counts.staged.length} staged file${counts.staged.length === 1 ? '' : 's'}; the rest stays as it is.`
        : `  stages all ${total} file${total === 1 ? '' : 's'}, untracked included, and commits them.`,
    ].join('\n'));
    return;
  }

  try {
    if (!handStaged) await git.addAll();
    const status = handStaged ? before : await git.status();
    const changes = collectGitChanges(handStaged
      ? { staged: [...counts.staged], modified: [], not_added: [], deleted: [], created: [], renamed: [] }
      : status);
    const message = buildWriteQuitCommitMessage(changes);
    const result = await git.commit(message);
    const shortHash = result.hash ? result.hash.slice(0, 7) : 'unknown';
    ctx.print(`Committed ${changes.length} file${changes.length === 1 ? '' : 's'} in ${repoRoot}: ${shortHash} ${message}`
      + (handStaged && (counts.unstaged.length + counts.untracked.length) > 0 ? ' (only the staged set; the rest is unchanged)' : ''));
  } catch (error) {
    throw new RefusalError(refusal({
      code: 'COMMIT_FAILED', state: handStaged ? 'nothing was committed; the staged set is as it was' : 'the changes are staged but not committed',
      reason: `git commit failed: ${summarizeError(error)}`, next: ['Run git status to see the repository'],
    }));
  }
}
