// ---------------------------------------------------------------------------
// Persistent cursor + item store for the inbound feed.
//
// Backed by HandlerSqliteStore (a SQLite file in WAL mode) at
//   {wd}/.goodvibes/tui/operator/<file>.sqlite
//
// Tables:
//   items(id PK, provider, kind, fromDigest, subjectPreview, bodyPreview,
//         routeId, receivedAt INT, unread INT, triage_revision TEXT, seq INT)
//   cursors(provider PK, nextSince INT)        one row per provider, or per
//                                              conversation as `provider:conversation`
//   imap_checkpoints(provider PK, checkpoint TEXT)
//   triage_receipts(id PK, revision, status, label, score, tags, receipt, battery)
//                                              triage labels beside their rows;
//                                              a label shows only for the current
//                                              battery (`name@version`)
//   inbox_source_revision_policy, inbox_retention_policy  format and policy versions
//
// One write path: the poller commits rows and their progress together through
// commitTimestampPoll (Slack, Discord) or commitImapPoll (mail). Dedup is by
// items.id. `receivedAt` is the provider's own time for every provider; `seq` is
// assigned by this store when a row is written or changes, so "new since" is
// "committed after", the only order a store fed by several pollers can promise.
//
// RETENTION. The items table is bounded by BOTH an age TTL and a count cap, and
// the sweep runs at init(), the recovery point, right after the database file
// is opened, and then on a timer for the life of the store, so a daemon that
// stays up for weeks keeps reclaiming. `pruneOlderThan` used to exist with no
// production caller at all, which meant the table grew without bound in
// practice. Reclaimed counts are handed to the `onSweep` hook (counts only,
// message previews and sender ids never reach a log line).
//
// Cursors are deliberately NOT reaped. Timestamp watermarks are monotonic;
// IMAP checkpoints retain their explicit generation and history baseline.
// Only an explicit UIDVALIDITY reset can replace an IMAP generation.
//
// Idempotence/concurrency: a sweep re-run immediately reclaims nothing (the
// DELETEs are set-based over the current contents). Every write is a statement
// or one transaction on the file, durable when it returns; two processes on the
// same file share it under SQLite's own locking.
// ---------------------------------------------------------------------------

import { HandlerSqliteStore, type HandlerSqliteTransaction } from '../state/daemon-handler-sqlite-store.js';
import type { ImapUidCheckpoint, ImapUidCheckpointAdvance, InboundChannelItem } from './provider-adapter.js';
import { captureTriageReceiptScope } from './triage/evidence.js';
import type { TriageLabel, TriageReceiptScope } from './triage/types.js';
import { INBOX_TRIAGE_BATTERY } from './triage/battery.js';
import { retainActiveInboxStore } from './active-stores.js';
import { captureImapAdvance, captureImapCheckpoint, captureImapItems, sameImapCheckpoint } from './imap-checkpoint.js';

/**
 * Age TTL for feed items: rows whose receivedAt is older than this are dropped
 * on every sweep. Long enough that "what did that person say last month" still
 * works, short enough that the table cannot grow indefinitely.
 */
export const INBOX_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Count cap for feed items: the newest this many rows survive a sweep, older
 * ones are dropped. Guards the case the TTL cannot, a very chatty month.
 */
export const INBOX_ITEM_CAP = 5_000;

/**
 * Cadence of the background retention sweep. The first sweep happens at init();
 * this timer is what keeps it from being a startup-only reap.
 */
export const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const DEFAULT_STORE_FILE_NAME = 'inbox.sqlite';

/** Result of one retention sweep. Counts only, never item content. */
export interface InboxSweepSummary {
  /** Unix ms of the sweep. */
  readonly at: number;
  /** Rows removed by the age TTL. */
  readonly expired: number;
  /** Rows removed by the count cap. */
  readonly capped: number;
  /** Rows left in the items table afterwards. */
  readonly remaining: number;
}

