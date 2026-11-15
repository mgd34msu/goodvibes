import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { logger } from '../../utils/logger.js';
import type { AtRestCipher } from '../../config/daemon-credential-store.js';
import { HandlerSqliteStore } from '../../state/daemon-handler-sqlite-store.js';
import type { MutationPublication } from '../../utils/file-mutation.js';
import { HandlerError } from '../../control-plane/host-handlers.js';
import { channelDraftWireReference, createChannelDraftWireReference, isHistoricalDraftWireReference, matchesHistoricalDraftWireReference } from './wire-reference.js';

// ---------------------------------------------------------------------------
// Channel drafts, the store of record.
//
// A draft is composed on one surface and very often finished on another: the
// phone writes it, the terminal sends it. This daemon-side store is the one
// every surface reads, and the Agent's local file is an outbox for saves made
// while the daemon could not be reached. Two rules are enforced here: a save
// never replaces a newer row with an older one (DRAFT_STALE), and a draft
// recorded as sent stays sent (DRAFT_ALREADY_SENT), so another surface cannot
// send it again by saving an earlier copy.
//
// An autonomous save or delete names the row it read; the write is a
// compare-and-set on that row's `updatedAt` inside the one transaction, and a
// row that moved is refused as DRAFT_CHANGED with the time it moved.
//
// SECURITY POSTURE:
//   - The message body is encrypted at rest (AES-256-GCM, the daemon at-rest
//     cipher) as `bodyEnc`. `list` never decrypts it: rows carry a fixed
//     '[redacted]' marker. `getReadable` decrypts one draft for an owner
//     (admin) caller, who can already send any text through the channel.
//   - The webhook URL is encrypted at rest (`webhookEnc`) and is ALWAYS
//     redacted ('[redacted]') in every response; the raw URL never leaves.
// ---------------------------------------------------------------------------

/** Redact a stored webhook for responses: present → '[redacted]', else undefined. */
export function redactWebhook(value?: string | null): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : '[redacted]';
}

export type DraftStatus = 'draft' | 'queued' | 'sent' | 'failed';

/**
 * Statuses callers are permitted to write via save(). The surface that sends a
 * draft records the outcome by saving it as `sent` (with `sentResponseId`) or
 * `failed` (with `sendError`), which is how every other surface learns it.
 */
export const WRITABLE_DRAFT_STATUSES: readonly DraftStatus[] = ['draft', 'queued', 'sent', 'failed'];

/** All known statuses. */
export const ALL_DRAFT_STATUSES: readonly DraftStatus[] = [
  'draft',
  'queued',
  'sent',
  'failed',
];

export const DEFAULT_DRAFT_VERSION = 1;
export const DEFAULT_DRAFT_LIST_LIMIT = 50;
export const MAX_DRAFT_LIST_LIMIT = 200;

/** Public metadata only. Body and webhook values remain private and encrypted. */
export interface DraftRecord {
  version: number;
  id: string;
  wireReference: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  status: DraftStatus;
  message: string; // Fixed '[redacted]' marker. Plaintext body is never transmitted.
  title?: string;
  channel?: string;
  route?: string;
  webhook?: string; // '[redacted]' when a webhook is stored, else omitted
  link?: string;
  tags?: string[];
  sentResponseId?: string;
  sendError?: string;
}

/** Normalized input accepted by upsert(). `message` is the FULL plaintext body. */
export interface DraftSaveInput {
  id?: string;
  wireReference?: string;
  version?: number;
  title?: string;
  message: string;
  channel?: string;
  route?: string;
  webhook?: string;
  link?: string;
  tags?: string[];
  status?: DraftStatus;
  /** Provider response id of the send; kept only for a `sent` draft. */
  sentResponseId?: string;
  /** Why the send failed; kept only for a `failed` draft. */
  sendError?: string;
  createdAt?: string;
  /**
   * Caller-supplied last-modified timestamp (ISO-8601). When provided it is
   * persisted verbatim, enabling the sync contract's 'most recent updatedAt
   * wins' conflict model; when omitted the store stamps updatedAt = now(). A
   * value older than the stored row's is refused as DRAFT_STALE.
   */
  updatedAt?: string;
}

