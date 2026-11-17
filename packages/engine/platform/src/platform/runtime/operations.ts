export { TREE_GLYPHS_CONFIG_KEY, readTreeGlyphSet, type TreeGlyphSetName } from './tree-glyph-setting.js';
export * from './remote/index.js';
export type { RemoteSessionBundle } from './remote/types.js';
export * from './tasks/index.js';
export { AcpTaskAdapter } from './tasks/adapters/index.js';
export { OpsControlPlane, OpsIllegalActionError, OpsTargetNotFoundError, OpsActionUnavailableError } from './ops/control-plane.js';
export type { OpsAgentCanceller } from './ops/control-plane.js';
export { ToolContractVerifier } from './tools/contract-verifier.js';
export type { ContractVerifierOptions } from './tools/contract-verifier.js';
export {
  McpLifecycleManager,
  McpPermissionManager,
  McpSchemaFreshnessTracker,
  buildMcpAttackPathReview,
  createMcpLifecycleManager,
  DEFAULT_RECONNECT_CONFIG,
} from './mcp/index.js';
export type {
  McpAttackPathFinding,
  McpAttackPathFindingKind,
  McpAttackPathReview,
  McpCapabilityClass,
  McpCoherenceAssessment,
  McpCoherenceVerdict,
  McpDecisionRecord,
  McpEventHandler,
  McpLifecycleManagerOptions,
  McpPermission,
  McpReconnectConfig,
  McpRiskLevel,
  McpSchemaRecord,
  McpSecuritySnapshot,
  McpServerEntry,
  McpServerPermissions,
  McpServerRole,
  McpServerState,
  McpToolPermission,
  McpTrustLevel,
  McpTrustMode,
  McpTrustProfile,
  QuarantineReason,
  QuarantineRecord,
  SchemaFreshness,
} from './mcp/index.js';
export {
  ALL_CAPABILITIES,
  ALL_CAPABILITIES as PLUGIN_CAPABILITIES,
  HIGH_RISK_CAPABILITIES,
  PluginTrustStore,
  SAFE_CAPABILITIES,
  filterCapabilitiesByTrust,
  isHighRiskCapability,
  isOperational as isPluginOperational,
  isReloadable as isPluginReloadable,
  isTerminal as isPluginTerminal,
  resolveCapabilityManifest,
  validateManifestV2,
  validatePluginSignature,
  pluginManifestSignaturePayload,
} from './plugins/index.js';
export type {
  PluginCapability,
  PluginCapabilityManifest,
  PluginManifestV2,
  PluginTrustTier,
} from './plugins/index.js';
export {
  LOW_QUALITY_THRESHOLD,
  computeQualityScore,
  createCompactionManager,
  describeScore,
  escalateStrategy,
  isTerminal as isTerminalCompactionState,
  reachableFrom as reachableFromCompactionState,
} from './compaction/index.js';
export type {
  CompactionQualityScore,
  CompactionStrategy,
  StrategyInput,
  StrategyOutput,
} from './compaction/index.js';
export {
  compactionFailurePlaybook,
  exportRecoveryPlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  reconnectFailurePlaybook,
  sessionUnrecoverablePlaybook,
  stuckTurnPlaybook,
} from './ops/playbooks/index.js';
export {
  createSessionUnrecoverablePlaybook,
} from './ops/playbooks/session-unrecoverable.js';
export {
  createStuckTurnPlaybook,
} from './ops/playbooks/stuck-turn.js';
export {
  createOpsCheckContext,
  createOpsEventObserver,
  findPlaybooksBySymptom,
  formatDoctorReport,
  getPlaybook,
  runDoctor,
} from './ops/index.js';
export type {
  DoctorCheckReport,
  DoctorPlaybookReport,
  DoctorReport,
  OpsCheckContext,
  OpsCheckContextOptions,
} from './ops/index.js';
export {
  evaluateOrchestrationSpawn,
} from './orchestration/spawn-policy.js';
export type {
  DistributedRuntimeSnapshotStore,
} from './remote/index.js';
export * from './crash-capture.js';
export { publishDaemonRuntimeRecord, type PublishedDaemonRuntimeRecord } from './detached-daemon-runtime.js';
export * from './session-maintenance.js';
export * from './session-persistence.js';
export * from './session-surface.js';
export * from './session-return-context.js';
export * from './retention/index.js';
export type {
  RetentionClass,
  RetentionClassConfig,
  RetentionConfig,
  CheckpointRecord,
  PruneOptions,
  PruneResult,
  PerClassPruneResult,
  Pruner,
  RetentionStats,
} from './retention/index.js';

