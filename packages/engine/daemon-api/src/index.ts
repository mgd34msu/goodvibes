export type {
  MaybeResponse,
  DaemonApiRouteHandlers,
  DaemonRemoteDispatchRouteHandlers,
  DaemonOperatorRouteHandlers,
  DaemonAutomationRouteHandlers,
  DaemonSessionRouteHandlers,
  DaemonTaskRouteHandlers,
  DaemonControlRouteHandlers,
  DaemonTelemetryRouteHandlers,
  DaemonChannelRouteHandlers,
  DaemonIntegrationRouteHandlers,
  DaemonSystemRouteHandlers,
  DaemonRemoteManagementRouteHandlers,
  DaemonKnowledgeRouteHandlers,
  DaemonKnowledgeRefinementRouteHandlers,
  DaemonMediaRouteHandlers,
  DaemonRuntimeSessionRouteHandlers,
  DaemonRuntimeAutomationRouteHandlers,
  DaemonRuntimeRouteHandlers,
  DaemonGatewayRestRouteHandlers,
  GatewayRestVerbInvocation,
  GatewayRestVerbMatch,
} from './context.js';
export { dispatchAutomationRoutes } from './automation.js';
export { dispatchSessionRoutes } from './sessions.js';
export { dispatchTaskRoutes } from './tasks.js';
export { dispatchOperatorRoutes } from './operator.js';
export { dispatchRemoteRoutes } from './remote.js';
export { dispatchDaemonApiRoutes } from './api-router.js';
export type { DaemonApiRouteExtension } from './api-router.js';
export { dispatchGatewayRestRoutes } from './gateway-rest-routes.js';
export {
  principalHasScope,
  resolveAuthenticatedPrincipal,
  resolvePrivateHostFetchOptions,
} from './http-policy.js';
export type { AuthenticatedPrincipal, AuthenticatedPrincipalKind, AuthenticatedPrincipalResolver, CredentialKind, ElevatedPrivateHostFetchConfig, PrivateHostFetchConfig, RequestContext, RequestPrincipal } from './http-policy.js';
export {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  isJsonRecord,
  missingScopes,
  readBoundedBodyInteger,
  readBoundedInteger,
  readBoundedPositiveInteger,
  readChannelConversationKind,
  readChannelLifecycleAction,
  readOptionalBoundedInteger,
  readOptionalStringField,
  readStringArrayField,
  scopeMatches,
} from './route-helpers.js';
export type {
  BoundedIntegerOptions,
  ChannelConversationKind,
  ChannelLifecycleAction,
  JsonBody,
  JsonRecord,
  RouteBodySchema,
} from './route-helpers.js';
export type {
  ChannelActionOutcomeLike,
  ChannelActionRefusalLike,
  ChannelAgentToolDefinitionLike,
  ChannelAllowlistInput,
  ChannelAuthorizeActionInput,
  ChannelDirectoryQuery,
  ChannelDirectoryScope,
  ChannelPluginServiceLike,
  ChannelPolicyServiceLike,
  ChannelSurface,
  ChannelTargetResolutionInput,
  DaemonChannelRouteContext,
  InboundMailHealthLike,
  SurfaceRegistryLike,
} from './channel-route-types.js';
export type {
  ChannelAccountRegistryLike,
  DaemonIntegrationRouteContext,
  IntegrationHelperServiceLike,
  IntegrationRuntimeStoreLike,
  MemoryEmbeddingRegistryLike,
  MemoryRegistryLike,
  MemoryBundleInput,
  MemoryLinkInput,
  MemoryProvenanceLinkInput,
  MemoryRecordAddInput,
  MemoryRecordReviewInput,
  MemoryRecordSearchFilterInput,
  MemoryRecordUpdateInput,
  ProviderRuntimeSnapshotServiceLike,
  RuntimeEventDomain as DaemonRuntimeEventDomain,
  UserAuthManagerLike,
} from './integration-route-types.js';
export { APPROVAL_REMEMBER_TIERS } from './system-route-types.js';
export type {
  ApprovalBrokerLike,
  ApprovalRememberTier,
  AutomationDeliveryGuarantee,
  AutomationRouteBindingKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
  ConfigManagerLike as DaemonSystemConfigManagerLike,
  CredentialStatusProviderLike,
  CredentialStatusRecord,
  DaemonApiClientKind,
  DaemonSystemRouteContext,
  IntegrationApprovalSnapshotSourceLike,
  PlatformServiceManagerLike,
  RouteBindingManagerLike,
  RouteBindingPatchInput,
  RouteBindingRecordInput,
  RouteBindingSurfaceKind,
  WatcherKind,
  WatcherRecord,
  WatcherRegistration,
  WatcherRegistryLike,
  WatcherSnapshotSaveFailure,
  WatcherSourceKind,
  WatcherSourceRecord,
  WorkspaceSwapManagerLike,
} from './system-route-types.js';
export type {
  AuthenticatedPrincipalLike,
  AutomationScheduleDefinition,
  DaemonKnowledgeRouteContext,
  KnowledgeGraphqlAccessLike,
  KnowledgeGraphqlResultLike,
  KnowledgeGraphqlServiceLike,
  KnowledgeAnswerMode,
  KnowledgeArtifactIngestRequest,
  KnowledgeAskRequest,
  KnowledgeBrowserKind,
  KnowledgeBrowserSourceKind,
  KnowledgeBrowserSyncRequest,
  KnowledgeCandidateDecisionRequest,
  KnowledgeConnectorIngestRequest,
  KnowledgeFileImportRequest,
  KnowledgeIngestCommon,
  KnowledgeIssueReviewRequest,
  KnowledgeJobRunMode,
  KnowledgeJobRunRequest,
  KnowledgeListingQuery,
  KnowledgeListingResult,
  KnowledgeMapQuery,
  KnowledgePacketDetail,
  KnowledgePacketOptions,
  KnowledgeProjectionMaterializeRequest,
  KnowledgeProjectionRequest,
  KnowledgeProjectionTargetKind,
  KnowledgeRefinementRunRequest,
  KnowledgeRefinementTaskFilter,
  KnowledgeReviewAction,
  KnowledgeScheduleRequest,
  KnowledgeScopeReadOptions,
  KnowledgeSearchRequest,
  KnowledgeServiceLike,
  KnowledgeSpaceScope,
  KnowledgeSubjectKind,
  KnowledgeUrlIngestRequest,
} from './knowledge-route-types.js';
export type {
  ArtifactKind,
  ArtifactStoreLike,
  DaemonMediaRouteContext,
  FetchExtractMode,
  MediaAnalysisInput,
  MediaArtifact,
  MediaGenerationInput,
  MediaProviderLike,
  MediaProviderRegistryLike,
  MediaTransformInput,
  MultimodalAnalysisInput,
  MultimodalAnalysisResult,
  MultimodalArtifactInput,
  MultimodalDetail,
  MultimodalServiceLike,
  MultimodalWritebackInput,
  VoiceAudioArtifact,
  VoiceRealtimeSessionInput,
  VoiceServiceLike,
  VoiceSynthesisInput,
  VoiceSynthesisStreamLike,
  VoiceTranscriptionInput,
  WebSearchInput,
  WebSearchSafeSearch,
  WebSearchServiceLike,
  WebSearchTimeRange,
  WebSearchVerbosity,
} from './media-route-types.js';
export {
  createArtifactFromUploadRequest,
  isArtifactUploadRequest,
  isJsonContentType,
} from './artifact-upload.js';
export type {
  ArtifactAcquisitionMode,
  ArtifactCreateRequest,
  ArtifactFetchMode,
  ArtifactStoreUploadLike,
  ArtifactStreamCreateRequest,
  ArtifactUploadFieldMap,
  ArtifactUploadResult,
} from './artifact-upload.js';
export { createDaemonControlRouteHandlers } from './control-routes.js';
export { createDaemonTelemetryRouteHandlers } from './telemetry-routes.js';
export { decodeOtlpProtobuf } from './otlp-protobuf.js';
export type { OtlpProtobufKind } from './otlp-protobuf.js';
export { createDaemonChannelRouteHandlers } from './channel-routes.js';
export { createDaemonIntegrationRouteHandlers } from './integration-routes.js';
export { createDaemonSystemRouteHandlers } from './system-routes.js';
export { createDaemonKnowledgeRouteHandlers } from './knowledge-routes.js';
export { createDaemonKnowledgeRefinementRouteHandlers } from './knowledge-refinement-routes.js';
export { createDaemonMediaRouteHandlers } from './media-routes.js';
export type {
  ConversationMessageEnvelope,
  DaemonRuntimeRouteContext,
  ExecutionIntent,
  RouteBindingRecordLike,
  SessionInputState,
  SessionKind,
  SessionParticipantInput,
  SessionSurfaceKind,
  SharedSessionRoutingIntent,
} from './runtime-route-types.js';
export { createDaemonRuntimeAutomationRouteHandlers } from './runtime-automation-routes.js';
export { createDaemonRuntimeSessionRouteHandlers } from './runtime-session-routes.js';
export { createDaemonRuntimeRouteHandlers } from './runtime-routes.js';
export {
  createDaemonRemoteRouteHandlers,
  handleRemotePairRequest,
  handleRemotePairVerify,
  handleRemotePeerHeartbeat,
  handleRemotePeerWorkPull,
  handleRemotePeerWorkComplete,
  matchPeerRoute,
  type PeerRouteId,
  type PeerRouteMatch,
} from './remote-routes.js';
export { buildErrorResponseBody, jsonErrorResponse, readErrorResponseBody, readJsonErrorResponse, summarizeErrorForRecord } from './error-response.js';
export {
  decodeCursor,
  encodeCursor,
  hasPaginationParams,
  paginateItems,
} from './pagination.js';
export type { PaginatedResponse } from './pagination.js';
export type { JsonErrorResponseOptions } from './error-response.js';
export {
  AddressRateLimiter,
  RelayHub,
  RelayConnection,
  DEFAULT_RELAY_LIMITS,
} from './relay-server.js';
export type {
  RelayServerSocket,
  RelayServerLogger,
  RelayServerLimits,
} from './relay-server.js';
export { createBunRelayServer } from './relay-server-entry.js';
export type { BunRelayServerOptions } from './relay-server-entry.js';
export { createRelayDaemonRegistration, RELAY_VIA_HEADER, isRelayTunneledRequest } from './relay-registration.js';
export type {
  RelayDaemonRegistration,
  RelayDaemonRegistrationOptions,
  RelayRegistrationRefusal,
  RelayRegistrationStats,
  RelayRegistrationStatus,
  RelayRegistrationLogger,
  RelayClientWebSocket,
} from './relay-registration.js';
export * from './browser-judgment-contract.js';
export * from './browser-code-languages.js';
export * from './browser-judgment-validation.js';
export * from './browser-judgment-routes.js';

export { createSettingsPreconditionHandler } from './settings-precondition.js';
export type { SettingsPreconditionRequest, SettingsPreconditionFacts, SettingsPreconditionReceipt, SettingsPreconditionHandler } from './settings-precondition.js';
export { createSettingsImportPreconditionHandler } from './settings-import-precondition.js';
export type { SettingsImportPreconditionRequest, SettingsImportPreconditionFacts, SettingsImportPreconditionReceipt, SettingsImportPreconditionHandler } from './settings-import-precondition.js';
