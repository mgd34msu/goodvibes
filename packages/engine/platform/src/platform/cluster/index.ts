/**
 * LAN leader election, exactly one node consumes each inbound surface.
 *
 * Wire a `ClusterCoordinator` in a composition root, register every INBOUND
 * consumer with it, one gate per surface it can actually serve, and start it.
 * Outbound sends, sessions, the control plane and HTTP never pass through here:
 * leadership gates what a node listens to, never what it can do.
 *
 * Elections are per surface, so a node that can serve ntfy but not Telegram
 * contests ntfy alone, and losing the ntfy holder moves ntfy without touching
 * anything else.
 *
 * The protocol is LAN-only. Nothing in this module contacts Telegram, ntfy, or
 * any other external service, and nothing in it is ever surfaced to a user,
 * elections, heartbeats and promotions are log lines and a `/status` section,
 * never a notification and never a transcript line. Surface wire IDs omit raw
 * discriminators; they are stable public pseudonyms, not anonymity against
 * guessing a known/low-entropy topic or account. Signatures do not encrypt them.
 */
export { ClusterMembershipOperationError, type ClusterMembershipOperation, type MembershipOperationFailure } from './membership-operation.js';
export { ClusterCoordinator, type ClusterCoordinatorOptions } from './coordinator.js';
export { ClusterElection, type ClusterElectionOptions } from './election-node.js';
export { SurfaceElection, type SurfaceElectionHost, type SurfaceElectionOptions } from './election.js';
export {
  ClusterSurfaceRegistry,
  type RegisteredClusterSurface,
} from './surface-registry.js';
export {
  ClusterHoldingsLedger,
  type ClusterHoldingRecord,
  type ClusterHoldingsOptions,
} from './holdings.js';
export { createSystemClusterClock, FakeClusterClock } from './clock.js';
export { MemoryClusterBus, MemoryClusterTransport } from './memory-transport.js';
export { UdpClusterTransport, parsePeers, type UdpClusterTransportOptions } from './udp-transport.js';
export {
  CLUSTER_NODE_ID_FILENAME,
  isValidNodeId,
  resolveNodeIdentity,
  type ResolveNodeIdOptions,
  type ResolvedNodeIdentity,
} from './identity.js';
export {
  canonicalSurfaceKey,
  inboxSurface,
  isSurfaceId,
  ntfySurface,
  providerSurface,
  stableSurfaceHash,
  surfaceIdFor,
  surfaceLabel,
  telegramBotIdFromToken,
  telegramSurface,
  type ClusterSurfaceKey,
  type ClusterSurfaceKind,
} from './surface-id.js';
export {
  compareSpreadRank,
  compareStableRank,
  compareVersions,
  isStrictlyNewerVersion,
  outranksForSurface,
  outranksStably,
  shouldYieldSurface,
  SURFACE_YIELD_GAP,
  type ClusterRankable,
  type ClusterSpreadRankable,
} from './ranking.js';
export {
  canonicalizeMessage,
  decodeMessage,
  encodeMessage,
  signMessage,
  type ClusterDecodeResult,
} from './protocol.js';
export { readClusterSettings, type ClusterSecretSource } from './config-read.js';
// ── group identity, membership and keys ─────────────────────────────────────
export {
  generateGroupId,
  deriveJoinSalt,
  deriveJoinVerifier,
  generateGroupKey,
  generateJoinKey,
  generateNodeKeyMaterial,
  isValidGroupId,
  normalizeJoinKey,
  JOIN_SCRYPT_PARAMS,
  type NodeKeyMaterial,
  type WrappedKeyEnvelope,
} from './group-crypto.js';
export {
  DEFAULT_GROUP_DISPLAY_NAME,
  findTombstone,
  groupStateFromRecord,
  isCurrentMember,
  isGroupEntry,
  keyEpochEntryId,
  keyEpochsFromRecord,
  MAX_GROUP_MEMBERS,
  memberEntryId,
  nextMembershipGeneration,
  normalizeDisplayName,
  type GroupMember,
  type GroupStateDocument,
  type GroupTombstone,
} from './group-state.js';
export {
  clearGroupKeyMaterial,
  clusterSecretStoreFrom,
  computeKeyAcceptance,
  createGroupKeyMaterial,
  GROUP_MATERIAL_SECRET_KEY,
  GroupKeyring,
  keyCommitment,
  loadGroupKeyMaterial,
  MAX_KEY_AGE_MS,
  MAX_KEY_GENERATIONS,
  readGroupKeyMaterial,
  saveGroupKeyMaterial,
  sweepKeyHistory,
  withGroupKey,
  type ClusterSecretStore,
  type ClusterSecretsSource,
  type GroupKeyMaterial,
  type GroupKeyRecord,
  type KeyAcceptance,
  type KeyEpochFacts,
} from './group-store.js';
export {
  ADMISSION_FRESHNESS_MS,
  decideAdmission,
  describeRefusal,
  GROUP_MESSAGE_TYPES,
  isOutOfBandMessageType,
  type AdmissionDecision,
  type AdmissionGrant,
  type AdmissionRefusal,
} from './group-membership.js';
export {
  GroupAdmissionService,
  type AdmissionFailure,
  type AdmissionOutcome,
} from './group-admissions.js';
export {
  CLUSTER_ENVELOPE_VERSION,
  canonicalizeEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  MAX_ENVELOPE_BYTES,
  peekEnvelope,
  signEnvelope,
  type ClusterEnvelope,
  type ClusterKeyring,
  type EnvelopeDecodeResult,
  type EnvelopeRejection,
} from './protocol-envelope.js';
export { GroupWireRouter, type GroupWireCounters } from './group-transport.js';
export {
  classifyDaemonConfigPath,
  isPortConfigKey,
  isReplicatedConfigPath,
  isReplicatedSecretKey,
  listDaemonConfigClassifications,
  listReplicatedConfigPaths,
  NODE_LOCAL_CONFIG_DOMAINS,
  replicatedSecretKeyFor,
  replicatedSecretKeys,
  REPLICATED_CONFIG_DOMAINS,
  type ConfigPathClassification,
  type ConfigReplicationClass,
} from './config-replication-policy.js';
export {
  CONFIG_TOMBSTONE_MAX_AGE_MS,
  createConfigReplicaDocument,
  deleteReplicaEntry,
  findReplicaEntry,
  MAX_REPLICATED_ENTRIES,
  MAX_REPLICATED_TOMBSTONES,
  MAX_REPLICATED_VALUE_BYTES,
  mergeConfigReplica,
  putReplicaEntry,
  readConfigReplicaDocument,
  sweepConfigReplica,
  type ConfigReplicaDocument,
  type ConfigReplicaEntry,
  type ConfigReplicaTombstone,
} from './config-replica.js';
export {
  CONFIG_MESSAGE_TYPES,
  ConfigLocalDifferenceError,
  ConfigReplicationService,
  type ConfigLocalDifference,
  type ConfigReplicationHost,
  type ConfigReplicationStatus,
  type HeldConfigChange,
  type ReplicatedConfigStore,
  type ReplicatedSecretStore,
} from './config-replication.js';
export {
  ClusterGroupRuntime,
  type ClusterGroupRuntimeOptions,
  type DiscoveredGroup,
  type GroupMembershipState,
  type MembershipRecordStep,
  type RotationResult,
  type SurfaceHolding,
} from './group-runtime.js';
export {
  ADMISSION_TIMEOUT_MS,
  createClusterGroupVerbs,
  acknowledgeRemoval,
  createGroup,
  decideLocalSetting,
  forgetNode,
  groupNodes,
  groupsOnTheNetwork,
  groupStatus,
  joinGroup,
  joinKeyForGroup,
  leaveGroup,
  rejoinGroup,
  renameGroupTo,
  rotateGroupKey,
  stillOnRoster,
  type CreateGroupResult,
  type ForgetNodeResult,
  type GroupOperationResult,
  type GroupOperationsContext,
  type GroupStatusReport,
  type JoinGroupResult,
  type JoinKeyResult,
  type NodeReport,
  type ClusterGroupVerbSurface,
  type LeaveGroupResult,
  type NodesResult,
  type RemovedNodeReport,
  type RenameGroupResult,
  type RotateKeyResult,
  type SettingDecisionResult,
} from './group-operations.js';
export {
  DEFAULT_CLUSTER_GROUP_SETTINGS,
  keyRotationGraceMs,
  keyRotationMs,
  resolveClusterGroupSettings,
  type ClusterGroupSettings,
} from './group-settings.js';
export {
  DEFAULT_CLUSTER_MULTICAST_GROUP,
  DEFAULT_CLUSTER_PORT,
  DEFAULT_CLUSTER_SETTINGS,
  clusterElectionTiming,
  resolveClusterSettings,
} from './settings.js';
export { deriveClusterTiming, type ClusterTiming } from './timing.js';
export { CLUSTER_PROTOCOL_VERSION } from './types.js';
export type {
  ClusterClock,
  ClusterElectionTiming,
  ClusterSettingAdjustment,
  ClusterConsumerGate,
  ClusterConsumerStartContext,
  ClusterCoordination,
  ClusterLogger,
  ClusterMessage,
  ClusterMessageType,
  ClusterPeerStatus,
  ClusterRole,
  ClusterSecretSetting,
  ClusterSettings,
  ClusterStatus,
  ClusterSurfaceHolding,
  ClusterSurfaceStatus,
  ClusterTransport,
  ClusterTransportDescription,
  SignedClusterMessage,
} from './types.js';

