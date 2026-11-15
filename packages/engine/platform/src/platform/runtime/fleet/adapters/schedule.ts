import type { ScheduleEntry } from '../../../tools/workflow/index.js';
import type { ProcessNode, ProcessState } from '../types.js';

/** Schedule node ids are namespaced: entries are keyed by user-chosen names. */
export function scheduleNodeId(name: string): string {
  return `schedule:${name}`;
}

function scheduleState(entry: ScheduleEntry): ProcessState {
  if (entry.running) return 'executing-tool';
  return entry.enabled ? 'idle' : 'paused';
}

/** What the schedule did last, or is doing: the run in progress, or how the last one ended. */
function scheduleActivity(entry: ScheduleEntry): ProcessNode['currentActivity'] {
  if (entry.running && entry.lastRun !== undefined) return { kind: 'phase', text: `running: ${entry.command}`, at: entry.lastRun };
  if (entry.lastExitAt === undefined) return undefined;
  const ended = entry.lastExitCode === null ? 'last run was stopped by a signal'
    : entry.lastExitCode === 0 ? 'last run succeeded' : `last run failed with exit code ${String(entry.lastExitCode)}`;
  return { kind: 'phase', text: ended, at: entry.lastExitAt };
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
  const activity = scheduleActivity(entry);
  return {
    id: scheduleNodeId(entry.name),
    kind: 'schedule',
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