export interface DraftListQuery {
  status?: DraftStatus;
  limit?: number;
}

export interface DraftSaveResult {
  draft: DraftRecord;
  created: boolean;
}

export interface DraftSyncStoreOptions {
  workingDirectory: string;
  cipher: AtRestCipher;
  /** Override the sqlite filename (tests). Defaults to 'drafts.sqlite'. */
  fileName?: string;
  /** UUID generator injection point (tests). Defaults to opaqueUuid. */
  generateId?: () => string;
  /** Clock injection point (tests). Defaults to () => new Date().toISOString(). */
  now?: () => string;
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS drafts (
     id TEXT PRIMARY KEY,
     wireReference TEXT,
     legacyWireReference INTEGER NOT NULL DEFAULT 1,
     version INTEGER NOT NULL,
     createdAt TEXT NOT NULL,
     updatedAt TEXT NOT NULL,
     status TEXT NOT NULL,
     title TEXT,
     bodyEnc TEXT NOT NULL,
     channel TEXT,
     route TEXT,
     webhookEnc TEXT,
     link TEXT,
     tags TEXT,
     sentResponseId TEXT,
     sendError TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts (status)',
  'CREATE INDEX IF NOT EXISTS idx_drafts_updatedAt ON drafts (updatedAt)',
];

interface DraftRow {
  id: string;
  wireReference: string | null;
  legacyWireReference: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  title: string | null;
  channel: string | null;
  route: string | null;
  webhookEnc: string | null;
  link: string | null;
  tags: string | null;
  sentResponseId: string | null;
  sendError: string | null;
}

function nullable(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function parseTags(raw: string | null): string[] | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const tags = parsed.filter((t): t is string => typeof t === 'string');
      return tags.length > 0 ? tags : undefined;
    }
  } catch {
    // Corrupt tags column, treat as absent rather than throwing on read.
  }
  return undefined;
}

function normalizeStatus(status: DraftStatus | undefined): DraftStatus {
  return status ?? 'draft';
}

function normalizeVersion(version: number | undefined): number {
  if (version === undefined || !Number.isFinite(version)) return DEFAULT_DRAFT_VERSION;
  const floored = Math.floor(version);
  return floored < 1 ? DEFAULT_DRAFT_VERSION : floored;
}

/**
 * Server-side mirror of agent drafts. Wraps HandlerSqliteStore; all body and
 * webhook material is encrypted at rest via the injected AtRestCipher.
 */
export class DraftSyncStore {
  private readonly store: HandlerSqliteStore;
  private readonly cipher: AtRestCipher;
  private readonly generateId: () => string;
  private readonly now: () => string;
  private initialized = false;
  private closed = false;
  private initializing: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly active = new Set<Promise<unknown>>();
  private upsertTail: Promise<void> = Promise.resolve();

  constructor(options: DraftSyncStoreOptions) {
    this.store = new HandlerSqliteStore({
      workingDirectory: options.workingDirectory,
      fileName: options.fileName ?? 'drafts.sqlite',
      schema: SCHEMA,
    });
    this.cipher = options.cipher;
    this.generateId = options.generateId ?? (() => opaqueUuid());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  init(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('DraftSyncStore is closed'));
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const pending = Promise.resolve().then(() => this.store.init()).then(async () => {
      // Existing stores contain an unused plaintext body digest. Remove the
      // column without decrypting or rewriting the authenticated ciphertext.
      if (this.store.all<{ name: string }>('PRAGMA table_info(drafts)').some(column => column.name === 'messageDigest')) {
        this.store.run('ALTER TABLE drafts DROP COLUMN messageDigest');
        await this.store.save();
      }
      // Old explicit INSERT/UPDATE statements leave this additive column intact.
      // Allocate a private-safe label once, never a digest of new caller metadata.
      const columns = this.store.all<{ name: string }>('PRAGMA table_info(drafts)');
      if (!columns.some(column => column.name === 'legacyWireReference')) this.store.run('ALTER TABLE drafts ADD COLUMN legacyWireReference INTEGER NOT NULL DEFAULT 1');
      if (!columns.some(column => column.name === 'wireReference')) this.store.run('ALTER TABLE drafts ADD COLUMN wireReference TEXT');
      for (const row of this.store.all<{ id: string; wireReference: string | null }>('SELECT id, wireReference FROM drafts')) {
        if (row.wireReference === null) this.store.run('UPDATE drafts SET wireReference = ? WHERE id = ? AND wireReference IS NULL', [createChannelDraftWireReference(row.id), row.id]);
        else channelDraftWireReference(row.id, row.wireReference);
      }
      this.store.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_wireReference ON drafts (wireReference)');
      await this.store.save();
      if (!this.closed) this.initialized = true;
    });
    this.initializing = pending;
    void pending.then(
      () => { if (this.initializing === pending) this.initializing = null; },
      () => { if (this.initializing === pending) this.initializing = null; },
    );
    return pending;
  }

