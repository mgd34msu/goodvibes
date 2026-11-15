import { validateCheckpointManifest, CheckpointManifestShapeError, type Manifest } from './manifest.js';
/**
 * manager.ts
 *
 * WorkspaceCheckpointManager, the coarse, whole-workspace rewind layer.
 *
 * Complements (does not replace) FileUndoManager (../../state/file-undo.ts),
 * which stays as the fine-grained, in-memory, per-file /undo layer. This
 * manager persists across sessions, snapshots the ENTIRE workspace tree, and
 * survives process restarts (backed by git objects + a JSON manifest on
 * disk), which is the wrong shape for FileUndoManager but exactly the shape
 * needed for "revert everything turn N did" or "restore the workspace to how
 * it looked an hour ago".
 *
 * Storage layout (workspace-local, see side-git.ts for the git mechanics):
 *   <workspaceRoot>/.goodvibes/checkpoints/git        , side GIT_DIR
 *   <workspaceRoot>/.goodvibes/checkpoints/index.json , manifest (JsonFileStore)
 *
 * Checkpoint refs live at refs/goodvibes/checkpoints/<id> inside the side
 * repo, entirely separate from the user's real git refs and from compaction's
 * `cpt_` boundary commits (which are conversation snapshots, not filesystem
 * snapshots, and are not stored in git at all, see types.ts's header comment
 * for the full disambiguation).
 *
 * Automatic snapshots subscribe to EXISTING runtime bus events
 * (TURN_COMPLETED / TURN_ERROR / TURN_CANCEL / AGENT_COMPLETED), no new
 * event contract is introduced by this module.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { JsonFileStore, JsonFileStoreParseError } from '../../state/json-file-store.js';
import { captureQuarantineSource, quarantineCorruptFile } from '../../utils/atomic-json-store.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { TurnEvent } from '../../../events/turn.js';
import type { AgentEvent } from '../../../events/agents.js';
import { RetentionPolicy, type RetentionConfig, type RetentionClass } from '../../runtime/retention/index.js';
import { SideGitRunner, CHECKPOINT_REF_PREFIX, EMPTY_TREE_HASH, detectGitToplevel } from './side-git.js';
import { acquireCrossProcessLock } from './cross-process-lock.js';
import { deleteCheckpointRefs, type CheckpointPruneResult } from './pruner.js';
import { computeSessionChanges } from './session-changes.js';
import { applyRestore } from './restore.js';
import { recordsForUnlistedRefs, deleteUnlistedRefs } from './unlisted-refs.js';
import { CheckpointDiffObservations } from './diff-observations.js';
import {
  BROAD_ROOT_OVERRIDE,
  DEFAULT_MAX_FIRST_SNAPSHOT_FILES,
  broadRootReason,
  broadRootRefusalMessage,
  firstSnapshotTooLargeMessage,
} from './root-guard.js';
import { CheckpointRestoreError, type WorkspaceCheckpoint, type CheckpointKind, type CheckpointDiff, type RestoreResult, type CheckpointSessionChanges } from './types.js';

const ID_PREFIX = 'wcp';

function generateCheckpointId(now: () => number): string {
  const ts = now().toString(36);
  const rand = randomUUID().slice(0, 8);
  return `${ID_PREFIX}_${ts}_${rand}`;
}

/** Default retention class per checkpoint kind when the caller does not specify one. */
function defaultRetentionClassFor(kind: CheckpointKind): RetentionClass {
  return kind === 'manual' ? 'forensic' : 'standard';
}

// Option shapes live in manager-options.ts (800-line cap), re-exported here.
export type {
  CreateCheckpointOptions,
  RestoreOptions,
  ListCheckpointsFilter,
  CheckpointSessionResolveContext,
  CheckpointSessionResolver,
  WorkspaceCheckpointManagerOptions,
} from './manager-options.js';
import type {
  CreateCheckpointOptions,
  RestoreOptions,
  ListCheckpointsFilter,
  CheckpointSessionResolver,
  WorkspaceCheckpointManagerOptions,
} from './manager-options.js';

/**
 * WorkspaceCheckpointManager, create/list/diff/restore/gc for whole-workspace
 * git-backed snapshots, plus automatic snapshotting on existing turn/agent
 * lifecycle events.
 */
export class WorkspaceCheckpointManager {
  // Resolved at init (git-root preference can move it off the raw option), so
  // these are reassigned once by `buildForRoot`, not `readonly`.
  // Assigned by `buildForRoot`, which the constructor always calls.
  private root!: string;
  private checkpointRootDir!: string;
  private sideGit!: SideGitRunner;
  private manifestStore!: JsonFileStore<Manifest>;
  private manifestPath!: string;
  private retentionPolicy!: RetentionPolicy;
  private readonly now: () => number;
  private readonly runtimeBus: RuntimeEventBus | undefined;
  /** Resolves a triggering turn/agent to its owning session id for automatic-snapshot stamping. May be replaced post-construction via `setSessionResolver`. */
  private resolveSessionId: CheckpointSessionResolver | undefined;
  private readonly unsubscribers: (() => void)[] = [];

