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
 * 2. The owner is told once, on a channel that still works. Not once per
 *    message: a broken processing path fails every message, and an alarm that
 *    fires per message is an alarm nobody reads. First failure notifies;
 *    repeats inside the window are counted, not re-sent; recovery says so once.
 *
 * The rollover in session-broker-intent.ts means the closed-session class
 * should not reach here at all any more. This is for the classes nobody has
 * predicted yet, which is the point, since the predicted one is exactly the
 * one that went unnoticed for a day.
 */

import type { ChannelSurface } from './types.js';
import { logger } from '../utils/logger.js';

/** How long after a notified failure the same surface stays quiet. */
export const DEFAULT_INGRESS_ALARM_WINDOW_MS = 30 * 60 * 1000;

/** What the owner is told, and what the health observation reports. */
export interface ChannelIngressFailureState {
  /** The named reason processing failed, carried verbatim into health. */
  readonly detail: string;
  /** When the CURRENT run of failures started. */
  readonly since: number;
  /** When the most recent failure happened. */
  readonly at: number;
  /** How many messages this run has failed to process. */
  readonly count: number;
  /** When the owner was last told about this run, or null if never. */
  readonly notifiedAt: number | null;
}

export interface ChannelIngressAlarmDeps {
  /**
   * Put one line in front of the owner. The implementation picks a channel
   * that still works, deliberately not necessarily `surface`, because the
   * surface that just failed to RECEIVE may well still SEND (Telegram's sends
   * worked throughout the incident this exists for), and if it cannot, another
   * connected channel can.
   */
  readonly notify: (surface: ChannelSurface, text: string) => void;
  /** Quiet window after a notification; defaults to 30 minutes. */
  readonly windowMs?: number | undefined;
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
 * Per-surface latch over inbound-processing failures.
 *
 * Deliberately not per-message and not per-error-text: the question the owner
 * needs answered is "is this channel carrying my messages", which is a property
 * of the surface over time, not of any one update.
 */
export class ChannelIngressAlarm {
  private readonly states = new Map<ChannelSurface, ChannelIngressFailureState>();
  /**
   * When the owner was last told a surface is failing, kept past the end of a
   * run. One broken chat among working ones ends a run on every success, and
   * without this each new run notified at once: a "heads up" and a
   * "processing again" per message.
   */
  private readonly lastNotifiedAt = new Map<ChannelSurface, number>();

  constructor(private readonly deps: ChannelIngressAlarmDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private windowMs(): number {
    const configured = this.deps.windowMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_INGRESS_ALARM_WINDOW_MS;
  }

  /** The live failure run for a surface, or null when it is processing cleanly. */
  failure(surface: ChannelSurface): ChannelIngressFailureState | null {
    return this.states.get(surface) ?? null;
  }

  /**
   * One inbound message could not be processed and was skipped.
   *
   * Returns true when this call notified the owner, so a caller can assert on
   * the rate limit rather than on the notification side effect.
   */
  recordFailure(surface: ChannelSurface, detail: string): boolean {
    const at = this.now();
    const previous = this.states.get(surface);
    const state: ChannelIngressFailureState = {
      detail,
      since: previous?.since ?? at,
      at,
      count: (previous?.count ?? 0) + 1,
      notifiedAt: previous?.notifiedAt ?? null,
    };
    // ERROR, not warn: the previous version of this condition was a warn line
    // in a debug file, which is why it went unseen for a day.
    logger.error('An inbound message could not be processed and was skipped', {
      surface,
      detail,
      failedSinceStart: state.count,
      runStartedAt: state.since,
    });
    const lastNotified = state.notifiedAt ?? this.lastNotifiedAt.get(surface) ?? null;
    const quietUntil = lastNotified === null ? null : lastNotified + this.windowMs();
    if (quietUntil !== null && at < quietUntil) {
      this.states.set(surface, state);
      return false;
    }
    this.states.set(surface, { ...state, notifiedAt: at });
    this.lastNotifiedAt.set(surface, at);
    this.send(
      surface,
      state.count === 1
        ? `Heads up: a message that arrived on ${surface} could not be processed and was skipped, ${detail}. `
          + `${surface} is being treated as degraded until one goes through.`
        : `${surface} is still failing to process arriving messages (${state.count} skipped since this started), ${detail}.`,
    );
    return true;
  }

  /**
   * A message processed cleanly. Ends a failure run, and says so once if the
   * owner had been told about it.
   */
  recordSuccess(surface: ChannelSurface): void {
    const previous = this.states.get(surface);
    if (!previous) return;
    this.states.delete(surface);
    logger.info('Inbound processing recovered on a channel that had been failing', {
      surface,
      skippedDuringOutage: previous.count,
    });
    if (previous.notifiedAt === null) return;
    this.send(
      surface,
      `${surface} is processing arriving messages again. ${previous.count} `
      + `${previous.count === 1 ? 'message was' : 'messages were'} skipped while it was failing; `
      + 'those are not retried, so anything you sent in that window is worth sending again.',
    );
  }

  /** Record one message's outcome: only `processed` ends a run, only `failed` starts or extends one. */
  record(surface: ChannelSurface, outcome: IngressOutcome, detail: string): void {
    if (outcome === 'processed') this.recordSuccess(surface);
    else if (outcome === 'failed') this.recordFailure(surface, detail);
  }

  /**
   * Notifying must never be a way for the alarm to take down the caller that
   * was already handling a failure.
   */
  private send(surface: ChannelSurface, text: string): void {
    try {
      this.deps.notify(surface, text);
    } catch (error) {
      logger.error('The channel-ingress alarm could not be delivered', {
        surface,
        error: error instanceof Error ? error.message : String(error),
      });
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
 * one is wired, decides separately whether the OWNER hears about it; a node
 * without one still logs and still reports degraded.
 *
 * Written against `ChannelSurface` rather than Telegram so any ingress with a
 * catch-and-continue loop gets the same behaviour by holding one of these.
 */
export class IngressProcessingHealth {
  private failure: string | null = null;

  constructor(
    private readonly surface: ChannelSurface,
    private readonly alarm?: ChannelIngressAlarm | undefined,
  ) {}

  /** The reason processing is currently failing, or undefined when it is not. */
  get lastError(): string | undefined {
    return this.failure ?? undefined;
  }

  /**
   * One inbound message could not be processed and was skipped past.
   *
   * Skipping is still right, a cursor wedged on one poison message redelivers
   * it forever and takes the whole channel down instead of one message. What
   * changed is that it is loud: ERROR rather than the warn line that sat unread
   * in a multi-megabyte debug file, plus degraded health, plus the alarm.
   */
  recordFailure(detail: string, context: Record<string, unknown> = {}): void {
    this.failure = detail;
    logger.error('An inbound message could not be processed; advancing past it', {
      surface: this.surface,
      ...context,
      error: detail,
    });
    this.alarm?.recordFailure(this.surface, detail);
  }

  /** A message processed cleanly, ending any run of failures. */
  recordSuccess(): void {
    if (this.failure === null) return;
    this.failure = null;
    this.alarm?.recordSuccess(this.surface);
  }
}
