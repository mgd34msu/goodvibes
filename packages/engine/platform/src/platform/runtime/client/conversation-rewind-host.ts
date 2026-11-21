/**
 * conversation-rewind-host.ts, a surface answering the daemon's questions
 * about a conversation only it is holding.
 *
 * ── What was broken ───────────────────────────────────────────────────────
 *
 * Files rewind works from anywhere, because the workspace checkpoint store is
 * the daemon's. The conversation half is answerable only by the process running
 * the loop, and once the surfaces became pure clients that process is not the
 * daemon. The daemon's in-process conversation registry, which nothing outside
 * the daemon could populate, answered "0 messages to drop" for every session
 * hosted elsewhere: a confident answer to a question it could not reach.
 *
 * This module is the other end of the fix. The surface OFFERS the conversation
 * it is running; the daemon then asks that surface when a rewind touches it.
 *
 * ── Why a poll, and why it is not a poll ──────────────────────────────────
 *
 * This is a reverse call: the daemon asking a connected client and awaiting an
 * answer while a `rewind.plan` call waits on it. The delivery is a `take` that
 * the surface holds open, a long poll, not a tight loop. With nothing waiting
 * the call parks for up to the daemon's own ceiling and returns empty; with
 * work waiting it returns immediately. So the steady state is one open request,
 * not repeated requests, and an answer starts moving the instant the question
 * is raised.
 *
 * The same call renews the lease. A surface that is polling is a surface that
 * is alive, so there is no separate keepalive to get out of step with it, and
 * a crashed surface simply stops being consulted when its lease lapses, with
 * nobody cleaning up after it.
 *
 * ── Answering honestly ────────────────────────────────────────────────────
 *
 * A question about a session this process is NOT holding is answered
 * `unavailable` with the reason, never zero. That distinction is the whole
 * point: a real zero and an unreachable conversation look identical as numbers,
 * and reporting the second as the first is what made the old behaviour a lie
 * rather than a gap.
 *
 * Every failure path resolves. A request that throws while being answered is
 * answered `unavailable` with the error text rather than left to time out, so
 * the waiting `rewind.plan` gets a reason instead of a stall.
 *
 * A rewind applied here whose outcome the daemon refused (the question expired,
 * or this surface is no longer its host) is put back from its undo snapshot, so
 * the conversation never ends up shorter than the receipt the person was shown.
 * When the outcome may have reached the daemon (the first report got no answer
 * and the retry was refused as already settled), it is left as it is and the
 * undo id is logged, because putting it back could contradict a receipt that
 * says it was rewound.
 *
 * An undo request puts the conversation back from the snapshot a rewind
 * applied here kept, only while nothing was added since; otherwise it is
 * answered with the reason (snapshot gone, conversation changed) and nothing
 * changes.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { RewindAnchor, RewindConversationPort } from '../../rewind/types.js';
import { discardTurnAnchorsAfter, restoreAnchorsDroppedBy } from '../../rewind/turn-anchors.js';
import { CONVERSATION_HOST_TAKEN_OVER_CODE } from '../../rewind/conversation-host-broker.js';
import type { SessionSurface } from '../session-surface.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';

/** How long a `take` is held open. Under the daemon's 25s ceiling by design. */
const DEFAULT_WAIT_MS = 20_000;
/** How long to wait before retrying after a transport failure. */
const RETRY_BACKOFF_MS = 3_000;
/** The longest wait between claims when the same session keeps being taken from this surface. */
const MAX_RECLAIM_BACKOFF_MS = 5 * 60_000;
/** A claim that held at least this long was not contested; the streak of quick losses starts over. */
const STABLE_CLAIM_MS = 60_000;
/** A take that comes back empty sooner than this is paced, so an intermediary answering at once cannot make the loop hot. */
const MIN_EMPTY_TAKE_MS = 1_000;

