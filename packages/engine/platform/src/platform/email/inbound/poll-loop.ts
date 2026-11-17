/**
 * Finding what arrived: the delta fetch, and the adaptive poll that drives it.
 *
 * The delta fetch is the load-bearing half of this file and is shared with the
 * IDLE path, which is why it lives beside the poll loop rather than inside it.
 * IDLE and polling differ only in WHEN they ask; what they ask is identical,
 * and identical because it has to be:
 *
 * > **The delta always comes from `UID SEARCH UID <cursor+1>:*`.**
 *
 * Not from arithmetic on `EXISTS`, which is a mailbox TOTAL and says neither
 * which message is new nor how many arrived. Not from a sequence number, which
 * renumbers on every expunge. Not from `SEARCH UNSEEN`, which cannot work at
 * all here because `EXAMINE` + `BODY.PEEK` means nothing is ever marked
 * `\Seen`, so the same messages would come back forever.
 *
 * The `*` in that range needs care
 * ────────────────────────────────
 * `UID SEARCH UID 11:*` does NOT mean "UIDs from 11 upwards". RFC 3501 defines
 * `*` as the highest UID in the mailbox, and a range whose start exceeds its
 * end is not empty, it is the range with its endpoints swapped. So on a
 * mailbox whose highest UID is 10, `11:*` is the range 10:11 and matches
 * message 10, which the cursor says is already processed. Every server does
 * this and it is correct behaviour; a watcher that trusted the result would
 * redeliver its newest message on every single poll. Results are therefore
 * filtered to strictly above the cursor, here, once.
 *
 * The cursor moves behind the work, never ahead of it
 * ───────────────────────────────────────────────────
 * `advance()` is called once per batch and only past the messages every
 * consumer settled. A crash, a failed notice or a killed process between
 * fetch and completion therefore leaves the cursor below the message, and the
 * next pass fetches it again, a duplicate each consumer absorbs by the message
 * key rather than a message nobody ever hears about. This is the same rule
 * `TelegramIngressSupervisor` already follows for its offset, and it is the
 * reason a reconnect loses nothing: recovery is not "resume the stream", it is
 * "ask what is above the cursor".
 */

import type { ImapEnvelopeBatch, ImapFetchProblem } from '../imap-client.js';
import type { CompleteMessageRead } from '../imap-message-complete.js';
import { parseSearchNumbers } from '../imap-headers.js';
import type {
  ImapInboundMessage,
  InboundMailboxMessage,
  InboundMailObserver,
  InboundMailSink,
  InboundWatcherSettings,
  MailboxBatchOutcome,
  MailboxContentRead,
  MailboxCursorPort,
  MailboxReader,
  MailboxWire,
  WatcherClock,
} from './ports.js';
import { isImapUid, MAX_IMAP_UID } from './source-cursor.js';
import { isConsumerUnavailable, MailboxReadError } from './mailbox-consumers.js';
import type { MailboxCursor } from './types.js';

/** Everything one drain of the mailbox needs. */
export interface MailboxDeltaDeps {
  readonly settings: InboundWatcherSettings;
  readonly reader: MailboxReader;
  readonly wire: MailboxWire;
  readonly cursors: MailboxCursorPort;
  readonly sink: InboundMailSink;
  readonly clock: WatcherClock;
  readonly observer?: InboundMailObserver | undefined;
  /** Where the cursor stands going in. */
  readonly cursor: MailboxCursor;
  /** Recorded on each message so a consumer can tell push from poll. */
  readonly via: 'idle' | 'poll';
  readonly signal: AbortSignal;
  /** Read failures per message across drains, owned by the watcher. */
  readonly readFailures?: MailboxReadFailures | undefined;
}

/** Why a drain stopped, and where it left the cursor. */
export type MailboxDeltaOutcome =
  /** Every message above the cursor was delivered. */
  | 'complete'
  /** Shutdown was requested part-way through. The rest is above the cursor. */
  | 'aborted'
  /** The sink refused a message. The cursor is below it; it will come again. */
  | 'delivery-failed'
  /** The server or socket failed. Classified by the caller. */
  | 'read-failed';

