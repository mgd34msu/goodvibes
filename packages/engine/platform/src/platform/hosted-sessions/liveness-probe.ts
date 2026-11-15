/**
 * The hosted engine's answer to "is this session actually doing something right
 * now?", asked by the shared session broker's idle reaper.
 *
 * Why the reaper has to ask instead of working it out: every liveness signal
 * the broker records is emitted by a turn running IN the broker's own process,
 * a message appended, an agent bound, an input queued, a participant
 * heartbeat. A hosted turn emits none of them. Its transcript lives on the
 * hosted record (so the broker's `messageCount` stays 0, which puts the session
 * in the 10-minute idle-empty window instead of the 24-hour one), and the
 * intake tick that would otherwise refresh its heartbeat is itself blocked
 * awaiting that very turn. The reaper was reading a record that had gone quiet
 * and concluding the work had stopped, when the work was the reason it was
 * quiet.
 */
import type { HostedSessionRecord } from './types.js';

/**
 * Kept for callers that pass a freshness window. The engine is the owner of
 * whether a hosted session is alive, and it holds a session until it is
 * terminated, so the probe no longer reads timestamps.
 */
export const DEFAULT_HOSTED_LIVENESS_FRESHNESS_MS = 10 * 60 * 1000;

/** The slice of HostedSessionManager this probe needs. */
export interface HostedSessionLivenessLookup {
  get(sessionId: string): HostedSessionRecord | null;
}

/** The shape the probe reads off a broker record; structural so no import cycle forms. */
export interface ProbedSession {
  readonly id: string;
  readonly kind: string;
}

export interface HostedSessionLivenessProbeOptions {
  /** Unused: liveness is the engine's record, not a time window. */
  readonly now?: () => number;
  /** Unused: liveness is the engine's record, not a time window. */
  readonly freshnessMs?: number;
}

/**
 * Build the probe the broker installs via `setExternalLivenessProbe`.
 *
 * Answers true only for sessions this engine actually owns, a non-hosted
 * session, or a hosted id the engine has no record of, is not this probe's to
 * vouch for, and it says so rather than blanket-exempting everything and
 * quietly disabling the reaper.
 */
export function createHostedSessionLivenessProbe(
  lookup: HostedSessionLivenessLookup,
  _options: HostedSessionLivenessProbeOptions = {},
): (session: ProbedSession) => boolean {
  return (session: ProbedSession): boolean => {
    if (session.kind !== 'hosted') return false;
    let record: HostedSessionRecord | null;
    try {
      record = lookup.get(session.id);
    } catch {
      // A probe that throws would take down the sweep that called it. An
      // engine that cannot answer is not evidence the session is alive.
      return false;
    }
    if (!record) return false;
    // The engine holds this session until it is terminated: that is the one
    // fact, owned here. A terminated one is done, and vouching for it would
    // leave its broker record active forever.
    return record.status !== 'terminated';
  };
}
