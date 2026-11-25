import type { ExternalOperationSource } from '../permissions/external-request.js';
import type { SubagentTask } from '../acp/protocol.js';
import type { AgentInput } from '../tools/agent/schema.js';
import type { AgentRecord } from '../tools/agent/manager.js';
import type {
  AutomationJob,
  AutomationRun,
  CreateAutomationJobInput,
  AutomationManager,
} from '../automation/index.js';
import type {
  CancellationRequest,
  CancellationResult,
  CrossSessionTaskRef,
  HandoffWithdrawal,
  SessionTaskGraphSnapshot,
  TaskHandoffRecord,
} from '../sessions/orchestration/index.js';
import type { ExecutionPlan } from '../core/execution-plan.js';
import type { DomainVerbosity } from './notifications/types.js';
import type { HITLMode, HITLModeDefinition } from '../state/mode-manager.js';

export interface ShellAgentManagerService {
  spawn(input: AgentInput): AgentRecord;
  /** Settles once the agent's admitted work, including its cleanup, has finished. */
  join(agentId: string): Promise<void>;
  getStatus(agentId: string): AgentRecord | null;
  cancel(agentId: string): boolean;
  cancelGraph(graphId: string): string[];
  cancelSubtree(rootAgentId: string): string[];
  /** The agents still pending or running; a caller about to replace the records refuses while any are. */
  listActive?(): AgentRecord[];
  clear(): void;
  exportState(): AgentRecord[];
  importState(records: AgentRecord[]): void;
}

export interface ShellAcpManagerService {
  spawn(task: SubagentTask, operation?: ExternalOperationSource): Promise<string>;
  cancel(agentId: string): Promise<void>;
}

export interface ShellAutomationManagerService {
  start(): Promise<void>;
  listJobs(): AutomationJob[];
  createJob(input: CreateAutomationJobInput): Promise<AutomationJob>;
  removeJob(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<AutomationJob | null>;
  runNow(id: string): Promise<AutomationRun>;
}

export type ShellAutomationManagerRuntimeService = ShellAutomationManagerService & AutomationManager;

export interface ShellModeManagerService {
  getHITLMode(): HITLMode;
  getHITLPreset(): HITLModeDefinition;
  listHITLPresets(): HITLModeDefinition[];
  setHITLMode(mode: HITLMode): void;
  setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void;
  getDomainOverrides(): Record<string, DomainVerbosity>;
}

export interface ShellPlanManagerService {
  getActive(sessionId?: string): ExecutionPlan | null;
  getSummary(plan: ExecutionPlan): string;
  list(): ExecutionPlan[];
  toMarkdown(plan: ExecutionPlan): string;
}

export interface ShellSessionOrchestrationService {
  linkTask(ref: CrossSessionTaskRef, dependsOn?: { sessionId: string; taskId: string }): { ok: boolean; error?: string };
  initiateHandoff(
    taskRef: { sessionId: string; taskId: string },
    fromSessionId: string,
    toSessionId: string,
    reason?: string,
  ): { ok: boolean; error?: string; handoffId?: string };
  snapshot(): SessionTaskGraphSnapshot;
  getDependencies(sessionId: string, taskId: string): CrossSessionTaskRef[];
  getDependents(sessionId: string, taskId: string): CrossSessionTaskRef[];
  getHandoffs(): TaskHandoffRecord[];
  /** The destination session accepts a waiting handoff; `true` when it is accepted (already, or now). */
  acknowledgeHandoff(handoffId: string, bySessionId?: string): boolean;
  /** The source session takes back a handoff that is still waiting. */
  withdrawHandoff(handoffId: string, bySessionId?: string): HandoffWithdrawal;
  cancel(request: CancellationRequest): CancellationResult;
}

/** The remote runners are the daemon's (runtime/remote/daemon-runners.ts), read through `remote.*`: a program keeps none. */
export interface CommandOpsShellServices {
  readonly agentManager?: ShellAgentManagerService | undefined;
  readonly acpManager?: ShellAcpManagerService | undefined;
  readonly automationManager?: ShellAutomationManagerRuntimeService | undefined;
  readonly modeManager?: ShellModeManagerService | undefined;
  readonly planManager?: ShellPlanManagerService | undefined;
  readonly sessionOrchestration?: ShellSessionOrchestrationService | undefined;
}
