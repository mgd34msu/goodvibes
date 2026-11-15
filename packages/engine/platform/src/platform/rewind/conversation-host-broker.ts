/**
 * conversation-host-broker.ts, conversation-scope rewind served by the surface
 * that actually hosts the conversation.
 *
 * WHAT WAS MISSING. Files rewind works from anywhere, because the workspace
 * checkpoint store is the daemon's own. The conversation half is answerable
 * only by the process running the loop, and once the surfaces became pure
 * clients that process is not the daemon. The daemon's in-process port resolved
 * a session's conversation out of a map nothing outside the daemon could
 * populate, so `rewind.plan` with scope 'conversation' returned "0 messages to
 * drop" for every session hosted anywhere else, a confident answer to a
 * question it could not reach.
 *
 * WHAT THIS IS. A surface REGISTERS the conversation it is hosting for a
 * session; the daemon then asks that surface, over the surface's own
 * connection, when a rewind touches it. There is no cross-surface path and
 * deliberately so: only the process holding the messages can count them or drop
 * them, so anyone else's answer would be a guess. A session nobody has
 * registered is reported unavailable with the reason, never as zero.
 *
 * THE SHAPE, and why it is this one. This is a reverse call, the daemon asking
 * a connected client and awaiting an answer, and the platform already has one
 * of those in ApprovalBroker: a record, a resolver held beside it, a bounded
 * deadline, and every outcome RESOLVING rather than rejecting so no caller is
 * ever left holding a promise. The same four apply here. Where it differs is
 * delivery: an approval fans out on an event stream because a person may take
 * minutes, whereas a rewind ask is answered by a program in milliseconds and
 * the asking `rewind.plan` call is waiting on it. So the host takes its
 * requests on its own connection (`rewind.conversation.requests.take`,
 * optionally waiting) and answers on it. That needs no publisher wired into the
 * verb groups and no second channel to keep honest.
 *
 * NOTHING HERE IS PERSISTED. A registration is a claim about a live process; a
 * restart means every claim is stale, and re-reading them from disk would
 * resurrect hosts that no longer exist. Instead a registration carries a lease
 * the host renews by polling, and an unrenewed one is dropped on the next
 * access, so the state is bounded by time rather than by a sweep, and a
 * crashed surface stops being consulted without anyone cleaning up after it.
 */
import { randomUUID } from 'node:crypto';
import type {
  RewindAnchor,
  RewindConversationOutcome,
  RewindConversationPort,
  RewindConversationPreview,
} from './types.js';

/** What a host is asked to do. */
export type ConversationRewindRequestKind = 'preview' | 'rewind' | 'undo';

/** Why a host could not undo a rewind, when it is a reason the caller can act on. */
export type ConversationUndoRefusalCode = 'UNDO_POINT_GONE' | 'CONVERSATION_CHANGED';

/** A surface's live claim on one session's conversation. */
export interface ConversationRewindHost {
  readonly hostId: string;
  readonly sessionId: string;
  /** How the surface names itself, for the refusal messages a person reads. */
  readonly label: string;
  readonly registeredAt: number;
  readonly leaseExpiresAt: number;
}

/** One question put to a host, as the host sees it. */
export interface ConversationRewindRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly kind: ConversationRewindRequestKind;
  /** Undo requests: the snapshot the conversation is restored from. */
  readonly undoSnapshotId?: string | undefined;
  /** When this question stops waiting; an answer after it is refused. */
  readonly expiresAt: number;
}

/** What a host answers with. */
export type ConversationRewindAnswer =
  | { readonly kind: 'preview'; readonly messagesToDrop: number; readonly messagesRemaining: number }
  | { readonly kind: 'rewind'; readonly droppedMessages: number; readonly undoSnapshotId: string; readonly undoExpiresAfter?: string | undefined }
  | { readonly kind: 'undone' }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly code?: ConversationUndoRefusalCode | undefined };

