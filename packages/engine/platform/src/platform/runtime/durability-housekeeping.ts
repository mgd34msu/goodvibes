/**
 * durability-housekeeping.ts, the reclaim half of every crash-durability
 * artefact a surface product writes to disk.
 *
 * The standing rule this module implements: if something is persisted across
 * restarts and crashes, recovery has to do the housekeeping. Each individual
 * store already knew how to WRITE its artefact and how to retire it on a clean
 * path; none of them reclaimed what a SIGKILL left behind. Three stores, three
 * kinds of residue:
 *
 *   - session locks         `<home>/.goodvibes/shared/owner-askers/session-*.writer.sqlite`
 *                           (session-open-lock.ts) removed on a clean close, so a
 *                           crash leaves one empty file behind; the kernel has
 *                           already released its lock, so it reads as closed.
 *   - quarantine files      `<path>.unrecognized`, written so a human can
 *                           inspect a corrupt file, never removed afterwards.
 *   - anchor sidecars       `<sessionsDir>/<id>.anchors.json`, outlives the
 *                           session JSONL that owns it.
 *
 * The quarantine and anchor reaps are bounded by an age window and a count
 * cap and decide what to keep by reading content; the session-lock reap
 * removes only files no process holds, taken without waiting. None touches the
 * current session, each tolerates a competing sweeper deleting the same file
 * first, and each reports what it removed. `startDurabilityHousekeeping` runs
 * the sweep at startup and then on a repeating timer, because a long-lived
 * process that only sweeps at boot never sweeps.
 *
 * Best-effort throughout: a failure in one reap never aborts the others and
 * nothing here ever throws to its caller.
 */
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { reapQuarantinedFiles } from '../config/read-versioned.js';
import { reapOrphanedAnchorSidecars } from '../rewind/turn-anchors.js';
import { sweepClosedSessionLocks } from './session-open-lock.js';
import type { SessionSurface } from './session-surface.js';

/**
 * How often the sweep repeats after startup: 6 hours. Hours, not minutes, the
 * residue this reclaims accumulates per crashed session, not continuously, and
 * a directory scan is not something a foreground surface should be doing often.
 */
export const DURABILITY_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface DurabilityHousekeepingInput {
  /** The product's declare-once storage handle; every swept path derives from it. */
  readonly surface: SessionSurface;
  /**
   * The session this process is using right now, read at sweep time rather
   * than captured once, a resume or fork can repoint it between sweeps.
   * Returning null means "not known yet", which is safe: the age rule and the
   * session lock independently protect an actively written artefact.
   */
  readonly currentSessionId?: () => string | null;
  /** Extra directories to scan for `.unrecognized` quarantine files. */
  readonly extraQuarantineDirs?: readonly string[];
}

export interface DurabilityHousekeepingOutcome {
  /** Lock files of sessions no process had open (crash residue). */
  readonly sessionLocks: number;
  readonly quarantineFiles: number;
  readonly anchorSidecars: number;
  /** Sum of the three counts above, zero means nothing was reclaimed. */
  readonly total: number;
}

/**
 * Run all three reaps once and return what each reclaimed.
 *
 * Each reap is isolated: one throwing is logged at warn level and counted as
 * zero, and the remaining reaps still run. The caller never sees an exception.
 */
export function runDurabilityHousekeeping(input: DurabilityHousekeepingInput): DurabilityHousekeepingOutcome {
  const { surface } = input;
  const currentSessionId = safely('current session id', () => input.currentSessionId?.() ?? null, null);

  // The current session's lock is held by this process, so the sweep cannot take it.
  const sessionLocks = safely('session locks', () => sweepClosedSessionLocks(surface).removed, 0);

  const quarantineFiles = safely('quarantine files', () =>
    reapQuarantinedFiles(quarantineDirsFor(input)).reaped, 0);

  const anchorSidecars = safely('anchor sidecars', () =>
    reapOrphanedAnchorSidecars(surface, { currentSessionId }).reaped, 0);

  const outcome: DurabilityHousekeepingOutcome = {
    sessionLocks,
    quarantineFiles,
    anchorSidecars,
    total: sessionLocks + quarantineFiles + anchorSidecars,
  };
  discloseHousekeeping(outcome);
  return outcome;
}

/**
 * Start durability housekeeping: one sweep now, then a repeating sweep every
 * `DURABILITY_HOUSEKEEPING_INTERVAL_MS`. Returns a disposer that stops the
 * timer; calling it more than once is harmless.
 *
 * The timer is `unref()`d, so an undisposed sweeper can never hold the process
 * open, same convention the store-snapshot scheduler and the config-file
 * watchers in durability-services.ts use.
 */
export function startDurabilityHousekeeping(
  input: DurabilityHousekeepingInput,
  options: { readonly intervalMs?: number } = {},
): () => void {
  runDurabilityHousekeeping(input);
  const timer = setInterval(
    () => { runDurabilityHousekeeping(input); },
    options.intervalMs ?? DURABILITY_HOUSEKEEPING_INTERVAL_MS,
  );
  timer.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Disclose what was reclaimed, silent deletion is indistinguishable from data
 * loss. Paths and counts only; nothing about a reclaimed file's contents.
 *
 * A sweep that reclaimed nothing logs nothing: the overwhelmingly common boot
 * has no residue at all, and a per-boot "reclaimed 0" line would train readers
 * to ignore the line that actually matters.
 */
function discloseHousekeeping(outcome: DurabilityHousekeepingOutcome): void {
  if (outcome.total === 0) return;
  logger.info('durability housekeeping reclaimed crash residue', {
    sessionLocks: outcome.sessionLocks,
    quarantineFiles: outcome.quarantineFiles,
    anchorSidecars: outcome.anchorSidecars,
    total: outcome.total,
  });
}

/**
 * Every directory that can accumulate `.unrecognized` files: the home-scoped
 * surface root and the per-project session,
 * state, recovery and checkpoint directories (versioned-config quarantines),
 * plus whatever the caller adds.
 */
function quarantineDirsFor(input: DurabilityHousekeepingInput): readonly string[] {
  const { surface } = input;
  return [
    join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot),
    surface.sessionsDir,
    surface.stateDir,
    surface.recoveryDir,
    surface.checkpointsDir,
    ...(input.extraQuarantineDirs ?? []),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
}

/** Run one reap in isolation: never throws, returns `fallback` if it would have. */
function safely<T>(label: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    logger.warn('durability housekeeping step failed', { step: label, error: summarizeError(error) });
    return fallback;
  }
}