/** One question, as the wire delivers it. */
interface HostRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly kind: 'preview' | 'rewind' | 'undo';
  readonly undoSnapshotId?: string;
  /** Rewind requests: the revision the apply was confirmed against; the port cuts nothing when the conversation moved on. */
  readonly expectedRevision?: string;
  readonly expiresAt: number;
}

/** Whether the daemon refused the call itself (a 4xx other than a timeout), so it certainly did not record it. */
function isDefiniteRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}

/** The daemon's code on a refused verb call, as both product verb callers carry it. */
function refusalCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export interface ConversationRewindHostOptions {
  readonly verbs: DaemonVerbCaller;
  /**
   * The port that answers, this process's own conversations, by session id.
   * With `restoreBefore`, a rewind whose outcome the daemon refused is put back
   * (only while nothing was added since, per `messagesSinceRewind`).
   */
  readonly port: RewindConversationPort & {
    restoreBefore?(undoSnapshotId: string): boolean;
    /** restoreBefore with the conversation's save awaited; an undo is answered only after it, saying when it failed. */
    restoreBeforeSaved?(undoSnapshotId: string): Promise<{ readonly restored: boolean; readonly notSaved?: string }>;
    messagesSinceRewind?(undoSnapshotId: string): number | null;
    /** The session a rewind's undo snapshot was taken of; an undo asked for another session is refused. */
    snapshotSession?(undoSnapshotId: string): string | null;
  };
  /** Whether this process is actually holding that session's conversation. */
  readonly hosts: (sessionId: string) => boolean;
  /** How this surface names itself in the refusals a person reads. */
  readonly label?: string;
  /**
   * The surface that owns the sessions directory. With it, the turn anchors a
   * rewind drops are also dropped from the sidecar, so a resume before the next
   * turn does not bring them back.
   */
  readonly surface?: SessionSurface;
  readonly waitMs?: number;
  readonly retryBackoffMs?: number;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests). */
  readonly now?: () => number;
}

export interface ConversationRewindHostClient {
  /**
   * Name the session whose conversation this surface is holding, without
   * starting the polling loop. The registration itself happens on the first
   * `pump`, so a caller that wants to drive the cycles deterministically, a
   * test, or a one-shot check, uses `offer` + `pump` and never has two takes
   * racing on one host id.
   */
  offer(sessionId: string): void;
  /** `offer`, plus the loop that keeps taking questions. Idempotent per session. */
  start(sessionId: string): void;
  /**
   * Move this surface's offer to `sessionId` when the live session changes
   * (resume, fork, recovery). Does nothing while this surface is not offering,
   * so a surface that never adopted a daemon stays quiet.
   */
  follow(sessionId: string): void;
  /**
   * Offer the conversation again after another surface took the session over and
   * this one stopped offering it. Meant for the moment the person acts on this
   * surface's session, so the claim moves back only on their say-so. Returns
   * true when it resumed; false when nothing had been taken over.
   */
  resumeIfTakenOver(): boolean;
  /** Withdraw the offer and stop. Idempotent; safe to call with nothing running. */
  stop(): Promise<void>;
  /** The host id the daemon issued, once registered. Null before that. */
  hostId(): string | null;
  /** One take-and-answer cycle: register if needed, take, answer each question. */
  pump(): Promise<number>;
}

