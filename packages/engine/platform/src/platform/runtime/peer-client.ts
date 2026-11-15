import type { AcpConnection } from './store/domains/acp.js';
import type { RuntimeStore } from './store/index.js';
import type { DistributedRuntimeManager } from './remote/distributed-runtime-manager.js';
import type {
  DistributedNodeHostContract,
  DistributedPeerAuth,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPendingWork,
  DistributedRuntimePairRequest,
  DistributedWorkPriority,
  DistributedWorkType,
} from './remote/index.js';
import type {
  RemoteExecutionArtifact,
  RemoteRunnerContract,
  RemoteRunnerPool,
} from './remote/types.js';
import type { RemoteRunnerRegistry } from './remote/runner-registry.js';
import type { RemoteSupervisor, RemoteSupervisorSnapshot } from './remote/supervisor.js';
import type { RemoteSessionStateSnapshot } from './remote/session-state.js';

export interface PeerClientDependencies {
  readonly runtimeStore: RuntimeStore;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
}

export interface PeerClientPairingSnapshot {
  readonly requests: readonly DistributedRuntimePairRequest[];
  readonly total: number;
  readonly pending: number;
  readonly approved: number;
  readonly verified: number;
  readonly rejected: number;
  readonly expired: number;
}

export interface PeerClientPeerSnapshot {
  readonly peerId: string;
  readonly peer: DistributedPeerRecord | null;
  readonly session: RemoteSessionStateSnapshot | null;
  readonly runnerContract: RemoteRunnerContract | null;
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly pendingWork: readonly DistributedPendingWork[];
  readonly artifacts: readonly RemoteExecutionArtifact[];
}

export interface PeerClientRunnersSnapshot {
  readonly pools: readonly RemoteRunnerPool[];
  readonly contracts: readonly RemoteRunnerContract[];
  readonly artifacts: readonly RemoteExecutionArtifact[];
}

export interface PeerClientAcpSnapshot {
  readonly transportState: string;
  readonly totalMessages: number;
  readonly activeConnections: readonly AcpConnection[];
}

export interface PeerClientSnapshot {
  readonly capturedAt: number;
  readonly nodeHostContract: DistributedNodeHostContract;
  readonly acp: PeerClientAcpSnapshot;
  readonly pairing: PeerClientPairingSnapshot;
  readonly peers: readonly DistributedPeerRecord[];
  readonly peerSnapshots: readonly PeerClientPeerSnapshot[];
  readonly work: readonly DistributedPendingWork[];
  readonly runners: PeerClientRunnersSnapshot;
  readonly supervisor: RemoteSupervisorSnapshot;
}

export interface PeerClientPairingDomain {
  listRequests(limit?: number): DistributedRuntimePairRequest[];
  request(input: Parameters<DistributedRuntimeManager['requestPairing']>[0]): ReturnType<DistributedRuntimeManager['requestPairing']>;
  approve(
    requestId: string,
    input?: Parameters<DistributedRuntimeManager['approvePairRequest']>[1],
  ): ReturnType<DistributedRuntimeManager['approvePairRequest']>;
  reject(
    requestId: string,
    input?: Parameters<DistributedRuntimeManager['rejectPairRequest']>[1],
  ): ReturnType<DistributedRuntimeManager['rejectPairRequest']>;
  verify(
    requestId: string,
    challenge: string,
    input?: Parameters<DistributedRuntimeManager['verifyPairRequest']>[2],
  ): ReturnType<DistributedRuntimeManager['verifyPairRequest']>;
}

export interface PeerClientPeersDomain {
  list(kind?: DistributedPeerKind, limit?: number): DistributedPeerRecord[];
  get(peerId: string): DistributedPeerRecord | null;
  getSnapshot(peerId: string): PeerClientPeerSnapshot | null;
  authenticateToken(tokenValue: string, remoteAddress?: string): ReturnType<DistributedRuntimeManager['authenticatePeerToken']>;
  heartbeat(
    auth: DistributedPeerAuth,
    input?: Parameters<DistributedRuntimeManager['heartbeatPeer']>[1],
  ): ReturnType<DistributedRuntimeManager['heartbeatPeer']>;
  rotateToken(
    peerId: string,
    input?: Parameters<DistributedRuntimeManager['rotatePeerToken']>[1],
  ): ReturnType<DistributedRuntimeManager['rotatePeerToken']>;
  revokeToken(
    peerId: string,
    input?: Parameters<DistributedRuntimeManager['revokePeerToken']>[1],
  ): ReturnType<DistributedRuntimeManager['revokePeerToken']>;
  disconnect(
    peerId: string,
    input?: Parameters<DistributedRuntimeManager['disconnectPeer']>[1],
  ): ReturnType<DistributedRuntimeManager['disconnectPeer']>;
}