  // Root-guard configuration (see WorkspaceCheckpointManagerOptions).
  private readonly rawWorkspaceRoot: string;
  private readonly explicitCheckpointDir: string | undefined;
  private readonly surfaceCheckpointsDir: string | undefined;
  private readonly retentionOverride: Partial<RetentionConfig> | undefined;
  private readonly preferGitRoot: boolean;
  private readonly allowBroadRoot: boolean;
  private readonly allowLargeFirstSnapshot: boolean;
  private readonly maxFirstSnapshotFiles: number;
  private readonly autoRetention: boolean;
  private readonly lockTimeoutMs: number | undefined;
  private readonly automaticSnapshotsAllowed: () => boolean;
  private readonly ownsSession: ((sessionId: string | undefined) => boolean) | undefined;
  private readonly homeDir: string;
  private readonly daemonStateDir: string;
  /** Non-null (the honest refusal message) when the resolved root was refused as too broad; drives both the skipped auto-subscription and rejected explicit `create()` calls. */
  private lastRetentionFailure: { readonly error: string; readonly at: number } | null = null;
  private rootRefusal: string | null = null;

  private checkpoints = new Map<string, WorkspaceCheckpoint>();
  private readonly diffObservations = new CheckpointDiffObservations();
  private initialized = false;
  private manifestReadOk = false; // the last manifest read under the lock succeeded
  private manifestQuarantined = false; // init moved an unreadable index aside; its refs are re-listed once
  private initPromise: Promise<void> | null = null;
  /** The manifest file as this process last read or wrote it (mtime, size, inode); `list()` reloads when the file on disk differs. */
  private manifestSignature: string | null = null;
  /** Locked operations running now, and how many have started; an unlocked reload applies only when neither moved. */
  private operationsInFlight = 0;
  private operationsStarted = 0;

  /**
   * Promise-chain mutex serializing every operation that touches the side
   * repo's shared index or object store: `create`, `restore`, `gc` and `diff`
   * (the one-argument `git diff` refreshes the index stat cache, a write).
   * Without it an auto-snapshot's `git add -A` could land between restore's
   * `read-tree --reset` and `checkout-index -a -f`, two creates could share the
   * index, and a `gc()` could prune an in-flight create's not-yet-ref'd commit.
   * Public methods `await this.init()` and then `withLock`; the git work lives
   * in `*Internal` methods, which internal callers use directly so one logical
   * operation never re-enters its own lock. The chain covers this process
   * only; the cross-process lock file acquired inside it covers other
   * processes sharing the checkpoint directory (cross-process-lock.ts).
   */
  private lockChain: Promise<void> = Promise.resolve();

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    // `lockChain` never rejects, so one `.then` waits for every earlier
    // operation whatever its outcome; the lock file is released in `finally`.
    const result = this.lockChain.then(async () => {
      this.operationsInFlight += 1;
      this.operationsStarted += 1;
      try {
        const release = await this.acquireStoreLock();
        try {
          // Another process sharing this store may have written the manifest
          // since we loaded it; every rewrite below saves the whole index, so
          // it must start from what is on disk.
          if (this.initialized) await this.reloadManifest();
          return await fn();
        } finally {
          release();
        }
      } finally {
        this.operationsInFlight -= 1;
      }
    });
    this.lockChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Take the cross-process lock on the side repo. A holder that is alive keeps
   * it (a frozen process may resume and run git against the same index); a
   * holder whose process is gone released it with its process.
   */
  private acquireStoreLock(): Promise<() => void> {
    return acquireCrossProcessLock(join(this.sideGit.gitDir, '.gv-lock'), {
      ...(this.lockTimeoutMs !== undefined ? { totalTimeoutMs: this.lockTimeoutMs } : {}),
    });
  }

  constructor(opts: WorkspaceCheckpointManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.runtimeBus = opts.runtimeBus;
    this.resolveSessionId = opts.resolveSessionId;
    this.rawWorkspaceRoot = opts.workspaceRoot;
    this.explicitCheckpointDir = opts.checkpointDir;
    this.surfaceCheckpointsDir = opts.surface?.checkpointsDir;
    this.retentionOverride = opts.retention;
    this.preferGitRoot = opts.preferGitRoot ?? true;
    this.allowBroadRoot = opts.allowBroadRoot ?? false;
    this.allowLargeFirstSnapshot = opts.allowLargeFirstSnapshot ?? false;
    this.maxFirstSnapshotFiles = opts.maxFirstSnapshotFiles ?? DEFAULT_MAX_FIRST_SNAPSHOT_FILES;
    this.autoRetention = opts.autoRetention ?? true;
    this.lockTimeoutMs = opts.lockTimeoutMs;
    this.automaticSnapshotsAllowed = opts.automaticSnapshotsAllowed ?? (() => true);
    this.ownsSession = opts.ownsSession;
    this.homeDir = opts.homeDir ?? homedir();
    this.daemonStateDir = opts.daemonStateDir ?? join(this.homeDir, '.goodvibes');
    // Build against the raw root first; init() may rebuild once the git-root
    // preference resolves a different (enclosing-repo) root.
    this.buildForRoot(opts.workspaceRoot);
  }

