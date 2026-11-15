/** UID progress pages. Seed planning and content consumption are separate reads. */
import type { ImapUidCheckpoint } from '../intake/provider-adapter.js';
import { captureImapCheckpoint } from '../intake/imap-checkpoint.js';
import type { EmailInboxBatchMessage } from './email-inbox-batch.js';
import { logger } from '../utils/logger.js';
import { withEmailReadConnection } from './email-read-connection.js';
import type { EmailConfig, EmailServiceDeps } from './email-service.js';
import type { EmailReplySubjectRead } from './reply-subject-source.js';

export interface EmailInboxPageInput {
  /** Only a durably committed checkpoint belongs here. Missing means plan only. */
  readonly checkpoint?: ImapUidCheckpoint | undefined;
  /** First seed keeps the newest page; later reads take the oldest pending page. */
  readonly limit?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * UIDs the caller has already seen fail to read on several polls in a row.
   * A failed read of one of these steps over it as `repeated-read-failure`
   * instead of ending the page, so no single message holds the mailbox.
   */
  readonly stepOver?: readonly number[] | undefined;
}

/** A message the page stepped over, with why and, when known, the claimed sender's domain. */
export interface EmailInboxSteppedOver {
  readonly uid: number;
  readonly reason: string;
  readonly senderDomain?: string;
}

export interface EmailInboxPageSelection {
  /**
   * UIDs this read searched: the whole mailbox when seeding or after a reset,
   * otherwise only those above the checkpoint.
   */
  readonly total: number;
  /** Eligible UIDs at this read, before the page limit; never a processed count. */
  readonly pending: number;
  /** Exact ascending page chosen from that search. Seed planning fetches none. */
  readonly selectedUids: readonly number[];
  readonly hasMore: boolean;
}

export type EmailInboxPageRead =
  | (EmailInboxPageSelection & {
    readonly outcome: 'checkpoint-required';
    readonly transition: 'seed' | 'reset';
    readonly previous: ImapUidCheckpoint | null;
    /** Persist this baseline before another read can consume its first message. */
    readonly next: ImapUidCheckpoint;
    readonly coveredUids: readonly [];
  })
  | (EmailInboxPageSelection & {
    readonly outcome: 'complete';
    readonly checkpoint: ImapUidCheckpoint;
    readonly messages: readonly EmailInboxBatchMessage[];
    /** Every covered UID has a complete source; screening still comes later. */
    readonly coveredUids: readonly number[];
    /**
     * Messages whose content this reader cannot prove complete (a signed or
     * report multipart, an unlisted charset, an oversize part). They are never
     * returned as messages or screened. They are listed so the owner can commit
     * them as suppressed (so the checkpoint moves past them) and show which UID
     * was left out and why; only present when there is one.
     */
    readonly unsupported?: readonly EmailInboxSteppedOver[];
  })
  /** `uid` names the message the read failed on, when it failed on one. */
  | { readonly outcome: 'incomplete'; readonly reason: string; readonly uid?: number };

const MAX_PAGE_SOURCE_BYTES = 4 * 1024 * 1024;
/**
 * How many messages (readable or not) one page examines. It matches the most
 * UIDs one checkpoint advance may cover, so a page of stepped-over messages can
 * always be committed and the next page starts past them.
 */
const MAX_EXAMINED_PER_PAGE = 50;
const isUid = (value: number): boolean => Number.isSafeInteger(value) && value >= 1 && value <= 0xffffffff;

