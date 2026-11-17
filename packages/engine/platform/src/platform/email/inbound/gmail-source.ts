/**
 * gmail-source.ts, Gmail as a first-class inbound source
 * (docs/decisions/2026-07-27-inbound-email-design.md §3.4d).
 *
 * A user who has already adopted Google credentials should not have to find an
 * IMAP host, a username and an app password to get inbound mail for a mailbox
 * the daemon can already read. So `users.history.list` becomes a source behind
 * the same seam IMAP sits behind, delivering the same messages to the same
 * sink, and expectation matching, taint labelling, dedup, notice rendering and
 * owner disclosure are written once for both.
 *
 * Three things about this file are load-bearing.
 *
 * **It is polling, and it says so.** There is no push available here:
 * `users.watch` + Pub/Sub needs a public HTTPS endpoint and a GCP topic, which
 * a daemon on someone's own machine behind NAT does not have. `latency`
 * therefore always answers `poll`, and it answers with the interval CURRENTLY
 * IN FORCE rather than a constant, a five-second worst case while a signup is
 * mid-flight and a sixty-second one when nothing is pending are different
 * promises, and a status line that showed the wrong one would be describing a
 * mode the daemon is not in.
 *
 * **A body-less grant is a refusal, never a quiet mailbox.** `gmail.metadata`
 * authorizes `users.history.list` and excludes the message body, Google's own
 * scope description says "but not the email body". A delta fetched under it
 * would come back `ok` with every body empty, which is indistinguishable from
 * a mailbox on a slow day and is the worst shape a defect can take in a
 * delivery path. `collectHistoryDelta` already refuses before making the call;
 * this file maps that refusal onto an `insufficient` verdict carrying Google's
 * own remedy, and stops polling until the grant changes. It never delivers a
 * body-less message and never reports an empty success in its place.
 *
 * **The position never moves past a message that was not read.** Gmail's
 * history is a forward-only log: records at or below a `startHistoryId` are
 * never returned again, so a cursor that advances over an unfetched message
 * does not postpone it, it makes it permanently unreachable, silently, and
 * under a `healthy` verdict, which is the worst shape this delivery path can
 * take. `collectHistoryDelta` separates a message that is GONE (deleted
 * between `history.list` and `messages.get`) from one we FAILED TO FETCH (a
 * rate limit, a server fault, a refused token, a dead socket) and reports the
 * second in `GmailHistoryDelta.unreadable`. This file refuses to advance while
 * that is non-empty. It is the same rule, on the same contract, that
 * `ImapEnvelopeBatch.unreadable` gives the IMAP drain, one idea, expressed
 * twice only where the identifier differs.
 *
 * **Losing our place is the same event on both sources.** A 404 on a
 * `startHistoryId` that aged out of Gmail's retention window means exactly what
 * a changed `UIDVALIDITY` means: the stored position names nothing. It goes
 * through `MailboxCursorStore.resolveGmail`, which is the same
 * establish-at-the-current-high-water-mark path `uid-validity-changed` uses,
 * discard, re-establish, disclose, and do NOT replay the mailbox. There is one
 * implementation of that rule and this file does not add a second.
 *
 * **The first-run history window is the IMAP one.** When a consumer that shows
 * the mailbox (the inbox) wants it, the newest 50 messages already in the
 * label are kept as history: one `users.messages.list` call names them, their
 * ids go into the cursor record (`historyMessageIds`), and they are handed on
 * flagged `history`, which no notice announces. Each id leaves the record once
 * every consumer took it; one Google would not hand over is tried on three
 * polls and then handed on as a stand-in saying it could not be read. Once,
 * at first run or when such a consumer attaches unseeded; nothing afterwards.
 *
 * What this file cannot do
 * ────────────────────────
 * It cannot open, hydrate, widen or extend an expectation. Whether one is open
 * arrives as an INJECTED PREDICATE, a function returning a boolean, and
 * nothing that could create an expectation is imported here, which is §2.1's
 * structural removal of the spawn capability applied to the other capability an
 * arriving message must never reach. A source that could register what it is
 * waiting for could decide, by content, what to wait for.
 */

import {
  CapabilityStateTracker,
  capabilityVerdict,
  errorText,
  stateForReason,
} from './capability.js';
import {
  INBOUND_CAPABILITY_POLICY_DEFAULT,
  resolveInboundCapabilityPolicy,
  type InboundCapabilityPolicy,
} from './capability-policy.js';
import { anySignal } from './any-signal.js';
import type { MailboxCursorStore } from './cursor-store.js';
import { DEFAULT_INBOUND_WATCHER_SETTINGS } from './ports.js';
import type {
  GmailInboundMessage,
  InboundCapabilityReason,
  InboundCapabilityVerdict,
  InboundMailNote,
  InboundMailObserver,
  InboundMailSink,
  MailboxBatchOutcome,
  InboundMailTerminalFailure,
  WatcherClock,
} from './ports.js';
import { isHistoryId } from './source-cursor.js';
import type { InboundMailSource, SourceLatency } from './source.js';
import { HISTORY_WINDOW_MESSAGES } from './watcher.js';
import type {
  GmailMessageBody,
  GmailMessageMetadata,
  GoogleApiFailure,
  GoogleApiResult,
  RecentMessageIds,
} from '../../google/api-client.js';
import {
  GMAIL_BODY_SCOPES,
  GMAIL_HISTORY_SCOPES,
  collectHistoryDelta,
  type GmailHistoryDelta,
  type HistoryDeltaDeps,
  type HistoryDeltaUnavailable,
  isPermanentFetchProblem,
  reachedHistoryId,
} from '../../google/history-delta.js';

/**
 * How long 403s with no named cause may go on, unbroken, before they are read
 * as a refused grant. A 403 Google names a usage limit never counts; this is
 * for one that names nothing. Unbounded would let a revoked scope retry for
 * ever as if it were a rate limit.
 */
const MAX_UNEXPLAINED_FORBIDDEN_MS = 10 * 60_000;

/** Refusals by the sink, in a row with no complete delta between, before the verdict says so. */
const MAX_CONSECUTIVE_DELIVERY_FAILURES = 3;

/**
 * Passes in a row in which Google answers one message with a permanent client
 * error (a malformed id, not a credential or a rate limit) before it is treated
 * as gone. Without a bound that one message holds the history position, and all
 * mail behind it, for ever.
 */
