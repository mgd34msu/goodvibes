/**
 * record-store.ts, the durable inbound-mail record store (docs/decisions/2026-07-27-inbound-email-design.md §9.3).
 *
 * Every arriving message the watcher looks at is recorded here, structured
 * fields (sender, subject, delivery evidence, link verdicts, outcome, notice
 * status, receivedAt) plus a bounded body excerpt, so the owner can later ask
 * "why did I get that message" and so `email.inbound.status` has something to
 * disclose. This is NOT the turn-scoped untrusted-content ledger
 * (`platform/security/untrusted-content.ts`): recording here happens at
 * arrival, has no watermark, and never feeds `evaluateOutwardEffect`. See
 * docs/decisions/2026-07-27-inbound-email-design.md §5.1, arrival is not ingest.
 *
 * Follows the same five-rule shape as `platform/devices/device-grants.ts`:
 *  1. Reap on recovery, records past their retention window, or past the
 *     count cap, are dropped at load.
 *  2. Bound everything, BOTH `retentionDays` (age) and `maxRecords` (count)
 *     apply; whichever binds first wins. The body excerpt itself is capped at
 *     `MAX_BODY_EXCERPT_CHARS` so a single message cannot make the store an
 *     unbounded copy of the mailbox.
 *  3. Validate by content, every field is re-validated on load; a record
 *     failing any check is discarded, not repaired.
 *  4. Reap periodically, `sweep()` is safe to call on a timer, not only at boot.
 *  5. Disclose what was reaped, every sweep returns an itemised report.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, openSync, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { PersistentStore, type PersistentStoreCorruption } from '../../state/persistent-store.js';
import { openRecordLog, type RecordLog } from '../../state/record-log.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { findCardNumberShapes } from '../../security/card-shapes.js';
import {
  clampDeliveryAddress,
  clampLinkVerdicts,
  clampRecordScope,
  MAX_NOTICE_FAILURE_REASON_CHARS,
  MAX_SENDER_DISPLAY_CHARS,
  MAX_SUBJECT_CHARS,
  validateInboundMailRecord,
} from './record-validation.js';
import { withInboundStoreWriteLock } from './store-write-lock.js';
import { loadStoreForWrite } from './store-read.js';
import {
  MAX_BODY_EXCERPT_CHARS,
  type HousekeepingTrigger,
} from './types.js';
// Type-only, and erased at build time: this file names the refusal vocabulary
// rather than owning it, which is the point (§7.3).
import type { SurfaceNoticeRefusal } from '../../daemon/types.js';

// The validator, its field bounds and its write-time clamps live in
// record-validation.ts and are re-exported here so this module stays the one
// entry point every caller already imports.
export {
  clampDeliveryAddress,
  clampLinkVerdicts,
  clampRecordScope,
  INBOUND_MAIL_OUTCOMES,
  INBOUND_NOTICE_STATUSES,
  MAX_ACCOUNT_CHARS,
  MAX_DELIVERED_TO_CHARS,
  MAX_MAILBOX_CHARS,
  MAX_LINK_REASON_CHARS,
  MAX_LINK_VERDICTS,
  MAX_NOTICE_FAILURE_REASON_CHARS,
  MAX_SENDER_DISPLAY_CHARS,
  MAX_SUBJECT_CHARS,
  validateInboundMailRecord,
} from './record-validation.js';

/** Correlates to `VerificationMatch['kind']` in verification-expectations.ts, plus link-only outcomes that never reach expectation matching. */
export type InboundMailOutcome =
  | 'matched-expectation'
  | 'no-expectation'
  | 'recipient-mismatch'
  | 'expired-expectation'
  | 'ambiguous'
  | 'no-delivery-evidence';

/**
 * `delivered` / `suppressed` / `pending`, the three outcomes that never come
 * back from the transport, plus every reason `deliverSurfaceNotice` refuses
 * with, PROJECTED off `SurfaceNoticeRefusal` rather than restated (§7.3).
 *
 * It was restated, and it had already drifted: the hand-written list omitted
 * `empty-text` and `unsupported-delivery-surface`, both of which
 * `deliverSurfaceNotice` really does return. A notice refused for either of
 * them could not be recorded, `validateInboundMailRecord` would reject the
 * record on load and drop it, so the one case the owner most needs to see
 * ("mail arrived and could not be announced") was the case that vanished.
 * A projection cannot drift, because there is nothing to keep in sync.
 *
 * `pending` is the state a record is written in BEFORE the notice is attempted,
 * and it is what makes the ordering in `intake.ts` possible: the record is the
 * thing that can fail, so it goes first, and the notice, the one step nothing
 * can undo, goes after it. A record sitting at `pending` means exactly what it
 * says: the message was recorded and the notice for it has not resolved. It is
 * reached in two real situations, the transport is refusing with
 * `delivery-failed` and the message is being retried, or the daemon died
 * between the record and the send, and in both of them `pending` is the true
 * answer where `suppressed` or `delivered` would be a guess.
 */
