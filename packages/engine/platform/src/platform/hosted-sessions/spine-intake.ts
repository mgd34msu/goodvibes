import { captureJudgmentFailure } from '../gate/failure-input.js';
import { judgmentPort, readFailureTransience, type FailureReadOptions } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
/**
 * spine-intake.ts, how a hosted session reaches the SHARED session spine, and
 * how a steer reaches a hosted turn.
 *
 * Two jobs, together because they are the same relationship seen from both
 * ends.
 *
 * REGISTRATION puts a hosted session in `sessions.list` beside every other
 * kind, so a client that lists sessions sees the ones the daemon is running
 * rather than only the ones its own process started.
 *
 * INTAKE is what makes `sessions.steer` and `sessions.followUp` actually drive
 * a hosted turn without a parallel verb family. The broker routes a steer at a
 * session with a live SURFACE participant to that surface to collect; for a
 * hosted session, this engine is the surface. So it collects the queued inputs
 * and hands each to the loop, the same contract `createWireSessionDispatch`
 * implements for a client across the wire, with the one difference that this
 * one shares a process with the broker.
 *
 * The engine is the one owner of "this hosted session is alive": the broker
 * routes a steer for a `hosted` session to this intake whatever its
 * participant's age, its reaper asks the engine (liveness-probe.ts), and so a
 * session is registered when it appears or its title or workspace changes,
 * never again as a heartbeat. Inputs are collected when the broker says its
 * sessions changed (`subscribe`); the interval only retries deliveries and
 * consumed marks that did not land.
 */

import { hostedLifecycleCallbacks } from './lifecycle-callbacks.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { HostedSessionRecord } from './types.js';
import { HostedSessionNotFoundError, HostedSessionNotReadyError, HostedSessionUnavailableError } from './errors.js';

/**
 * The narrow view of the shared session broker hosted sessions use.
 *
 * Registration is what puts a hosted session in `sessions.list` beside every
 * other kind. The input methods are what make `sessions.steer` and
 * `sessions.followUp` DRIVE one: a steer at a session with a live surface
 * participant is queued FOR that surface to collect, and for a hosted session
 * this engine is the surface. Collecting and delivering those queued inputs is
 * the same contract `createWireSessionDispatch` implements for a client on the
 * other side of the wire, the difference is only that this one is in the same
 * process as the broker.
 */
export interface HostedSessionSpine {
  register(input: {
    readonly sessionId: string;
    readonly kind: 'hosted';
    readonly project?: string | undefined;
    readonly title?: string | undefined;
    readonly participant: {
      readonly surfaceKind: 'service';
      readonly surfaceId: string;
      readonly lastSeenAt: number;
    };
  }): Promise<unknown>;
  closeSession(sessionId: string): Promise<unknown>;
  /** Inputs waiting for this surface to collect. */
  getInputsSince(
    sessionId: string,
    options: { readonly state?: 'queued' | undefined },
  ): readonly {
    readonly id: string;
    readonly body: string;
    readonly state?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    readonly correlationId?: string | undefined;
    /** The surface the input was submitted from, recorded by the code that accepted it. */
    readonly surfaceKind?: string | undefined;
  }[];
  /** Report one collected (`consumed:false`) or finished (`consumed:true`). */
  markInputDelivered(
    sessionId: string,
    inputId: string,
    options?: { readonly consumed?: boolean | undefined },
  ): Promise<unknown>;
  /**
   * Report one this surface collected and could not act on, with the reason.
   *
   * Optional so a stand-in spine in a test need not implement it; a spine
   * without it leaves the record collected-but-unfinished, which is still
   * honest, what must never happen is marking it consumed.
   */
  failInput?(sessionId: string, inputId: string, error: string): Promise<unknown>;
  /**
   * Be told when sessions, messages or inputs change, so inputs are collected
   * as they arrive. Returns the unsubscribe. Optional: without it the intake
   * reads on its interval.
   */
  subscribe?(listener: () => void): () => void;
}