/** A custom SurfaceElection host must declare the exact ranking behavior in
 * its existing signed nodeVersion, as ClusterElection does automatically. */
export { CLUSTER_RANK_FEATURE, CLUSTER_V1_PEER_RANK_FEATURE, clusterRankingWireVersion, clusterProductVersion } from './ranking-feature.js';
export { ClusterRoles, clusterRoleGate, clusterRoleSurface, type ClusterRoleName, type ClusterRoleSource } from './roles.js';
export {
  AUTHORITY_KINDS,
  authorityDigest,
  authorityHead,
  authorityKey,
  buildAuthorityView,
  compactAuthority,
  emptyAuthorityRecord,
  issueEntries,
  keyOf,
  mergeAuthority,
  readAuthorityEntry,
  readAuthorityRecord,
  rescopeAuthorityRecord,
  revokeEntry,
  toAuthorityWire,
  updateEntry,
  AuthorityMissingError,
  AuthorityRevokedError,
  type AnyAuthorityEntry,
  type AuthorityAudience,
  type AuthorityDraft,
  type AuthorityEntry,
  type AuthorityHead,
  type AuthorityKey,
  type AuthorityKind,
  type AuthorityPublicParts,
  type AuthorityPrivateParts,
  type AuthorityRecord,
  type AuthorityRecordWire,
  type AuthorityRef,
  type AuthorityRevocation,
  type AuthorityScope,
  type AuthorityUserConflict,
  type AuthorityView,
} from './authority-record.js';
export {
  AUTHORITY_REVOKED_RETENTION_MS,
  AuthorityRecordFile,
  openAuthorityRecordFile,
  AuthorityRecordUnavailableError,
  resolveAuthorityNodeId,
  type AuthorityAbsorbResult,
  type AuthorityChange,
  type AuthorityChangeNotice,
  type AuthorityRecordFileOptions,
  type AuthorityWriteResult,
} from './authority-record-file.js';
export { AuthoritySync, type AuthoritySyncHost, type EpochSecrets } from './authority-sync.js';
export { stableJson as groupTenantStableJson, type GroupTenant, type GroupTenantHost } from './group-tenants.js';
