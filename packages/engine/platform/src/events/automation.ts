/**
 * AutomationEvent, discriminated union covering automation job and run lifecycle events.
 */

export const AUTOMATION_SCHEDULE_KINDS = ['at', 'every', 'cron'] as const;
export const AUTOMATION_RUN_OUTCOMES = ['success', 'partial', 'failed', 'cancelled'] as const;

export type AutomationScheduleKind = (typeof AUTOMATION_SCHEDULE_KINDS)[number];

export type AutomationExecutionMode = 'isolated' | 'current' | 'pinned' | 'background';

export type AutomationRunOutcome = (typeof AUTOMATION_RUN_OUTCOMES)[number];

export type AutomationEvent =
  /**
   * A scheduled job was created. `name` is its display name, `scheduleKind`
   * how it repeats (`at` once, `every` an interval, `cron` an expression), and
   * `enabled` whether it will run.
   */
  | {
      type: 'AUTOMATION_JOB_CREATED';
      jobId: string;
      name: string;
      scheduleKind: AutomationScheduleKind;
      enabled: boolean;
    }
  /**
   * A scheduled job's definition changed; `changedFields` names the fields
   * that differ. A change of `enabled` is also announced by
   * AUTOMATION_JOB_ENABLED or AUTOMATION_JOB_DISABLED.
   */
  | {
      type: 'AUTOMATION_JOB_UPDATED';
      jobId: string;
      changedFields: string[];
    }
  /**
   * A scheduled job was removed, by its owner, an agent, a script, or a
   * one-shot job finishing; `reason` says which (`job-removed` for a removal
   * asked for). It no longer runs or lists anywhere.
   */
  | {
      type: 'AUTOMATION_JOB_REMOVED';
      jobId: string;
      reason: string;
    }
  /** A scheduled job was turned on and will run at its next due time. */
  | {
      type: 'AUTOMATION_JOB_ENABLED';
      jobId: string;
    }
  /** A scheduled job was turned off; `reason` is why it was paused (`disabled` when none was given). */
  | {
      type: 'AUTOMATION_JOB_DISABLED';
      jobId: string;
      reason: string;
    }
  /**
   * A run of a scheduled job began. `runId` names the run, `startedAt` is its
   * start time (milliseconds since the epoch) and `attempt` counts retries of
   * the same run, from 1.
   */
  | {
      type: 'AUTOMATION_RUN_STARTED';
      jobId: string;
      runId: string;
      startedAt: number;
      attempt: number;
    }
  /**
   * The one terminal event: every run that ends announces it once, whatever
   * the outcome. A subscriber that needs "the run is over" listens for this
   * type only.
   */
  | {
      type: 'AUTOMATION_RUN_COMPLETED';
      jobId: string;
      runId: string;
      startedAt: number;
      completedAt: number;
      durationMs: number;
      outcome: AutomationRunOutcome;
      /** What went wrong, for a `failed` outcome. */
      error?: string | undefined;
      /** Whether another attempt could succeed, for a `failed` outcome whose failure was classified. */
      retryable?: boolean | undefined;
    }
  /** Detail of a failed run (its retry reading); the run's end is announced by AUTOMATION_RUN_COMPLETED. */
  | {
      type: 'AUTOMATION_RUN_FAILED';
      jobId: string;
      runId: string;
      startedAt: number;
      failedAt: number;
      error: string;
      retryable: boolean;
    }
  /**
   * A run failed and its job turned itself off after too many failures in a
   * row: `consecutiveFailures` is the count and `reason` why it was paused
   * (`failure-threshold-reached` unless the job gave its own).
   */
  | {
      type: 'AUTOMATION_JOB_AUTO_DISABLED';
      jobId: string;
      reason: string;
      consecutiveFailures: number;
    };

export type AutomationEventType = AutomationEvent['type'];
