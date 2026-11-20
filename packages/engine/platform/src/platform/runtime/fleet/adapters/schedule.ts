import type { ScheduleEntry } from '../../../tools/workflow/index.js';
import type { ProcessNode, ProcessState } from '../types.js';
import { parseIntervalWords } from '@goodvibes/engine/contracts';

/** Schedule node ids are namespaced: entries are keyed by user-chosen names. */
export function scheduleNodeId(name: string): string {
  return `schedule:${name}`;
}

function scheduleState(entry: ScheduleEntry): ProcessState {
  if (entry.running) return 'executing-tool';
  return entry.enabled ? 'idle' : 'paused';
}

/** What the schedule did last, or is doing: the run in progress, or how the last one ended. */
function scheduleActivity(entry: ScheduleEntry, now: number): ProcessNode['currentActivity'] {
  const skipped = entry.skippedTicks ? ` (${entry.skippedTicks} tick${entry.skippedTicks === 1 ? '' : 's'} skipped while a run was still going)` : '';
  if (entry.running && entry.lastRun !== undefined) return { kind: 'phase', text: `running: ${entry.command}${skipped}`, at: entry.lastRun };
  if (entry.lastExitAt === undefined) {
    // A command that never started (not on PATH) has no exit; its error says why.
    return entry.lastError ? { kind: 'phase', text: `${entry.lastError}${skipped}`, at: now } : undefined;
  }
  const ended = entry.lastError ? `last run: ${entry.lastError}`
    : entry.lastExitCode === null ? 'last run was stopped by a signal'
      : entry.lastExitCode === 0 ? 'last run succeeded' : `last run failed with exit code ${String(entry.lastExitCode)}`;
  return { kind: 'phase', text: `${ended}${skipped}`, at: entry.lastExitAt };
}

/** When the schedule runs and how its last run ended, for the work board. */
function scheduleFacts(entry: ScheduleEntry): NonNullable<ProcessNode['schedule']> {
  const intervalMs = parseIntervalWords(entry.interval);
  // A run that ended with an error or a non-zero exit failed; a clean one has no delivery to speak of.
  const failed = !entry.running && entry.lastExitAt !== undefined && (entry.lastError !== undefined || entry.lastExitCode !== 0);
  return {
    ...(intervalMs !== undefined ? { cadence: { kind: 'every' as const, intervalMs } } : {}),
    ...(entry.lastRun !== undefined ? { lastRunAt: entry.lastRun } : {}),
    ...(failed ? { lastOutcome: 'failed' as const } : {}),
  };
}

/**
 * ScheduleEntry -> ProcessNode. A schedule whose command is executing is
 * active ('executing-tool'); between runs it is honestly 'idle'; disabled maps
 * to 'paused' (NOT 'killed': the entry still exists and can be re-armed). The
 * activity line says how the last run ended. Kill removes the schedule and
 * stops a run in progress. The label says the schedule lives in this process
 * only, unlike the durable `/schedule` routines shown under the same kind.
 */
export function adaptSchedule(entry: ScheduleEntry, now: number = Date.now()): ProcessNode {
  const activity = scheduleActivity(entry, now);
  return {
    id: scheduleNodeId(entry.name),
    kind: 'schedule',
    serves: 'you',
    schedule: scheduleFacts(entry),
    parentId: undefined,
    label: `${entry.name} (${entry.interval}, this process only)`,
    task: entry.command,
    state: scheduleState(entry),
    startedAt: entry.lastRun,
    elapsedMs: entry.running && entry.lastRun !== undefined ? Math.max(0, now - entry.lastRun) : 0,
    costUsd: null,
    costState: 'unpriced',
    ...(activity ? { currentActivity: activity } : {}),
    capabilities: { interruptible: false, killable: true, pausable: entry.enabled, resumable: !entry.enabled, steerable: false },
    raw: entry,
  };
}