  /** Persist the admitted snapshot; shutdown waits for its atomic write. */
  async save(): Promise<void> {
    this.requireInit();
    return this.track(this.store.save());
  }

  /** Stop admission immediately and drain accepted work before closing SQLite. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.initialized = false;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([this.initializing, ...this.active]);
      this.store.close();
    });
    // Compatibility for old void callers; awaiting close still observes failure.
    void this.closing.catch(() => {
      try { logger.warn('Draft store did not close cleanly'); } catch { /* Preserve cleanup outcome. */ }
    });
    return this.closing;
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.active.add(pending);
    void pending.then(() => this.active.delete(pending), () => this.active.delete(pending));
    return pending;
  }

  private requireInit(): void {
    if (this.closed) throw new Error('DraftSyncStore is closed');
    if (!this.initialized) throw new Error('DraftSyncStore is not initialized');
  }

  /**
   * Create (no id) or update (id present) a draft. Encrypts the body and
   * webhook at rest, preserves createdAt on update, and
   * sets updatedAt to input.updatedAt when present (enabling 'most recent
   * updatedAt wins') or now() otherwise.
   *
   * FULL-REPLACE SEMANTICS (intentional, per the full-snapshot sync contract):
   * every caller-supplied field is a complete snapshot, NOT a partial patch.
   * The ON CONFLICT UPDATE SET clause assigns each column from the incoming row,
   * so an OMITTED optional field is CLEARED on update (webhookEnc/tags/title/
   * channel/route/link → NULL). That includes sentResponseId/sendError, which
   * belong to the `sent`/`failed` snapshot they came with.
   */
  /**
   * `expectedUpdatedAt` is the row the caller read: its `updatedAt`, or null for
   * "no such draft yet". When given, the write applies only if the row is still
   * that one, checked inside the transaction (DRAFT_CHANGED otherwise).
   */
  async upsert(
    input: DraftSaveInput,
    assertCurrent?: () => void,
    withPublication?: MutationPublication,
    persist = false,
    expectedUpdatedAt?: string | null,
  ): Promise<DraftSaveResult> {
    this.requireInit();
    // The same ID may be saved concurrently. Creation detection and write-back
    // run in admission order, preserving the first creation metadata.
    const pending = this.upsertTail.then(() => this.performUpsert(input, assertCurrent, withPublication, persist, expectedUpdatedAt));
    this.upsertTail = pending.then(() => {}, () => {});
    return this.track(pending);
  }

  private async performUpsert(
    input: DraftSaveInput,
    assertCurrent: (() => void) | undefined,
    withPublication: MutationPublication | undefined,
    persist: boolean,
    expectedUpdatedAt: string | null | undefined,
  ): Promise<DraftSaveResult> {
    const encryptionChecks: Array<() => void> = [];
    const current = assertCurrent ? () => { assertCurrent(); for (const check of encryptionChecks) check(); } : undefined;
    const retainEncryption = (check: () => void) => { encryptionChecks.push(check); };
    assertCurrent?.();
    const existing = input.id !== undefined ? this.getRow(input.id) : null;
    const created = existing === null;
    const id = existing?.id ?? input.id ?? this.generateId();
    if (input.wireReference !== undefined) channelDraftWireReference(id, input.wireReference);
    const wireReference = existing?.wireReference ?? input.wireReference ?? createChannelDraftWireReference(id);
    channelDraftWireReference(id, wireReference);
    const conflict = this.store.get<{ id: string }>('SELECT id FROM drafts WHERE id <> ? AND (wireReference = ? OR id = ? OR wireReference = ?)', [id, wireReference, wireReference, id]);
    if (conflict) throw new HandlerError('Native draft reference is ambiguous', 'NATIVE_DRAFT_REFERENCE_UNAVAILABLE', 409);
    if (input.wireReference !== undefined && input.wireReference !== wireReference
      && this.store.get('SELECT id FROM drafts WHERE id <> ? AND (wireReference = ? OR id = ?)', [id, input.wireReference, input.wireReference])) {
      throw new HandlerError('Native draft reference is ambiguous', 'NATIVE_DRAFT_REFERENCE_UNAVAILABLE', 409);
    }
    // Only an actual incoming historical-shaped selector requests this old
    // compatibility lookup. A new row must not shadow another row's old handle.
    for (const reference of new Set([id, wireReference, input.wireReference])) {
      if (reference === undefined || !isHistoricalDraftWireReference(reference)) continue;
      const owner = this.resolveReferenceId(reference);
      if (owner !== undefined && owner !== id) throw new HandlerError('Native draft reference is ambiguous', 'NATIVE_DRAFT_REFERENCE_UNAVAILABLE', 409);
    }
    const timestamp = this.now();
    const createdAt = existing?.createdAt ?? input.createdAt ?? timestamp;
    const updatedAt = input.updatedAt ?? timestamp;
    const status = normalizeStatus(input.status);
    if (existing && input.updatedAt !== undefined && Date.parse(existing.updatedAt) > Date.parse(input.updatedAt)) {
      throw new HandlerError(
        `Draft was changed on another surface at ${existing.updatedAt}; this save is from ${input.updatedAt} and was not applied. Reload the draft and apply the edit again.`,
        'DRAFT_STALE',
        409,
      );
    }
    if (existing?.status === 'sent' && status !== 'sent') {
      throw new HandlerError(
        'Draft was already sent and cannot be saved as unsent; save a new draft to send it again.',
        'DRAFT_ALREADY_SENT',
        409,
      );
    }
    const version = normalizeVersion(input.version);

    const bodyEnc = await this.cipher.encrypt(input.message, assertCurrent, retainEncryption);
    current?.();
    const webhookEnc =
      input.webhook !== undefined && input.webhook !== ''
        ? await this.cipher.encrypt(input.webhook, assertCurrent, retainEncryption)
        : null;
    const tagsJson =
      input.tags !== undefined && input.tags.length > 0
        ? JSON.stringify(input.tags)
        : null;

    const write = (target: Pick<HandlerSqliteStore, 'run' | 'get'>) => {
      if (expectedUpdatedAt !== undefined) assertRowUnchanged(target, id, expectedUpdatedAt);
      target.run(
      `INSERT INTO drafts (
         id, wireReference, legacyWireReference, version, createdAt, updatedAt, status, title, bodyEnc,
         channel, route, webhookEnc, link, tags, sentResponseId, sendError
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         wireReference = excluded.wireReference,
         version = excluded.version,
         updatedAt = excluded.updatedAt,
         status = excluded.status,
         title = excluded.title,
         bodyEnc = excluded.bodyEnc,
         channel = excluded.channel,
         route = excluded.route,
         webhookEnc = excluded.webhookEnc,
         link = excluded.link,
         tags = excluded.tags,
         sentResponseId = excluded.sentResponseId,
         sendError = excluded.sendError`,
      [
        id,
        wireReference,
        existing?.legacyWireReference ?? 0,
        version,
        createdAt,
        updatedAt,
        status,
        nullable(input.title),
        bodyEnc,
        nullable(input.channel),
        nullable(input.route),
        webhookEnc,
        nullable(input.link),
        tagsJson,
        status === 'sent' ? nullable(input.sentResponseId) : null,
        status === 'failed' ? nullable(input.sendError) : null,
      ],
    );

      const row = target.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', [id]);
      return { draft: toRecord(row ?? this.fallbackRow(id, wireReference, version, createdAt, updatedAt, status, webhookEnc, input)), created };
    };
    // `persist` stages and publishes the write as one unit, so a save that fails
    // leaves the mirror, which other readers see live, as it was. Without it the
    // row is changed in memory only and the caller saves.
    return current || persist
      ? await this.store.persistTransaction(write, current ?? (() => {}), withPublication)
      : write(this.store);
  }

  /** The row a request selects, read once: the redacted record and the `updatedAt` its write will compare. */
  selectRow(id: string): { readonly target: DraftRecord | null; readonly updatedAt: string | null } {
    this.requireInit();
    const target = this.get(id);
    return { target, updatedAt: target?.updatedAt ?? null };
  }

  /**
   * One draft with its text, for a caller entitled to read it (the owner). The
   * webhook stays redacted. Null when there is no such draft.
   */
  async getReadable(id: string): Promise<DraftRecord | null> {
    this.requireInit();
    const row = this.store.get<{ bodyEnc: string }>('SELECT bodyEnc FROM drafts WHERE id = ?', [id]);
    const record = this.get(id);
    if (!row || !record) return null;
    return { ...record, message: await this.track(this.cipher.decrypt(row.bodyEnc)) };
  }

  /** Exhaustive native lookup. A handle identifies only one existing row, never a new draft. */
  resolveReferenceId(reference: string): string | undefined {
    this.requireInit();
    const matching: string[] = [];
    for (const { id, wireReference, legacyWireReference } of this.store.all<{ id: string; wireReference: string | null; legacyWireReference: number }>('SELECT id, wireReference, legacyWireReference FROM drafts')) {
      if (id === reference || wireReference === reference || legacyWireReference === 1 && matchesHistoricalDraftWireReference(id, reference)) matching.push(id);
    }
    if (matching.length > 1) throw new HandlerError('Native draft reference is ambiguous', 'NATIVE_DRAFT_REFERENCE_UNAVAILABLE', 409);
    return matching[0];
  }

  /** Delete as one staged write; with `expectedUpdatedAt`, only the row the caller read. */
  async deleteAdmitted(id: string, assertCurrent: () => void, withPublication?: MutationPublication, expectedUpdatedAt?: string | null): Promise<boolean> {
    this.requireInit();
    return this.track(this.store.persistTransaction(transaction => {
      if (expectedUpdatedAt !== undefined) assertRowUnchanged(transaction, id, expectedUpdatedAt);
      const existed = transaction.get('SELECT id FROM drafts WHERE id = ?', [id]) !== null;
      if (existed) transaction.run('DELETE FROM drafts WHERE id = ?', [id]);
      return existed;
    }, assertCurrent, withPublication));
  }

  /** List drafts, newest-updated first, optionally filtered by status. */
  list(query: DraftListQuery = {}): DraftRecord[] {
    this.requireInit();
    const limit = clampLimit(query.limit);
    const rows =
      query.status !== undefined
        ? this.store.all<DraftRow>(
            `SELECT id, wireReference, legacyWireReference, version, createdAt, updatedAt, status, title,
                    channel, route, webhookEnc, link, tags, sentResponseId, sendError
             FROM drafts WHERE status = ? ORDER BY updatedAt DESC, id ASC LIMIT ?`,
            [query.status, limit],
          )
        : this.store.all<DraftRow>(
            `SELECT id, wireReference, legacyWireReference, version, createdAt, updatedAt, status, title,
                    channel, route, webhookEnc, link, tags, sentResponseId, sendError
             FROM drafts ORDER BY updatedAt DESC, id ASC LIMIT ?`,
            [limit],
          );
    return rows.map((row) => toRecord(row));
  }

  /** Total number of stored drafts (optionally status-filtered). */
  count(status?: DraftStatus): number {
    this.requireInit();
    const row =
      status !== undefined
        ? this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts WHERE status = ?', [status])
        : this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts');
    return row?.n ?? 0;
  }

  /** Fetch a single draft as a redacted record, or null when absent. */
  get(id: string): DraftRecord | null {
    this.requireInit();
    const row = this.getRow(id);
    return row === null ? null : toRecord(row);
  }

  /** Delete a draft. Returns true when a row was removed. */
  delete(id: string): boolean {
    this.requireInit();
    const existed = this.getRow(id) !== null;
    if (existed) this.store.run('DELETE FROM drafts WHERE id = ?', [id]);
    return existed;
  }

  private getRow(id: string): DraftRow | null {
    return this.store.get<DraftRow>(
      `SELECT id, wireReference, legacyWireReference, version, createdAt, updatedAt, status, title,
              channel, route, webhookEnc, link, tags, sentResponseId, sendError
       FROM drafts WHERE id = ?`,
      [id],
    );
  }

  // Defensive synthesis if a read-back ever returns null (should not happen for
  // the row we just wrote); keeps upsert total even under a degraded backend.
  private fallbackRow(
    id: string,
    wireReference: string,
    version: number,
    createdAt: string,
    updatedAt: string,
    status: DraftStatus,
    webhookEnc: string | null,
    input: DraftSaveInput,
  ): DraftRow {
    return {
      id,
      wireReference,
      legacyWireReference: 0,
      version,
      createdAt,
      updatedAt,
      status,
      title: nullable(input.title),
      channel: nullable(input.channel),
      route: nullable(input.route),
      webhookEnc,
      link: nullable(input.link),
      tags:
        input.tags !== undefined && input.tags.length > 0
          ? JSON.stringify(input.tags)
          : null,
      sentResponseId: status === 'sent' ? nullable(input.sentResponseId) : null,
      sendError: status === 'failed' ? nullable(input.sendError) : null,
    };
  }
}

