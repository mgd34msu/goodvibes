/**
 * Which runtime a call belongs to, for the judgment port.
 *
 * Two daemons can run in one process (embedded sessions for workspaces that
 * cannot share one daemon). The port the newer one installs is the process's
 * current port, but a reading the older daemon starts must keep the older
 * daemon's port and lifetime, or stopping the newer daemon ends it. A daemon
 * makes one scope, runs its composition, its start, every request it serves
 * and every embedded submission inside it, and its judgment composition claims
 * the scope for its port; the judgment port reads the scope of the current
 * async call chain (installJudgmentRuntimeScope). A call outside any scope
 * gets the process-current port, as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { JudgmentPort } from '@goodvibes/judgment/decisions';
import { installJudgmentRuntimeScope } from '@goodvibes/engine/errors';

/** One runtime's scope; `port` is set by that runtime's judgment composition. */
export interface JudgmentRuntimeScope {
  port: JudgmentPort | undefined;
}

const scopes = new AsyncLocalStorage<JudgmentRuntimeScope>();
installJudgmentRuntimeScope(() => scopes.getStore()?.port);

export function createJudgmentRuntimeScope(): JudgmentRuntimeScope {
  return { port: undefined };
}

/** Runs `fn` (and every async continuation it starts) as part of `scope`'s runtime. */
export function runInJudgmentRuntime<T>(scope: JudgmentRuntimeScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

/**
 * The runtime the current call belongs to, kept for a callback that runs
 * later outside this call chain (a listener's request handler): the returned
 * function runs its argument in that runtime, or plainly when there is none.
 */
export function captureJudgmentRuntime(): <T>(fn: () => T) => T {
  const scope = scopes.getStore();
  return (fn) => (scope === undefined ? fn() : scopes.run(scope, fn));
}

/** Called by a runtime's judgment composition: the scope it runs in now names its port. */
export function claimJudgmentRuntimeScope(port: JudgmentPort): void {
  const scope = scopes.getStore();
  if (scope !== undefined && scope.port === undefined) scope.port = port;
}
