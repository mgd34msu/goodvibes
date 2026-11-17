/**
 * Runtime store, Zustand vanilla store for the GoodVibes platform runtime.
 *
 * Uses `createStore` from `zustand/vanilla` (NOT the React `create` hook)
 * because this runtime uses Zustand directly with no React renderer.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';
import type { TurnEvent } from '../../../events/turn.js';
import type { ToolEvent } from '../../../events/tools.js';
import type { GateEvent } from '../../../events/gate.js';
import type { TaskEvent } from '../../../events/tasks.js';
import type { AgentEvent } from '../../../events/agents.js';
import type { ContractEvent } from '../../../events/contract.js';
import type { CommunicationEvent } from '../../../events/communication.js';
import type { PluginEvent } from '../../../events/plugins.js';
import type { McpEvent } from '../../../events/mcp.js';
import type { TransportEvent } from '../../../events/transport.js';
import type { CompactionEvent } from '../../../events/compaction.js';
import type {
  SessionDomainState,
  ConversationDomainState,
  TaskDomainState,
  TaskLifecycleState,
  RuntimeTask,
  AgentDomainState,
  AgentLifecycleState,
  RuntimeAgent,
  PermissionDomainState,
  PermissionDecision,
  ContractDomainState,
  CommunicationDomainState,
  PluginDomainState,
  McpDomainState,
  AcpDomainState,
  DaemonDomainState,
  IntegrationDomainState,
  IntegrationRecord,
  IntegrationStatus,
  AutomationDomainState,
  RoutesDomainState,
  ControlPlaneDomainState,
  ControlPlaneClientRecord,
  DeliveryDomainState,
  WatcherDomainState,
  WatcherRecord,
  SurfaceDomainState,
  SurfaceRecord,
} from './domains/index.js';
import type { AutomationJob } from '../../automation/jobs.js';
import type { AutomationRun } from '../../automation/runs.js';
import type { AutomationRouteBinding } from '../../automation/routes.js';
import type { AutomationSurfaceKind } from '../../automation/types.js';
import type { AutomationDeliveryAttempt } from '../../automation/delivery.js';
import { canRetry } from '../tasks/lifecycle.js';
import { createInitialRuntimeState } from './state.js';
import type { RuntimeState } from './state.js';
import {
  patchControlPlaneDomain,
  syncSessionStatePatch,
  transitionAgentDomainRecord,
  transitionTaskDomainRecord,
  updateAgentState,
  updateAutomationDomainFromJob,
  updateAutomationDomainFromRun,
  removeAutomationDomainJob,
  updateCommunicationState,
  updateConversationState,
  updateControlPlaneDomainFromClient,
  updateDeliveryDomainFromAttempt,
  updateIntegrationDomainFromRecord,
  updateMcpState,
  updateContractsState,
  updatePermissionState,
  updatePluginState,
  updateRouteFailureState,
  updateRoutesDomainFromBinding,
  removeRoutesDomainBinding,
  updateSessionState,
  updateSurfaceDomainFromRecord,
  updateTaskDomainFromRecord,
  updateTaskState,
  updateTransportState,
  updateWatcherDomainFromRecord,
  removeWatcherDomainRecord,
} from './helpers/reducers.js';

export type RuntimeStore = StoreApi<RuntimeState>;

export function createRuntimeStore(): RuntimeStore {
  return createStore<RuntimeState>(() => createInitialRuntimeState());
}

function mutateRuntimeStore(store: RuntimeStore, updater: (state: RuntimeState) => RuntimeState): void {
  store.setState(updater);
}

export interface DomainDispatch {
  dispatchTurnEvent(event: TurnEvent): void;
  /** Forwarded from the `tools` bus domain by the host event bridge; it feeds `conversation.activeToolCalls`. */
  dispatchToolEvent(event: ToolEvent): void;
  dispatchGateEvent(event: GateEvent): void;
  /** @deprecated No production host calls this; the task domain is driven by `syncRuntimeTask`/`transitionRuntimeTask`. */
  dispatchTaskEvent(event: TaskEvent): void;
  dispatchAgentEvent(event: AgentEvent): void;
  dispatchContractEvent(event: ContractEvent): void;
  dispatchCommunicationEvent(event: CommunicationEvent): void;
  /** Forwarded from the `plugins` bus domain by the host event bridge. */
  dispatchPluginEvent(event: PluginEvent): void;
  /** Forwarded from the `mcp` bus domain by the host event bridge; the MCP domain, and MCP health, are driven from it. */
  dispatchMcpEvent(event: McpEvent): void;
  dispatchTransportEvent(event: TransportEvent): void;
  dispatchCompactionEvent(event: CompactionEvent): void;
  syncSessionState(patch: Partial<SessionDomainState>, source?: string): void;
  syncRuntimeTask(task: RuntimeTask, source?: string): void;
  transitionRuntimeTask(
    taskId: string,
    status: TaskLifecycleState,
    patch?: Partial<RuntimeTask>,
    source?: string,
  ): void;
  /** True when the task exists and its status allows an explicit retry (`canRetry`). */
  canRetryRuntimeTask?(taskId: string): boolean;
  transitionRuntimeAgent(
    agentId: string,
    status: AgentLifecycleState,
    patch?: Partial<RuntimeAgent>,
    source?: string,
  ): void;
  syncIntegration(record: IntegrationRecord, source?: string): void;
  /** The job's source comes with it; sources are kept for the jobs and runs the mirror retains. */
  syncAutomationJob(record: AutomationJob, source?: string): void;
  removeAutomationJob(jobId: string, source?: string): void;
  syncAutomationRun(record: AutomationRun, source?: string): void;
  syncRouteBinding(record: AutomationRouteBinding, source?: string): void;
  removeRouteBinding(bindingId: string, source?: string): void;
  recordRouteBindingFailure(
    surfaceKind: AutomationSurfaceKind,
    externalId: string,
    source?: string,
  ): void;
  syncControlPlaneClient(record: ControlPlaneClientRecord, source?: string): void;
  syncControlPlaneState(patch: Partial<ControlPlaneDomainState>, source?: string): void;
  syncDeliveryAttempt(record: AutomationDeliveryAttempt, source?: string): void;
  syncSurface(record: SurfaceRecord, source?: string): void;
  syncWatcher(record: WatcherRecord, source?: string): void;
  removeWatcher(watcherId: string, source?: string): void;
}

