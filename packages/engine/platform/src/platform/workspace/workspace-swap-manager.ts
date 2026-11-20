/**
 * workspace-swap-manager.ts
 *
 * Changes the daemon's working directory (`runtime.workingDir`), set through
 * POST /config {key:"runtime.workingDir", value:"<path>"} or the state tool.
 *
 * Sessions, hooks, the permission scope, contracts, worktrees, checkpoints,
 * the code and project indexes, the file watcher and native work intake are
 * all built for one root, so a working directory is never moved one service at
 * a time: that would leave one process answering from two directories. A host
 * that can move (`moveHost`) moves as a whole: the change is saved, and once no
 * session has input waiting or a turn running, the host's owner stops every
 * service and builds them all again on the new root, in the same process,
 * with the same listener address. Attached apps reconnect. A host without
 * `moveHost` keeps the change for its next start and says so.
 *
 *   - Returns INVALID_PATH when the path is empty or cannot be created.
 *   - Returns REROOT_FAILED when the new path could not be saved; nothing
 *     changed and the saved working directory is what it was.
 *   - Returns WORKSPACE_BUSY when the host is already moving.
 *   - Requesting the root the host runs on cancels a saved, not yet applied
 *     change (and a move still waiting for sessions to finish); requesting the
 *     already saved root changes nothing.
 *   - On success the result says whether the host is moving now (`moving`),
 *     waiting for busy sessions first (`waitingForSessions`), or applies the
 *     change at the next start (`restartRequired`, `requiresRestart`).
 *
 * Events emitted on runtimeBus (domain: 'workspace'):
 *   WORKSPACE_SWAP_STARTED  , when the host begins to move
 *   WORKSPACE_SWAP_COMPLETED, on the moved host once it serves on the new root
 *                             (announceArrival), or after the change is saved
 *                             for the next start on a host that cannot move
 *   WORKSPACE_SWAP_REFUSED  , when a change is refused because a move is under way
 *   WORKSPACE_SWAP_FAILED   , when the path cannot be created or saved, or on the
 *                             host that returned to its root after a move failed
 *                             (announceReturn)
 */

import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readDaemonSetting, writeDaemonSetting } from './daemon-home.js';
import type { WorkspaceEvent } from '../../events/workspace.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { createEventEnvelope } from '../runtime/events/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { failedRead, present, refusal, type Observed } from '@goodvibes-jev/engine/errors';

/** The services bound to the working directory, in product terms; all of them move together. */
export const WORKSPACE_ROOT_BOUND_SERVICES: readonly string[] = Object.freeze([
  'sessions', 'hooks', 'permission scope', 'contracts', 'worktrees', 'checkpoints',
  'code index', 'project index', 'file watcher', 'native work intake',
]);

/** How often a move waiting for busy sessions looks again. One map walk per look. */
const DEFAULT_IDLE_POLL_MS = 1_000;

export interface WorkspaceSwapDeps {
  readonly runtimeBus: RuntimeEventBus | null;
  readonly daemonHomeDir: string;
  /**
   * The start option that sets the working directory ahead of the saved
   * setting (`--working-dir`, `GOODVIBES_WORKING_DIR`), when this process was
   * started with one: a later start uses that option again, so the result
   * says it must change or be removed for the new root to outlast a restart.
   */
  readonly startOverride?: string | undefined;
  /**
   * Moves the running host to `workingDir`: its owner stops every service and
   * builds them again there, in this process. Called once, after the change
   * is saved and no session is busy; it must not stop anything before the
   * request that asked for the move has been answered (schedule the work).
   * Absent: the change applies at the next start.
   */
  readonly moveHost?: ((workingDir: string) => void) | undefined;
  /** Sessions with input waiting or a turn running; a move waits until there are none. */
  readonly getBusySessionCount?: (() => number) | undefined;
  /** How often a move waiting for busy sessions looks again (default one second). */
  readonly idlePollMs?: number | undefined;
}

export type WorkspaceSwapResult =
  | {
    ok: true;
    /** The root this host runs on as it answers. */
    previous: string;
    /** The saved root: where the host moves now, or what the next start uses. */
    current: string;
    /** Always true on success: the change was saved. */
    persisted: boolean;
    /** True when the host moves to `current` in this process (now, or once busy sessions finish). */
    moving: boolean;
    /** Sessions the move waits for (0 when it starts at once or nothing moves). */
    waitingForSessions: number;
    /** True when nothing moves until the host restarts. */
    restartRequired: boolean;
    /** The services that move to `current` at the next start; empty unless `restartRequired`. */
    requiresRestart: readonly string[];
    /** What the person or agent should know or do next, in product terms. */
    note: string;
  }
  | { ok: false; code: 'INVALID_PATH'; reason: string }
  | { ok: false; code: 'REROOT_FAILED'; reason: string }
  | { ok: false; code: 'WORKSPACE_BUSY'; reason: string; retryAfter: number };

