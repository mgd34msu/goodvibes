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
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { WorktreeRegistry } from '../../runtime/worktree/registry.js';
import { runWorktreeSetup, type WorktreeSetupConfig } from '../../runtime/worktree/setup.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';

/** The deps the worktree lifecycle verbs need, the registry to act on, the source root to carry from, and the current setup config. */
export interface WorktreeSetupGatewayDeps {
  readonly registry: Pick<WorktreeRegistry, 'recordSetup' | 'discard' | 'list'>;
  readonly sourceRoot: string;
  /** Resolves the current per-project setup config (read fresh each run so a config change takes effect without a restart). */
  readonly resolveConfig: () => WorktreeSetupConfig;
}

/**
 * The one linked worktree `rawPath` names. Setup runs the configured commands
 * and copies carry-over files (`.env` among them) from the source root into
 * whatever directory it is given, and records the outcome there, so a path
 * that is the main checkout, another repository, or just a folder is refused
 * before anything runs. Discard needs no copy of this: the registry's
 * `discard` refuses the same paths itself, in its receipt.
 */
async function resolveLinkedWorktree(deps: WorktreeSetupGatewayDeps, rawPath: string): Promise<string> {
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
    const worktreePath = await resolveLinkedWorktree(deps, path);
    const setup = await runWorktreeSetup(worktreePath, deps.sourceRoot, deps.resolveConfig());
    deps.registry.recordSetup(worktreePath, setup);
    return { path: worktreePath, setup };
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
    return await deps.registry.discard(resolve(deps.sourceRoot, path));
  };
}

/** Attach the worktree lifecycle handlers to their already-registered descriptors. Missing descriptors are silent no-ops. */
export function registerWorktreeSetupGatewayMethods(catalog: GatewayMethodCatalog, deps: WorktreeSetupGatewayDeps): void {
  const setup = catalog.get('worktrees.setup.run');
  if (setup) catalog.register(setup, createWorktreeSetupRunHandler(deps), { replace: true });
  const discard = catalog.get('worktrees.discard');
  if (discard) catalog.register(discard, createWorktreeDiscardHandler(deps), { replace: true });
}