export interface MailboxDeltaReport {
  readonly outcome: MailboxDeltaOutcome;
  /** How many UIDs the search returned above the cursor. */
  readonly found: number;
  /** How many were handed to the sink and accepted. */
  readonly delivered: number;
  /** UIDs the search returned and the FETCH did not: expunged in between. */
  readonly vanished: number;
  /** Where the cursor stands coming out. */
  readonly cursor: MailboxCursor;
  /** The failure, for `delivery-failed` and `read-failed`. */
  readonly error: unknown;
  /**
   * Which command failed, for `read-failed`.
   *
   * A refused FETCH and a refused SEARCH are different claims about the
   * mailbox, the first says its contents are withheld, the second is
   * routinely transient, so the caller is told which one it was rather than
   * left to guess from the message text.
   */
  readonly phase: 'search' | 'fetch' | null;
  /**
   * True when `read-failed` means "the server answered and this client could
   * not read the answer", rather than a refusal or a dead socket.
   *
   * The caller needs this as its own fact rather than as a string match on
   * `error.message`. An unreadable answer is retried, the message is still in
   * the mailbox and the cursor has not moved past it, but it is retried
   * against a condition that may never clear, so it needs a ceiling of its own
   * the way an unexpected throw does. Counting it requires being able to
   * recognise it, and recognising it by re-reading the sentence
   * `unreadableFetch` wrote would be a second classifier that silently stops
   * agreeing the day the sentence is reworded.
   */
  readonly unreadableFetch: boolean;
}

/**
 * Ask the server for the UIDs above the cursor.
 *
 * Issued on the raw wire because `UID SEARCH UID n:*` is not on the client's
 * method surface, and bounded by the operation timeout because a search that
 * never answers is a dead connection wearing a healthy one's clothes.
 *
 * REFUSES A CURSOR OUTSIDE THE 32-BIT UID SPACE rather than searching from it.
 * `source-cursor.ts` and `MailboxCursorStore` between them make such a cursor
 * unstorable and unwritable, and `parseSearchNumbers` makes it unreadable off
 * the wire, so this should never fire, it is here because of what the failure
 * LOOKED like when it could. `UID SEARCH UID 9007199254740992:*` is a range a
 * server answers perfectly happily, and every UID it returns then fails the
 * `uid > lastSeenUid` filter below: the drain reports `complete, found: 0`,
 * the watcher reports healthy, and no mail is ever delivered again. Silence
 * that reports itself as success is the one failure mode this whole capability
 * exists to eliminate, so an impossible position is raised as a read failure,
 * `drainMailboxDelta` turns it into `read-failed` on the `search` phase, which
 * the caller backs off and discloses, rather than being searched from as if
 * it were a place.
 */