export class WorkspaceSwapManager {
  private readonly liveWorkingDir: string;
  private savedWorkingDir: string | null;
  /** The root a move waits to go to while sessions are busy. */
  private waitingMove: string | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once the host was handed to its owner to move; this host answers nothing more about moving. */
  private movingTo: string | null = null;

  constructor(
    initialWorkingDir: string,
    private readonly deps: WorkspaceSwapDeps,
  ) {
    this.liveWorkingDir = initialWorkingDir;
    const saved = readDaemonSetting(deps.daemonHomeDir, 'runtime.workingDir');
    this.savedWorkingDir = typeof saved === 'string' && saved !== initialWorkingDir ? saved : null;
  }

  /** The root this host runs on. A move builds a new host; this one keeps its root until it stops. */
  getCurrentWorkingDir(): string {
    return this.liveWorkingDir;
  }

  /** The saved root a move or the next start will use, when it differs from the running one. */
  getPendingWorkingDir(): string | null {
    return this.movingTo ?? this.waitingMove ?? this.savedWorkingDir;
  }

  async requestSwap(newWorkingDir: string): Promise<WorkspaceSwapResult> {
    const raw = newWorkingDir.trim();
    if (!raw) {
      return { ok: false, code: 'INVALID_PATH', reason: 'Working directory path must not be empty. Nothing changed.' };
    }
    const from = this.liveWorkingDir;
    const to = isAbsolute(raw) ? resolve(raw) : resolve(from, raw);
    if (this.movingTo !== null) {
      const reason = `The daemon is already moving to '${this.movingTo}'. Nothing changed; retry once it serves there again (apps reconnect on their own).`;
      this._emit({ type: 'WORKSPACE_SWAP_REFUSED', from, to, reason, retryAfter: 5 });
      return { ok: false, code: 'WORKSPACE_BUSY', reason, retryAfter: 5 };
    }
    const pendingBefore = this.waitingMove ?? this.savedWorkingDir;
    const target = to === from ? null : to;

    if (target === pendingBefore && (target === null || this.deps.moveHost === undefined || this.waitingMove !== null)) {
      return this.success(from, to, target);
    }

    if (target !== null) {
      try {
        mkdirSync(to, { recursive: true });
        if (!statSync(to).isDirectory()) throw new Error('it exists and is not a directory');
      } catch (err: unknown) {
        const reason = `Cannot use '${to}' as the working directory: ${err instanceof Error ? err.message : String(err)}. Nothing changed; the daemon keeps working in '${from}'. Choose a directory that exists or can be created.`;
        this._emit({ type: 'WORKSPACE_SWAP_FAILED', from, to, code: 'INVALID_PATH', reason });
        return { ok: false, code: 'INVALID_PATH', reason };
      }
    }

    try {
      writeDaemonSetting(this.deps.daemonHomeDir, 'runtime.workingDir', to);
    } catch (err: unknown) {
      logger.warn('[WorkspaceSwap] saving runtime.workingDir failed', { error: summarizeError(err), daemonHomeDir: this.deps.daemonHomeDir, to });
      const reason = `Could not save the working directory to the daemon settings in '${this.deps.daemonHomeDir}': ${summarizeError(err)}. Nothing changed; the daemon keeps working in '${from}'. Make that directory writable, then retry.`;
      this._emit({ type: 'WORKSPACE_SWAP_FAILED', from, to, code: 'REROOT_FAILED', reason });
      return { ok: false, code: 'REROOT_FAILED', reason };
    }
    this.savedWorkingDir = target;
    this.cancelWaitingMove();
    if (target === null || this.deps.moveHost === undefined) {
      if (target !== null) this._emit({ type: 'WORKSPACE_SWAP_COMPLETED', from, to, persistedInDaemonSettings: true });
      return this.success(from, to, target);
    }
    this.waitingMove = target;
    this.moveWhenIdle();
    return this.success(from, to, target);
  }

  /**
   * Said by the host a move built, once it serves on its new root: the move
   * is complete. `from` is the root the previous host ran on.
   */
  announceArrival(from: string): void {
    this._emit({ type: 'WORKSPACE_SWAP_COMPLETED', from, to: this.liveWorkingDir, persistedInDaemonSettings: true });
  }

  /**
   * Said by the host rebuilt on its old root after a move to `to` failed:
   * nothing moved, and the saved working directory is this root again.
   */
  announceReturn(to: string, reason: string): void {
    this._emit({ type: 'WORKSPACE_SWAP_FAILED', from: this.liveWorkingDir, to, code: 'REROOT_FAILED', reason });
  }

  /**
   * Said by the host owner when a move could not begin (the new root's
   * settings could not be read): nothing stopped, this host keeps serving and
   * can be asked again; the new root stays saved for the next start.
   */
  abandonMove(reason: string): void {
    const to = this.movingTo;
    this.movingTo = null;
    if (to !== null) {
      this._emit({ type: 'WORKSPACE_SWAP_FAILED', from: this.liveWorkingDir, to, code: 'REROOT_FAILED',
        reason: `The daemon did not move to '${to}': ${reason}. It keeps working in '${this.liveWorkingDir}'.` });
    }
  }