/**
 * The compare half of the compare-and-set: the row is still the one the
 * request read. Runs inside the write's transaction, so nothing can move it
 * between this check and the write.
 */
function assertRowUnchanged(target: Pick<HandlerSqliteStore, 'get'>, id: string, expectedUpdatedAt: string | null): void {
  const row = target.get<{ updatedAt: string }>('SELECT updatedAt FROM drafts WHERE id = ?', [id]);
  const now = row?.updatedAt ?? null;
  if (now === expectedUpdatedAt) return;
  throw new HandlerError(
    now === null
      ? `Draft ${id} was deleted after this request read it; nothing was written. Read the drafts again and retry.`
      : expectedUpdatedAt === null
        ? `Draft ${id} was created on another surface at ${now} after this request looked; nothing was written. Read it and retry.`
        : `Draft ${id} changed on another surface at ${now} after this request read it (at ${expectedUpdatedAt}); nothing was written. Read it again and retry.`,
    'DRAFT_CHANGED',
    409,
  );
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_DRAFT_LIST_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_DRAFT_LIST_LIMIT) return MAX_DRAFT_LIST_LIMIT;
  return floored;
}

/**
 * Map a stored row to a wire record. The required `message` field carries the
 * fixed redaction marker; the webhook is redacted; tags are parsed.
 */
export function toRecord(row: DraftRow): DraftRecord {
  const record: DraftRecord = {
    version: row.version,
    id: row.id,
    wireReference: channelDraftWireReference(row.id, row.wireReference ?? undefined),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status as DraftStatus,
    message: '[redacted]',
  };
  if (row.title !== null) record.title = row.title;
  if (row.channel !== null) record.channel = row.channel;
  if (row.route !== null) record.route = row.route;
  // Webhook is encrypted at rest; reads ALWAYS redact. Presence of webhookEnc
  // means a webhook exists → emit '[redacted]'; the raw URL never leaves here.
  const redacted = redactWebhook(row.webhookEnc);
  if (redacted !== undefined) record.webhook = redacted;
  if (row.link !== null) record.link = row.link;
  const tags = parseTags(row.tags);
  if (tags !== undefined) record.tags = tags;
  if (row.sentResponseId !== null) record.sentResponseId = row.sentResponseId;
  if (row.sendError !== null) record.sendError = row.sendError;
  return record;
}