export type InboundNoticeStatus = 'delivered' | 'suppressed' | 'pending' | SurfaceNoticeRefusal;

/** A link's registrable domain plus verdict only, never the raw URL the message assembled (§7). */
export interface InboundLinkVerdict {
  readonly registrableDomain: string;
  readonly verdict: 'allowed' | 'refused' | 'unresolved';
  /** Bounded at `MAX_LINK_REASON_CHARS`, sixty-four unbounded strings is an unbounded record. */
  readonly reason?: string | undefined;
}

/** Structured fields for one inbound message, plus a bounded body excerpt. */
/** Everything a record carries regardless of which source found the message. */
export interface InboundMailRecordCommon {
  readonly id: string;
  readonly account: string;
  readonly mailbox: string;
  /** Attacker-written `From:` text. Card shapes redacted and length-bounded at write time (§11.0). */
  readonly senderDisplay: string;
  /** Sanitized/truncated (§7): newlines and control characters removed before this is ever stored. Card shapes redacted (§11.0). */
  readonly subject: string;
  /** The alias the message landed at. Sender-chosen on a catch-all domain, so card shapes are redacted here too (§11.0). */
  readonly deliveredToAddress: string | null;
  readonly deliveryEvidenceSource: 'alias-mailbox' | 'delivered-to-header' | 'x-original-to-header' | 'none';
  readonly links: readonly InboundLinkVerdict[];
  readonly outcome: InboundMailOutcome;
  readonly noticeStatus: InboundNoticeStatus;
  readonly noticeFailureReason?: string | undefined;
  /** Bounded to MAX_BODY_EXCERPT_CHARS. Never rendered to the owner (§7), retained for the owner's own later inspection / debugging only. */
  readonly bodyExcerpt: string;
  readonly receivedAt: string;
}

/** A record of a message an IMAP source found. */
export interface ImapInboundMailRecord extends InboundMailRecordCommon {
  readonly source: 'imap';
  readonly uidValidity: number;
  readonly uid: number;
}

/** A record of a message a Gmail source found. */
export interface GmailInboundMailRecord extends InboundMailRecordCommon {
  readonly source: 'gmail';
  /** Gmail's opaque message resource id. Not a number, never coerced to one. */
  readonly resourceId: string;
  /**
   * The delta's high-water mark, a decimal uint64 STRING.
   *
   * Never parsed to a number. `18446744073709551615` does not survive a
   * round trip through a JS double, and a position that silently shifts is a
   * position that re-reads or skips history. `source-cursor.ts` already made
   * that impossible for the cursor; this is the same value in the same
   * shape, validated by the same predicate rather than a second copy of it.
   */
  readonly historyId: string;
}

/**
 * One stored record, discriminated on the source that found the message.
 *
 * A union rather than a widened record with optional `uid` / `historyId`, and
 * the reason is the defect this replaced: `validateInboundMailRecord` required
 * a positive `uidValidity` and `uid` unconditionally, so EVERY Gmail message
 * failed validation and was dropped, on the path automatic selection makes
 * the default once Google is adopted. Mail arrived, matched, was announced,
 * and nothing was ever written. §9.3's retention had nothing to retain,
 * §11.0's card redaction had nothing to redact, and `email.inbound.status`
 * truthfully reported zero records, which reads as "no mail" rather than
 * "cannot store mail".
 *
 * Same discriminant and same rule as `InboundSourceCursor`.
 */
export type InboundMailRecord = ImapInboundMailRecord | GmailInboundMailRecord;

/**
 * A record's identity as one readable string, for disclosure only.
 *
 * `imap:<uidValidity>:<uid>` / `gmail:<resourceId>`. Never a key and never
 * parsed back apart, a sweep report exists to tell the owner WHICH message
 * went, and a report that carried `uid: 0` for every Gmail record (which is
 * what an IMAP-shaped field would have to do) tells the owner nothing while
 * looking like it told them something.
 */
export function describeRecordIdentity(
  record: DistributivePick<InboundMailRecord, 'source' | 'uidValidity' | 'uid' | 'resourceId'>,
): string {
  return record.source === 'gmail'
    ? `gmail:${record.resourceId}`
    : `imap:${String(record.uidValidity)}:${String(record.uid)}`;
}

/**
 * `Pick` distributed across the union, for the same reason `DistributiveOmit`
 * exists below: a plain `Pick` over a union collapses to the SHARED keys, so
 * `uid`, `uidValidity` and `resourceId` would all vanish and the resulting
 * "key" would identify nothing.
 */
type DistributivePick<T, K extends PropertyKey> = T extends unknown
  ? Pick<T, Extract<K, keyof T>>
  : never;

/**
 * One message's natural key: the mailbox it landed in, plus the identity the
 * receiving server assigned it.
 *
 * Projected off `InboundMailRecord` rather than restated, so it cannot describe
 * a field the record does not have. This is the key `record()` upserts on and
 * `findByMessage()` looks up, deliberately NOT the record `id`, which is a
 * fresh UUID per write and therefore identifies a WRITE rather than a MESSAGE.
 *
 * Never the `Message-ID` header, for the reason `sink.ts` states at length: the
 * sender writes it, so two different messages can carry the same one, and a key
 * a sender can choose is a key a sender can collide with.
 */
