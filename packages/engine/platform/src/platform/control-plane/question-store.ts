/**
 * The owner inbox's own items: questions an agent or a session left, channel
 * claims, purchase windows and queued actions. Approvals are not stored here;
 * they stay in the approval broker and the inbox reads them from it.
 *
 * One SQLite file per owner home (`~/.goodvibes/shared/owner-inbox.sqlite`),
 * opened directly by every process that asks or answers: the daemon, each
 * terminal app (TUI, Agent, headless runs) and the agents they run. A post, an
 * answer, a withdrawal and what became of an answer are each one row write in
 * one transaction, so two processes answering at once cannot both win, and a
 * process sees another's change on its next read. `revision()` is SQLite's own
 * change counter (one statement, no file read): a reader compares one integer
 * to learn whether anything changed, and re-reads the rows only when it did.
 *
 * First answer wins: an answer is written only while the row is still open; a
 * later one changes nothing and reports who answered it.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { openSqliteFile, type SqliteFile, type SqliteMigration } from '../state/sqlite-file.js';
import type { RevisionSource } from '../utils/revision.js';
import { logger } from '../utils/logger.js';
import { canonicalFilePath } from '../utils/canonical-path.js';
import type { OwnerAnswer, OwnerAnswerSource, OwnerItemKind } from './owner-inbox.js';

/** Item kinds the question store holds; approvals live in the approval broker. */
export type StoredOwnerItemKind = Exclude<OwnerItemKind, 'approval'>;

/**
 * Metadata key naming the session that asked a question (a terminal app's
 * conversation, a headless run, a hosted session, a channel's shared session):
 * the answer goes back into that session's conversation, now when it is open,
 * otherwise when it is next opened.
 */
export const OWNER_ANSWER_SESSION_METADATA = 'answerSession';

/** Metadata key naming the agent that asked: it takes the answer on its next model request while it runs. */
export const OWNER_ANSWER_AGENT_METADATA = 'answerAgent';

/**
 * Metadata key holding the asking terminal session's saved file: present = it
 * can be opened again, and it is the session's identity (it names the app and
 * the project store as well as the id; owner-asker-liveness.ts `sessionAskerKey`).
 */
export const OWNER_ASKER_SESSION_FILE_METADATA = 'askerSessionFile';

/**
 * Whether an item recorded with saved file `recorded` belongs to the session
 * whose saved file is `wanted`. A session with a file takes items that name the
 * same file, and items that name none (asked before the file was recorded,
 * matched by id as they always were). A session without one (a hosted
 * session, a channel's) takes only items that name none, so a terminal
 * session with the same id is never mistaken for it.
 */
export function sessionFileMatches(recorded: string | undefined, wanted: string | undefined): boolean {
  if (recorded === undefined) return true;
  // Compared in canonical form: a question recorded under another spelling of the same folder is the session's.
  return wanted !== undefined && (recorded === wanted || canonicalFilePath(recorded) === canonicalFilePath(wanted));
}