export interface InboxCursorStoreOptions {
  /** Original native writer floor before publishing message source revisions. */
  readonly beforeSourceRevisionWrite?: (() => void) | undefined;
  /** Original constructor-owned account domain, never inferred from message fields. */
  readonly triageScope?: TriageReceiptScope | undefined;
  /** Override the age TTL (tests / embedders). Defaults to INBOX_ITEM_TTL_MS. */
  readonly itemTtlMs?: number;
  /** Override the count cap (tests / embedders). Defaults to INBOX_ITEM_CAP. */
  readonly itemCap?: number;
  /** Sweep cadence; 0 or less disables the timer (the init sweep still runs). */
  readonly sweepIntervalMs?: number;
  /** Called after a sweep that reclaimed at least one row. Counts only. */
  readonly onSweep?: (summary: InboxSweepSummary) => void;
  /** Called when a sweep failed, so retention problems are visible rather than swallowed. */
  readonly onSweepError?: (message: string) => void;
  /** Clock seam (tests). Defaults to Date.now. */
  readonly now?: () => number;
  /** Timer seams (tests). Default to the globals. */
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

/** Versioned local policy, independent of account/source authority. */
export interface InboxRetentionPolicy { readonly itemTtlMs: number; readonly itemCap: number }
export function isInboxRetentionPolicy(value: unknown): value is InboxRetentionPolicy {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row['itemTtlMs'] === 'number' && Number.isSafeInteger(row['itemTtlMs']) && row['itemTtlMs'] >= 0
    && typeof row['itemCap'] === 'number' && Number.isSafeInteger(row['itemCap']) && row['itemCap'] >= 0;
}
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS inbox_source_revision_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_retention_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, itemTtlMs INTEGER NOT NULL, itemCap INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS imap_checkpoints (
     provider TEXT PRIMARY KEY, checkpoint TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     kind TEXT NOT NULL,
     fromDigest TEXT NOT NULL,
     subjectPreview TEXT NOT NULL,
     bodyPreview TEXT NOT NULL,
     routeId TEXT,
     receivedAt INTEGER NOT NULL,
     unread INTEGER NOT NULL,
     triage_revision TEXT,
     seq INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_provider_received
     ON items(provider, receivedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_items_received
     ON items(receivedAt)`,
  `CREATE TABLE IF NOT EXISTS cursors (
     provider TEXT PRIMARY KEY,
     nextSince INTEGER NOT NULL
   )`,
  // One receipt per row: the label scored for the row's content revision, and
  // the full receipt (model attribution, readings) for anyone who asks why.
  `CREATE TABLE IF NOT EXISTS triage_receipts (
     id TEXT PRIMARY KEY,
     revision TEXT NOT NULL,
     status TEXT NOT NULL,
     label TEXT,
     score REAL,
     tags TEXT,
     receipt TEXT NOT NULL,
     battery TEXT
   )`,
];

interface ItemRow {
  id: string;
  provider: string;
  kind: string;
  fromDigest: string;
  subjectPreview: string;
  bodyPreview: string;
  routeId: string | null;
  receivedAt: number;
  unread: number;
  triageLabel?: string | null;
  triageScore?: number | null;
  triageTags?: string | null;
}

/**
 * A position in the feed's total order (receivedAt DESC, id ASC). Paging is
 * keyset rather than OFFSET because the feed is written to while it is being
 * read: an OFFSET page re-anchors on every insert, so a caller walking pages
 * while a poll lands would see items twice and skip others. A key resumes from
 * a row, not from a count, so an insert above the cursor cannot shift it.
 */
export interface InboxPosition {
  readonly receivedAt: number;
  readonly id: string;
}

export interface InboxQuery {
  providers?: readonly string[];
  since?: number;
  /** Resume strictly AFTER this position in the feed order. */
  after?: InboxPosition;
  /** Max items returned across the whole query. */
  limit: number;
}

/** One receipt to store beside its row, scored against the row revision it names. */
export interface InboxTriageReceiptRow {
  readonly id: string;
  /** The row's `triage_revision` when it was read for scoring. */
  readonly revision: string;
  readonly status: 'settled' | 'held' | 'unavailable';
  readonly label?: TriageLabel;
  readonly score?: number;
  readonly tags?: readonly string[];
  /** The full receipt (attribution and readings), stored as written. */
  readonly receipt: string;
  /** `name@version` of the battery that scored it; another version's label is history. */
  readonly battery: string;
}

/** A row waiting for triage, with the revision its receipt must name. */
export interface InboxTriageCandidate { readonly item: InboundChannelItem; readonly revision: string }

export class InboxCursorStore {
  private readonly store: HandlerSqliteStore;
  private initialized = false;
  private sourceRevisionsReady = false;
  private initializing: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly flushing = new Set<Promise<void>>();
  private readonly sweeping = new Set<Promise<void>>();
  private readonly itemTtlMs: number;
  private readonly itemCap: number;
  private readonly sweepIntervalMs: number;
  private readonly onSweep: ((summary: InboxSweepSummary) => void) | undefined;
  private readonly onSweepError: ((message: string) => void) | undefined;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Set by close(). `init()` is async and arms the retention timer only after
   * two awaits, so a surface that is torn down while its bootstrap is still in
   * flight would otherwise arm a timer AFTER the only thing that could clear it
   * had already run. That is not hypothetical: registerInboxMethods() kicks
   * init() off without awaiting it, so any shutdown inside the first tick of a
   * daemon's life hits exactly this window.
   */
  private closed = false;
  private readonly releaseStorage: () => void;
  /** The account this mirror belongs to, stamped on the triage receipts it holds. */
  readonly triageScope: TriageReceiptScope | undefined;

  constructor(
    workingDirectory: string,
    fileName: string = DEFAULT_STORE_FILE_NAME,
    options: InboxCursorStoreOptions = {},
  ) {
    this.triageScope = captureTriageReceiptScope(options.triageScope);
    const policy = { itemTtlMs: options.itemTtlMs ?? INBOX_ITEM_TTL_MS, itemCap: options.itemCap ?? INBOX_ITEM_CAP };
    if (!isInboxRetentionPolicy(policy)) throw new Error('Inbox retention requires nonnegative safe-integer TTL and item cap');
    this.store = new HandlerSqliteStore({
      workingDirectory,
      fileName: fileName || DEFAULT_STORE_FILE_NAME,
      schema: SCHEMA,
      beforeWrite: options.beforeSourceRevisionWrite,
    });
    this.itemTtlMs = policy.itemTtlMs;
    this.itemCap = policy.itemCap;
    this.sweepIntervalMs = options.sweepIntervalMs ?? INBOX_SWEEP_INTERVAL_MS;
    this.onSweep = options.onSweep;
    this.onSweepError = options.onSweepError;
    this.now = options.now ?? Date.now;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
    this.releaseStorage = retainActiveInboxStore(this.store.dbPath);
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  /** Set when the store file was unreadable at open and a fresh one started: what happened and where the old file is. */
  recoveryNotice(): string | undefined {
    return this.store.recoveryNotice();
  }

  /**
   * Open the database, then immediately reap: recovery is exactly when stale
   * rows from previous runs must go. The periodic timer starts afterwards so
   * retention is not a startup-only event.
   */
  init(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('InboxCursorStore is closed.'));
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const pending = (async () => {
      await this.store.init();
      if (this.closed) return;
      const sourcePolicy = this.store.get<{ version: number }>('SELECT version FROM inbox_source_revision_policy WHERE singleton = 1');
      if (sourcePolicy && sourcePolicy.version !== 1) throw new Error('Inbox source revisions are unsupported');
      // HandlerSqliteStore.beforeWrite declares the source-revision reader
      // floor before every mirror transaction commits; this schema setup is
      // not a mirror mutation and does not declare it.
      const columns = this.store.all<{ name: string }>('PRAGMA table_info(items)');
      if (!columns.some(column => column.name === 'triage_revision')) {
        if (sourcePolicy) throw new Error('Inbox source revision schema is unsupported');
        this.store.run('ALTER TABLE items ADD COLUMN triage_revision TEXT');
      }
      if (!sourcePolicy) {
        // An existing column alone does not prove that its writer updated it
        // with semantic mutations. Reissue only derived revisions, never body data.
        this.store.run('UPDATE items SET triage_revision = NULL');
        this.store.run('INSERT INTO inbox_source_revision_policy (singleton, version) VALUES (1, 1)');
      }
      if (!columns.some(column => column.name === 'seq')) {
        // Rows written before the store assigned sequences take their insertion order.
        this.store.run('ALTER TABLE items ADD COLUMN seq INTEGER');
        this.store.run('UPDATE items SET seq = rowid');
      }
      this.store.run('CREATE INDEX IF NOT EXISTS idx_items_seq ON items(seq)');
      // Receipts stored before the battery was recorded name none, so they lend
      // no label and their rows are scored once more.
      const receiptColumns = this.store.all<{ name: string }>('PRAGMA table_info(triage_receipts)');
      if (!receiptColumns.some(column => column.name === 'battery')) this.store.run('ALTER TABLE triage_receipts ADD COLUMN battery TEXT');
      const unversioned = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM items WHERE triage_revision IS NULL');
      if (unversioned && unversioned.count > 0) {
        this.store.run("UPDATE items SET triage_revision = 'ir-' || lower(hex(randomblob(16))) WHERE triage_revision IS NULL");
      }
      const saved = this.store.get<{ version: number; itemTtlMs: number; itemCap: number }>('SELECT version, itemTtlMs, itemCap FROM inbox_retention_policy WHERE singleton = 1');
      if (saved && (saved.version !== 1 || !isInboxRetentionPolicy(saved))) throw new Error('Inbox retention policy is unsupported');
      if (!saved || saved.itemTtlMs !== this.itemTtlMs || saved.itemCap !== this.itemCap) {
        this.store.run('INSERT OR REPLACE INTO inbox_retention_policy (singleton, version, itemTtlMs, itemCap) VALUES (1, 1, ?, ?)', [this.itemTtlMs, this.itemCap]);
      }
      this.sourceRevisionsReady = true;
      await this.runSweep();
      if (this.closed) return;
      this.initialized = true;
      this.startSweepTimer();
    })();
    this.initializing = pending;
    void pending.then(
      () => { if (this.initializing === pending) this.initializing = null; },
      () => { if (this.initializing === pending) this.initializing = null; },
    );
    return pending;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('InboxCursorStore is closed.');
    if (!this.sourceRevisionsReady) throw new Error('Inbox source revisions are unavailable');
  }

  /**
   * One retention pass: age TTL first, then the count cap over what is left.
   * Returns counts only. Running it twice in a row reclaims nothing the second
   * time, the pass is a function of the table's current contents.
   */
  sweepRetention(): InboxSweepSummary {
    this.assertOpen();
    const at = this.now();
    const expired = this.pruneOlderThan(at - this.itemTtlMs);
    const capped = this.enforceItemCap();
    // A triage label lives and dies with its row.
    if (expired + capped > 0) this.store.run('DELETE FROM triage_receipts WHERE id NOT IN (SELECT id FROM items)');
    return { at, expired, capped, remaining: this.countItems() };
  }

  /** Sweep, persist and disclose counts. Observer failures cannot strand a timer. */
  private runSweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pending = (async () => {
      try {
        const summary = this.sweepRetention();
        if (summary.expired + summary.capped === 0) return;
        this.onSweep?.(summary);
      } catch (error) {
        try { this.onSweepError?.(error instanceof Error ? error.message : String(error)); }
        catch { /* Observer callbacks cannot create unhandled timer rejections. */ }
      }
    })();
    this.sweeping.add(pending);
    void pending.then(() => { this.sweeping.delete(pending); });
    return pending;
  }

  private startSweepTimer(): void {
    if (this.closed || this.sweepTimer !== null || this.sweepIntervalMs <= 0) return;
    const handle = this.setIntervalImpl(() => {
      void this.runSweep();
    }, this.sweepIntervalMs);
    // Retention must never be the reason the process stays alive (Bun/Node unref).
    (handle as unknown as { unref?: () => void }).unref?.();
    this.sweepTimer = handle;
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer === null) return;
    this.clearIntervalImpl(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Count cap: keep the newest `itemCap` rows (receivedAt DESC, id ASC, the
   * same order listItems() uses), delete the rest. Returns rows removed.
   */
  private enforceItemCap(): number {
    const before = this.countItems();
    if (before <= this.itemCap) return 0;
    this.store.run(
      `DELETE FROM items WHERE id NOT IN (
         SELECT id FROM items ORDER BY receivedAt DESC, id ASC LIMIT ?
       )`,
      [this.itemCap],
    );
    return before - this.countItems();
  }

  /**
   * Stage timestamp rows and their progress together. Nothing becomes visible
   * until the post-write synchronous fence authorizes atomic publication.
   *
   * Without `conversations` the provider's one watermark moves to the newest
   * row. With it, each named conversation's own cursor moves to the time given
   * (what was read completely for it), and the provider-wide row is left as the
   * floor for conversations that have no cursor of their own yet.
   */
  commitTimestampPoll(provider: string, inputItems: readonly InboundChannelItem[], assertCurrent: () => void,
    conversations?: Readonly<Record<string, number>>): Promise<number> {
    this.assertOpen();
    // The persistence queue may yield; do not retain mutable adapter results.
    const items = inputItems.map(item => ({ ...item }));
    let nextSince = 0;
    for (const item of items) {
      if (item.provider !== provider) throw new Error('Timestamp inbox item belongs to another provider');
      if (!Number.isFinite(item.receivedAt)) throw new Error('Invalid timestamp inbox item');
      nextSince = Math.max(nextSince, Math.floor(item.receivedAt));
    }
    const advances = Object.entries(conversations ?? {}).map(([conversation, at]): [string, number] => {
      if (!conversation || conversation.length > 200 || !Number.isSafeInteger(at) || at < 0) throw new Error('Invalid inbox conversation cursor');
      return [`${provider}:${conversation}`, at];
    });
    const pending = trackSequences(held => this.store.persistTransaction(transaction => {
      for (const item of items) {
        const existing = transaction.get<{ provider: string }>('SELECT provider FROM items WHERE id = ?', [item.id]);
        if (existing && existing.provider !== provider) throw new Error('Timestamp inbox item id belongs to another provider');
      }
      const inserted = upsertRows(transaction, items, held);
      const cursorRows: readonly (readonly [string, number])[] = conversations ? advances : nextSince > 0 ? [[provider, nextSince]] : [];
      for (const [key, at] of cursorRows) transaction.run(`INSERT INTO cursors (provider, nextSince) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET nextSince = MAX(cursors.nextSince, excluded.nextSince)`, [key, at]);
      return inserted;
    }, () => { this.assertOpen(); const result = assertCurrent(); this.assertOpen(); return result; }));
    // Closing must drain this transaction, without marking later ordinary
    // mutations clean or releasing the underlying lifetime lock early.
    const tracked = pending.then(() => {});
    this.flushing.add(tracked);
    void tracked.then(() => this.flushing.delete(tracked), () => this.flushing.delete(tracked));
    return pending;
  }

  /** Account scoping belongs to the owning store path, never to mailbox data. */
  getImapCheckpoint(provider: string): ImapUidCheckpoint | null {
    this.assertOpen();
    return readImapCheckpoint(this.store, provider);
  }

  /**
   * Publish redacted rows and their UID progress as one durable image. The
   * synchronous fence is rechecked immediately before atomic rename. Failed
   * transactions never publish an in-memory checkpoint or feed row.
   */
  commitImapPoll(provider: string, inputItems: readonly InboundChannelItem[], input: ImapUidCheckpointAdvance,
    assertCurrent: () => void,
  ): Promise<number> {
    this.assertOpen();
    const items = captureImapItems(provider, inputItems);
    const advance = captureImapAdvance(input, items);
    const pending = trackSequences(held => this.store.persistTransaction((transaction) => {
      if (!sameImapCheckpoint(readImapCheckpoint(transaction, provider), advance.previous)) {
        throw new Error('IMAP inbox checkpoint changed before commit');
      }
      if (advance.transition === 'reset') {
        transaction.run('DELETE FROM items WHERE provider = ?', [provider]);
        transaction.run('DELETE FROM triage_receipts WHERE id NOT IN (SELECT id FROM items)');
      }
      for (const item of items) {
        const existing = transaction.get<{ provider: string }>('SELECT provider FROM items WHERE id = ?', [item.id]);
        if (existing && existing.provider !== provider) throw new Error('IMAP inbox item id belongs to another provider');
      }
      const inserted = upsertRows(transaction, items, held);
      transaction.run(`INSERT INTO imap_checkpoints (provider, checkpoint) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET checkpoint = excluded.checkpoint`, [provider, JSON.stringify(advance.next)]);
      return inserted;
    }, () => { this.assertOpen(); const result = assertCurrent(); this.assertOpen(); return result; }));
    // Do not mark ordinary revisions clean: a separate flush still owns any
    // mutation accepted after this transaction's synchronous publication.
    const tracked = pending.then(() => {});
    this.flushing.add(tracked);
    void tracked.then(() => this.flushing.delete(tracked), () => this.flushing.delete(tracked));
    return pending;
  }

  /** Current cursor for a provider (0 when unset). */
  getCursor(provider: string): number {
    this.assertOpen();
    const row = this.store.get<{ nextSince: number }>(
      'SELECT nextSince FROM cursors WHERE provider = ?',
      [provider],
    );
    return row ? Number(row.nextSince) : 0;
  }

  /** Every conversation cursor this provider has, keyed by conversation id. One query. */
  getConversationCursors(provider: string): Map<string, number> {
    this.assertOpen();
    const prefix = `${provider}:`;
    const rows = this.store.all<{ provider: string; nextSince: number }>(
      'SELECT provider, nextSince FROM cursors WHERE substr(provider, 1, ?) = ?', [prefix.length, prefix]);
    return new Map(rows.map(row => [row.provider.slice(prefix.length), Number(row.nextSince)]));
  }

  /**
   * Read items for the feed, filtered by provider set + since, newest first,
   * capped at limit. `since` is a store sequence (the `cursor` an earlier read
   * returned): only rows committed or changed after it are returned.
   */
  listItems(query: InboxQuery): InboundChannelItem[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.providers && query.providers.length > 0) {
      const placeholders = query.providers.map(() => '?').join(', ');
      clauses.push(`provider IN (${placeholders})`);
      params.push(...query.providers);
    }
    if (typeof query.since === 'number' && Number.isFinite(query.since)) {
      clauses.push('seq > ?');
      params.push(Math.floor(query.since));
    }
    if (query.after && Number.isFinite(query.after.receivedAt)) {
      // Strictly after the cursor row in (receivedAt DESC, id ASC) order: an
      // older timestamp, or the same timestamp with a higher id. Both halves
      // are needed, several items can share a receivedAt, and comparing on
      // the timestamp alone would drop every one of its ties.
      clauses.push('(receivedAt < ? OR (receivedAt = ? AND items.id > ?))');
      const at = Math.floor(query.after.receivedAt);
      params.push(at, at, query.after.id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(0, Math.floor(query.limit));
    params.push(limit);
    // A label shows only while the receipt names the row's current content
    // revision and was decided by the current battery version.
    const rows = this.store.all<ItemRow>(
      `SELECT items.id AS id, provider, kind, fromDigest, subjectPreview, bodyPreview,
              routeId, receivedAt, unread, r.label AS triageLabel, r.score AS triageScore, r.tags AS triageTags
         FROM items LEFT JOIN triage_receipts r
           ON r.id = items.id AND r.revision = items.triage_revision AND r.status = 'settled' AND r.battery = ?
         ${where}
         ORDER BY receivedAt DESC, items.id ASC
         LIMIT ?`,
      [INBOX_TRIAGE_BATTERY, ...params],
    );
    return rows.map(rowToItem);
  }

  /** Each named row's current content revision, in one query. A row missing here is gone. */
  triageRevisions(ids: readonly string[]): Map<string, string> {
    this.assertOpen();
    if (ids.length === 0) return new Map();
    const rows = this.store.all<{ id: string; triage_revision: string }>(
      `SELECT id, triage_revision FROM items WHERE id IN (${ids.map(() => '?').join(', ')})`, [...ids]);
    return new Map(rows.map(row => [row.id, row.triage_revision]));
  }

  /** Rows of this provider whose content has no settled label from the current battery yet, newest first. */
  untriagedItems(provider: string, limit: number): InboxTriageCandidate[] {
    this.assertOpen();
    const rows = this.store.all<ItemRow & { revision: string }>(
      `SELECT items.id AS id, provider, kind, fromDigest, subjectPreview, bodyPreview, routeId, receivedAt, unread,
              items.triage_revision AS revision
         FROM items LEFT JOIN triage_receipts r ON r.id = items.id AND r.revision = items.triage_revision
        WHERE provider = ? AND items.triage_revision IS NOT NULL
          AND (r.id IS NULL OR r.status <> 'settled' OR r.battery IS NOT ?)
        ORDER BY receivedAt DESC, items.id ASC LIMIT ?`, [provider, INBOX_TRIAGE_BATTERY, Math.max(0, Math.floor(limit))]);
    return rows.map(row => ({ item: rowToItem(row), revision: row.revision }));
  }

  /**
   * Store triage receipts beside their rows. Each row's revision is compared
   * once, inside the transaction: a row whose content changed or went away since
   * it was read is left for the next pass, the others are written. A failed
   * attempt never replaces a settled label the same battery gave the same
   * content; another battery version's receipt is history and is replaced.
   * Returns the ids written.
   */
  commitTriageReceipts(receipts: readonly InboxTriageReceiptRow[], assertCurrent: () => void = () => {}): Promise<readonly string[]> {
    this.assertOpen();
    const rows = receipts.map(row => ({ ...row, tags: row.tags ? JSON.stringify([...row.tags]) : null }));
    if (rows.length === 0) return Promise.resolve([]);
    const pending = this.store.persistTransaction(transaction => {
      const written: string[] = [];
      for (const row of rows) {
        const current = transaction.get<{ triage_revision: string | null }>('SELECT triage_revision FROM items WHERE id = ?', [row.id]);
        if (!current || current.triage_revision !== row.revision) continue;
        if (row.status !== 'settled') {
          const kept = transaction.get<{ status: string; battery: string | null }>('SELECT status, battery FROM triage_receipts WHERE id = ? AND revision = ?', [row.id, row.revision]);
          if (kept?.status === 'settled' && kept.battery === row.battery) continue;
        }
        transaction.run(`INSERT OR REPLACE INTO triage_receipts (id, revision, status, label, score, tags, receipt, battery)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.revision, row.status, row.label ?? null, row.score ?? null, row.tags, row.receipt, row.battery]);
        written.push(row.id);
      }
      return written;
    }, () => { this.assertOpen(); const result = assertCurrent(); this.assertOpen(); return result; });
    const tracked = pending.then(() => {});
    this.flushing.add(tracked);
    void tracked.then(() => this.flushing.delete(tracked), () => this.flushing.delete(tracked));
    return pending;
  }

  /** Highest store sequence across the (optionally provider-filtered) feed, or 0: the "what is new" watermark. */
  maxSequence(providers?: readonly string[]): number {
    this.assertOpen();
    const { where, params } = filterClause(providers);
    const row = this.store.get<{ maxSeq: number | null }>(
      `SELECT MAX(seq) AS maxSeq FROM items ${where}`,
      params,
    );
    return row && row.maxSeq != null ? Number(row.maxSeq) : 0;
  }

  /**
   * Total count of items matching the (optional) provider set and `since`
   * watermark.
   *
   * `since` is part of the filter and not an afterthought: the total is what a
   * caller compares its page against to know whether it has seen everything, so
   * a total counting rows the same call's `since` excluded would tell it there
   * is more when there is not.
   */
  countItems(providers?: readonly string[], since?: number): number {
    this.assertOpen();
    const { where, params } = filterClause(providers, since);
    const row = this.store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items ${where}`,
      params,
    );
    return row ? Number(row.n) : 0;
  }

  /**
   * Composite cursors have no owner component: every persisted ID must belong
   * to its wire provider namespace, including rows outside the requested page.
   * Checking in SQLite avoids materializing an unbounded mirror on each read.
   */
  hasInvalidItemNamespaces(providers: readonly string[]): boolean {
    this.assertOpen();
    const membership = providers.length ? `provider NOT IN (${providers.map(() => '?').join(', ')}) OR ` : '1 = 1 OR ';
    const row = this.store.get<{ invalid: number }>(
      `SELECT 1 AS invalid FROM items WHERE ${membership}substr(id, 1, length(provider) + 1) <> provider || ':' LIMIT 1`,
      [...providers],
    );
    return row !== null && row !== undefined;
  }

  /**
   * Per-provider item counts over the same filter, in ONE query.
   *
   * The aggregator reports a stored count for every provider on every call, and
   * doing that with one countItems() per provider would be a query per provider
   * per request. Providers absent from the result simply have no rows.
   */
  countItemsByProvider(providers?: readonly string[], since?: number): Map<string, number> {
    this.assertOpen();
    const { where, params } = filterClause(providers, since);
    const rows = this.store.all<{ provider: string; n: number }>(
      `SELECT provider, COUNT(*) AS n FROM items ${where} GROUP BY provider`,
      params,
    );
    const out = new Map<string, number>();
    for (const row of rows) out.set(row.provider, Number(row.n));
    return out;
  }

  /**
   * Retention: delete items strictly older than `cutoff` (Unix ms), optionally
   * scoped to a provider set. Returns the number of rows removed. Cursors are
   * left untouched so already-consumed watermarks never regress. A non-finite
   * cutoff is a no-op (prevents an accidental whole-table wipe).
   */
  pruneOlderThan(cutoff: number, providers?: readonly string[]): number {
    this.assertOpen();
    if (!Number.isFinite(cutoff)) return 0;
    const clauses = ['receivedAt < ?'];
    const params: (string | number)[] = [Math.floor(cutoff)];
    if (providers && providers.length > 0) {
      const placeholders = providers.map(() => '?').join(', ');
      clauses.push(`provider IN (${placeholders})`);
      params.push(...providers);
    }
    const before = this.countItems(providers);
    this.store.run(`DELETE FROM items WHERE ${clauses.join(' AND ')}`, params);
    return before - this.countItems(providers);
  }

  /** Stop admission/timers, await owned I/O, flush the last revision and close. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      let timerError: unknown;
      try { this.stopSweepTimer(); } catch (error) { timerError = error; }
      try {
        // A late init must finish before we close its handle. It is prevented
        // from starting a sweep/timer once closed, but its actual I/O is owned.
        await Promise.allSettled([this.initializing, ...this.sweeping, ...this.flushing]);
        if (timerError !== undefined) throw timerError;
      } finally { this.store.close(); this.releaseStorage(); }
    });
    return this.closing;
  }
}

// One sequence for every inbox mirror in this process. The daemon keeps one
// mirror per account and lists them together, so a watermark must compare
// across them. A sequence is the commit time in ms, made unique and increasing,
// so it also stays ahead of everything written before a restart.
let lastSequence = 0;
/** First sequence of every transaction staged but not yet published. */
const unpublished = new Map<Set<number>, true>();

function issueSequences(count: number, storeMax: number, held: Set<number>): number {
  const first = Math.max(lastSequence + 1, storeMax + 1, Date.now());
  lastSequence = first + Math.max(0, count - 1);
  held.add(first);
  return first;
}

function trackSequences<T>(run: (held: Set<number>) => Promise<T>): Promise<T> {
  const held = new Set<number>();
  unpublished.set(held, true);
  return run(held).finally(() => { unpublished.delete(held); });
}

/**
 * The highest sequence a reader may hand out as its watermark: below every
 * transaction still being written, so a row published after the read can never
 * carry a sequence the caller has already passed. Unbounded when nothing is
 * being written (after a restart too), so the store's own maximum stands.
 */
export function publishedSequenceBound(): number {
  let bound = Number.POSITIVE_INFINITY;
  for (const held of unpublished.keys()) for (const first of held) bound = Math.min(bound, first - 1);
  return bound;
}

/** Shared WHERE builder for the provider-set + since filter the reads share. */
function filterClause(
  providers?: readonly string[],
  since?: number,
): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (providers && providers.length > 0) {
    clauses.push(`provider IN (${providers.map(() => '?').join(', ')})`);
    params.push(...providers);
  }
  if (typeof since === 'number' && Number.isFinite(since)) {
    clauses.push('seq > ?');
    params.push(Math.floor(since));
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToItem(row: ItemRow): InboundChannelItem {
  const item: InboundChannelItem = {
    id: row.id,
    provider: row.provider,
    kind: normalizeKind(row.kind),
    fromDigest: row.fromDigest,
    subjectPreview: row.subjectPreview,
    bodyPreview: row.bodyPreview,
    receivedAt: Number(row.receivedAt),
    unread: Number(row.unread) !== 0,
  };
  if (row.routeId != null) item.routeId = row.routeId;
  if (row.triageLabel === 'spam' || row.triageLabel === 'priority' || row.triageLabel === 'normal') {
    item.triageLabel = row.triageLabel;
    if (typeof row.triageScore === 'number') item.triageScore = row.triageScore;
    try {
      const tags: unknown = row.triageTags ? JSON.parse(row.triageTags) : [];
      if (Array.isArray(tags)) item.triageTags = tags.filter((tag): tag is string => typeof tag === 'string');
    } catch { /* A label without readable tags still shows. */ }
  }
  return item;
}

function normalizeKind(value: string): InboundChannelItem['kind'] {
  return value === 'dm' || value === 'thread' || value === 'mention' || value === 'reaction'
    ? value
    : 'dm';
}

function readImapCheckpoint(store: HandlerSqliteTransaction, provider: string): ImapUidCheckpoint | null {
  const row = store.get<{ checkpoint: string }>('SELECT checkpoint FROM imap_checkpoints WHERE provider = ?', [provider]);
  return row ? captureImapCheckpoint(JSON.parse(row.checkpoint) as ImapUidCheckpoint) : null;
}

function upsertRows(store: HandlerSqliteTransaction, items: readonly InboundChannelItem[], held: Set<number>): number {
  if (items.length === 0) return 0;
  const batchIds = [...new Set(items.map((item) => item.id))];
  const existing = new Set(store.all<{ id: string }>(
    `SELECT id FROM items WHERE id IN (${batchIds.map(() => '?').join(', ')})`, batchIds,
  ).map((row) => row.id));
  let inserted = 0;
  // A row takes the next sequence when it is written new or its content changes,
  // so a caller polling with `since` sees both; an identical re-read keeps its place.
  let next = issueSequences(items.length, Number(store.get<{ maxSeq: number | null }>('SELECT MAX(seq) AS maxSeq FROM items')?.maxSeq ?? 0), held);
  const unchanged = `items.provider IS excluded.provider
        AND (CASE items.kind WHEN 'dm' THEN 'direct' WHEN 'thread' THEN 'thread' ELSE 'service' END)
          IS (CASE excluded.kind WHEN 'dm' THEN 'direct' WHEN 'thread' THEN 'thread' ELSE 'service' END)
        AND items.subjectPreview IS excluded.subjectPreview AND items.bodyPreview IS excluded.bodyPreview
        AND items.unread IS excluded.unread`;
  for (const item of items) {
    if (!existing.has(item.id)) { inserted += 1; existing.add(item.id); }
    store.run(`INSERT INTO items
      (id, provider, kind, fromDigest, subjectPreview, bodyPreview, routeId, receivedAt, unread, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
      triage_revision = CASE WHEN ${unchanged} THEN items.triage_revision ELSE NULL END,
      seq = CASE WHEN ${unchanged} THEN items.seq ELSE excluded.seq END,
      provider = excluded.provider, kind = excluded.kind,
      fromDigest = excluded.fromDigest, subjectPreview = excluded.subjectPreview,
      bodyPreview = excluded.bodyPreview, routeId = COALESCE(excluded.routeId, items.routeId),
      receivedAt = excluded.receivedAt, unread = excluded.unread`,
    [item.id, item.provider, item.kind, item.fromDigest, item.subjectPreview, item.bodyPreview,
      item.routeId ?? null, item.receivedAt, item.unread ? 1 : 0, next]);
    next += 1;
    // SQLite issues only an actual new/changed message revision; identical
    // polling never mints then discards a new identifier.
    store.run("UPDATE items SET triage_revision = 'ir-' || lower(hex(randomblob(16))) WHERE id = ? AND triage_revision IS NULL", [item.id]);
  }
  return inserted;
}

