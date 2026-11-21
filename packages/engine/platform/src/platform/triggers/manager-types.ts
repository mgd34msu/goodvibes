/**
 * manager-types.ts, the ports and configuration surface of the trigger
 * supervisor.
 *
 * Split out of manager.ts so the supervisor's wiring contract can be read (and
 * implemented by a host, or faked by a test) without paging through the
 * lifecycle logic that consumes it. Everything with an effect the supervisor
 * needs, running an agent turn, running a confirmed grant, supervising a
 * long-lived command, arrives through one of these interfaces.
 */

import { RefusalError, refusal } from '@goodvibes/engine/errors';
import type { TriggerProcessHost } from './process-triggers.js';
import type { ProbeIo } from './probes.js';
import { DEFAULT_RETENTION, type TriggerRetentionPolicy } from './store.js';
import type { TriggerActionGrant } from './types.js';

/** Runs the payload when a trigger fires. Hosts wire the real runtime. */
export interface TriggerActionExecutor {
  runAgentTurn(input: {
    readonly triggerId: string;
    /** The trigger's label, for the delivered answer's title. */
    readonly label?: string | undefined;
    readonly prompt: string;
    readonly sessionId?: string | undefined;
    readonly model?: string | undefined;
    /** Where the turn's answer goes (a channel); absent: the owner inbox. */
    readonly deliverTo?: string | undefined;
  }): Promise<string>;
  runGrant(input: {
    readonly triggerId: string;
    readonly grant: TriggerActionGrant;
  }): Promise<string>;
}

/** Supervises a long-lived command and delivers its output as it arrives. */
export interface TriggerStreamHost {
  start(input: {
    readonly triggerId: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string | undefined;
    readonly onChunk: (chunk: string) => void;
    readonly onExit: (exitCode: number | null) => void;
  }): Promise<{ readonly streamId: string; readonly pid: number }>;
  stop(streamId: string): void;
  /** Drain only children actually admitted by this host, including output. */
  join?(): Promise<void>;
}

/** The resolved `watchers.triggers.*` settings the supervisor reads. */
export interface TriggerManagerConfig {
  readonly enabled: boolean;
  readonly backoffLadderMs?: string | undefined;
  readonly breakerStrikes?: number | undefined;
  readonly defaultCheckIntervalMs?: number | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly maxConcurrentChecks?: number | undefined;
  readonly observationRingSize?: number | undefined;
  readonly runHistoryLimit?: number | undefined;
  readonly runHistoryTtlHours?: number | undefined;
  readonly eventLogLimit?: number | undefined;
  readonly eventLogTtlHours?: number | undefined;
  readonly sweepIntervalMs?: number | undefined;
  readonly supervisionTickMs?: number | undefined;
  readonly streamQueueLimit?: number | undefined;
  readonly streamBatchLines?: number | undefined;
  readonly streamBatchIntervalMs?: number | undefined;
  readonly onExitMaxDurationMs?: number | undefined;
  readonly onExitStdin?: string | undefined;
  readonly outputTailBytes?: number | undefined;
}

export interface TriggerManagerOptions {
  /** The trigger database (`…/triggers.db`). */
  readonly storePath: string;
  /**
   * A snapshot, or a function read on every access. Hosts pass the function
   * form so `watchers.triggers.enabled` is genuinely runtime-toggleable: with
   * a frozen snapshot, turning the flag on would do nothing until restart,
   * which is exactly the "configurable but not really" shape flags-are-features
   * forbids.
   */
  readonly config: TriggerManagerConfig | (() => TriggerManagerConfig);
  readonly actions: TriggerActionExecutor;
  readonly processHost?: TriggerProcessHost | undefined;
  readonly streamHost?: TriggerStreamHost | undefined;
  readonly probeIo?: ProbeIo | undefined;
  /**
   * The tools platform-tool probes call (probe-tools.ts); `probeIo.callTool`
   * runs on the same host. Absent: a platform-tool probe is refused at create.
   */
  readonly probeTools?: import('./probe-tools.js').ProbeToolHost | undefined;
  /**
   * The fetch tool's host settings an http probe is held to; a create whose
   * URL they refuse is refused. Absent: no localhost and no private host.
   */
  readonly probeHostPolicy?: import('./probes.js').ProbeHostPolicy | undefined;
  readonly now?: (() => number) | undefined;
  /** Stable for the lifetime of one daemon process. Drives restart detection. */
  readonly daemonBootId?: string | undefined;
  readonly sessionIsLive?: ((sessionId: string) => boolean) | undefined;
  /**
   * Whether new work is admitted (daemon/work-admission.ts). While it is not (a
   * self-update's restart) nothing new starts here and what was due stays due.
   */
  readonly workAdmitted?: (() => boolean) | undefined;
  /**
   * Subscribes to `watchers.triggers.enabled`; returns the unsubscribe. With
   * it, turning the setting on starts supervising stored triggers at once.
   */
  readonly watchEnabled?: ((onChange: (enabled: boolean) => void) => () => void) | undefined;
}

/**
 * Raised instead of silently doing nothing when the family is off. A watcher
 * that quietly declines to exist is the worst of both worlds, the operator
 * believes it is running.
 */
export class TriggerDisabledError extends RefusalError {
  constructor(operation: string) {
    super(refusal({
      code: 'TRIGGERS_OFF',
      state: 'triggers are off (watchers.triggers.enabled is false)',
      reason: `Cannot ${operation}: the trigger family is off (watchers.triggers.enabled is false)`,
      next: ['Set watchers.triggers.enabled to true (/settings set watchers.triggers.enabled true), then try again'],
      status: 409,
    }));
    this.name = 'TriggerDisabledError';
  }
}

/** Turns the operator-facing hour/count settings into the store's policy shape. */
export function retentionFrom(config: TriggerManagerConfig): TriggerRetentionPolicy {
  return {
    observationRingSize: config.observationRingSize ?? DEFAULT_RETENTION.observationRingSize,
    runHistoryLimit: config.runHistoryLimit ?? DEFAULT_RETENTION.runHistoryLimit,
    runHistoryTtlMs: (config.runHistoryTtlHours ?? 168) * 60 * 60 * 1000,
    eventLogLimit: config.eventLogLimit ?? DEFAULT_RETENTION.eventLogLimit,
    eventLogTtlMs: (config.eventLogTtlHours ?? 24) * 60 * 60 * 1000,
  };
}