const MAX_PERMANENT_UNREADABLE_PASSES = 5;

/** Polls a history message may fail to read before it is handed on as a stand-in; the IMAP reader's bound. */
const HISTORY_READ_ATTEMPTS = 3;

/**
 * "Is somebody waiting on a message right now?"
 *
 * A plain predicate, injected. Deliberately NOT the expectation registry, not
 * a narrowed view of it, and not anything that transitively imports it: the
 * registry can open an expectation, and a type that names it would let this
 * file be handed the thing it must not have. The caller, the supervisor, which
 * is already authorized, answers the question.
 */
export type ExpectationPresence = () => boolean;

/**
 * The cursor operations the Gmail source needs, projected off the real store.
 *
 * A `Pick` rather than a hand-written interface, and that is the rule this
 * round keeps re-learning rather than a preference. Two structurally-identical
 * `MailboxCursor` declarations in separate lanes had already drifted in
 * BEHAVIOUR, one clamped with `Math.max`, the other assigned unconditionally,
 * while everything still compiled. A `Pick` cannot drift from what it picks,
 * and if `resolveGmail` gains an argument this stops compiling in the ordinary
 * build.
 *
 * Note what is absent: `resolve` and `advance`, the IMAP pair. A `historyId`
 * cannot say which UIDs are done, so a Gmail source holding them could only
 * misuse them.
 */
export type GmailCursorPort = Pick<
  MailboxCursorStore,
  'getGmail' | 'resolveGmail' | 'advanceGmail'
> & Partial<Pick<MailboxCursorStore, 'recordGmailHistory'>>;

export interface GmailMailSourceDeps {
  /** Config account id, not an address. */
  readonly account: string;
  /** The watched Gmail label, e.g. `INBOX`. Keyed the same way an IMAP mailbox is. */
  readonly mailbox: string;
  /** Scopes, one history page, one message, the same narrow I/O `collectHistoryDelta` takes. */
  readonly history: HistoryDeltaDeps;
  /**
   * The mailbox's CURRENT `historyId`, as Google sent it.
   *
   * Injected rather than called here, so this file stays free of any Google
   * client: it is handed I/O, exactly as `history` is. The composition fills it
   * with `GoogleApiClient.currentHistoryId()`, which reads
   * `users.getProfile().historyId`, "the ID of the mailbox's current history
   * record", Google's own words for the field, and the reason that call is the
   * right one for a path that establishes without backfilling. Needed on
   * exactly two paths, both of which establish rather than replay: a first run,
   * and a `resync-required` recovery.
   */
  readonly currentHistoryId: () => Promise<GoogleApiResult<string>>;
  /**
   * The newest message ids of the label, newest first: `users.messages.list`,
   * asked only to keep the first-run history window. Absent: no window.
   */
  readonly listRecentMessageIds?: ((labelId: string, maxResults: number) => Promise<GoogleApiResult<RecentMessageIds>>) | undefined;
  readonly cursors: GmailCursorPort;
  readonly sink: InboundMailSink;
  readonly clock: WatcherClock;
  /** Injected; see `ExpectationPresence`. */
  readonly expectationOpen: ExpectationPresence;
  /**
   * Subscribe to "an expectation was just opened"; returns the unsubscribe.
   * An idle wait is one timer that this wakes early, so an opening is noticed
   * at once without waking every `pollExpectingMs` meanwhile.
   */
  readonly expectationOpened: (wake: () => void) => () => void;
  /** `surfaces.email.inbound.gmailPollSecondsExpecting`, in milliseconds. */
  readonly pollExpectingMs: number;
  /** `surfaces.email.inbound.gmailPollSecondsIdle`, in milliseconds. */
  readonly pollIdleMs: number;
  /** How long an `insufficient` verdict waits before re-probing. Defaults to the watcher's 60 minutes. */
  readonly capabilityRecheckMs?: number | undefined;
  /**
   * `surfaces.email.inbound.onInsufficientCapability`, read at source-create
   * time by `source-factory.ts`.
   *
   * Optional, defaulting to `INBOUND_CAPABILITY_POLICY_DEFAULT`, the value the
   * schema ships, so an omitted dependency produces the shipped behaviour
   * rather than the permissive one. That direction matters: the weaker policy
   * announces mail it can never act on, and nothing should be able to select it
   * by forgetting to pass a field.
   */
  readonly capabilityPolicy?: InboundCapabilityPolicy | undefined;
  readonly observer?: InboundMailObserver | undefined;
}

export class GmailMailSource implements InboundMailSource {
  readonly kind = 'gmail-history' as const;

  private readonly deps: GmailMailSourceDeps;
  private readonly tracker: CapabilityStateTracker;
  private readonly pollExpectingMs: number;
  private readonly pollIdleMs: number;
  private readonly capabilityRecheckMs: number;
  private readonly capabilityPolicy: InboundCapabilityPolicy;
  private readonly halt = new AbortController();
  private recheckWake: AbortController | null = null;
  private terminal: InboundMailTerminalFailure | null = null;
  /** When the current unbroken run of 403s with no named cause began, see `transientVerdict`. */
  private unexplainedForbiddenSince: number | null = null;
  /** Deliveries in a row the sink refused, with no complete delta in between. */
  private deliveryFailures = 0;
  /** Consecutive passes in which each message id was permanently unreadable. */
  private readonly permanentUnreadable = new Map<string, number>();
  /**
   * The history position this source last read or wrote. This source is the
   * only writer of its own cursor record, so the file is read once, at the
   * first poll, and written only when the position moves.
   */
  private position: string | null = null;
  /** A consumer that shows the mailbox wants the history window kept. */
  private historyRequested = false;
  /** The history window still to hand on, oldest first, as the cursor record holds it. */
  private historyWindow: { readonly ids: readonly string[]; readonly skipped: number } | null = null;
  /** Whether a history window was ever kept for this cursor, and how many older messages it left out. */
  private historyKept: { readonly skipped: number } | null = null;
  /** Polls in a row each history message failed to read; bounded by the window. */
  private readonly historyReadFailures = new Map<string, number>();

