/**
 * election.ts, the leader-election state machine for ONE surface.
 *
 * There is one instance of this per inbound surface the node can actually
 * serve: one for each Telegram bot, one per ntfy topic, one per inbox account.
 * They share a transport and a holdings ledger (both owned by the node manager
 * in election-node.ts) and nothing else, separate roles, separate timers,
 * separate transition queues. That separation is the point: a node configured
 * for Telegram and ntfy and a node configured for ntfy alone contest ntfy and
 * leave each other's other surfaces entirely alone, and losing the ntfy holder
 * moves ntfy without disturbing Telegram.
 *
 * Everything this class touches is injected: the transport (through the host),
 * the clock, the randomness behind the CLAIM jitter, and the callbacks that
 * start and stop the surface's consumer. There is no socket and no wall-clock
 * dependency in here, which is what makes a 90-second watchdog takeover a test
 * that runs in microseconds.
 *
 * What it guarantees: on an orderly handoff the successor never starts before
 * the predecessor has finished stopping, and a node that could not stop its
 * consumer fences the surface instead of contesting it again. What it does not
 * guarantee: this is not a lease. A holder cut off by a partition keeps its
 * consumer running while the peers, missing its heartbeats, elect another, so
 * two nodes can consume one surface until the partition heals and the lower
 * rank yields. A message delivered to both in that window is handled on each;
 * on one node a redelivered message is handled once, because the session
 * broker keys every inbound message by its provider message id
 * (`providerMessageKey`), and Telegram itself refuses a second poller.
 *
 * Every role transition runs through a single serialized queue, per surface,
 * so a wedged ntfy stop cannot block a Telegram transition. Consumer start and
 * stop are awaited, and datagrams keep arriving while they run, so without
 * serialization a HEARTBEAT landing mid-`start()` could interleave a second
 * transition into a half-applied one.
 */
import { hasCurrentClusterRanking } from './ranking-feature.js';
import { ClusterConsumerStopError, OwnedClusterDrainError } from './owned-drain-error.js';
import {
  compareStableRank,
  isStrictlyNewerVersion,
  outranksForSurface,
  shouldYieldSurface,
  type ClusterSpreadRankable,
} from './ranking.js';
import {
  INITIAL_CONSUMER_CONFLICT_STATE,
  nextConsumerConflictBackoff,
} from './consumer-conflict-backoff.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';
import type { ClusterHoldingsLedger } from './holdings.js';
import type { ClusterTiming } from './timing.js';
import type {
  ClusterConsumerStartContext,
  ClusterClock,
  ClusterLogger,
  ClusterMessage,
  ClusterMessageType,
  ClusterRole,
  ClusterSurfaceStatus,
} from './types.js';

/**
 * What a surface election needs from the node it lives in.
 *
 * Everything shared across surfaces is here rather than duplicated per
 * surface: one socket, one peer table, one holdings ledger, one node identity.
 */
export interface SurfaceElectionHost {
  readonly nodeId: string;
  readonly version: string;
  /** Actual per-node wire behavior after accepting an existing v1 peer. */
  readonly ranking?: 'v1-peer' | undefined;
  readonly logger: ClusterLogger;
  readonly clock: ClusterClock;
  readonly timing: ClusterTiming;
  readonly ledger: ClusterHoldingsLedger;
  /** Broadcast a datagram stamped with this surface's digest. Custom hosts
   * encode nodeVersion with clusterRankingWireVersion(version, ranking ===
   * 'v1-peer') and adopt v1 behavior before delivering an accepted v1 peer.
   * ClusterElection owns this automatically for all built-in consumers. */
  send(type: ClusterMessageType, surfaceId: string): Promise<void>;
  /**
   * Can this node serve the surface RIGHT NOW, gate registered, credential
   * present, surface enabled locally? Re-asked at every promotion rather than
   * captured once, because a credential can be removed while the node runs.
   */
  canServe(surfaceId: string): boolean;
  /** Start this surface's consumer. Must not resolve until it is running. */
  startConsumer(surfaceId: string, context: ClusterConsumerStartContext): Promise<void>;
  /** Stop it. Must not resolve until consumption has genuinely ceased. */
  stopConsumer(surfaceId: string, reason: string): Promise<void>;
  /**
   * Claim this NODE's single rebalancing slot, or false if one was used too
   * recently.
   *
   * Node-level, not per surface, and that is the second half of the
   * anti-oscillation argument. Every surface a node holds runs its own yield
   * check, and they all read the same holdings number: an overloaded node
   * holding three surfaces would have all three conclude "I am two ahead, I
   * should yield" in the same instant, hand over all three, and leave the
   * other node overloaded by exactly as much. One slot per node per cooldown
   * means one surface moves, everyone re-observes, and the next check sees the
   * corrected numbers.
   *
   * Synchronous by contract: it is called with no await between the decision
   * and the reservation, so two surfaces can never both win the slot.
   */
  tryReserveYield(mono: number): boolean;
}

/**
 * Every role a surface can be in, and the roles each can move to.
 *
 * Two rows carry the safety argument. `stopped` leads only to `probing`, so a
 * late timer or a queued re-probe cannot bring a stopped election back to life.
 * `fenced` leads only to `stopped`: a consumer that would not stop must never
 * be joined by a second one on this node, so nothing short of leaving the
 * election (a restart) moves it on.
 */