/** What the intake needs from the engine that owns the sessions. */
export interface HostedSessionSpineIntakeOptions {
  readonly spine?: HostedSessionSpine | undefined;
  /** Captured composition owner for failure readings; no ambient port changes during retry. */
  readonly failureReading?: FailureReadOptions | undefined;
  /** Non-terminated hosted sessions, read fresh on every tick. */
  readonly liveSessions: () => readonly HostedSessionRecord[];
  /** Attribute awaited registration/close callbacks to their session owner. */
  readonly withLifecycle?: <T>(sessionId: string, callback: () => Promise<T>) => Promise<T>;
  /** Hand one collected input to its session's loop. */
  readonly deliver: (sessionId: string, text: string, correlationId?: string | undefined, delivery?: { readonly operatorInput?: boolean | undefined }) => Promise<void>;
  readonly now: () => number;
  /** Interval read. Default 750ms without a spine `subscribe`; with one, a 5 s retry pass for deliveries and marks that did not land. */
  readonly intervalMs?: number | undefined;
  /** Delivery attempts one collected input gets before it is failed. Default 3. */
  readonly maxDeliveryAttempts?: number | undefined;
  /**
   * Put one line in front of the owner over a channel that still works.
   * Omitted ⇒ an undeliverable message is logged and recorded on the spine but
   * nobody is told, which is the state a survive-detach session must not be in.
   */
  readonly alertOwner?: ((text: string) => void) | undefined;
}

const DEFAULT_INTAKE_INTERVAL_MS = 750;
/** With changes pushed by the spine, the interval only retries what did not land. */
const SUBSCRIBED_RETRY_INTERVAL_MS = 5_000;
const HOSTED_PARTICIPANT_SURFACE_ID = 'daemon:hosted-sessions';

/**
 * Surfaces whose input an authenticated operator sent: the daemon accepts them
 * only over its authenticated listener or gateway. A channel, webhook, schedule
 * or companion records its own kind, so its input never resets the session's
 * untrusted-content window.
 */
const OPERATOR_SURFACE_KINDS: ReadonlySet<string> = new Set(['tui', 'web', 'webui', 'agent']);

/**
 * What the engine's own refusal already says about a failed delivery, with no
 * reading: not ready yet is retried (nothing ran), a session that is gone or
 * cannot serve is failed at once. Undefined for any other error.
 */
function knownDeliveryFailure(error: unknown): 'retry' | 'terminal' | undefined {
  try {
    if (error instanceof HostedSessionNotReadyError) return 'retry';
    if (error instanceof HostedSessionUnavailableError || error instanceof HostedSessionNotFoundError) return 'terminal';
  } catch { /* an exotic thrown value is read as unknown */ }
  return undefined;
}

/**
 * How many ticks one collected input is given before it is failed.
 *
 * Small on purpose. The failures worth retrying here are the transient ones,
 * a restored session's loop still being composed, a floor lease still being
 * acquired, and those clear within a tick or two. Anything that survives
 * the bounded attempt ceiling is failed observably rather than kept in limbo.
 * The engine's own refusal decides retry eligibility when it is one (not ready
 * is retried, unavailable is not); the shared failure reader decides for any
 * other error. This count is only the ceiling after that.
 */
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;

/** One collected input still owed to a session's loop. */
interface PendingDelivery {
  readonly sessionId: string;
  readonly inputId: string;
  readonly body: string;
  /** The broker's input identity, retained through queued delivery and retry. */
  readonly correlationId?: string | undefined;
  /** An authenticated operator sent it; see OPERATOR_SURFACE_KINDS. */
  readonly operatorInput?: boolean | undefined;
  readonly attempts: number;
  /** Failed attempts to classify the current failure; bounded like delivery attempts. */
  readonly readingFailures?: number | undefined;
  readonly failure?: { readonly error: unknown; readonly detail: string; readonly blocked?: boolean; readonly reading?: FailureReadOptions } | undefined;
}

/**
 * One session's deliveries, in order, and the task draining them.
 *
 * A lane per session keeps ordering where ordering is owed, a session's own
 * steer and the follow-up meant to come after it stay serial, while leaving
 * every OTHER session's lane free to run at the same time. Delivery is the
 * whole turn; a lane that waits for one must not be allowed to hold the intake
 * pass, and with it every other session's heartbeat.
 */
