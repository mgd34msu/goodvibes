/**
 * client.ts, the platform session-spine surface client.
 *
 * The in-process coordinator that mirrors a surface's OWN session identity
 * (create / resume / heartbeat / close) into the daemon-hosted session spine.
 * It sits NEXT TO a surface's local session truth, never replacing it: the local
 * store stays the offline read-model; this client mirrors identity to the daemon
 * and buffers ops when the daemon is unreachable.
 *
 * This is the ONE core extracted from two near-twin implementations, the TUI's
 * typed-client version (`goodvibes-tui` src/runtime/session-spine-client.ts) and
 * the agent's raw-REST version (`goodvibes-agent` src/runtime/session-spine-client.ts).
 * The union of their behaviors is the spec; their differences are parameterized:
 *
 *  - TRANSPORT is injected. The core builds a canonical
 *    {@link RegisterSharedSessionInput} and hands it to an injected
 *    {@link SpineTransport}; the adapter performs the real wire call (a typed platform
 *    sessions client, or a hand-rolled version-tolerant REST mirror) and folds its
 *    result into a {@link SpineResult}. The core NEVER assumes a typed client
 *    exists, that is exactly why the agent, which compiles against a pinned npm
 *    platform that may predate `sessions.register`, can still use this core.
 *  - ACTIVATION MODE is optional. Construct WITH a `transport` for
 *    live-immediately mode (the agent, live for the whole process lifetime), or
 *    WITHOUT one for dormant-until-`activate()` mode (the TUI, activated once its
 *    bootstrap adopts a compatible external daemon, deactivated when the mode is
 *    lost).
 *  - PARTICIPANT identity, origin `kind`, queue bound and heartbeat window are
 *    options with the verified defaults.
 *
 * Discipline (load-bearing for the interactive-latency budget):
 *  - Every public method (register / reopen / heartbeat / close /
 *    foldLegacyRecords) is fire-and-forget: it returns SYNCHRONOUSLY and never
 *    throws into the caller, even when the wire call rejects. (foldLegacyRecords
 *    returns a never-rejecting promise of whether the fold reached the daemon,
 *    which is what gates the fold's completion marker.) Session
 *    start/resume/heartbeat never block the render or turn path.
 *  - Before a transport is attached every op is queued, never dropped-on-the-floor
 *    and never attempted over a transport that does not exist. Attaching flushes
 *    the backlog.
 *  - Offline ops go into a bounded ring (drop-oldest) holding at most one
 *    register per session (later ones merge into it); flush is idempotent
 *    because register is an upsert, and stops at the first op the daemon
 *    cannot take so the rest keep their order.
 *  - Heartbeat is debounced/coalesced to at most one wire call per window and omits
 *    the title so it never renames a titled session.
 *  - A timer-driven keepalive fires the heartbeat on a fixed cadence INDEPENDENT of
 *    render/turn activity, so a live-but-idle surface keeps its participant
 *    lastSeenAt fresh and never falls outside the daemon's freshness/reaper windows.
 */

import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';
import type {
  RegisterSharedSessionInput,
  SharedSessionKind,
  SharedSessionParticipant,
} from '../../control-plane/index.js';

/**
 * The canonical TUI participant (TRANSPORT axis). Pass as the `participant` option
 * when the surface is the operator terminal UI.
 */
export const TUI_SPINE_PARTICIPANT: Omit<SharedSessionParticipant, 'lastSeenAt'> = {
  surfaceKind: 'tui',
  surfaceId: 'surface:tui',
  displayName: 'Terminal UI',
};

/**
 * The canonical agent participant (TRANSPORT axis). `surfaceKind` stays 'service';
 * the record origin `kind` ('agent') is stamped by the REST mirror server-side, not
 * here, so the agent leaves `recordKind` unset.
 */
export const AGENT_SPINE_PARTICIPANT: Omit<SharedSessionParticipant, 'lastSeenAt'> = {
  surfaceKind: 'service',
  surfaceId: 'surface:goodvibes-agent',
  displayName: 'GoodVibes Agent',
};

/** Honest reachability posture derived from this client's own wire attempts. */
export type SpineReachability = 'unknown' | 'online' | 'offline';

