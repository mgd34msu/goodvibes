import type { Database, Statement } from 'bun:sqlite';
import type { JsonValue } from '../port/types.ts';
import type { DecisionEntry, DecisionId, DecisionLog, DecisionNote, DecisionQuery, DecisionRetention, DecisionSummary, DecisionTruth, DecisionVolumeEntry, NewDecisionEntry } from './types.ts';
import { decisionVolumeRow, type DecisionVolumeRow } from './volume-row.ts';
import { COLUMNS, META_TABLE, NOTES_TABLE, QUESTIONS_TABLE, TABLE, openLog, openSyncedWriter, rowsOf, type Params } from './sqlite-schema.ts';

/** What reading an entry back needs from its row. */
interface Row {
  readonly id: string;
  readonly entry: string;
  /** The row's questions from the questions table; null on a row that still carries them in `entry`. */
  readonly questions: string | null;
  readonly notes: string;
}

/** The file's page accounting and vacuum mode, for the retention pass (state/decision-log.ts). */
export interface DecisionLogStorage {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freePages: number;
  /** `incremental`: freed pages go back with `reclaim`; `none`: an older file, until `finishCarryForward` rewrites it once. */
  readonly vacuum: 'none' | 'full' | 'incremental';
  /** Rows written before version 6 that still carry their questions in the row. */
  readonly rowsToCarry: number;
}

/** What carrying an older file forward gave back: its size before and after. */
export interface DecisionLogCarriedForward {
  readonly fromBytes: number;
  readonly toBytes: number;
}

/** One row of the payload-free summary read. */
interface SummaryRow {
  readonly id: string;
  readonly status: DecisionEntry['status'];
  readonly requested_model: string | null;
  readonly model: string | null;
}

/** The kinds of note; the ordered note table holds every one. */
type NoteColumn = DecisionNote['kind'];
/** How a note of one kind is written to the notes table and read back. */
interface NoteCodec<N extends DecisionNote> {
  write(note: N): string;
  read(text: string): N;
}
const NOTE_CODECS: { readonly [K in NoteColumn]: NoteCodec<Extract<DecisionNote, { kind: K }>> } = {
  readings: { write: (note) => JSON.stringify(note.readings), read: (text) => ({ kind: 'readings', readings: JSON.parse(text) as JsonValue }) },
  action: { write: (note) => note.action, read: (text) => ({ kind: 'action', action: text }) },
  truth: { write: (note) => JSON.stringify(note.truth), read: (text) => ({ kind: 'truth', truth: JSON.parse(text) as DecisionTruth }) },
};
/** A new row stores its id, the entry without its questions, and their key; SQLite derives the rest, and notes attach later. */
const INSERT_COLUMNS = ['id', 'entry', 'questions_hash'] as const satisfies readonly (keyof typeof COLUMNS)[];
type InsertParams = Readonly<Record<(typeof INSERT_COLUMNS)[number], string>>;
const codecFor = (column: NoteColumn): NoteCodec<DecisionNote> => NOTE_CODECS[column] as NoteCodec<DecisionNote>;

/** An entry split for storage: the row's text without its questions, and the questions with their key. */
interface StoredEntry {
  readonly entry: string;
  readonly questions: string;
  readonly hash: string;
}

/** Splits an entry's questions from the rest of it; equal question sets get equal keys. */
function splitQuestions(entry: NewDecisionEntry | Readonly<Record<string, unknown>>): StoredEntry {
  const { questions, ...rest } = entry as Readonly<Record<string, unknown>>;
  const text = JSON.stringify(questions ?? null);
  return { entry: JSON.stringify(rest), questions: text, hash: Bun.CryptoHasher.hash('sha256', text, 'hex') };
}

const toParams = (id: DecisionId, stored: StoredEntry): InsertParams => ({ id, entry: stored.entry, questions_hash: stored.hash });

function toEntry(row: Row): DecisionEntry {
  const parsed = JSON.parse(row.entry) as NewDecisionEntry;
  const entry = { ...parsed, ...(row.questions === null ? {} : { questions: JSON.parse(row.questions) as JsonValue }), id: row.id as DecisionId };
  if (entry.status === 'failed') return entry;
  const saved = JSON.parse(row.notes) as { kind: NoteColumn; payload: string }[];
  const notes = saved.map(note => codecFor(note.kind).read(note.payload));
  return { ...entry, notes };
}