/** Why a host-facing call was refused. Each maps to one honest message. */
export type ConversationRewindRefusal =
  | 'not-the-host'
  | 'taken-over'
  | 'host-unknown'
  | 'request-unknown'
  | 'request-expired'
  | 'too-many-hosts';

/**
 * The wire code for a host whose session another surface claimed. A surface
 * that receives it stops offering the session instead of claiming it back;
 * every other refusal of a host-facing call is a plain conflict.
 */
export const CONVERSATION_HOST_TAKEN_OVER_CODE = 'HOST_TAKEN_OVER';

export class ConversationRewindHostError extends Error {
  readonly refusal: ConversationRewindRefusal;
  /** The input field the refusal is about, for the caller's error attribution. */
  readonly field: string;
  /** The code the refusal travels under on the wire. */
  readonly code: string;

  constructor(message: string, refusal: ConversationRewindRefusal, field: string) {
    super(message);
    this.name = 'ConversationRewindHostError';
    this.refusal = refusal;
    this.field = field;
    this.code = refusal === 'taken-over' ? CONVERSATION_HOST_TAKEN_OVER_CODE : 'CONFLICT';
  }
}

/** How many replaced hosts the broker remembers the reason for. */
const MAX_REMEMBERED_TAKEOVERS = 64;

/** Lease bounds. A lease is a promise to keep polling, not a reservation. */
export const CONVERSATION_HOST_MIN_LEASE_MS = 5_000;
export const CONVERSATION_HOST_MAX_LEASE_MS = 10 * 60_000;
export const CONVERSATION_HOST_DEFAULT_LEASE_MS = 2 * 60_000;

/**
 * How long a read-only question handed to a host may go unanswered before the
 * next poll is given it again, in case the response carrying it was lost. A
 * `rewind` question is never handed out twice: truncating a conversation is
 * not something to repeat on a guess.
 */
export const CONVERSATION_PREVIEW_REDELIVER_MS = 3_000;

/** How long a host may hold a `take` call open waiting for work. */
export const CONVERSATION_HOST_MAX_WAIT_MS = 25_000;

/** How long the daemon waits for a host's answer before reporting unavailable. */
export const CONVERSATION_ANSWER_TIMEOUT_MS = 20_000;

/**
 * Ceilings. Both bound memory held on behalf of processes that may already be
 * gone, which is the only kind of state this broker keeps.
 */
export const CONVERSATION_HOST_MAX_HOSTS = 256;
export const CONVERSATION_HOST_MAX_PENDING = 8;

export interface ConversationRewindHostBrokerOptions {
  /**
   * A port for sessions no surface has registered, the daemon's own in-process
   * conversation store, when it has one. Consulted only after the registry
   * misses, because a surface that says it is holding the conversation is a
   * better authority on it than a store that merely might be.
   */
  readonly fallback?: RewindConversationPort | null | undefined;
  readonly answerTimeoutMs?: number | undefined;
  readonly defaultLeaseMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

interface PendingRequest {
  readonly request: ConversationRewindRequest;
  readonly hostId: string;
  readonly settle: (answer: ConversationRewindAnswer) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  taken: boolean;
  /** When a host last took this request, for redelivering a lost preview. */
  takenAt: number;
}

function clampLease(requestedMs: number | undefined, fallbackMs: number): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) return fallbackMs;
  return Math.min(Math.max(Math.floor(requestedMs), CONVERSATION_HOST_MIN_LEASE_MS), CONVERSATION_HOST_MAX_LEASE_MS);
}

function unavailable(reason: string): { available: false; unavailableReason: string } {
  return { available: false, unavailableReason: reason };
}

/**
 * The registry of surfaces hosting conversations, and the port the rewind
 * service asks through.
 */
