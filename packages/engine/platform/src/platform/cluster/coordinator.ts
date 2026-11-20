/**
 * coordinator.ts, the one object a composition root wires up.
 *
 * A process has exactly ONE coordinator. Several inbound consumers register
 * with it, the platform daemon facade registers Telegram ingress and one gate per
 * ntfy topic; the goodvibes-tui daemon additionally registers one gate per
 * inbox provider, and each of them follows the leadership OF ITS OWN SURFACE.
 * Two coordinators in one process would be two nodes in the group arguing with
 * each other, so a composition that already has one passes it down rather than
 * making a second.
 *
 * What changed from the whole-node design: registering a gate no longer puts a
 * consumer under one global leader. It declares that this node can serve one
 * specific surface, which starts an election for that surface alone. A node
 * with a Telegram token and an ntfy topic contests both; a node with only the
 * topic contests only ntfy and leaves Telegram entirely alone. A node that
 * registers nothing contests nothing and claims nothing.
 *
 * With `cluster.enabled` false the coordinator degrades to exactly the
 * behavior that existed before it: every gate starts on start() and stops on
 * stop(), no sockets are opened, and nothing is broadcast anywhere.
 */
import { ClusterConsumerStopError, OwnedClusterDrainError } from './owned-drain-error.js';
import { ClusterElection } from './election-node.js';
import { ClusterSurfaceRegistry } from './surface-registry.js';
import { createSystemClusterClock } from './clock.js';
import { clusterElectionTiming } from './settings.js';
import { resolveNodeIdentity } from './identity.js';
import { surfaceIdFor, surfaceLabel, type ClusterSurfaceKey } from './surface-id.js';
import { CLUSTER_ROLE_NAMES, clusterRoleSurface, type ClusterRoleName } from './roles.js';
import { UdpClusterTransport } from './udp-transport.js';
import type {
  ClusterClock,
  ClusterConsumerGate,
  ClusterConsumerStartContext,
  ClusterLogger,
  ClusterSettings,
  ClusterStatus,
  ClusterSurfaceHolding,
  ClusterSurfaceStatus,
  ClusterTransport,
} from './types.js';

export interface ClusterCoordinatorOptions {
  readonly settings: ClusterSettings;
  readonly version: string;
  /** Daemon state directory; holds the persistent node id. */
  readonly stateDirectory: string;
  readonly logger: ClusterLogger;
  /** Test seam: an in-memory transport instead of a real socket. */
  readonly transport?: ClusterTransport | undefined;
  readonly clock?: ClusterClock | undefined;
  readonly nodeId?: string | undefined;
  readonly random?: (() => number) | undefined;
}

export class ClusterCoordinator {
  private readonly registry: ClusterSurfaceRegistry;
  private readonly clock: ClusterClock;
  /** Pending or failed owned retirements fence same-surface replacement. */
  private readonly ownedWithdrawals = new Map<string, Promise<void>>();
  private readonly ownedGateDrains = new Map<ClusterConsumerGate, { surfaceId: string; work: Promise<void> }>();
  /**
   * Resolved on first use, never in the constructor: resolving it MINTS AND
   * WRITES a file, and merely composing a runtime (which every test that
   * builds RuntimeServices does) must not touch the state directory.
   */
  private nodeIdValue: string | null = null;
  private election: ClusterElection | null = null;
  private transport: ClusterTransport | null = null;
  private started = false;
  /** The start in flight, which a second start() joins and stop() waits out. */
  private starting: Promise<void> | null = null;
  /** The stop in flight, which a second stop() joins. */
  private stopping: Promise<void> | null = null;
  /** The last of start() and stop() to be called; a start queued behind a stop honours it. */
  private wanted = false;
  /** Only meaningful with the election off: every gate runs unconditionally. */
  private ungatedRunning = false;
  /** Elections were on but the group could not be joined, so every gate runs. */
  private ungatedFallback = false;
  /** Run once at start(), before anything is contested. See `onPrepare`. */
  private readonly prepares: (() => Promise<void>)[] = [];

  constructor(private readonly options: ClusterCoordinatorOptions) {
    this.clock = options.clock ?? createSystemClusterClock();
    this.registry = new ClusterSurfaceRegistry(options.logger);
  }