/** Every value is bound under its column's name. */
const param = (column: keyof typeof COLUMNS): string => `$${column}`;
const equals = (column: keyof typeof COLUMNS): string => `${column} = ${param(column)}`;
const ID_IS = equals('id');
/** Entry and ID projections must retain exactly the same window semantics. */
const matchingWindow = (conditions: readonly string[]) =>
  `FROM ${TABLE} WHERE ${['TRUE', ...conditions].join(' AND ')} ORDER BY at DESC, id DESC LIMIT $limit`;
/** Every statement the log runs. */
const SQL = {
  insert: `INSERT INTO ${TABLE} (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(param).join(', ')})`,
  /** A question set is written once; every later decision asking it names it by its key. */
  insertQuestions: `INSERT OR IGNORE INTO ${QUESTIONS_TABLE} (hash, questions) VALUES ($hash, $questions)`,
  /** Rows written before version 6, a batch at a time (found through the questions-key index). */
  legacyRows: `SELECT id, entry FROM ${TABLE} WHERE questions_hash IS NULL LIMIT $limit`,
  legacyCount: `SELECT count(*) AS n FROM ${TABLE} WHERE questions_hash IS NULL`,
  carryRow: `UPDATE ${TABLE} SET entry = $entry, questions_hash = $hash WHERE id = $id AND questions_hash IS NULL`,
  /** The question sets a batch of entries names, read before the entries go. */
  batchQuestionKeys: `SELECT DISTINCT questions_hash AS hash FROM ${TABLE} WHERE questions_hash IS NOT NULL AND id IN (SELECT value FROM json_each($ids))`,
  /** A question set no remaining entry names. */
  deleteOrphanQuestions: `DELETE FROM ${QUESTIONS_TABLE} WHERE hash IN (SELECT value FROM json_each($hashes))
    AND NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE questions_hash = ${QUESTIONS_TABLE}.hash)`,
  carriedFrom: `SELECT value FROM ${META_TABLE} WHERE key = 'carried_from_bytes'`,
  forgetCarriedFrom: `DELETE FROM ${META_TABLE} WHERE key = 'carried_from_bytes'`,
  /** A note attaches only to an answered entry; one statement, so it needs no transaction. */
  append: `INSERT INTO ${NOTES_TABLE} (decision_id, kind, payload)
    SELECT $id, $kind, $payload WHERE EXISTS (SELECT 1 FROM ${TABLE} WHERE ${ID_IS} AND status = 'answered')`,
  /**
   * Many notes in one statement, in the order given; a note whose entry is
   * not answered is left out. Returns the decision of each note written.
   */
  appendMany: `INSERT INTO ${NOTES_TABLE} (decision_id, kind, payload)
    SELECT json_extract(note.value, '$.id'), json_extract(note.value, '$.kind'), json_extract(note.value, '$.payload')
    FROM json_each($notes) AS note
    WHERE EXISTS (SELECT 1 FROM ${TABLE} WHERE id = json_extract(note.value, '$.id') AND status = 'answered')
    ORDER BY note.key
    RETURNING decision_id`,
  /** The entry at a position from the newest, by time then id; the row cap keeps it and every newer one. */
  nthNewest: `SELECT at, id FROM ${TABLE} ORDER BY at DESC, id DESC LIMIT 1 OFFSET $offset`,
  count: `SELECT count(*) AS n FROM ${TABLE}`,
  /**
   * Entries the retention rule no longer keeps, oldest first: older than
   * $before, or past the row cap (before the capping entry by time then id, so
   * entries tied on its time count too). An entry with a truth note always stays.
   */
  expired: `SELECT id FROM ${TABLE} WHERE at <= $bound AND (at < $before OR at < $capAt OR (at = $capAt AND id < $capId))
    AND NOT EXISTS (SELECT 1 FROM ${NOTES_TABLE} WHERE decision_id = ${TABLE}.id AND kind = 'truth')
    ORDER BY at, id LIMIT $limit`,
  deleteNotes: `DELETE FROM ${NOTES_TABLE} WHERE decision_id IN (SELECT value FROM json_each($ids))`,
  deleteEntries: `DELETE FROM ${TABLE} WHERE id IN (SELECT value FROM json_each($ids))`,
  /** Looked up by primary key; reads two small fields of the entry, never its questions, answers or notes. */
  summaries: `SELECT id, status, json_extract(entry, '$.requestedModel') AS requested_model, json_extract(entry, '$.model') AS model
    FROM ${TABLE} WHERE id IN (SELECT value FROM json_each($ids))`,
  /** Newest first, up to $limit, meeting every condition given. */
  matching: (conditions: readonly string[]) =>
    `SELECT ${TABLE}.id, ${TABLE}.entry,
       (SELECT questions FROM ${QUESTIONS_TABLE} WHERE hash = ${TABLE}.questions_hash) AS questions,
       (SELECT json_group_array(json_object('kind', kind, 'payload', payload)) FROM
         (SELECT kind, payload FROM ${NOTES_TABLE} WHERE decision_id = ${TABLE}.id ORDER BY seq)) AS notes
     ${matchingWindow(conditions)}`,
  matchingIds: (conditions: readonly string[]) => `SELECT ${TABLE}.id ${matchingWindow(conditions)}`,
  /** Limit the indexed entry window before expanding only its lineage.
   * No question, answer or note payload is returned. */
  volume: (conditions: readonly string[]) => `WITH selected AS (
      SELECT id, at, battery, site,
        json_type(entry, '$.context') AS context_kind,
        json_type(entry, '$.context.battery') AS battery_kind,
        json_type(entry, '$.context.site') AS site_kind,
        json_type(entry, '$.lineage') AS lineage_kind,
        CASE WHEN json_type(entry, '$.lineage') = 'object' THEN json_extract(entry, '$.lineage') END AS lineage
      FROM ${TABLE} WHERE ${['TRUE', ...conditions].join(' AND ')}
      ORDER BY at DESC, id DESC LIMIT $limit
    ) SELECT selected.id, selected.battery, selected.site,
      selected.context_kind, selected.battery_kind, selected.site_kind, selected.lineage_kind,
      json_extract(selected.lineage, '$.logicalRequestId') AS logical_id,
      json_type(selected.lineage, '$.logicalRequestId') AS logical_kind,
      json_type(selected.lineage, '$.attempts') AS attempts_kind,
      json_array_length(selected.lineage, '$.attempts') AS attempt_count,
      json_extract(selected.lineage, '$.omittedAttempts') AS omitted_count,
      json_type(selected.lineage, '$.omittedAttempts') AS omitted_kind,
      sum(CASE WHEN attempt.type = 'object'
        THEN CASE WHEN json_type(attempt.value, '$.dispatched') = 'true' THEN 1 ELSE 0 END ELSE 0 END) AS wire_attempts,
      sum(CASE WHEN attempt.type = 'object'
        THEN CASE WHEN json_type(attempt.value, '$.dispatched') IS NULL THEN 1 ELSE 0 END ELSE 0 END) AS unknown_attempts,
      sum(CASE WHEN attempt.key IS NULL THEN 0 WHEN attempt.type <> 'object' THEN 1
        WHEN json_type(attempt.value, '$.dispatched') IS NULL OR json_type(attempt.value, '$.dispatched') IN ('true', 'false') THEN 0
        ELSE 1 END) AS invalid_attempts
    FROM selected LEFT JOIN json_each(selected.lineage, '$.attempts') AS attempt ON TRUE
    GROUP BY selected.id ORDER BY selected.at DESC, selected.id DESC`,
};

