/**
 * Remote runners, Public API
 *
 * The remote runners the product has: runner contracts, pools and portable
 * review artifacts (`RemoteRunnerRegistry`), the supervisor and the per-runner
 * derivations `/remote` reads (capabilities, heartbeat, negotiation, recovery,
 * session state), and the distributed runtime that pairs and serves remote
 * peers over HTTP. Each live connection owns its own lifecycle: ACP subagents
 * report it through TRANSPORT_* events, distributed peers through pairing,
 * heartbeats and work claims, the daemon client through its HTTP retry hooks.
 */

export type {
  RemoteRunnerContract,
  RemoteRunnerCapabilityCeiling,
  RemoteExecutionArtifact,
  RemoteRunnerEvidenceSummary,
} from './types.js';

export {
  deriveRemoteCapabilities,
} from './capabilities.js';
export type {
  RemoteCapabilityId,
  RemoteCapabilitySnapshot,
} from './capabilities.js';
export {
  deriveRemoteHeartbeat,
} from './heartbeat.js';
export type {
  RemoteHeartbeatSnapshot,
} from './heartbeat.js';
export {
  deriveRemoteNegotiation,
} from './negotiation.js';
export type {
  RemoteNegotiationSnapshot,
} from './negotiation.js';
export {
  deriveRemoteRecoveryActions,
} from './recovery.js';
export type {
  RemoteRecoveryAction,
} from './recovery.js';
export {
  buildRemoteSessionStateSnapshot,
} from './session-state.js';
export type {
  RemoteSessionStateSnapshot,
} from './session-state.js';
export {
  RemoteSupervisor,
} from './supervisor.js';
export type {
  RemoteSupervisorSnapshot,
} from './supervisor.js';
export {
  RemoteRunnerRegistry,
  exportRemoteArtifactForAgent,
  importRemoteArtifact,
} from './runner-registry.js';
export type {
  DistributedPeerKind,
  DistributedPairRequestStatus,
  DistributedPeerStatus,
  DistributedWorkPriority,
  DistributedWorkStatus,
  DistributedWorkType,
  DistributedSessionBridge,
  DistributedApprovalBridge,
  DistributedAutomationBridge,
  DistributedRuntimePairRequest,
  DistributedPeerTokenRecord,
  DistributedPeerRecord,
  DistributedPendingWork,
  DistributedRuntimeAuditRecord,
  DistributedRuntimeSnapshotStore,
  DistributedPeerAuth,
  DistributedNodeHostContract,
} from './distributed-runtime.js';
export {
  DistributedRuntimeManager,
  getDistributedNodeHostContract,
} from './distributed-runtime.js';
