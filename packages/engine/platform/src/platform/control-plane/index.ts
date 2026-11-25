export type {
  ControlPlaneStreamingMode,
  ControlPlaneClientSurface,
  ControlPlaneServerConfig,
  ControlPlaneClientDescriptor,
  ControlPlaneEventSubscription,
} from './types.js';
export type { ControlPlaneGatewayConfig, ControlPlaneEventStreamOptions, ControlPlaneRecentEvent } from './gateway.js';
export { ControlPlaneGateway } from './gateway.js';
export { DEFAULT_DOMAINS, RENDER_GRADE_SESSION_DOMAINS } from './gateway-utils.js';
export { SSE_HEARTBEAT_INTERVAL_MS, sseIdleTimeoutSeconds } from './sse-timing.js';
export {
  CLIENT_COMPATIBILITY_FLOOR,
  CLIENT_COMPATIBILITY_FLOOR_HEADER,
  compareBuildVersions,
  evaluateClientCompatibility,
  readClientCompatibilityFloor,
} from './client-compatibility.js';
export type { ClientCompatibilityStatus, ClientCompatibilityVerdict } from './client-compatibility.js';
export {
  evaluateDaemonCompatibility,
  evaluateDaemonStatusCompatibility,
  readDaemonVersion,
} from './daemon-compatibility.js';
export type { DaemonCompatibilityStatus, DaemonCompatibilityVerdict } from './daemon-compatibility.js';
export {
  GatewayMethodCatalog,
  grantedGatewayScopes,
} from './method-catalog.js';
export type {
  GatewayScopePolicyOwner,
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayEventTransport,
  GatewayHttpBinding,
  GatewayMethodAccess,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodListOptions,
  GatewayMethodSource,
  GatewayMethodTransport,
} from './method-catalog.js';
export type {
  CreateSharedSessionInput,
  EnsureSharedSessionInput,
  FindSharedSessionOptions,
  ListSharedSessionsOptions,
  ParticipantRouteAttachInput,
  RegisterSharedSessionInput,
  SharedSessionRegisterResult,
  SharedSessionKind,
  SharedSessionMessage,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionStatus,
  SharedSessionSubmission,
  SharedSessionSubmissionReceipt,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
export type {
  SharedSessionAgentSpawnRoutingInput,
  SharedSessionCompletion,
  SharedSessionContinuationRequest,
  SharedSessionContinuationResult,
  SharedSessionContinuationOutcome,
  // The runner shape a host binds into the dispatch seam. Nine of its siblings
  // were already public and this one was not, so a client naming the seam it
  // implements had to re-declare the runner structurally instead of importing it.
  SharedSessionContinuationRunner,
  SharedSessionHelperModelOverride,
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionInputState,
  SharedSessionRoutingIntent,
} from './session-intents.js';
// The one shared normalizer from a session's routing intent to an agent-spawn
// routing input, public so every surface derives spawn routing identically
// instead of re-implementing the model/provider/fallback rules.
export { buildSharedSessionAgentSpawnRoutingInput } from './session-intents.js';
// Surface-presence check plus the freshness window the daemon itself applies:
// lets a consumer compose the same "is a live surface attached?" answer the
// broker uses for steer/follow-up routing.
export { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS } from './session-broker-sessions.js';
export { SharedSessionBroker } from './session-broker.js';
export {
  discoverLegacySessionSources,
  importLegacySessionStores,
} from './session-store-importer.js';
export type {
  LegacySessionSource,
  ImportLegacySessionsResult,
} from './session-store-importer.js';
// The one resolver every control-plane store file path goes through, the
// surface segment is mandatory, never a silent default (see the file header).
export { controlPlaneStorePath } from './control-plane-store-paths.js';
export type { ControlPlaneStorePathShellPaths } from './control-plane-store-paths.js';
export type {
  SharedApprovalRecord,
  SharedApprovalAuditRecord,
  SharedApprovalStatus,
  RequestSharedApprovalInput,
  ApprovalActionInput,
} from './approval-broker.js';
export { ApprovalBroker, LOCAL_APPROVAL_NODE } from './approval-broker.js';
export type { ApprovalRelayPort } from './approval-broker.js';
export { ApprovalRelay, APPROVAL_RELAY_TYPES, type ApprovalSummary, type RelayPrincipal } from './approval-relay.js';
export {
  approvalLifecycle,
  readApproval,
  formatApprovalRef,
  parseApprovalRef,
  isOpenApprovalStatus,
} from './approval-lifecycle.js';
export type {
  ApprovalAction,
  ApprovalActor,
  ApprovalCause,
  ApprovalHold,
  ApprovalNextMove,
  ApprovalReading,
  ApprovalReason,
  ApprovalReceiptState,
  ApprovalRef,
  ApprovalRefusalCode,
  ApprovalRequester,
  ApprovalTransition,
  ApprovalViewer,
  TransitionOutcome,
  TransitionRequest,
} from './approval-lifecycle.js';
export {
  OWNER_ANSWER_AGENT_METADATA,
  OWNER_ANSWER_SESSION_METADATA,
  OWNER_ASKER_HOST_METADATA,
  OWNER_ASKER_SESSION_FILE_METADATA,
  OWNER_ITEM_KINDS,
  OWNER_ITEM_LIMITS,
  OwnerInbox,
  OwnerInboxInputError,
  answerAgentOf,
  answerSessionOf,
  askerOf,
  createOwnerInbox,
  handleOwnerDecisions,
  isOwnerDecisionHandledHere,
  listEveryOwnerItem,
  listEveryOwnerItemReport,
  ownerInboxCursorOf,
  questionClosedText,
  readOwnerAnswerDelivery,
  readOwnerItem,
  validateNewOwnerItem,
} from './owner-inbox.js';
export type {
  NewOwnerItem,
  OwnerAnswer,
  OwnerAnswerDelivery,
  OwnerAnswerDeliveryReport,
  OwnerAnswerDeliveryState,
  OwnerAnswerOutcome,
  OwnerAnswerReader,
  OwnerAnswerSource,
  OwnerAsker,
  OwnerAskerPresence,
  OwnerAskerPresenceProbe,
  OwnerDecisionHandler,
  OwnerInboxApprovalSource,
  OwnerInboxListFilter,
  OwnerInboxListener,
  OwnerInboxOptions,
  OwnerInboxPage,
  OwnerInboxPort,
  OwnerInboxListReport,
  OwnerItem,
  OwnerItemKind,
  OwnerItemStatus,
  OwnerPostOutcome,
} from './owner-inbox.js';
export { QuestionStore, ownerInboxStorePath, sharedQuestionStore } from './question-store.js';
export { terminalSessionPresence } from './owner-session-presence.js';
export { askerLivenessPath, holdAskerRunning, isAskerRunning, settleAskerLock } from './owner-asker-liveness.js';
export type { OwnerAskerKind } from './owner-asker-liveness.js';
export type { QuestionAskerScope, StoredAnswerDelivery, StoredOwnerEntry, StoredOwnerItem, StoredOwnerItemKind } from './question-store.js';
export { registerOwnerInboxGatewayMethods } from './routes/owner-inbox.js';
export { registerNotificationDeadLetterGatewayMethods, listNotificationDeadLetters, replayNotificationDeadLetters } from './routes/notification-dead-letters.js';
export type { NotificationDeadLetterSources } from './routes/notification-dead-letters.js';
export { registerFlagsStatusGatewayMethods } from './routes/flags-status.js';
export { registerAuthorityStatusGatewayMethods, type AuthorityStatusPeers } from './routes/authority-status.js';
export type { OwnerInboxGatewayService } from './routes/owner-inbox.js';
export { SHARED_APPROVAL_DISPOSITIONS } from './approval-disposition.js';
export type { SharedApprovalDisposition, SharedApprovalDecision, ExplicitApprovalDisposition } from './approval-disposition.js';
export {
  buildModifiedEditArgs,
  readApprovalEditHunks,
  resolveApprovalHunkSelection,
} from './approval-hunk-apply.js';
export type { EditHunkLike, ApprovalHunkSelectionResolution } from './approval-hunk-apply.js';
export type { ControlPlaneAuthMode, ControlPlaneAuthSnapshot } from '../../client-auth/control-plane-auth-snapshot.js';
export type { MessageSource, ConversationMessageEnvelope } from './conversation-message.js';
export { buildOperatorContract } from './operator-contract.js';
export { dispatchDaemonApiRoutes } from './routes/index.js';
export {
  ARTIFACT_ACQUISITION_MODE_SCHEMA,
  ARTIFACT_FETCH_MODE_SCHEMA,
} from './media-contract-schemas.js';
export {
  ARTIFACT_ATTACHMENT_SCHEMA,
  ARTIFACT_DESCRIPTOR_SCHEMA,
} from './operator-contract-schemas-shared.js';
export {
  AUTOMATION_RUN_SCHEMA,
  ROUTE_BINDING_SCHEMA,
} from './operator-contract-schemas-admin.js';
export {
  SHARED_SESSION_INPUT_RECORD_SCHEMA,
  SHARED_SESSION_ROUTING_INTENT_SCHEMA,
} from './operator-contract-schemas-runtime.js';
export {
  KNOWLEDGE_INJECTION_PROMPT_SCHEMA,
  KNOWLEDGE_INJECTION_SCHEMA,
} from './operator-contract-schemas-knowledge.js';
// fleet.*/checkpoints.*/sessions.search verb registration (see routes/register-fleet-checkpoints-search.ts).
export { registerFleetCheckpointsSearchGatewayMethods } from './routes/register-fleet-checkpoints-search.js';
// The single verb-group registrar the runtime-services composition root calls:
// folds in the fleet/checkpoints group above and constructs + wires the
// browser-push group (see routes/register-gateway-verb-groups.ts).
export { registerGatewayVerbGroups } from './routes/register-gateway-verb-groups.js';
export type { GatewayVerbGroupDeps } from './routes/register-gateway-verb-groups.js';
// Live-turn controls holder: an interactive consumer binds its Orchestrator so
// sessions.toolCalls.cancel / sessions.queuedMessages.* act on the live runtime.
export { SessionLiveTurnControlsHolder, createSessionRuntimeControls } from './routes/session-runtime.js';
export type {
  SessionContextUsage,
  SessionLiveTurnControls,
  SessionRuntimeControls,
} from './routes/session-runtime.js';
// The hosted-session verb group: a product composing its own catalog attaches
// these the way it attaches every other handler-registered group.
export { registerHostedSessionGatewayMethods } from './routes/hosted-sessions.js';
export type { HostedSessionVerbService } from './routes/hosted-sessions.js';
// skills.* CRUD verb registration over the canonical SkillService (see routes/skills.ts).
export { registerDevicesGatewayMethods } from './routes/devices.js';
export type { DevicesGatewayService } from './routes/devices.js';
// Conversation-scope rewind served by the surface hosting the conversation
// (see routes/rewind-conversation-hosts.ts).
export {
  createConversationRewindHostBroker,
  registerRewindConversationHostGatewayMethods,
} from './routes/rewind-conversation-hosts.js';
export { registerSkillsGatewayMethods } from './routes/skills.js';
export type { SkillsGatewayService } from './routes/skills.js';

// The checkout seam: what `GatewayVerbGroupDeps.onBrowserCheckout` hands a
// composition so it can construct a PaymentsGatewayServiceImpl over the SAME
// browser engine the `browser.*` verbs drive, holding the SAME card-material
// guard the engine scrubs against (see routes/browser-composition.ts).
export { browserGatewayOverEngine, composeDaemonBrowser, createDaemonBrowserGatewayService } from './routes/browser-composition.js';
export type {
  BrowserCheckoutSeam,
  BrowserCompositionDeps,
  DaemonBrowserGatewayService,
} from './routes/browser-composition.js';

export type {
  PaymentsGatewayService,
  PaymentPurchaseView,
  PaymentsBudgetView,
  PaymentCardView,
} from './routes/payments.js';

// Shared host handler binding, including explicit-user confirmation semantics.
export * from './host-handlers.js';

export { registerWorkLedgerGatewayMethods } from './routes/work-ledger.js';
export { registerNativeWorkExecutionGatewayMethods } from './routes/native-work-execution.js';
export { registerWorkGatewayMethods, type WorkItemView, type WorkRunView, type WorkState, type WorkStepView, type WorkQuestionView } from './routes/work.js';
export { registerNativeWorkSubmissionGatewayMethods } from './routes/native-work-submission.js';

export { registerWorkLedgerImportGatewayMethods } from './routes/work-ledger-import.js';

export { registerNativeConversationIntakeGatewayMethods } from './routes/native-intake.js';

export { createNativeInboundSourceOwner, NativeInboundSourceError, sameNativeInboundSourceRef } from './native-inbound-source.js';
export type { NativeInboundBrokerIdentity, NativeInboundSourceRef, NativeInboundOrigin, NativeInboundOriginal, NativeInboundSourceHandle, NativeInboundResolvedSource, NativeInboundSourceResolver } from './native-inbound-source.js';

export { createNativeInboundHandoff, NativeInboundReceiverRefusal } from './native-inbound-handoff.js';
export type { NativeMutationHost } from './native-mutation.js';
export { NATIVELY_ADMITTED_METHOD_IDS } from './native-admission-methods.js';
export { captureOccasionsGatewayTarget } from './routes/native-profile-mutation.js';
export { registerNativeAutomationGatewayMethods } from '../daemon/http/native-automation.js';
// The one admission check of a cataloged call and the grant a pairing token holds, for a call made in-process on a paired caller's behalf.
export { pairingTokenCaller, refuseGatewayInvocation } from '../daemon/http/gateway-binding-gate.js';
export type { NativeInboundDisposition, NativeInboundAcceptance, NativeInboundProcessingOwner, NativeInboundReceiver } from './native-inbound-handoff.js';
export type { DelegatedSessionInputBinding, DelegatedSessionTransferReceipt, DelegatedSessionSubmission } from './session-broker-delegated.js';
export type { OwnerApprovalGuard, RaisedOwnerApproval, ResolveOwnerApprovalInput, ResolveSharedApprovalInput } from './approval-broker-owner.js';

export { prepareGatewayScopePolicyOwner, completeGatewayScopePolicyBootstrap, waitForGatewayScopePolicyBootstrap } from './scope-policy-bootstrap.js';
export { composeOccasions } from './routes/occasions-composition.js';
export type { OccasionsComposition, OccasionsCompositionDeps } from './routes/occasions-composition.js';

export { registerTriggerSupervisorGatewayMethods } from './routes/trigger-supervisor.js';