export interface PeerClientWorkDomain {
  list(limit?: number, peerId?: string): DistributedPendingWork[];
  enqueue(input: Parameters<DistributedRuntimeManager['enqueueWork']>[0]): ReturnType<DistributedRuntimeManager['enqueueWork']>;
  invoke(input: Parameters<DistributedRuntimeManager['invokePeer']>[0]): ReturnType<DistributedRuntimeManager['invokePeer']>;
  claim(
    auth: DistributedPeerAuth,
    input?: Parameters<DistributedRuntimeManager['claimWork']>[1],
  ): ReturnType<DistributedRuntimeManager['claimWork']>;
  complete(
    auth: DistributedPeerAuth,
    workId: string,
    input?: Parameters<DistributedRuntimeManager['completeWork']>[2],
  ): ReturnType<DistributedRuntimeManager['completeWork']>;
  cancel(
    workId: string,
    input?: Parameters<DistributedRuntimeManager['cancelWork']>[1],
  ): ReturnType<DistributedRuntimeManager['cancelWork']>;
}

export interface PeerClientRunnersDomain {
  listPools(): RemoteRunnerPool[];
  getPool(poolId: string): RemoteRunnerPool | null;
  createPool(input: Parameters<RemoteRunnerRegistry['createPool']>[0]): RemoteRunnerPool;
  assignRunnerToPool(poolId: string, runnerId: string): RemoteRunnerPool | null;
  removeRunnerFromPool(poolId: string, runnerId: string): RemoteRunnerPool | null;
  listContracts(): RemoteRunnerContract[];
  getContract(runnerId: string): RemoteRunnerContract | null;
  registerContract(contract: RemoteRunnerContract): RemoteRunnerContract;
  upsertContractForAgent(agentId: string): RemoteRunnerContract | null;
  listArtifacts(): RemoteExecutionArtifact[];
  getArtifact(artifactId: string): RemoteExecutionArtifact | null;
  captureArtifactForAgent(agentId: string): RemoteExecutionArtifact | null;
  captureArtifactForRunner(runnerId: string): RemoteExecutionArtifact | null;
  exportArtifact(
    artifactId: string,
    path?: string,
  ): ReturnType<RemoteRunnerRegistry['exportArtifact']>;
  importArtifact(path: string): ReturnType<RemoteRunnerRegistry['importArtifact']>;
  buildReviewSummary(artifactId: string): string | null;
  exportSessionBundle(path?: string): ReturnType<RemoteRunnerRegistry['exportSessionBundle']>;
  importSessionBundle(path: string): ReturnType<RemoteRunnerRegistry['importSessionBundle']>;
}

export interface PeerClient {
  readonly pairing: PeerClientPairingDomain;
  readonly peers: PeerClientPeersDomain;
  readonly work: PeerClientWorkDomain;
  readonly runners: PeerClientRunnersDomain;
  getSnapshot(): PeerClientSnapshot;
  getNodeHostContract(): DistributedNodeHostContract;
}

/** Reads past the manager's list defaults: its `limit` is a plain slice, so this means "all". */
const ALL = Number.MAX_SAFE_INTEGER;
/** How many pair requests, peers and work items a snapshot lists; counts and per-peer snapshots cover every one. */
const SNAPSHOT_PAIR_REQUESTS = 250;
const SNAPSHOT_PEERS = 500;
const SNAPSHOT_WORK = 500;

function countRequests(
  requests: readonly DistributedRuntimePairRequest[],
  all: readonly DistributedRuntimePairRequest[] = requests,
): PeerClientPairingSnapshot {
  return {
    requests,
    total: all.length,
    pending: all.filter((request) => request.status === 'pending').length,
    approved: all.filter((request) => request.status === 'approved').length,
    verified: all.filter((request) => request.status === 'verified').length,
    rejected: all.filter((request) => request.status === 'rejected').length,
    expired: all.filter((request) => request.status === 'expired').length,
  };
}

function collectPeerIds(
  peers: readonly DistributedPeerRecord[],
  contracts: readonly RemoteRunnerContract[],
  sessions: readonly RemoteSessionStateSnapshot[],
  requests: readonly DistributedRuntimePairRequest[],
  work: readonly DistributedPendingWork[],
): readonly string[] {
  const ids = new Set<string>();
  for (const peer of peers) ids.add(peer.id);
  for (const contract of contracts) ids.add(contract.runnerId);
  for (const session of sessions) ids.add(session.runnerId);
  for (const request of requests) {
    if (request.peerId) ids.add(request.peerId);
    if (request.requestedId) ids.add(request.requestedId);
  }
  for (const item of work) ids.add(item.peerId);
  return [...ids].sort();
}