export interface StoredOwnerItem {
  readonly id: string;
  readonly kind: StoredOwnerItemKind;
  /** The producer's own name for the item; a second post under an open key returns the first. */
  readonly key?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly title: string;
  readonly detail: string;
  /** Empty: the answer is free text. */
  readonly options: readonly string[];
  /** Who asked, in the producer's words (an agent name, a channel, a subsystem). */
  readonly askedBy?: string | undefined;
  /** The authenticated principal that posted it over the wire, when one did. */
  readonly postedBy?: string | undefined;
  readonly createdAt: number;
  /** After this the item reads as expired and takes no answer. Nothing answers it on the owner's behalf. */
  readonly expiresAt?: number | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** What became of an answer: taken by the agent or session that asked, or not deliverable and why. */
export interface StoredAnswerDelivery {
  readonly state: 'delivered' | 'undeliverable';
  readonly reason?: string | undefined;
  readonly at: number;
}

export interface StoredOwnerEntry {
  readonly item: StoredOwnerItem;
  readonly answer?: OwnerAnswer | undefined;
  readonly answeredBy?: OwnerAnswerSource | undefined;
  readonly withdrawnReason?: string | undefined;
  readonly closedAt?: number | undefined;
  /** Set once, after the answer: the first report wins. */
  readonly delivery?: StoredAnswerDelivery | undefined;
  readonly updatedAt: number;
}

export type QuestionStoreAnswerResult =
  | { readonly applied: true; readonly entry: StoredOwnerEntry }
  | { readonly applied: false; readonly entry: StoredOwnerEntry };

/** Whose questions to read: one session's, one agent's, or both. */
export interface QuestionAskerScope {
  readonly session?: string | undefined;
  /** The session's saved file, its identity; absent for a session that has none (see {@link sessionFileMatches}). */
  readonly sessionFile?: string | undefined;
  readonly agent?: string | undefined;
}

/** Whether `entry` is the scope's: asked by its agent, or by its session (id and saved file). */
function inScope(entry: StoredOwnerEntry, scope: QuestionAskerScope): boolean {
  if (scope.agent !== undefined && metadataText(entry.item, OWNER_ANSWER_AGENT_METADATA) === scope.agent) return true;
  if (scope.session === undefined || metadataText(entry.item, OWNER_ANSWER_SESSION_METADATA) !== scope.session) return false;
  return sessionFileMatches(metadataText(entry.item, OWNER_ASKER_SESSION_FILE_METADATA) ?? undefined, scope.sessionFile);
}

/** Where the one owner inbox store of a home is. */
export function ownerInboxStorePath(shellPaths: { resolveUserPath(...segments: string[]): string }): string {
  return shellPaths.resolveUserPath('shared', 'owner-inbox.sqlite');
}

/** Closed items kept for the history view; open items and answers still waiting for their asker are never dropped. */
const MAX_CLOSED_ENTRIES = 500;
const STORED_KINDS: ReadonlySet<string> = new Set<StoredOwnerItemKind>(['question', 'claim', 'purchase', 'queued-action']);

const MIGRATIONS: readonly SqliteMigration[] = [{
  toVersion: 1,
  up: (db: Database) => {
    db.run(`CREATE TABLE owner_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      item_key TEXT,
      answer_session TEXT,
      answer_agent TEXT,
      item TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      answer TEXT,
      answered_by TEXT,
      withdrawn_reason TEXT,
      closed_at INTEGER,
      delivery_state TEXT,
      delivery_reason TEXT,
      delivery_at INTEGER,
      updated_at INTEGER NOT NULL
    )`);
    db.run('CREATE INDEX owner_items_open_key ON owner_items(kind, item_key) WHERE closed_at IS NULL AND item_key IS NOT NULL');
    db.run('CREATE INDEX owner_items_answer_session ON owner_items(answer_session) WHERE answer_session IS NOT NULL');
    db.run('CREATE INDEX owner_items_answer_agent ON owner_items(answer_agent) WHERE answer_agent IS NOT NULL');
    db.run('CREATE INDEX owner_items_closed_at ON owner_items(closed_at) WHERE closed_at IS NOT NULL');
  },
}];

interface ItemRow {
  readonly id: string;
  readonly item: string;
  readonly answer: string | null;
  readonly answered_by: string | null;
  readonly withdrawn_reason: string | null;
  readonly closed_at: number | null;
  readonly delivery_state: string | null;
  readonly delivery_reason: string | null;
  readonly delivery_at: number | null;
  readonly updated_at: number;
}

const ROW_COLUMNS = 'id, item, answer, answered_by, withdrawn_reason, closed_at, delivery_state, delivery_reason, delivery_at, updated_at';
/** Rows an asker still has to take: open questions, and answers no one has taken or settled. */
const UNDELIVERED = '(closed_at IS NULL OR (answer IS NOT NULL AND delivery_state IS NULL))';

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function readStoredItem(value: unknown): StoredOwnerItem {
  if (!isRecordObject(value)
    || typeof value['id'] !== 'string'
    || typeof value['kind'] !== 'string' || !STORED_KINDS.has(value['kind'])
    || typeof value['title'] !== 'string'
    || typeof value['detail'] !== 'string'
    || !Array.isArray(value['options']) || !value['options'].every((option) => typeof option === 'string')
    || typeof value['createdAt'] !== 'number'
    || !optionalString(value['key']) || !optionalString(value['sessionId'])
    || !optionalString(value['askedBy']) || !optionalString(value['postedBy'])
    || (value['expiresAt'] !== undefined && typeof value['expiresAt'] !== 'number')
    || (value['metadata'] !== undefined && !isRecordObject(value['metadata']))) {
    throw new Error('not an owner item');
  }
  return value as unknown as StoredOwnerItem;
}

function readAnswer(value: unknown): OwnerAnswer {
  if (!isRecordObject(value) || !optionalString(value['option']) || !optionalString(value['text'])) throw new Error('not an answer');
  return value as OwnerAnswer;
}

function readSource(value: unknown): OwnerAnswerSource {
  if (!isRecordObject(value) || typeof value['actor'] !== 'string' || typeof value['surface'] !== 'string') throw new Error('not an answer source');
  return value as unknown as OwnerAnswerSource;
}

function metadataText(item: Pick<StoredOwnerItem, 'metadata'>, key: string): string | null {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isClosed(entry: StoredOwnerEntry): boolean {
  return entry.closedAt !== undefined;
}

export class QuestionStore implements RevisionSource {
  readonly id = 'owner questions';
  readonly #path: string;
  #file: SqliteFile | null = null;
  /** Every row as of `revision`; read again only when the revision moved. */
  #snapshot: { readonly revision: number; readonly entries: ReadonlyMap<string, StoredOwnerEntry> } | null = null;

  constructor(options: { readonly path: string }) {
    this.#path = options.path;
  }

  get path(): string {
    return this.#path;
  }

  /** Moves on every post, answer, withdrawal and delivery, made by this process or any other. */
  revision(): number {
    return this.#open().revision();
  }

  get(id: string): StoredOwnerEntry | undefined {
    return this.#entries().get(id);
  }

  has(id: string): boolean {
    return this.#entries().has(id);
  }

  entries(): IterableIterator<StoredOwnerEntry> {
    return this.#entries().values();
  }

  /**
   * One asker's open questions and the answers it has not taken yet: what a
   * session or agent picks up when it is opened again. One indexed read.
   */
  undelivered(scope: QuestionAskerScope): StoredOwnerEntry[] {
    const file = this.#open();
    const clauses: string[] = [];
    const params: string[] = [];
    if (scope.session !== undefined) { clauses.push('answer_session = ?'); params.push(scope.session); }
    if (scope.agent !== undefined) { clauses.push('answer_agent = ?'); params.push(scope.agent); }
    if (clauses.length === 0) return [];
    const rows = file.db.query<ItemRow, string[]>(
      `SELECT ${ROW_COLUMNS} FROM owner_items WHERE (${clauses.join(' OR ')}) AND ${UNDELIVERED}`,
    ).all(...params);
    // The index finds the id; the saved file tells namesakes in another app or project apart.
    return rows.map((row) => this.#decode(row)).filter((entry): entry is StoredOwnerEntry => entry !== null && inScope(entry, scope));
  }

  /**
   * Append a new item, or return the open one a producer already posted under
   * the same key. `stillOpen` says whether that one still counts (an expired
   * item does not). Checked and written in one transaction, so two processes
   * posting the same key at once ask once.
   */
  post(
    item: Omit<StoredOwnerItem, 'id' | 'createdAt'>,
    now: number,
    stillOpen: (entry: StoredOwnerEntry) => boolean,
  ): { readonly created: boolean; readonly entry: StoredOwnerEntry } {
    const file = this.#open();
    return file.tx(() => {
      if (item.key !== undefined) {
        const rows = file.db.query<ItemRow, [string, string]>(
          `SELECT ${ROW_COLUMNS} FROM owner_items WHERE kind = ? AND item_key = ? AND closed_at IS NULL`,
        ).all(item.kind, item.key);
        for (const row of rows) {
          const existing = this.#decode(row);
          if (existing && stillOpen(existing)) return { created: false, entry: existing };
        }
      }
      // Short enough to type as an answer target; 48 random bits is ample for one owner's inbox.
      const stored: StoredOwnerItem = { ...item, id: `q-${randomUUID().replace(/-/g, '').slice(0, 12)}`, createdAt: now };
      file.db.query<never, [string, string, string | null, string | null, string | null, string, number, number]>(
        'INSERT INTO owner_items (id, kind, item_key, answer_session, answer_agent, item, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        stored.id, stored.kind, stored.key ?? null,
        metadataText(stored, OWNER_ANSWER_SESSION_METADATA), metadataText(stored, OWNER_ANSWER_AGENT_METADATA),
        JSON.stringify(stored), now, now,
      );
      return { created: true, entry: { item: stored, updatedAt: now } };
    });
  }

  /** Record the first answer; a later one changes nothing. Expiry is the caller's check. */
  answer(id: string, answer: OwnerAnswer, by: OwnerAnswerSource, now: number): QuestionStoreAnswerResult | undefined {
    return this.#close(id, 'answer = ?, answered_by = ?', [JSON.stringify(answer), JSON.stringify(by)], now);
  }

  /** The producer takes an open item back (its window closed, its session ended). */
  withdraw(id: string, reason: string, now: number): QuestionStoreAnswerResult | undefined {
    return this.#close(id, 'withdrawn_reason = ?', [reason], now);
  }

  /**
   * Record what became of an answer. Only an answered item takes one, and only
   * once: a second report changes nothing and returns the first, so of two
   * processes holding the asking session, exactly one hands the answer over.
   */
  recordDelivery(id: string, state: StoredAnswerDelivery['state'], reason: string | undefined, now: number): QuestionStoreAnswerResult | undefined {
    const file = this.#open();
    const changed = file.db.query<never, [string, string | null, number, number, string]>(
      'UPDATE owner_items SET delivery_state = ?, delivery_reason = ?, delivery_at = ?, updated_at = ? WHERE id = ? AND answer IS NOT NULL AND delivery_state IS NULL',
    ).run(state, reason ?? null, now, now, id).changes;
    const entry = this.#read(id);
    if (!entry) return undefined;
    return changed > 0 ? { applied: true, entry } : { applied: false, entry };
  }

  /**
   * A session will never be opened again (deleted, or a hosted session ended):
   * its open questions are withdrawn and its waiting answers marked not
   * deliverable, in one transaction. `sessionFile` is the session's identity
   * (see {@link sessionFileMatches}); a namesake's questions are left alone.
   * Returns the ids it changed.
   */
  settleSession(sessionId: string, withdrawnReason: string, undeliverableReason: string, now: number, sessionFile?: string): string[] {
    const file = this.#open();
    return file.tx(() => {
      const rows = file.db.query<ItemRow, [string]>(
        `SELECT ${ROW_COLUMNS} FROM owner_items WHERE answer_session = ? AND ${UNDELIVERED}`,
      ).all(sessionId);
      const ids = rows
        .map((row) => this.#decode(row))
        .filter((entry): entry is StoredOwnerEntry => entry !== null && inScope(entry, { session: sessionId, sessionFile }))
        .map((entry) => entry.item.id);
      for (const id of ids) {
        file.db.query<never, [string, number, number, string]>(
          'UPDATE owner_items SET withdrawn_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL',
        ).run(withdrawnReason, now, now, id);
        file.db.query<never, [string, number, number, string]>(
          "UPDATE owner_items SET delivery_state = 'undeliverable', delivery_reason = ?, delivery_at = ?, updated_at = ? WHERE id = ? AND answer IS NOT NULL AND delivery_state IS NULL",
        ).run(undeliverableReason, now, now, id);
      }
      return ids;
    });
  }

  close(): void {
    this.#file?.close();
    this.#file = null;
    this.#snapshot = null;
  }

  #close(id: string, assignments: string, values: readonly string[], now: number): QuestionStoreAnswerResult | undefined {
    const file = this.#open();
    const changed = file.db.query<never, (string | number)[]>(
      `UPDATE owner_items SET ${assignments}, closed_at = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL`,
    ).run(...values, now, now, id).changes;
    const entry = this.#read(id);
    if (!entry) return undefined;
    return changed > 0 && isClosed(entry) ? { applied: true, entry } : { applied: false, entry };
  }

  #read(id: string): StoredOwnerEntry | undefined {
    const row = this.#open().db.query<ItemRow, [string]>(`SELECT ${ROW_COLUMNS} FROM owner_items WHERE id = ?`).get(id);
    return row ? this.#decode(row) ?? undefined : undefined;
  }

  #entries(): ReadonlyMap<string, StoredOwnerEntry> {
    const file = this.#open();
    const revision = file.revision();
    if (this.#snapshot && this.#snapshot.revision === revision) return this.#snapshot.entries;
    const entries = new Map<string, StoredOwnerEntry>();
    for (const row of file.db.query<ItemRow, []>(`SELECT ${ROW_COLUMNS} FROM owner_items`).all()) {
      const entry = this.#decode(row);
      if (entry) entries.set(entry.item.id, entry);
    }
    this.#snapshot = { revision, entries };
    return entries;
  }

  #decode(row: ItemRow): StoredOwnerEntry | null {
    try {
      const item = readStoredItem(JSON.parse(row.item));
      const delivery = row.delivery_state === 'delivered' || row.delivery_state === 'undeliverable'
        ? { state: row.delivery_state, ...(row.delivery_reason !== null ? { reason: row.delivery_reason } : {}), at: row.delivery_at ?? row.updated_at } as const
        : undefined;
      return {
        item,
        ...(row.answer !== null ? { answer: readAnswer(JSON.parse(row.answer)) } : {}),
        ...(row.answered_by !== null ? { answeredBy: readSource(JSON.parse(row.answered_by)) } : {}),
        ...(row.withdrawn_reason !== null ? { withdrawnReason: row.withdrawn_reason } : {}),
        ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
        ...(delivery !== undefined ? { delivery } : {}),
        updatedAt: row.updated_at,
      };
    } catch (error) {
      logger.warn('[owner-inbox] skipped a damaged row in the owner inbox store', {
        path: this.#path,
        id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  #open(): SqliteFile {
    if (this.#file) return this.#file;
    const file = openSqliteFile(this.#path, { name: 'owner inbox', migrations: MIGRATIONS });
    this.#file = file;
    this.#trimOnOpen(file);
    return file;
  }

  /**
   * Keep every open item, every answer still waiting for its asker, and the
   * newest closed ones. Runs once per process, when the store is first opened;
   * it writes only when there is more than that to drop.
   */
  #trimOnOpen(file: SqliteFile): void {
    try {
      const closed = file.db.query<{ n: number }, []>('SELECT count(*) AS n FROM owner_items WHERE closed_at IS NOT NULL').get()?.n ?? 0;
      if (closed <= MAX_CLOSED_ENTRIES) return;
      file.db.query<never, [number]>(
        `DELETE FROM owner_items WHERE closed_at IS NOT NULL
          AND NOT (answer IS NOT NULL AND delivery_state IS NULL AND (answer_session IS NOT NULL OR answer_agent IS NOT NULL))
          AND id NOT IN (SELECT id FROM owner_items WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?)`,
      ).run(MAX_CLOSED_ENTRIES);
    } catch (error) {
      logger.warn('[owner-inbox] could not drop old answered items; the store keeps them until the next start', {
        path: this.#path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const sharedStores = new Map<string, QuestionStore>();

/**
 * The store at `path`, one per process: the daemon's inbox, a terminal's
 * `/questions`, its `query` tools and the answer delivery of its sessions and
 * agents all read through one connection.
 */
export function sharedQuestionStore(path: string): QuestionStore {
  let store = sharedStores.get(path);
  if (!store) {
    store = new QuestionStore({ path });
    sharedStores.set(path, store);
  }
  return store;
}