export async function readEmailInboxPage(deps: EmailServiceDeps, config: EmailConfig,
  sourceRead: EmailReplySubjectRead, input: EmailInboxPageInput,
): Promise<EmailInboxPageRead> {
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Mail page limit must be from 1 through 50.');
  // Capture nested caller state synchronously, before credentials or transport.
  const checkpoint = input.checkpoint === undefined ? undefined : captureImapCheckpoint(input.checkpoint);
  return withEmailReadConnection(deps, config, sourceRead, input.signal, async (client, current) => {
    const validity = client.mailboxStatus?.uidValidity;
    if (validity === undefined || validity === null || !isUid(validity)) {
      return Object.freeze({ outcome: 'incomplete', reason: 'Mailbox identity is unavailable.' });
    }
    // Within a known mailbox generation only UIDs above the checkpoint are
    // asked for; the whole mailbox is listed once, to seed or after a reset.
    const known = checkpoint !== undefined && checkpoint.uidValidity === validity;
    const fromUid = known ? Math.max(checkpoint.history.lowerBoundUid, (checkpoint.lastTerminalUid ?? 0) + 1) : undefined;
    const uids = await client.searchCompleteUids(false, fromUid);
    current();
    if (!checkpoint || checkpoint.uidValidity !== validity) {
      const selectedUids = Object.freeze(uids.slice(-limit));
      const skippedOlderMessages = uids.length - selectedUids.length;
      const next: ImapUidCheckpoint = Object.freeze({ kind: 'imap-uid', uidValidity: validity, lastTerminalUid: null,
        history: Object.freeze(skippedOlderMessages === 0
          ? { kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 }
          : { kind: 'bounded-seed', lowerBoundUid: selectedUids[0]!, skippedOlderMessages }) });
      // This connection stops before UNSEEN/FETCH. Even a failed first body on
      // the next connection cannot move this already-persisted history fence.
      return Object.freeze({ outcome: 'checkpoint-required', transition: checkpoint ? 'reset' : 'seed',
        previous: checkpoint ?? null, next, total: uids.length, pending: selectedUids.length,
        selectedUids, coveredUids: Object.freeze([] as const), hasMore: false });
    }
    const pending = uids.filter(uid => uid >= checkpoint.history.lowerBoundUid
      && (checkpoint.lastTerminalUid === null || uid > checkpoint.lastTerminalUid));
    // The page is the oldest `limit` readable messages. A message whose own
    // bytes cannot be shown here is stepped over (never screened, reported so
    // the owner is told it exists), and a read that failed ends the page at
    // that message, keeping everything read before it.
    const unseen = pending.length === 0 ? new Set<number>() : new Set(await client.searchCompleteUids(true, fromUid));
    current();
    const stepOver = new Set(input.stepOver ?? []);
    const examined: number[] = [];
    const unsupported: EmailInboxSteppedOver[] = [];
    const readable: number[] = [];
    const messages: EmailInboxBatchMessage[] = [];
    let bytes = 0;
    let stoppedEarly = false;
    for (const uid of pending) {
      if (readable.length >= limit || examined.length >= MAX_EXAMINED_PER_PAGE) break;
      current();
      const source = await client.readCompleteMessageDetail(uid);
      current();
      if (source.outcome === 'incomplete' && (source.fromMessage || stepOver.has(uid))) {
        examined.push(uid);
        unsupported.push(Object.freeze({ uid, reason: source.fromMessage ? source.reason : 'repeated-read-failure',
          ...(source.fromMessage && source.senderDomain ? { senderDomain: source.senderDomain } : {}) }));
        continue;
      }
      if (source.outcome !== 'complete') {
        if (examined.length === 0) return Object.freeze({ outcome: 'incomplete', uid,
          reason: source.outcome === 'gone' ? 'Mailbox changed during the page read.' : source.reason });
        stoppedEarly = true;
        break;
      }
      let size = Buffer.byteLength(source.rawHeaders, 'utf8') + Buffer.byteLength(source.rawBodyStructure, 'utf8');
      for (const section of source.textSections) size += Buffer.byteLength(section.text, 'utf8');
      // One message is at most a quarter of the page budget, so the first always fits.
      if (bytes + size > MAX_PAGE_SOURCE_BYTES && readable.length > 0) { stoppedEarly = true; break; }
      bytes += size;
      examined.push(uid); readable.push(uid);
      messages.push(Object.freeze({ unread: unseen.has(uid), source }));
    }
    const selectedUids = Object.freeze(examined);
    current();
    // A stepped-over UID below the last covered one is passed by the checkpoint
    // and is no longer pending; one above it is still waiting for a later page.
    const lastCovered = readable.at(-1);
    const passed = lastCovered === undefined ? 0 : unsupported.filter(entry => entry.uid < lastCovered).length;
    for (const entry of unsupported) logger.warn('Inbox message stepped over: it cannot be read here', { uid: entry.uid, reason: entry.reason });
    return Object.freeze({ outcome: 'complete', checkpoint, messages: Object.freeze(messages),
      total: uids.length, pending: pending.length - passed, selectedUids, coveredUids: Object.freeze(readable),
      ...(unsupported.length > 0 ? { unsupported: Object.freeze(unsupported) } : {}),
      hasMore: stoppedEarly || pending.length > examined.length });
  });
}
