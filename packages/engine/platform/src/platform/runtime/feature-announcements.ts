/**
 * feature-announcements.ts, announce-once receipts for default-on features.
 *
 * Nothing default-on requires a setup step to function; instead, each
 * newly-default-on capability announces itself exactly once, usably:
 * - the web surface exposes its URL for daemon-start/footer display,
 * - automation exposes a how-to-create-your-first-routine empty state while
 *   it has no routines,
 * - the exec sandbox's first auto-allowed contained run yields a one-time
 *   "commands now run contained; escalations will ask" line.
 *
 * The platform provides these as state the surfaces render: a persisted
 * announce-once store (so "once" survives restarts), a startup collector, a
 * pure empty-state builder, and a first-contained-run announcer callback.
 */
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { resolveHostBinding, resolveWebBinding } from '../daemon/host-resolver.js';
import { resolvePairingWebOrigin } from '../pairing/web-origin.js';
import { join } from 'node:path';
import { trySyncFileLock } from '../config/sync-file-lock.js';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';

/** One announce-once line a surface renders verbatim. */
export interface FeatureAnnouncement {
  readonly id: string;
  readonly text: string;
}

/** A fired announcement awaiting delivery to a rendering surface. */
export interface PendingFeatureAnnouncement {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

interface AnnouncementFileState {
  announced: Record<string, number>;
  pending: PendingFeatureAnnouncement[];
}

/** The outcome of {@link FeatureAnnouncementStore.recordOnce}. */
export type AnnouncementRecordOutcome = 'recorded' | 'recorded-unsaved' | 'announced-before' | 'busy';

/** How many undelivered lines the pending queue keeps; older ones are dropped first. */
export const PENDING_ANNOUNCEMENTS_KEPT = 50;

/**
 * Ids written by memory consolidation runs before their receipts became plain
 * notices: one per run, never read back. Dropped from `announced` on the next write.
 */
function isRetiredRunReceiptId(id: string): boolean {
  return id.startsWith('memory-consolidation:') || id.startsWith('mcon-');
}

/**
 * Persisted announce-once bookkeeping under the control-plane config
 * directory, so an announcement made by any process of this install is made
 * exactly once, PLUS a pending-delivery queue: an announcement recorded with
 * text waits here until a rendering surface drains it (the daemon folds the
 * queue into the explicitly-consuming /status receipts read), so
 * announce-once lines reach surfaces instead of dead-ending in the log.
 * A recurring notice (a consolidation run's receipt) joins the queue through
 * {@link notify} without an announce-once id, so `announced` holds only the
 * fixed set of once-per-install ids and does not grow with use.
 *
 * Every read-modify-write holds the shared file lock (the daemon and the
 * terminal products write this file). When another process holds it past the
 * short wait, the write is skipped, not made unlocked: an announcement or
 * notice that misses its turn is made on the next attempt.
 *
 * File format: `{ announced: { id -> timestamp }, pending: [{id,text,at}] }`.
 * The legacy format (a plain id->timestamp map) reads as announced-with-
 * nothing-pending, old installs never re-announce.
 */
export class FeatureAnnouncementStore {
  constructor(private readonly path: string) {}

  private read(): AnnouncementFileState {
    const empty: AnnouncementFileState = { announced: {}, pending: [] };
    try {
      return (
        readJsonFileOrQuarantine<AnnouncementFileState>(this.path, {
          label: 'runtime/feature-announcements',
          recovery: 'Announce-once state is empty, so an already-seen announcement may be shown one more time; nothing else depends on this file.',
          validate: (parsed) => {
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('announcement state file is not a JSON object');
            }
            const record = parsed as Record<string, unknown>;
            if (record.announced !== null && typeof record.announced === 'object' && !Array.isArray(record.announced)) {
              return {
                announced: record.announced as Record<string, number>,
                pending: Array.isArray(record.pending)
                  ? (record.pending as PendingFeatureAnnouncement[]).filter(
                      (entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.text === 'string' && typeof entry.at === 'number',
                    )
                  : [],
              };
            }
            // Legacy format: a plain id -> timestamp map. Announced, nothing pending.
            return { announced: record as Record<string, number>, pending: [] };
          },
        }) ?? empty
      );
    } catch {
      return empty;
    }
  }