const OUTCOME_FILTER =
  `EXISTS (SELECT 1 FROM ${NOTES_TABLE}, json_tree(${NOTES_TABLE}.payload)
    WHERE decision_id = ${TABLE}.id AND kind = 'readings'
      AND json_tree.key = 'outcome' AND json_tree.type = 'text' AND json_tree.atom = $outcome)`;

/** The condition each query filter puts on a row; the filter's value is bound under the filter's own name. */
const FILTERS: Readonly<Record<Exclude<keyof DecisionQuery, 'limit'>, string>> = {
  battery: equals('battery'),
  site: equals('site'),
  excludeSite: '(site IS NULL OR site <> $excludeSite)',
  since: 'at >= $since',
  until: 'at < $until',
  outcome: OUTCOME_FILTER,
  status: equals('status'),
};

/** The WHERE clauses and parameters for a query. */
function filterFor(query: DecisionQuery): { where: string[]; params: Params } {
  const active = (Object.keys(FILTERS) as (keyof typeof FILTERS)[]).flatMap((name) => {
    const value = query[name];
    return value === undefined ? [] : [{ name, value }];
  });
  return { where: active.map(({ name }) => FILTERS[name]), params: Object.fromEntries(active.map(({ name, value }) => [name, value])) };
}

/** A note waiting for the next batched write, and who hears if it is not written. */
interface PendingNote {
  readonly id: string;
  readonly kind: NoteColumn;
  readonly payload: string;
  readonly onUnrecorded: () => void;
}

