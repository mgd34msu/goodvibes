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
  /** Connections started this session. */
  readonly totalSpawned: number;
  readonly activeConnections: readonly AcpConnection[];
}

/**
 * One peer's place in the whole snapshot: which records it has, by id. The
 * records themselves are in the snapshot's lists (or, for one peer in full,
 * from `peers.getSnapshot(peerId)`), so nothing is listed twice.
 */
export interface PeerClientPeerIndexEntry {
  readonly peerId: string;
  readonly hasPeer: boolean;
  readonly hasSession: boolean;
  readonly hasRunnerContract: boolean;
  readonly pairRequestIds: readonly string[];
  readonly workIds: readonly string[];
  readonly artifactIds: readonly string[];
}

export interface PeerClientSnapshot {
  readonly capturedAt: number;
  readonly nodeHostContract: DistributedNodeHostContract;
  readonly acp: PeerClientAcpSnapshot;
  readonly pairing: PeerClientPairingSnapshot;
  readonly peers: readonly DistributedPeerRecord[];
  readonly peerSnapshots: readonly PeerClientPeerIndexEntry[];
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
  /** The contract a runner has now, built without storing anything (read commands use this). */
  readContractForAgent(agentId: string): RemoteRunnerContract | null;
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
  importSessionBundle(path: string, options?: { readonly replace?: boolean | undefined }): ReturnType<RemoteRunnerRegistry['importSessionBundle']>;
  /** Validate a parsed session bundle and name what importing it would replace; writes nothing. */
  describeSessionBundleImport(value: unknown): ReturnType<RemoteRunnerRegistry['describeSessionBundleImport']>;
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


function buildAcpSnapshot(store: RuntimeStore): PeerClientAcpSnapshot {
  const state = store.getState().acp;
  return {
    transportState: state.managerTransportState,
    totalSpawned: state.totalSpawned,
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
  readonly supervisor: RemoteSupervisorSnapshot;
}

/**
 * Reads each collection once. The supervisor snapshot is taken first: it is
 * the one place that brings the runner contracts up to date with the agents in
 * the store, so the contract list read after it is current.
 */
function readPeerListing(deps: PeerClientDependencies): PeerListing {
  const supervisor = deps.remoteSupervisor.getSnapshot(deps.runtimeStore);
  return {
    supervisor,
    peers: deps.distributedRuntime.listPeers(undefined, ALL),
    pairRequests: deps.distributedRuntime.listPairRequests(ALL),
    work: deps.distributedRuntime.listWork(ALL),
    contracts: deps.remoteRunnerRegistry.listContracts(),
    artifacts: deps.remoteRunnerRegistry.listArtifacts(),
  };
}

interface PeerRecords {
  peer: DistributedPeerRecord | null;
  session: RemoteSessionStateSnapshot | null;
  runnerContract: RemoteRunnerContract | null;
  readonly pairRequests: DistributedRuntimePairRequest[];
  readonly pendingWork: DistributedPendingWork[];
  readonly artifacts: RemoteExecutionArtifact[];
}

/** Every record grouped by peer id, in one pass over each list. */
function indexByPeer(listing: PeerListing): Map<string, PeerRecords> {
  const index = new Map<string, PeerRecords>();
  const at = (peerId: string): PeerRecords => {
    let entry = index.get(peerId);
    if (!entry) {
      entry = { peer: null, session: null, runnerContract: null, pairRequests: [], pendingWork: [], artifacts: [] };
      index.set(peerId, entry);
    }
    return entry;
  };
  for (const peer of listing.peers) at(peer.id).peer ??= peer;
  for (const contract of listing.contracts) at(contract.runnerId).runnerContract ??= contract;
  for (const session of listing.supervisor.sessions) at(session.runnerId).session ??= session;
  for (const request of listing.pairRequests) {
    if (request.peerId) at(request.peerId).pairRequests.push(request);
    if (request.requestedId && request.requestedId !== request.peerId) at(request.requestedId).pairRequests.push(request);
  }
  for (const item of listing.work) at(item.peerId).pendingWork.push(item);
  for (const artifact of listing.artifacts) at(artifact.runnerId).artifacts.push(artifact);
  return index;
}

function buildPeerSnapshot(deps: PeerClientDependencies, peerId: string): PeerClientPeerSnapshot | null {
  const records = indexByPeer(readPeerListing(deps)).get(peerId);
  return records ? { peerId, ...records } : null;
}

function buildPeerIndex(listing: PeerListing): readonly PeerClientPeerIndexEntry[] {
  const index = indexByPeer(listing);
  return Object.freeze([...index.keys()].sort().map((peerId) => {
    const records = index.get(peerId)!;
    return Object.freeze({
      peerId,
      hasPeer: records.peer !== null,
      hasSession: records.session !== null,
      hasRunnerContract: records.runnerContract !== null,
      pairRequestIds: records.pairRequests.map((request) => request.id),
      workIds: records.pendingWork.map((item) => item.id),
      artifactIds: records.artifacts.map((artifact) => artifact.id),
    });
  }));
}

function buildSnapshot(deps: PeerClientDependencies): PeerClientSnapshot {
  const listing = readPeerListing(deps);
  const pools = deps.remoteRunnerRegistry.listPools();
  const supervisor = listing.supervisor;
  return Object.freeze({
    capturedAt: Date.now(),
    nodeHostContract: deps.distributedRuntime.getNodeHostContract(),
    acp: buildAcpSnapshot(deps.runtimeStore),
    pairing: countRequests(listing.pairRequests.slice(0, SNAPSHOT_PAIR_REQUESTS), listing.pairRequests),
    peers: listing.peers.slice(0, SNAPSHOT_PEERS),
    peerSnapshots: buildPeerIndex(listing),
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
        for (const peer of resolved.distributedRuntime.listPeers(undefined, ALL)) if (peer.id === peerId) return peer;
        return null;
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
      readContractForAgent(agentId: string): RemoteRunnerContract | null {
        return resolved.remoteRunnerRegistry.readContractForAgent(agentId, resolved.runtimeStore);
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
      importSessionBundle(path: string, options?: { readonly replace?: boolean | undefined }) {
        return resolved.remoteRunnerRegistry.importSessionBundle(path, options);
      },
      describeSessionBundleImport(value: unknown) {
        return resolved.remoteRunnerRegistry.describeSessionBundleImport(value);
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