  /**
   * (Re)construct every root-bound collaborator for `root`: storage dir, side
   * git runner, manifest store, and retention policy (whose pruner closes over
   * the side git runner, so it is rebuilt alongside it). Called from the
   * constructor with the raw root, and again from init() if the git-root
   * preference resolves a different root.
   */
  private buildForRoot(root: string): void {
    this.root = root;
    // Precedence: an explicit checkpointDir override always wins; otherwise a
    // surface's checkpointsDir (fixed to the surface's own workingDirectory,
    // not re-derived from `root`, see WorkspaceCheckpointManagerOptions.surface);
    // otherwise the legacy, unscoped `<root>/.goodvibes/checkpoints` (compat).
    this.checkpointRootDir = this.explicitCheckpointDir ?? this.surfaceCheckpointsDir ?? join(root, '.goodvibes', 'checkpoints');
    this.sideGit = new SideGitRunner({
      workspaceRoot: root,
      gitDir: join(this.checkpointRootDir, 'git'),
    });
    this.manifestPath = join(this.checkpointRootDir, 'index.json');
    this.manifestStore = new JsonFileStore<Manifest>(this.manifestPath);
    this.retentionPolicy = new RetentionPolicy(this.retentionOverride, this.now);
  }

  /**
   * The workspace root snapshots are taken of. Until `init()` resolves it this
   * is the root the manager was constructed with; init may move it to the
   * enclosing git repository's top level (`preferGitRoot`). Read it when it is
   * needed, never copy it at construction; {@link resolveRoot} waits for init.
   */
  get workspaceRoot(): string {
    return this.root;
  }

  /** The resolved workspace root, after init. Diff paths are relative to it. */
  async resolveRoot(): Promise<string> {
    await this.init();
    return this.root;
  }

  /**
   * Install (or replace) the session resolver used to stamp `sessionId` onto
   * automatic snapshots. Wired after construction because the daemon's
   * agent→session mapping (the session broker) is built alongside this manager;
   * the subscription reads the resolver at each event, so a later install takes
   * effect for all subsequent snapshots.
   */
  setSessionResolver(resolver: CheckpointSessionResolver | undefined): void {
    this.resolveSessionId = resolver;
  }

  /**
   * Idempotent setup: init the side repo, load the manifest (re-hydrating the
   * in-memory RetentionPolicy so retention state survives process restarts),
   * and subscribe to automatic-snapshot events if a runtime bus was provided.
   * Safe to call multiple times; concurrent callers share one in-flight init.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      // A failed init must not be cached: every public method starts with
      // `await this.init()`, so a single transient failure (a busy side repo,
      // an unreadable manifest) would otherwise replay the same rejection for
      // the life of the process and disable checkpoints entirely. Clearing the
      // slot on rejection makes the next call a real retry.
      this.initPromise = this._init().catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
  }

  private async _init(): Promise<void> {
    await this.resolveAndGuardRoot();
    // Cross-process lock around the side repo's `git init`, not just the
    // later withLock-guarded operations: two processes constructing a
    // manager against the same not-yet-initialized checkpoint directory at
    // once race `git init` itself (observed failure: "cannot copy
    // .../info/exclude: File exists" when both processes' `git init` calls
    // overlap), before any of the create/restore/gc/diff critical sections
    // are ever reached.
    {
      const release = await this.acquireStoreLock();
      try {
        await this.sideGit.init();
      } finally {
        release();
      }
    }
    await this.reloadManifest();
    if (this.manifestQuarantined) await this.adoptUnlistedRefs();
    if (this.runtimeBus) {
      if (this.rootRefusal) {
        logger.warn('WorkspaceCheckpointManager: refusing automatic snapshot subscription for a broad root', {
          root: this.root,
          reason: this.rootRefusal,
          override: BROAD_ROOT_OVERRIDE,
        });
      } else {
        this.subscribeToAutomaticSnapshots(this.runtimeBus);
      }
    }
    if (this.runtimeBus && !this.rootRefusal) await this.takeBaseline();
    this.initialized = true;
    // One retention sweep at init so a store that grew past its limits in a
    // previous process shrinks on the next startup (non-blocking).
    this.maybeRunRetention();
  }

  /**
   * An empty store gets one unstamped snapshot when automatic snapshots start,
   * so the first session's first checkpoint has a parent and "what this session
   * changed" is that session's work, not the whole workspace. It is part of
   * init, which the products start eagerly at launch, so it is done before a
   * first turn can end (that turn's snapshot awaits init). It costs the
   * whole-tree sweep the first turn's snapshot would otherwise pay, once in the
   * life of the store. A failure is logged and never fails init.
   */
  private async takeBaseline(): Promise<void> {
    if (this.checkpoints.size > 0 || !this.automaticSnapshotsAllowed()) return;
    try {
      await this.withLock(async () => {
        if (this.checkpoints.size > 0) return null;
        // Recorded even when the workspace is empty: the empty tree is then the
        // real base of the first session.
        return this.createInternal({ kind: 'manual', label: 'workspace baseline', retentionClass: 'standard' }, true);
      });
    } catch (err) {
      logger.warn('WorkspaceCheckpointManager: baseline snapshot failed; the first session will be diffed from its own first checkpoint', {
        error: summarizeError(err),
      });
    }
  }

