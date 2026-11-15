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
import { resolveWebBinding } from '../daemon/host-resolver.js';
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
export type AnnouncementRecordOutcome = 'recorded' | 'announced-before' | 'busy';

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

  private persist(state: AnnouncementFileState, context: string): void {
    const announced: Record<string, number> = {};
    for (const [id, at] of Object.entries(state.announced)) if (!isRetiredRunReceiptId(id)) announced[id] = at;
    const pending = state.pending.length > PENDING_ANNOUNCEMENTS_KEPT
      ? state.pending.slice(state.pending.length - PENDING_ANNOUNCEMENTS_KEPT)
      : state.pending;
    try {
      writeJsonFileAtomic(this.path, { announced, pending });
    } catch (err) {
      // An unwritable store must never block the feature; the announcement
      // may repeat on the next start, which is noisy but honest.
      logger.warn('[announcements] could not persist announce-once state', {
        context,
        error: err instanceof Error ? err.message : String(err),
      });
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
   * Record an announcement once per install. `recorded`: this call made it (the
   * caller announces); `announced-before`: it was already made (stay silent);
   * `busy`: another process held the store, nothing was written (try again later).
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
      this.persist(state, id);
      return 'recorded';
    });
    return attempt.ran ? attempt.value : 'busy';
  }

  /** {@link recordOnce} as a boolean: true only when this call made the announcement. */
  record(id: string, text?: string): boolean {
    return this.recordOnce(id, text) === 'recorded';
  }

  /**
   * Queue a recurring notice for surface delivery without an announce-once id
   * (a run receipt). The queue keeps the newest {@link PENDING_ANNOUNCEMENTS_KEPT}.
   * Returns false when another process held the store and nothing was queued.
   */
  notify(id: string, text: string): boolean {
    if (text.length === 0) return false;
    return this.locked(() => {
      const state = this.read();
      state.pending.push({ id, text, at: Date.now() });
      this.persist(state, id);
    }).ran;
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
      this.persist({ announced: state.announced, pending: [] }, 'drain');
      return pending;
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
   */
  forgetMatching(selects: (id: string) => boolean): void {
    if (!Object.keys(this.read().announced).some(selects)) return;
    this.locked(() => {
      const state = this.read();
      const announced: Record<string, number> = {};
      for (const [id, at] of Object.entries(state.announced)) if (!selects(id)) announced[id] = at;
      const pending = state.pending.filter((entry) => !selects(entry.id));
      if (Object.keys(announced).length === Object.keys(state.announced).length && pending.length === state.pending.length) return;
      this.persist({ announced, pending }, 'forget');
    });
  }

  /** Removes the named announcements from the pending queue; ids not pending are ignored. */
  acknowledge(ids: ReadonlySet<string>): void {
    this.locked(() => {
      const state = this.read();
      const remaining = state.pending.filter((entry) => !ids.has(entry.id));
      if (remaining.length === state.pending.length) return;
      this.persist({ announced: state.announced, pending: remaining }, 'acknowledge');
    });
  }
}

/** The store file location for an install (control-plane config directory). */
export function featureAnnouncementsPath(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
): string {
  return join(configManager.getControlPlaneConfigDir(), 'control-plane', 'feature-announcements.json');
}

/** The web surface's reachable URL from its settings. */
export function resolveWebSurfaceUrl(configManager: Pick<ConfigManager, 'get'>): string {
  const publicBaseUrl = configManager.get('web.publicBaseUrl');
  if (publicBaseUrl.trim().length > 0) return publicBaseUrl;
  // Anchored to the web binding resolver so the announced URL always carries a
  // validated port and the mode-resolved host (never a raw 0/NaN/typo value).
  const binding = resolveWebBinding({ hostMode: configManager.get('web.hostMode'), host: configManager.get('web.host'), port: configManager.get('web.port') });
  // A wildcard bind address is where the server listens, not an address a
  // browser can open; this machine reaches it as localhost.
  const host = binding.host === '0.0.0.0' || binding.host === '::' ? 'localhost' : binding.host;
  return `http://${host}:${binding.port}`;
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
  if (deps.configManager.get('web.enabled')) {
    const url = resolveWebSurfaceUrl(deps.configManager);
    // The scope suffix MUST come from the RESOLVER, not the raw stored value: a
    // case/space variant ('  Local ') is recognized-local and still needs the
    // scope note the old raw `=== 'local'` check silently dropped, and an
    // unrecognized value ('LAN') is served at loopback under the safe fallback,
    // it must be announced as unrecognized, never as the network mode the
    // operator may have believed they set.
    const rawHostMode = deps.configManager.get('web.hostMode');
    const binding = resolveWebBinding({
      hostMode: rawHostMode,
      host: deps.configManager.get('web.host'),
      port: deps.configManager.get('web.port'),
    });
    let suffix = '';
    if (!binding.recognized) {
      suffix = `, web.hostMode value ${JSON.stringify(String(rawHostMode))} is unrecognized; applied the safe local default, so this serves this machine only`;
    } else if (binding.effectiveMode === 'local') {
      suffix = ', serving this machine only until web.hostMode is widened';
    } else if ((binding.host === '0.0.0.0' || binding.host === '::') && deps.configManager.get('web.publicBaseUrl').trim().length === 0) {
      suffix = ', listening on every network interface: other devices use this machine\'s address, or set web.publicBaseUrl to announce a fixed URL';
    }
    const text = `Web surface ready: ${url}${suffix}`;
    // Recording WITH text also enqueues the line for surface delivery.
    if (deps.store.record(WEB_SURFACE_ANNOUNCEMENT_ID, text)) {
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