export type InboundMailMessageKey = DistributivePick<
  InboundMailRecord,
  'source' | 'account' | 'mailbox' | 'uidValidity' | 'uid' | 'resourceId'
>;

/** A message key as one string, so "the record of this message" is a map lookup. */
function messageKeyOf(key: InboundMailMessageKey): string {
  return key.source === 'gmail'
    ? JSON.stringify(['gmail', key.account, key.mailbox, key.resourceId])
    : JSON.stringify(['imap', key.account, key.mailbox, key.uidValidity, key.uid]);
}

/** `file-unreadable` is the whole-file counterpart of `malformed`, see `CursorDiscardReason`. */
export type InboundMailDiscardReason = 'malformed' | 'file-unreadable' | 'expired' | 'over-cap';


export interface InboundMailDiscard {
  readonly id: string;
  readonly account: string;
  readonly mailbox: string;
  /** See `describeRecordIdentity`. Disclosure, not a key. */
  readonly messageRef: string;
  readonly reason: InboundMailDiscardReason;
  readonly removedAt: number;
  /** Present where the removal needs a sentence rather than a reason word. */
  readonly note?: string | undefined;
}

export interface InboundMailRecordSweepReport {
  readonly sweptAt: number;
  readonly removed: readonly InboundMailDiscard[];
  readonly retained: number;
}

export interface InboundMailRecordPolicy {
  /** Age bound. Records older than this are reaped regardless of count. */
  readonly retentionMs: number;
  /** Count bound. Oldest-by-receivedAt records past this are reaped regardless of age. */
  readonly maxRecords: number;
  /** Body excerpt cap. Clamped at construction to never exceed MAX_BODY_EXCERPT_CHARS. */
  readonly maxBodyExcerptChars: number;
}

/**
 * What write-time bounding has removed since this process started.
 *
 * §9 rule 5 is "disclose what was reaped", and applying the bounds on write
 * would otherwise delete records with nothing anywhere saying so, the sweep
 * report itemises what IT removed, and a record the write already dropped is a
 * record the sweep never sees. This is the counterpart disclosure.
 *
 * Deliberately in-memory and deliberately labelled `since`: it counts this
 * daemon's own writes, and a restart resets it. Persisting it would make the
 * tally a second store needing its own reaping and bounding, which is the
 * defect two lines up in this same file's history (see housekeeping.ts). A
 * count that says what window it covers is honest; a count that implies "ever"
 * would not be.
 */
export interface InboundMailWriteReapTally {
  /** Records a write dropped for being past `retentionMs`. */
  readonly expired: number;
  /** Records a write dropped for being past `maxRecords`. */
  readonly overCap: number;
  /** When this tally started counting, this store's construction. */
  readonly since: number;
}

export const DEFAULT_INBOUND_MAIL_RECORD_POLICY: InboundMailRecordPolicy = {
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maxRecords: 5000,
  maxBodyExcerptChars: MAX_BODY_EXCERPT_CHARS,
};

/** The whole-file store this one replaced. Read once, to bring its records into the log. */
interface InboundMailSnapshot extends Record<string, unknown> {
  readonly version: 1;
  readonly records: readonly InboundMailRecord[];
}

/**
 * One line of the record log: the record of one message as of that write
 * (`put`) and the ids that write bounded out (`drop`). `seq` rises with every
 * line, so compaction can tell a record's newest line from the ones it replaced.
 * `imported` marks that every record of the whole-file store is in the log, so
 * that file is never read into it a second time.
 */
interface InboundMailLogLine {
  readonly seq: number;
  readonly put?: unknown;
  readonly drop?: readonly string[] | undefined;
  readonly imported?: true | undefined;
}

/** What memory holds per record: everything but the body excerpt, which stays in the log until someone asks for it. */
type IndexedInboundMailRecord = DistributiveOmit<InboundMailRecord, 'bodyExcerpt'>;

/** Superseded lines a log may carry before a write compacts it (or as many as it has live records, when that is more). */
const COMPACT_SLACK_LINES = 256;

