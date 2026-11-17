import type { RuntimeServices } from './services.js';
import type { UiReadModel } from './ui-read-models-base.js';
import { createStoreBackedReadModel, projectRecords } from './ui-read-model-helpers.js';
import type { RemoteSupervisorSnapshot } from './remote/supervisor.js';
import type { DistributedPendingWork, DistributedPeerRecord, DistributedRuntimePairRequest } from './remote/distributed-runtime-types.js';

export interface UiRemoteSnapshot {
  /** The daemon listener this process hosts, if any. */
  readonly daemon: {
    readonly transportState: string;
    readonly isRunning: boolean;
    readonly lastError?: string | undefined;
  };
  /** Automation runs queued or running in this process. */
  readonly activeAutomationRuns: number;
  readonly acp: {
    readonly transportState: string;
    readonly totalSpawned: number;
    readonly activeConnections: readonly import('./store/domains/acp.js').AcpConnection[];
  };
  readonly pools: ReturnType<RuntimeServices['remoteRunnerRegistry']['listPools']>;
  readonly contracts: ReturnType<RuntimeServices['remoteRunnerRegistry']['listContracts']>;
  readonly artifacts: ReturnType<RuntimeServices['remoteRunnerRegistry']['listArtifacts']>;
  readonly supervisor: RemoteSupervisorSnapshot;
  readonly distributed: {
    readonly pairRequests: readonly DistributedRuntimePairRequest[];
    readonly peers: readonly DistributedPeerRecord[];
    readonly work: readonly DistributedPendingWork[];
  };
}

export interface UiRemoteReadModels {
  readonly remote: UiReadModel<UiRemoteSnapshot>;
}

export function createRemoteReadModels(runtimeServices: RuntimeServices): UiRemoteReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    remote: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const distributedRaw = runtimeServices.distributedRuntime.getSnapshot() as {
        pairRequests?: readonly DistributedRuntimePairRequest[] | undefined;
        peers?: readonly DistributedPeerRecord[] | undefined;
        work?: readonly DistributedPendingWork[] | undefined;
      };
      return {
        daemon: {
          transportState: state.daemon.transportState,
          isRunning: state.daemon.isRunning,
          lastError: state.daemon.lastError,
        },
        activeAutomationRuns: state.automation.activeRunIds.length,
        acp: {
          transportState: state.acp.managerTransportState,
          totalSpawned: state.acp.totalSpawned,
          activeConnections: projectRecords(state.acp.activeConnectionIds, state.acp.connections),
        },
        pools: runtimeServices.remoteRunnerRegistry.listPools(),
        contracts: runtimeServices.remoteRunnerRegistry.listContracts(),
        artifacts: runtimeServices.remoteRunnerRegistry.listArtifacts(),
        supervisor: runtimeServices.remoteSupervisor.getSnapshot(runtimeStore),
        distributed: {
          pairRequests: distributedRaw.pairRequests ?? [],
          peers: distributedRaw.peers ?? [],
          work: distributedRaw.work ?? [],
        },
      };
    }),
  };
}
