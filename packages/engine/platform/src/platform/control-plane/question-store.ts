/**
 * The owner inbox's own items: questions an agent left, channel claims,
 * purchase windows and queued actions. Approvals are not stored here; they stay
 * in the approval broker and the inbox reads them from it.
 *
 * Kept on a record log: a post, an answer and a withdrawal are each one
 * appended line, synced before the call returns because the person or agent
 * on the other side is told it is saved. The latest state of every item is
 * folded in memory at open, so a list is a map walk and an answer is one
 * append. One process (the daemon) writes the file.
 *
 * First answer wins: an answer to an item that is no longer open changes
 * nothing and reports who answered it.
 */
import { randomUUID } from 'node:crypto';
import { openRecordLog, type RecordLog } from '../state/record-log.js';
import type { RevisionSource } from '../utils/revision.js';
import { logger } from '../utils/logger.js';
import type { OwnerAnswer, OwnerAnswerSource, OwnerItemKind } from './owner-inbox.js';

/** Item kinds the question store holds; approvals live in the approval broker. */
export type StoredOwnerItemKind = Exclude<OwnerItemKind, 'approval'>;

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

export interface StoredOwnerEntry {
  readonly item: StoredOwnerItem;
  readonly answer?: OwnerAnswer | undefined;
  readonly answeredBy?: OwnerAnswerSource | undefined;
  readonly withdrawnReason?: string | undefined;
  readonly closedAt?: number | undefined;
  readonly updatedAt: number;
}

type QuestionLogRecord =
  | { readonly v: 1; readonly op: 'post'; readonly item: StoredOwnerItem }
  | { readonly v: 1; readonly op: 'answer'; readonly id: string; readonly answer: OwnerAnswer; readonly by: OwnerAnswerSource; readonly at: number }
  | { readonly v: 1; readonly op: 'withdraw'; readonly id: string; readonly reason: string; readonly at: number };

export type QuestionStoreAnswerResult =
  | { readonly applied: true; readonly entry: StoredOwnerEntry }
  | { readonly applied: false; readonly entry: StoredOwnerEntry };

/** Closed items kept for the history view; open items are never dropped. */
const MAX_CLOSED_ENTRIES = 500;
const STORED_KINDS: ReadonlySet<string> = new Set<StoredOwnerItemKind>(['question', 'claim', 'purchase', 'queued-action']);

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

function decodeRecord(line: string): QuestionLogRecord {
  const value: unknown = JSON.parse(line);
  if (!isRecordObject(value) || value['v'] !== 1) throw new Error('unknown record version');
  switch (value['op']) {
    case 'post':
      return { v: 1, op: 'post', item: readStoredItem(value['item']) };
    case 'answer':
      if (typeof value['id'] !== 'string' || typeof value['at'] !== 'number') throw new Error('malformed answer');
      return { v: 1, op: 'answer', id: value['id'], answer: readAnswer(value['answer']), by: readSource(value['by']), at: value['at'] };
    case 'withdraw':
      if (typeof value['id'] !== 'string' || typeof value['reason'] !== 'string' || typeof value['at'] !== 'number') throw new Error('malformed withdrawal');
      return { v: 1, op: 'withdraw', id: value['id'], reason: value['reason'], at: value['at'] };
    default:
      throw new Error('unknown record operation');
  }
}

function isClosed(entry: StoredOwnerEntry): boolean {
  return entry.closedAt !== undefined;
}

export class QuestionStore implements RevisionSource {
  readonly id = 'owner questions';
  readonly #path: string;
  #log: RecordLog<QuestionLogRecord> | null = null;
  #entries = new Map<string, StoredOwnerEntry>();
  /** Open item id per `${kind}\u0000${key}`. */
  #openKeys = new Map<string, string>();
  #revision = 0;

  constructor(options: { readonly path: string }) {
    this.#path = options.path;
  }

  get path(): string {
    return this.#path;
  }

  /** Moves on every post, answer and withdrawal. */
  revision(): number {
    return this.#revision;
  }

  get(id: string): StoredOwnerEntry | undefined {
    this.#open();
    return this.#entries.get(id);
  }

  has(id: string): boolean {
    this.#open();
    return this.#entries.has(id);
  }

  entries(): IterableIterator<StoredOwnerEntry> {
    this.#open();
    return this.#entries.values();
  }

