export type AutonomyQueueStatus = 'ready' | 'active' | 'needs-setup' | 'attention' | 'blocked';

export interface AgentHarnessAutonomyQueueArgs {
  readonly queueItemId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface OperatorContractMethod {
  readonly invokable?: boolean;
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly category?: string;
  readonly http?: {
    readonly method?: string;
    readonly path?: string;
  };
}

export interface AutonomyQueueItem {
  readonly id: string;
  readonly label: string;
  readonly status: AutonomyQueueStatus;
  readonly owner: 'agent' | 'connected-host' | 'agent-and-connected-host';
  readonly kind: 'work-plan' | 'research-run' | 'host-task' | 'approval' | 'automation-run' | 'schedule' | 'reminder' | 'routine-schedule' | 'delegated-agent' | 'background-process' | 'delivery';
  readonly visible: true;
  readonly cancellable: boolean;
  /** Rows that exist in this lane's source (shown or not); absent when the lane has no record source. */
  readonly records?: number;
  /** Of those, how many are running or queued now. */
  readonly active?: number;
  /** Of those, how many wait on the owner (pending approvals, failed or blocked work). */
  readonly needsOwner?: number;
  /** Connected-host methods published for this lane; never a count of work. */
  readonly methodsAvailable?: number;
  readonly current: string;
  readonly next: string;
  readonly inspectRoute: string;
  readonly modelRoute: string;
  readonly cancelRoute?: string;
  readonly createRoute?: string;
  readonly batchCreateRoute?: string;
  readonly methodIds?: readonly string[];
  readonly unavailableMethodIds?: readonly string[] | undefined;
  readonly liveRecords?: readonly AutonomyQueueLiveRecord[];
  /** Sources this lane reads that could not be read this time: the lane is unknown, not empty. */
  readonly unreadSources?: readonly string[];
}

export interface AutonomyQueueLiveRecord {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly phase?: string;
  readonly progress?: number;
  readonly updatedAt?: string;
  readonly summary: string;
  readonly inspectRoute: string;
  /** Present when the routes and next steps below were copied from a host record rather than built by this program. */
  readonly routeOrigin?: 'host-record';
  readonly cancelRoute?: string;
  readonly checkpointRoute?: string;
  readonly pauseRoute?: string;
  readonly resumeRoute?: string;
  readonly nextSteps?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly logTail?: readonly string[];
  readonly output?: AutonomyQueueRecordOutput;
  readonly diagnostics?: readonly string[];
  readonly controls?: readonly AutonomyQueueRecordControl[];
}

export interface AutonomyQueueRecordOutput {
  readonly status: 'preview' | 'route-only';
  readonly route: string;
  readonly source: 'runtime-task-result' | 'runtime-task-error' | 'host-output-chunk' | 'provider-source-preview' | 'not-published';
  readonly preview?: string;
  readonly policy: string;
}

export interface AutonomyQueueRecordControl {
  readonly id: string;
  readonly label: string;
  readonly state: 'available' | 'unavailable';
  readonly effect: 'read-only' | 'confirmed-effect';
  readonly confirmationRequired: boolean;
  readonly modelRoute?: string;
  readonly reason?: string;
}

export type SnapshotReader<TSnapshot> = {
  readonly getSnapshot: () => TSnapshot;
};

export type AutonomyQueueResolution =
  | { readonly status: 'found'; readonly item: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };
