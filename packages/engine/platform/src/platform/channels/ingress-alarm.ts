/**
 * ingress-alarm.ts, a message from the owner that the daemon failed to process
 * is an INCIDENT, not a log line.
 *
 * The failure this exists for, in full: a route binding pointed at a closed
 * session, every inbound Telegram update threw `Session is closed`, and the
 * poller did the only sensible thing with a poison update, logged it at warn
 * and advanced the cursor past it. That warn went into a multi-megabyte debug
 * file. Nothing else happened. Channel health went on reporting the surface
 * fine, because health watches whether the poll LOOP is running and the loop
 * was running perfectly; it was the processing behind it that was eating
 * messages. The owner found out by noticing silence.
 *
 * Advancing the cursor is still right, a wedged cursor redelivering one poison
 * update forever is the worse failure, and it takes the whole channel down
 * rather than one message. What changes here is that advancing past is LOUD:
 *
 * 1. The surface's health goes degraded with the real reason, through the
 *    observation the health rule already reads (`ChannelRuntimeObservation.lastError`
 *    → `resolveChannelHealthState` → `degraded`). No parallel health mechanism.
 * 2. The owner hears it from the channel health watcher, the one announcer of a
 *    surface going bad and coming back (health-watcher.ts). A failure run
 *    starting or ending wakes the watcher at once instead of at its next sweep;
 *    the watcher's own rules say how often a failing surface is repeated.
 *
 * The rollover in session-broker-intent.ts means the closed-session class
 * should not reach here at all any more. This is for the classes nobody has
 * predicted yet, which is the point, since the predicted one is exactly the
 * one that went unnoticed for a day.
 */

import type { ChannelSurface } from './types.js';
import { logger } from '../utils/logger.js';

/** What the health observation reports for a surface whose processing fails. */
export interface ChannelIngressFailureState {
  /** The named reason processing failed, carried verbatim into health. */
  readonly detail: string;
  /** When the CURRENT run of failures started. */
  readonly since: number;
  /** When the most recent failure happened. */
  readonly at: number;
  /** How many messages this run has failed to process. */
  readonly count: number;
  /**
   * What happens to a message that failed, a fact of how the surface receives
   * it: `skipped` (a polled feed advances past it; nothing sends it again) or
   * `redelivered` (a webhook answered with an error; the provider sends it again).
   */
  readonly delivery: IngressFailureDelivery;
}

export type IngressFailureDelivery = 'skipped' | 'redelivered';

/**
 * The failure as the surface's health reason: what failed and what became of
 * the messages, from how the surface receives them. A skipped message is gone
 * (send it again); a webhook message is sent again by its provider, so sending
 * it again by hand would deliver it twice.
 */
export function describeIngressFailure(state: ChannelIngressFailureState | null | undefined): string | undefined {
  if (!state) return undefined;
  const one = state.count === 1;
  const what = state.delivery === 'redelivered'
    ? `${one ? '1 arriving message' : `${state.count} arriving messages`} could not be processed; the provider sends ${one ? 'it' : 'them'} again on its own, so do not resend ${one ? 'it' : 'them'}`
    : `${one ? '1 arriving message was' : `${state.count} arriving messages were`} skipped and will not be retried; send ${one ? 'it' : 'them'} again once this works`;
  return `${state.detail} (${what})`;
}

export interface ChannelIngressAlarmDeps {
  /** Test seam. */
  readonly now?: (() => number) | undefined;
}

/**
 * What happened to one inbound message, the only thing the alarm reads.
 *
 * - `processed`: the surface took the message (answered, started, continued).
 * - `refused`: the request was turned away on purpose, a policy refusal, an
 *   answer that was consumed, a bad signature, a malformed body. Redelivery
 *   cannot change it and it says nothing about whether processing works, so
 *   it neither starts nor ends a failure run.
 * - `failed`: the message could not be processed and may be lost.
 */
export type IngressOutcome = 'processed' | 'refused' | 'failed';

/**
 * The one rule for turning an ingress answer into an outcome. A thrown error is
 * `failed` at the caller. A missing answer is `refused` (nothing handled it).
 * 408, 409 (could not be started), 429 and 5xx are failures; every other 4xx is
 * a refusal; anything below 400 was processed.
 */
export function ingressOutcome(answer: Response | number | null | undefined): IngressOutcome {
  if (answer === null || answer === undefined) return 'refused';
  const status = typeof answer === 'number' ? answer : answer.status;
  if (status >= 500 || status === 408 || status === 409 || status === 429) return 'failed';
  if (status >= 400) return 'refused';
  return 'processed';
}

/**
 * Per-surface latch over inbound-processing failures: one instance per daemon,
 * shared by every inbound path (the Telegram poller, the webhook seam in
 * `ChannelPluginRegistry`, the streaming surfaces in
 * `ChannelProviderRuntimeManager`, the detached slash-command paths), because
 * "is this surface failing" is a question about the SURFACE, not about which
 * mechanism noticed.
 *
 * Deliberately not per-message and not per-error-text: the question the owner
 * needs answered is "is this channel carrying my messages", which is a property
 * of the surface over time, not of any one update. It tells nobody itself;
 * listeners hear when a run starts or ends.
 */