const CLUSTER_SURFACE_ROLES = defineLifecycle<ClusterRole>('cluster surface', {
  stopped: ['probing'],
  probing: ['probing', 'standby', 'awaiting-handoff', 'master', 'stopped'],
  standby: ['electing', 'probing', 'stopped'],
  electing: ['standby', 'master', 'probing', 'stopped'],
  'awaiting-handoff': ['standby', 'master', 'probing', 'stopped'],
  master: ['resigning'],
  resigning: ['standby', 'probing', 'stopped', 'fenced'],
  fenced: ['stopped'],
});

export interface SurfaceElectionOptions {
  readonly surfaceId: string;
  /** Local, digest-derived label for logs. Never the topic or bot name. */
  readonly label: string;
  readonly kind: string;
  readonly host: SurfaceElectionHost;
  /** Test seam for the CLAIM jitter draw. Defaults to Math.random. */
  readonly random?: (() => number) | undefined;
}

/**
 * Failed consumer starts a holder rides out before handing the surface on.
 * Each retry waits longer than the last, so this is a few minutes at the shipped
 * timing: long enough for a blip, short enough that a healthier node is not
 * kept waiting behind a credential that will never work.
 */
const MAX_CONSUMER_START_FAILURES = 6;

export class SurfaceElection {
  private readonly surfaceId: string;
  private readonly host: SurfaceElectionHost;
  private readonly random: () => number;

  private role: ClusterRole = 'stopped';
  /** Why the consumer could not be stopped, while the surface is fenced. */
  private drainFailure: string | null = null;
  /**
   * True from start() until stop(). Checked by every path into `probing`, so a
   * re-probe that was queued or timed before a stop cannot rejoin the election
   * after it, even when start() and stop() land in the same tick.
   */
  private active = false;
  private consumerRunning = false;
  /** Consecutive failed starts while holding; drives the retry backoff. */
  private consumerStartFailures = 0;
  private cancelStartRetry: (() => void) | null = null;
  /** When the consumer stop began, so a stop that takes longer than a heartbeat keeps announcing the holder. */
  private stopBeganMono: number | null = null;
  /**
   * Monotonic time before which a standby must not contest this surface after a
   * consumer conflict. Without it the crash watchdog would start an election as
   * soon as the master timeout passed and cut every longer backoff short.
   */
  private conflictHoldUntilMono: number | null = null;

  private holderNodeId: string | null = null;
  private lastHolderHeartbeatAt: number | null = null;
  private lastHolderHeartbeatMono: number | null = null;

  /**
   * Consecutive refusals by the provider for THIS surface, and what was waited
   * for the last one. A refusal means another process holds the credential,
   * which retrying cannot fix, so the interval grows rather than staying flat
   *, see consumer-conflict-backoff.ts.
   */
  private consumerConflictBackoff = INITIAL_CONSUMER_CONFLICT_STATE;
  /** When the consumer last actually started, for judging "did it serve?". */
  private consumerStartedMono: number | null = null;

  private cancelProbe: (() => void) | null = null;
  private cancelHeartbeat: (() => void) | null = null;
  private heartbeatWork: Promise<void> | undefined;
  private cancelElection: (() => void) | null = null;
  private cancelSettle: (() => void) | null = null;
  private cancelHandoff: (() => void) | null = null;
  private cancelCandidacy: (() => void) | null = null;
  private cancelYieldCheck: (() => void) | null = null;

  private claimSentThisElection = false;
  private preemptTarget: string | null = null;

