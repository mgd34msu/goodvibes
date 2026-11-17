/**
 * RuntimeState, the canonical top-level state shape for the GoodVibes
 * runtime store. All domain slices are defined here, and each has a writer
 * in `createDomainDispatch`: a fact with another owner (provider health, code
 * intelligence, the active model, trace export) is read from that owner.
 *
 * Each domain includes revision, lastUpdatedAt, and source metadata fields.
 * These are defined per-domain in the domain files.
 */

import type { SessionDomainState } from './domains/session.js';
import type { ConversationDomainState } from './domains/conversation.js';
import type { PermissionDomainState } from './domains/permissions.js';
import type { TaskDomainState } from './domains/tasks.js';
import type { AgentDomainState } from './domains/agents.js';
import type { ContractDomainState } from './domains/contracts.js';
import type { CommunicationDomainState } from './domains/communication.js';
import type { McpDomainState } from './domains/mcp.js';
import type { DaemonDomainState } from './domains/daemon.js';
import type { AutomationDomainState } from './domains/automation.js';
import type { AcpDomainState } from './domains/acp.js';
import type { RoutesDomainState } from './domains/routes.js';
import type { ControlPlaneDomainState } from './domains/control-plane.js';
import type { DeliveryDomainState } from './domains/deliveries.js';
import type { WatcherDomainState } from './domains/watchers.js';
import type { SurfaceDomainState } from './domains/surfaces.js';
import type { IntegrationDomainState } from './domains/integrations.js';

import { createInitialSessionState } from './domains/session.js';
import { createInitialConversationState } from './domains/conversation.js';
import { createInitialPermissionsState } from './domains/permissions.js';
import { createInitialTasksState } from './domains/tasks.js';
import { createInitialAgentsState } from './domains/agents.js';
import { createInitialContractsState } from './domains/contracts.js';
import { createInitialCommunicationState } from './domains/communication.js';
import { createInitialMcpState } from './domains/mcp.js';
import { createInitialDaemonState } from './domains/daemon.js';
import { createInitialAutomationState } from './domains/automation.js';
import { createInitialAcpState } from './domains/acp.js';
import { createInitialRoutesState } from './domains/routes.js';
import { createInitialControlPlaneState } from './domains/control-plane.js';
import { createInitialDeliveryState } from './domains/deliveries.js';
import { createInitialWatcherState } from './domains/watchers.js';
import { createInitialSurfaceState } from './domains/surfaces.js';
import { createInitialIntegrationsState } from './domains/integrations.js';

/**
 * RuntimeState, the complete state shape managed by the runtime store.
 *
 * Domain slices, each with revision/lastUpdatedAt/source metadata.
 * All mutations must go through typed domain dispatch APIs.
 */
export interface RuntimeState {
  session: SessionDomainState;
  conversation: ConversationDomainState;
  permissions: PermissionDomainState;
  tasks: TaskDomainState;
  agents: AgentDomainState;
  contracts: ContractDomainState;
  communication: CommunicationDomainState;
  mcp: McpDomainState;
  daemon: DaemonDomainState;
  automation: AutomationDomainState;
  routes: RoutesDomainState;
  controlPlane: ControlPlaneDomainState;
  deliveries: DeliveryDomainState;
  watchers: WatcherDomainState;
  surfaces: SurfaceDomainState;
  acp: AcpDomainState;
  integrations: IntegrationDomainState;
}

/**
 * Creates and returns a fully initialized RuntimeState with all domains
 * set to their default initial values.
 *
 * This is the factory used by `createRuntimeStore()` and test harnesses.
 */
export function createInitialRuntimeState(): RuntimeState {
  return {
    session: createInitialSessionState(),
    conversation: createInitialConversationState(),
    permissions: createInitialPermissionsState(),
    tasks: createInitialTasksState(),
    agents: createInitialAgentsState(),
    contracts: createInitialContractsState(),
    communication: createInitialCommunicationState(),
    mcp: createInitialMcpState(),
    daemon: createInitialDaemonState(),
    automation: createInitialAutomationState(),
    routes: createInitialRoutesState(),
    controlPlane: createInitialControlPlaneState(),
    deliveries: createInitialDeliveryState(),
    watchers: createInitialWatcherState(),
    surfaces: createInitialSurfaceState(),
    acp: createInitialAcpState(),
    integrations: createInitialIntegrationsState(),
  };
}
