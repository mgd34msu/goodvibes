/**
 * Barrel export for all runtime store domain types and initial state factories.
 */

export type {
  SessionRecoveryState,
  SessionStatus,
  SessionLineageEntry,
  SessionDomainState,
} from './session.js';
export { createInitialSessionState } from './session.js';

export type {
  TurnState,
  ToolExecutionState,
  ActiveToolCall,
  TurnUsage,
  StreamProgress,
  ConversationDomainState,
} from './conversation.js';
export { createInitialConversationState } from './conversation.js';

export type {
  PermissionMode,
  PermissionDecisionMachineState,
  PermissionDecisionOutcome,
  PermissionSourceLayer,
  PermissionDecisionReason,
  PermissionDecision,
  PermissionDomainState,
} from './permissions.js';
export { createInitialPermissionsState } from './permissions.js';

export type {
  TaskLifecycleState,
  TaskKind,
  TaskRetryPolicy,
  RuntimeTask,
  TaskDomainState,
} from './tasks.js';
export { createInitialTasksState } from './tasks.js';

export type {
  AgentLifecycleState,
  AgentContractRef,
  RuntimeAgent,
  AgentDomainState,
} from './agents.js';
export { createInitialAgentsState } from './agents.js';

export type {
  ContractCriterionRecord,
  ContractUnitRecord,
  ContractGroupRecord,
  ContractEscalationRecord,
  ContractRecord,
  ContractGateRecord,
  ContractDomainState,
} from './contracts.js';
export { createInitialContractsState } from './contracts.js';

export type {
  RuntimeCommunicationRecord,
  CommunicationDomainState,
} from './communication.js';
export { createInitialCommunicationState } from './communication.js';

export type {
  McpServerLifecycleState,
  McpServerRecord,
  McpDomainState,
} from './mcp.js';
export { createInitialMcpState } from './mcp.js';

export type {
  DaemonTransportState,
  DaemonDomainState,
} from './daemon.js';
export { createInitialDaemonState } from './daemon.js';

export type {
  AutomationDomainState,
} from './automation.js';
export { createInitialAutomationState } from './automation.js';

export type {
  RoutesDomainState,
} from './routes.js';
export { createInitialRoutesState } from './routes.js';

export type {
  ControlPlaneClientKind,
  ControlPlaneTransportKind,
  ControlPlaneConnectionState,
  ControlPlaneClientRecord,
  ControlPlaneDomainState,
} from './control-plane.js';
export { createInitialControlPlaneState } from './control-plane.js';

export type {
  DeliveryDomainState,
  RetiredAttemptCounts,
} from './deliveries.js';
export { createInitialDeliveryState } from './deliveries.js';

export type {
  WatcherKind,
  WatcherState,
  WatcherSourceStatus,
  WatcherRecord,
  WatcherDomainState,
} from './watchers.js';
export { createInitialWatcherState } from './watchers.js';

export type {
  SurfaceConnectionState,
  SurfaceRecord,
  SurfaceDomainState,
} from './surfaces.js';
export { createInitialSurfaceState } from './surfaces.js';

export type {
  AcpTransportState,
  AcpConnection,
  AcpDomainState,
} from './acp.js';
export { createInitialAcpState } from './acp.js';

export type {
  IntegrationStatus,
  IntegrationCategory,
  IntegrationRecord,
  IntegrationDomainState,
} from './integrations.js';
export { createInitialIntegrationsState } from './integrations.js';
