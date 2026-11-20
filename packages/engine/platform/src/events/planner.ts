/**
 * PlannerEvent, discriminated union for adaptive planner decisions and overrides.
 */

export type ExecutionStrategy = 'auto' | 'single' | 'cohort' | 'background' | 'remote';

export interface StrategyCandidate {
  readonly strategy: ExecutionStrategy;
  readonly score: number;
  readonly reasonCode: string;
}

export interface PlannerDecision {
  readonly provenance?: 'classic';
  readonly selected: ExecutionStrategy;
  readonly reasonCode: string;
  readonly candidates: readonly StrategyCandidate[];
  readonly overrideActive: boolean;
  readonly timestamp: number;
  /** The automatic reading's band outcome and decision-log identity, when present. */
  readonly outcome?: 'act' | 'confirm' | 'escalate' | undefined;
  readonly decisionId?: string | undefined;
  readonly inputs: {
    /** Null means no risk assessment was taken. */
    readonly riskScore: number | null;
    readonly latencyBudgetMs: number;
    readonly isMultiStep: boolean;
    readonly remoteAvailable: boolean;
    readonly backgroundEligible: boolean;
    readonly taskDescription?: string | undefined;
  };
}

export type WorkPlanTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface WorkPlanTaskEventRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly owner?: string | undefined;
  readonly status: WorkPlanTaskStatus;
  readonly priority?: number | undefined;
  readonly order: number;
  readonly source?: string | undefined;
  readonly tags: readonly string[];
  readonly parentTaskId?: string | undefined;
  readonly contractId?: string | undefined;
  readonly phaseId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly decisionId?: string | undefined;
  readonly sourceMessageId?: string | undefined;
  readonly linkedArtifactIds: readonly string[];
  readonly linkedSourceIds: readonly string[];
  readonly linkedNodeIds: readonly string[];
  readonly originSurface?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface WorkPlanEventBase {
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly workPlanId: string;
  /** The plan's revision after the commit the event reports; it only moves up. */
  readonly revision: number;
}

export type PlannerEvent =
  /**
   * The planner's choice of execution strategy (single, cohort, background,
   * remote) with its scored candidates and inputs. Declared for subscribers;
   * nothing in this release emits it.
   */
  | ({
    type: 'PLAN_STRATEGY_SELECTED';
  } & PlannerDecision)
  /** `/plan override` set the execution strategy `/workstream` uses when it drafts a plan, or cleared it (`strategy` null, `clearedBy` who cleared it). */
  | {
    type: 'PLAN_STRATEGY_OVERRIDDEN';
    strategy: ExecutionStrategy | null;
    clearedBy?: string | undefined;
  }
  /** A task was added to a project's work plan; `task` is the task as stored and `revision` the plan's revision after the change. */
  | ({
    type: 'WORK_PLAN_TASK_CREATED';
    task: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  /** A work plan task changed; `task` is the task now and `previousTask` before. */
  | ({
    type: 'WORK_PLAN_TASK_UPDATED';
    task: WorkPlanTaskEventRecord;
    previousTask: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  /** A work plan task moved from `previousStatus` to `status` (pending, in_progress, blocked, done, failed, cancelled). */
  | ({
    type: 'WORK_PLAN_TASK_STATUS_CHANGED';
    taskId: string;
    status: WorkPlanTaskStatus;
    previousStatus: WorkPlanTaskStatus;
    task: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  /** A task was removed from a project's work plan; `task` is what it was. */
  | ({
    type: 'WORK_PLAN_TASK_DELETED';
    taskId: string;
    task: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  /** A copy of the work plan read before `updatedAt` is out of date: read the plan again. `reason` says what changed it (a task created or updated here, or a change made elsewhere). */
  | ({
    type: 'WORK_PLAN_SNAPSHOT_INVALIDATED';
    reason: string;
    /** When the commit was made. A snapshot read at an older revision is stale. */
    updatedAt: number;
  } & WorkPlanEventBase);

export type PlannerEventType = PlannerEvent['type'];
