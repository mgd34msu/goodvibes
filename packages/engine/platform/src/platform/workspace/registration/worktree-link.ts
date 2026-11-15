/**
 * workspace/registration/worktree-link.ts
 *
 * The impure worktree→main-repo LINK probe. A linked git worktree records its
 * main repository in its own `.git` file, and `git rev-parse --git-common-dir`
 * resolves to that main repo's shared `.git` directory regardless of where the
 * worktree lives on disk. This is exactly the link registration inheritance must
 * follow, an orchestration-spawned worktree can sit outside the registered
 * project's subtree yet still belong to it, so we derive the MAIN worktree root
 * from the common dir rather than from path ancestry.
 *
 * Kept isolated (and behind an injectable runner) so the resolver and store stay
 * pure/testable and only this file shells out.
 */

import { execFile, spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { normalizeWorkspaceRoot } from './resolution.js';
import type { WorkspaceGitMetadata } from './types.js';

/** Runs one `git -C <cwd> <args>` and returns trimmed stdout, or null on any failure. */
export type GitRunner = (cwd: string, args: readonly string[]) => string | null;

/** Async form of {@link GitRunner}: the daemon event loop keeps serving other sessions while git runs. */
export type AsyncGitRunner = (cwd: string, args: readonly string[]) => Promise<string | null>;

const defaultAsyncGitRunner: AsyncGitRunner = (cwd, args) => new Promise((resolve) => {
  try {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 5_000, windowsHide: true }, (error, stdout) => {
      const out = error || typeof stdout !== 'string' ? '' : stdout.trim();
      resolve(out.length > 0 ? out : null);
    });
  } catch {
    resolve(null);
  }
});

const defaultGitRunner: GitRunner = (cwd, args) => {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/**
 * Probe the worktree→main-repo link for `path`. Returns `mainWorktreeRoot` only
 * when `path` is a LINKED worktree whose main repo lives elsewhere; returns an
 * empty object for the main worktree, a non-worktree directory, or a
 * non-repo/bare-repo path.
 */
export function probeWorktreeLink(path: string, runGit: GitRunner = defaultGitRunner): WorkspaceGitMetadata {
  const commonDir = runGit(path, COMMON_DIR_ARGS);
  const mainRoot = mainRootOf(commonDir);
  if (!mainRoot) return {};
  return linkedTo(mainRoot, runGit(path, TOP_LEVEL_ARGS));
}

/** Same probe as {@link probeWorktreeLink} without blocking the event loop; the store's default. */
export async function probeWorktreeLinkAsync(path: string, runGit: AsyncGitRunner = defaultAsyncGitRunner): Promise<WorkspaceGitMetadata> {
  const mainRoot = mainRootOf(await runGit(path, COMMON_DIR_ARGS));
  if (!mainRoot) return {};
  return linkedTo(mainRoot, await runGit(path, TOP_LEVEL_ARGS));
}

const COMMON_DIR_ARGS = ['rev-parse', '--path-format=absolute', '--git-common-dir'] as const;
const TOP_LEVEL_ARGS = ['rev-parse', '--path-format=absolute', '--show-toplevel'] as const;

/**
 * The main worktree root is the parent of the shared `.git` directory. A bare
 * repo's common dir is not a `.git` directory, so there is no main worktree to
 * inherit from: report nothing rather than guessing.
 */
function mainRootOf(commonDir: string | null): string | null {
  if (!commonDir || basename(commonDir) !== '.git') return null;
  return normalizeWorkspaceRoot(dirname(commonDir));
}

/** Only a LINKED worktree (whose own top-level differs from the main root) needs inheritance; the main worktree already matches by path. */
function linkedTo(mainRoot: string, topLevel: string | null): WorkspaceGitMetadata {
  if (!topLevel || normalizeWorkspaceRoot(topLevel) === mainRoot) return {};
  return { mainWorktreeRoot: mainRoot };
}
