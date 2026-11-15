/**
 * Which phases of a failed turn or task took unusually long for what they do,
 * decided in code from one table: seconds for local work, minutes for a model
 * reply, a batch of tools or a background task. Phases with no duration, and
 * phases the table does not know, are not called slow.
 */
import type { PhaseTimingEntry } from './types.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Longest ordinary duration per phase; longer is slow. */
export const SLOW_PHASE_LIMITS_MS: Readonly<Record<'turn' | 'task', Readonly<Record<string, number>>>> = {
  turn: {
    // Local checks before the model call.
    PREFLIGHT: 5 * SECOND,
    // Sending the request until the reply starts.
    MODEL_REQUEST: 2 * MINUTE,
    // The model writing its reply.
    STREAM: 10 * MINUTE,
    // Local work after the reply, before the next step.
    AFTER_STREAM: 5 * SECOND,
    // The tools the model asked for, from the first call received until none is in flight.
    TOOLS: 10 * MINUTE,
    // Local work after the tools, until the next reply starts.
    AFTER_TOOLS: 2 * MINUTE,
  },
  task: {
    // Registering the task.
    CREATED: 5 * SECOND,
    // The background task doing its work.
    RUNNING: 30 * MINUTE,
  },
};

/** The phases, in order, whose duration is over the table's limit for their kind. */
export function slowPhases(domain: 'turn' | 'task', phaseTimings: readonly PhaseTimingEntry[]): string[] {
  const limits = SLOW_PHASE_LIMITS_MS[domain];
  return phaseTimings
    .filter((entry) => {
      const limit = limits[entry.phase];
      return entry.durationMs !== undefined && limit !== undefined && entry.durationMs > limit;
    })
    .map((entry) => entry.phase);
}