  /** Writes the store; returns whether the write landed (a failure is logged and said, never treated as saved). */
  private persist(state: AnnouncementFileState, context: string): boolean {
    const announced: Record<string, number> = {};
    for (const [id, at] of Object.entries(state.announced)) if (!isRetiredRunReceiptId(id)) announced[id] = at;
    const pending = state.pending.length > PENDING_ANNOUNCEMENTS_KEPT
      ? state.pending.slice(state.pending.length - PENDING_ANNOUNCEMENTS_KEPT)
      : state.pending;
    try {
      writeJsonFileAtomic(this.path, { announced, pending });
      return true;
    } catch (err) {
      // An unwritable store must never block the feature; the announcement
      // may repeat on the next start, which is noisy but honest.
      logger.warn('[announcements] could not persist announce-once state', {
        context,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Run a read-modify-write under the shared file lock, or report that another process holds it. */
  private locked<T>(operation: () => T): { readonly ran: true; readonly value: T } | { readonly ran: false } {
    const attempt = trySyncFileLock(this.path, operation);
    if (!attempt.ran) {
      logger.debug('[announcements] store busy in another process; skipped this write', { path: this.path });
    }
    return attempt;
  }

  has(id: string): boolean {
    return id in this.read().announced;
  }

  /**
   * Record an announcement once per install. `recorded`: this call made it and
   * it is saved (the caller announces); `recorded-unsaved`: this call made it but
   * the save failed (the caller still announces; it will be announced again on
   * a later start, noisy but honest); `announced-before`: it was already made
   * (stay silent); `busy`: another process held the store, nothing was written
   * (try again later).
   * With `text`, the first record also enqueues the line for surface delivery
   * (see drainPending), so the announcement reaches a rendering surface, not
   * only the log.
   */
  recordOnce(id: string, text?: string): AnnouncementRecordOutcome {
    const attempt = this.locked((): AnnouncementRecordOutcome => {
      const state = this.read();
      if (id in state.announced) return 'announced-before';
      const at = Date.now();
      state.announced[id] = at;
      if (typeof text === 'string' && text.length > 0) {
        state.pending.push({ id, text, at });
      }
      return this.persist(state, id) ? 'recorded' : 'recorded-unsaved';
    });
    return attempt.ran ? attempt.value : 'busy';
  }

  /** {@link recordOnce} as a boolean: true only when this call made the announcement (saved or not). */
  record(id: string, text?: string): boolean {
    const outcome = this.recordOnce(id, text);
    return outcome === 'recorded' || outcome === 'recorded-unsaved';
  }

  /**
   * Queue a recurring notice for surface delivery without an announce-once id
   * (a run receipt). The queue keeps the newest {@link PENDING_ANNOUNCEMENTS_KEPT}.
   * Returns false when nothing was queued: another process held the store, or
   * the write failed.
   */
  notify(id: string, text: string): boolean {
    if (text.length === 0) return false;
    const attempt = this.locked(() => {
      const state = this.read();
      state.pending.push({ id, text, at: Date.now() });
      return this.persist(state, id);
    });
    return attempt.ran && attempt.value;
  }

  /**
   * The fired-but-undelivered announcements, cleared on read: exactly-once
   * delivery to the first draining reader (the daemon's explicitly-consuming
   * /status receipts read), mirroring the daemon receipt contract. Empty when
   * another process holds the store; the lines stay queued for the next drain.
   */
  drainPending(): PendingFeatureAnnouncement[] {
    const attempt = this.locked(() => {
      const state = this.read();
      if (state.pending.length === 0) return [];
      const pending = state.pending;
      // Handed out only once cleared on disk: a failed clear keeps them queued for the next drain, never handed out twice.
      return this.persist({ announced: state.announced, pending: [] }, 'drain') ? pending : [];
    });
    return attempt.ran ? attempt.value : [];
  }

  /** The fired-but-undelivered announcements, left in place until {@link acknowledge} names them. */
  peekPending(): PendingFeatureAnnouncement[] {
    // A read needs no lock: every write replaces the file with one rename.
    return this.read().pending;
  }

  /**
   * Forgets every announced id the predicate selects (and any of them still
   * pending), so a condition that went away and comes back is announced again.
   * Reads without the lock first so a store with nothing to forget is not rewritten.
   * Returns false when nothing was forgotten (another process held the store, or the write failed)
   * (the callers run at every start or settings load, so the next one retries).
   */
  forgetMatching(selects: (id: string) => boolean): boolean {
    if (!Object.keys(this.read().announced).some(selects)) return true;
    const attempt = this.locked(() => {
      const state = this.read();
      const announced: Record<string, number> = {};
      for (const [id, at] of Object.entries(state.announced)) if (!selects(id)) announced[id] = at;
      const pending = state.pending.filter((entry) => !selects(entry.id));
      if (Object.keys(announced).length === Object.keys(state.announced).length && pending.length === state.pending.length) return true;
      return this.persist({ announced, pending }, 'forget');
    });
    return attempt.ran && attempt.value;
  }

  /**
   * Removes the named announcements from the pending queue; ids not pending are
   * ignored. Returns false when nothing was removed (another process held the
   * store, or the write failed): the caller keeps the acknowledgement and tries again.
   */
  acknowledge(ids: ReadonlySet<string>): boolean {
    const attempt = this.locked(() => {
      const state = this.read();
      const remaining = state.pending.filter((entry) => !ids.has(entry.id));
      if (remaining.length === state.pending.length) return true;
      return this.persist({ announced: state.announced, pending: remaining }, 'acknowledge');
    });
    return attempt.ran && attempt.value;
  }
}

/** The store file location for an install (control-plane config directory). */
export function featureAnnouncementsPath(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
): string {
  return join(configManager.getControlPlaneConfigDir(), 'control-plane', 'feature-announcements.json');
}

/**
 * The web UI's address from its settings: a user-set `web.publicBaseUrl`,
 * else where the web UI is served, from the one owner of that address
 * (pairing/web-origin.ts). Undefined when no web UI is served.
 */
export function resolveWebSurfaceUrl(configManager: Pick<ConfigManager, 'get'>): string | undefined {
  return resolvePairingWebOrigin(configManager)?.origin;
}

export const WEB_SURFACE_ANNOUNCEMENT_ID = 'web-surface-url';
export const SANDBOX_CONTAINED_ANNOUNCEMENT_ID = 'exec-sandbox-contained';

/** The one-time contained-exec line, verbatim. */
export const SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT =
  'commands now run contained; escalations will ask';

/**
 * Collect the announce-once lines due at daemon start. Each returned line is
 * recorded in the store as announced, the caller renders every returned
 * line (daemon-start log, footer, ...), exactly once per install.
 */
export function collectStartupAnnouncements(deps: {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly store: Pick<FeatureAnnouncementStore, 'record'>;
}): FeatureAnnouncement[] {
  const lines: FeatureAnnouncement[] = [];
  const url = resolveWebSurfaceUrl(deps.configManager);
  if (url !== undefined) {
    // The scope suffix comes from the listener that serves the web UI (the
    // control plane when the daemon serves the bundle), through the resolver,
    // never the raw stored value: an unrecognized mode ('LAN') is served at
    // loopback under the safe fallback and is announced as unrecognized.
    const servedByDaemon = deps.configManager.get('controlPlane.webui.serve') === true;
    const modeKey = servedByDaemon ? 'controlPlane.hostMode' : 'web.hostMode';
    const rawHostMode = deps.configManager.get(modeKey);
    const binding = servedByDaemon
      ? resolveHostBinding(typeof rawHostMode === 'string' ? rawHostMode : 'local', String(deps.configManager.get('controlPlane.host') ?? ''), Number(deps.configManager.get('controlPlane.port')), 'controlPlane')
      : resolveWebBinding({ hostMode: rawHostMode, host: deps.configManager.get('web.host'), port: deps.configManager.get('web.port') });
    let suffix = '';
    if (!binding.recognized) {
      suffix = `, ${modeKey} value ${JSON.stringify(String(rawHostMode))} is unrecognized; applied the safe local default, so this serves this machine only`;
    } else if (binding.effectiveMode === 'local') {
      suffix = servedByDaemon ? ', serving this machine only until goodvibes-daemon webui enable --lan' : ', serving this machine only until web.hostMode is widened';
    } else if ((binding.host === '0.0.0.0' || binding.host === '::') && deps.configManager.get('web.publicBaseUrl').trim().length === 0) {
      suffix = ', listening on every network interface: other devices use this machine\'s address, or set web.publicBaseUrl to announce a fixed URL';
    }
    const text = `Web surface ready: ${url}${suffix}`;
    // Recorded WITHOUT text: the line goes to the daemon log (the caller) and
    // `goodvibes status` reports the web surface itself; it is never queued for
    // surface delivery, so the web UI it describes does not show it as a banner.
    if (deps.store.record(WEB_SURFACE_ANNOUNCEMENT_ID)) {
      lines.push({ id: WEB_SURFACE_ANNOUNCEMENT_ID, text });
    }
  }
  return lines;
}

/** The automation empty state a surface renders while no routines exist. */
export interface AutomationEmptyState {
  readonly title: string;
  readonly body: string;
}

/**
 * Automation's how-to-create-your-first-routine empty state: present while
 * automation is enabled and has zero routines, absent otherwise. Persistent
 * state (not once-only), it disappears by itself when the first routine
 * exists, so nothing default-on ever needs a setup step to be honest.
 */
export function buildAutomationEmptyState(input: {
  readonly enabled: boolean;
  readonly routineCount: number;
}): AutomationEmptyState | null {
  if (!input.enabled || input.routineCount > 0) return null;
  return {
    title: 'No routines yet',
    body:
      'Automation is on and idle. Create your first routine with /automation create '
      + '(name, schedule, prompt) or the schedule verb, it runs on its cadence with '
      + 'durable run history, retries, and delivery receipts.',
  };
}

/**
 * The exec sandbox's first-contained-run announcer: call it on every
 * sandboxed command execution; the FIRST call per install announces once via
 * `onAnnounce` and every later call is silent. Once the store has answered
 * (recorded, or announced before) this process never asks it again, so a
 * contained command costs one boolean test; a busy store is asked again on the
 * next run.
 */
export function createSandboxContainmentAnnouncer(
  store: Pick<FeatureAnnouncementStore, 'recordOnce'>,
  onAnnounce: (announcement: FeatureAnnouncement) => void,
): () => void {
  let settled = false;
  return () => {
    if (settled) return;
    // Recording WITH text also enqueues the line for surface delivery.
    const outcome = store.recordOnce(SANDBOX_CONTAINED_ANNOUNCEMENT_ID, SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT);
    if (outcome === 'busy') return;
    settled = true;
    if (outcome === 'recorded') {
      onAnnounce({
        id: SANDBOX_CONTAINED_ANNOUNCEMENT_ID,
        text: SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT,
      });
    }
  };
}