  /**
   * Resolve the effective root (preferring the enclosing git repo top level)
   * and decide whether it is too broad to snapshot. When the git-root
   * preference moves the root, every root-bound collaborator is rebuilt via
   * `buildForRoot`. A refused root sets `rootRefusal` (logged with the
   * override name in `_init`) so automatic subscription is skipped and explicit
   * `create()` calls fail honestly; the `allowBroadRoot` override clears it.
   */
  private async resolveAndGuardRoot(): Promise<void> {
    let resolved = this.rawWorkspaceRoot;
    if (this.preferGitRoot) {
      const toplevel = await detectGitToplevel(this.rawWorkspaceRoot);
      if (toplevel) resolved = toplevel;
    }
    if (resolved !== this.workspaceRoot) {
      this.buildForRoot(resolved);
    }

    const reason = broadRootReason(resolved, this.homeDir, this.daemonStateDir);
    this.rootRefusal = reason && !this.allowBroadRoot ? broadRootRefusalMessage(resolved, reason) : null;
  }

  /**
   * The most recent automatic retention sweep failure, or null once a sweep
   * has succeeded again. A locked or full side repository fails every sweep
   * quietly otherwise, and the store grows with nothing reporting why.
   */
  retentionFailure(): { readonly error: string; readonly at: number } | null {
    return this.lastRetentionFailure;
  }

  /** Cheap, non-blocking retention sweep: skips when auto-retention is off, the root was refused, or nothing is over-limit; else fires the lock-serialized `gc()` fire-and-forget (like the auto-snapshot path). */
  private maybeRunRetention(): void {
    if (!this.autoRetention || this.rootRefusal) return;
    let due = false;
    try {
      due = this.retentionPolicy.needsPrune();
    } catch (err) {
      this.recordRetentionFailure(err);
      return;
    }
    if (!due) return;
    void this.gc().catch((err) => this.recordRetentionFailure(err));
  }

  private recordRetentionFailure(err: unknown): void {
    const error = typeof err === 'string' ? err : summarizeError(err);
    this.lastRetentionFailure = { error, at: Date.now() };
    logger.warn('WorkspaceCheckpointManager: automatic retention sweep failed', { error });
  }