interface SessionDeliveryLane {
  readonly queue: PendingDelivery[];
  worker: Promise<void> | null;
}

function pendingKey(sessionId: string, inputId: string): string {
  return `${sessionId}\u0000${inputId}`;
}

export class HostedSessionSpineIntake {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** A change arrived while a pass was scheduling: run one more pass after it. */
  private rerun = false;
  private tickQueued = false;
  private scheduling = false;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private readonly sessionLifetimes = new Map<string, AbortController>();
  private readonly fenced = new Set<string>();
  private readonly callbackOwners = new Map<string, object>();
  private readonly registrations = new Map<string, Set<Promise<void>>>();
  /** Collected inputs whose delivery has not succeeded yet, by session+input. */
  private readonly pending = new Map<string, PendingDelivery>();
  /** In-flight or queued deliveries, by session+input, so a tick never schedules one twice. */
  private readonly inFlight = new Set<string>();
  /** One delivery lane per session with work outstanding. */
  private readonly lanes = new Map<string, SessionDeliveryLane>();
  /** What each session's last successful registration said, and when. */
  private readonly lastRegistered = new Map<string, { readonly at: number; readonly title: string; readonly project: string }>();
  /**
   * Inputs whose turn ran but whose consumed mark has not reached the spine. The
   * spine still lists them as queued, so they are not collected again; the mark
   * is retried on each tick until it lands or the session closes.
   */
  private readonly unconsumed = new Map<string, { readonly sessionId: string; readonly inputId: string }>();

  private readonly failureReading: FailureReadOptions | undefined;
  constructor(private readonly options: HostedSessionSpineIntakeOptions) {
    this.failureReading = options.failureReading ? { ...options.failureReading } : undefined;
  }

  /** Begin collecting and heartbeating. A no-op without a spine. */
  start(): void {
    const spine = this.options.spine;
    if (this.timer || !spine || this.stopped) return;
    if (spine.subscribe) this.unsubscribe = spine.subscribe(() => this.queueTick());
    const interval = this.options.intervalMs ?? (this.unsubscribe ? SUBSCRIBED_RETRY_INTERVAL_MS : DEFAULT_INTAKE_INTERVAL_MS);
    this.timer = setInterval(() => { void this.tick(); }, interval);
    // Never hold the process open on account of an idle intake tick.
    (this.timer as unknown as { unref?: () => void }).unref?.();
    if (this.unsubscribe) this.queueTick();
  }