function buildAcpSnapshot(store: RuntimeStore): PeerClientAcpSnapshot {
  const state = store.getState().acp;
  return {
    transportState: state.managerTransportState,
    totalMessages: state.totalMessages,
    activeConnections: state.activeConnectionIds
      .map((id) => state.connections.get(id))
      .filter((connection): connection is AcpConnection => connection !== undefined),
  };
}

/** One complete read of everything a peer snapshot draws on. */
interface PeerListing {
  readonly peers: readonly DistributedPeerRecord[];
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly work: readonly DistributedPendingWork[];
  readonly contracts: readonly RemoteRunnerContract[];
  readonly artifacts: readonly RemoteExecutionArtifact[];
  readonly sessions: readonly RemoteSessionStateSnapshot[];
}

function readPeerListing(deps: PeerClientDependencies): PeerListing {
  deps.remoteRunnerRegistry.ensureContractsFromStore(deps.runtimeStore);
  return {
    peers: deps.distributedRuntime.listPeers(undefined, ALL),
    pairRequests: deps.distributedRuntime.listPairRequests(ALL),
    work: deps.distributedRuntime.listWork(ALL),
    contracts: deps.remoteRunnerRegistry.listContracts(),
    artifacts: deps.remoteRunnerRegistry.listArtifacts(),
    sessions: deps.remoteSupervisor.getSnapshot(deps.runtimeStore).sessions,
  };
}

function peerSnapshotFrom(listing: PeerListing, peerId: string): PeerClientPeerSnapshot | null {
  const peer = listing.peers.find((entry) => entry.id === peerId) ?? null;
  const runnerContract = listing.contracts.find((entry) => entry.runnerId === peerId) ?? null;
  const pairRequests = listing.pairRequests.filter((request) => request.peerId === peerId || request.requestedId === peerId);
  const pendingWork = listing.work.filter((item) => item.peerId === peerId);
  const artifacts = listing.artifacts.filter((artifact) => artifact.runnerId === peerId);
  const session = listing.sessions.find((entry) => entry.runnerId === peerId) ?? null;
  if (!peer && !runnerContract && !session && pairRequests.length === 0 && pendingWork.length === 0 && artifacts.length === 0) {
    return null;
  }
  return { peerId, peer, session, runnerContract, pairRequests, pendingWork, artifacts };
}

function buildPeerSnapshot(deps: PeerClientDependencies, peerId: string): PeerClientPeerSnapshot | null {
  return peerSnapshotFrom(readPeerListing(deps), peerId);
}

function buildPeerSnapshots(listing: PeerListing): readonly PeerClientPeerSnapshot[] {
  const peerIds = collectPeerIds(listing.peers, listing.contracts, listing.sessions, listing.pairRequests, listing.work);
  const snapshots = peerIds
    .map((peerId) => peerSnapshotFrom(listing, peerId))
    .filter((snapshot): snapshot is PeerClientPeerSnapshot => snapshot !== null);
  return Object.freeze(snapshots);
}

function buildSnapshot(deps: PeerClientDependencies): PeerClientSnapshot {
  const listing = readPeerListing(deps);
  const pools = deps.remoteRunnerRegistry.listPools();
  const supervisor = deps.remoteSupervisor.getSnapshot(deps.runtimeStore);
  return Object.freeze({
    capturedAt: Date.now(),
    nodeHostContract: deps.distributedRuntime.getNodeHostContract(),
    acp: buildAcpSnapshot(deps.runtimeStore),
    pairing: countRequests(listing.pairRequests.slice(0, SNAPSHOT_PAIR_REQUESTS), listing.pairRequests),
    peers: listing.peers.slice(0, SNAPSHOT_PEERS),
    peerSnapshots: buildPeerSnapshots(listing),
    work: listing.work.slice(0, SNAPSHOT_WORK),
    runners: {
      pools,
      contracts: listing.contracts,
      artifacts: listing.artifacts,
    },
    supervisor,
  });
}