export class ConversationRewindHostBroker implements RewindConversationPort {
  private readonly hosts = new Map<string, ConversationRewindHost>();
  private readonly pending = new Map<string, PendingRequest>();
  /** The lease length each host asked for, so polling renews it rather than shortening it. */
  private readonly hostLeaseMs = new Map<string, number>();
  /** The principal that registered each host, when the route supplied one. */
  private readonly hostPrincipals = new Map<string, string>();
  /** Resolvers for `take` calls waiting on work, keyed by host id. */
  private readonly waiters = new Map<string, Array<() => void>>();
  /** Hosts replaced by another surface, so the replaced one can be told why instead of "unknown". Bounded. */
  private readonly takenOverHosts = new Map<string, string>();
  private readonly fallback: RewindConversationPort | null;
  private readonly answerTimeoutMs: number;
  private readonly defaultLeaseMs: number;
  private readonly now: () => number;

  constructor(options: ConversationRewindHostBrokerOptions = {}) {
    this.fallback = options.fallback ?? null;
    this.answerTimeoutMs = options.answerTimeoutMs && options.answerTimeoutMs > 0
      ? options.answerTimeoutMs
      : CONVERSATION_ANSWER_TIMEOUT_MS;
    this.defaultLeaseMs = clampLease(options.defaultLeaseMs, CONVERSATION_HOST_DEFAULT_LEASE_MS);
    this.now = options.now ?? (() => Date.now());
  }

  // ── The surface-facing registry ───────────────────────────────────────────

  /**
   * Offer this surface's live conversation for a session, or renew the offer.
   *
   * Passing the `hostId` a previous call returned renews that registration.
   * Passing none claims the session: any earlier host for it is replaced and
   * its outstanding questions are answered unavailable, because they were
   * addressed to a surface that is no longer the one holding the messages.
   * Passing a `hostId` that is not the session's current host is refused rather
   * than treated as a fresh claim, a surface that believes it is the host and
   * is not should learn so, not silently take over.
   */
  registerHost(input: {
    readonly sessionId: string;
    readonly hostId?: string | undefined;
    readonly label?: string | undefined;
    readonly leaseMs?: number | undefined;
    /**
     * Who is registering, as the route authenticated them. A claim on a
     * session another principal already hosts is refused; a registration that
     * names no principal is accepted as before.
     */
    readonly principalId?: string | undefined;
  }): ConversationRewindHost {
    this.dropExpiredHosts();
    const now = this.now();
    const leaseMs = clampLease(input.leaseMs, this.defaultLeaseMs);
    const existing = this.findHostForSession(input.sessionId);

    if (input.hostId) {
      if (!existing || existing.hostId !== input.hostId) {
        throw new ConversationRewindHostError(
          `hostId ${JSON.stringify(input.hostId)} is not the registered host for session ${JSON.stringify(input.sessionId)}. `
          + 'Register without a hostId to claim the session, which replaces whoever holds it now.',
          'not-the-host',
          'hostId',
        );
      }
      const renewed: ConversationRewindHost = { ...existing, leaseExpiresAt: now + leaseMs };
      this.hosts.set(renewed.hostId, renewed);
      this.hostLeaseMs.set(renewed.hostId, leaseMs);
      return renewed;
    }

    const owner = existing ? this.hostPrincipals.get(existing.hostId) : undefined;
    if (existing && owner !== undefined && owner !== input.principalId) {
      throw new ConversationRewindHostError(
        `Session ${JSON.stringify(input.sessionId)} is already hosted by a surface registered by another principal. `
        + 'Only that principal can replace it; until its lease lapses or it releases the session, rewind is served by that surface.',
        'not-the-host',
        'sessionId',
      );
    }
    if (existing) {
      this.evictHost(existing.hostId, 'another surface took over hosting this session\'s conversation');
      this.rememberTakeover(existing.hostId, existing.sessionId);
    }
    if (this.hosts.size >= CONVERSATION_HOST_MAX_HOSTS) {
      throw new ConversationRewindHostError(
        `This daemon is already tracking ${CONVERSATION_HOST_MAX_HOSTS} conversation hosts, the ceiling. `
        + 'Release a session that is no longer live, or let its lease lapse.',
        'too-many-hosts',
        'sessionId',
      );
    }

    const host: ConversationRewindHost = {
      hostId: `cvh_${randomUUID().slice(0, 12)}`,
      sessionId: input.sessionId,
      label: input.label?.trim() ? input.label.trim() : 'a connected surface',
      registeredAt: now,
      leaseExpiresAt: now + leaseMs,
    };
    this.hosts.set(host.hostId, host);
    this.hostLeaseMs.set(host.hostId, leaseMs);
    if (input.principalId !== undefined) this.hostPrincipals.set(host.hostId, input.principalId);
    return host;
  }