/** The id of the record a line carries, or '' for a line that carries none. */
function lineRecordId(line: InboundMailLogLine): string {
  const put = (line as { readonly put?: unknown } | null)?.put;
  if (put === null || typeof put !== 'object') return '';
  const id = (put as { readonly id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

export interface InboundMailStoreOptions {
  readonly policy?: Partial<InboundMailRecordPolicy> | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * `Omit` distributed across the union.
 *
 * A plain `Omit<InboundMailRecord, …>` on a union collapses to the keys the
 * variants SHARE, which would silently drop `uid`, `resourceId` and
 * `historyId` from the input type, every caller would then compile while
 * passing an identity the store cannot use. Distributing keeps each arm whole.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type InboundMailRecordInput =
  DistributiveOmit<InboundMailRecord, 'id' | 'bodyExcerpt'> & { readonly body: string };

/**
 * Durable inbound-mail record store, named to match `InboundMailContext`
 * (docs/decisions/2026-07-27-inbound-email-design.md §2.1), which carries it as `records`.
 *
 * The records live in a record log beside the path the store was given
 * (`<name>.log.jsonl`): a message is one appended line, whatever the log
 * already holds. Memory holds one small entry per record (no body excerpt) and
 * the message-key lookup, loaded once; a read is one `stat` to notice lines
 * another process appended.
 */
export class InboundMailStore {
  /** The whole-file store at the given path: its lock orders writers across processes, and its records are imported once. */
  private readonly legacy: PersistentStore<InboundMailSnapshot>;
  private readonly legacyPath: string | null;
  private readonly logPath: string | null;
  private log: RecordLog<InboundMailLogLine> | null = null;
  private opened = false;
  private readonly index = new Map<string, IndexedInboundMailRecord>();
  /** Message key to record id. */
  private readonly byMessage = new Map<string, string>();
  /** The `seq` of each record's newest line. */
  private readonly seqOf = new Map<string, number>();
  /** Body excerpts of a store that has no file. */
  private readonly memoryExcerpts = new Map<string, string>();
  private seq = 0;
  /** Log lines already folded into the index. */
  private consumed = 0;
  /** Lines in the log whose record did not validate. */
  private malformed = 0;
  /** Entries of the imported whole-file store that did not validate, until a sweep has reported them. */
  private importedMalformed = 0;
  /** The log carries the line that says the whole-file store was imported. */
  private importDone = false;
  /** Such lines in the log; compaction keeps them, so they are not superseded lines. */
  private importLines = 0;
  private readonly policy: InboundMailRecordPolicy;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();
  /** The last unreadable-file event, latched so status can name it. */
  private corruption: PersistentStoreCorruption | null = null;
  /** The same event until a sweep has itemised it. */
  private unreportedCorruption: PersistentStoreCorruption | null = null;
  private writeReapedExpired = 0;
  private writeReapedOverCap = 0;
  private readonly tallySince: number;

  constructor(storeOrPath: PersistentStore<InboundMailSnapshot> | string, options: InboundMailStoreOptions = {}) {
    this.legacy = typeof storeOrPath === 'string' ? new PersistentStore<InboundMailSnapshot>(storeOrPath) : storeOrPath;
    const lockPath = this.legacy.lockPath;
    this.legacyPath = lockPath === null ? null : lockPath.slice(0, -'.lock'.length);
    this.logPath = this.legacyPath === null ? null : `${this.legacyPath.replace(/\.json$/, '')}.log.jsonl`;
    const merged = { ...DEFAULT_INBOUND_MAIL_RECORD_POLICY, ...(options.policy ?? {}) };
    this.policy = { ...merged, maxBodyExcerptChars: Math.min(merged.maxBodyExcerptChars, MAX_BODY_EXCERPT_CHARS) };
    this.now = options.now ?? (() => Date.now());
    this.tallySince = this.now();
  }

  getPolicy(): InboundMailRecordPolicy {
    return this.policy;
  }

  /** What write-time bounding has removed since this store was constructed. See `InboundMailWriteReapTally`. */
  getWriteReapTally(): InboundMailWriteReapTally {
    return {
      expired: this.writeReapedExpired,
      overCap: this.writeReapedOverCap,
      since: this.tallySince,
    };
  }

  /** The unreadable-file event this store last saw, or null. See `MailboxCursorStore.getCorruption`. */
  getCorruption(): PersistentStoreCorruption | null {
    return this.corruption;
  }

  /**
   * Bring the index up to date. The first call opens the log, and brings in
   * the records of the whole-file store this one replaced; every later call is
   * one `stat`, and reads lines only when another process appended some.
   * `locked` says the caller already holds the cross-process write lock.
   */
  private async current(locked: boolean): Promise<void> {
    const logPath = this.logPath;
    if (logPath === null) return;
    if (!this.opened) {
      const open = async (): Promise<void> => {
        if (this.opened) return;
        const log = this.log ?? openRecordLog<InboundMailLogLine>(logPath, { fsync: 'batch', key: lineRecordId });
        this.log = log;
        log.refresh();
        this.rebuild(log);
        // Only the holder of the write lock imports, so two processes starting together import once.
        await this.importWholeFileStore(log);
        this.opened = true;
      };
      await (locked ? open() : withInboundStoreWriteLock(this.legacy.lockPath, open));
      return;
    }
    const log = this.log;
    if (log === null) return;
    const found = log.refresh();
    if (found === 0) return;
    if (log.size === this.consumed + found) {
      for (const line of log.scan(this.consumed)) this.fold(line);
      this.consumed = log.size;
    } else {
      // Another process compacted the log: its lines were renumbered.
      this.rebuild(log);
    }
  }

  /**
   * Bring the records of the whole-file store this one replaced into the log,
   * once: every valid record is appended, then the `imported` line, and only
   * once both are on disk is the file removed, so the log is the one copy.
   *
   * Safe to run again at any point. Until the `imported` line is in the log the
   * import has not happened as far as any open is concerned, so a crash part way
   * through appends the same records again under the same ids at the next open,
   * which fold into the same entries (nothing else writes before an import
   * finishes: every write opens the store first). Once the line is there the
   * file is never read again, only removed if it is still present.
   *
   * A file that cannot be read refuses the open with the file untouched
   * (store-read.ts). One that does not parse is reported; it is removed only
   * when `PersistentStore` kept a copy of it, the copy the report names.
   */
  private async importWholeFileStore(log: RecordLog<InboundMailLogLine>): Promise<void> {
    const legacyPath = this.legacyPath;
    if (legacyPath === null) return;
    if (!this.importDone) {
      const { data, corruption } = await loadStoreForWrite(this.legacy);
      if (corruption !== null) {
        this.corruption = corruption;
        this.unreportedCorruption = corruption;
        // Without a kept copy the unreadable file is the only evidence; it stays, and the next open tries again.
        if (corruption.quarantinedTo === undefined) return;
      } else if (data === null) {
        return; // No whole-file store: nothing to import.
      }
      const entries: readonly unknown[] = data !== null && Array.isArray(data.records) ? data.records : [];
      for (const entry of entries) {
        const record = validateInboundMailRecord(entry);
        if (record === null) {
          this.importedMalformed += 1;
          continue;
        }
        this.seq += 1;
        log.append({ seq: this.seq, put: record });
      }
      this.seq += 1;
      log.append({ seq: this.seq, imported: true });
      await log.flush();
      for (const line of log.scan(this.consumed)) this.fold(line);
      this.consumed = log.size;
    } else if (!existsSync(legacyPath)) {
      return;
    }
    try {
      // The log file's own directory entry must be on disk before the only other copy goes.
      syncDirectory(dirname(legacyPath));
      await fs.rm(legacyPath, { force: true });
    } catch (error) {
      // The records are in the log; every later open finds the `imported` line and only retries this removal.
      logger.warn('[inbound-mail] the imported record file could not be removed', { path: legacyPath, error: summarizeError(error) });
    }
  }

  private rebuild(log: RecordLog<InboundMailLogLine>): void {
    this.index.clear();
    this.byMessage.clear();
    this.seqOf.clear();
    this.malformed = 0;
    this.importLines = 0;
    for (const line of log.scan(0)) this.fold(line);
    this.consumed = log.size;
  }

  private fold(line: InboundMailLogLine): void {
    if (line === null || typeof line !== 'object') return;
    const seq = typeof line.seq === 'number' && Number.isFinite(line.seq) ? line.seq : 0;
    if (seq > this.seq) this.seq = seq;
    if (line.imported === true) {
      this.importDone = true;
      this.importLines += 1;
    }
    if (line.put !== undefined) {
      const record = validateInboundMailRecord(line.put);
      if (record === null) this.malformed += 1;
      else this.place(record, seq);
    }
    if (Array.isArray(line.drop)) {
      for (const id of line.drop as readonly unknown[]) if (typeof id === 'string') this.remove(id);
    }
  }

  private place(record: InboundMailRecord, seq: number): void {
    const { bodyExcerpt, ...rest } = record;
    const indexed = rest as IndexedInboundMailRecord;
    const previous = this.index.get(indexed.id);
    if (previous !== undefined) this.byMessage.delete(messageKeyOf(previous));
    this.index.set(indexed.id, indexed);
    this.byMessage.set(messageKeyOf(indexed), indexed.id);
    this.seqOf.set(indexed.id, seq);
    if (this.logPath === null) this.memoryExcerpts.set(indexed.id, bodyExcerpt);
  }

  private remove(id: string): void {
    const indexed = this.index.get(id);
    if (indexed === undefined) return;
    const key = messageKeyOf(indexed);
    if (this.byMessage.get(key) === id) this.byMessage.delete(key);
    this.index.delete(id);
    this.seqOf.delete(id);
    this.memoryExcerpts.delete(id);
  }

  /** The whole record, its body excerpt read from the log (one positioned read). */
  private full(indexed: IndexedInboundMailRecord): InboundMailRecord {
    if (this.log === null) {
      return { ...indexed, bodyExcerpt: this.memoryExcerpts.get(indexed.id) ?? '' } as InboundMailRecord;
    }
    return validateInboundMailRecord(this.log.get(indexed.id)?.put)
      ?? ({ ...indexed, bodyExcerpt: '' } as InboundMailRecord);
  }

  /**
   * Run one change as the only writer. The index is brought current, `change`
   * decides, and what it decided is ONE appended line; nothing already in the
   * log is rewritten. The log is compacted only once its superseded lines
   * outnumber its live records (or at a sweep, when it has any).
   */
  private async mutate<T>(
    change: () => {
      readonly put?: InboundMailRecord | undefined;
      readonly drop: readonly string[];
      readonly compactNow?: boolean | undefined;
      readonly result: T;
    },
  ): Promise<T> {
    // The chain orders writers inside THIS process; the lock orders them
    // across processes. Both, because neither alone is "one writer at a time"
    //, see store-write-lock.ts for why a second daemon is reachable here.
    const run = this.writeChain.then(async () => withInboundStoreWriteLock(this.legacy.lockPath, async () => {
      await this.current(true);
      const { put, drop, compactNow, result } = change();
      const log = this.log;
      if (put !== undefined || drop.length > 0) {
        const seq = this.seq + 1;
        if (log !== null) {
          log.append({ seq, ...(put !== undefined ? { put } : {}), ...(drop.length > 0 ? { drop } : {}) });
          this.consumed = log.size;
        }
        this.seq = seq;
        if (put !== undefined) this.place(put, seq);
        for (const id of drop) this.remove(id);
        // The write is acknowledged only once it is on disk.
        if (log !== null) await log.flush();
      }
      if (log !== null) {
        const superseded = log.size - this.index.size - this.importLines;
        if (compactNow === true ? superseded > 0 : superseded > Math.max(COMPACT_SLACK_LINES, this.index.size)) {
          await log.compact((line) => {
            // The import line stays: it is what keeps a whole-file store from being read in twice.
            if (line.imported === true) return true;
            const id = lineRecordId(line);
            return id !== '' && this.seqOf.get(id) === line.seq;
          });
          this.consumed = log.size;
          this.malformed = 0;
        }
      }
      return result;
    }));
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * WHAT THE STORE HOLDS, not what a read is willing to serve.
   *
   * `list()` filters by age and by count, so a caller counting its result was
   * counting a VIEW. `stored` counts every record the log holds, the ones that
   * do not validate included: they occupy the file. `live` is what a read
   * serves. Both are returned because the GAP between them is itself the fact
   * worth disclosing, records past their window that no write or sweep has
   * reached yet.
   */
  async count(): Promise<{ readonly stored: number; readonly live: number }> {
    await this.current(false);
    const cutoff = this.now() - this.policy.retentionMs;
    let live = 0;
    for (const record of this.index.values()) if (Date.parse(record.receivedAt) >= cutoff) live += 1;
    return { stored: this.index.size + this.malformed, live: Math.min(live, this.policy.maxRecords) };
  }

  /**
   * Apply BOTH policy bounds to the set a write would leave.
   *
   * The bounds hold on every write, not only at the six-hourly sweep. Age
   * first, then count, so the reason a record went is the bound that actually
   * bound first, the same order and the same precedence `sweep()` uses,
   * because two orders would mean two answers to "why is this gone".
   */
  private applyBounds<R extends { readonly receivedAt: string }>(
    records: readonly R[],
    now: number,
  ): { kept: R[]; expired: number; overCap: number } {
    const cutoff = now - this.policy.retentionMs;
    // Each time parsed once: this runs on every write over the whole set.
    const withinAge = records.map((record) => ({ record, at: Date.parse(record.receivedAt) })).filter((entry) => entry.at >= cutoff);
    const expired = records.length - withinAge.length;
    if (withinAge.length <= this.policy.maxRecords) {
      return { kept: withinAge.map((entry) => entry.record), expired, overCap: 0 };
    }
    // Oldest-first, drop from the front: the same "oldest by receivedAt goes
    // first" rule `sweep()` applies.
    const oldestFirst = withinAge.sort((x, y) => x.at - y.at);
    const overCap = oldestFirst.length - this.policy.maxRecords;
    return { kept: oldestFirst.slice(overCap).map((entry) => entry.record), expired, overCap };
  }

  /**
   * Live, content-validated records, newest first. Read-time filter for age
   * and count (does not persist the drop, `sweep()` does that), so a read
   * between sweeps never serves a record past either bound. Pass `limit` when
   * only the newest few are wanted: each record returned is one read of its line.
   */
  async list(input?: { readonly account?: string | undefined; readonly limit?: number | undefined }): Promise<readonly InboundMailRecord[]> {
    await this.current(false);
    const cutoff = this.now() - this.policy.retentionMs;
    const live = [...this.index.values()]
      .filter((r) => Date.parse(r.receivedAt) >= cutoff)
      .filter((r) => !input?.account || r.account === input.account)
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const bounded = live.slice(0, this.policy.maxRecords);
    return (input?.limit ? bounded.slice(0, input.limit) : bounded).map((indexed) => this.full(indexed));
  }

  async get(id: string): Promise<InboundMailRecord | null> {
    await this.current(false);
    const indexed = this.index.get(id);
    return indexed === undefined ? null : this.full(indexed);
  }

  /**
   * The record of ONE message, by the identity the receiving server assigned.
   *
   * This is the store's answer to "have I already dealt with this message, and
   * what happened to it", a question the in-memory dedup cache cannot answer
   * across a restart, because it is a `Map` in a process that just died. The
   * intake asks it before announcing, so a message redelivered because the
   * cursor had not advanced when the daemon restarted is not announced to the
   * owner a second time (§6). It is a map lookup.
   *
   * Bounded by the same age filter `list()` applies: a record past the
   * retention window is not a live fact about this message, and answering with
   * one would let a 30-day-old row suppress a notice.
   *
   * Note the consequence of write-time bounding, stated rather than left to be
   * discovered: a record written already past `retentionMs` is bounded out by
   * the same write that made it, so this answers `null` for it. That is the
   * policy working, a record too old to keep is too old to have kept, not an
   * inconsistency between two methods.
   */
  async findByMessage(key: InboundMailMessageKey): Promise<InboundMailRecord | null> {
    await this.current(false);
    const cutoff = this.now() - this.policy.retentionMs;
    // Same clamp the write applied, so a long account is one string on both
    // sides of the comparison rather than two.
    const id = this.byMessage.get(messageKeyOf({ ...key, ...clampRecordScope(key) }));
    const indexed = id === undefined ? undefined : this.index.get(id);
    return indexed !== undefined && Date.parse(indexed.receivedAt) >= cutoff ? this.full(indexed) : null;
  }

  /**
   * Record one inbound message. Its text fields arrive redacted of card shapes
   * by the intake, over the WHOLE body before any cut; the store bounds them.
   *
   * ONE MESSAGE, ONE RECORD. A write whose message key already exists replaces
   * that row in place and keeps its `id`; it does not append a second row. That
   * is not tidiness, it is what makes the intake's ordering safe to retry: the
   * record now goes in BEFORE the notice, in a `pending` state, and every
   * retried pass, a `delivery-failed` transport, a daemon restarted mid-pass,
   * writes the same message again. Appending would turn each retry into another
   * row, and `email.inbound.status` would report five arrivals for one message
   * while the owner's phone had buzzed once. The `id` is kept so a reference
   * taken from an earlier read still resolves through `get()`.
   */
  async record(input: InboundMailRecordInput): Promise<InboundMailRecord> {
    // The identity travels as a unit, chosen by the input's own source, so a
    // new source cannot be half-copied into a record.
    const identity = input.source === 'gmail'
      ? { source: 'gmail' as const, resourceId: input.resourceId, historyId: input.historyId }
      : { source: 'imap' as const, uidValidity: input.uidValidity, uid: input.uid };
    const entry: InboundMailRecord = {
      ...identity,
      id: randomUUID(),
      // Clamped, like every other persisted string. These two were bounded on
      // the load path and nowhere on the write path, so an oversized one was
      // written in full and then discarded whole on the next load, see
      // `clampRecordScope`, which `findByMessage` applies to its key for the
      // same reason.
      ...clampRecordScope(input),
      // Sender, subject and delivery address arrive already redacted by the
      // intake (card numbers, and short codes labelled as card details),
      // the same text the owner's notice shows. The store still masks card
      // numbers itself, a local pattern pass with no model, so no caller can
      // put one on disk; then it bounds them.
      senderDisplay: maskCardNumbers(input.senderDisplay).slice(0, MAX_SENDER_DISPLAY_CHARS),
      // The subject is persisted alongside the excerpt AND rendered to the
      // owner in the notice, so it is the same exposure by a different field.
      // Re-clamped after redacting because a marker is longer than the digits
      // it replaces, and a subject over 998 chars fails validation on load,
      // taking the whole record with it.
      subject: maskCardNumbers(input.subject).slice(0, MAX_SUBJECT_CHARS),
      // Sender-chosen too, on the catch-all domain the aliases live on (§7.1):
      // the local part is whatever the message was addressed to, so a PAN can
      // arrive as the alias itself. Clamped by `clampDeliveryAddress` rather
      // than a plain slice, see there for why this one field cannot use the
      // subject's re-clamp.
      deliveredToAddress: input.deliveredToAddress === null
        ? null
        : clampDeliveryAddress(maskCardNumbers(input.deliveredToAddress)),
      deliveryEvidenceSource: input.deliveryEvidenceSource,
      // Clamped, not trusted: `reason` is bounded per entry and the array is
      // bounded by count, because sixty-four unbounded strings is an unbounded
      // record. Clamping at write rather than rejecting at load is the same
      // choice the subject and the delivery address make, an oversized field
      // must not take the whole message down with it on the next load.
      links: clampLinkVerdicts(input.links),
      outcome: input.outcome,
      noticeStatus: input.noticeStatus,
      // The one field on this record whose text a REMOTE SERVER wrote:
      // `intake.ts` fills it from `delivery.error`, the notice transport's own
      // refusal body. Bounded here so a chatty push service cannot make one
      // record arbitrarily large inside a store that believes `maxRecords`
      // bounds it.
      ...(input.noticeFailureReason
        ? { noticeFailureReason: input.noticeFailureReason.slice(0, MAX_NOTICE_FAILURE_REASON_CHARS) }
        : {}),
      // The intake redacted the whole body before handing it here (one local
      // scan, see `redactInboundFields`). Card numbers are masked
      // over the whole body before the cut and again after it, because a cut
      // can turn a longer digit run into one: local pattern passes, no model.
      bodyExcerpt: maskCardNumbers(maskCardNumbers(input.body).slice(0, this.policy.maxBodyExcerptChars)),
      receivedAt: input.receivedAt,
    };
    return this.mutate(() => {
      // Matched on the CLAMPED scope, the same one `entry` was built with:
      // comparing a stored (clamped) account against an unclamped input is how
      // a retry stops recognising its own earlier row.
      const existingId = this.byMessage.get(messageKeyOf({ ...input, ...clampRecordScope(input) }));
      const stored: InboundMailRecord = existingId === undefined ? entry : { ...entry, id: existingId };
      // BOUNDS ON THE WRITE, not only on the sweep, so the store itself is
      // bounded; the sweep stays because it also itemises, drops lines that do
      // not validate, and compacts the log.
      const candidates: { readonly id: string; readonly receivedAt: string }[] = [];
      for (const record of this.index.values()) if (record.id !== stored.id) candidates.push(record);
      candidates.push(stored);
      const { kept, expired, overCap } = this.applyBounds(candidates, this.now());
      this.writeReapedExpired += expired;
      this.writeReapedOverCap += overCap;
      if (expired + overCap === 0) return { put: stored, drop: [], result: stored };
      const keptIds = new Set(kept.map((record) => record.id));
      const keepsStored = keptIds.has(stored.id);
      // A write already past a bound leaves no record; an earlier record of the same message goes with it.
      const drop = candidates
        .filter((record) => !keptIds.has(record.id) && (record.id !== stored.id || existingId !== undefined))
        .map((record) => record.id);
      return { ...(keepsStored ? { put: stored } : {}), drop, result: stored };
    });
  }

  /**
   * One housekeeping pass: drop records that do not validate, drop records
   * past the age bound, and enforce the count bound (oldest by `receivedAt`
   * first). Whichever bound removes a record first is the reason recorded.
   * The log is compacted here, so superseded lines do not outlive a sweep.
   */
  async sweep(trigger: HousekeepingTrigger = 'manual'): Promise<InboundMailRecordSweepReport> {
    void trigger;
    const now = this.now();
    const cutoff = now - this.policy.retentionMs;
    return this.mutate(() => {
      const removed: InboundMailDiscard[] = [];
      const corrupt = this.unreportedCorruption;
      this.unreportedCorruption = null;
      if (corrupt !== null) {
        removed.push({
          id: '(unreadable)',
          account: '(unknown)',
          mailbox: '(unknown)',
          messageRef: '(unreadable)',
          reason: 'file-unreadable',
          removedAt: now,
          note: `the inbound record file could not be read (${corrupt.detail}), so its `
            + 'contents were discarded',
        });
      }
      if (this.malformed + this.importedMalformed > 0) {
        removed.push({ id: '(unreadable)', account: '(unknown)', mailbox: '(unknown)', messageRef: '(unreadable)', reason: 'malformed', removedAt: now });
      }
      this.importedMalformed = 0;

      const withinAge: IndexedInboundMailRecord[] = [];
      const drop: string[] = [];
      for (const record of this.index.values()) {
        if (Date.parse(record.receivedAt) < cutoff) {
          removed.push({ id: record.id, account: record.account, mailbox: record.mailbox, messageRef: describeRecordIdentity(record), reason: 'expired', removedAt: now });
          drop.push(record.id);
          continue;
        }
        withinAge.push(record);
      }

      const sorted = withinAge.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
      const overflow = sorted.length - this.policy.maxRecords;
      let retained = 0;
      for (let index = 0; index < sorted.length; index += 1) {
        const record = sorted[index];
        if (!record) continue;
        if (index < overflow) {
          removed.push({ id: record.id, account: record.account, mailbox: record.mailbox, messageRef: describeRecordIdentity(record), reason: 'over-cap', removedAt: now });
          drop.push(record.id);
          continue;
        }
        retained += 1;
      }

      return { drop, compactNow: true, result: { sweptAt: now, removed, retained } satisfies InboundMailRecordSweepReport };
    });
  }

  async runRecoverySweep(): Promise<InboundMailRecordSweepReport> {
    return this.sweep('recovery');
  }
}

/** Make the entries of a directory durable (a file created or removed in it). */
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Replace each card-number shape with the marker `redactCardShapes` uses. Local, no model. */
function maskCardNumbers(text: string): string {
  const findings = findCardNumberShapes(text);
  let result = text;
  for (let index = findings.length - 1; index >= 0; index -= 1) {
    const finding = findings[index]!;
    result = `${result.slice(0, finding.startIndex)}[redacted:pan]${result.slice(finding.startIndex + finding.length)}`;
  }
  return result;
}
