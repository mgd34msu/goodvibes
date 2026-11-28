/**
 * routes/worktree-setup.ts
 *
 * Handler for `worktrees.setup.run`, the rerun affordance for worktree
 * cold-start setup. Re-runs the configured setup (commands + untracked-file
 * carry-over) on a live worktree by path, records the honest outcome onto the
 * worktree registry record (so a failed setup stays a visible worktree state),
 * and returns the result. Registered from services.ts, the composition root
 * that holds the worktree registry, the daemon config, and the source root.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { GitService } from '../../git/index.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { listPersistedWorktreeMeta, summarizeWorktreeOwnership, type WorktreeRegistry } from '../../runtime/worktree/registry.js';
import { runWorktreeSetup, type WorktreeSetupConfig } from '../../runtime/worktree/setup.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';

/** The deps the worktree lifecycle verbs need, the registry to act on, the source root to carry from, and the current setup config. */
export interface WorktreeSetupGatewayDeps {
  readonly registry: Pick<WorktreeRegistry, 'recordSetup' | 'discard' | 'list'>;
  readonly sourceRoot: string;
  /** Resolves the current per-project setup config (read fresh each run so a config change takes effect without a restart). */
  readonly resolveConfig: () => WorktreeSetupConfig;
  /**
   * Why the project's own setup commands were not used (its folder is not trusted), read with each run; undefined when
   * they were used or it has none. Said beside the setup's outcome.
   */
  readonly commandsNotUsed?: (() => string | undefined) | undefined;
  /**
   * The same three for another project the caller names (`project`: its folder's full path), the one register file
   * that project's terminal programs keep. Absent: only the daemon's own folder is served.
   */
  readonly forProject?: ((project: string) => Omit<WorktreeSetupGatewayDeps, 'forProject'>) | undefined;
}

/** The project a call names (`project` or `x-goodvibes-project`), or the daemon's own folder when it names none. */
function namedProjectOf(params: Record<string, unknown>, callProject: string | undefined): string {
  const fromParam = typeof params.project === 'string' ? params.project.trim() : '';
  return fromParam || callProject?.trim() || '';
}

function depsFor(deps: WorktreeSetupGatewayDeps, params: Record<string, unknown>, callProject?: string): Omit<WorktreeSetupGatewayDeps, 'forProject'> {
  const named = namedProjectOf(params, callProject);
  if (!named) return deps;
  if (!isAbsolute(named)) throw new GatewayVerbError(`project is a folder's full path; "${named}" is not, so nothing was run or changed.`, 'INVALID_REQUEST', 400, 'project');
  if (!deps.forProject) throw new GatewayVerbError('This daemon serves only its own folder\'s worktrees; nothing was run or changed.', 'NOT_FOUND', 404, 'project');
  if (!existsSync(named) || !GitService.isGitRepo(named)) {
    throw new GatewayVerbError(`${named} is not a git repository this machine has, so nothing was run or changed.`, 'NOT_FOUND', 404, 'project');
  }
  return deps.forProject(named);
}

/**
 * The one linked worktree `rawPath` names. Setup runs the configured commands
 * and copies carry-over files (`.env` among them) from the source root into
 * whatever directory it is given, and records the outcome there, so a path
 * that is the main checkout, another repository, or just a folder is refused
 * before anything runs. Discard needs no copy of this: the registry's
 * `discard` refuses the same paths itself, in its receipt.
 */
async function resolveLinkedWorktree(deps: Omit<WorktreeSetupGatewayDeps, 'forProject'>, rawPath: string): Promise<string> {
  const absolute = resolve(deps.sourceRoot, rawPath);
  let real = absolute;
  try { real = realpathSync(absolute); } catch { /* a path that is gone cannot match a live worktree below */ }
  let main = resolve(deps.sourceRoot);
  try { main = realpathSync(main); } catch { /* an unreadable source root matches nothing */ }
  const rows = await deps.registry.list();
  const known = rows.find((row) => row.path === real || row.path === absolute);
  if (!known || known.path === main) {
    throw new GatewayVerbError(
      `${rawPath} is not a linked worktree of this project, so nothing was run or changed. List the project's worktrees (worktrees.snapshot) and pass one of their paths.`,
      'NOT_FOUND',
      404,
      'path',
    );
  }
  return known.path;
}

export function createWorktreeSetupRunHandler(deps: WorktreeSetupGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requireStringValue(params.path, 'path');
    const project = depsFor(deps, params, invocation.context.call?.project);
    const worktreePath = await resolveLinkedWorktree(project, path);
    const notUsed = project.commandsNotUsed?.();
    const setup = await runWorktreeSetup(worktreePath, project.sourceRoot, project.resolveConfig());
    project.registry.recordSetup(worktreePath, setup);
    return { path: worktreePath, setup, ...(notUsed !== undefined ? { projectCommandsNotUsed: notUsed } : {}) };
  };
}

/**
 * `worktrees.discard`, discard actually discards: the registry's
 * eviction-preserving removal (dirty state committed onto the KEPT branch,
 * directory removed, record dropped) with the honest receipt as the output.
 * A path that is not a linked worktree of this project comes back as a
 * refused receipt (`ok: false`, nothing committed or removed).
 */
export function createWorktreeDiscardHandler(deps: WorktreeSetupGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requireStringValue(params.path, 'path');
    const project = depsFor(deps, params, invocation.context.call?.project);
    return await project.registry.discard(resolve(project.sourceRoot, path));
  };
}

/**
 * `worktrees.snapshot` for the project a call names (`project` or `x-goodvibes-project`: that project's one register file,
 * as its terminal programs keep it), or the daemon's own folder when it names none. The same records and summary either way.
 */
export function createWorktreeSnapshotHandler(deps: WorktreeSetupGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const named = namedProjectOf(params, invocation.context.call?.project);
    // An existing non-git project has no worktrees (empty list); a missing path still hits depsFor's 404.
    if (named && isAbsolute(named) && deps.forProject && existsSync(named) && !GitService.isGitRepo(named)) {
      return { summary: summarizeWorktreeOwnership([]), records: [] };
    }
    const project = depsFor(deps, params, invocation.context.call?.project);
    const records = listPersistedWorktreeMeta({ workingDirectory: project.sourceRoot });
    return { summary: summarizeWorktreeOwnership(records), records };
  };
}

/** Attach the worktree lifecycle handlers to their already-registered descriptors. Missing descriptors are silent no-ops. */
export function registerWorktreeSetupGatewayMethods(catalog: GatewayMethodCatalog, deps: WorktreeSetupGatewayDeps): void {
  const snapshot = catalog.get('worktrees.snapshot');
  if (snapshot) catalog.register(snapshot, createWorktreeSnapshotHandler(deps), { replace: true });
  const setup = catalog.get('worktrees.setup.run');
  if (setup) catalog.register(setup, createWorktreeSetupRunHandler(deps), { replace: true });
  const discard = catalog.get('worktrees.discard');
  if (discard) catalog.register(discard, createWorktreeDiscardHandler(deps), { replace: true });
}