  /** Serializes every role transition for THIS surface; see the file header. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SurfaceElectionOptions) {
    this.surfaceId = options.surfaceId;
    this.host = options.host;
    this.random = options.random ?? Math.random;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Join this surface's election. */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.enqueue(() => this.beginProbe('boot'));
    await this.settled();
  }

  /**
   * Leave this surface's election cleanly.
   *
   * A holder stops its consumer and broadcasts RESIGN on the way out, which is
   * what turns a restart from a 90-second outage into a sub-second one. The
   * watchdog exists for the case this path never runs, a crash, a kill -9, a
   * lost power cable, not for the ordinary case.
   */
  async stop(reason = 'shutdown'): Promise<void> {
    if (!this.active && this.role === 'stopped') return;
    this.active = false;
    let drainFailure: OwnedClusterDrainError | undefined;
    this.enqueue(async () => {
      try {
        if (this.role === 'master') await this.stopConsumerThenResign(reason, null);
      } catch (error) {
        // The surface stays fenced (never `stopped`) and the stop says why.
        if (error instanceof OwnedClusterDrainError) drainFailure = error;
        throw error;
      } finally {
        this.clearAllTimers();
      }
      if (this.role !== 'stopped') this.setRole('stopped');
    });
    await this.settled();
    if (drainFailure) throw drainFailure;
  }

  /** Resolves once every queued transition has finished. */
  async settled(): Promise<void> {
    await this.queue;
  }

  // ── inspection ────────────────────────────────────────────────────────────

  get currentRole(): ClusterRole {
    return this.role;
  }

  get isMaster(): boolean {
    return this.role === 'master';
  }

  get id(): string {
    return this.surfaceId;
  }

  status(): ClusterSurfaceStatus {
    return {
      surfaceId: this.surfaceId,
      label: this.options.label,
      kind: this.options.kind,
      role: this.role,
      holderNodeId: this.role === 'master' ? this.host.nodeId : this.holderNodeId,
      consuming: this.consumerRunning,
      lastHolderHeartbeatAt: this.lastHolderHeartbeatAt,
      ...(this.role === 'fenced' && this.drainFailure !== null ? { drainFailure: this.drainFailure } : {}),
    };
  }

  // ── external signals ──────────────────────────────────────────────────────

  /**
   * A provider told us somebody else is already consuming THIS surface,
   * Telegram answers a concurrent getUpdates with 409.
   *
   * Never fight over it. The other consumer is real whether or not it speaks
   * this protocol, so stop, back off, and re-probe. Fighting produces two
   * processes that each keep terminating the other's long poll and a user
   * whose messages arrive nowhere. Only this surface stands down; the node's
   * other surfaces are unaffected, because the conflict is about one bot token
   * or one topic and says nothing about the rest.
   */
  reportConsumerConflict(detail: string): void {
    if (this.role === 'stopped') return;
    this.enqueue(async () => {
      if (this.role !== 'master') return;
      const delayMs = this.nextConsumerConflictDelay();
      this.host.logger.warn('cluster: another consumer is already reading this surface; standing down', {
        surface: this.options.label,
        detail,
        backoffMs: delayMs,
        // Without the streak this line looks identical on the first refusal and
        // on the two-hundredth, so a node stuck against a credential another
        // process holds reads as a one-off every time it happens.
        consecutiveConflicts: this.consumerConflictBackoff.streak,
        ...(this.consumerConflictBackoff.streak > 1
          ? {
              action: 'this surface has been refused repeatedly; stop the other process using this '
                + 'credential, or remove the credential from this machine, retrying cannot resolve it',
            }
          : {}),
      });
      await this.stopConsumerThenResign(`consumer conflict: ${detail}`, null);
      this.holdOffThenReprobe(delayMs, 'a consumer conflict was reported', 're-probe after a consumer conflict');
    });
  }

  /** See consumer-conflict-backoff.ts for why this grows rather than repeats. */
  private nextConsumerConflictDelay(): number {
    const now = this.host.clock.monotonicNow();
    this.consumerConflictBackoff = nextConsumerConflictBackoff(this.consumerConflictBackoff, {
      servedForMs: this.consumerStartedMono === null ? 0 : now - this.consumerStartedMono,
      floorMs: this.host.timing.consumerConflictBackoffMs,
      ceilingMs: this.host.timing.consumerConflictBackoffMaxMs,
      servedLongEnoughMs: this.host.timing.masterTimeoutMs,
    });
    return this.consumerConflictBackoff.lastDelayMs;
  }

  // ── probing ───────────────────────────────────────────────────────────────

  private async beginProbe(reason: string): Promise<void> {
    if (!this.active) return;
    if (!this.setRole('probing')) return;
    this.clearElectionTimers();
    this.preemptTarget = null;
    this.host.logger.debug('cluster: probing for this surface\'s holder', {
      surface: this.options.label,
      reason,
    });
    await this.send('PROBE');
    this.cancelProbe?.();
    this.cancelProbe = this.host.clock.setTimer(() => {
      this.enqueue(async () => {
        if (this.role !== 'probing') return;
        await this.becomeMaster('no node answered the boot probe for this surface', 'ordered');
      });
    }, this.host.timing.bootProbeMs);
  }

  // ── election ──────────────────────────────────────────────────────────────

  private beginElection(windowMs: number, reason: string, handoff: 'ordered' | 'gap'): void {
    if (!this.setRole('electing')) return;
    this.clearElectionTimers();
    this.claimSentThisElection = false;
    const jitter = Math.floor(this.random() * windowMs);
    this.host.logger.debug('cluster: starting an election for a surface', {
      surface: this.options.label,
      reason,
      jitterMs: jitter,
    });
    this.cancelElection = this.host.clock.setTimer(() => {
      this.enqueue(async () => {
        if (this.role !== 'electing') return;
        await this.sendClaim();
        this.cancelSettle = this.host.clock.setTimer(() => {
          this.enqueue(async () => {
            if (this.role !== 'electing') return;
            await this.becomeMaster(reason, handoff);
          });
        }, this.host.timing.claimSettleMs);
      });
    }, jitter);
  }

  private async sendClaim(): Promise<void> {
    this.claimSentThisElection = true;
    await this.send('CLAIM');
  }

  // ── role transitions ──────────────────────────────────────────────────────

  /**
   * Take the surface and start consuming it.
   *
   * `handoff` decides where consumption resumes from, and the distinction is
   * not cosmetic, it is the difference between losing messages and answering
   * them twice:
   *
   *   'ordered' , the predecessor stopped consuming and THEN said so, so it
   *                read right up to its last moment. There is no gap. Resuming
   *                from its last heartbeat would replay everything it already
   *                handled between that heartbeat and its stop, and the user
   *                would get a second answer to a message that was answered.
   *
   *   'gap'     , the predecessor vanished (crash, kill -9, a handoff it never
   *                completed). The last moment it is KNOWN to have been alive
   *                is its last heartbeat for THIS surface, so consumption
   *                resumes there. A provider without a per-subscriber cursor
   *                may redeliver a message or two from that window; a duplicate
   *                is a nuisance and a lost message is not recoverable, so the
   *                window is deliberately replayed rather than skipped.
   */
  private async becomeMaster(reason: string, handoff: 'ordered' | 'gap'): Promise<void> {
    // Winning something this node cannot serve is worse than losing it: the
    // node that COULD have served it stands down, and the surface goes unread
    // by anybody. Re-checked here, at the last possible moment, because a
    // credential can be removed while an election is in flight.
    if (!this.host.canServe(this.surfaceId)) {
      this.host.logger.warn('cluster: declining a surface this node cannot serve', {
        surface: this.options.label,
        reason,
      });
      this.clearElectionTimers();
      this.becomeStandby(null, 'this node cannot serve the surface');
      return;
    }
    if (!this.setRole('master')) return;
    this.clearElectionTimers();
    this.preemptTarget = null;
    this.conflictHoldUntilMono = null;
    this.consumerStartFailures = 0;
    this.host.ledger.noteHolder(this.surfaceId, this.host.nodeId, this.host.clock.monotonicNow());
    // Announce before consuming: a strictly newer peer that disagrees gets its
    // chance to preempt through the ordered path rather than by racing us.
    await this.send('CLAIM');
    // And say we hold it at once. A consumer start can take seconds, and a
    // standby that lost this election would otherwise still be timing out the
    // previous holder and could promote itself into that gap.
    await this.send('HEARTBEAT');
    const context: ClusterConsumerStartContext = {
      replayFromMs: handoff === 'gap' ? this.lastHolderHeartbeatAt : null,
      reason,
    };
    // Startup may own a held provider read. Keep announcing the original
    // holder while the serialized transition awaits that exact startup.
    this.armHeartbeat();
    await this.startConsumerAsHolder(context);
    this.armYieldCheck();
    await this.send('HEARTBEAT');
  }

  /**
   * Start the consumer for a surface this node holds, and keep retrying while
   * it holds it if the start fails.
   *
   * A failed start is not handed on with a RESIGN: a RESIGN tells the
   * successor nothing was missed, so it would resume "from now" and skip the
   * replay window (`context.replayFromMs`) this node was meant to cover. The
   * retry keeps that window. A provider that drops this node for good (a lost
   * socket) withdraws its gate instead, which is the ordered stand-down.
   */
  private async startConsumerAsHolder(
    context: ClusterConsumerStartContext,
    addedOnly = false,
  ): Promise<void> {
    try {
      await this.host.startConsumer(this.surfaceId, context);
      this.consumerRunning = true;
      if (addedOnly) {
        this.consumerStartFailures = 0;
        return;
      }
      this.consumerStartedMono = this.host.clock.monotonicNow();
      this.host.logger.info('cluster: this node is now responsible for an inbound surface', {
        surface: this.options.label,
        nodeId: this.host.nodeId,
        version: this.host.version,
        reason: context.reason,
        replayFromMs: context.replayFromMs,
        ...(this.consumerStartFailures > 0 ? { failedAttemptsBefore: this.consumerStartFailures } : {}),
      });
      this.consumerStartFailures = 0;
    } catch (error) {
      // A consumer added beside ones that are already reading does not make the
      // surface unread when it fails to start; it is only retried.
      if (!addedOnly) this.consumerRunning = false;
      this.consumerStartFailures += 1;
      // Doubling from one heartbeat to the crash timeout: prompt for a blip,
      // and never more than one attempt per timeout for a lasting fault.
      const retryMs = Math.min(
        this.host.timing.heartbeatMs * 2 ** Math.min(this.consumerStartFailures - 1, 20),
        this.host.timing.masterTimeoutMs,
      );
      const meta = {
        surface: this.options.label,
        reason: context.reason,
        error: error instanceof Error ? error.message : String(error),
        attempt: this.consumerStartFailures,
        retryMs,
      };
      if (this.consumerStartFailures === 1) {
        this.host.logger.error('cluster: took a surface but its consumer failed to start; this node is not reading it and will retry', meta);
      } else {
        this.host.logger.debug('cluster: a surface consumer still fails to start', meta);
      }
      this.cancelStartRetry?.();
      this.cancelStartRetry = this.host.clock.setTimer(() => {
        this.cancelStartRetry = null;
        this.enqueue(async () => {
          if (this.role !== 'master' || (this.consumerRunning && !addedOnly)) return;
          if (!addedOnly && this.consumerStartFailures >= MAX_CONSUMER_START_FAILURES) {
            await this.standDownAfterFailedStarts();
            return;
          }
          await this.startConsumerAsHolder(context, addedOnly);
        });
      }, retryMs);
    }
  }

  /**
   * This node holds a surface it has repeatedly failed to read. Holding it only
   * keeps a node that may be able to read it from trying, so hand it on the
   * ordered way and stay out of the next election for a while, the same
   * back-off a refused consumer gets.
   */
  private async standDownAfterFailedStarts(): Promise<void> {
    const failedAttempts = this.consumerStartFailures;
    this.consumerStartedMono = null;
    const delayMs = this.nextConsumerConflictDelay();
    this.host.logger.error('cluster: this node could not start the consumer for a surface it holds, so it is handing the surface to another node', {
      surface: this.options.label,
      failedAttempts,
      holdOffMs: delayMs,
      action: 'check this machine\'s credential for the surface; until it works another node will read it if one can',
    });
    await this.stopConsumerThenResign('its consumer repeatedly failed to start', null);
    this.holdOffThenReprobe(delayMs, 'its consumer repeatedly failed to start', 're-probe after repeated consumer start failures');
  }

  /** Stand by, stay out of the election for `delayMs`, then probe afresh. */
  private holdOffThenReprobe(delayMs: number, standbyReason: string, probeReason: string): void {
    this.becomeStandby(null, standbyReason);
    this.conflictHoldUntilMono = this.host.clock.monotonicNow() + delayMs;
    this.cancelProbe?.();
    this.cancelProbe = this.host.clock.setTimer(() => {
      this.enqueue(async () => {
        // Anything that moved this surface on since (a holder appeared, a
        // wake re-probe, a stop) already decided what happens next.
        if (this.role !== 'standby') return;
        await this.beginProbe(probeReason);
      });
    }, delayMs);
  }

  /**
   * A consumer was registered on a surface this node may already hold. When it
   * does, start just that consumer now (the registry skips the ones already
   * reading) instead of leaving it idle until the next handoff; otherwise the
   * normal take-over starts it with the rest.
   */
  startAddedConsumers(): void {
    this.enqueue(async () => {
      if (this.role !== 'master' || !this.consumerRunning) return;
      await this.startConsumerAsHolder({
        replayFromMs: null,
        reason: 'a consumer was registered on a surface this node already holds',
      }, true);
    });
  }

  /**
   * The ordered half of every handoff: the consumer stops FIRST, and only once
   * it has genuinely stopped does RESIGN go out. The successor keys off
   * RESIGN, so this ordering is the entire reason a handoff cannot
   * double-consume. Reversing these two lines would reintroduce the bug this
   * module exists to fix.
   */
  private async stopConsumerThenResign(reason: string, nextHolderNodeId: string | null): Promise<void> {
    this.setRole('resigning');
    this.stopBeganMono = this.host.clock.monotonicNow();
    // The heartbeat keeps running until the consumer has really stopped: a
    // consumer that is slow to drain is still reading, and peers that stopped
    // hearing from this node would take the surface over beside it.
    this.cancelStartRetry?.();
    this.cancelStartRetry = null;
    // Transport failure is already reported by the heartbeat owner; join it
    // without allowing a failed send to skip the actual consumer stop.
    await Promise.allSettled([this.heartbeatWork]);
    this.cancelYieldCheck?.();
    this.cancelYieldCheck = null;
    // Stopped even when the start failed: a gate that failed part-way may
    // still hold something, and stopping a stopped consumer is harmless.
    let stopFailed = false;
    if (this.consumerRunning || this.consumerStartFailures > 0) {
      try {
        await this.host.stopConsumer(this.surfaceId, reason);
      } catch (error) {
        this.host.logger.error('cluster: an inbound consumer did not stop cleanly before resigning', {
          surface: this.options.label,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        // Owned withdrawal must not announce that an undrained consumer stopped.
        // Peers may still take over after heartbeat expiry; this is not a lease
        // or a global no-overlap guarantee. Local owner authority stays fenced,
        // and so does this surface: contesting it again would start a second
        // consumer beside the one that would not stop.
        if (error instanceof OwnedClusterDrainError) {
          this.drainFailure = error.message;
          this.setRole('fenced');
          this.host.logger.error('cluster: a surface is fenced on this node until the daemon restarts', {
            surface: this.options.label,
            reason: 'its consumer did not stop, so this node will not contest it again',
            action: 'restart the daemon to recover this surface on this node; another node may take it over meanwhile',
          });
          throw error;
        }
        // A consumer that may still be reading must not be announced as gone:
        // RESIGN would let a successor start a second one beside it. Peers take
        // the surface over once this node's heartbeat times out.
        if (error instanceof ClusterConsumerStopError) stopFailed = true;
      }
      this.consumerRunning = false;
      this.consumerStartFailures = 0;
    }
    // Stopped for good, and any beat still in flight joined, so none can follow
    // the RESIGN and make the successor think the old holder is back.
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    await Promise.allSettled([this.heartbeatWork]);
    this.stopBeganMono = null;
    if (stopFailed) {
      this.host.logger.error('cluster: a consumer did not stop, so this node is not announcing that it let the surface go', {
        surface: this.options.label,
        reason,
        action: 'peers take the surface over when this node\'s heartbeat times out',
      });
    } else {
      this.host.ledger.noteReleased(this.surfaceId, this.host.nodeId);
      await this.send('RESIGN');
    }
    this.holderNodeId = nextHolderNodeId;
    // This node WAS the reader right up to this moment, so this moment is the
    // surface's last known-alive time. Leaving a stale reading here would have
    // the watchdog declare the surface abandoned the instant we stood down,
    // and the node that just gave it up would immediately contest it again,
    // against the successor it handed it to.
    this.lastHolderHeartbeatAt = this.host.clock.now();
    this.lastHolderHeartbeatMono = this.host.clock.monotonicNow();
    this.host.logger.info('cluster: released responsibility for an inbound surface', {
      surface: this.options.label,
      reason,
      ...(nextHolderNodeId ? { successor: nextHolderNodeId } : {}),
    });
  }

  private becomeStandby(holderNodeId: string | null, reason: string): void {
    if (!this.setRole('standby')) return;
    this.clearElectionTimers();
    this.preemptTarget = null;
    if (holderNodeId) this.holderNodeId = holderNodeId;
    // A node that just gave a surface up has no holder to time out against
    // yet; start the clock now so an unclaimed surface comes back rather than
    // sitting unread forever.
    this.lastHolderHeartbeatMono ??= this.host.clock.monotonicNow();
    this.armCandidacy();
    this.host.logger.debug('cluster: standing by on a surface', {
      surface: this.options.label,
      holder: this.holderNodeId,
      reason,
    });
  }

  /**
   * Take the surface from a sitting holder because this build is strictly
   * newer.
   *
   * We do NOT start consuming here. The old holder owns the stop; we wait for
   * its RESIGN, with a grace timer for the case it died mid-handoff.
   */
  private async beginPreemption(target: ClusterMessage): Promise<void> {
    if (!this.setRole('awaiting-handoff')) return;
    this.clearElectionTimers();
    this.preemptTarget = target.nodeId;
    this.host.logger.info('cluster: preempting an older holder and waiting for its handoff', {
      surface: this.options.label,
      holder: target.nodeId,
      holderVersion: target.nodeVersion,
      version: this.host.version,
    });
    await this.send('CLAIM');
    this.cancelHandoff = this.host.clock.setTimer(() => {
      this.enqueue(async () => {
        if (this.role !== 'awaiting-handoff') return;
        this.host.logger.warn('cluster: the preempted holder did not resign in time; taking over', {
          surface: this.options.label,
          holder: this.preemptTarget,
          graceMs: this.host.timing.preemptGraceMs,
        });
        await this.becomeMaster('preemption grace elapsed', 'gap');
      });
    }, this.host.timing.preemptGraceMs);
  }

  // ── inbound datagrams ─────────────────────────────────────────────────────

  /**
   * Handle a datagram already decoded, already authenticated, already
   * deduplicated by sequence, and already confirmed to carry THIS surface's
   * digest. Everything before that is the node manager's job.
   */
  deliver(message: ClusterMessage): void {
    // A holder answers "who holds this?" at once, even while its queue is busy
    // starting the consumer. A peer left unanswered for that long concludes
    // nobody holds the surface and promotes itself beside us. Only answers
    // that change no role qualify; a strictly newer CLAIM still waits its turn.
    if (this.role === 'master' && (message.type === 'PROBE'
      || (message.type === 'CLAIM' && !isStrictlyNewerVersion(this.peerRank(message), this.selfRank())))) {
      this.beatOutsideQueue();
      return;
    }
    this.enqueue(() => this.dispatch(message));
  }

  private async dispatch(message: ClusterMessage): Promise<void> {
    if (this.role === 'stopped' || this.role === 'resigning' || this.role === 'fenced') return;
    switch (message.type) {
      case 'PROBE': return this.onProbe();
      case 'HEARTBEAT': return this.onHeartbeat(message);
      case 'CLAIM': return this.onClaim(message);
      case 'RESIGN': return this.onResign(message);
    }
  }

  /** A node is probing this surface. Only its holder answers, immediately. */
  private async onProbe(): Promise<void> {
    if (this.role !== 'master') return;
    await this.send('HEARTBEAT');
  }

  private async onHeartbeat(message: ClusterMessage): Promise<void> {
    this.noteHolderAlive(message.nodeId);
    switch (this.role) {
      case 'probing':
        if (isStrictlyNewerVersion(this.selfRank(), this.peerRank(message))) {
          await this.beginPreemption(message);
          return;
        }
        this.becomeStandby(message.nodeId, 'a holder answered the boot probe');
        return;
      case 'electing':
        this.becomeStandby(message.nodeId, 'a holder spoke up during the election');
        return;
      case 'awaiting-handoff':
        // A DIFFERENT node than the one we preempted holds it: our premise is
        // stale, so abandon the preemption rather than take over behind it.
        if (message.nodeId !== this.preemptTarget
          && !isStrictlyNewerVersion(this.selfRank(), this.peerRank(message))) {
          this.becomeStandby(message.nodeId, 'a different node holds the surface');
        }
        return;
      case 'master':
        await this.reconcileWithPeerHolder(message);
        return;
      default:
        this.holderNodeId = message.nodeId;
    }
  }

  /**
   * Two nodes can hold one surface after a partition heals. Both sides run the
   * same ordering over the same two candidates, so they agree on the winner
   * without negotiating; the loser performs the ordered stop-then-RESIGN and
   * the winner, which never stopped, simply carries on.
   *
   * Decided on the STABLE order, which excludes holdings. Holdings are
   * observed from traffic, and two nodes that were partitioned have by
   * definition been observing different traffic, ranking a reconciliation on
   * a number they disagree about could leave both sides believing they won.
   * Version and the per-surface hash come out of the datagram itself and can
   * never disagree.
   */
  private async reconcileWithPeerHolder(message: ClusterMessage): Promise<void> {
    if (compareStableRank(this.peerRank(message), this.selfRank(), this.surfaceId) < 0) {
      this.host.logger.info('cluster: a better-ranked node holds this surface; handing it over', {
        surface: this.options.label,
        peer: message.nodeId,
        peerVersion: message.nodeVersion,
      });
      await this.stopConsumerThenResign('a better-ranked node claimed this surface', message.nodeId);
      this.becomeStandby(message.nodeId, 'lost the split-brain reconciliation');
      return;
    }
    // We outrank it: assert, so the other side reconciles the same way.
    await this.send('HEARTBEAT');
  }

  private async onClaim(message: ClusterMessage): Promise<void> {
    switch (this.role) {
      case 'master':
        if (isStrictlyNewerVersion(this.peerRank(message), this.selfRank())) {
          await this.stopConsumerThenResign('preempted by a strictly newer build', message.nodeId);
          this.becomeStandby(message.nodeId, 'preempted by a strictly newer build');
          return;
        }
        // Not newer: hold the surface and assert it, which silences the claimer.
        await this.send('HEARTBEAT');
        return;
      case 'electing':
      case 'probing':
        if (outranksForSurface(this.peerRank(message), this.selfRank(), this.surfaceId)) {
          // The winner is alive as of this CLAIM. Timing it out from the dead
          // holder's last heartbeat instead would have this node contest again
          // on its next watchdog tick, while the winner is still starting.
          // `lastHolderHeartbeatAt` is left alone: it is the replay point.
          this.lastHolderHeartbeatMono = this.host.clock.monotonicNow();
          this.becomeStandby(message.nodeId, 'a better-ranked node claimed the surface');
          return;
        }
        // A worse claim: answer once so the claimer stands down promptly
        // instead of running its settle window out against us.
        if (!this.claimSentThisElection) await this.sendClaim();
        return;
      case 'awaiting-handoff':
        if (outranksForSurface(this.peerRank(message), this.selfRank(), this.surfaceId)) {
          this.lastHolderHeartbeatMono = this.host.clock.monotonicNow();
          this.becomeStandby(message.nodeId, 'a better-ranked node claimed during our handoff');
        }
        return;
      default:
        return;
    }
  }

  private async onResign(message: ClusterMessage): Promise<void> {
    if (this.role === 'awaiting-handoff' && message.nodeId === this.preemptTarget) {
      this.cancelHandoff?.();
      this.cancelHandoff = null;
      await this.becomeMaster('the preempted holder handed the surface over', 'ordered');
      return;
    }
    // Only a STANDBY shortcuts to an election here. A probing node is already
    // running its own boot window and would gain nothing by jumping the queue,
    // and a node that has just woken from suspend is deliberately made to
    // re-probe rather than act on a farewell it may have received minutes ago.
    if (this.role === 'standby') {
      if (this.holderNodeId !== null && message.nodeId !== this.holderNodeId) return;
      this.holderNodeId = null;
      // The holder said goodbye, so there is nothing to wait out: run the
      // short election window instead of the crash-only watchdog timeout.
      // It stopped consuming before it said goodbye, so nothing was missed.
      this.beginElection(this.host.timing.resignElectionWindowMs, 'the holder resigned', 'ordered');
    }
  }

  private noteHolderAlive(nodeId: string): void {
    this.lastHolderHeartbeatAt = this.host.clock.now();
    this.lastHolderHeartbeatMono = this.host.clock.monotonicNow();
    // A real holder now answers for the surface, so the conflict backoff has
    // nothing left to protect; its liveness drives the watchdog again.
    this.conflictHoldUntilMono = null;
    if (this.role !== 'master') this.holderNodeId = nodeId;
  }

  // ── timers ────────────────────────────────────────────────────────────────

  private armHeartbeat(): void {
    this.cancelHeartbeat?.();
    const tick = (): void => {
      if (this.role !== 'master' && this.role !== 'resigning') return;
      this.cancelHeartbeat = this.host.clock.setTimer(tick, this.host.timing.heartbeatMs);
      this.beatOutsideQueue();
    };
    this.cancelHeartbeat = this.host.clock.setTimer(tick, this.host.timing.heartbeatMs);
  }

  /**
   * One HEARTBEAT from the holder, outside the transition queue.
   *
   * Heartbeats report the retained holder, not a role transition. They must
   * not queue behind its provider startup/drain. Own and join each send
   * before RESIGN, so no late heartbeat can resurrect a retired holder. One
   * already in flight answers for this one too.
   */
  /**
   * A holder announces itself while it holds the surface, and while a consumer
   * stop that is taking longer than a heartbeat is still in progress: that
   * consumer is still reading, and silence would let a peer start a second one.
   * A stop that finishes at once sends nothing extra.
   */
  private mayAnnounceHolder(): boolean {
    if (this.role === 'master') return true;
    return this.role === 'resigning' && this.stopBeganMono !== null
      && this.host.clock.monotonicNow() - this.stopBeganMono >= this.host.timing.heartbeatMs;
  }

  private beatOutsideQueue(): void {
    if (!this.mayAnnounceHolder() || this.heartbeatWork) return;
    const work = Promise.resolve().then(async () => {
      if (!this.mayAnnounceHolder()) return;
      this.host.ledger.noteHolder(this.surfaceId, this.host.nodeId, this.host.clock.monotonicNow());
      await this.send('HEARTBEAT');
    });
    this.heartbeatWork = work;
    void work.then(() => { if (this.heartbeatWork === work) this.heartbeatWork = undefined; }, () => {
      if (this.heartbeatWork === work) this.heartbeatWork = undefined;
      this.host.logger.error('cluster: holder heartbeat failed');
    });
  }

  /**
   * A standby says, periodically, that it can serve this surface.
   *
   * Without it a standby is invisible: it sends nothing after losing, so the
   * holder's ledger forgets it, and an overloaded holder concludes there is
   * nobody to rebalance to. A PROBE is the right shape for the beat, the
   * holder answers it with a HEARTBEAT, so the beat also re-confirms the
   * holder is alive.
   */
  private armCandidacy(): void {
    this.cancelCandidacy?.();
    const tick = (): void => {
      this.enqueue(async () => {
        if (this.role !== 'standby') return;
        await this.send('PROBE');
        this.cancelCandidacy = this.host.clock.setTimer(tick, this.host.timing.candidacyAnnounceMs);
      });
    };
    this.cancelCandidacy = this.host.clock.setTimer(tick, this.host.timing.candidacyAnnounceMs);
  }

  private armYieldCheck(): void {
    this.cancelYieldCheck?.();
    const tick = (): void => {
      this.enqueue(async () => {
        if (this.role !== 'master') return;
        await this.considerYield();
        if (this.role === 'master') {
          this.cancelYieldCheck = this.host.clock.setTimer(tick, this.host.timing.yieldCheckMs);
        }
      });
    };
    this.cancelYieldCheck = this.host.clock.setTimer(tick, this.host.timing.yieldCheckMs);
  }

  /**
   * Rebalancing, as a voluntary yield rather than an outside preemption.
   *
   * The holder decides, and it only decides yes when it is at least
   * SURFACE_YIELD_GAP surfaces ahead of a node that can serve this one. See
   * shouldYieldSurface for why the threshold is two and not one. The release
   * itself is the ordinary ordered stop-then-RESIGN, so consumption of the
   * surface stops before anything anywhere starts it again, a rebalance never
   * opens a window where two nodes read the same topic.
   */
  private async considerYield(): Promise<void> {
    const mono = this.host.clock.monotonicNow();
    const selfHoldings = this.host.ledger.holdingsOf(this.host.nodeId, mono);
    let best: { nodeId: string; holdings: number } | null = null;
    // A node this cluster would already declare DEAD as a holder must not be
    // handed a surface as a candidate. The two liveness questions used to
    // disagree, a holder is gone after masterTimeoutMs, a yield target was
    // believed alive for twice candidacyAnnounceMs, and candidacyAnnounceMs IS
    // masterTimeoutMs, so a crashed node stayed an eligible recipient for
    // twice as long as it stayed an eligible holder. Measured on a two-node LAN
    // at a 4s timeout: failover finished 4.6s after the kill, a rescued surface
    // was yielded back to the corpse 0.8s later, and it went unconsumed for a
    // further 5.3s. See the regression test in cluster-spread.test.ts.
    const liveWithinMs = Math.min(
      this.host.timing.candidacyAnnounceMs * 2,
      this.host.timing.masterTimeoutMs,
    );
    for (const nodeId of this.host.ledger.candidatesFor(this.surfaceId, mono, this.host.nodeId, liveWithinMs)) {
      const holdings = this.host.ledger.holdingsOf(nodeId, mono);
      if (!best || holdings < best.holdings) best = { nodeId, holdings };
    }
    if (!best || !shouldYieldSurface(selfHoldings, best.holdings)) return;
    // Decide, then reserve, with no await in between, see tryReserveYield.
    if (!this.host.tryReserveYield(mono)) return;
    this.host.logger.info('cluster: yielding a surface to spread inbound work across the network', {
      surface: this.options.label,
      held: selfHoldings,
      candidate: best.nodeId,
      candidateHeld: best.holdings,
    });
    await this.stopConsumerThenResign('rebalancing: a peer on this network holds fewer surfaces', best.nodeId);
    this.becomeStandby(null, 'yielded the surface to spread load');
  }

  /**
   * Driven by the node manager's single watchdog: notice a holder that stopped
   * breathing. Suspend detection is node-level and arrives through
   * `onWakeFromSuspend` instead.
   */
  onWatchdogTick(mono: number): void {
    if (this.role !== 'standby' || this.lastHolderHeartbeatMono === null) return;
    if (mono - this.lastHolderHeartbeatMono < this.host.timing.masterTimeoutMs) return;
    // Backing off after a consumer conflict; its own re-probe timer decides when.
    if (this.conflictHoldUntilMono !== null && mono < this.conflictHoldUntilMono) return;
    this.enqueue(async () => {
      if (this.role !== 'standby') return;
      this.beginElection(this.host.timing.electionWindowMs, 'the holder stopped heartbeating', 'gap');
    });
  }

  /**
   * A woken node knows nothing about who holds this surface now, and its own
   * consumer was frozen mid-flight. Stop first, THEN re-probe, resuming a long
   * poll that a successor has already taken over is precisely the double
   * consumption this module prevents.
   */
  onWakeFromSuspend(gapMs: number): void {
    if (this.role === 'stopped' || this.role === 'fenced') return;
    this.enqueue(async () => {
      if (this.role === 'stopped' || this.role === 'fenced') return;
      this.host.logger.info('cluster: the host was suspended; re-probing a surface before consuming it', {
        surface: this.options.label,
        gapMs,
        roleBeforeSuspend: this.role,
      });
      if (this.role === 'master') {
        await this.stopConsumerThenResign('the host was suspended', null);
      }
      this.lastHolderHeartbeatAt = null;
      this.lastHolderHeartbeatMono = null;
      this.holderNodeId = null;
      // Measured on a monotonic clock that stood still while asleep, so it
      // describes a network that has moved on; the probe decides afresh.
      this.conflictHoldUntilMono = null;
      await this.beginProbe('woke from suspend');
    });
  }

  private clearElectionTimers(): void {
    this.cancelProbe?.();
    this.cancelProbe = null;
    this.cancelElection?.();
    this.cancelElection = null;
    this.cancelSettle?.();
    this.cancelSettle = null;
    this.cancelHandoff?.();
    this.cancelHandoff = null;
    this.cancelCandidacy?.();
    this.cancelCandidacy = null;
  }

  private clearAllTimers(): void {
    this.clearElectionTimers();
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    this.cancelYieldCheck?.();
    this.cancelYieldCheck = null;
    this.cancelStartRetry?.();
    this.cancelStartRetry = null;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  /**
   * The one place a role changes. A move the table does not allow is logged
   * and refused, leaving the role as it was, so a late timer or a queued
   * transition cannot carry a stopped or fenced surface somewhere unsafe.
   */
  private setRole(to: ClusterRole): boolean {
    const move = CLUSTER_SURFACE_ROLES.check(this.role, to);
    if (!move.ok) {
      this.host.logger.warn('cluster: refused a surface role change', {
        surface: this.options.label,
        reason: move.reason,
      });
      return false;
    }
    this.role = to;
    return true;
  }

  private selfRank(): ClusterSpreadRankable {
    const ranking = this.host.ranking;
    return {
      nodeId: this.host.nodeId,
      version: this.host.version,
      ...(ranking ? { ranking } : {}),
      holdings: this.host.ledger.holdingsOf(this.host.nodeId, this.host.clock.monotonicNow()),
    };
  }

  private peerRank(message: ClusterMessage): ClusterSpreadRankable {
    return {
      nodeId: message.nodeId,
      version: message.nodeVersion,
      ...(hasCurrentClusterRanking(message.nodeVersion) ? {} : { ranking: 'v1-peer' as const }),
      holdings: this.host.ledger.holdingsOf(message.nodeId, this.host.clock.monotonicNow()),
    };
  }

  private async send(type: ClusterMessageType): Promise<void> {
    await this.host.send(type, this.surfaceId);
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.host.logger.error('cluster: a surface state transition failed', {
        surface: this.options.label,
        role: this.role,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