export function createPeerClient(deps: PeerClientDependencies): PeerClient {
  const resolved = Object.freeze({ ...deps });
  return {
    pairing: {
      listRequests(limit = 100): DistributedRuntimePairRequest[] {
        return resolved.distributedRuntime.listPairRequests(limit);
      },
      request(input) {
        return resolved.distributedRuntime.requestPairing(input);
      },
      approve(requestId, input) {
        return resolved.distributedRuntime.approvePairRequest(requestId, input ?? {});
      },
      reject(requestId, input) {
        return resolved.distributedRuntime.rejectPairRequest(requestId, input ?? {});
      },
      verify(requestId, challenge, input) {
        return resolved.distributedRuntime.verifyPairRequest(requestId, challenge, input ?? {});
      },
    },
    peers: {
      list(kind, limit = 200): DistributedPeerRecord[] {
        return resolved.distributedRuntime.listPeers(kind, limit);
      },
      get(peerId: string): DistributedPeerRecord | null {
        return resolved.distributedRuntime.listPeers(undefined, ALL).find((peer) => peer.id === peerId) ?? null;
      },
      getSnapshot(peerId: string): PeerClientPeerSnapshot | null {
        return buildPeerSnapshot(resolved, peerId);
      },
      authenticateToken(tokenValue: string, remoteAddress?: string) {
        return resolved.distributedRuntime.authenticatePeerToken(tokenValue, remoteAddress);
      },
      heartbeat(auth: DistributedPeerAuth, input) {
        return resolved.distributedRuntime.heartbeatPeer(auth, input ?? {});
      },
      rotateToken(peerId: string, input) {
        return resolved.distributedRuntime.rotatePeerToken(peerId, input ?? {});
      },
      revokeToken(peerId: string, input) {
        return resolved.distributedRuntime.revokePeerToken(peerId, input ?? {});
      },
      disconnect(peerId: string, input) {
        return resolved.distributedRuntime.disconnectPeer(peerId, input ?? {});
      },
    },
    work: {
      list(limit = 200, peerId?: string): DistributedPendingWork[] {
        return resolved.distributedRuntime.listWork(limit, peerId);
      },
      enqueue(input) {
        return resolved.distributedRuntime.enqueueWork(input);
      },
      invoke(input) {
        return resolved.distributedRuntime.invokePeer(input);
      },
      claim(auth: DistributedPeerAuth, input) {
        return resolved.distributedRuntime.claimWork(auth, input ?? {});
      },
      complete(auth: DistributedPeerAuth, workId: string, input) {
        return resolved.distributedRuntime.completeWork(auth, workId, input ?? {});
      },
      cancel(workId: string, input) {
        return resolved.distributedRuntime.cancelWork(workId, input ?? {});
      },
    },
    runners: {
      listPools(): RemoteRunnerPool[] {
        return resolved.remoteRunnerRegistry.listPools();
      },
      getPool(poolId: string): RemoteRunnerPool | null {
        return resolved.remoteRunnerRegistry.getPool(poolId);
      },
      createPool(input: Parameters<RemoteRunnerRegistry['createPool']>[0]): RemoteRunnerPool {
        return resolved.remoteRunnerRegistry.createPool(input);
      },
      assignRunnerToPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
        return resolved.remoteRunnerRegistry.assignRunnerToPool(poolId, runnerId);
      },
      removeRunnerFromPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
        return resolved.remoteRunnerRegistry.removeRunnerFromPool(poolId, runnerId);
      },
      listContracts(): RemoteRunnerContract[] {
        return resolved.remoteRunnerRegistry.listContracts();
      },
      getContract(runnerId: string): RemoteRunnerContract | null {
        return resolved.remoteRunnerRegistry.getContract(runnerId);
      },
      registerContract(contract: RemoteRunnerContract): RemoteRunnerContract {
        return resolved.remoteRunnerRegistry.registerContract(contract);
      },
      upsertContractForAgent(agentId: string): RemoteRunnerContract | null {
        return resolved.remoteRunnerRegistry.upsertContractForAgent(agentId, resolved.runtimeStore);
      },
      listArtifacts(): RemoteExecutionArtifact[] {
        return resolved.remoteRunnerRegistry.listArtifacts();
      },
      getArtifact(artifactId: string): RemoteExecutionArtifact | null {
        return resolved.remoteRunnerRegistry.getArtifact(artifactId);
      },
      captureArtifactForAgent(agentId: string): RemoteExecutionArtifact | null {
        return resolved.remoteRunnerRegistry.captureArtifactForAgent(agentId, resolved.runtimeStore);
      },
      captureArtifactForRunner(runnerId: string): RemoteExecutionArtifact | null {
        return resolved.remoteRunnerRegistry.captureArtifactForRunner(runnerId, resolved.runtimeStore);
      },
      exportArtifact(artifactId: string, path?: string) {
        return resolved.remoteRunnerRegistry.exportArtifact(artifactId, path);
      },
      importArtifact(path: string) {
        return resolved.remoteRunnerRegistry.importArtifact(path);
      },
      buildReviewSummary(artifactId: string): string | null {
        return resolved.remoteRunnerRegistry.buildReviewSummary(artifactId);
      },
      exportSessionBundle(path?: string) {
        return resolved.remoteRunnerRegistry.exportSessionBundle(resolved.runtimeStore, path);
      },
      importSessionBundle(path: string) {
        return resolved.remoteRunnerRegistry.importSessionBundle(path);
      },
    },
    getSnapshot(): PeerClientSnapshot {
      return buildSnapshot(resolved);
    },
    getNodeHostContract(): DistributedNodeHostContract {
      return resolved.distributedRuntime.getNodeHostContract();
    },
  };
}