export function createDomainDispatch(store: RuntimeStore): DomainDispatch {
  return {
    dispatchTurnEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        conversation: updateConversationState(state.conversation, event),
      }));
    },
    dispatchToolEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        conversation: updateConversationState(state.conversation, event),
      }));
    },
    dispatchGateEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        permissions: updatePermissionState(state.permissions, event),
      }));
    },
    dispatchTaskEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: updateTaskState(state.tasks, event),
      }));
    },
    dispatchAgentEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        agents: updateAgentState(state.agents, event),
      }));
    },
    dispatchContractEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        contracts: updateContractsState(state.contracts, event),
      }));
    },
    dispatchCommunicationEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        communication: updateCommunicationState(state.communication, event),
      }));
    },
    dispatchPluginEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        plugins: updatePluginState(state.plugins, event),
      }));
    },
    dispatchMcpEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        mcp: updateMcpState(state.mcp, event),
      }));
    },
    dispatchTransportEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        ...updateTransportState(state.acp, state.daemon, event),
      }));
    },
    dispatchCompactionEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        session: updateSessionState(state.session, event),
      }));
    },
    syncSessionState(patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        session: syncSessionStatePatch(state.session, patch, source),
      }));
    },
    syncRuntimeTask(task, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: updateTaskDomainFromRecord(state.tasks, task, source),
      }));
    },
    transitionRuntimeTask(taskId, status, patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: transitionTaskDomainRecord(state.tasks, taskId, status, patch, source),
      }));
    },
    canRetryRuntimeTask(taskId) {
      const task = store.getState().tasks.tasks.get(taskId);
      return task !== undefined && canRetry(task.status);
    },
    transitionRuntimeAgent(agentId, status, patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        agents: transitionAgentDomainRecord(state.agents, agentId, status, patch, source),
      }));
    },
    syncIntegration(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        integrations: updateIntegrationDomainFromRecord(state.integrations, record, source),
      }));
    },
    syncAutomationJob(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        automation: updateAutomationDomainFromJob(state.automation, record, source),
      }));
    },
    removeAutomationJob(jobId, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        automation: removeAutomationDomainJob(state.automation, jobId, source),
      }));
    },
    syncAutomationRun(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        automation: updateAutomationDomainFromRun(state.automation, record, source),
      }));
    },
    syncRouteBinding(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        routes: updateRoutesDomainFromBinding(state.routes, record, source),
      }));
    },
    removeRouteBinding(bindingId, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        routes: removeRoutesDomainBinding(state.routes, bindingId, source),
      }));
    },
    recordRouteBindingFailure(surfaceKind, externalId, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        routes: updateRouteFailureState(state.routes, surfaceKind, externalId, source),
      }));
    },
    syncControlPlaneClient(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        controlPlane: updateControlPlaneDomainFromClient(state.controlPlane, record, source),
      }));
    },
    syncControlPlaneState(patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        controlPlane: patchControlPlaneDomain(state.controlPlane, patch, source),
      }));
    },
    syncDeliveryAttempt(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        deliveries: updateDeliveryDomainFromAttempt(state.deliveries, record, source),
      }));
    },
    syncSurface(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        surfaces: updateSurfaceDomainFromRecord(state.surfaces, record, source),
      }));
    },
    removeWatcher(watcherId, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        watchers: removeWatcherDomainRecord(state.watchers, watcherId, source),
      }));
    },
    syncWatcher(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        watchers: updateWatcherDomainFromRecord(state.watchers, record, source),
      }));
    },
  };
}

export type { RuntimeState } from './state.js';
export { createInitialRuntimeState } from './state.js';
export * from './selectors/index.js';
export * from './domains/index.js';