export { FocusTracker } from './focus-tracker.js';
export {
  readBooleanConfig,
  readNotifyOnlyWhenUnfocused,
  shouldFireAlert,
} from './alert-gating.js';
export type { ConfigGet } from './alert-gating.js';
export {
  NOTIFICATIONS_METADATA_ONLY_KEY,
  NOTIFICATIONS_METADATA_ONLY_SETTING,
  readNotificationsMetadataOnly,
} from './notification-privacy.js';

export {
  applyRecoverySnapshot,
  confirmRecoveryRestore,
} from './recovery-snapshot-apply.js';
export type {
  ApplyRecoverySnapshotOptions,
  ApplyRecoverySnapshotResult,
  RecoveryApplyRefusal,
  RecoveryRestoreConfirmation,
  RestorableConversation,
} from './recovery-snapshot-apply.js';

export {
  claimSessionHere,
  closeSessionHere,
  isSessionOpenElsewhere,
  moveSessionHere,
  openSessionHere,
  sessionIdentityFile,
  sessionOpenLockPath,
  sweepClosedSessionLocks,
} from './session-open-lock.js';
export type { SessionIdentitySurface, SessionLockSweepResult } from './session-open-lock.js';

export {
  DURABILITY_HOUSEKEEPING_INTERVAL_MS,
  runDurabilityHousekeeping,
  startDurabilityHousekeeping,
} from './durability-housekeeping.js';
export type {
  DurabilityHousekeepingInput,
  DurabilityHousekeepingOutcome,
} from './durability-housekeeping.js';

export { createDurabilityServices } from './durability-services.js';
export type { DurabilityServices, DurabilityServicesInput } from './durability-services.js';

export { resolveDaemonCompanionToken, workspaceOperatorTokenCandidates } from './operator-token-cleanup.js';

export { bindWriteLastSessionPointerToSurface } from './session-pointer-surface.js';

export {
  BINARY_INSTALL_COMMAND,
  detectInstallKind,
  fallbackUpdateCommand,
} from './install-kind.js';
export type { InstallKind } from './install-kind.js';

export { buildReachabilityNotices, reachabilityNoticeLines } from './reachability-notice.js';
export type {
  ReachabilityNotice,
  ReachabilityNoticeInput,
  ReachabilityNoticeKind,
} from './reachability-notice.js';

export {
  announceReachability,
  boundedLatestRelease,
  INSTALLED_COMMANDS,
  LATEST_LOOKUP_TIMEOUT_MS,
  probeVersionLine,
  resolveSelfDirectory,
  runReachabilityCheck,
} from './reachability-check.js';
export type { ReachabilityCheckInput, ReachabilityCheckResult } from './reachability-check.js';

export { createContractedAgentGraph, createAgentExecutionGraph } from './agent-graph-composition.js';
export type { ContractedAgentGraph, ContractedAgentGraphOptions, AgentExecutionGraph, AgentExecutionGraphOptions } from './agent-graph-composition.js';

// Product roots compose these once their actual plans and fleet owners exist.
export { composeContractRunner, resumeContracts } from './contract-composition.js';
export type { ContractRunnerCompositionOptions, ComposedContractRunner, NativeContractCompositionOwner } from './contract-composition.js';
export { fleetCeilingRefusal, makeRuntimeFleetProbe } from './orchestration/fleet-count.js';
export { composeJudgment } from './judgment-services.js';
export { createJudgmentSourceLifetime } from './judgment-source-lifetime.js';
export type { JudgmentServices, JudgmentServicesInput, JudgmentSettingsSource } from './judgment-services.js';