  constructor(deps: GmailMailSourceDeps) {
    this.deps = deps;
    // Floored rather than range-checked: the 2-60 s and 10-3600 s ranges belong
    // to the config schema that declares those keys, and restating them here
    // would be a second set of bounds that can disagree with the first. This
    // floor only catches a value no configuration can produce.
    this.pollExpectingMs = Math.max(1_000, Math.floor(deps.pollExpectingMs));
    this.pollIdleMs = Math.max(1_000, Math.floor(deps.pollIdleMs));
    this.capabilityRecheckMs = Math.max(
      1_000,
      Math.floor(deps.capabilityRecheckMs ?? DEFAULT_INBOUND_WATCHER_SETTINGS.capabilityRecheckMs),
    );
    this.capabilityPolicy = deps.capabilityPolicy ?? INBOUND_CAPABILITY_POLICY_DEFAULT;
    this.tracker = new CapabilityStateTracker({
      account: deps.account,
      mailbox: deps.mailbox,
      clock: deps.clock,
      observer: deps.observer,
    });
  }

  /**
   * The interval in force: fast while something is being waited for, slow when
   * nothing is.
   *
   * The predicate is asked every time rather than sampled once, because an
   * expectation opening is exactly the moment the answer has to change, a
   * signup starts mid-run and the next wait is the short one.
   */
  get intervalMs(): number {
    return this.deps.expectationOpen() ? this.pollExpectingMs : this.pollIdleMs;
  }

  /** Always polling, always the interval in force. Never the word "real-time". */
  get latency(): SourceLatency {
    return { kind: 'poll', worstCaseMs: this.intervalMs };
  }

  /** The current verdict, for a supervisor folding this into channel status. */
  get verdict(): InboundCapabilityVerdict {
    return this.tracker.current
      ?? capabilityVerdict('reconnecting', 'The Gmail source has not asked Google anything yet.');
  }

  /** Non-null once a verdict only a changed grant can clear has been reached. */
  get terminalFailure(): InboundMailTerminalFailure | null {
    return this.terminal;
  }

  /**
   * Establish the position and answer with a capability verdict.
   *
   * On Gmail, unlike IMAP, capability is DECLARATIVE: the token states what it
   * may do, so a body-less grant is caught before the first delta is fetched
   * rather than on the first message. That asymmetry is the protocol, and it is
   * why an insufficient verdict here can be trusted to mean "this will not work
   * at all" rather than "the first fetch failed".
   */
  async start(signal: AbortSignal): Promise<InboundCapabilityVerdict> {
    const combined = anySignal([signal, this.halt.signal]);
    try {
      return await this.pollOnce(combined.signal);
    } finally {
      combined.dispose();
    }
  }

  /**
   * Poll until aborted.
   *
   * Sleeps FIRST: `start()` has already made one pass, and asking again
   * immediately would spend a call to learn what was just learned. An
   * `insufficient` verdict waits `capabilityRecheckMs` instead of the poll
   * interval, a grant does not change in five seconds, and re-asking on the
   * poll interval would turn a refusal into a request loop.
   */
  async run(signal: AbortSignal): Promise<void> {
    const combined = anySignal([signal, this.halt.signal]);
    try {
      while (!combined.signal.aborted) {
        const wake = new AbortController();
        this.recheckWake = wake;
        const wait = anySignal([combined.signal, wake.signal]);
        try {
          await this.sleepUntilDue(wait.signal);
        } finally {
          wait.dispose();
          if (this.recheckWake === wake) this.recheckWake = null;
        }
        if (combined.signal.aborted) return;
        try {
          await this.pollOnce(combined.signal);
        } catch (error) {
          // A store write or an injected dependency that threw. Not a
          // capability verdict, nothing about the grant is known to have
          // changed, so it is degraded, disclosed, and tried again.
          this.unexplainedForbiddenSince = null;
          this.record(capabilityVerdict('reconnecting', errorText(error)));
          this.note('delivery-failed', `The Gmail poll did not complete: ${errorText(error)}`);
        }
      }
    } finally {
      combined.dispose();
    }
  }

  /**
   * Re-ask about a refused grant now rather than after `capabilityRecheckMs`.
   *
   * Only while refused. Every config write asks for a recheck, and a working
   * source answering each one with a Google call would turn a settings page
   * into a request burst for no new information.
   */
  recheckNow(): void {
    if (this.tracker.state !== 'insufficient') return;
    this.recheckWake?.abort();
  }

  /**
   * Keep the history window for a consumer that attached after the position
   * was established. Applied at the next poll.
   */
  requestHistory(): void {
    this.historyRequested = true;
  }

