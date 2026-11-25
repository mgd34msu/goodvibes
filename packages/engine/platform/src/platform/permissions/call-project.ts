/**
 * The project a permission decision is for.
 *
 * One daemon decides for turns and callers in many projects with one
 * permission manager. A decision reads the owner's rules "in this project",
 * keeps an "allow / deny in this project" answer, resolves relative paths and
 * reads the folder's trust: each of those is the project of the turn or call
 * that was asked about, never the folder the daemon was started in. Whoever
 * starts a turn or admits a call in a known project (a daemon-run agent in its
 * folder, a runner, a hosted agent, an outside caller naming its folder) runs
 * the decision inside {@link decideInProject}; the manager reads it with
 * {@link projectOfDecision} and falls back to its own folder only when nothing
 * named one (a program's own turn, whose folder is its project).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { projectIdentityOf } from '../workspace/project-identity.js';

const projectOfCall = new AsyncLocalStorage<string>();

/**
 * The project root a working directory belongs to: the product's one project identity
 * (workspace/project-identity.ts): a product worktree's project, else the nearest registered workspace or repository
 * root that contains the folder, else the folder; a subfolder of a project reads that project's rules.
 */
export function projectRootOfDirectory(directory: string): string {
  return projectIdentityOf(directory);
}

/** Run `work` with every permission decision in it made for the project `directory` belongs to; no folder leaves it as it is. */
export function decideInProject<T>(directory: string | undefined, work: () => T): T {
  if (typeof directory !== 'string' || directory.trim().length === 0) return work();
  return projectOfCall.run(projectRootOfDirectory(directory), work);
}

/** The project root the decision being made is for, when a turn or call named one. */
export function projectOfDecision(): string | undefined {
  return projectOfCall.getStore();
}
