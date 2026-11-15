/**
 * workspace-swap-manager.ts
 *
 * Changes the daemon's working directory (`runtime.workingDir`), set through
 * POST /config {key:"runtime.workingDir", value:"<path>"} or the state tool.
 *
 * A change is saved and takes effect when the host next starts; nothing in the
 * running process moves. Sessions, hooks, the permission scope, contracts,
 * worktrees, checkpoints, the code and project indexes, the file watcher and
 * native work intake are all built for the root the process started on, and
 * moving only some of them would leave one process answering from two
 * directories. So the running process stays whole on its start root until it
 * restarts, every result says so, and no authority is revoked: nothing it was
 * granted for changes while it runs.
 *
 *   - Returns INVALID_PATH when the path is empty or cannot be created.
 *   - Returns REROOT_FAILED when the new path could not be saved; nothing
 *     changed and the saved working directory is what it was.
 *   - Requesting the root the process runs on cancels a saved, not yet applied
 *     change; requesting the already saved root changes nothing.
 *   - On success the result has `restartRequired` and the services that move
 *     at the next start (`requiresRestart`).
 *
 * Events emitted on runtimeBus (domain: 'workspace'):
 *   WORKSPACE_SWAP_COMPLETED, after the new path is saved
 *   WORKSPACE_SWAP_FAILED   , when the path cannot be created or saved
 */

import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readDaemonSetting, writeDaemonSetting } from './daemon-home.js';
import type { WorkspaceEvent } from '../../events/workspace.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { createEventEnvelope } from '../runtime/events/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The services bound to the working directory at start, in product terms; all of them move at the next start. */
export const WORKSPACE_ROOT_BOUND_SERVICES: readonly string[] = Object.freeze([
  'sessions', 'hooks', 'permission scope', 'contracts', 'worktrees', 'checkpoints',
  'code index', 'project index', 'file watcher', 'native work intake',
]);

export interface WorkspaceSwapDeps {
  readonly runtimeBus: RuntimeEventBus | null;
  readonly daemonHomeDir: string;
  /**
   * The start option that sets the working directory ahead of the saved
   * setting (`--working-dir`, `GOODVIBES_WORKING_DIR`), when this process was
   * started with one: a saved change only applies once that option is changed
   * or removed, and the result says so.
   */
  readonly startOverride?: string | undefined;
}

export type WorkspaceSwapResult =
  | {
    ok: true;
    /** The root this process runs on, until it restarts. */
    previous: string;
    /** The saved root the next start uses. */
    current: string;
    /** Always true on success: the change was saved. */
    persisted: boolean;
    /** True when the saved root differs from the running one, so a restart applies it. */
    restartRequired: boolean;
    /** The services that move to `current` at the next start; empty when nothing changes. */
    requiresRestart: readonly string[];
    /** What the person or agent should know or do next, in product terms. */
    note: string;
  }
  | { ok: false; code: 'INVALID_PATH'; reason: string }
  | { ok: false; code: 'REROOT_FAILED'; reason: string };

export class WorkspaceSwapManager {
  private readonly liveWorkingDir: string;
  private savedWorkingDir: string | null;

  constructor(
    initialWorkingDir: string,
    private readonly deps: WorkspaceSwapDeps,
  ) {
    this.liveWorkingDir = initialWorkingDir;
    const saved = readDaemonSetting(deps.daemonHomeDir, 'runtime.workingDir');
    this.savedWorkingDir = typeof saved === 'string' && saved !== initialWorkingDir ? saved : null;
  }

  /** The root this process runs on. It does not change while the process runs. */
  getCurrentWorkingDir(): string {
    return this.liveWorkingDir;
  }

  /** The saved root the next start will use, when it differs from the running one. */
  getPendingWorkingDir(): string | null {
    return this.savedWorkingDir;
  }

  async requestSwap(newWorkingDir: string): Promise<WorkspaceSwapResult> {
    const raw = newWorkingDir.trim();
    if (!raw) {
      return { ok: false, code: 'INVALID_PATH', reason: 'Working directory path must not be empty. Nothing changed.' };
    }
    const from = this.liveWorkingDir;
    const to = isAbsolute(raw) ? resolve(raw) : resolve(from, raw);
    const pendingBefore = this.savedWorkingDir;
    const target = to === from ? null : to;

    if (target === pendingBefore) {
      return this.success(from, to, target !== null);
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
    this._emit({ type: 'WORKSPACE_SWAP_COMPLETED', from, to, persistedInDaemonSettings: true });
    return this.success(from, to, target !== null);
  }

  private success(from: string, to: string, restartRequired: boolean): WorkspaceSwapResult {
    const override = this.deps.startOverride
      ? ` This daemon was started with ${this.deps.startOverride}, which wins over the saved setting: change or remove it before restarting.`
      : '';
    const note = restartRequired
      ? `Saved. The daemon keeps working in '${from}' until it restarts; after a restart every service uses '${to}'.${override}`
      : `The daemon already works in '${from}'; no change is waiting for a restart.`;
    return {
      ok: true, previous: from, current: to, persisted: true, restartRequired,
      requiresRestart: restartRequired ? WORKSPACE_ROOT_BOUND_SERVICES : [], note,
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
