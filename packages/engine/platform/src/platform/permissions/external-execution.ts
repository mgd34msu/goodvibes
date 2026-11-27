/**
 * Workspace constraints for an external protocol owner (an MCP server, a hosted
 * ACP agent). Paths are resolved once, when the owner is prepared: a spawned
 * process keeps the directory it was started in whatever a path later points
 * at, so re-resolving it per ask protects nothing. What can change, the trust
 * decision, is the trust owner's revision, compared as an integer.
 */
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ExternalPermissionHost } from './external-request.js';

function withinFolder(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Capture revision only: the canonical manager still owns action classification. */
export async function prepareExternalWorkspaceRevision(host: ExternalPermissionHost, signal: AbortSignal): Promise<() => void> {
  const trust = host.workspaceTrust;
  const prepare = trust?.prepareAutonomousConstraint;
  if (trust === undefined || (trust !== null && typeof prepare !== 'function')) throw new Error('External operation has no workspace trust owner');
  if (host.workspaceRoot) realpathSync(resolve(host.workspaceRoot));
  const assertTrust = await prepare?.call(trust, 'read', signal);
  const assertCurrent = () => { signal.throwIfAborted(); host.signal.throwIfAborted(); assertTrust?.(); };
  assertCurrent(); return assertCurrent;
}

/** Process start retains both the original owner's and actual target's bounds. */
export async function prepareExternalExecution(host: ExternalPermissionHost, cwd: string, signal: AbortSignal): Promise<() => void> {
  const origin = host.workspaceTrust;
  const resolver = host.workspaceTrustFor;
  const root = host.workspaceRoot;
  if (origin === undefined) throw new Error('External process has no workspace trust owner');
  const target = resolver ? resolver(cwd) : origin;
  if (target === undefined) throw new Error('External process target has no workspace trust owner');
  const physical = realpathSync(resolve(cwd));
  // The trust owner is a project (runtime/workspace-trust.ts workspaceTrustOwnerOf): a process starts in its root, or in
  // a folder inside it (a program's sandbox rooted where it was opened), never outside the project its trust covers.
  if (!resolver && origin !== null && (!root || !withinFolder(realpathSync(resolve(root)), physical)))
    throw new Error('External process target differs from its workspace trust owner');
  const originPrepare = origin?.prepareAutonomousConstraint;
  const targetPrepare = target?.prepareAutonomousConstraint;
  if ((origin !== null && typeof originPrepare !== 'function') || (target !== null && typeof targetPrepare !== 'function'))
    throw new Error('External process workspace trust capability is unavailable');
  const originPreparation = originPrepare?.call(origin, 'execute', signal);
  const targetPreparation = target === origin ? originPreparation : targetPrepare?.call(target, 'execute', signal);
  const [originCurrent, targetCurrent] = await Promise.all([originPreparation, targetPreparation]);
  const assertCurrent = () => { signal.throwIfAborted(); host.signal.throwIfAborted(); originCurrent?.(); targetCurrent?.(); };
  assertCurrent(); return assertCurrent;
}