/**
 * Outcome of a single injected-transport op, folding the two real backends' result
 * vocabularies into one common core:
 *  - `'ok'`      , the daemon applied it. Reachability → online; flush the queue.
 *  - `'offline'` , a transient connectivity fault (host unreachable). Reachability
 *                   → offline; enqueue for idempotent replay on reconnect.
 *  - `'rejected'`, a DURABLE refusal (auth required / route missing / server error).
 *                   NOT a connectivity fault: logged, NEVER enqueued (so it can't
 *                   retry-forever), reachability left unchanged.
 */
export type SpineOutcome = 'ok' | 'offline' | 'rejected';

export interface SpineResult {
  readonly outcome: SpineOutcome;
  readonly error?: string | undefined;
  /**
   * Set on a `rejected` register the daemon answered with "this session is
   * closed here". The daemon is reachable and holds the session, so it is not
   * a failure to retry; it is a disagreement between this surface and the daemon.
   */
  readonly conflict?: 'closed' | undefined;
}

/**
 * The injected async transport. Structurally satisfied by a thin adapter over the
 * platform's typed HTTP sessions client (TUI) or over a hand-rolled REST mirror (agent).
 * The core only ever calls these two methods and reads the folded {@link SpineResult}.
 */
export interface SpineTransport {
  register(input: RegisterSharedSessionInput): Promise<SpineResult>;
  close(sessionId: string): Promise<SpineResult>;
}

export interface SessionSpineRecord {
  readonly sessionId: string;
  readonly project: string;
  readonly title?: string | undefined;
  readonly userId?: string | undefined;
}

interface QueuedOp {
  readonly type: 'register' | 'close';
  readonly sessionId: string;
  readonly input?: RegisterSharedSessionInput;
  /** Fold closes only: the session's register count when queued. A flush that already took the op
   * out of its queue skips it when the session was registered again since. */
  readonly registeredAt?: number;
  /** Told once whether the daemon took the op (`ok` or a durable refusal) or it was dropped. */
  readonly onSettled?: ((applied: boolean) => void) | undefined;
}

/**
 * One queued register per session is enough: a later one carries the same
 * identity with a fresher lastSeenAt. The merge keeps a title and a reopen
 * flag from either, so a burst of heartbeats cannot evict the titled
 * registration or the reopen they follow.
 */
function mergeRegisterInputs(older: RegisterSharedSessionInput, newer: RegisterSharedSessionInput): RegisterSharedSessionInput {
  const title = newer.title ?? older.title;
  return {
    ...older,
    ...newer,
    ...(title !== undefined ? { title } : {}),
    ...(older.reopen || newer.reopen ? { reopen: true } : {}),
  };
}

/**
 * The injected log sink. `warn` is OPTIONAL rather than required: surfaces
 * outside this repo already construct `{ debug, info }` literals for this slot
 * against a published platform, and making `warn` mandatory would break every one of
 * them at compile time for the sake of one disclosure line. Call it through
 * {@link spineWarn}, which falls back to `info` when a caller supplied a
 * two-method sink; the default sink (the real `logger`) always has `warn`.
 */
type SpineLogger = Pick<typeof logger, 'debug' | 'info'> & Partial<Pick<typeof logger, 'warn'>>;

/** Disclose at warn level when the sink has one, otherwise at info, never silently. */
function spineWarn(log: SpineLogger, message: string, data?: Record<string, unknown>): void {
  if (log.warn) log.warn(message, data);
  else log.info(message, data);
}

export interface SessionSpineClientOptions {
  /**
   * The participant identity stamped onto every register/heartbeat (TRANSPORT axis).
   * Required, each surface passes its own (e.g. {@link TUI_SPINE_PARTICIPANT} /
   * {@link AGENT_SPINE_PARTICIPANT}).
   */
  readonly participant: Omit<SharedSessionParticipant, 'lastSeenAt'>;
  /**
   * Attach the transport at construction for LIVE-IMMEDIATELY mode (the agent is
   * live for the whole process lifetime). Omit for DORMANT-UNTIL-`activate()` mode
   * (the TUI activates once its bootstrap adopts a compatible external daemon).
   */
  readonly transport?: SpineTransport | undefined;
  /**
   * Origin record `kind` stamped into every built input. The TUI stamps `'tui'`;
   * the agent leaves it unset (its REST mirror stamps `'agent'` server-side).
   */
  readonly recordKind?: SharedSessionKind | undefined;
  /**
   * Optional reachability probe backing {@link SessionSpineClient.probeReachability}
   * (the agent's deferred-startup GET /status). Returns true when the host answered.
   * Omitted for the TUI (whose reachability rides its wire calls). Runs OFF the
   * interactive path.
   */
  readonly probe?: (() => Promise<boolean>) | undefined;
  readonly now?: () => number;
  readonly queueLimit?: number;
  readonly heartbeatMinIntervalMs?: number;
  readonly log?: SpineLogger;
}