  /** Stop waiting to move; called when the host stops for another reason. */
  dispose(): void {
    this.cancelWaitingMove();
  }

  private cancelWaitingMove(): void {
    this.waitingMove = null;
    if (this.waitTimer !== null) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  /**
   * How many sessions have a turn running or input waiting. A probe that
   * throws is `failed`, never 0: a move does not cut off a turn it could not see.
   */
  busySessions(): Observed<number> {
    const probe = this.deps.getBusySessionCount;
    if (probe === undefined) return present(0);
    try { return present(probe()); }
    catch (err: unknown) {
      return failedRead(refusal({
        code: 'WORKSPACE_BUSY_UNKNOWN',
        state: 'the move waits',
        reason: `could not tell whether a turn is running: ${summarizeError(err)}`,
        next: ['The move starts once the daemon can tell that no turn is running.'],
        retryable: true,
      }));
    }
  }

  /** True only when the probe saw no busy session. */
  private idle(): boolean {
    const busy = this.busySessions();
    return busy.kind === 'present' && busy.value === 0;
  }

  private moveWhenIdle(): void {
    const target = this.waitingMove;
    if (target === null || this.movingTo !== null) return;
    if (!this.idle()) {
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.moveWhenIdle();
      }, this.deps.idlePollMs ?? DEFAULT_IDLE_POLL_MS);
      this.waitTimer.unref?.();
      return;
    }
    this.waitingMove = null;
    this.movingTo = target;
    this._emit({ type: 'WORKSPACE_SWAP_STARTED', from: this.liveWorkingDir, to: target });
    try {
      this.deps.moveHost!(target);
    } catch (err: unknown) {
      // The owner could not even begin; this host stays where it is and can be asked again.
      this.movingTo = null;
      const reason = `The daemon could not begin moving to '${target}': ${summarizeError(err)}. It keeps working in '${this.liveWorkingDir}'; the new directory stays saved for the next start.`;
      logger.warn('[WorkspaceSwap] the host could not begin a move', { error: summarizeError(err), to: target });
      this._emit({ type: 'WORKSPACE_SWAP_FAILED', from: this.liveWorkingDir, to: target, code: 'REROOT_FAILED', reason });
    }
  }

  private success(from: string, to: string, target: string | null): WorkspaceSwapResult {
    const override = this.deps.startOverride
      ? ` This daemon was started with ${this.deps.startOverride}, which wins over the saved setting at a start: change or remove it, or the next restart returns to it.`
      : '';
    if (target === null) {
      return {
        ok: true, previous: from, current: to, persisted: true, moving: false, waitingForSessions: 0,
        restartRequired: false, requiresRestart: [],
        note: `The daemon already works in '${from}'; no change is waiting.`,
      };
    }
    if (this.deps.moveHost === undefined) {
      return {
        ok: true, previous: from, current: to, persisted: true, moving: false, waitingForSessions: 0,
        restartRequired: true, requiresRestart: WORKSPACE_ROOT_BOUND_SERVICES,
        note: `Saved. This host cannot move while it runs, so it keeps working in '${from}' until it restarts; after a restart every service uses '${to}'.${override}`,
      };
    }
    const read = this.movingTo === null && this.waitingMove !== null ? this.busySessions() : present(0);
    const busy = read.kind === 'present' ? read.value : 0;
    return {
      ok: true, previous: from, current: to, persisted: true, moving: true, waitingForSessions: busy,
      restartRequired: false, requiresRestart: [],
      note: read.kind === 'failed'
        ? `Saved. The daemon could not tell whether a turn is running, so the move to '${to}' waits until it can; every service then starts again there and attached apps reconnect.${override}`
        : busy > 0
          ? `Saved. The daemon moves to '${to}' as soon as ${busy} busy session(s) finish their current turn; every service then starts again there and attached apps reconnect.${override}`
          : `Saved. The daemon is moving to '${to}' now: every service starts again there and attached apps reconnect in a moment.${override}`,
    };
  }

  private _emit(payload: WorkspaceEvent): void {
    if (!this.deps.runtimeBus) return;
    try {
      const envelope = createEventEnvelope(
        payload.type,
        payload,
        { sessionId: '', source: 'workspace-swap-manager' },
      );
      this.deps.runtimeBus.emit<'workspace'>(
        'workspace',
        // WorkspaceEvent is the DomainEventMap['workspace'] union; createEventEnvelope
        // infers the payload type as the concrete member rather than the full union.
        // A single widening cast (not through unknown) is safe here.
        envelope as import('../runtime/events/index.js').RuntimeEventEnvelope<WorkspaceEvent['type'], WorkspaceEvent>,
      );
    } catch {
      // Never throw from event emission
    }
  }
}