  /** One pass after the current synchronous work: a burst of changes is one read. */
  private queueTick(): void {
    if (this.tickQueued || this.stopped) return;
    this.tickQueued = true;
    queueMicrotask(() => { this.tickQueued = false; void this.tick(); });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lifetime.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Permanently stop registration admission for a terminated session. Inputs
   * it collected and still owed a delivery retry are failed on the spine with
   * the reason, never left looking collected and in progress.
   */
  fence(sessionId: string): void {
    this.fenced.add(sessionId);
    this.sessionLifetimes.get(sessionId)?.abort();
    for (const [key, entry] of this.unconsumed) if (entry.sessionId === sessionId) this.unconsumed.delete(key);
    this.lastRegistered.delete(sessionId);
    const spine = this.options.spine;
    for (const pending of [...this.pending.values()]) {
      if (pending.sessionId !== sessionId || this.inFlight.has(pendingKey(pending.sessionId, pending.inputId))) continue;
      if (spine) void this.abandon(spine, pending);
      else this.pending.delete(pendingKey(pending.sessionId, pending.inputId));
    }
  }

  /**
   * This collected input can no longer be delivered. A terminated session's
   * input is failed on the spine with that reason. A stopping intake writes
   * nothing: the daemon is going down with the broker, and the broker's boot
   * reconciliation cancels inputs left collected.
   */
  private async abandon(spine: HostedSessionSpine, pending: PendingDelivery): Promise<void> {
    this.pending.delete(pendingKey(pending.sessionId, pending.inputId));
    if (!this.fenced.has(pending.sessionId)) return;
    logger.warn('[hosted-sessions] a collected input was not delivered before its session ended; marked failed', {
      sessionId: pending.sessionId, inputId: pending.inputId,
    });
    await spine.failInput?.(pending.sessionId, pending.inputId,
      'The hosted session ended before this message was delivered; it was not answered. Send it again on a live session.').catch(() => undefined);
  }

  /** Put (or refresh) this session on the shared spine. Never throws. */
  async register(record: HostedSessionRecord): Promise<void> {
    if (!this.options.spine || this.stopped || this.fenced.has(record.id)) return;
    const registrations = this.registrations.get(record.id) ?? new Set<Promise<void>>();
    // Publish ownership before a registration callback can request termination.
    const registration = Promise.resolve().then(() => this.withLifecycle(record.id, () => this.registerSession(record)));
    registrations.add(registration);
    this.registrations.set(record.id, registrations);
    try {
      await registration;
    } finally {
      registrations.delete(registration);
      if (registrations.size === 0) this.registrations.delete(record.id);
    }
  }

  private callbackOwner(sessionId: string): object {
    let owner = this.callbackOwners.get(sessionId);
    if (!owner) { owner = {}; this.callbackOwners.set(sessionId, owner); }
    return owner;
  }

  private withLifecycle<T>(sessionId: string, callback: () => Promise<T>): Promise<T> {
    return hostedLifecycleCallbacks.run(this.callbackOwner(sessionId), () => this.options.withLifecycle?.(sessionId, callback) ?? callback());
  }

  /** An owning shutdown must not inherit a callback's self-drain restriction. */
  outsideCallbacks<T>(callback: () => T): T {
    return hostedLifecycleCallbacks.outsideMany(this.callbackOwners.values(), callback);
  }

  private assertOutsideCallback(sessionId: string): void {
    if (hostedLifecycleCallbacks.active(this.callbackOwner(sessionId))) {
      throw new Error(`Hosted session ${sessionId} lifecycle callback cannot await its own spine drain`);
    }
  }

  private async registerSession(record: HostedSessionRecord): Promise<void> {
    if (!this.options.spine) return;
    try {
      await this.options.spine.register({
        sessionId: record.id,
        kind: 'hosted',
        project: record.workspaceRoot,
        title: record.title,
        participant: {
          surfaceKind: 'service',
          surfaceId: HOSTED_PARTICIPANT_SURFACE_ID,
          lastSeenAt: this.options.now(),
        },
      });
      this.lastRegistered.set(record.id, { at: this.options.now(), title: record.title, project: record.workspaceRoot });
    } catch (error) {
      logger.warn('[hosted-sessions] registering a hosted session on the shared spine failed; it runs but is not in the union list', {
        sessionId: record.id,
        error: summarizeError(error),
      });
    }
  }

  async drainRegistrations(sessionId: string): Promise<void> {
    this.assertOutsideCallback(sessionId);
    await Promise.allSettled(this.registrations.get(sessionId) ?? []);
  }

  /** Drain and close the spine record. Refuse recursive self-drains; log broker failures. */
  async close(sessionId: string): Promise<void> {
    this.assertOutsideCallback(sessionId);
    this.fence(sessionId);
    await this.drainRegistrations(sessionId);
    if (!this.options.spine) return;
    try {
      await this.withLifecycle(sessionId, () => this.options.spine!.closeSession(sessionId));
    } catch (error) {
      logger.debug('[hosted-sessions] closing a hosted session on the shared spine failed', {
        sessionId,
        error: summarizeError(error),
      });
    }
    // The session is fenced, drained and closed: its abort controller and callback owner serve nothing now.
    this.sessionLifetimes.delete(sessionId);
    this.callbackOwners.delete(sessionId);
    this.lastRegistered.delete(sessionId);
  }

  /**
   * Drop the fence of a session the manager no longer holds. The fence is what
   * refuses a late registration, so call this only once nothing can register
   * the id again; an id is never reused.
   */
  forget(sessionId: string): void {
    this.fenced.delete(sessionId);
    this.sessionLifetimes.delete(sessionId);
    this.callbackOwners.delete(sessionId);
    this.lastRegistered.delete(sessionId);
  }

  /**
   * One pass: heartbeat every live session, then collect its queued inputs and
   * hand them to that session's delivery lane.
   *
   * What this method must NOT do is wait for a delivery. `deliver` runs the
   * whole turn, minutes, on a real one, and this used to be awaited inside
   * the re-entrancy guard, so for as long as any ONE hosted session was
   * answering, no other session was heartbeated. A hosted session whose
   * participant goes stale stops receiving its own steers and starts getting
   * background agents instead: the conversation keeps answering, from the wrong
   * thing. The stale clocks also read as idle to the session reaper, which is
   * how a session with a turn plainly still running was closed "idle-reaped".
   *
   * So the guard now covers SCHEDULING only. Delivery is detached into a
   * per-session lane, ordering within a session is the lane's job, and errors
   * out of a detached delivery are reported exactly where a thrown delivery
   * used to be reported from here.
   */
  async tick(): Promise<void> {
    const spine = this.options.spine;
    if (!spine || this.stopped) return;
    if (this.scheduling) { this.rerun = true; return; }
    this.scheduling = true;
    this.rerun = false;
    try {
      // Retries first: a message that has already waited a tick outranks one
      // still queued, and delivering out of order is how a steer arrives after
      // the follow-up that was meant to come after it.
      for (const pending of [...this.pending.values()]) {
        this.enqueueDelivery(spine, pending);
      }
      await this.retryConsumedMarks(spine);
      for (const record of this.options.liveSessions()) {
        await this.heartbeat(record);
        if (this.stopped || this.fenced.has(record.id)) continue;
        for (const input of spine.getInputsSince(record.id, { state: 'queued' })) {
          if (!input.body.trim()) continue;
          // Its turn already ran; only the consumed mark is outstanding.
          if (this.unconsumed.has(pendingKey(record.id, input.id))) continue;
          const delivery: PendingDelivery = {
            sessionId: record.id,
            inputId: input.id,
            body: input.body,
            correlationId: input.correlationId,
            ...(input.surfaceKind !== undefined && OPERATOR_SURFACE_KINDS.has(input.surfaceKind) ? { operatorInput: true } : {}),
            attempts: 0,
          };
          // Without the collected mark the input is still queued on the spine, so
          // delivering now would answer it again on the next tick.
          try { await spine.markInputDelivered(record.id, delivery.inputId); }
          catch (error) {
            logger.warn('[hosted-sessions] a queued input could not be marked collected; it stays queued and is retried next tick', {
              sessionId: record.id, inputId: input.id, error: summarizeError(error),
            });
            continue;
          }
          this.enqueueDelivery(spine, delivery);
        }
      }
    } catch (error) {
      // The tick runs on an interval with nobody awaiting it, so a throw out of
      // liveSessions() or getInputsSince() was an unhandled rejection, which,
      // on a process that treats those as fatal, took the daemon down over a
      // read that will very likely succeed on the next tick.
      logger.warn('[hosted-sessions] an intake pass failed; the next tick retries', {
        error: summarizeError(error),
      });
    } finally {
      this.scheduling = false;
    }
    if (this.rerun) this.queueTick();
  }

  /**
   * Register one session when it is new to the spine or its title or workspace
   * changed (never as a heartbeat: liveness is the engine's), without letting a broker
   * call that never settles hold the pass. A registration still outstanding
   * from an earlier tick is left to finish rather than stacked; a new one is
   * given one interval, then the pass moves on and it finishes on its own.
   */
  private async heartbeat(record: HostedSessionRecord): Promise<void> {
    if ((this.registrations.get(record.id)?.size ?? 0) > 0) return;
    const last = this.lastRegistered.get(record.id);
    if (last && last.title === record.title && last.project === record.workspaceRoot) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.intervalMs ?? DEFAULT_INTAKE_INTERVAL_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try { await Promise.race([this.register(record), bound]); }
    finally { clearTimeout(timer); }
  }

  private async retryConsumedMarks(spine: HostedSessionSpine): Promise<void> {
    for (const [key, entry] of [...this.unconsumed]) {
      try {
        await spine.markInputDelivered(entry.sessionId, entry.inputId, { consumed: true });
        this.unconsumed.delete(key);
      } catch { /* retried next tick */ }
    }
  }

  /**
   * Wait for every delivery now in flight.
   *
   * The tick no longer waits for delivery, so a caller that needs the OUTCOME
   *, a test asserting what the spine recorded, a shutdown that would rather
   * not abandon a message mid-flight, asks for it explicitly instead of
   * relying on tick() to have finished the work.
   */
  async drainDeliveries(): Promise<void> {
    for (;;) {
      const workers = [...this.lanes.values()]
        .map((lane) => lane.worker)
        .filter((worker): worker is Promise<void> => worker !== null);
      if (workers.length === 0) return;
      await Promise.all(workers);
    }
  }

  /** Put one delivery in its session's lane and make sure the lane is draining. */
  private enqueueDelivery(spine: HostedSessionSpine, pending: PendingDelivery): void {
    const key = pendingKey(pending.sessionId, pending.inputId);
    // Already queued or already being delivered: a tick that fires while a slow
    // turn is in flight must not hand the same message over a second time.
    if (this.inFlight.has(key)) return;
    // Collected after its session was fenced: it can never be delivered now.
    if (this.fenced.has(pending.sessionId)) { void this.abandon(spine, pending); return; }
    if (this.stopped) return;
    this.inFlight.add(key);
    const lane = this.lanes.get(pending.sessionId) ?? { queue: [], worker: null };
    this.lanes.set(pending.sessionId, lane);
    lane.queue.push(pending);
    this.startLane(spine, pending.sessionId, lane);
  }

  /**
   * Drain one session's lane, serially, detached from the tick that filled it.
   *
   * The lane's task never rejects: a delivery that fails is handled by
   * attemptDelivery, and anything that escapes it is reported where tick()
   * used to report it. Nobody awaits this task in normal operation, so a
   * rejection here would be an unhandled one, the failure mode this whole
   * class already exists to keep off a daemon that treats those as fatal.
   */
  private startLane(spine: HostedSessionSpine, sessionId: string, lane: SessionDeliveryLane): void {
    if (lane.worker) return;
    lane.worker = (async (): Promise<void> => {
      try {
        for (;;) {
          const next = lane.queue.shift();
          if (next === undefined) return;
          const key = pendingKey(next.sessionId, next.inputId);
          try {
            await this.attemptDelivery(spine, next);
          } catch {
            // A reader/provider exception is untrusted too. Retain the input
            // without echoing potentially credential-bearing exception text.
            logger.warn('[hosted-sessions] delivery classification unavailable; input remains collected', {
              sessionId: next.sessionId, inputId: next.inputId,
            });
          } finally {
            this.inFlight.delete(key);
          }
        }
      } finally {
        lane.worker = null;
        if (lane.queue.length > 0) {
          // Something arrived while the last delivery was settling.
          this.startLane(spine, sessionId, lane);
        } else if (this.lanes.get(sessionId) === lane) {
          this.lanes.delete(sessionId);
        }
      }
    })();
  }

  /**
   * Hand one collected input to its session's loop.
   *
   * Delivery failing is NOT the same as delivery happening: marking the input
   * consumed either way is a record saying the owner's message was answered
   * when nothing received it, and on a survive-detach session with nobody
   * attached the only trace was a warn line in the daemon log. So a failure
   * keeps the input, retries it on the next tick, and, once the attempts are
   * spent, fails it on the spine and puts the incident in front of the owner.
   */
  private async attemptDelivery(spine: HostedSessionSpine, pending: PendingDelivery): Promise<void> {
    const key = pendingKey(pending.sessionId, pending.inputId);
    const assertCurrent = () => {
      this.lifetime.signal.throwIfAborted();
      if (this.fenced.has(pending.sessionId)) throw new Error('Hosted delivery owner closed');
    };
    if (this.stopped || this.fenced.has(pending.sessionId)) { await this.abandon(spine, pending); return; }
    // A failed reading may be retried, but never by resending the input before
    // its actual delivery failure has been classified.
    if (pending.failure) {
      await this.classifyFailure(spine, pending, assertCurrent);
      return;
    }
    try {
      await this.options.deliver(pending.sessionId, pending.body, pending.correlationId,
        pending.operatorInput === true ? { operatorInput: true } : undefined);
      this.pending.delete(key);
      // A successfully completed turn stays delivered during shutdown drain.
      try { await spine.markInputDelivered(pending.sessionId, pending.inputId, { consumed: true }); }
      catch (error) {
        if (!this.fenced.has(pending.sessionId)) {
          this.unconsumed.set(key, { sessionId: pending.sessionId, inputId: pending.inputId });
          logger.warn('[hosted-sessions] a delivered input could not be marked consumed; the mark is retried and the input is not delivered again', {
            sessionId: pending.sessionId, inputId: pending.inputId, error: summarizeError(error),
          });
        }
      }
    } catch (error) {
      // Its session or this intake closed while it waited: no retry can reach it.
      if (this.stopped || this.fenced.has(pending.sessionId)) { await this.abandon(spine, pending); return; }
      const known = knownDeliveryFailure(error);
      if (known !== undefined) { await this.settleKnownFailure(spine, pending, known, summarizeError(error)); return; }
      // Keep the input collected even if the evidence is unsafe to read. It must
      // never be retried merely because privacy admission failed.
      const blocked: PendingDelivery = { ...pending, attempts: pending.attempts + 1,
        failure: { error: undefined, blocked: true, detail: 'Delivery failed; failure evidence has not been admitted.' } };
      this.pending.set(key, blocked);
      const captured = captureJudgmentFailure(error);
      const failed: PendingDelivery = { ...blocked,
        failure: { error: captured, detail: summarizeError(captured), ...(this.failureReading ? { reading: this.failureReading } : {}) } };
      this.pending.set(key, failed);
      await this.classifyFailure(spine, failed, assertCurrent);
    }
  }

  /**
   * A failure the engine classified itself. Not ready is retried on the next
   * tick until the attempts are spent; anything else fails the input now, with
   * the session's own reason.
   */
  private async settleKnownFailure(spine: HostedSessionSpine, pending: PendingDelivery, known: 'retry' | 'terminal', detail: string): Promise<void> {
    const key = pendingKey(pending.sessionId, pending.inputId);
    const attempts = pending.attempts + 1;
    if (known === 'retry' && attempts < (this.options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS)) {
      this.pending.set(key, { ...pending, attempts, failure: undefined });
      logger.warn('[hosted-sessions] a collected input could not be delivered yet; it is retried next tick', {
        sessionId: pending.sessionId, inputId: pending.inputId, attempts, error: detail,
      });
      return;
    }
    this.pending.delete(key);
    logger.error('[hosted-sessions] a collected input could not be delivered and is now marked failed', {
      sessionId: pending.sessionId, inputId: pending.inputId, attempts, error: detail,
    });
    await spine.failInput?.(pending.sessionId, pending.inputId, detail).catch(() => undefined);
    this.alertOwner(pending, attempts, detail);
  }

  /** Whether this session still has an input queued, collected or being delivered. */
  hasOutstanding(sessionId: string): boolean {
    for (const pending of this.pending.values()) if (pending.sessionId === sessionId) return true;
    for (const key of this.inFlight) if (key.startsWith(`${sessionId}\u0000`)) return true;
    try {
      return (this.options.spine?.getInputsSince(sessionId, { state: 'queued' }).length ?? 0) > 0;
    } catch {
      // Unknown is not idle: keep the session.
      return true;
    }
  }

  /**
   * Classify a delivery failure, bounding the classification itself. A reader
   * that keeps failing must not keep the input collected forever with nobody
   * told: after the same ceiling as delivery attempts it is failed and the
   * owner alerted.
   */
  private async classifyFailure(spine: HostedSessionSpine, pending: PendingDelivery, assertCurrent: () => void): Promise<void> {
    try {
      await this.resolveFailure(spine, pending, assertCurrent);
    } catch (error) {
      if (this.stopped || this.fenced.has(pending.sessionId)) { await this.abandon(spine, pending); return; }
      const key = pendingKey(pending.sessionId, pending.inputId);
      const current = this.pending.get(key) ?? pending;
      const readingFailures = (current.readingFailures ?? 0) + 1;
      if (readingFailures < (this.options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS)) {
        this.pending.set(key, { ...current, readingFailures });
        throw error;
      }
      this.pending.delete(key);
      const detail = `${current.failure?.detail ?? 'Delivery failed.'} Its failure could not be classified after ${readingFailures} attempts, so it is not retried.`;
      logger.error('[hosted-sessions] a collected input failed and its failure could not be classified; it is now marked failed', {
        sessionId: pending.sessionId, inputId: pending.inputId, attempts: current.attempts, readingFailures,
      });
      await spine.failInput?.(pending.sessionId, pending.inputId, detail).catch(() => undefined);
      this.alertOwner(current, current.attempts, detail);
    }
  }

  private async resolveFailure(spine: HostedSessionSpine, pending: PendingDelivery, assertCurrent: () => void): Promise<void> {
    return withConfiguredDecisionModelPolicy(() => this.resolveOwnedFailure(spine, pending, assertCurrent));
  }
  private async resolveOwnedFailure(spine: HostedSessionSpine, pending: PendingDelivery, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const failure = pending.failure!;
    if (failure.blocked) throw new Error('Hosted delivery failure evidence could not be admitted');
    let owner = this.sessionLifetimes.get(pending.sessionId);
    if (!owner) { owner = new AbortController(); this.sessionLifetimes.set(pending.sessionId, owner); }
    const captured = await decisionOrClassic<FailureReadOptions | undefined>(async () => failure.reading ?? { port: judgmentPort('engine.hosted-session.spine-delivery') }, () => undefined);
    const signal = AbortSignal.any([this.lifetime.signal, owner.signal, ...(captured?.signal ? [captured.signal] : [])]);
    assertCurrent(); signal.throwIfAborted();
    const reading = captured ? { ...captured, signal, beforeAttempt: () => { assertCurrent(); const result = captured.beforeAttempt?.(); if (result !== undefined) return result; signal.throwIfAborted(); } } : undefined;
    // Retain the exact owner if a reader failure needs a later reading attempt.
    this.pending.set(pendingKey(pending.sessionId, pending.inputId), { ...pending, failure: { ...failure, ...(captured ? { reading: captured } : {}) } });
    const transience = await readFailureTransience(failure.error, 'engine.hosted-session.spine-delivery', reading ? { reading } : {});
    assertCurrent(); signal.throwIfAborted();
    const key = pendingKey(pending.sessionId, pending.inputId);
    const cap = this.options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    // the count is only the mechanical ceiling AFTER eligibility.
    // A failed conversation may already have completed tools. Classic must
    // surface that failure for resume/inspection, never replay the whole turn.
    if (!isClassicOperation() && transience.failureClass === 'retryable' && pending.attempts < cap) {
      this.pending.set(key, { ...pending, failure: undefined });
      logger.warn('[hosted-sessions] a collected input could not be delivered; it stays queued for the next tick', {
        sessionId: pending.sessionId, inputId: pending.inputId, attempts: pending.attempts, error: failure.detail,
      });
      return;
    }
    this.pending.delete(key);
    logger.error('[hosted-sessions] a collected input could not be delivered and is now marked failed', {
      sessionId: pending.sessionId, inputId: pending.inputId, attempts: pending.attempts, error: failure.detail,
    });
    assertCurrent(); signal.throwIfAborted();
    await spine.failInput?.(pending.sessionId, pending.inputId, failure.detail).catch(() => undefined);
    assertCurrent(); signal.throwIfAborted();
    this.alertOwner(pending, pending.attempts, failure.detail);
  }

  /** Say it on a channel that still works. Never throws into the tick. */
  private alertOwner(pending: PendingDelivery, attempts: number, detail: string): void {
    try {
      this.options.alertOwner?.(
        `A message for hosted session ${pending.sessionId} could not be delivered after ${attempts} attempts `
        + `and has been marked failed: ${detail}`,
      );
    } catch (error) {
      logger.error('[hosted-sessions] the owner could not be told about an undelivered message', {
        sessionId: pending.sessionId,
        inputId: pending.inputId,
        error: summarizeError(error),
      });
    }
  }
}