  private get nodeId(): string {
    this.nodeIdValue ??= this.options.nodeId
      ?? resolveNodeIdentity({ stateDirectory: this.options.stateDirectory, logger: this.options.logger }).nodeId;
    return this.nodeIdValue;
  }

  get enabled(): boolean {
    return this.options.settings.enabled;
  }

  /**
   * True between `start()` and `stop()`.
   *
   * Read by anything that retries registering a surface in the background, a
   * Slack workspace whose identity would not resolve the first time, so it
   * stops retrying once the daemon is shutting down instead of registering
   * consumers into a coordinator that has already left the group.
   */
  get running(): boolean {
    return this.started;
  }

  /** True when this node holds at least one inbound surface. */
  get isMaster(): boolean {
    if (!this.options.settings.enabled) return this.started;
    return this.election?.isMaster ?? false;
  }

  /** True when this node currently holds the given surface. */
  holdsSurface(surface: ClusterSurfaceKey): boolean {
    if (!this.options.settings.enabled || this.ungatedFallback) return this.ungatedRunning;
    return this.election?.surfaceRole(surfaceIdFor(surface)) === 'master';
  }

  /**
   * True when this machine runs the role now (see roles.ts). With clustering
   * off, or when coordination could not be established, every role is held
   * here: there is nobody else to run it.
   */
  holdsRole(role: ClusterRoleName): boolean {
    if (!this.options.settings.enabled || this.ungatedFallback) return true;
    return this.election?.surfaceRole(surfaceIdFor(clusterRoleSurface(role))) === 'master';
  }

  /**
   * The node id of the machine that runs the role, as this machine's election
   * last heard it, or null when nobody is known to hold it (an election is
   * under way, or clustering is off and this machine holds it).
   */
  roleHolder(role: ClusterRoleName): string | null {
    if (!this.options.settings.enabled || this.ungatedFallback) return null;
    const surfaceId = surfaceIdFor(clusterRoleSurface(role));
    return this.election?.status().surfaces.find((surface) => surface.surfaceId === surfaceId)?.holderNodeId ?? null;
  }

  /**
   * The surfaces this node is currently consuming, and why, the answer
   * `ClusterGroupRuntimeOptions.surfaceHoldings` asks for.
   *
   * The per-surface election owns this fact, so the group layer is handed a
   * reader for it rather than keeping a second copy that could disagree with
   * the elections actually running. `null`, not an empty array, when there is
   * no election to ask, because "this node holds nothing" and "nobody can say
   * what this node holds" are different answers and `cluster status` prints
   * them differently.
   *
   * Every `surfaceId` here is already the digest the election routes on, never
   * a topic or chat id; the group layer validates the wire shape and preserves
   * this exact identity rather than deriving another one during inspection.
   */
  surfaceHoldings(): readonly ClusterSurfaceHolding[] | null {
    // Clustering off means this node consumes everything it can, ungated. That
    // is a real and reportable state, but it is not an election result, and
    // presenting it as one would put surfaces in `cluster status` that no
    // election ever awarded.
    if (!this.options.settings.enabled) return null;
    const election = this.election;
    if (!election) return null;
    return election.status().surfaces
      .filter((surface) => surface.role === 'master')
      .map((surface) => {
        const role = CLUSTER_ROLE_NAMES.find((name) => surfaceIdFor(clusterRoleSurface(name)) === surface.surfaceId);
        if (role) return { surfaceId: surface.surfaceId, reason: `elected for the ${role} role` };
        return {
          surfaceId: surface.surfaceId,
          reason: surface.consuming
            ? `elected for ${surface.kind} (${surface.label})`
            : `elected for ${surface.kind} (${surface.label}), consumer not yet running`,
        };
      });
  }

  /**
   * Register an inbound consumer for one surface. Returns an unregister
   * function.
   *
   * Registering while the node is already running starts that surface's
   * election immediately, so a consumer composed late, a topic added at
   * runtime, an account that finished authenticating, still comes up without
   * a restart.
   */
  register(gate: ClusterConsumerGate): () => void {
    const withdraw = this.registerConsumer(gate, false);
    return () => {
      void withdraw().catch(() => this.options.logger.error('cluster: consumer withdrawal failed'));
    };
  }