  /** Withdraw an offer. Outstanding questions for it are answered unavailable. */
  releaseHost(input: { readonly sessionId: string; readonly hostId: string }): ConversationRewindHost {
    const host = this.hosts.get(input.hostId);
    if (!host || host.sessionId !== input.sessionId) {
      throw new ConversationRewindHostError(
        `hostId ${JSON.stringify(input.hostId)} does not hold session ${JSON.stringify(input.sessionId)}.`,
        'not-the-host',
        'hostId',
      );
    }
    this.evictHost(host.hostId, 'the surface hosting this conversation released it');
    return host;
  }

  /** Every live registration, for a status surface. */
  listHosts(): readonly ConversationRewindHost[] {
    this.dropExpiredHosts();
    return [...this.hosts.values()].sort((a, b) => a.registeredAt - b.registeredAt);
  }

  /**
   * Collect the questions waiting for this host, renewing its lease, a surface
   * that is polling is a surface that is alive, so a separate keepalive would
   * be ceremony over the same fact.
   *
   * With nothing waiting and a `waitMs`, the call holds open until a question
   * arrives or the wait runs out, and an empty return is a normal answer rather
   * than an error: nothing needed doing.
   */
  async takeRequests(input: {
    readonly hostId: string;
    readonly waitMs?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<{ readonly host: ConversationRewindHost; readonly requests: readonly ConversationRewindRequest[] }> {
    let host = this.renewByPolling(input.hostId);
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : CONVERSATION_HOST_MAX_PENDING;

    let ready = this.collect(host.hostId, limit);
    const waitMs = Math.min(
      Math.max(Math.floor(input.waitMs ?? 0), 0),
      CONVERSATION_HOST_MAX_WAIT_MS,
    );
    if (ready.length === 0 && waitMs > 0) {
      const deadline = this.now() + waitMs;
      for (;;) {
        const remaining = deadline - this.now();
        if (remaining <= 0) break;
        // A preview already taken becomes collectable again with no new event
        // to wake this call, so the wait ends when it does rather than at waitMs.
        const redeliverIn = this.untilRedelivery(host.hostId);
        await this.waitForWork(host.hostId, redeliverIn === undefined ? remaining : Math.min(remaining, redeliverIn));
        // The lease is renewed again on the way out: the host was here for the
        // whole wait, and charging it for the time it spent waiting for us would
        // expire a surface that did exactly what it was asked to do.
        host = this.renewByPolling(input.hostId);
        ready = this.collect(host.hostId, limit);
        if (ready.length > 0) break;
      }
    }
    return { host, requests: ready };
  }

  /**
   * The question behind a request id, for a caller that needs to know which
   * kind of answer it owes before it builds one. Refused when the request is no
   * longer waiting, or was put to a different surface.
   */
  describeRequest(input: { readonly hostId: string; readonly requestId: string }): ConversationRewindRequest {
    const entry = this.pending.get(input.requestId);
    if (!entry) {
      throw new ConversationRewindHostError(
        `No conversation rewind request with id ${JSON.stringify(input.requestId)} is waiting. `
        + 'It may already have been answered, or it timed out and was reported unavailable.',
        'request-unknown',
        'requestId',
      );
    }
    if (entry.request.expiresAt <= this.now()) {
      throw new ConversationRewindHostError(
        `Request ${JSON.stringify(input.requestId)} stopped waiting for an answer, so the daemon has already reported it unavailable.`,
        'request-expired',
        'requestId',
      );
    }
    if (entry.hostId !== input.hostId) {
      throw new ConversationRewindHostError(
        `Request ${JSON.stringify(input.requestId)} was put to a different surface. `
        + 'Only the surface hosting a session\'s conversation can answer for it.',
        'not-the-host',
        'hostId',
      );
    }
    return entry.request;
  }

  /** Answer one question. Refused when it is not this host's, or has expired. */
  answerRequest(input: {
    readonly hostId: string;
    readonly requestId: string;
    readonly answer: ConversationRewindAnswer;
  }): ConversationRewindRequest {
    const request = this.describeRequest(input);
    this.settle(input.requestId, input.answer);
    return request;
  }

  /** Answer everything outstanding and forget every registration. */
  shutdown(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { kind: 'unavailable', reason: 'the daemon stopped serving conversation rewind' });
    }
    this.hosts.clear();
    this.hostLeaseMs.clear();
    this.hostPrincipals.clear();
    for (const [hostId, resolvers] of this.waiters) {
      for (const resolve of resolvers) resolve();
      this.waiters.delete(hostId);
    }
  }