export function createConversationRewindHost(options: ConversationRewindHostOptions): ConversationRewindHostClient {
  const log = options.log ?? logger;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const backoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const now = options.now ?? Date.now;
  interface Offer {
    readonly sessionId: string;
    readonly predecessor: Promise<void> | undefined;
    readonly retired: Promise<void>;
    readonly retire: () => void;
    hostId: string | null;
    /** When the current claim was issued, and how many claims in a row were lost within STABLE_CLAIM_MS. */
    registeredAt: number;
    lostClaims: number;
    /** Settled once a rewind this offer is applying has been answered; close waits for it before releasing the host. */
    applying: Promise<void> | undefined;
    stopped: boolean;
    running: boolean;
    /** The daemon said another surface took this session over; the loop ended instead of claiming it back. */
    takenOver: boolean;
    registration: Promise<string | null> | undefined;
    pump: Promise<number> | undefined;
    loop: Promise<void> | undefined;
    closing: Promise<void> | undefined;
    cancelBackoff: (() => void) | undefined;
  }

  let current: Offer | undefined;
  let lastClosing: Promise<void> | undefined;
  const idle = Promise.resolve();
  const isCurrent = (offer: Offer): boolean => current === offer && !offer.stopped;

  const register = (offer: Offer): Promise<string | null> => {
    if (offer.registration) return offer.registration;
    const pending = Promise.resolve().then(async () => {
      // A late old registration could otherwise claim the same session after
      // its successor. Release the predecessor before making the new claim.
      await offer.predecessor;
      if (!isCurrent(offer)) return null;
      try {
        const result = await options.verbs.invoke<{ host?: { hostId?: string } }>(
          'rewind.conversation.host.register',
          { sessionId: offer.sessionId, label: options.label ?? 'a connected surface' },
        );
        const hostId = result?.host?.hostId ?? null;
        // Keep the actual issued id even after retirement: close must release
        // that registration, but it must never become the successor's id.
        offer.hostId = hostId;
        if (hostId) offer.registeredAt = now();
        if (hostId && isCurrent(offer)) {
          log.info(`[rewind] offered this session's conversation to the daemon (host ${hostId})`);
        }
        return hostId;
      } catch (error) {
        if (isCurrent(offer)) {
          log.debug('[rewind] offering this conversation to the daemon failed', { error: summarizeError(error) });
        }
        return null;
      }
    });
    offer.registration = pending;
    const clear = () => { if (offer.registration === pending) offer.registration = undefined; };
    void pending.then(clear, clear);
    return pending;
  };

  const answerFor = async (offer: Offer, request: HostRequest, state: { applied: boolean }): Promise<Record<string, unknown> | undefined> => {
    if (!isCurrent(offer)) return undefined;
    const hosted = options.hosts(request.sessionId);
    if (!isCurrent(offer)) return undefined;
    if (!hosted) {
      return {
        unavailableReason: `this surface is no longer holding the conversation for session ${request.sessionId}`,
      };
    }
    const anchor: RewindAnchor = { sessionId: request.sessionId, turnId: request.turnId ?? undefined };
    // A port that could not answer for this anchor says so; its zero counts
    // must not travel on as a real "nothing to drop".
    const unavailable = (reason: string | undefined) => ({
      unavailableReason: reason?.trim() || `this surface could not rewind the conversation for session ${request.sessionId}`,
    });
    if (request.kind === 'undo') return await undoHere(request);
    if (request.kind === 'preview') {
      const preview = await options.port.preview(anchor);
      if (!isCurrent(offer)) return undefined;
      if (preview.available === false) return unavailable(preview.unavailableReason);
      return { messagesToDrop: preview.messagesToDrop, messagesRemaining: preview.messagesRemaining,
        ...(preview.revision ? { revision: preview.revision } : {}) };
    }
    const outcome = await options.port.rewind(anchor, request.expectedRevision);
    if (outcome.available === false) return isCurrent(offer) ? unavailable(outcome.unavailableReason) : undefined;
    // The conversation has been cut. The daemon owns the record of that and is
    // waiting for the dropped count and the undo handle, so the outcome is
    // reported even when this offer was withdrawn while the rewind ran.
    state.applied = true;
    // Kept under the undo id, so putting the rewind back also puts the anchors back.
    if (anchor.turnId !== undefined && !discardTurnAnchorsAfter(anchor.sessionId, anchor.turnId, options.surface, outcome.undoSnapshotId).saved) {
      log.warn('the list of rewind points could not be saved; after a restart it may offer turns that were rewound away', { sessionId: anchor.sessionId });
    }
    return { droppedMessages: outcome.droppedMessages, undoSnapshotId: outcome.undoSnapshotId,
      ...(outcome.undoExpiresAfter ? { undoExpiresAfter: outcome.undoExpiresAfter } : {}) };
  };

  /** Restore the pre-rewind conversation, only while nothing newer was added since the rewind. */
  const undoHere = async (request: HostRequest): Promise<Record<string, unknown>> => {
    const id = request.undoSnapshotId ?? '';
    const port = options.port;
    if (!port.restoreBefore || !port.messagesSinceRewind) {
      return { unavailableReason: 'this surface keeps no undo snapshots for its conversation' };
    }
    const since = id ? port.messagesSinceRewind(id) : null;
    const owner = since === null ? null : port.snapshotSession?.(id) ?? null;
    if (owner !== null && owner !== request.sessionId) {
      return { unavailableReason: `undo snapshot ${id} is of session ${owner}, not ${request.sessionId}; nothing was changed`, unavailableCode: 'TARGET_CHANGED' };
    }
    if (since === null) {
      return { unavailableReason: 'the undo snapshot is gone from this surface (only the newest 32 rewinds keep one)', unavailableCode: 'UNDO_POINT_GONE' };
    }
    if (since !== 0) {
      const what = since > 0 ? `${since} newer message${since === 1 ? '' : 's'}` : 'been edited';
      return { unavailableReason: `the conversation has ${what} since the rewind`, unavailableCode: 'CONVERSATION_CHANGED' };
    }
    // The save is awaited where the port offers it, so "undone" is reported once the restore is on disk or said not to be.
    const restored = port.restoreBeforeSaved ? await port.restoreBeforeSaved(id) : { restored: port.restoreBefore(id) };
    if (!restored.restored) {
      return { unavailableReason: 'the undo snapshot is gone from this surface', unavailableCode: 'UNDO_POINT_GONE' };
    }
    restoreAnchorsDroppedBy(id, options.surface);
    return { undone: true, ...(restored.notSaved === undefined ? {} : { notSaved: restored.notSaved }) };
  };

  /** A rewind applied here that the daemon has no record of: put it back when that is certain. */
  const settleUnreported = (request: HostRequest, undoSnapshotId: unknown, mayHaveLanded: boolean, error: unknown): void => {
    const undoId = typeof undoSnapshotId === 'string' ? undoSnapshotId : '';
    const untouched = undoId !== '' && (options.port.messagesSinceRewind?.(undoId) ?? 0) === 0;
    if (!mayHaveLanded && untouched && options.port.restoreBefore?.(undoId)) {
      restoreAnchorsDroppedBy(undoId, options.surface);
      log.warn('[rewind] the daemon refused the outcome of a rewind applied here, so the conversation was put back as it was', {
        requestId: request.requestId, sessionId: request.sessionId, error: summarizeError(error),
      });
      return;
    }
    log.warn('[rewind] the conversation was rewound here but the daemon has no confirmed record of it; its undo id restores it', {
      requestId: request.requestId, sessionId: request.sessionId, undoSnapshotId: undoId, error: summarizeError(error),
    });
  };

  const answer = async (offer: Offer, hostId: string, request: HostRequest): Promise<void> => {
    const state = { applied: false };
    let finished: () => void = () => {};
    if (request.kind !== 'preview') offer.applying = new Promise<void>((resolve) => { finished = resolve; });
    try {
      let payload: Record<string, unknown> | undefined;
      try {
        payload = await answerFor(offer, request, state);
      } catch (error) {
        if (!isCurrent(offer)) return;
        payload = { unavailableReason: `the surface hosting this conversation could not answer: ${summarizeError(error)}` };
      }
      if (payload?.['undone'] === true) state.applied = true;
      if (!payload || (!isCurrent(offer) && !state.applied)) return;
      // An applied rewind whose report got no answer is worth one more try: the
      // undo handle exists nowhere else. A report the daemon refused is not.
      let mayHaveLanded = false;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await options.verbs.invoke('rewind.conversation.requests.answer', {
            hostId, requestId: request.requestId, ...payload,
          });
          return;
        } catch (error) {
          const refused = isDefiniteRefusal(error);
          if (!refused) mayHaveLanded = true;
          if (state.applied && attempt === 1 && !refused) continue;
          if (state.applied && request.kind === 'undo') {
            log.warn('[rewind] the conversation was restored here but the daemon has no confirmed record of it', {
              requestId: request.requestId, sessionId: request.sessionId, error: summarizeError(error),
            });
          } else if (state.applied) {
            settleUnreported(request, payload['undoSnapshotId'], mayHaveLanded, error);
          } else if (isCurrent(offer)) {
            log.debug('[rewind] the daemon would not accept this answer', {
              requestId: request.requestId, error: summarizeError(error),
            });
          }
          return;
        }
      }
    } finally {
      finished();
    }
  };

  const pumpOffer = async (offer: Offer): Promise<number> => {
    if (!isCurrent(offer)) return 0;
    if (!offer.hostId) {
      await register(offer);
      if (!isCurrent(offer) || !offer.hostId) return 0;
    }
    const hostId = offer.hostId;
    let taken: { requests?: readonly HostRequest[] } | null = null;
    try {
      taken = await options.verbs.invoke<{ requests?: readonly HostRequest[] }>(
        'rewind.conversation.requests.take',
        { hostId, waitMs },
      );
    } catch (error) {
      // Releasing our own host wakes its pending take with host-unknown. That
      // retired cycle owes no retry or new semantic error/redaction reading.
      if (isCurrent(offer)) {
        // A claim lost quickly, again and again, means another surface holds
        // this session too and each claim evicts the other. The wait between
        // claims grows so the two stop trading the session every few seconds.
        offer.lostClaims = now() - offer.registeredAt < STABLE_CLAIM_MS ? offer.lostClaims + 1 : 1;
        offer.hostId = null;
        // A daemon that says another surface took the session over is not a
        // transport failure: claiming again would only take it back. The loop
        // ends; the next `start` for this session (a command run here) claims it.
        if (refusalCode(error) === CONVERSATION_HOST_TAKEN_OVER_CODE) {
          offer.running = false;
          offer.takenOver = true;
          log.warn('[rewind] another surface took over this session\'s conversation; this surface stopped offering it');
          return 0;
        }
        if (offer.lostClaims === 3) {
          log.warn('[rewind] this session\'s conversation keeps being taken over by another surface; claims are being spaced out');
        }
        log.debug('[rewind] taking conversation-rewind questions failed; will re-offer', {
          error: summarizeError(error),
        });
      }
      return 0;
    }
    if (!isCurrent(offer)) return 0;
    const requests = taken?.requests ?? [];
    for (const request of requests) {
      if (!isCurrent(offer)) break;
      // The daemon stopped waiting for this one; applying it now would change the
      // conversation for a rewind that was already reported as unanswered.
      if (Number.isFinite(request.expiresAt) && request.expiresAt <= now()) {
        log.debug('[rewind] skipped a question the daemon had already stopped waiting for', { requestId: request.requestId });
        continue;
      }
      await answer(offer, hostId, request);
    }
    return isCurrent(offer) ? requests.length : 0;
  };

  const pump = (offer: Offer): Promise<number> => {
    if (offer.pump) return offer.pump;
    const pending = Promise.resolve().then(() => pumpOffer(offer));
    offer.pump = pending;
    const clear = () => { if (offer.pump === pending) offer.pump = undefined; };
    void pending.then(clear, clear);
    return pending;
  };

  const backoff = async (offer: Offer, ms: number = backoffMs): Promise<void> => {
    if (!isCurrent(offer) || !offer.running) return;
    if (options.sleep) {
      await Promise.race([options.sleep(ms), offer.retired]);
      return;
    }
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        if (offer.cancelBackoff === finish) offer.cancelBackoff = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      offer.cancelBackoff = finish;
    });
  };

  const run = async (offer: Offer): Promise<void> => {
    while (isCurrent(offer) && offer.running) {
      const startedAt = now();
      const handled = await pump(offer);
      if (!isCurrent(offer) || !offer.running) return;
      if (!offer.hostId) {
        await backoff(offer, Math.min(backoffMs * 2 ** Math.max(0, offer.lostClaims - 1), Math.max(backoffMs, MAX_RECLAIM_BACKOFF_MS)));
      } else if (handled === 0 && waitMs === 0) {
        await backoff(offer);
      } else if (handled === 0 && now() - startedAt < MIN_EMPTY_TAKE_MS) {
        await backoff(offer, MIN_EMPTY_TAKE_MS);
      }
    }
  };

  const close = (offer: Offer): Promise<void> => {
    if (offer.closing) return offer.closing;
    offer.stopped = true;
    offer.running = false;
    if (current === offer) current = undefined;
    offer.retire();
    offer.cancelBackoff?.();
    // Retire synchronously; drain each promise captured by this exact offer.
    const pendingPump = offer.pump;
    const pendingLoop = offer.loop;
    offer.closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        // A rewind being applied is answered under the host that asked for it.
        await offer.applying;
        await offer.predecessor;
        await offer.registration;
        const hostId = offer.hostId;
        offer.hostId = null;
        if (hostId) {
          try {
            await options.verbs.invoke('rewind.conversation.host.release', { sessionId: offer.sessionId, hostId });
            log.info('[rewind] withdrew this session\'s conversation from the daemon');
          } catch {
            // Cleanup remains observable without reading retired private error
            // text. A lapsed registration already has the desired end state.
            log.debug('[rewind] releasing the conversation host was not acknowledged');
          }
        }
      } catch (error) { failures.push(error); }
      const outcomes = await Promise.allSettled([pendingPump, pendingLoop]);
      for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Conversation rewind host cleanup failed');
    });
    // Session changes initiate cleanup synchronously without an awaiting caller.
    // The original rejection remains observable through the retained close.
    void offer.closing.catch(() => {});
    lastClosing = offer.closing;
    return offer.closing;
  };

  const offer = (sessionId: string): Offer | undefined => {
    if (!sessionId) return undefined;
    if (current?.sessionId === sessionId) return current;
    if (current) close(current);
    let retire!: () => void;
    const retired = new Promise<void>(resolve => { retire = resolve; });
    current = {
      sessionId, predecessor: lastClosing, retired, retire,
      hostId: null, registeredAt: 0, lostClaims: 0, applying: undefined, stopped: false, running: false, takenOver: false,
      registration: undefined, pump: undefined, loop: undefined,
      closing: undefined, cancelBackoff: undefined,
    };
    return current;
  };

  const launch = (offered: Offer): void => {
    offered.running = true;
    offered.loop = run(offered).catch(error => {
      if (!isCurrent(offered)) return;
      offered.running = false;
      log.warn('[rewind] the conversation-host loop stopped', { error: summarizeError(error) });
    });
  };

  return {
    offer(sessionId): void { offer(sessionId); },

    start(sessionId): void {
      const offered = offer(sessionId);
      if (!offered || offered.running) return;
      launch(offered);
    },

    follow(sessionId): void {
      const previous = current;
      if (!sessionId || !previous || !isCurrent(previous) || previous.sessionId === sessionId) return;
      const wasLive = previous.running || previous.takenOver;
      const offered = offer(sessionId);
      if (offered && wasLive && !offered.running) launch(offered);
    },

    resumeIfTakenOver(): boolean {
      const offered = current;
      if (!offered || !isCurrent(offered) || !offered.takenOver || offered.running) return false;
      offered.takenOver = false;
      offered.lostClaims = 0;
      launch(offered);
      return true;
    },

    stop(): Promise<void> { return current ? close(current) : lastClosing ?? idle; },
    hostId: () => current?.hostId ?? null,
    pump: () => current ? pump(current) : Promise.resolve(0),
  };
}