  /**
   * Owned registration: eligibility disappears synchronously and withdrawal
   * resolves only after the exact gate and its election retirement have drained.
   * Await it before registering a replacement for the same surface.
   */
  registerOwned(gate: ClusterConsumerGate): () => Promise<void> {
    return this.registerConsumer(gate, true);
  }

  private registerConsumer(gate: ClusterConsumerGate, strictDrain: boolean): () => Promise<void> {
    const surfaceId = surfaceIdFor(gate.surface);
    if (strictDrain && this.ownedWithdrawals.has(surfaceId)) {
      throw new Error('Owned cluster surface is still retiring: the consumer registered for it before has not '
        + 'finished stopping. Await that withdrawal before registering a replacement; if the withdrawal '
        + 'rejected, that consumer did not stop and only a daemon restart can serve this surface again');
    }
    let retired = false;
    let running = false;
    let stopping: Promise<void> | undefined;
    const starts = new Set<Promise<void>>();
    const drain = (reason: string): Promise<void> => {
      if (stopping) return stopping;
      if (!running && starts.size === 0) return Promise.resolve();
      const admitted = [...starts];
      const work = Promise.resolve().then(async () => {
        // Stop must begin now so it can cancel a pending start. A generic
        // gate may complete startup late; fence that completion with a final
        // stop before claiming this exact consumer has drained.
        await gate.stop(reason);
        await Promise.allSettled(admitted);
        if (admitted.length) await gate.stop(reason);
        running = false;
      }).catch((error: unknown) => {
        if (strictDrain) throw new OwnedClusterDrainError();
        throw error;
      });
      stopping = work;
      void work.then(() => { if (stopping === work) stopping = undefined; }, () => {
        // Legacy consumers historically restart after a failed stop. Only an
        // owned drain is sticky: it must remain fenced rather than claim repair.
        if (!strictDrain && stopping === work) stopping = undefined;
      });
      return work;
    };
    const owned: ClusterConsumerGate = { ...gate,
      start: (context) => {
        if (retired || stopping) return Promise.reject(new Error('Cluster consumer registration is retiring'));
        running = true;
        const work = Promise.resolve().then(() => {
          if (retired) return;
          return gate.start(context);
        }).catch((error: unknown) => {
          if (strictDrain) throw new Error('Owned cluster consumer failed to start');
          throw error;
        });
        starts.add(work);
        void work.then(() => starts.delete(work), () => starts.delete(work));
        return work;
      },
      stop: async (reason) => {
        await drain(reason);
        if (strictDrain) {
          // A previously removed sibling may still be stopping or may have
          // failed. Its raw drain, never its election retirement, is the fence
          // so sibling cleanup cannot form a promise cycle or emit false RESIGN.
          await Promise.all([...this.ownedGateDrains.entries()]
            .filter(([other, pending]) => other !== owned && pending.surfaceId === surfaceId)
            .map(([, pending]) => pending.work));
        }
      },
    };
    const unregister = strictDrain ? this.registry.registerOwned(owned) : this.registry.register(owned);
    if (this.ungatedRunning) {
      void this.startGateUngated(owned, {
        replayFromMs: null,
        reason: 'registered while this node was already consuming',
      });
    }
    let withdrawal: Promise<void> | undefined;
    return () => {
      if (withdrawal) return withdrawal;
      retired = true;
      const exactDrain = drain('consumer registration withdrawn');
      if (strictDrain) this.ownedGateDrains.set(owned, { surfaceId, work: exactDrain });
      const retirement = unregister();
      withdrawal = Promise.all([retirement, owned.stop('consumer registration withdrawn'),
        ...(strictDrain ? [this.ownedWithdrawals.get(surfaceId)] : [])]).then(() => {});
      if (strictDrain) {
        const pending = withdrawal;
        this.ownedWithdrawals.set(surfaceId, pending);
        void pending.then(() => {
          this.ownedGateDrains.delete(owned);
          if (this.ownedWithdrawals.get(surfaceId) === pending) this.ownedWithdrawals.delete(surfaceId);
        }, () => {}); // Failed retirement deliberately remains fenced.
      }
      // Legacy owners may deliberately ignore cleanup; rejection still remains
      // observable to an owned caller, without becoming an unhandled rejection.
      void withdrawal.catch(() => {});
      return withdrawal;
    };
  }