  /** Stop polling. Safe to call twice, and safe to call before `start`. */
  async stop(): Promise<void> {
    this.halt.abort();
    await Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // One pass
  // -------------------------------------------------------------------------

  private waitMs(): number {
    return this.tracker.state === 'insufficient' ? this.capabilityRecheckMs : this.intervalMs;
  }

  /**
   * Wait out the interval in force, and shorten it when an expectation opens.
   *
   * A single fixed sleep of the idle interval (up to an hour by configuration)
   * would not poll for an expectation opened during it until it ended, past the
   * expectation's own window. The wait is one timer that the opening wakes,
   * and the interval is re-read when it does; Google is only asked when the
   * whole interval in force has elapsed. A refused grant's wait is not woken,
   * nothing about it changes when an expectation opens.
   */
  private async sleepUntilDue(signal: AbortSignal): Promise<void> {
    const startedAt = this.deps.clock.now();
    // Only ever shortened: an expectation closing mid-wait is no reason to
    // make the poll that was already due wait longer.
    const planned = this.waitMs();
    const subscribe = this.deps.expectationOpened;
    while (!signal.aborted) {
      const remaining = Math.min(planned, this.waitMs()) - (this.deps.clock.now() - startedAt);
      if (remaining <= 0) return;
      if (this.tracker.state === 'insufficient') {
        await this.deps.clock.sleep(remaining, signal);
        continue;
      }
      const opened = new AbortController();
      const unsubscribe = subscribe(() => opened.abort());
      const either = anySignal([signal, opened.signal]);
      try {
        await this.deps.clock.sleep(remaining, either.signal);
      } finally {
        either.dispose();
        unsubscribe();
      }
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<InboundCapabilityVerdict> {
    if (signal.aborted) return this.verdict;

    if (this.position === null) {
      const cursor = await this.deps.cursors.getGmail(this.deps.account, this.deps.mailbox);
      if (cursor === null) return this.establish(false, signal);
      this.position = cursor.historyId;
      this.historyWindow = windowOf(cursor);
      this.historyKept = keptOf(cursor);
    }
    await this.history(signal);
    this.reportPosition();

    const result = await collectHistoryDelta(this.deps.history, {
      startHistoryId: this.position,
      labelId: this.deps.mailbox,
      historyTypes: ['messageAdded'],
      // The one place the owner's policy changes what is ASKED FOR rather than
      // what is done with the answer. Under `refuse-and-notify`, the shipped
      // value, this stays `'refuse'` and `collectHistoryDelta` never calls
      // Google at all for a body-less grant, exactly as before.
      onMetadataOnlyGrant: this.capabilityPolicy === 'notice-only' ? 'fetch-metadata' : 'refuse',
    });

    if (result.ok) return this.deliver(result.value, signal);
    if ('unavailable' in result) {
      // The stored position aged out of Gmail's retention window. Same event as
      // a changed UIDVALIDITY, same resolution path, and no replay.
      if (result.unavailable === 'resync-required') return this.establish(true, signal);
      return this.refuse(result);
    }
    return this.recordFailure(result);
  }

  /**
   * Establish the position at the current high-water mark, for a first run or
   * after a `resync-required`.
   *
   * Never backfills notices on either path. A newly watched label starts
   * listening now rather than retroactively deciding about mail that arrived
   * before it was asked to, and an expired cursor is not an invitation to
   * re-announce a week of old mail because Google rotated its history window.
   * On a first run a consumer that shows the mailbox gets the history window
   * (see the header); it is never announced.
   */
  private async establish(afterExpiry: boolean, signal: AbortSignal): Promise<InboundCapabilityVerdict> {
    const fresh = await this.deps.currentHistoryId();
    if (!fresh.ok) return this.recordFailure(fresh);
    if (!isHistoryId(fresh.value)) {
      // Refused rather than persisted: the store would reject it anyway, and
      // an invalid position written and dropped on the next load looks exactly
      // like having a position while having none.
      this.unexplainedForbiddenSince = null;
      return this.record(capabilityVerdict(
        'server-unavailable',
        `Google answered with ${JSON.stringify(fresh.value)} where a decimal historyId was expected, `
        + 'so no position could be established.',
      ));
    }

    const resolution = await this.deps.cursors.resolveGmail({
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      currentHistoryId: fresh.value,
      historyExpired: afterExpiry,
    });
    this.position = resolution.cursor.historyId;
    this.historyWindow = windowOf(resolution.cursor);
    this.historyKept = keptOf(resolution.cursor);

    if (resolution.kind === 'history-expired') {
      this.note('cursor-reset',
        `Google reported the stored history position ${resolution.previous?.historyId ?? '(unknown)'} `
        + 'is outside the range it still keeps, so every record below it names nothing. The position '
        + `was re-established at historyId ${resolution.cursor.historyId}; mail already in the label `
        + 'is not replayed. An aged-out history window is not a reason to re-announce old mail.');
    } else if (resolution.kind === 'first-run') {
      this.note('cursor-established',
        `Listening from historyId ${resolution.cursor.historyId} onwards. Mail already in `
        + `'${this.deps.mailbox}' is not announced: the daemon starts listening now rather than backfilling; `
        + 'a consumer that shows the mailbox keeps the newest of it as history.');
      this.historyRequested = true;
      await this.history(signal);
    }
    this.reportPosition();
    return this.record(capabilityVerdict('polling-configured', this.pollingDetail()));
  }

  /**
   * How the grant lets a history message be read: in full, by its headers
   * only (a `gmail.metadata` grant under `notice-only`), or not at all (the
   * delta refuses such a grant, and the window waits for one that reads).
   */
  private historyReads(): 'full' | 'metadata-only' | null {
    const granted = new Set(this.deps.history.scopes());
    if (!GMAIL_HISTORY_SCOPES.some((scope) => granted.has(scope))) return null;
    if (GMAIL_BODY_SCOPES.some((scope) => granted.has(scope))) return 'full';
    return this.capabilityPolicy === 'notice-only' ? 'metadata-only' : null;
  }

  /** Keep and hand on the history window. Its failure is noted and never fails the poll: new mail is still read. */
  private async history(signal: AbortSignal): Promise<void> {
    if (!this.historyRequested && this.historyWindow === null) return;
    try {
      await this.keepHistory();
      await this.deliverHistory(signal);
    } catch (error) {
      this.note('delivery-failed', `The history window of '${this.deps.mailbox}' was not handed on this poll: ${errorText(error)}`);
    }
  }

  /**
   * Keep the newest messages already in the label as history, once, when a
   * consumer that shows the mailbox wants it: one `users.messages.list` call
   * and one cursor write. A failed list keeps nothing; new mail is still read.
   */
  private async keepHistory(): Promise<void> {
    if (!this.historyRequested) return;
    this.historyRequested = false;
    const list = this.deps.listRecentMessageIds;
    const record = this.deps.cursors.recordGmailHistory?.bind(this.deps.cursors);
    if (list === undefined || record === undefined || this.position === null) return;
    if (this.deps.sink.wantsHistory?.() !== true || this.historyReads() === null) return;
    const listed = await list(this.deps.mailbox, HISTORY_WINDOW_MESSAGES);
    if (!listed.ok) {
      this.note('cursor-established',
        `The messages already in '${this.deps.mailbox}' could not be listed, so none are kept as history: ${listed.problem}`);
      return;
    }
    // Google lists newest first; the window is handed on oldest first.
    const ids = listed.value.ids.slice(0, HISTORY_WINDOW_MESSAGES).reverse();
    const skipped = listed.value.more ? Math.max(0, listed.value.estimate - ids.length) : 0;
    await record({ account: this.deps.account, mailbox: this.deps.mailbox }, { messageIds: ids, skippedOlderMessages: skipped });
    this.historyWindow = ids.length > 0 ? { ids, skipped } : null;
    this.historyKept = { skipped };
    this.note('cursor-established',
      `${String(ids.length)} message(s) already in '${this.deps.mailbox}' are kept as history for the inbox `
      + `and are not announced${skipped > 0 ? `; about ${String(skipped)} older one(s) are left out` : ''}.`);
  }

  /**
   * Hand the history window's messages on, flagged `history`, and drop from
   * the cursor record each one every consumer took. A message Google answers
   * is gone (404) leaves the window; one it would not hand over is tried on
   * the next poll and, on the third, handed on as a stand-in saying it could
   * not be read. A refused credential, a usage limit or no answer is the
   * account's state, not the message's: the delta reports it and it does not
   * count. New mail is never held behind the window.
   */
  private async deliverHistory(signal: AbortSignal): Promise<void> {
    const window = this.historyWindow;
    const position = this.position;
    if (window === null || position === null || signal.aborted) return;
    const reads = this.historyReads();
    if (reads === null) return;
    const messages: GmailInboundMessage[] = [];
    const done = new Set<string>();
    for (const id of window.ids) {
      if (signal.aborted) return;
      let failure: GoogleApiFailure | null = null;
      if ((this.historyReadFailures.get(id) ?? 0) < HISTORY_READ_ATTEMPTS) {
        if (reads === 'full') {
          const read = await this.deps.history.getMessage(id);
          if (read.ok) {
            messages.push({ ...this.toInboundMessage(read.value, position, { availability: 'full', text: read.value.body }), history: true });
            continue;
          }
          failure = read;
        } else {
          const read = await this.deps.history.readMessageMetadata(id);
          if (read.ok) {
            messages.push({ ...this.toInboundMessage(read.value, position, { availability: 'metadata-only' }), history: true });
            continue;
          }
          failure = read;
        }
        if (failure.status === 404) { done.add(id); continue; }
        if (failure.status === null || failure.status === 401 || failure.status === 403 || failure.status === 429) continue;
        const attempts = (this.historyReadFailures.get(id) ?? 0) + 1;
        this.historyReadFailures.set(id, attempts);
        if (attempts < HISTORY_READ_ATTEMPTS) continue;
        this.note('message-stepped-over',
          `Message ${id} of the history window could not be read on ${String(attempts)} polls in a row `
          + `(${failure.problem}); the inbox shows that it exists and it is not read again.`);
      }
      messages.push(this.historyStandIn(id, position));
    }
    const outcome = signal.aborted ? null : await deliverToSink(this.deps.sink, messages, signal);
    if (outcome === null || signal.aborted) return;
    for (const message of messages.slice(0, outcome.done)) done.add(message.resourceId);
    if (outcome.failed) {
      this.note('delivery-failed',
        `History message ${messages[outcome.done]?.resourceId ?? '(unknown)'} was not taken; it and the history `
        + `after it are handed on again at the next poll: ${errorText(outcome.error)}`);
    }
    if (done.size === 0) return;
    for (const id of done) this.historyReadFailures.delete(id);
    const rest = window.ids.filter((id) => !done.has(id));
    await this.deps.cursors.recordGmailHistory?.(
      { account: this.deps.account, mailbox: this.deps.mailbox },
      { messageIds: rest, skippedOlderMessages: window.skipped },
    );
    this.historyWindow = rest.length > 0 ? { ids: rest, skipped: window.skipped } : null;
  }

  /**
   * Tell the consumers where this reader stands and what history window it
   * kept, so the inbox status says what history a Gmail-read inbox was given.
   * Never throws: reporting cannot stop the mail being read.
   */
  private reportPosition(): void {
    if (this.position === null) return;
    const kept = this.historyKept;
    try {
      this.deps.sink.position?.({
        source: 'gmail',
        historyId: this.position,
        ...(kept === null ? {} : { history: { pendingMessages: this.historyWindow?.ids.length ?? 0, skippedOlderMessages: kept.skipped } }),
      });
    } catch {
      // A reporting consumer cannot stop the reader.
    }
  }

  /** The stand-in for a history message that could not be read: it exists, nothing of it is shown. */
  private historyStandIn(id: string, historyId: string): GmailInboundMessage {
    return {
      source: 'gmail',
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      from: '',
      subject: '',
      claimedDate: '',
      messageId: '',
      deliveredTo: [],
      unverifiedToHeaderClaim: '',
      resourceId: id,
      historyId,
      body: '',
      bodyAvailability: 'metadata-only',
      via: 'poll',
      history: true,
      unreadable: { reason: 'repeated-read-failure' },
    };
  }

  /**
   * Hand a delta's messages to the sink, then move the cursor as far as the
   * messages that were done reach.
   *
   * Each history record has its own id, so the cursor moves to the last record
   * whose messages were all read and handed on, the same per-message rule the
   * IMAP path follows with UIDs, and never past a message that was not. A
   * refused delivery or a message Google would not hand over stops the cursor
   * just below that message's record: on a forward-only history log moving past
   * it would be a permanent loss, not a delay. Only what follows is fetched
   * again, and dedup suppresses any message behind it that was already handed
   * on. A message deleted between `history.list` and `messages.get` counts as
   * done; `collectHistoryDelta` has already removed it.
   */
  private async deliver(
    delta: GmailHistoryDelta,
    signal: AbortSignal,
  ): Promise<InboundCapabilityVerdict> {
    // The delta is narrowed ONCE, here, and every message carries the answer as
    // its own field from this point on. Doing it in one place is the point: the
    // alternative is each downstream step re-deriving "were bodies available"
    // from the shape it was handed, and the step that derives it wrongly is the
    // one deciding whether a verification expectation is satisfied.
    //
    // Building the whole list before delivering any of it also keeps the
    // narrowing out of the loop, so there is no arm of the union reachable
    // inside the delivery path at all.
    const messages: readonly GmailInboundMessage[] = delta.bodies === 'available'
      ? delta.messages.map((message) => this.toInboundMessage(
        message,
        delta.historyId,
        { availability: 'full', text: message.body },
      ))
      : delta.messages.map((message) => this.toInboundMessage(
        message,
        delta.historyId,
        { availability: 'metadata-only' },
      ));

    const held = this.heldUnreadable(delta);
    const notDone = new Set(held.map((problem) => problem.id));
    // Set by `pollOnce` before every delta; the history position this delta started from.
    const start = this.position;
    // Every consumer of this mailbox gets the delta as one batch; the history
    // position passes only the messages they all settled.
    const outcome = signal.aborted ? null : await deliverToSink(this.deps.sink, messages, signal);
    if (outcome === null || signal.aborted) return this.verdict;
    const refused = outcome.failed ? messages[outcome.done] : undefined;
    if (refused !== undefined) {
      const error = outcome.error;
      // Google answered, so any run of unexplained 403s is over.
      this.unexplainedForbiddenSince = null;
      for (const rest of messages.slice(outcome.done)) notDone.add(rest.resourceId);
      const reached = start === null ? null : reachedHistoryId(delta, start, (id) => !notDone.has(id));
      if (reached !== null) await this.moveCursor(reached);
      this.note('delivery-failed',
        `Message ${refused.resourceId} was not processed, so the history position moves only to `
        + `${reached ?? 'where it was'}, just below it, and the mail from there on is fetched again: ${errorText(error)}`);
      // Deliberately no backoff. The stated worst case is the poll interval,
      // and stretching the interval because a sink refused would make that
      // number untrue, the sink's problem is not a reason to notice the
      // NEXT message later.
      this.deliveryFailures += 1;
      if (this.deliveryFailures < MAX_CONSECUTIVE_DELIVERY_FAILURES) return this.verdict;
      // The same message refusing every pass holds the cursor, and everything
      // behind it, in place under a verdict that would otherwise stay green.
      return this.record(capabilityVerdict(
        'reconnecting',
        `Message ${refused.resourceId} has been refused ${String(this.deliveryFailures)} times in a `
        + `row, so mail behind it in this label is not being handed on: ${errorText(error)}`,
      ));
    }
    this.deliveryFailures = 0;

    if (held.length > 0) {
      // Messages this delta named and Google would not hand over. NOT messages
      // that are gone, `collectHistoryDelta` has already separated those out
      // and dropped them. These are still in the mailbox, and Gmail's history
      // is forward-only, so advancing to `delta.historyId` here would put the
      // cursor above records that can never be requested again: the
      // verification email nobody is ever told about, under a `healthy`
      // verdict. So the position moves only to just below the first of them.
      const reached = start === null ? null : reachedHistoryId(delta, start, (id) => !notDone.has(id));
      if (reached !== null) await this.moveCursor(reached);
      this.note('fetch-unreadable', this.unreadableDetail({ ...delta, unreadable: held }, reached ?? 'where it was'));
      return this.recordFailure(this.firstUnreadableFailure({ ...delta, unreadable: held }));
    }

    await this.moveCursor(delta.historyId);
    if (delta.messages.length > 0) {
      this.note('delta-drained',
        `${String(delta.messages.length)} message(s) delivered; history position advanced to `
        + `${delta.historyId}.`);
    }
    // A drained metadata-only delta is NOT healthy. Mail is moving and nothing
    // it carries can complete a signup, so the verdict says `degraded` with the
    // reason that names why, not `polling-configured`, which is the verdict for
    // a source doing exactly what it was asked to do.
    if (delta.bodies === 'withheld-metadata-only') return this.record(this.noticeOnlyVerdict());
    return this.record(capabilityVerdict('polling-configured', this.pollingDetail()));
  }

  /** Persist the history position, when it moved. */
  private async moveCursor(historyId: string): Promise<void> {
    if (historyId === this.position) return;
    try {
      const advanced = await this.deps.cursors.advanceGmail(
        { account: this.deps.account, mailbox: this.deps.mailbox },
        { historyId },
      );
      this.position = advanced.historyId;
    } catch (error) {
      // The record may have been removed under us; the next poll reads it again.
      this.position = null;
      throw error;
    }
  }

  /**
   * The verdict while `notice-only` is in force over a body-less Google grant.
   *
   * Built through `resolveInboundCapabilityPolicy` rather than written out
   * here, so the sentence the owner reads about which policy is in force comes
   * from the one function that decides it. A second sentence composed at this
   * call site is the mirror that drifts.
   */
  private noticeOnlyVerdict(): InboundCapabilityVerdict {
    const policy = resolveInboundCapabilityPolicy(
      this.capabilityPolicy,
      'gmail-metadata-notice-only',
    );
    // `capabilityVerdict` supplies the state and the remedial step from the two
    // tables in `capability.ts`, so this call site cannot hand the owner a
    // different fix for the same reason than the terminal notice would.
    return capabilityVerdict(
      'gmail-metadata-notice-only',
      'The connected Google account granted only the gmail.metadata scope, which Google '
      + 'describes as "View your email message metadata such as labels and headers, but not the '
      + `email body". ${this.pollingDetail()} ${policy.statusSentence}`,
    );
  }

  /**
   * What the owner is told when a delta could not be fully read.
   *
   * Says the three things that decide whether this needs acting on: how many
   * messages were unread, that the position did NOT move, and Google's own
   * words for why. The count of what was delivered is included because a
   * partly-read delta is a different situation from one that read nothing, and
   * a note that omitted it would read like a total outage during a single
   * rate-limited fetch.
   */
  /**
   * The unreadable entries that still hold the position. An entry Google has
   * answered with a permanent client error for MAX_PERMANENT_UNREADABLE_PASSES
   * passes in a row is given up on, with a note naming it; every transient
   * answer resets that id's count and never counts toward it.
   */
  private heldUnreadable(delta: GmailHistoryDelta): GmailHistoryDelta['unreadable'] {
    const seen = new Set(delta.unreadable.map((problem) => problem.id));
    for (const id of [...this.permanentUnreadable.keys()]) {
      if (!seen.has(id)) this.permanentUnreadable.delete(id);
    }
    const held: Array<GmailHistoryDelta['unreadable'][number]> = [];
    for (const problem of delta.unreadable) {
      if (!isPermanentFetchProblem(problem)) {
        this.permanentUnreadable.delete(problem.id);
        held.push(problem);
        continue;
      }
      const passes = (this.permanentUnreadable.get(problem.id) ?? 0) + 1;
      if (passes < MAX_PERMANENT_UNREADABLE_PASSES) {
        this.permanentUnreadable.set(problem.id, passes);
        held.push(problem);
        continue;
      }
      this.permanentUnreadable.delete(problem.id);
      this.note('fetch-unreadable',
        `Message ${problem.id} was refused by Google with HTTP ${String(problem.status)} on `
        + `${String(passes)} passes in a row (${problem.detail}), so it is treated as gone and the `
        + `history position moves past it to ${delta.historyId}.`);
    }
    return held;
  }

  private unreadableDetail(delta: GmailHistoryDelta, reached: string): string {
    const reasons = [...new Set(delta.unreadable.map((problem) => problem.detail))].join('; ');
    const ids = delta.unreadable.map((problem) => problem.id).join(', ');
    return `${String(delta.unreadable.length)} message(s) in this delta could not be fetched `
      + `(${ids}): ${reasons}. An answer we could not read is not evidence the message is gone, `
      + `so the history position moves only to ${reached}, just below the first of them, rather `
      + `than to ${delta.historyId}, and the mail from there on is fetched again. `
      + `${String(delta.messages.length)} message(s) in the same delta were delivered; any of them `
      + 'fetched again is suppressed as a duplicate.';
  }

  /**
   * The first unreadable entry, as the `GoogleApiFailure` `transientVerdict`
   * already knows how to classify.
   *
   * The FIRST rather than a summary, because the verdict turns on the status
   * and a synthesised "several things went wrong" would carry no status to
   * turn on, a 401 and a 429 need opposite answers (a new grant versus
   * waiting), and collapsing them would pick neither.
   *
   * `fix` is carried through rather than blanked, because `transientVerdict`
   * reads it directly on the `credentials-rejected` branch. Blanked, a token
   * refused mid-delta would reach the owner as "your mail has stopped" with no
   * remedial step attached, which is this file's own failure mode (`refuse`
   * carries Google's `problem` and `fix` verbatim for exactly this reason)
   * reproduced on the neighbouring path.
   */
  private firstUnreadableFailure(delta: GmailHistoryDelta): GoogleApiFailure {
    const first = delta.unreadable[0];
    return {
      ok: false,
      status: first?.status ?? null,
      problem: first?.detail ?? 'A message in the delta could not be fetched.',
      fix: first?.fix ?? '',
    };
  }

  /**
   * A grant that cannot do the job: refuse, name it, and say what fixes it.
   *
   * `problem` and `fix` are carried VERBATIM from `history-delta.ts`, which
   * quotes Google's own scope descriptions. Rewriting them here would be a
   * second explanation of the same condition, and the two would drift.
   *
   * The two reasons are distinct on purpose, the state tracker announces on a
   * change of state OR reason, so collapsing them into one would mean a token
   * that lost its last body scope, leaving only `gmail.metadata`, produced no
   * new announcement at all.
   */
  private refuse(result: HistoryDeltaUnavailable): InboundCapabilityVerdict {
    // `no-gmail-scope` keeps `mailbox-unreadable`, "signed in and this mailbox
    // cannot be read at all" is exactly what it is, and there is no Gmail-shaped
    // distinction to draw. `metadata-scope-only` no longer borrows
    // `fetch-refused`: it has its own reason now, because the two are opposite
    // situations and a policy has to tell them apart. `fetch-refused` is minted
    // from a FAILED envelope fetch, so when it fires nothing is readable;
    // `gmail-metadata-only` is the one condition where EVERYTHING except the
    // body is readable, which is why `notice-only` can mean something here and
    // nowhere else. The detail and the fix stay Gmail's own words either way.
    const reason = result.unavailable === 'no-gmail-scope'
      ? 'mailbox-unreadable'
      : 'gmail-metadata-only';
    // What the owner's setting actually selected for THIS condition, and, when
    // it selected nothing, the sentence saying so. Appended rather than
    // branched on: `statusSentence` is never empty, so the owner is told which
    // policy is in force whether or not it degraded, and there is no `if` here
    // that could be written the wrong way round.
    const policy = resolveInboundCapabilityPolicy(this.capabilityPolicy, reason);
    const verdict: InboundCapabilityVerdict = {
      state: stateForReason(reason),
      reason,
      detail: `${result.problem} ${policy.statusSentence}`,
      fix: result.fix,
    };
    this.latchInsufficient(verdict, reason, result.fix);
    return verdict;
  }

  /**
   * Record a failed Google call, announcing it to the owner when it means the
   * grant cannot work.
   *
   * `refuse` is not the only way to an `insufficient` verdict: a token Google
   * rejects mid-poll gets there too, and without the terminal failure the
   * owner is told nothing, since the announcer reacts to that alone.
   */
  private recordFailure(failure: GoogleApiFailure): InboundCapabilityVerdict {
    const verdict = this.transientVerdict(failure);
    if (verdict.state !== 'insufficient') return this.record(verdict);
    this.latchInsufficient(verdict, verdict.reason, verdict.fix);
    return verdict;
  }

  /**
   * Record an `insufficient` verdict and, on the transition, hand the owner the
   * terminal failure.
   *
   * The tracker's own answer to "was this a transition" decides, so the owner is
   * told once per transition and not once per probe.
   */
  private latchInsufficient(
    verdict: InboundCapabilityVerdict,
    reason: InboundCapabilityReason,
    fix: string,
  ): void {
    const announced = this.tracker.record(verdict);
    const failure: InboundMailTerminalFailure = {
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      reason,
      // The SAME detail the verdict carries, policy sentence included. The
      // terminal notice is the surface the owner actually reads when mail
      // stops, so a sentence that reached only the status line would reach
      // them in the place they are not looking.
      detail: verdict.detail,
      fix,
      at: new Date(this.deps.clock.now()).toISOString(),
      // No `EmailCapabilityFailureNotice`: that record is minted by the IMAP
      // error types, and inventing one here would claim a provenance this
      // failure does not have.
      notice: null,
    };
    this.terminal = failure;
    if (announced) {
      try {
        this.deps.observer?.terminalFailure?.(failure);
      } catch {
        // A notification route that throws must not become a second failure.
      }
    }
  }

  /**
   * An ordinary API failure, classified by what Google answered.
   *
   * A refused credential is `insufficient`, nothing clears it but a new grant.
   * A rate limit or a server fault is `degraded`: it is "not yet", not
   * "cannot", and the delta is still above the cursor when it clears.
   *
   * A 403 is ambiguous: Google sends it for a missing scope or a disabled API,
   * which only a new grant fixes, and also for a usage limit, which clears by
   * itself. The client reads which one from Google's own reason fields. A
   * usage limit (`rate-limited`) is waited out and never counts towards a
   * refusal. A 403 whose cause Google did not name is polled again, and
   * an unbroken run of them lasting `MAX_UNEXPLAINED_FORBIDDEN_MS` is taken as a
   * real refusal so a revoked scope cannot retry for ever. Any other failure
   * ends the run. A grant Google reports as dead
   * (`grant-invalid`) is a refusal whatever the status, including the `null`
   * status of a token that could not be obtained at all.
   */
  private transientVerdict(failure: GoogleApiFailure): InboundCapabilityVerdict {
    let rejected = failure.reason === 'grant-invalid'
      || failure.reason === 'missing-scopes'
      || failure.reason === 'api-disabled'
      || failure.status === 401;
    if (!rejected && failure.status === 403 && failure.reason !== 'rate-limited') {
      const now = this.deps.clock.now();
      this.unexplainedForbiddenSince ??= now;
      rejected = now - this.unexplainedForbiddenSince >= MAX_UNEXPLAINED_FORBIDDEN_MS;
    } else {
      this.unexplainedForbiddenSince = null;
    }
    if (rejected) {
      return {
        state: stateForReason('credentials-rejected'),
        reason: 'credentials-rejected',
        detail: failure.problem,
        fix: failure.fix,
      };
    }
    if (failure.status === 403 || failure.status === 429
      || (failure.status !== null && failure.status >= 500)) {
      return capabilityVerdict('server-unavailable', failure.problem);
    }
    return capabilityVerdict('reconnecting', failure.problem);
  }

  /**
   * One delta message as the pipeline's own shape.
   *
   * Takes `GmailMessageMetadata`, which `GmailMessageBody` extends, so both
   * delta arms pass one in and neither can reach a `body` property through this
   * parameter.
   *
   * The body arrives as its own discriminated argument rather than being read
   * off `message` or inferred from a boolean flag. That is what makes "full"
   * and "we have text" impossible to state separately: `'full'` is the only
   * shape that carries a `text`, and `'metadata-only'` has nowhere to put one.
   * Sniffing the property instead would decide "does this have a body" from
   * whether a field happens to be present, and a body-capable grant returning a
   * genuinely empty message would then be indistinguishable from a metadata-only
   * one, which is the confusion the whole round exists to remove.
   */
  private toInboundMessage(
    message: GmailMessageMetadata,
    historyId: string,
    body:
      | { readonly availability: 'full'; readonly text: string }
      | { readonly availability: 'metadata-only' },
  ): GmailInboundMessage {
    return {
      source: 'gmail',
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      from: message.from,
      subject: message.subject,
      // Sender-written, so display only, and never an ordering key, the
      // historyId is the ordering authority on this source.
      claimedDate: message.date,
      // The `Message-ID` header, which Gmail's `messages.get` mapping does not
      // extract today. Left empty rather than filled with the opaque resource
      // id: §6 refuses `Message-ID` as an identity on BOTH sources, so putting
      // the server-assigned id in the sender-written field would make one field
      // mean two different things and would tempt a consumer into treating it
      // as an identity. The identity is `resourceId`, below.
      messageId: '',
      deliveredTo: message.deliveredTo,
      unverifiedToHeaderClaim: message.to,
      resourceId: message.id,
      ...(message.receivedAt === undefined ? {} : { arrivedAt: message.receivedAt }),
      unread: message.unread,
      historyId,
      // `''` on the metadata arm because there is no text to put there, the
      // argument type has no field for one. `bodyAvailability` below is what
      // tells every downstream reader which of the two an empty string means.
      body: body.availability === 'full' ? body.text : '',
      bodyAvailability: body.availability,
      via: 'poll',
    };
  }

  private pollingDetail(): string {
    const seconds = Math.round(this.intervalMs / 1000);
    return `Gmail has no push available to a daemon behind NAT, so new mail is found by asking `
      + `every ${String(seconds)} second${seconds === 1 ? '' : 's'}.`;
  }

  /** Record a verdict and return it, so call sites read as one expression. */
  private record(verdict: InboundCapabilityVerdict): InboundCapabilityVerdict {
    this.tracker.record(verdict);
    // A terminal failure describes the verdict that latched it. Once anything
    // but `insufficient` is recorded, the grant works again and the old
    // failure would be stale data on the status surface.
    if (verdict.state !== 'insufficient') this.terminal = null;
    if (verdict.reason === 'polling-configured' || verdict.reason === 'gmail-metadata-notice-only') {
      this.unexplainedForbiddenSince = null;
    }
    return verdict;
  }

  private note(kind: InboundMailNote['kind'], detail: string): void {
    try {
      this.deps.observer?.note?.({
        account: this.deps.account,
        mailbox: this.deps.mailbox,
        kind,
        detail,
        at: new Date(this.deps.clock.now()).toISOString(),
      });
    } catch {
      // An observer that throws must not stop the mail being read.
    }
  }
}

/** The history window a cursor record holds, or null when none is left to hand on. */
function windowOf(cursor: { readonly historyMessageIds?: readonly string[] | undefined; readonly skippedOlderMessages?: number | undefined }): { readonly ids: readonly string[]; readonly skipped: number } | null {
  const ids = cursor.historyMessageIds;
  return ids !== undefined && ids.length > 0 ? { ids, skipped: cursor.skippedOlderMessages ?? 0 } : null;
}

/** Whether the cursor record holds a kept history window (even one fully handed on), and what it left out. */
function keptOf(cursor: { readonly historyMessageIds?: readonly string[] | undefined; readonly skippedOlderMessages?: number | undefined }): { readonly skipped: number } | null {
  return cursor.historyMessageIds !== undefined ? { skipped: cursor.skippedOlderMessages ?? 0 } : null;
}

/** A batch to the sink, one message at a time for a sink that takes no batches. */
async function deliverToSink(
  sink: InboundMailSink,
  messages: readonly GmailInboundMessage[],
  signal: AbortSignal,
): Promise<MailboxBatchOutcome> {
  if (messages.length === 0) return { done: 0, failed: false, error: null };
  if (sink.deliverBatch) return sink.deliverBatch(messages, signal);
  for (const [index, message] of messages.entries()) {
    if (signal.aborted) return { done: index, failed: true, error: signal.reason };
    try {
      await sink.deliver(message);
    } catch (error) {
      return { done: index, failed: true, error };
    }
  }
  return { done: messages.length, failed: false, error: null };
}