export async function searchAboveCursor(
  wire: MailboxWire,
  lastSeenUid: number,
  options: { readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<number[]> {
  if (!isImapUid(lastSeenUid)) {
    throw new Error(
      `Refusing to search above UID ${String(lastSeenUid)}: not an integer in `
      + `0..${String(MAX_IMAP_UID)} (RFC 3501 §2.3.1.1). No UID a server can issue is above it, `
      + 'so every message in the mailbox would be filtered out and the drain would report '
      + 'success having delivered nothing.',
    );
  }
  const from = Math.max(1, lastSeenUid + 1);
  const tag = await wire.sendCommand(`UID SEARCH UID ${from}:*`);
  const lines = await wire.awaitTag(tag, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  // Filtered, not trusted: see the file header on why `11:*` can return 10.
  const above = parseSearchNumbers(lines).filter((uid) => uid > lastSeenUid);
  above.sort((a, b) => a - b);
  return above;
}

function chunk(uids: readonly number[], size: number): number[][] {
  const batches: number[][] = [];
  for (let index = 0; index < uids.length; index += size) {
    batches.push(uids.slice(index, index + size));
  }
  return batches;
}

/**
 * Fetch and process everything above the cursor, advancing behind each one.
 *
 * Batched at `deltaBatchSize`, and the batching is load-bearing rather than
 * defensive. `fetchEnvelopes` REFUSES a batch above `IMAP_MAX_FETCH_UIDS`
 * instead of trimming it, so a mailbox that took two thousand messages while
 * the daemon was down would fail its whole delta on one over-long `UID FETCH`
 * line and make no progress at all on any pass. Splitting it is what makes
 * that recovery possible; the ceiling is enforced when the setting is
 * resolved.
 *
 * Ascending UID order throughout, because the cursor is a high-water mark:
 * processing 12 before 11 and then failing on 11 would leave the cursor either
 * at 12 (losing 11) or at 10 (redelivering 12). In order, the cursor is always
 * exactly "everything below this is done".
 *
 * A UID the search returned and the FETCH did not is a message expunged in the
 * gap between the two, but ONLY when no unreadable response could have been
 * that UID's own. The cursor advances past a genuine expunge: the server has
 * said it is not there, and holding the cursor below a UID that no longer
 * exists would make every subsequent pass re-search from a point that can
 * never clear.
 *
 * Whether an unreadable response could have been this UID's is decided per
 * UID, not per batch, see `attributeUnreadable`. A batch-wide test was the
 * first version of this rule and it froze the cursor permanently: with UID 101
 * genuinely expunged and UID 102 unreadable in the same batch, 101 was refused
 * as well, batch composition is stable across retries, and so the cursor could
 * never clear 100. The block that exists to avoid stepping over live mail must
 * not also refuse to step over mail the server has said is gone.
 */
export async function drainMailboxDelta(
  deps: MailboxDeltaDeps,
): Promise<MailboxDeltaReport> {
  const { settings, cursor } = deps;
  const failures = deps.readFailures ?? new MailboxReadFailures();
  let current = cursor;
  let delivered = 0;
  let vanished = 0;

  const finish = (
    outcome: MailboxDeltaOutcome,
    found: number,
    error: unknown = null,
    phase: 'search' | 'fetch' | null = null,
    unreadableFetch = false,
  ): MailboxDeltaReport => ({
    outcome, found, delivered, vanished, cursor: current, error, phase, unreadableFetch,
  });

  let uids: number[];
  try {
    uids = await searchAboveCursor(deps.wire, cursor.lastSeenUid, {
      timeoutMs: settings.operationTimeoutMs,
      signal: deps.signal,
    });
  } catch (error) {
    return finish(deps.signal.aborted ? 'aborted' : 'read-failed', 0, error, 'search');
  }
  if (uids.length === 0) {
    reportPosition(deps, current, 0);
    return finish('complete', 0);
  }

  for (const batch of chunk(uids, settings.deltaBatchSize)) {
    if (deps.signal.aborted) return finish('aborted', uids.length);
    let fetched: ImapEnvelopeBatch;
    try {
      fetched = await deps.reader.fetchEnvelopeBatch(batch);
    } catch (error) {
      return finish(
        deps.signal.aborted ? 'aborted' : 'read-failed', uids.length, error, 'fetch');
    }
    const byUid = new Map(fetched.envelopes.map((envelope) => [envelope.uid, envelope]));
    const unreadable = fetched.unreadable;
    const attribution = attributeUnreadable(unreadable);
    const unread = unreadSearch(deps, batch[0]!);

    const messages: ImapInboundMessage[] = [];
    // The highest UID the cursor may pass when every message here is settled:
    // the last message, or an expunge or stepped-over UID after it.
    let covered = current.lastSeenUid;
    let stop: Error | null = null;
    for (const uid of batch) {
      const envelope = byUid.get(uid);
      if (envelope === undefined) {
        if (attribution.couldBe(uid)) {
          // Not an expunge, or not provably one. Read again on the next
          // drains; after the bounded attempts it is stepped over and handed
          // on as a stand-in, so it neither holds the mailbox nor goes unsaid.
          if (failures.note('envelope', current.uidValidity, uid) < MAX_READ_ATTEMPTS) {
            stop = unreadableFetch(deps, current, uid, unreadable, attribution.named.has(uid));
            break;
          }
          failures.clear('envelope', current.uidValidity, uid);
          messages.push(standIn(deps, current, uid, 'repeated-read-failure'));
          note(deps, 'message-stepped-over',
            `UID ${uid} could not be read on ${MAX_READ_ATTEMPTS} drains in a row, so it was handed on as `
            + 'a message that could not be read here and the cursor moves past it.');
          covered = uid;
          continue;
        }
        vanished += 1;
        covered = uid;
        continue;
      }
      failures.clear('envelope', current.uidValidity, uid);
      // The base fields are a straight carry off the envelope: the pipeline
      // downstream reads `InboundMessageCommon` and never narrows, so what a
      // source can say has to be said here rather than left for each
      // consumer to dig out of `envelope`. `date` becomes `claimedDate`
      // because it is sender-written and is not an ordering key.
      const uidValidity = current.uidValidity;
      messages.push({
        source: 'imap',
        account: settings.account,
        mailbox: settings.mailbox,
        from: envelope.from,
        subject: envelope.subject,
        claimedDate: envelope.date,
        messageId: envelope.messageId,
        deliveredTo: envelope.deliveredTo,
        unverifiedToHeaderClaim: envelope.unverifiedToHeaderClaim,
        uidValidity,
        uid,
        envelope,
        via: deps.via,
        ...(uid <= (current.historyThrough ?? 0) ? { history: true } : {}),
        readContent: () => readContent(deps, failures, uidValidity, uid),
        readUnread: async () => (await unread()).has(uid),
      });
      covered = uid;
    }

    const outcome = await deliverBatch(deps.sink, messages, deps.signal);
    // Retired part-way through: nothing more is handed on and the cursor stays
    // where it was, so the next reader hands the batch over again.
    if (deps.signal.aborted) return finish('aborted', uids.length);
    delivered += outcome.done;
    // Only now, and only past what every consumer settled. Everything about
    // "no message is lost" is in this ordering.
    const target = outcome.failed ? messages[outcome.done]!.uid - 1 : covered;
    if (target > current.lastSeenUid) current = await advanceTo(deps, current, target);
    reportPosition(deps, current, uids.filter((uid) => uid > current.lastSeenUid).length);
    if (outcome.failed) {
      const failedUid = messages[outcome.done]!.uid;
      if (outcome.error instanceof MailboxReadError) {
        return finish(deps.signal.aborted ? 'aborted' : 'read-failed', uids.length, outcome.error, 'fetch');
      }
      note(deps, 'delivery-failed',
        `UID ${failedUid} was not processed, so the cursor stays at `
        + `${current.lastSeenUid} and the message will be fetched again.`);
      return finish('delivery-failed', uids.length, outcome.error);
    }
    if (stop !== null) {
      note(deps, 'fetch-unreadable', stop.message);
      return finish('read-failed', uids.length, stop, 'fetch', true);
    }
  }

  note(deps, 'delta-drained',
    `${delivered} message(s) processed above UID ${cursor.lastSeenUid}`
    + `${vanished > 0 ? `, ${vanished} expunged before they could be fetched` : ''}.`);
  return finish('complete', uids.length);
}

/** Drains a message may fail to read on before it is stepped over. */
export const MAX_READ_ATTEMPTS = 3;
/** Bound on the failure counts held at once; the oldest are forgotten first. */
const MAX_TRACKED_READ_FAILURES = 256;

/**
 * Consecutive drains on which a message could not be read, per
 * `uidValidity:uid` and per kind of read. Held in memory by the watcher:
 * after a restart a message gets the same few drains again, which is the
 * bound that matters, no single message holds the mailbox.
 */
export class MailboxReadFailures {
  private readonly counts = new Map<string, number>();

  note(kind: 'envelope' | 'content', uidValidity: number, uid: number): number {
    const key = `${kind}:${String(uidValidity)}:${String(uid)}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.delete(key);
    this.counts.set(key, count);
    if (this.counts.size > MAX_TRACKED_READ_FAILURES) this.counts.delete(this.counts.keys().next().value!);
    return count;
  }

  clear(kind: 'envelope' | 'content', uidValidity: number, uid: number): void {
    if (this.counts.size > 0) this.counts.delete(`${kind}:${String(uidValidity)}:${String(uid)}`);
  }
}

/** Feed a batch to the sink, one message at a time for a sink that takes no batches. */
async function deliverBatch(
  sink: InboundMailSink,
  messages: readonly InboundMailboxMessage[],
  signal: AbortSignal,
): Promise<MailboxBatchOutcome> {
  if (messages.length === 0) return { done: 0, failed: false, error: null };
  if (sink.deliverBatch) return sink.deliverBatch(messages, signal);
  for (let index = 0; index < messages.length; index += 1) {
    if (signal.aborted) return { done: index, failed: true, error: signal.reason };
    try {
      await sink.deliver(messages[index]!);
    } catch (error) {
      return { done: index, failed: true, error };
    }
  }
  return { done: messages.length, failed: false, error: null };
}

/** One `UID SEARCH UNSEEN` per batch, and only when a consumer asks whether a message is unread. */
function unreadSearch(deps: MailboxDeltaDeps, fromUid: number): () => Promise<ReadonlySet<number>> {
  let pending: Promise<ReadonlySet<number>> | null = null;
  return () => pending ??= deps.reader.searchCompleteUids(true, fromUid).then(
    (uids) => new Set(uids),
    (error: unknown) => {
      pending = null;
      throw new MailboxReadError('The unread search failed on this connection; it is asked again on the next drain.', { cause: error });
    },
  );
}

/**
 * The complete source, on this session. A read that failed (not the message's
 * own bytes) is tried on the next drains and handed back as
 * `repeated-read-failure` after the bounded attempts.
 */
async function readContent(
  deps: MailboxDeltaDeps,
  failures: MailboxReadFailures,
  uidValidity: number,
  uid: number,
): Promise<MailboxContentRead> {
  let read: CompleteMessageRead;
  try {
    read = await deps.reader.readCompleteMessageDetail(uid);
  } catch {
    read = { outcome: 'incomplete', reason: 'source-fetch-failed', fromMessage: false };
  }
  if (read.outcome === 'incomplete' && !read.fromMessage) {
    if (failures.note('content', uidValidity, uid) < MAX_READ_ATTEMPTS) {
      throw new MailboxReadError(`The complete source of UID ${uid} could not be read on this connection; it is read again on the next drain.`);
    }
    failures.clear('content', uidValidity, uid);
    note(deps, 'message-stepped-over',
      `The complete source of UID ${uid} could not be read on ${MAX_READ_ATTEMPTS} drains in a row, so it is shown as a message that could not be read here.`);
    return { outcome: 'incomplete', reason: 'repeated-read-failure', fromMessage: true };
  }
  failures.clear('content', uidValidity, uid);
  return read;
}

/** The stand-in for a message the reader stepped over: no envelope fields, the reason, and its place. */
function standIn(deps: MailboxDeltaDeps, current: MailboxCursor, uid: number, reason: string): ImapInboundMessage {
  const { account, mailbox } = deps.settings;
  return {
    source: 'imap',
    account,
    mailbox,
    from: '',
    subject: '',
    claimedDate: '',
    messageId: '',
    deliveredTo: [],
    unverifiedToHeaderClaim: '',
    uidValidity: current.uidValidity,
    uid,
    envelope: {
      uid, from: '', subject: '', date: '', messageId: '', mailbox,
      deliveredTo: [], deliveryEvidence: [], unverifiedToHeaderClaim: '', authenticationResults: [],
    },
    via: deps.via,
    ...(uid <= (current.historyThrough ?? 0) ? { history: true } : {}),
    unreadable: { reason },
  };
}

function reportPosition(deps: MailboxDeltaDeps, cursor: MailboxCursor, pending: number): void {
  const history = cursor.historyThrough !== undefined && cursor.historyFloorUid !== undefined
    ? { floorUid: cursor.historyFloorUid, throughUid: cursor.historyThrough, skippedOlderMessages: cursor.skippedOlderMessages ?? 0 }
    : undefined;
  try {
    deps.sink.position?.({ uidValidity: cursor.uidValidity, lastSeenUid: cursor.lastSeenUid, pending, history });
  } catch {
    // Reporting cannot stop the mail being read.
  }
}

/**
 * Which missing UIDs an unreadable response could belong to.
 *
 * THE RULE, stated once so it is arguable rather than buried: a UID absent
 * from the fetch result is unattributable, and therefore not provably
 * expunged, when either
 *
 *   1. an unreadable response NAMED that UID (`problem.uid === uid`); the
 *      server answered for it and the answer could not be read, or
 *   2. any unreadable response named no UID at all (`problem.uid === null`);
 *      such a response belongs to some message in this batch and there is
 *      nothing in it that says which.
 *
 * Anything else is a genuine expunge and the cursor advances past it. That is
 * the whole of the difference from the batch-wide test this replaces: a
 * response that names UID 102 says nothing whatsoever about UID 101, and
 * treating it as though it did is what pinned the cursor below a message the
 * server had already said was gone.
 *
 * WHAT THIS CANNOT DECIDE, plainly: case 2. When even one response arrived
 * with no legible UID, every missing UID in the batch is ambiguous, the drain
 * stops at the first of them, and no missing UID in that batch advances. A
 * counting argument does bound how many of them can really be unreadable, at
 * most one per unattributable response, but it does not say WHICH, and the
 * cursor is a high-water mark that can only move past a specific UID. A
 * sequence-number argument could narrow it further (responses come back in
 * mailbox order, and mailbox order is UID order), but it would rest on an
 * ordering RFC 3501 does not require a server to use for a `UID FETCH` set,
 * and being wrong about it means stepping over live mail. So this stays with
 * what the server actually said.
 *
 * Over-retrying a message that really was expunged costs one more fetch that
 * returns nothing; under-retrying costs the message. The ceiling on how long
 * that retrying may go on is the watcher's, see `MAX_CONSECUTIVE_UNREADABLE_DRAINS`.
 */
function attributeUnreadable(unreadable: readonly ImapFetchProblem[]): {
  readonly named: ReadonlySet<number>;
  readonly couldBe: (uid: number) => boolean;
} {
  const named = new Set<number>();
  let anyUnattributable = false;
  for (const problem of unreadable) {
    if (problem.uid === null) anyUnattributable = true;
    else named.add(problem.uid);
  }
  return {
    named,
    couldBe: (uid: number): boolean => anyUnattributable || named.has(uid),
  };
}

/**
 * The failure raised when a UID is missing from a batch and an unreadable
 * response could have been its own.
 *
 * The two facts that used to be one
 * ────────────────────────────────
 * "The server sent no response for UID 307" and "the server sent a response for
 * UID 307 and we could not read it" arrive here identically: 307 is not in the
 * result. The first is an expunge and the cursor may move past it. The second
 * is a message still sitting in the mailbox that we know nothing about, and
 * moving the cursor past it means nobody is ever told it arrived.
 *
 * This function is reached only in the second case. `attributed` says which
 * way it was reached, and the sentence says so, because "the server answered
 * for UID 307 and we could not read it" and "one of the answers was
 * unreadable and none of them said which message it was about" are different
 * things to tell an owner who is trying to work out what their mail server is
 * doing.
 *
 * The wording is deliberately the owner's, not a stack trace: this reaches
 * `classifyReadFailure`, which sees a plain Error rather than an
 * `IMAP command failed:` refusal and classifies it as `reconnecting`, a
 * transient condition the watcher retries under its normal backoff. It is the
 * watcher's own consecutive-unreadable count, not this classification, that
 * eventually calls it a capability verdict.
 */
function unreadableFetch(
  deps: MailboxDeltaDeps,
  current: MailboxCursor,
  uid: number,
  unreadable: readonly ImapFetchProblem[],
  attributed: boolean,
): Error {
  const reasons = unreadable.map((problem) => problem.detail).join('; ');
  const claim = attributed
    ? `The mail server answered the fetch for UID ${uid} with a response this client could not read`
    : `The mail server answered this fetch with ${unreadable.length} response(s) this client `
      + `could not read, and none of them named a UID, so any of them may have been UID ${uid}'s`;
  return new Error(
    `${claim} (${reasons}). An unreadable answer is not evidence that the message is gone, so `
    + `the cursor stays at ${current.lastSeenUid} and the message will be fetched again.`,
  );
}

/**
 * Move the cursor and take the store's answer for where it now is.
 *
 * The returned cursor is the STORE'S, not a locally reconstructed one. This
 * used to build `{ ...current, lastSeenUid: uid }` by hand, which quietly
 * disagreed with the store: `advance` clamps with
 * `Math.max(existing.lastSeenUid, input.lastSeenUid)` so a cursor never moves
 * backwards, and the local copy assigned unconditionally. Two computations of
 * one rule, neither aware of the other. Now there is one.
 */
async function advanceTo(
  deps: MailboxDeltaDeps,
  current: MailboxCursor,
  uid: number,
): Promise<MailboxCursor> {
  return deps.cursors.advance({
    account: current.account,
    mailbox: current.mailbox,
    uidValidity: current.uidValidity,
    lastSeenUid: uid,
  });
}

function note(
  deps: MailboxDeltaDeps,
  kind: 'delta-drained' | 'delivery-failed' | 'fetch-unreadable' | 'message-stepped-over',
  detail: string,
): void {
  try {
    deps.observer?.note?.({
      account: deps.settings.account,
      mailbox: deps.settings.mailbox,
      kind,
      detail,
      at: new Date(deps.clock.now()).toISOString(),
    });
  } catch {
    // An observer that throws must not stop the mail being read.
  }
}

// ---------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------

/**
 * Why the poll loop returned.
 *
 * `read-failed` is deliberately not split into "the socket died" and "the
 * server refused" here. Telling those apart decides whether the watcher
 * reconnects or reports `insufficient`, which is a capability judgement, and
 * it is made in one place, `classifyReadFailure`, rather than duplicated in
 * each loop.
 */
export type PollLoopOutcome =
  /** Shutdown requested. */
  | 'stopped'
  /** The search or fetch failed; the caller classifies the error. */
  | 'read-failed'
  /** The sink refused a message; the caller retries after a pause. */
  | 'delivery-failed';

export interface PollLoopResult {
  readonly outcome: PollLoopOutcome;
  readonly cursor: MailboxCursor;
  readonly error: unknown;
  /** Which command failed, for `read-failed`. */
  readonly phase: 'search' | 'fetch' | null;
  /** True when `read-failed` was an unreadable answer. See `MailboxDeltaReport`. */
  readonly unreadableFetch: boolean;
  /** How many drains ran, complete or not. */
  readonly passes: number;
  /**
   * How many of those drains completed.
   *
   * The caller resets its consecutive-failure counters on a completed drain,
   * and a poll loop that ran for six hours and then hit one bad fetch has
   * completed thousands. Without this the caller only ever sees the drain that
   * ended the loop, so hours of demonstrated progress would count for nothing
   * and a ceiling meant for CONSECUTIVE failures would accumulate across
   * unrelated days.
   */
  readonly completedDrains: number;
  /**
   * Messages the last drain delivered before the loop ended. A pass that
   * delivered some and then failed on one made progress, so the caller must
   * not count it as a stalled mailbox.
   */
  readonly delivered: number;
}

/**
 * Poll the mailbox until shutdown or until something the caller must act on.
 *
 * Runs when the server does not advertise IDLE, when IDLE is refused, and when
 * the owner asked for polling. It is not a lesser path: it finds exactly the
 * same messages by exactly the same search, just on a timer instead of on a
 * push, and a verification mail found within two minutes is found in time.
 *
 * The first drain happens IMMEDIATELY, before the first sleep. Whatever
 * arrived while the connection was down is already above the cursor, and
 * waiting out a poll interval before looking would add the interval to every
 * reconnect for no reason.
 */
export async function runPollLoop(deps: MailboxDeltaDeps): Promise<PollLoopResult> {
  let cursor = deps.cursor;
  let passes = 0;
  let completedDrains = 0;
  const stopped = (): PollLoopResult => ({
    outcome: 'stopped',
    cursor,
    error: null,
    phase: null,
    unreadableFetch: false,
    passes,
    completedDrains,
    delivered: 0,
  });
  for (;;) {
    if (deps.signal.aborted) return stopped();
    const report = await drainMailboxDelta({ ...deps, cursor, via: 'poll' });
    cursor = report.cursor;
    passes += 1;
    if (report.outcome === 'complete') completedDrains += 1;
    if (report.outcome === 'read-failed') {
      return {
        outcome: 'read-failed',
        cursor,
        error: report.error,
        phase: report.phase,
        unreadableFetch: report.unreadableFetch,
        passes,
        completedDrains,
        delivered: report.delivered,
      };
    }
    // A notice route that is down: the next pass retries on this same
    // connection after the poll interval; the sink sets the message aside
    // after a bounded number of attempts.
    if (report.outcome === 'delivery-failed' && !isConsumerUnavailable(report.error)) {
      return {
        outcome: 'delivery-failed',
        cursor,
        error: report.error,
        phase: null,
        unreadableFetch: false,
        passes,
        completedDrains,
        delivered: report.delivered,
      };
    }
    if (report.outcome === 'aborted' || deps.signal.aborted) return stopped();
    await deps.clock.sleep(deps.settings.pollIntervalMs, deps.signal);
  }
}