export { createChannelComposition } from './channel-composition.js';
export type { ChannelComposition } from './channel-composition.js';

export { createRemoteExecutionServices } from './remote-execution-composition.js';
export type { RemoteExecutionServices } from './remote-execution-composition.js';

export { wireIdlePowerAndLiveTurn } from './idle-power-services.js';
export type { IdlePowerServices, IdlePowerServicesDeps } from './idle-power-services.js';

// The platform's setup contract: what ANY "set this up" request commits us to.
// Voice is one instance of it; see runtime/setup-contract.ts.
export {
  SETUP_INTENT_CONTRACT_PROMPT,
  renderSetupPlan,
  setupPlanStrings,
  setupStepsOfKind,
} from './setup-contract.js';
export type {
  SetupOption,
  SetupPlan,
  SetupSolutionShape,
  SetupStep,
  SetupStepKind,
} from './setup-contract.js';
export { WAKE_RECOVERY_COMMAND, wireVoiceSetup } from './voice-setup-services.js';
export type { VoiceSetupServices, VoiceSetupServicesDeps } from './voice-setup-services.js';

export { createSessionStorageServices } from './session-storage-services.js';
export type { SessionStorageServices } from './session-storage-services.js';

export {
  CODE_INDEX_ENABLED_CONFIG_KEY,
  CODE_INDEX_MAX_FILE_BYTES,
  CODE_INDEX_MAX_FILES,
  CODE_INDEX_MAX_TOTAL_BYTES,
  codeIndexDbPath,
  createCodeIndexServices,
  isCodeIndexAutoStartEnabled,
  isCodeInjectionSettingEnabled,
} from './code-index-services.js';
export type { CodeIndexServices, CodeIndexServicesDeps } from './code-index-services.js';

export {
  applyProviderOptimizerSettings,
  bindProviderOptimizerConfig,
  readProviderOptimizerSettings,
  type ProviderOptimizerSettings,
} from './provider-optimizer-wiring.js';

export {
  CONTROL_PLANE_FEATURE_FLAG,
  DELIVERY_ENGINE_FEATURE_FLAG,
  enableFeatureFlags,
  getMissingSurfaceFeatureFlags,
  getServerSurfaceFeatureFlags,
  getSurfaceFeatureFlag,
  isFeatureFlagEnabled,
  ROUTE_BINDING_FEATURE_FLAG,
  SERVICE_MANAGEMENT_FEATURE_FLAG,
  surfaceFeatureGateSettingsKeys,
} from './surface-feature-flags.js';

export { WorkspaceRegistrationManager } from './workspace-registration.js';
export type {
  WorkspaceRegistrationEvaluation,
  WorkspaceRegistrationManagerOptions,
  WorkspaceRegistrationShellPaths,
} from './workspace-registration.js';

export {
  detectPriorWorkspaceState,
  readPersistedWorkspaceTrust,
  trustGatedAsk,
  WorkspaceTrustManager,
} from './workspace-trust.js';
export type {
  PersistedWorkspaceTrustView,
  WorkspaceTrustLevel,
  WorkspaceTrustManagerOptions,
  WorkspaceTrustPaths,
} from './workspace-trust.js';

// Headless hosts ask through the shared broker and read explicit record provenance.
export {
  createWorkspaceTrustDecisionAsk,
  trustGatedApprovalRaiser,
  WorkspaceTrustDecisionUnsettledError,
  WORKSPACE_TRUST_ASK_TIMEOUT_MS,
} from './workspace-trust-approval.js';
export type {
  ApprovalRaise,
  ApprovalRaiseExtras,
  TrustGateManager,
  WorkspaceTrustDecisionAskDeps,
} from './workspace-trust-approval.js';

export * from './turn-notification.js';
export type { NotificationPrivacyReader } from './notification-envelope.js';