  /** The open item a producer already posted under `key`, if any. */
  findOpen(kind: StoredOwnerItemKind, key: string): StoredOwnerEntry | undefined {
    this.#open();
    const id = this.#openKeys.get(`${kind}\u0000${key}`);
    return id === undefined ? undefined : this.#entries.get(id);
  }

  /** Append a new item. The caller validated it; `id` and `createdAt` are assigned here. */
  post(item: Omit<StoredOwnerItem, 'id' | 'createdAt'>, now: number): StoredOwnerEntry {
    const log = this.#open();
    // Short enough to type as an answer target; 48 random bits is ample for one owner's inbox.
    const record: QuestionLogRecord = { v: 1, op: 'post', item: { ...item, id: `q-${randomUUID().replace(/-/g, '').slice(0, 12)}`, createdAt: now } };
    log.append(record);
    this.#apply(record);
    return this.#entry(record.item.id);
  }

  /** Record the first answer; a later one changes nothing. Expiry is the caller's check. */
  answer(id: string, answer: OwnerAnswer, by: OwnerAnswerSource, now: number): QuestionStoreAnswerResult | undefined {
    const log = this.#open();
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (isClosed(entry)) return { applied: false, entry };
    const record: QuestionLogRecord = { v: 1, op: 'answer', id, answer, by, at: now };
    log.append(record);
    this.#apply(record);
    return { applied: true, entry: this.#entry(id) };
  }

  /** The producer takes an open item back (its window closed, its session ended). */
  withdraw(id: string, reason: string, now: number): QuestionStoreAnswerResult | undefined {
    const log = this.#open();
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (isClosed(entry)) return { applied: false, entry };
    const record: QuestionLogRecord = { v: 1, op: 'withdraw', id, reason, at: now };
    log.append(record);
    this.#apply(record);
    return { applied: true, entry: this.#entry(id) };
  }

  close(): void {
    this.#log?.close();
    this.#log = null;
  }

  #open(): RecordLog<QuestionLogRecord> {
    if (this.#log) return this.#log;
    const log = openRecordLog<QuestionLogRecord>(this.#path, { fsync: 'each', decode: decodeRecord });
    for (const record of log.scan()) this.#apply(record);
    this.#log = log;
    this.#trimOnOpen(log);
    return log;
  }

  #apply(record: QuestionLogRecord): void {
    if (record.op === 'post') {
      if (this.#entries.has(record.item.id)) return;
      this.#entries.set(record.item.id, { item: record.item, updatedAt: record.item.createdAt });
      if (record.item.key !== undefined) this.#openKeys.set(`${record.item.kind}\u0000${record.item.key}`, record.item.id);
      this.#revision += 1;
      return;
    }
    const entry = this.#entries.get(record.id);
    if (!entry) {
      logger.warn('[owner-inbox] a record names an item the log does not hold', { path: this.#path, id: record.id });
      return;
    }
    // The first close wins; a later answer line in the log changes nothing.
    if (isClosed(entry)) return;
    const next: StoredOwnerEntry = record.op === 'answer'
      ? { ...entry, answer: record.answer, answeredBy: record.by, closedAt: record.at, updatedAt: record.at }
      : { ...entry, withdrawnReason: record.reason, closedAt: record.at, updatedAt: record.at };
    this.#entries.set(record.id, next);
    if (entry.item.key !== undefined) this.#openKeys.delete(`${entry.item.kind}\u0000${entry.item.key}`);
    this.#revision += 1;
  }

  #entry(id: string): StoredOwnerEntry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`Owner item ${id} was written but is not in memory.`);
    return entry;
  }

  /**
   * Keep every open item and the newest closed ones. Runs once, when the log is
   * first opened, and only rewrites the file when it holds far more than it keeps.
   */
  #trimOnOpen(log: RecordLog<QuestionLogRecord>): void {
    const closed = [...this.#entries.values()].filter(isClosed);
    if (closed.length <= MAX_CLOSED_ENTRIES) return;
    closed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    const dropped = new Set(closed.slice(MAX_CLOSED_ENTRIES).map((entry) => entry.item.id));
    for (const id of dropped) this.#entries.delete(id);
    // A kept item has at most two records (post, close); rewrite only when the file holds twice that and more.
    if (log.size < 4 * this.#entries.size + 100) return;
    void log.compact((record) => !dropped.has(record.op === 'post' ? record.item.id : record.id)).catch((error: unknown) => {
      logger.warn('[owner-inbox] could not compact the question log; it keeps growing until the next start', {
        path: this.#path,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