export class ChannelIngressAlarm {
  private readonly states = new Map<ChannelSurface, ChannelIngressFailureState>();
  /**
   * When a surface whose processing had failed last processed a message. Kept
   * only for surfaces that failed once (a handful), so a webhook surface that
   * nothing else can observe can be read as working again.
   */
  private readonly processedAfterFailure = new Map<ChannelSurface, number>();
  private readonly listeners = new Set<(surface: ChannelSurface) => void>();

  constructor(private readonly deps: ChannelIngressAlarmDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Hear when a surface starts or stops failing; returns the unsubscribe. */
  subscribe(listener: (surface: ChannelSurface) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The live failure run for a surface, or null when it is processing cleanly. */
  failure(surface: ChannelSurface): ChannelIngressFailureState | null {
    return this.states.get(surface) ?? null;
  }

  /** When this surface last processed a message after having failed, if it ever failed. */
  recoveredAt(surface: ChannelSurface): number | undefined {
    return this.states.has(surface) ? undefined : this.processedAfterFailure.get(surface);
  }

  /** One inbound message could not be processed: skipped (a polled feed) or left for its provider to send again (a webhook). */
  recordFailure(surface: ChannelSurface, detail: string, delivery: IngressFailureDelivery): void {
    const at = this.now();
    const previous = this.states.get(surface);
    const state: ChannelIngressFailureState = {
      detail,
      since: previous?.since ?? at,
      at,
      count: (previous?.count ?? 0) + 1,
      delivery,
    };
    this.states.set(surface, state);
    // ERROR, not warn: the previous version of this condition was a warn line
    // in a debug file, which is why it went unseen for a day.
    logger.error(delivery === 'redelivered' ? 'An inbound message could not be processed; its provider will send it again' : 'An inbound message could not be processed and was skipped', {
      surface,
      detail,
      failedSinceStart: state.count,
      runStartedAt: state.since,
    });
    if (!previous) this.changed(surface);
  }

  /** A message processed cleanly. Ends a failure run. */
  recordSuccess(surface: ChannelSurface): void {
    const previous = this.states.get(surface);
    if (!previous) {
      if (this.processedAfterFailure.has(surface)) this.processedAfterFailure.set(surface, this.now());
      return;
    }
    this.states.delete(surface);
    this.processedAfterFailure.set(surface, this.now());
    logger.info('Inbound processing recovered on a channel that had been failing', {
      surface,
      skippedDuringOutage: previous.count,
    });
    this.changed(surface);
  }

  /** Record one message's outcome: only `processed` ends a run, only `failed` starts or extends one. */
  record(surface: ChannelSurface, outcome: IngressOutcome, detail: string, delivery: IngressFailureDelivery): void {
    if (outcome === 'processed') this.recordSuccess(surface);
    else if (outcome === 'failed') this.recordFailure(surface, detail, delivery);
  }

  /** A listener must never take down the caller that was already handling a failure. */
  private changed(surface: ChannelSurface): void {
    for (const listener of this.listeners) {
      try {
        listener(surface);
      } catch (error) {
        logger.error('A channel-ingress listener failed', {
          surface,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * One ingress loop's answer to "can I process what I am receiving?", kept
 * separate from "am I receiving?".
 *
 * Those are different questions and conflating them is the entire defect. The
 * Telegram poll loop was turning over perfectly, mode polling, running true,
 * reason "long-polling", while every update it handed on threw, and the
 * surface reported `healthy` for a day. So the failure is held HERE rather than
 * on the supervisor's own status object, which the mode transitions replace
 * wholesale and would have quietly erased it on the next refresh.
 *
 * `lastError` is what an ingress folds into the health observation it publishes
 * (`observedRuntime(running, reason, lastError)` → `degraded`). The alarm, if
 * one is wired, carries the failure to the daemon's health view; a node
 * without one still logs and still reports degraded.
 *
 * Written against `ChannelSurface` rather than Telegram so any ingress with a
 * catch-and-continue loop gets the same behaviour by holding one of these.
 */
export class IngressProcessingHealth {
  private failure: ChannelIngressFailureState | null = null;

  constructor(
    private readonly surface: ChannelSurface,
    private readonly alarm?: ChannelIngressAlarm | undefined,
  ) {}

  /** The reason processing is currently failing, or undefined when it is not. */
  get lastError(): string | undefined {
    return describeIngressFailure(this.failure);
  }

  /**
   * One inbound message could not be processed and was skipped past.
   *
   * Skipping is still right, a cursor wedged on one poison message redelivers
   * it forever and takes the whole channel down instead of one message. What
   * changed is that it is loud: ERROR rather than the warn line that sat unread
   * in a multi-megabyte debug file, plus degraded health the watcher announces.
   */
  recordFailure(detail: string, context: Record<string, unknown> = {}): void {
    const at = Date.now();
    this.failure = { detail, since: this.failure?.since ?? at, at, count: (this.failure?.count ?? 0) + 1, delivery: 'skipped' };
    logger.error('An inbound message could not be processed; advancing past it', {
      surface: this.surface,
      ...context,
      error: detail,
    });
    this.alarm?.recordFailure(this.surface, detail, 'skipped');
  }

  /** A message processed cleanly, ending any run of failures. */
  recordSuccess(): void {
    if (this.failure === null) return;
    this.failure = null;
    this.alarm?.recordSuccess(this.surface);
  }
}