  // ---------------------------------------------------------------------------
  // Automatic snapshots
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the EXISTING turn/agent lifecycle events, no new event
   * types are introduced. A snapshot is taken at the boundary AFTER each
   * turn/agent-run finishes, meaning "revert everything turn N did" means
   * restoring the checkpoint captured BEFORE turn N, i.e. checkpoint[N-1] in
   * `list()`'s (newest-first) ordering, an intentional off-by-one, documented
   * here rather than hidden: this module always snapshots "where things ended
   * up", never "where things started".
   *
   * Listener bodies are wrapped so a failure NEVER throws back into the bus:
   * `RuntimeEventBus.emit()` only catches synchronous throws from a listener,
   * not rejections from a returned (but un-awaited) promise, so every
   * auto-snapshot call here is deliberately `.catch()`-guarded.
   */
  private subscribeToAutomaticSnapshots(bus: RuntimeEventBus): void {
    // A workspace that shares the bus with others snapshots only its own sessions'
    // events, stamped with the session the event names.
    const owned = (eventSessionId: string | undefined): boolean => this.ownsSession?.(eventSessionId) ?? true;
    const stamp = (resolved: string | undefined, eventSessionId: string | undefined): string | undefined =>
      resolved ?? (this.ownsSession ? eventSessionId : undefined);
    const snapshotTurn = (turnId: string, reason: string, eventSessionId: string | undefined): void => {
      if (!owned(eventSessionId) || !this.automaticSnapshotsAllowed()) return;
      // Resolve the owning session synchronously, at event-fire time, so the id
      // is captured even though create() runs async and the resolver's backing
      // state (e.g. the session's active turn/agent) may move on afterwards.
      const sessionId = stamp(this.resolveSessionId?.({ turnId }), eventSessionId);
      this.create({ kind: 'turn', turnId, sessionId, retentionClass: 'standard', label: `turn ${reason}` }).catch((err) => {
        logger.warn('WorkspaceCheckpointManager: automatic turn snapshot failed', {
          turnId,
          reason,
          error: summarizeError(err),
        });
      });
    };
    const snapshotAgentRun = (agentId: string, eventSessionId: string | undefined): void => {
      if (!owned(eventSessionId) || !this.automaticSnapshotsAllowed()) return;
      const sessionId = stamp(this.resolveSessionId?.({ agentId }), eventSessionId);
      this.create({ kind: 'agent-run', agentId, sessionId, retentionClass: 'standard', label: 'agent run' }).catch((err) => {
        logger.warn('WorkspaceCheckpointManager: automatic agent-run snapshot failed', {
          agentId,
          error: summarizeError(err),
        });
      });
    };

    this.unsubscribers.push(
      bus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload, sessionId }) => {
        snapshotTurn(payload.turnId, 'completed', sessionId);
      }),
      bus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload, sessionId }) => {
        snapshotTurn(payload.turnId, 'error', sessionId);
      }),
      bus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload, sessionId }) => {
        snapshotTurn(payload.turnId, 'cancelled', sessionId);
      }),
      bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload, sessionId }) => {
        snapshotAgentRun(payload.agentId, sessionId);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new checkpoint. Returns `null` (a cheap no-op) when the current
   * workspace tree is identical to the parent checkpoint's tree, no commit,
   * no ref, no manifest entry is created in that case.
   *
   * Serialized against every other index-touching operation on this manager
   *, see `withLock`.
   */
  async create(opts: CreateCheckpointOptions): Promise<WorkspaceCheckpoint | null> {
    await this.init();
    if (this.rootRefusal) throw new Error(this.rootRefusal);
    const checkpoint = await this.withLock(() => this.createInternal(opts));
    // After a real (non-no-op) create, sweep retention if a limit is now
    // crossed, outside the lock, non-blocking, so create() stays fast.
    if (checkpoint) this.maybeRunRetention();
    return checkpoint;
  }

  private async createInternal(opts: CreateCheckpointOptions, recordEmptyFirst = false): Promise<WorkspaceCheckpoint | null> {
    await this.guardFirstSnapshotSize(opts);
    await this.sideGit.stageAll(opts.paths);
    const treeHash = await this.sideGit.writeTree();

    const parent = this.mostRecentCheckpoint();
    const parentTree = parent ? await this.sideGit.treeOf(parent.commit) : EMPTY_TREE_HASH;
    if (parentTree === treeHash && !(recordEmptyFirst && !parent)) {
      logger.debug('WorkspaceCheckpointManager.create: tree unchanged since parent, no-op', {
        kind: opts.kind,
        parentId: parent?.id ?? null,
      });
      return null;
    }

    const id = generateCheckpointId(this.now);
    const kind = opts.kind;
    const retentionClass = opts.retentionClass ?? defaultRetentionClassFor(kind);
    const label = opts.label ?? this.defaultLabel(kind, id);
    const message = `wcp: ${kind} ${label}`.trim();
    const commit = await this.sideGit.commitTree(treeHash, message);
    const ref = `${CHECKPOINT_REF_PREFIX}${id}`;
    await this.sideGit.updateRef(ref, commit);
    try {
      return await this.recordCheckpoint(opts, { id, kind, label, retentionClass, commit, parent });
    } catch (error) {
      // A ref without a manifest record can never be listed, restored or pruned.
      this.checkpoints.delete(id);
      this.retentionPolicy.unregister(id);
      await this.sideGit.deleteRef(ref).catch(() => undefined);
      throw error;
    }
  }

  private async recordCheckpoint(
    opts: CreateCheckpointOptions,
    made: { id: string; kind: CheckpointKind; label: string; retentionClass: RetentionClass; commit: string; parent: WorkspaceCheckpoint | null },
  ): Promise<WorkspaceCheckpoint> {
    const { id, kind, label, retentionClass, commit, parent } = made;
    const changedPaths = parent
      ? await this.sideGit.diffNameOnly(parent.commit, commit)
      : await this.sideGit.listTrackedFiles(commit);
    const sizeBytes = await this.computeSizeBytes(changedPaths);

    const checkpoint: WorkspaceCheckpoint = {
      id,
      kind,
      label,
      createdAt: this.now(),
      parentId: parent?.id ?? null,
      turnId: opts.turnId,
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      retentionClass,
      commit,
      sizeBytes,
    };

    this.checkpoints.set(id, checkpoint);
    this.retentionPolicy.register({
      id,
      createdAt: checkpoint.createdAt,
      sizeBytes,
      retentionClass,
      path: this.sideGit.gitDir,
    });
    await this.persistManifest();

    logger.debug('WorkspaceCheckpointManager.create: checkpoint created', { id, kind, parentId: checkpoint.parentId });
    return checkpoint;
  }

  /** List checkpoints, newest-first. `list()[0]` is always the most recent checkpoint. */
  async list(filter?: ListCheckpointsFilter): Promise<WorkspaceCheckpoint[]> {
    await this.init();
    await this.reloadIfWrittenElsewhere();
    let results = Array.from(this.checkpoints.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (filter?.kind) results = results.filter((c) => c.kind === filter.kind);
    if (filter?.sessionId) results = results.filter((c) => c.sessionId === filter.sessionId);
    if (filter?.since != null) results = results.filter((c) => c.createdAt >= filter.since!);
    if (filter?.limit != null) results = results.slice(0, filter.limit);
    return results;
  }

  /**
   * Diff two checkpoints, or a checkpoint against the live working tree when
   * `b` is omitted.
   *
   * Serialized against every other index-touching operation on this manager
   *, see `withLock`. The single-argument form (`b` omitted, diffing against
   * the live working tree) stages the work tree into the side index first, so
   * it is not purely read-only.
   */
  async diff(a: string, b?: string): Promise<CheckpointDiff> {
    await this.init();
    return this.withLock(() => this.diffObservations.read(['checkpoint', a, b ?? 'WORKING'], () => this.diffInternal(a, b)));
  }

  private async diffInternal(a: string, b?: string): Promise<CheckpointDiff> {
    const fromCheckpoint = this.requireCheckpoint(a);
    const toCheckpoint = b ? this.requireCheckpoint(b) : undefined;
    // The one-argument form compares against the side index, which only knows
    // files staged by an earlier snapshot; stage first so files created since
    // are listed. A refused root is never swept.
    if (!toCheckpoint && !this.rootRefusal) await this.sideGit.stageAll();

    const [unifiedDiff, stat_, files] = await Promise.all([
      this.sideGit.diff(fromCheckpoint.commit, toCheckpoint?.commit),
      this.sideGit.diffStat(fromCheckpoint.commit, toCheckpoint?.commit),
      this.sideGit.diffNameOnly(fromCheckpoint.commit, toCheckpoint?.commit),
    ]);

    return {
      from: a,
      to: b ?? 'WORKING',
      files,
      unifiedDiff,
      stat: stat_,
    };
  }

  /**
   * Aggregate the file changes a single session made, the "what changed in
   * this session" surface a remote view needs, one diff spanning every
   * turn/agent snapshot stamped with `sessionId` (see
   * {@link computeSessionChanges} for the base/latest selection and the honest
   * empty result for a session with no stamped checkpoints). Both endpoints are
   * committed side-repo trees, so this is a pure two-tree diff; it still takes
   * the lock to stay consistent with a concurrent create()/gc().
   */
  async sessionChanges(sessionId: string): Promise<CheckpointSessionChanges> {
    await this.init();
    return this.withLock(() => this.diffObservations.read(['session', sessionId], () => computeSessionChanges(this.checkpoints, this.sideGit, sessionId)));
  }

  /**
   * Restore the workspace to the state captured by checkpoint `id`.
   *
   * By default (`safetyCheckpoint: true`) takes a checkpoint of the CURRENT
   * state first, so a restore is itself undoable via another restore.
   *
   * Whole-workspace restore (no `opts.paths`):
   *   1. Snapshot the current tracked-file set (via the safety checkpoint, or
   *      a transient write-tree when `safetyCheckpoint: false`), this is the
   *      "before" set.
   *   2. Reset the side index to the target checkpoint's tree and check every
   *      file in it out to disk (re-creates anything the checkpoint had that
   *      is currently missing or modified).
   *   3. Remove exactly the files that were in the "before" set but are NOT
   *      in the target checkpoint's tree (files created/tracked after the
   *      checkpoint). Anything NOT in the "before" set, i.e. any untracked
   *      path outside what this engine has ever snapshotted, is never
   *      touched, by construction: it never appears in either set.
   *
   * Scoped restore (`opts.paths` provided) only checks out those paths from
   * the target tree; it never removes files outside the given paths.
   *
   * Serialized against every other index-touching operation on this manager
   *, see `withLock`. Without this, an auto-snapshot `create()` firing on a
   * bus event could run its `git add -A` in between the `read-tree --reset`
   * and `checkout-index -a -f` calls below, silently corrupting the restore.
   */
  async restore(id: string, opts?: RestoreOptions): Promise<RestoreResult> {
    // An empty list is not "no scope": treating it as a whole-workspace restore
    // would rewrite and delete files for a caller that selected nothing.
    if (opts?.paths && opts.paths.length === 0) {
      throw new RefusalError(refusal({
        code: 'INVALID_ARGUMENT',
        state: 'nothing was restored',
        reason: 'The restore scope `paths` is an empty list',
        next: ['Name at least one path to restore, or omit paths to restore the whole workspace'],
        status: 400,
      }));
    }
    await this.init();
    return this.withLock(() => this.restoreInternal(id, opts));
  }

  private async restoreInternal(id: string, opts?: RestoreOptions): Promise<RestoreResult> {
    const target = this.requireCheckpoint(id);
    const wantSafety = opts?.safetyCheckpoint ?? true;

    let beforeFiles: string[];
    let safetyCheckpointId: string | null = null;
    if (wantSafety) {
      // Calls createInternal directly (not the public, lock-acquiring
      // `create()`), this whole method already holds the lock.
      const safety = await this.createInternal({ kind: 'manual', label: `pre-restore safety (before ${id})`, retentionClass: 'forensic' });
      // A null safety means the tree already equals the most recent
      // checkpoint, which is then the undo point.
      const current = safety ?? this.mostRecentCheckpoint();
      safetyCheckpointId = current?.id ?? null;
      beforeFiles = current ? await this.sideGit.listTrackedFiles(current.commit) : [];
    } else {
      await this.sideGit.stageAll();
      const transientTree = await this.sideGit.writeTree();
      beforeFiles = await this.sideGit.listTrackedFiles(transientTree);
    }

    try {
      return await applyRestore(this.sideGit, this.root, target, safetyCheckpointId, beforeFiles, opts?.paths);
    } catch (error) {
      if (safetyCheckpointId === null) throw error;
      throw new CheckpointRestoreError(id, safetyCheckpointId, error);
    }
  }

  /**
   * Apply retention limits: `RetentionPolicy` selects prune candidates, their
   * records leave the index and the index is saved, then their refs are
   * deleted, then (only if anything was actually deleted) a single
   * `git gc --prune=now` reclaims the now-unreachable objects. Saving the
   * index first means a crash in between leaves only unlisted refs, which the
   * next sweep deletes, never a listed checkpoint whose snapshot is gone. This never touches compaction's boundary commits,
   * they are tracked in an entirely separate `RetentionPolicy` instance
   * (../../runtime/compaction) with no shared state.
   *
   * Reclamation only works because checkpoint commits are parentless (see
   * `SideGitRunner.commitTree`): a pruned ref's commit has no descendant
   * keeping it reachable via a git parent pointer, so once its ref is
   * deleted it is genuinely unreachable and `--prune=now` frees it.
   *
   * Serialized against every other index/object-store-touching operation on
   * this manager, see `withLock`. Without this, a `create()` racing this
   * method could write a loose commit object that isn't ref'd yet at the
   * moment `--prune=now` runs, and lose it.
   */
  async gc(): Promise<CheckpointPruneResult> {
    await this.init();
    const result = await this.withLock(() => this.gcInternal());
    const failed = result.failedIds.length;
    if (failed > 0) {
      const first = result.errors[result.failedIds[0]!] ?? 'unknown error';
      this.recordRetentionFailure(`${failed} pruned checkpoint snapshot(s) could not be deleted from the side repository (first error: ${first}); they are no longer listed and the next sweep deletes them`);
    } else {
      this.lastRetentionFailure = null;
    }
    return result;
  }

  private async gcInternal(): Promise<CheckpointPruneResult> {
    const ids = this.retentionPolicy.candidates().map((record) => record.id);
    if (ids.length > 0) {
      for (const id of ids) {
        this.checkpoints.delete(id);
        this.retentionPolicy.unregister(id);
      }
      await this.persistManifest();
    }
    const result = await deleteCheckpointRefs(this.sideGit, ids);
    // Refs the index does not list are unrestorable and keep their objects
    // alive; only sweep them when the index was read successfully under this
    // lock. Refs that just failed above are not retried in the same sweep.
    const orphans = this.manifestReadOk
      ? await deleteUnlistedRefs(this.sideGit, new Set([...this.checkpoints.keys(), ...result.failedIds]))
      : 0;
    if (result.deletedIds.length > 0 || orphans > 0) await this.sideGit.gc();
    return result;
  }

  /** Unsubscribe from the runtime bus. Does not touch anything on disk. */
  dispose(): void {
    this.diffObservations.clear();
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // best-effort
      }
    }
    this.unsubscribers.length = 0;
  }

  /** After the owner stops new calls, unsubscribe and drain accepted init/git work. */
  async drain(): Promise<void> {
    this.dispose();
    if (this.initPromise) await this.init().catch(() => {});
    this.dispose(); // Initialization may have subscribed after the first dispose.
    let pending: Promise<void>;
    do { pending = this.lockChain; await pending; } while (pending !== this.lockChain);
    this.diffObservations.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Before the FIRST-ever whole-workspace snapshot for this store, refuse if
   * the sweep would capture more than `maxFirstSnapshotFiles` files, a cheap
   * `ls-files`-style enumeration (no blobs written), not a full stage. This
   * catches an over-broad root (e.g. a home directory) before it materializes
   * a large object store, rather than proceeding silently. Only the first
   * snapshot is checked (a store with existing checkpoints has already proven
   * its root is sane), and only whole-workspace sweeps (a scoped `paths` create
   * is bounded by construction). The `allowLargeFirstSnapshot` override skips it.
   */
  private async guardFirstSnapshotSize(opts: CreateCheckpointOptions): Promise<void> {
    if (this.allowLargeFirstSnapshot) return;
    if (this.checkpoints.size > 0) return;
    if (opts.paths && opts.paths.length > 0) return;
    const count = await this.sideGit.countFirstSnapshotFiles();
    if (count > this.maxFirstSnapshotFiles) {
      throw new Error(firstSnapshotTooLargeMessage(this.root, count, this.maxFirstSnapshotFiles));
    }
  }

  private mostRecentCheckpoint(): WorkspaceCheckpoint | null {
    let latest: WorkspaceCheckpoint | null = null;
    for (const checkpoint of this.checkpoints.values()) {
      if (!latest || checkpoint.createdAt > latest.createdAt) {
        latest = checkpoint;
      }
    }
    return latest;
  }

  private requireCheckpoint(id: string): WorkspaceCheckpoint {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) {
      throw new Error(`WorkspaceCheckpointManager: no checkpoint found with id "${id}"`);
    }
    return checkpoint;
  }

  private defaultLabel(kind: CheckpointKind, id: string): string {
    if (kind === 'manual') return id;
    return `${kind} snapshot`;
  }

  /**
   * Approximate incremental bytes introduced by a checkpoint: sum of on-disk
   * sizes of the changed paths, read immediately after they were staged and
   * committed (so they still reflect exactly the content just captured).
   * Deleted paths (no longer on disk) contribute 0. This is deliberately not
   * exact git object-store accounting, it exists for retention's `maxSizeBytes`
   * bookkeeping, not for a byte-perfect audit.
   */
  private async computeSizeBytes(paths: string[]): Promise<number> {
    let total = 0;
    for (const path of paths) {
      const absolute = join(this.root, path);
      if (!existsSync(absolute)) continue;
      try {
        const info = await stat(absolute);
        if (info.isFile()) total += info.size;
      } catch {
        // Ignore races (file removed between listing and stat).
      }
    }
    return total;
  }

  /**
   * Load the manifest, moving it aside instead of failing when it cannot be
   * parsed.
   *
   * An index.json left unreadable by an unclean shutdown must not wedge the
   * whole checkpoint feature: the file is quarantined with a receipt and the
   * manager starts from an empty index, which the next save rewrites. Only the
   * index is lost, the checkpoint commits themselves stay in the side repo and
   * remain reachable by ref.
   */
  private async loadManifestOrQuarantine(): Promise<Manifest | null> {
    const source = captureQuarantineSource(this.manifestPath); if (!source) return null;
    try {
      try { const loaded = await this.manifestStore.load(source); source.assertCurrent(); return validateCheckpointManifest(loaded); }
      catch (error) {
        source.assertCurrent();
        if (!(error instanceof JsonFileStoreParseError) && !(error instanceof CheckpointManifestShapeError)) throw error;
        this.manifestQuarantined = true;
        quarantineCorruptFile(this.manifestPath, { source,
          label: 'workspace/checkpoints', reason: 'checkpoint index JSON or metadata shape is invalid',
          recovery: 'The checkpoint index was rebuilt from the snapshot refs in the side repo; labels, parents and sizes of those checkpoints were not recoverable',
        });
        return null;
      }
    } finally { source.close(); }
  }

  /**
   * Replace the in-memory index (and retention's view of it) with the manifest
   * on disk. Under the lock an unreadable or missing manifest keeps the
   * in-memory index, which the next save writes back, rather than forgetting it.
   */
  private async reloadManifest(): Promise<void> {
    let manifest: Manifest | null;
    const signature = await this.readManifestSignature();
    if (!this.initialized) { manifest = await this.loadManifestOrQuarantine(); this.manifestReadOk = true; }
    else {
      try { const raw = await this.manifestStore.load(); manifest = raw === null ? null : validateCheckpointManifest(raw); this.manifestReadOk = true; } catch { manifest = null; this.manifestReadOk = false; }
      if (!manifest) return;
    }
    this.manifestSignature = signature;
    this.applyManifest(manifest);
  }

  /**
   * Bring the in-memory index up to date when another process sharing this
   * store saved the manifest: one `stat`, and a read only when the file
   * changed. Takes no lock (a save is an atomic rename). The result is applied
   * only if no locked operation started meanwhile; such an operation reloads
   * under the lock itself, and its in-progress records must not be replaced.
   */
  private async reloadIfWrittenElsewhere(): Promise<void> {
    if (this.operationsInFlight > 0) return;
    const started = this.operationsStarted;
    const signature = await this.readManifestSignature();
    if (signature === null || signature === this.manifestSignature) return;
    let manifest: Manifest;
    try {
      const raw = await this.manifestStore.load();
      if (raw === null) return;
      manifest = validateCheckpointManifest(raw);
    } catch {
      return; // the next locked operation reads it and keeps the index meanwhile
    }
    if (this.operationsInFlight > 0 || this.operationsStarted !== started) return;
    this.manifestSignature = signature;
    this.applyManifest(manifest);
  }

  private async readManifestSignature(): Promise<string | null> {
    try {
      const info = await stat(this.manifestPath);
      return `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch {
      return null;
    }
  }

  private applyManifest(manifest: Manifest | null): void {
    const loaded = new Map((manifest?.checkpoints ?? []).map((c) => [c.id, c]));
    for (const id of this.checkpoints.keys()) if (!loaded.has(id)) this.retentionPolicy.unregister(id);
    this.checkpoints = loaded;
    for (const c of loaded.values()) {
      this.retentionPolicy.register({ id: c.id, createdAt: c.createdAt, sizeBytes: c.sizeBytes, retentionClass: c.retentionClass, path: this.sideGit.gitDir });
    }
  }

  /** After a quarantined index, list the snapshot refs still in the side repo again instead of leaving them unreachable. */
  private async adoptUnlistedRefs(): Promise<void> {
    const release = await this.acquireStoreLock();
    try {
      const records = await recordsForUnlistedRefs(this.sideGit, new Set(this.checkpoints.keys()), this.now);
      if (records.length === 0) return;
      for (const c of records) {
        this.checkpoints.set(c.id, c);
        this.retentionPolicy.register({ id: c.id, createdAt: c.createdAt, sizeBytes: c.sizeBytes, retentionClass: c.retentionClass, path: this.sideGit.gitDir });
      }
      await this.persistManifest();
      logger.warn('WorkspaceCheckpointManager: re-listed checkpoint refs after the index was quarantined', { count: records.length });
    } finally {
      release();
    }
  }

  private async persistManifest(): Promise<void> {
    await this.manifestStore.save({ checkpoints: Array.from(this.checkpoints.values()) });
    this.manifestSignature = await this.readManifestSignature();
  }
}