  // ── The RewindConversationPort the rewind service asks through ────────────

  async preview(anchor: RewindAnchor): Promise<RewindConversationPreview> {
    const host = this.findHostForSession(anchor.sessionId);
    if (!host) {
      if (this.fallback) return this.fallback.preview(anchor);
      return { messagesToDrop: 0, messagesRemaining: 0, ...unavailable(this.noHostReason(anchor.sessionId)) };
    }
    const answer = await this.ask(host, anchor.sessionId, anchor.turnId ?? null, 'preview');
    if (answer.kind === 'preview') {
      return { messagesToDrop: answer.messagesToDrop, messagesRemaining: answer.messagesRemaining };
    }
    return {
      messagesToDrop: 0,
      messagesRemaining: 0,
      ...unavailable(answer.kind === 'unavailable' ? answer.reason : this.wrongKindReason(host, 'preview')),
    };
  }

  async rewind(anchor: RewindAnchor): Promise<RewindConversationOutcome> {
    const host = this.findHostForSession(anchor.sessionId);
    if (!host) {
      if (this.fallback) return this.fallback.rewind(anchor);
      return { droppedMessages: 0, undoSnapshotId: '', ...unavailable(this.noHostReason(anchor.sessionId)) };
    }
    const answer = await this.ask(host, anchor.sessionId, anchor.turnId ?? null, 'rewind');
    if (answer.kind === 'rewind') {
      return { droppedMessages: answer.droppedMessages, undoSnapshotId: answer.undoSnapshotId,
        ...(answer.undoExpiresAfter ? { undoExpiresAfter: answer.undoExpiresAfter } : {}) };
    }
    return {
      droppedMessages: 0,
      undoSnapshotId: '',
      ...unavailable(answer.kind === 'unavailable' ? answer.reason : this.wrongKindReason(host, 'rewind')),
    };
  }

