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

function createListHandler(service: WorkspacesGatewayService): GatewayMethodHandler {
  return async () => {
    const snapshot = await service.snapshot();
    return { workspaces: snapshot.workspaces, declines: snapshot.declines };
  };
}

/**
 * The projects a caller can choose: each registered root once. The daemon's own working folder is a folder of its own
 * in its home, never a project (products/daemon cli/configuration.ts `daemonOwnFolder`), so it is not offered.
 */
function createProjectsHandler(service: WorkspacesGatewayService, daemonFolder: string | undefined): GatewayMethodHandler {
  return async () => {
    const snapshot = await service.snapshot();
    const projects: { root: string; label?: string; daemonFolder: boolean }[] = [];
    for (const workspace of snapshot.workspaces) {
      if (workspace.root === daemonFolder || projects.some((project) => project.root === workspace.root)) continue;
      projects.push({ root: workspace.root, ...(workspace.label ? { label: workspace.label } : {}), daemonFolder: false });
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
