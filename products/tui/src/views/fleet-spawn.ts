// ---------------------------------------------------------------------------
// fleet-spawn.ts
//
// The terminal app's gateway for the Your agents panel's "new agent" key: the
// ACP calls over this product's operator endpoint. The controller itself
// (FleetSpawn) is shared with the Agent in terminal-shell/fleet-spawn.ts.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { AcpSpawnGateway, AcpSpawnGatewayResolution } from '@goodvibes-jev/engine/terminal-shell/fleet-spawn';
import { resolveOperatorRpc } from '../runtime/client/operator-endpoint.ts';

export * from '@goodvibes-jev/engine/terminal-shell/fleet-spawn';

export interface AcpSpawnGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/**
 * The live gateway over the generic operator invoke path, the same daemon
 * resolution the fleet acts use. Unavailable, with the reason, when no daemon
 * is reachable, so the key refuses cleanly instead of throwing.
 */
export function createAcpSpawnGateway(deps: AcpSpawnGatewayDeps): AcpSpawnGatewayResolution {
  const rpc = resolveOperatorRpc(deps);
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { platformClient } = rpc;
  const gateway: AcpSpawnGateway = {
    listAgents: async () => (await platformClient.operator.invoke('acp.agents.list', {})).agents,
    listWorkspaces: async () => (await platformClient.operator.invoke('workspaces.registrations.list', {})).workspaces,
    createSession: (input) => platformClient.operator.invoke('acp.sessions.create', input),
  };
  return { available: true, gateway };
}