  /**
   * Ask the surface hosting a session to put its conversation back from an
   * undo snapshot. Null when no surface hosts the session: the caller then
   * looks in its own store. The host restores only while nothing newer was
   * added since the rewind, and says which refusal applies otherwise.
   */
  async undo(sessionId: string, undoSnapshotId: string): Promise<
    { readonly undone: true; readonly label: string }
    | { readonly undone: false; readonly label: string; readonly reason: string; readonly code: ConversationUndoRefusalCode | null }
    | null
  > {
    const host = this.findHostForSession(sessionId);
    if (!host) return null;
    const answer = await this.ask(host, sessionId, null, 'undo', undoSnapshotId);
    if (answer.kind === 'undone') return { undone: true, label: host.label };
    return {
      undone: false,
      label: host.label,
      reason: answer.kind === 'unavailable' ? answer.reason : this.wrongKindReason(host, 'undo'),
      code: answer.kind === 'unavailable' ? answer.code ?? null : null,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private noHostReason(sessionId: string): string {
    return `no surface has offered a live conversation for session ${JSON.stringify(sessionId)}. `
      + 'Only the process running that conversation can count or drop its messages, so nothing here can answer for it. '
      + 'Run the rewind from the surface hosting the session, or have that surface register its conversation.';
  }

  private wrongKindReason(host: ConversationRewindHost, kind: ConversationRewindRequestKind): string {
    return `${host.label} answered a conversation ${kind} request with the wrong kind of answer`;
  }

  /** Put one question to a host and wait, bounded, for the answer. */
  private ask(
    host: ConversationRewindHost,
    sessionId: string,
    turnId: string | null,
    kind: ConversationRewindRequestKind,
    undoSnapshotId?: string,
  ): Promise<ConversationRewindAnswer> {
    const outstanding = [...this.pending.values()].filter((entry) => entry.hostId === host.hostId).length;
    if (outstanding >= CONVERSATION_HOST_MAX_PENDING) {
      return Promise.resolve({
        kind: 'unavailable',
        reason: `${host.label} already has ${CONVERSATION_HOST_MAX_PENDING} unanswered conversation rewind requests; it is not keeping up`,
      });
    }

    const now = this.now();
    const requestId = `cvr_${randomUUID().slice(0, 12)}`;
    const request: ConversationRewindRequest = {
      requestId,
      sessionId,
      turnId,
      kind,
      ...(undoSnapshotId === undefined ? {} : { undoSnapshotId }),
      expiresAt: now + this.answerTimeoutMs,
    };

    return new Promise<ConversationRewindAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(requestId, {
          kind: 'unavailable',
          reason: kind === 'rewind'
            // Deliberately not "nothing was dropped". The host may have
            // truncated and failed to report it, and claiming otherwise would
            // put a false receipt in front of the person deciding what to do next.
            ? `${host.label} did not answer within ${Math.round(this.answerTimeoutMs / 1000)}s, so whether it truncated the conversation cannot be confirmed from here`
            : kind === 'undo'
              ? `${host.label} did not answer within ${Math.round(this.answerTimeoutMs / 1000)}s, so whether it restored the conversation cannot be confirmed from here`
              : `${host.label} did not answer within ${Math.round(this.answerTimeoutMs / 1000)}s`,
        });
      }, this.answerTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { request, hostId: host.hostId, settle: resolve, timer, taken: false, takenAt: 0 });
      this.wakeWaiters(host.hostId);
    });
  }

  /** Resolve one question exactly once, however it ended. */
  private settle(requestId: string, answer: ConversationRewindAnswer): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.settle(answer);
  }

  private findHostForSession(sessionId: string): ConversationRewindHost | null {
    this.dropExpiredHosts();
    for (const host of this.hosts.values()) {
      if (host.sessionId === sessionId) return host;
    }
    return null;
  }

  private renewByPolling(hostId: string): ConversationRewindHost {
    this.dropExpiredHosts();
    const host = this.hosts.get(hostId);
    if (!host) {
      const takenOverSession = this.takenOverHosts.get(hostId);
      if (takenOverSession !== undefined) {
        throw new ConversationRewindHostError(
          `Another surface took over hosting session ${JSON.stringify(takenOverSession)}'s conversation, so hostId ${JSON.stringify(hostId)} no longer serves it. `
          + 'Stop offering this session; register it again only if this surface should take it back.',
          'taken-over',
          'hostId',
        );
      }
      throw new ConversationRewindHostError(
        `hostId ${JSON.stringify(hostId)} is not registered. Its lease may have lapsed; register the session again.`,
        'host-unknown',
        'hostId',
      );
    }
    // The lease the host asked for, not the default: polling must not shorten it.
    const renewed: ConversationRewindHost = { ...host, leaseExpiresAt: this.now() + (this.hostLeaseMs.get(hostId) ?? this.defaultLeaseMs) };
    this.hosts.set(hostId, renewed);
    return renewed;
  }

  private collect(hostId: string, limit: number): readonly ConversationRewindRequest[] {
    const now = this.now();
    const ready: ConversationRewindRequest[] = [];
    for (const entry of this.pending.values()) {
      if (entry.hostId !== hostId) continue;
      if (entry.request.expiresAt <= now) continue;
      const lost = entry.taken && entry.request.kind === 'preview' && now - entry.takenAt >= CONVERSATION_PREVIEW_REDELIVER_MS;
      if (entry.taken && !lost) continue;
      entry.taken = true;
      entry.takenAt = now;
      ready.push(entry.request);
      if (ready.length >= limit) break;
    }
    return ready;
  }

  /** Milliseconds until the soonest taken, unexpired preview of this host is handed out again; undefined when none is. */
  private untilRedelivery(hostId: string): number | undefined {
    const now = this.now();
    let soonest: number | undefined;
    for (const entry of this.pending.values()) {
      if (entry.hostId !== hostId || !entry.taken || entry.request.kind !== 'preview' || entry.request.expiresAt <= now) continue;
      const due = Math.max(entry.takenAt + CONVERSATION_PREVIEW_REDELIVER_MS - now, 1);
      if (soonest === undefined || due < soonest) soonest = due;
    }
    return soonest;
  }

  private waitForWork(hostId: string, waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const resolvers = this.waiters.get(hostId);
        if (resolvers) {
          const index = resolvers.indexOf(finish);
          if (index >= 0) resolvers.splice(index, 1);
          if (resolvers.length === 0) this.waiters.delete(hostId);
        }
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      const resolvers = this.waiters.get(hostId) ?? [];
      resolvers.push(finish);
      this.waiters.set(hostId, resolvers);
    });
  }

  private wakeWaiters(hostId: string): void {
    const resolvers = this.waiters.get(hostId);
    if (!resolvers) return;
    for (const resolve of [...resolvers]) resolve();
  }

  private rememberTakeover(hostId: string, sessionId: string): void {
    this.takenOverHosts.set(hostId, sessionId);
    if (this.takenOverHosts.size > MAX_REMEMBERED_TAKEOVERS) {
      const oldest = this.takenOverHosts.keys().next().value;
      if (oldest !== undefined) this.takenOverHosts.delete(oldest);
    }
  }

  /** Answer this host's outstanding questions and forget it. */
  private evictHost(hostId: string, reason: string): void {
    this.hosts.delete(hostId);
    this.hostLeaseMs.delete(hostId);
    this.hostPrincipals.delete(hostId);
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.hostId !== hostId) continue;
      this.settle(requestId, { kind: 'unavailable', reason });
    }
    const resolvers = this.waiters.get(hostId);
    if (resolvers) {
      for (const resolve of [...resolvers]) resolve();
    }
  }

  /**
   * Drop registrations whose lease has lapsed, on the way into every access.
   * A surface that stopped polling stopped being able to answer, whether it
   * crashed, disconnected, or simply moved on, and a stale claim is worse than
   * no claim, because it turns "nobody is hosting this" into a timeout.
   */
  private dropExpiredHosts(): void {
    const now = this.now();
    for (const host of [...this.hosts.values()]) {
      if (host.leaseExpiresAt > now) continue;
      this.evictHost(host.hostId, `${host.label} stopped polling, so its offer to serve this conversation lapsed`);
    }
  }
}
