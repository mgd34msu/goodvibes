import type { AgentOrchestrator } from '@goodvibes/engine/platform/platform/agents';

type OrchestratorDeps = Parameters<AgentOrchestrator['setDependencies']>[0];
type OrchestratorPermissionManager = NonNullable<OrchestratorDeps['permissionManager']>;

/**
 * Hands the orchestrator that runs spawned and background agents its tool
 * dependencies, together with the permission manager, in one call. The platform
 * gate approves every background tool call when no manager is present, so there
 * is no window in which an agent can exist without one: the manager is a required
 * argument, and a missing one is refused instead of silently leaving agents ungated.
 */
export function installAgentOrchestratorDependencies(
  orchestrator: { setDependencies(deps: OrchestratorDeps): void },
  deps: Omit<OrchestratorDeps, 'permissionManager'>,
  permissionManager: OrchestratorPermissionManager | undefined,
): void {
  if (!permissionManager) {
    throw new Error('Agent orchestrator dependencies need a permission manager: without one every background tool call would run ungated.');
  }
  orchestrator.setDependencies({ ...deps, permissionManager });
}
