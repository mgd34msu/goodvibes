/**
 * routes/workspaces.ts
 *
 * Handlers for the registered-workspace registry verbs over
 * WorkspaceRegistrationStore. Thin verb registration: each handler reads the
 * invocation params, calls the store, and maps a WorkspaceRegistrationError to
 * an honest 400. Attached to the descriptors cataloged (without a handler) from
 * ../method-catalog-workspaces.ts, via the same GatewayMethodCatalog.register
 * mechanism skills.* / rewind.* use.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import {
  WorkspaceRegistrationError,
  type WorkspaceGitMetadata,
  type WorkspaceRegistrationStore,
} from '../../workspace/registration/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';
import { folderReach } from '../../workspace/folder-reach.js';

/** The subset of the store the verb handlers need. */
export type WorkspacesGatewayService = Pick<
  WorkspaceRegistrationStore,
  'snapshot' | 'add' | 'remove' | 'resolve'
>;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof WorkspaceRegistrationError) {
    throw new GatewayVerbError(error.message, error.code, 400);
  }
  throw error;
}

/**
 * A caller that is not the owner in person (daemon-api `currentRecordReach`) is shown only the projects it may name (the
 * ones the owner gave it, control-plane/caller-reach.ts); the owner, every one.
 */
function reachableRoots<T extends { readonly root: string }>(workspaces: readonly T[]): readonly T[] {
  const reach = currentRecordReach();
  return reach ? workspaces.filter((workspace) => reach('project', workspace.root)) : workspaces;
}

/**
 * A project whose folder cannot be reached now (the folder that held it is missing too: a disk not mounted, a parent
 * folder renamed) is listed with `reachable: false`; nothing of it is let go, and it is the same project when its folder
 * is back (workspace/folder-reach.ts). Absent means reachable.
 */
function withReach<T extends { readonly root: string }>(workspace: T): T & { readonly reachable?: false } {
  return folderReach(workspace.root) === 'unreachable' ? { ...workspace, reachable: false as const } : workspace;
}

function createListHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async () => {
    const snapshot = await service.snapshot();
    // The folders the owner declined to register are the owner's own choices: not a caller's but the owner's.
    return { workspaces: reachableRoots(snapshot.workspaces).map(withReach), declines: currentRecordReach() ? [] : snapshot.declines };
  };
}

/**
 * The projects a caller can choose: each registered root once. The daemon's own working folder is a folder of its own
 * in its home, never a project (products/daemon cli/configuration.ts `daemonOwnFolder`), so it is not offered.
 */
function createProjectsHandler(service: WorkspacesGatewayService, daemonFolder: string | undefined): GatewayMethodHandler {
  return async () => {
    const snapshot = await service.snapshot();
    const projects: { root: string; label?: string; daemonFolder: boolean; reachable?: false }[] = [];
    for (const workspace of reachableRoots(snapshot.workspaces)) {
      if (workspace.root === daemonFolder || projects.some((project) => project.root === workspace.root)) continue;
      projects.push(withReach({ root: workspace.root, ...(workspace.label ? { label: workspace.label } : {}), daemonFolder: false }));
    }
    return { projects };
  };
}

function createAddHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const root = requireStringValue(params.root, 'root');
    const label = optionalString(params.label);
    // Provenance: which surface/flow wrote the record, and whether this root
    // is in scope for the automatic checkpoint boundary (absent = false, so
    // a plain self-recording never widens another consumer's checkpoint scope).
    const origin = optionalString(params.origin);
    const checkpointEligible = params.checkpointEligible === true ? true : undefined;
    try {
      const opts = {
        ...(label !== undefined ? { label } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(checkpointEligible !== undefined ? { checkpointEligible } : {}),
      };
      const result = await service.add(root, Object.keys(opts).length > 0 ? opts : undefined);
      // A re-registration that granted native scope changed something; the caller
      // told to register again needs to see that the step worked.
      return { workspace: result.record, alreadyRegistered: result.alreadyRegistered, nativeScopeGranted: result.nativeScopeGranted === true };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createRemoveHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const root = requireStringValue(params.root, 'root');
    try {
      return await service.remove(root);
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createResolveHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requireStringValue(params.path, 'path');
    const mainWorktreeRoot = optionalString(params.mainWorktreeRoot);
    const git: WorkspaceGitMetadata | undefined =
      mainWorktreeRoot !== undefined ? { mainWorktreeRoot } : undefined;
    try {
      return await service.resolve(path, git);
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

/**
 * Attach the workspaces.* handlers to the descriptors already cataloged (without
 * a handler) from ../method-catalog-workspaces.ts. A missing descriptor is a
 * silent no-op, construction must never fail because a wire verb failed to
 * register; the operator-contract gates catch a real drift.
 */
export function registerWorkspacesGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: WorkspacesGatewayService,
  /** The daemon's own working folder, listed first by workspaces.projects.list. */
  daemonFolder?: string | undefined,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('workspaces.registrations.list', createListHandler(service));
  attach('workspaces.projects.list', createProjectsHandler(service, daemonFolder));
  attach('workspaces.registrations.add', createAddHandler(service));
  attach('workspaces.registrations.remove', createRemoveHandler(service));
  attach('workspaces.resolve', createResolveHandler(service));
}