const DEFAULT_QUEUE_LIMIT = 128;
const DEFAULT_HEARTBEAT_MIN_INTERVAL_MS = 45_000;

export class SessionSpineClient {
  private readonly participant: Omit<SharedSessionParticipant, 'lastSeenAt'>;
  private readonly recordKind: SharedSessionKind | undefined;
  private readonly probeImpl: (() => Promise<boolean>) | undefined;
  private readonly now: () => number;
  private readonly queueLimit: number;
  private readonly heartbeatMinIntervalMs: number;
  private readonly log: SpineLogger;

  private transport: SpineTransport | null = null;
  private reachability: SpineReachability = 'unknown';
  private readonly records = new Map<string, RegisterSharedSessionInput>();
  private readonly queue: QueuedOp[] = [];
  /**
   * The legacy fold's ops. Kept apart from the bounded ring, whose drop-oldest
   * would evict a large fold wholesale; it is finite (one store's records) and
   * drained after the live ops.
   */
  private readonly foldQueue: QueuedOp[] = [];
  /** Throttle window and trailing timer are per session: one session's beat must not swallow another's. */
  private readonly lastHeartbeatAt = new Map<string, number>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions the daemon already told us are closed there; warned once, not on every beat. */
  private readonly closedOnDaemon = new Set<string>();
  /** Per session, how many times this surface registered or reopened it. */
  private readonly registerCount = new Map<string, number>();
  private flushing = false;
  /** The most recently registered/reopened session, the keepalive heartbeat target. */
  private lastSessionId: string | null = null;
  /**
   * Timer-driven keepalive: fires the heartbeat on a fixed cadence INDEPENDENT of
   * render/turn activity, so a live-but-render-silent surface keeps its participant
   * lastSeenAt fresh. Each tick is just a heartbeat() call, so it rides the SAME
   * bounded offline-queue/reconnect handling as every other op, no new retry loop,
   * no faster-than-cadence attempts against a dead daemon.
   */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionSpineClientOptions) {
    this.participant = options.participant;
    this.recordKind = options.recordKind;
    this.probeImpl = options.probe;
    this.now = options.now ?? (() => Date.now());
    this.queueLimit = Math.max(1, options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
    this.heartbeatMinIntervalMs = Math.max(0, options.heartbeatMinIntervalMs ?? DEFAULT_HEARTBEAT_MIN_INTERVAL_MS);
    this.log = options.log ?? logger;
    // Live-immediately mode: a transport supplied at construction starts the
    // keepalive now and is live for the whole process lifetime (no activate step).
    if (options.transport) {
      this.transport = options.transport;
      this.startKeepalive();
    }
  }

  /** Honest reachability: 'unknown' until a wire call resolves, then online/offline. */
  status(): SpineReachability {
    return this.reachability;
  }

  /** Whether a transport is currently attached. */
  get active(): boolean {
    return this.transport !== null;
  }

  /** Ops waiting for the daemon: the bounded offline queue plus any unfinished legacy fold (for diagnostics / tests). */
  get pendingOps(): number {
    return this.queue.length + this.foldQueue.length;
  }

  /** The session the keepalive heartbeat currently targets (diagnostics/tests). */
  get keepaliveSessionId(): string | null {
    return this.lastSessionId;
  }

  /**
   * The CANONICAL "which wire rows are mine" set: every sessionId this client
   * has register()/reopen()'d and not yet close()'d, regardless of whatever id
   * a caller's own local store separately uses for the same conceptual
   * session. register()/reopen() send exactly the `sessionId` the caller
   * passes in, this client never assumes that string also matches a local
   * broker's own idea of the session's id. A cross-surface read facade (the
   * platform's SessionUnionCache) uses this to recognize its own wire mirror by
   * the id ACTUALLY SENT, not by hoping a local reader's id happens to agree.
   */
  get mirroredSessionIds(): ReadonlySet<string> {
    return new Set(this.records.keys());
  }

  /**
   * DORMANT-MODE activation: attach the transport once a compatible external daemon
   * has been adopted. Flushes anything queued while dormant, starts the keepalive.
   * Reachability stays 'unknown' until the first wire call resolves.
   */
  activate(transport: SpineTransport): void {
    this.transport = transport;
    this.log.info('session spine activated, mirroring session identity to the adopted external daemon', {});
    this.startKeepalive();
    void this.flush();
  }

  /**
   * Detach the transport (daemon mode resolved to non-external, or was lost). Ops
   * continue to be queued (bounded, drop-oldest) rather than dropped.
   */
  deactivate(reason: string): void {
    if (this.transport === null) return;
    this.transport = null;
    this.reachability = 'unknown';
    this.stopKeepalive();
    this.log.info('session spine deactivated', { reason });
  }

  /** CREATE: fire-and-forget initial registration (title stamped once). */
  register(record: SessionSpineRecord): void {
    this.cacheHeartbeatRecord(record);
    this.dispatchRegister(this.buildInput(record, { includeTitle: true }));
  }

  /** RESUME: fire-and-forget reopen (reopen:true, no title), the only reopen path. */
  reopen(record: SessionSpineRecord): void {
    this.cacheHeartbeatRecord(record);
    this.closedOnDaemon.delete(record.sessionId);
    this.dispatchRegister(this.buildInput(record, { includeTitle: false, reopen: true }));
  }

  /**
   * HEARTBEAT: debounced re-register, coalesced to one wire call per window, no title,
   * no reopen. Safe to call on every turn/render tick, internally a no-op unless the
   * window has elapsed.
   */
  heartbeat(sessionId: string): void {
    const cached = this.records.get(sessionId);
    if (!cached) return;
    const now = this.now();
    const last = this.lastHeartbeatAt.get(sessionId) ?? 0;
    if (now - last >= this.heartbeatMinIntervalMs) {
      this.lastHeartbeatAt.set(sessionId, now);
      this.dispatchRegister(this.withFreshLastSeen(cached));
      return;
    }
    if (this.heartbeatTimers.has(sessionId)) return; // already a trailing beat scheduled -> coalesced
    const delay = Math.max(0, this.heartbeatMinIntervalMs - (now - last));
    const timer = setTimeout(() => {
      this.heartbeatTimers.delete(sessionId);
      this.lastHeartbeatAt.set(sessionId, this.now());
      const rec = this.records.get(sessionId);
      if (rec) this.dispatchRegister(this.withFreshLastSeen(rec));
    }, delay);
    timer.unref?.();
    this.heartbeatTimers.set(sessionId, timer);
  }

  /** CLOSE: best-effort, fire-and-forget; tolerate a racing daemon stop. */
  close(sessionId: string): void {
    this.records.delete(sessionId);
    this.lastHeartbeatAt.delete(sessionId);
    this.closedOnDaemon.delete(sessionId);
    const trailing = this.heartbeatTimers.get(sessionId);
    if (trailing) {
      clearTimeout(trailing);
      this.heartbeatTimers.delete(sessionId);
    }
    if (this.lastSessionId === sessionId) this.lastSessionId = [...this.records.keys()].at(-1) ?? null;
    // A register for this session still waiting in the queue must reach the
    // daemon before the close does, or its later replay would reopen it.
    if (!this.transport || this.queue.some((op) => op.sessionId === sessionId)) {
      this.enqueue({ type: 'close', sessionId });
      void this.flush();
      return;
    }
    void this.runClose(sessionId);
  }

  /**
   * LEGACY FOLD: register each per-project record; a record whose id is in `closedIds`
   * is registered then closed so a locally-closed session STAYS closed in the daemon
   * (honest history). Idempotent, register is an upsert; closing an already-closed
   * record is a no-op.
   */
  foldLegacyRecords(records: readonly SessionSpineRecord[], closedIds: ReadonlySet<string>): Promise<boolean> {
    // Resolves once every fold op has reached the daemon (true) or one was
    // dropped (false); stays pending while no daemon is attached. Never rejects.
    let outstanding = 0;
    let allApplied = true;
    let resolveSettled: (allApplied: boolean) => void = () => {};
    const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
    const settle = (applied: boolean): void => {
      if (!applied) allApplied = false;
      outstanding -= 1;
      if (outstanding === 0) resolveSettled(allApplied);
    };
    for (const record of records) {
      outstanding += 1;
      this.foldQueue.push({ type: 'register', sessionId: record.sessionId, input: this.buildInput(record, { includeTitle: true }), onSettled: settle });
      if (closedIds.has(record.sessionId)) {
        outstanding += 1;
        this.foldQueue.push({ type: 'close', sessionId: record.sessionId, registeredAt: this.registerCount.get(record.sessionId) ?? 0, onSettled: settle });
      }
    }
    if (outstanding === 0) resolveSettled(true);
    void this.flush();
    return settled;
  }

  /** Reachability probe, runs OFF the interactive path (deferred startup). Flushes on
   * success. A no-op returning the current status when no `probe` option was supplied. */
  async probeReachability(): Promise<SpineReachability> {
    if (!this.probeImpl) return this.reachability;
    let reachable = false;
    try {
      reachable = await this.probeImpl();
    } catch {
      reachable = false;
    }
    if (reachable) {
      this.reachability = 'online';
      await this.flush();
    } else {
      this.reachability = 'offline';
    }
    return this.reachability;
  }

  /** Clears the pending heartbeat + keepalive timers; call on shutdown. */
  dispose(): void {
    for (const timer of this.heartbeatTimers.values()) clearTimeout(timer);
    this.heartbeatTimers.clear();
    this.stopKeepalive();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer !== null || this.heartbeatMinIntervalMs <= 0) return;
    this.keepaliveTimer = setInterval(() => {
      for (const sessionId of this.records.keys()) this.heartbeat(sessionId);
    }, this.heartbeatMinIntervalMs);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private cacheHeartbeatRecord(record: SessionSpineRecord): void {
    // Cache the title-less form so heartbeats never rename a titled session.
    this.records.set(record.sessionId, this.buildInput(record, { includeTitle: false }));
    // Track the newest session as the keepalive-heartbeat target.
    this.lastSessionId = record.sessionId;
  }

  private buildInput(
    record: SessionSpineRecord,
    opts: { readonly includeTitle: boolean; readonly reopen?: boolean },
  ): RegisterSharedSessionInput {
    const participant: SharedSessionParticipant = {
      ...this.participant,
      ...(record.userId ? { userId: record.userId } : {}),
      lastSeenAt: this.now(),
    };
    return {
      sessionId: record.sessionId,
      ...(this.recordKind ? { kind: this.recordKind } : {}),
      project: record.project,
      ...(opts.includeTitle && record.title ? { title: record.title } : {}),
      participant,
      ...(opts.reopen ? { reopen: true } : {}),
    };
  }

  private withFreshLastSeen(input: RegisterSharedSessionInput): RegisterSharedSessionInput {
    return { ...input, participant: { ...input.participant, lastSeenAt: this.now() } };
  }

  private dispatchRegister(input: RegisterSharedSessionInput): void {
    this.registerCount.set(input.sessionId, (this.registerCount.get(input.sessionId) ?? 0) + 1);
    this.dropFoldCloses(input.sessionId);
    if (!this.transport) {
      this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      return;
    }
    // A close for this session still waiting in the queue must reach the daemon
    // before this register does; sent first, the replayed close would shut a
    // session this surface just reopened.
    if (this.queue.some((op) => op.sessionId === input.sessionId)) {
      this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      void this.flush();
      return;
    }
    void this.runRegister(input);
  }

  /**
   * The fold drains after the live queue, so a fold close still waiting for a
   * session this surface has just (re)opened would shut it again. The reopen
   * supersedes the legacy "closed" history: drop those closes.
   */
  private dropFoldCloses(sessionId: string): void {
    for (let index = this.foldQueue.length - 1; index >= 0; index -= 1) {
      const op = this.foldQueue[index]!;
      if (op.type === 'close' && op.sessionId === sessionId) {
        this.foldQueue.splice(index, 1);
        op.onSettled?.(true);
      }
    }
  }

  private async runRegister(input: RegisterSharedSessionInput): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      return;
    }
    try {
      const result = await transport.register(input);
      // Detached while the call was out: this transport no longer speaks for
      // the spine, so its answer must not set reachability. A non-ok answer
      // still keeps the op for the next transport.
      if (this.transport !== transport) {
        if (result.outcome === 'offline') this.enqueue({ type: 'register', sessionId: input.sessionId, input });
        return;
      }
      if (result.outcome === 'ok') {
        this.reachability = 'online';
        await this.flush();
      } else if (result.outcome === 'offline') {
        this.reachability = 'offline';
        this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      } else if (result.conflict === 'closed') {
        // The daemon answered, so it is reachable, but it holds this session as closed.
        this.reachability = 'online';
        this.noteClosedOnDaemon(input.sessionId);
      } else {
        // Durable reject: honest local-only. Never claim online; do not queue (this is
        // not a transient connectivity fault, so it must not retry-forever).
        this.log.debug('session spine register not applied', { error: result.error });
      }
    } catch (error) {
      // Fire-and-forget contract: absorb everything. An unexpected transport throw is
      // treated as transient offline and queued for reconnect replay.
      if (this.transport === transport) this.reachability = 'offline';
      this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      this.log.debug('session spine register threw, queued for reconnect', { error: errorMessage(error) });
    }
  }

  private async runClose(sessionId: string): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      this.enqueue({ type: 'close', sessionId });
      return;
    }
    try {
      const result = await transport.close(sessionId);
      if (this.transport !== transport) {
        if (result.outcome === 'offline') this.enqueue({ type: 'close', sessionId });
        return;
      }
      if (result.outcome === 'ok') {
        this.reachability = 'online';
      } else if (result.outcome === 'offline') {
        this.reachability = 'offline';
        this.enqueue({ type: 'close', sessionId });
      } else {
        this.log.debug('session spine close not applied', { error: result.error });
      }
    } catch (error) {
      if (this.transport === transport) this.reachability = 'offline';
      this.enqueue({ type: 'close', sessionId });
      this.log.debug('session spine close threw, queued for reconnect', { error: errorMessage(error) });
    }
  }

  private noteClosedOnDaemon(sessionId: string): void {
    if (this.closedOnDaemon.has(sessionId)) return;
    this.closedOnDaemon.add(sessionId);
    spineWarn(this.log, 'session spine: the daemon holds this session as closed, so its identity is not mirrored as open', { sessionId });
  }

  private enqueue(op: QueuedOp): void {
    if (op.type === 'register' && op.input) {
      // Coalesce with this session's queued register when nothing for the
      // session sits after it (a close in between must keep its order).
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        const queued = this.queue[index]!;
        if (queued.sessionId !== op.sessionId) continue;
        if (queued.type === 'register' && queued.input) {
          this.queue[index] = { ...queued, input: mergeRegisterInputs(queued.input, op.input) };
          return;
        }
        break;
      }
    }
    if (this.queue.length >= this.queueLimit) this.queue.shift()?.onSettled?.(false); // drop-oldest
    this.queue.push(op);
  }

  /**
   * Replay queued ops in order: the live queue, then the legacy fold. The
   * first op the daemon cannot take (offline, or a throw) goes back with
   * everything after it, in order, and the flush stops; trying the rest
   * against an unreachable daemon would only reorder them.
   */
  private async flush(): Promise<void> {
    if (this.flushing || (this.queue.length === 0 && this.foldQueue.length === 0)) return;
    const transport = this.transport;
    if (!transport) return;
    this.flushing = true;
    try {
      // Ops queued while this flush runs are taken on the next pass.
      while (this.queue.length > 0 || this.foldQueue.length > 0) {
        for (const source of [this.queue, this.foldQueue]) {
          const pending = source.splice(0, source.length);
          for (let index = 0; index < pending.length; index += 1) {
            const op = pending[index]!;
            let result: SpineResult;
            try {
              if (op.type === 'register') {
                if (!op.input) {
                  op.onSettled?.(true);
                  continue;
                }
                result = await transport.register(op.input);
              } else {
                // A flush that took this fold close before the reopen cannot be reached by dropFoldCloses.
                if (op.registeredAt !== undefined && op.registeredAt !== (this.registerCount.get(op.sessionId) ?? 0)) {
                  op.onSettled?.(true);
                  continue;
                }
                result = await transport.close(op.sessionId);
              }
            } catch (error) {
              this.log.debug('session spine flush op threw, re-queued', { error: errorMessage(error) });
              result = { outcome: 'offline' };
            }
            const detached = this.transport !== transport;
            if (result.outcome === 'offline' || (detached && result.outcome !== 'ok')) {
              if (!detached) this.reachability = 'offline';
              // Ahead of anything queued while this flush ran, so order is kept.
              source.unshift(...pending.slice(index));
              return;
            }
            if (result.outcome === 'ok') {
              if (!detached) this.reachability = 'online';
            }
            // A durable refusal is dropped (never retried forever on the live path) but
            // is not "taken": a fold whose ops were refused must not write its marker.
            // A closed-session answer means the daemon holds the session, which is all
            // a fold needs.
            const refused = result.outcome === 'rejected' && result.conflict !== 'closed';
            if (result.outcome === 'rejected') {
              if (result.conflict === 'closed') this.noteClosedOnDaemon(op.sessionId);
              else this.log.debug('session spine flush op not applied', { error: result.error });
            }
            op.onSettled?.(!refused);
            if (detached) {
              source.unshift(...pending.slice(index + 1));
              return;
            }
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FoldLegacySpineStoreOptions {
  readonly storePath: string;
  readonly markerPath: string;
  readonly project: string;
  readonly now?: () => number;
  readonly log?: SpineLogger;
}

export interface FoldLegacySpineStoreResult {
  readonly folded: number;
  readonly skipped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The fold marker's schema version. A marker written by an OLDER schema reads as
 * "not folded" and the fold re-runs, the fold is an upsert-based register pass,
 * so repeating it costs one file read, never data. A marker written by a NEWER
 * schema is ACCEPTED: a later build already did at least this much work, and a
 * downgrade must not re-fold on every single boot.
 */
const FOLD_MARKER_SCHEMA_VERSION = 1;

/**
 * Has this surface's legacy store already been folded? Answered by PARSING the
 * marker, never by its existence.
 *
 * `existsSync(markerPath)` returns true for a zero-byte file, a truncated
 * object, and a page of NULs left behind by a crash between creating the marker
 * and finishing its write. Any of those used to suppress the fold forever,
 * stranding the user's legacy sessions outside the daemon with no way back. So
 * the marker must positively assert its own completion: a JSON object carrying a
 * known schema version and `completed: true`. Unreadable, empty, unparseable, an
 * array, a bare `true`, a missing flag, or an older schema all read as "not
 * folded" and the (idempotent, upsert-based) fold runs again, disclosed, with
 * the reason, rather than silently.
 */
function hasCompletedFold(markerPath: string, log: SpineLogger): boolean {
  let raw: string;
  try {
    if (!existsSync(markerPath)) return false;
    raw = readFileSync(markerPath, 'utf-8');
  } catch (error) {
    spineWarn(log, 'session spine legacy fold marker unreadable, folding again', {
      marker: markerPath,
      error: errorMessage(error),
    });
    return false;
  }
  if (raw.trim().length === 0) {
    spineWarn(log, 'session spine legacy fold marker is empty (interrupted write), folding again', { marker: markerPath });
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    spineWarn(log, 'session spine legacy fold marker is not parseable JSON (torn write), folding again', {
      marker: markerPath,
      bytes: raw.length,
    });
    return false;
  }
  if (!isRecord(parsed)) {
    spineWarn(log, 'session spine legacy fold marker is not an object, folding again', { marker: markerPath });
    return false;
  }
  if (parsed.completed !== true) {
    spineWarn(log, 'session spine legacy fold marker does not assert completion, folding again', { marker: markerPath });
    return false;
  }
  const version = parsed.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    spineWarn(log, 'session spine legacy fold marker has no usable schema version, folding again', { marker: markerPath });
    return false;
  }
  if (version < FOLD_MARKER_SCHEMA_VERSION) {
    spineWarn(log, 'session spine legacy fold marker was written by an older schema, folding again', {
      marker: markerPath,
      markerSchemaVersion: version,
      currentSchemaVersion: FOLD_MARKER_SCHEMA_VERSION,
    });
    return false;
  }
  return true;
}

/**
 * Write the fold marker with the content that makes it verifiable: schema
 * version, an explicit completion flag, when it ran, how many records it folded,
 * and which store they came from.
 *
 * Written to a sibling temp file and renamed into place, so an interruption
 * leaves either no marker at all (the fold retries next boot) or the complete
 * previous one, never a half-written file a later boot would trust. The temp
 * name is unique per call so two processes folding the same surface at once cannot
 * scribble over each other's partial file; publication is
 * atomic and both write the same completion assertion, so whichever lands last
 * is equally correct. A failed write is cleaned up by the shared writer and logged,
 * not thrown: the fold itself already succeeded, and a marker-less re-run is
 * safe.
 */
function writeCompletedFoldMarker(
  markerPath: string,
  body: { readonly migratedAt: number; readonly count: number; readonly source: string },
  log: SpineLogger,
): void {
  try {
    writeFileAtomic(
      markerPath,
      JSON.stringify(
        {
          schemaVersion: FOLD_MARKER_SCHEMA_VERSION,
          completed: true,
          migratedAt: body.migratedAt,
          count: body.count,
          source: body.source,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o644, durable: false },
    );
  } catch (err) {
    log.debug('session spine legacy fold marker write failed', { error: errorMessage(err) });
  }
}

/**
 * Reads a surface's OWN project-scoped control-plane sessions.json and folds each
 * record into the daemon via the client (register upsert; closed records also
 * closed). Writes a marker file so subsequent runs are a no-op. Register is
 * idempotent, so even a marker-less re-run is safe. Only folds the store for the
 * project it is invoked from, the per-project discovery scope is documented, not
 * silently "complete" across every project a surface has ever run in.
 *
 * The marker is validated by CONTENT on every boot (see {@link hasCompletedFold})
 * and written via temp-file-plus-rename (see {@link writeCompletedFoldMarker}), so
 * a crash mid-write can no longer leave a carcass that suppresses the fold
 * forever. An unreadable/absent legacy store still writes NO marker, so a later
 * run with a real store folds it.
 */
/** Marker paths whose fold has been queued and has not settled yet, in this process. */
const foldsInFlight = new Set<string>();

export function foldLegacySpineStore(
  client: {
    /** A client that returns a promise has the marker wait for it; one that returns nothing is taken at its word. */
    foldLegacyRecords(records: readonly SessionSpineRecord[], closedIds: ReadonlySet<string>): void | Promise<boolean>;
  },
  options: FoldLegacySpineStoreOptions,
): FoldLegacySpineStoreResult {
  const log = options.log ?? logger;
  if (hasCompletedFold(options.markerPath, log)) return { folded: 0, skipped: true };
  // A fold whose ops are still on their way to the daemon has not written its
  // marker yet; a second fold of the same store would only queue them twice.
  if (foldsInFlight.has(options.markerPath)) return { folded: 0, skipped: true };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.storePath, 'utf-8')) as unknown;
  } catch {
    // No store (or unreadable) -> nothing to fold; do not write a marker so a later
    // run with a real store still folds.
    return { folded: 0, skipped: false };
  }

  const sessions = isRecord(raw) && isRecord(raw.sessions) ? raw.sessions : {};
  const records: SessionSpineRecord[] = [];
  const closedIds = new Set<string>();
  for (const [key, value] of Object.entries(sessions)) {
    if (!isRecord(value)) continue;
    const sessionId = typeof value.id === 'string' && value.id.trim().length > 0 ? value.id : key;
    const title = typeof value.title === 'string' ? value.title : undefined;
    records.push({ sessionId, project: options.project, ...(title ? { title } : {}) });
    if (value.status === 'closed') closedIds.add(sessionId);
  }

  // The marker is written only once the daemon has taken every folded op. A
  // fold the process exits before finishing, or one an op of which was
  // dropped, leaves no marker and runs again (register is an upsert).
  const writeMarker = (): void => writeCompletedFoldMarker(
    options.markerPath,
    { migratedAt: (options.now ?? Date.now)(), count: records.length, source: options.storePath },
    log,
  );
  const settled = client.foldLegacyRecords(records, closedIds);
  if (settled instanceof Promise) {
    foldsInFlight.add(options.markerPath);
    void settled.then((allApplied) => {
      foldsInFlight.delete(options.markerPath);
      if (allApplied) writeMarker();
      else spineWarn(log, 'session spine legacy fold did not complete; it will run again', { source: options.storePath });
    });
  } else {
    writeMarker();
  }

  return { folded: records.length, skipped: false };
}
