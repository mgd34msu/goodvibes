import type { RuntimeStore } from '../store/index.js';
import type { AcpConnection } from '../store/domains/acp.js';
import { RemoteRunnerRegistry } from './runner-registry.js';
import type { RemoteRunnerContract, RemoteRunnerPool } from './types.js';
import { deriveRemoteCapabilities, type RemoteCapabilitySnapshot } from './capabilities.js';
import { deriveRemoteHeartbeat, type RemoteHeartbeatSnapshot } from './heartbeat.js';
import { deriveRemoteNegotiation, type RemoteNegotiationSnapshot } from './negotiation.js';
import { deriveRemoteRecoveryActions, type RemoteRecoveryAction } from './recovery.js';
import { buildRemoteSessionStateSnapshot, type RemoteSessionStateSnapshot } from './session-state.js';

/** A runner with no transport: a local sub-agent or orchestration node. */
export interface RemoteLocalRunnerSnapshot {
  readonly runnerId: string;
  readonly label: string;
  readonly template: string;
  readonly taskId?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly orchestrationGraphId?: string | undefined;
}

export interface RemoteSupervisorSnapshot {
  readonly capturedAt: number;
  readonly totalConnections: number;
  readonly activeConnections: number;
  /** Sessions whose transport is degraded or whose heartbeat is not fresh. */
  readonly degradedConnections: number;
  readonly pools: readonly RemoteRunnerPool[];
  /** Runners with a transport; each has a heartbeat and recovery steps. */
  readonly sessions: readonly RemoteSessionStateSnapshot[];
  /** Runners with no transport, which have no heartbeat to report. */
  readonly localRunners: readonly RemoteLocalRunnerSnapshot[];
}

function stateIsDegraded(state: string): boolean {
  return state === 'degraded' || state === 'reconnecting' || state === 'terminal_failure';
}

export class RemoteSupervisor {
  constructor(private readonly remoteRegistry: RemoteRunnerRegistry) {}

  public getSnapshot(store: RuntimeStore): RemoteSupervisorSnapshot {
    this.remoteRegistry.ensureContractsFromStore(store);
    const state = store.getState();
    const pools = this.remoteRegistry.listPools();
    const contracts = this.remoteRegistry.listContracts();
    const connections = [...state.acp.connections.values()];
    const connected = new Set(connections.map((connection) => connection.agentId));
    const runnerIds = new Set<string>([
      ...connected,
      ...contracts.filter((contract) => contract.transport).map((contract) => contract.runnerId),
    ]);
    const sessions = [...runnerIds].map((runnerId) => this.describeRunner(runnerId, connections, contracts));
    const localRunners = contracts
      .filter((contract) => !contract.transport && !connected.has(contract.runnerId))
      .map((contract): RemoteLocalRunnerSnapshot => Object.freeze({
        runnerId: contract.runnerId,
        label: contract.label,
        template: contract.template,
        ...(contract.taskId ? { taskId: contract.taskId } : {}),
        ...(contract.parentAgentId ? { parentAgentId: contract.parentAgentId } : {}),
        ...(contract.orchestrationGraphId ? { orchestrationGraphId: contract.orchestrationGraphId } : {}),
      }));
    return Object.freeze({
      capturedAt: Date.now(),
      totalConnections: connections.length,
      activeConnections: state.acp.activeConnectionIds.length,
      degradedConnections: sessions.filter((session) => stateIsDegraded(session.transportState) || session.heartbeat.status !== 'fresh').length,
      pools,
      sessions,
      localRunners,
    });
  }

  private describeRunner(
    runnerId: string,
    connections: readonly AcpConnection[],
    contracts: readonly RemoteRunnerContract[],
  ): RemoteSessionStateSnapshot {
    const connection = connections.find((entry) => entry.agentId === runnerId) ?? null;
    const contract = contracts.find((entry) => entry.runnerId === runnerId) ?? null;
    const capabilities: readonly RemoteCapabilitySnapshot[] = deriveRemoteCapabilities(contract, connection);
    const heartbeat: RemoteHeartbeatSnapshot = deriveRemoteHeartbeat(connection, contract);
    const negotiation: RemoteNegotiationSnapshot = deriveRemoteNegotiation(contract, connection);
    const recovery: readonly RemoteRecoveryAction[] = deriveRemoteRecoveryActions(connection, contract, heartbeat);
    return buildRemoteSessionStateSnapshot({
      runnerId,
      // The contract names a runner by its task; a connection that went before its agent was known carries only its id.
      label: contract?.label ?? connection?.label ?? runnerId,
      connection,
      contract,
      heartbeat,
      negotiation,
      capabilities,
      recovery,
    });
  }
}