/**
 * A decision log in a SQLite file (or `:memory:`), created on first use.
 *
 * Two connections, each with its sync mode set once at open, so no write
 * switches modes:
 * - Synced (FULL): every entry, an entry written with its notes, and a note
 *   attached directly (truth notes: owner corrections, outcomes, calibration
 *   fixtures). A caller acts on the answer an entry records, and contract and
 *   work-ledger proofs read entries back by id later, so an entry is on disk
 *   before `record` returns.
 * - Unsynced (NORMAL): readings and action notes written through
 *   `attachLater`, batched into one statement per turn, and pruning. After a
 *   power loss the newest of these can be missing, never an entry, and the
 *   file is never damaged; the next synced commit also makes them durable.
 */
export class SqliteDecisionLog implements DecisionLog, Disposable {
  readonly #db: Database;
  /** The synced writer; the same connection when the log is in memory. */
  readonly #synced: Database;
  /** The writing statements, prepared once. */
  readonly #insert: Statement;
  readonly #insertQuestions: Statement;
  readonly #append: Statement;
  readonly #appendMany: Statement;
  #pending: PendingNote[] = [];
  #flushQueued = false;

  constructor(path: string) {
    this.#db = openLog(path);
    try { this.#synced = openSyncedWriter(path, this.#db); }
    catch (error) { this.#db.close(); throw error; }
    this.#insert = this.#synced.prepare(SQL.insert);
    this.#insertQuestions = this.#synced.prepare(SQL.insertQuestions);
    this.#append = this.#synced.prepare(SQL.append);
    this.#appendMany = this.#db.prepare(SQL.appendMany);
  }

  /**
   * One synced commit per entry, as before version 6: the question set's row (written only the first time
   * that set is asked) and the entry's row go in the same transaction.
   */
  record(entry: NewDecisionEntry): DecisionId {
    const id = Bun.randomUUIDv7() as DecisionId;
    const stored = splitQuestions(entry);
    this.#synced.transaction(() => {
      this.#insertQuestions.run({ hash: stored.hash, questions: stored.questions });
      this.#insert.run(toParams(id, stored));
    }).immediate();
    return id;
  }