  /**
   * Register work that decides WHICH surfaces this node can serve, to run once
   * at `start()` before any election begins.
   *
   * It exists because that decision is asynchronous, a surface is servable
   * only if its credential actually resolves, and a `goodvibes://secrets/...`
   * reference resolves off disk, while composition roots are not. Registering
   * a surface after the boot probe would make it sit out its own first
   * election; guessing synchronously would let a node with an unresolvable
   * token win one and then read nothing.
   *
   * Several callers may add their own: a host that composes inbound consumers
   * of its own shares this coordinator rather than making a second one, and
   * each contributes the surfaces it knows about.
   */
  onPrepare(prepare: () => Promise<void>): void {
    this.prepares.push(prepare);
  }

  /**
   * Join the group and start contesting. A second call joins the start in
   * flight. A stop() that arrives meanwhile wins: each await below is followed
   * by a check, so nothing is started after the stop, and the stop waits for
   * this to reach one of those checks before tearing down what was built.
   */
  start(): Promise<void> {
    this.wanted = true;
    if (this.starting) return this.starting;
    if (this.started) return Promise.resolve();
    const work = this.runStart().finally(() => {
      if (this.starting === work) this.starting = null;
    });
    this.starting = work;
    return work;
  }

  private async runStart(): Promise<void> {
    if (this.stopping) {
      await this.stopping;
      // Another stop() joined that one after this start was asked for.
      if (!this.wanted) return;
    }
    this.started = true;
    this.ungatedFallback = false;
    // Said once per start: config get shows the stored value, the node runs this one.
    for (const adjustment of this.options.settings.adjustments ?? []) {
      this.options.logger.warn(`cluster: ${adjustment.key} is set to ${adjustment.configured}s but runs as ${adjustment.effective}s`, { reason: adjustment.reason });
    }
    for (const prepare of [...this.prepares]) {
      if (!this.started) return;
      try {
        await prepare();
      } catch (error) {
        // A surface that could not be resolved is a surface this node will not
        // contest. Said out loud, because the visible symptom otherwise is a
        // machine that quietly reads nothing.
        this.options.logger.error('cluster: could not work out which inbound surfaces this node can serve', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!this.started) return;

    if (!this.options.settings.enabled) {
      this.options.logger.debug('cluster: leader election is disabled; consuming on this node unconditionally');
      await this.startAllUngated('cluster.enabled is false');
      return;
    }

    this.transport = this.options.transport ?? new UdpClusterTransport({
      port: this.options.settings.port,
      multicastGroup: this.options.settings.multicastGroup,
      peers: this.options.settings.peers,
      logger: this.options.logger,
    });

    this.election = new ClusterElection({
      nodeId: this.nodeId,
      version: this.options.version,
      settings: this.options.settings,
      transport: this.transport,
      clock: this.clock,
      logger: this.options.logger,
      registry: this.registry,
      ...(this.options.random ? { random: this.options.random } : {}),
    });
    try {
      await this.election.start();
    } catch (error) {
      // The failed election already undid itself (ClusterElection.start).
      this.election = null;
      this.transport = null;
      // A stop during the failed join owns the teardown; consuming now would
      // start gates after it, with nothing left to stop them.
      if (!this.started) return;
      // Coordination could not be established at all, the socket would not
      // bind, or the transport threw. Consume anyway. A node that answers a
      // message twice is a nuisance; a network where NOBODY reads the inbox
      // is a user whose messages vanish, and that is strictly worse. Said at
      // error level so the cause is visible rather than inferred from silence.
      this.options.logger.error('cluster: could not join the local coordination group; consuming unconditionally', {
        error: error instanceof Error ? error.message : String(error),
        impact: 'if another goodvibes node is running on this network, an inbound message may be answered twice',
        action: `check that UDP port ${this.options.settings.port} is free, or set cluster.enabled false to silence this`,
      });
      this.ungatedFallback = true;
      await this.startAllUngated('coordination unavailable');
    }
  }

  stop(reason = 'shutdown'): Promise<void> {
    this.wanted = false;
    if (this.stopping) return this.stopping;
    if (!this.started) return Promise.resolve();
    this.started = false;
    // Captured now: a start() issued after this stop must not be waited on
    // here, because that start waits on this stop.
    const inFlightStart = this.starting;
    const work = this.runStop(reason, inFlightStart).finally(() => {
      if (this.stopping === work) this.stopping = null;
    });
    this.stopping = work;
    return work;
  }

  private async runStop(reason: string, inFlightStart: Promise<void> | null): Promise<void> {
    if (inFlightStart) await inFlightStart.catch(() => {});
    if (this.election) {
      // The election's own stop performs the ordered stop-then-RESIGN, per
      // surface.
      await this.election.stop(reason);
      this.election = null;
      this.transport = null;
      return;
    }
    if (this.ungatedRunning) await this.stopAllUngated(reason);
  }

  /** Wait for any in-flight transition, tests and orderly shutdown use it. */
  async settled(): Promise<void> {
    await this.election?.settled();
  }

  /**
   * A provider reported that something else is already consuming a surface
   * (Telegram's 409 on getUpdates is the live case). Never contest it.
   *
   * Pass the surface when it is known: a 409 from one bot token is not a
   * reason for this node to give up an unrelated ntfy topic.
   */
  reportConsumerConflict(detail: string, surface?: ClusterSurfaceKey): void {
    if (!this.election) return;
    if (surface) this.election.reportConsumerConflict(detail, surfaceIdFor(surface));
    else this.election.reportConsumerConflict(detail);
  }

  /** The `cluster` section of /status. Inspection only. */
  status(): ClusterStatus {
    if (this.election) return this.election.status();
    const surfaces: ClusterSurfaceStatus[] = this.registry.list().map((surface) => ({
      surfaceId: surface.surfaceId,
      label: surface.label,
      kind: surface.key.kind,
      role: this.ungatedRunning ? 'master' : 'stopped',
      holderNodeId: this.ungatedRunning ? this.nodeId : null,
      consuming: this.ungatedRunning,
      lastHolderHeartbeatAt: null,
    }));
    return {
      enabled: this.options.settings.enabled,
      // `master` below is not an election result in either ungated case; this
      // is what lets a reader tell "won" from "reads everything regardless".
      coordination: !this.options.settings.enabled
        ? 'ungated-disabled'
        : this.ungatedFallback ? 'ungated-fallback' : 'elected',
      role: this.started ? 'master' : 'stopped',
      nodeId: this.nodeId,
      version: this.options.version,
      uptimeMs: 0,
      consumersRunning: this.ungatedRunning,
      heldSurfaceCount: this.ungatedRunning ? surfaces.length : 0,
      signed: false,
      electionAuthentication: this.options.settings.secret.state === 'unavailable' ? 'unavailable' : 'none',
      surfaces,
      peers: [],
      transport: { mode: 'in-memory', group: '', port: 0, peers: [] },
      electionTiming: clusterElectionTiming(this.options.settings),
    };
  }

  // ── the election-off path ─────────────────────────────────────────────────

  private async startAllUngated(reason: string): Promise<void> {
    this.ungatedRunning = true;
    for (const surface of this.registry.list()) {
      if (!this.started) return;
      await this.registry.startSurface(surface.surfaceId, { replayFromMs: null, reason });
    }
  }

  private async stopAllUngated(reason: string): Promise<void> {
    // Every surface gets its stop even when an earlier one fails: leaving the
    // rest running after a shutdown would keep reading inboxes that no node
    // claims, and the first failure is still reported to the caller.
    let failure: { readonly error: unknown } | null = null;
    for (const surface of [...this.registry.list()].reverse()) {
      try {
        await this.registry.stopSurface(surface.surfaceId, reason);
      } catch (error) {
        // Already logged by the registry; without an election there is no
        // RESIGN to withhold, and a legacy consumer's failed stop never failed
        // the shutdown.
        if (error instanceof ClusterConsumerStopError) continue;
        if (failure === null) failure = { error };
        else {
          this.options.logger.error('cluster: another surface also failed to stop', {
            surface: surface.label,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.ungatedRunning = false;
    if (failure !== null) throw failure.error;
  }

  private async startGateUngated(
    gate: ClusterConsumerGate,
    context: ClusterConsumerStartContext,
  ): Promise<void> {
    try {
      await gate.start(context);
    } catch (error) {
      this.options.logger.error('cluster: an inbound consumer failed to start', {
        surface: surfaceLabel(gate.surface),
        consumer: gate.id,
        reason: context.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
