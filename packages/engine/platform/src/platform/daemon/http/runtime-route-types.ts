import type { DaemonRuntimeRouteHandlers } from '@goodvibes/engine/daemon-api';
import type { DaemonRuntimeRouteContext as PlatformDaemonRuntimeRouteContext, JsonBody } from '@goodvibes/engine/daemon-api';
import type {
  AutomationScheduleDefinition,
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
} from '../../automation/index.js';
import type { AgentRecordLike as DaemonApiAgentRecordLike } from '@goodvibes/engine/daemon-api/runtime-route-types';
import type { AgentManager } from '../../tools/agent/index.js';
// The local Like-view types below describe the minimal route handler inputs
// accepted by daemon-api handlers. They stay narrow so callers can provide
// lightweight records instead of full runtime objects.
interface AutomationRouteBinding {
  readonly id?: string | undefined;
}
/** The agent record as the task routes read it: its status and how it was started (a retry starts the same work again). */
type AgentRecordLike = DaemonApiAgentRecordLike;
type AutomationJobLike = { readonly id: string };
type AutomationRunLike = {
  readonly id: string;
  readonly jobId: string;
  readonly agentId?: string | undefined;
  readonly status: string;
  readonly startedAt?: number | undefined;

  readonly endedAt?: number | undefined;
  readonly queuedAt: number;
  readonly continuationMode?: string | undefined;
};
interface RuntimeTaskLike {
  readonly kind?: string | undefined;
  readonly owner?: string | undefined;
  readonly description?: string | undefined;
  readonly title?: string | undefined;
}
interface RuntimeTaskStateLike {
  readonly tasks: Map<string, RuntimeTaskLike>;
}

export interface DaemonRuntimeRouteContext extends Omit<
  PlatformDaemonRuntimeRouteContext,
  'automationManager' | 'normalizeAtSchedule' | 'normalizeEverySchedule' | 'normalizeCronSchedule' | 'trySpawnAgent'
> {
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonBody | null | Response>;
  readonly recordApiResponse: (req: Request, path: string, response: Response) => Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly agentManager: {
    getStatus(agentId: string): AgentRecordLike | null;
    cancel(agentId: string): void;
  };
  /** Adapts the canonical automation manager with parsed create/update inputs.
   * Other methods retain the canonical signatures.
   */
  readonly automationManager: {
    listJobs(): AutomationJobLike[];
    listRuns(): AutomationRunLike[];
    getRun(runId: string): AutomationRunLike | null | undefined;
    triggerHeartbeat(input: { source: string }): Promise<unknown>;
    listHeartbeatWakes?(): readonly unknown[];
    cancelRun(runId: string, reason: string): Promise<unknown | null>;
    retryRun(runId: string): Promise<unknown>;
    createJob(input: CreateAutomationJobInput): Promise<AutomationJobLike>;
    updateJob(jobId: string, input: UpdateAutomationJobInput): Promise<AutomationJobLike | null>;
    removeJob(jobId: string): Promise<void>;
    setEnabled(jobId: string, enabled: boolean): Promise<AutomationJobLike | null>;
    runNow(jobId: string): Promise<{ id: string; agentId?: string; status: string }>;
    getSchedulerCapacity(): { slotsTotal: number; slotsInUse: number; queueDepth: number; oldestQueuedAgeMs: number | null };
  };
  readonly normalizeAtSchedule: (at: number) => AutomationScheduleDefinition;
  readonly normalizeEverySchedule: (interval: string | number, anchorAt?: number) => AutomationScheduleDefinition;
  readonly normalizeCronSchedule: (expression: string, timezone?: string, staggerMs?: unknown) => AutomationScheduleDefinition;
  readonly trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel: string, sessionId?: string) => AgentRecordLike | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly agentTask?: string; readonly contractId?: string; readonly sessionId?: string; },
  ) => void;

  /**
   * A surface that ran the turn in its own process reports the answer, so the
   * daemon can write it into the shared session and push it down the reply
   * pipeline. The daemon's own completion poll only ever sees agents THIS
   * process spawned, so without this an answer produced by a client that
   * collected the input over `sessions.inputs.list` never reached the
   * conversation it came from.
   */
  readonly completeSurfaceReplyFromSurface: (input: {
    readonly agentId: string;
    readonly sessionId?: string | undefined;
    readonly body: string;
    readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  }) => Promise<boolean>;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'telephony' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly syncSpawnedAgentTask: (record: AgentRecordLike, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: AgentRecordLike) => void;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly runtimeStore: { getState(): { tasks: RuntimeTaskStateLike } } | null;
  readonly runtimeDispatch: {
    transitionRuntimeTask(
      taskId: string,
      status: string,
      patch: Record<string, unknown>,
      source: string,
    ): void;
    canRetryRuntimeTask?(taskId: string): boolean;
  } | null;
}

export type { JsonBody };

export type DaemonRuntimeRouteHandlerMap = DaemonRuntimeRouteHandlers;