  recordWithNotes(entry: NewDecisionEntry, notes: readonly DecisionNote[]): DecisionId {
    const id = Bun.randomUUIDv7() as DecisionId;
    const stored = splitQuestions(entry);
    this.#synced.transaction(() => {
      this.#insertQuestions.run({ hash: stored.hash, questions: stored.questions });
      this.#insert.run(toParams(id, stored));
      for (const note of notes) this.#note(id, note);
    }).immediate();
    return id;
  }

  attach(id: string, note: DecisionNote): void {
    this.flushNotes();
    this.#note(id, note);
  }

  /**
   * Queues a note for the batched write at the end of this turn: one
   * statement for every note queued in the turn, unsynced. Never throws; a
   * note that cannot be written (its entry is not answered, or the write
   * fails) calls `onUnrecorded`. Every read and write of this log writes the
   * queue first, so this log never reads without its own notes.
   */
  attachLater(id: string, note: DecisionNote, onUnrecorded: () => void): void {
    let payload: string;
    try { payload = codecFor(note.kind).write(note); }
    catch { onUnrecorded(); return; }
    this.#pending.push({ id, kind: note.kind, payload, onUnrecorded });
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => this.flushNotes());
  }

  /** Writes the queued notes now, in one statement. */
  flushNotes(): void {
    this.#flushQueued = false;
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    let written: Set<string>;
    try {
      const rows = this.#appendMany.all({ notes: JSON.stringify(batch.map(({ id, kind, payload }) => ({ id, kind, payload }))) }) as { decision_id: string }[];
      written = new Set(rows.map(row => row.decision_id));
    } catch {
      written = new Set();
    }
    for (const note of batch) {
      if (written.has(note.id)) continue;
      try { note.onUnrecorded(); } catch { /* a listener cannot turn finished work into a failure */ }
    }
  }

  #note(id: string, note: DecisionNote): void {
    const { changes } = this.#append.run({ id, kind: note.kind, payload: codecFor(note.kind).write(note) });
    if (changes !== 1) throw new RangeError(`decision ${id} cannot take a ${note.kind} note`);
  }

  prune(rule: DecisionRetention): number {
    if (!Number.isSafeInteger(rule.batch) || rule.batch < 1 || !Number.isSafeInteger(rule.maxEntries) || rule.maxEntries < 1) {
      throw new RangeError('Decision log retention needs a positive batch and entry cap.');
    }
    this.flushNotes();
    // Exactly the newest `maxEntries` stay under the cap: ties on the capping time are broken by id.
    // Only a log holding more than the cap looks for the capping entry: that read sorts every row by time and id.
    const total = rowsOf<{ readonly n: number }>(this.#db, SQL.count)[0]?.n ?? 0;
    const capped = total > rule.maxEntries ? rowsOf<{ readonly at: string; readonly id: string }>(this.#db, SQL.nthNewest, { offset: rule.maxEntries - 1 })[0] : undefined;
    return this.#db.transaction(() => {
      // `bound` is the later of the two cut-offs, so the search walks the time index up to it instead of
      // reading every row's time out of its entry (a whole-table pass of a large log held the file for long).
      const capAt = capped?.at ?? '';
      const ids = rowsOf<{ readonly id: string }>(this.#db, SQL.expired, {
        bound: capAt > rule.before ? capAt : rule.before, before: rule.before, capAt, capId: capped?.id ?? '', limit: rule.batch,
      }).map(row => row.id);
      if (ids.length === 0) return 0;
      const list = JSON.stringify(ids);
      const hashes = rowsOf<{ readonly hash: string }>(this.#db, SQL.batchQuestionKeys, { ids: list }).map(row => row.hash);
      this.#db.query(SQL.deleteNotes).run({ ids: list });
      this.#db.query(SQL.deleteEntries).run({ ids: list });
      if (hashes.length > 0) this.#db.query(SQL.deleteOrphanQuestions).run({ hashes: JSON.stringify(hashes) });
      return ids.length;
    }).immediate();
  }

  /**
   * Moves the questions of up to `batch` rows written before version 6 into the questions table, each row
   * keeping everything else; returns how many rows it moved. One unsynced transaction per call. An entry
   * read back is the same before and after (`get`, `query`).
   */
  carryForward(batch: number): number {
    if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError('Carrying the decision log forward needs a positive batch.');
    this.flushNotes();
    return this.#db.transaction(() => {
      const rows = rowsOf<{ readonly id: string; readonly entry: string }>(this.#db, SQL.legacyRows, { limit: batch });
      const questions = this.#db.query(SQL.insertQuestions), carry = this.#db.query(SQL.carryRow);
      for (const row of rows) {
        const stored = splitQuestions(JSON.parse(row.entry) as Readonly<Record<string, unknown>>);
        questions.run({ hash: stored.hash, questions: stored.questions });
        carry.run({ id: row.id, entry: stored.entry, hash: stored.hash });
      }
      return rows.length;
    }).immediate();
  }

  /** The file's pages, free pages, vacuum mode and rows still to carry forward. Reads only SQLite's own counters and one indexed count. */
  storage(): DecisionLogStorage {
    const number = (sql: string): number => Number(Object.values(rowsOf<Record<string, number>>(this.#db, sql)[0] ?? {})[0] ?? 0);
    const mode = number('PRAGMA auto_vacuum');
    return {
      pageSize: number('PRAGMA page_size'),
      pageCount: number('PRAGMA page_count'),
      freePages: number('PRAGMA freelist_count'),
      vacuum: mode === 2 ? 'incremental' : mode === 1 ? 'full' : 'none',
      rowsToCarry: number(SQL.legacyCount),
    };
  }

  /**
   * Gives up to `pages` free pages back to the file system (a file in incremental vacuum mode); returns how many
   * went. Each call is one short write that moves pages from the end of the file, never a whole-file rewrite.
   */
  reclaim(pages: number): number {
    if (!Number.isSafeInteger(pages) || pages < 1) throw new RangeError('Reclaiming decision log space needs a positive page count.');
    this.flushNotes();
    const before = this.storage().freePages;
    this.#db.query(`PRAGMA incremental_vacuum(${pages})`).all();
    return before - this.storage().freePages;
  }

  /**
   * The last step of carrying a file written before version 6 forward, once every row is carried: one rewrite
   * of the file (VACUUM) that switches it to incremental vacuum mode, so every later pass frees space a batch
   * at a time. Returns the sizes before carrying forward began and now, once; undefined when this file was not
   * carried forward or the step already ran. The caller runs it only when the live data is small, because the
   * rewrite holds the file for as long as copying that data takes.
   */
  finishCarryForward(): DecisionLogCarriedForward | undefined {
    this.flushNotes();
    const recorded = rowsOf<{ readonly value: string }>(this.#db, SQL.carriedFrom)[0];
    if (recorded === undefined) return undefined;
    if (this.storage().vacuum !== 'incremental') {
      this.#db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
      this.#db.exec('VACUUM;');
    }
    this.#db.query(SQL.forgetCarriedFrom).run();
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const now = this.storage();
    return { fromBytes: Number(recorded.value), toBytes: now.pageCount * now.pageSize };
  }

  /** Hands the space freed by pruning back from the write-ahead log. */
  checkpoint(): void {
    this.flushNotes();
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  get(id: string): DecisionEntry | undefined {
    this.flushNotes();
    return this.#entries(SQL.matching([ID_IS]), { id, limit: 1 })[0];
  }

  query(query: DecisionQuery = {}): readonly DecisionEntry[] {
    this.flushNotes();
    const { where, params } = filterFor(query);
    return this.#entries(SQL.matching(where), { ...params, limit: query.limit ?? 1000 });
  }

  queryIds(query: DecisionQuery = {}): readonly DecisionId[] {
    this.flushNotes();
    const { where, params } = filterFor(query);
    return rowsOf<{ readonly id: DecisionId }>(this.#db, SQL.matchingIds(where), { ...params, limit: query.limit ?? 1000 })
      .map(row => row.id);
  }

  /** Native local monitoring never materializes full entries or their notes. */
  queryVolume(query: DecisionQuery = {}): readonly DecisionVolumeEntry[] {
    const limit = query.limit ?? 1000;
    // The monitor uses one sentinel row beyond its configured 100k maximum.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_001) throw new RangeError('Decision volume query requires a bounded limit.');
    this.flushNotes();
    const { where, params } = filterFor(query);
    return rowsOf<DecisionVolumeRow>(this.#db, SQL.volume(where), { ...params, limit }).map(decisionVolumeRow);
  }

  summaries(ids: readonly string[]): readonly DecisionSummary[] {
    if (ids.length === 0) return [];
    return rowsOf<SummaryRow>(this.#db, SQL.summaries, { ids: JSON.stringify(ids) }).map(row => ({
      id: row.id as DecisionId,
      status: row.status,
      requestedModel: row.requested_model ?? '',
      ...(row.model === null ? {} : { model: row.model }),
    }));
  }

  #entries(sql: string, params: Params): DecisionEntry[] {
    return rowsOf<Row>(this.#db, sql, params).map(toEntry);
  }

  [Symbol.dispose](): void {
    try { this.flushNotes(); }
    finally {
      if (this.#synced !== this.#db) this.#synced.close();
      this.#db.close();
    }
  }
}
