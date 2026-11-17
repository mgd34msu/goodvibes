/**
 * The work plan's task rows, in one SQLite file that every GoodVibes program
 * run by the same user opens: `~/.goodvibes/work-plans.sqlite`, beside the
 * project identity registry that names the projects (`~/.goodvibes/project-identities`).
 * The terminal app, the Agent and the daemon therefore keep one plan per project,
 * whichever of them edits it and whether or not they run at the same time.
 *
 * The file is a row store (state/sqlite-file.ts): WAL, so a reader never waits
 * for a writer; a busy timeout, so a second program's brief write is waited for;
 * every edit is one immediate transaction, so two programs editing the same plan
 * never overwrite each other. The plan's revision is MAX(revision) of its rows
 * (store-work-plan-tasks.ts), read by any program with one indexed statement.
 *
 * A program learns of another program's commit without polling: the file's WAL
 * is watched, and on a change the connection's `data_version` (moved only by
 * another connection's commit) is compared; listeners then compare each plan's
 * revision they hold.
 *
 * `work_plan_moves` records which earlier copy of a plan (the rows a program kept
 * in its own knowledge database before the plan had this file) was moved in, so
 * each copy is moved once, by whichever program opens that plan first.
 */
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { openSqliteFile, type SqliteFile } from '../../state/sqlite-file.js';
import type { SqlDatabase } from '../../state/sqlite-store.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  countWorkPlanTasksInSpace,
  createProjectWorkPlanTaskTable,
  listWorkPlanTaskRecordIds,
  projectWorkPlanFinishedIndexSql,
  readWorkPlanStatusCounts,
  readWorkPlanTaskImportRecord,
  reclaimFinishedWorkPlanTasks,
  workPlanTaskView,
  writeWorkPlanCommit,
  type WorkPlanTaskCommit,
  type WorkPlanTaskCommitResult,
  type WorkPlanTaskView,
} from '../store-work-plan-tasks.js';

export const WORK_PLAN_ROWS_FILE = 'work-plans.sqlite';

/**
 * A quick burst of writes to the WAL is reported as one watch event, which can
 * arrive before the burst's last commit is visible; no further event follows.
 * One more look this long after the last event hears that commit.
 */
const WAL_BURST_SETTLE_MS = 50;

/** Where the plan lives for a configuration: the user's shared `.goodvibes` directory, or the config directory when there is no home. */
export function workPlanRowsPath(homeDirectory: string | null | undefined, configDirectory: string): string {
  return homeDirectory ? join(homeDirectory, '.goodvibes', WORK_PLAN_ROWS_FILE) : join(configDirectory, WORK_PLAN_ROWS_FILE);
}

const MOVES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS work_plan_moves (
  source TEXT NOT NULL,
  space_id TEXT NOT NULL,
  work_plan_id TEXT NOT NULL,
  moved_at INTEGER NOT NULL,
  PRIMARY KEY (source, space_id, work_plan_id)
)`;

type Statements = Pick<SqlDatabase, 'exec' | 'run'>;

function movedIn(db: Statements, source: string, spaceId: string, workPlanId: string): boolean {
  return (db.exec('SELECT 1 FROM work_plan_moves WHERE source = ? AND space_id = ? AND work_plan_id = ?', [source, spaceId, workPlanId])[0]?.values.length ?? 0) > 0;
}

function statements(db: Database): Statements {
  return {
    run(sql, params = []) {
      db.query<unknown, SQLQueryBindings[]>(sql).run(...(params as SQLQueryBindings[]));
    },
    exec(sql, params = []) {
      const statement = db.query<unknown, SQLQueryBindings[]>(sql);
      const values = statement.values(...(params as SQLQueryBindings[])) as unknown[][];
      return values.length ? [{ columns: [...statement.columnNames], values }] : [];
    },
  };
}

export class WorkPlanRows {
  readonly path: string;
  #file: SqliteFile | null = null;
  #db: Statements | null = null;
  #watcher: FSWatcher | null = null;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #dataVersion = -1;
  #scheduled = false;
  #knownChange = false;
  readonly #listeners = new Set<() => void>();

  constructor(path: string) {
    this.path = path;
  }

  #open(): { readonly file: SqliteFile; readonly db: Statements } {
    if (!this.#file || !this.#db) {
      const file = openSqliteFile(this.path, {
        name: 'work plan',
        migrations: [{
          toVersion: 1,
          up: (db) => {
            const plain = statements(db);
            createProjectWorkPlanTaskTable(plain);
            plain.run(projectWorkPlanFinishedIndexSql);
            plain.run(MOVES_TABLE_SQL);
          },
        }],
      });
      this.#file = file;
      this.#db = statements(file.db);
      this.#dataVersion = this.#readDataVersion();
    }
    return { file: this.#file, db: this.#db };
  }

  /** One read transaction, so `read` sees one committed state of the plan. */
  read<T>(spaceId: string, workPlanId: string, read: (view: WorkPlanTaskView) => T): T {
    const { file, db } = this.#open();
    return file.db.transaction(() => read(workPlanTaskView(db, spaceId, workPlanId, null)))();
  }

  /**
   * One edit of a plan in one immediate transaction: `decide` sees the rows as
   * stored (no other program can commit in between) and names what to write.
   */
  commit<T>(spaceId: string, workPlanId: string, decide: (view: WorkPlanTaskView) => WorkPlanTaskCommit<T>): WorkPlanTaskCommitResult<T> {
    const { file, db } = this.#open();
    return file.tx(() => this.#write(db, spaceId, workPlanId, decide(workPlanTaskView(db, spaceId, workPlanId, null))));
  }

  #write<T>(db: Statements, spaceId: string, workPlanId: string, decision: WorkPlanTaskCommit<T>): WorkPlanTaskCommitResult<T> {
    if (decision.put.length === 0 && decision.remove.length === 0) {
      return { value: decision.value, changed: false, head: workPlanTaskView(db, spaceId, workPlanId, null).head };
    }
    const revision = writeWorkPlanCommit(db, spaceId, workPlanId, decision.put, decision.remove, decision.at);
    const reclaimed = decision.reclaimFinished ? reclaimFinishedWorkPlanTasks(db, spaceId, workPlanId, revision, decision.at) : [];
    const statusCounts = readWorkPlanStatusCounts(db, spaceId, workPlanId);
    // Another holder of this handle in this program shares the connection, so data_version does not tell it.
    if (this.#listeners.size > 0) this.#schedule(true);
    return { value: decision.value, changed: true, head: { revision, updatedAt: decision.at }, statusCounts, reclaimed };
  }

  /** Whether the earlier copy of this plan kept at `source` was moved in: one primary-key read. */
  moved(source: string, spaceId: string, workPlanId: string): boolean {
    const { db } = this.#open();
    return movedIn(db, source, spaceId, workPlanId);
  }

  /**
   * Move an earlier copy of a plan in, once per copy: in one immediate
   * transaction, unless the move is already recorded, write what `decide` names
   * and record the move. Answers false when another program moved it first.
   */
  moveIn(source: string, spaceId: string, workPlanId: string, decide: (view: WorkPlanTaskView) => WorkPlanTaskCommit<undefined>): boolean {
    const { file, db } = this.#open();
    return file.tx(() => {
      if (movedIn(db, source, spaceId, workPlanId)) return false;
      const decision = decide(workPlanTaskView(db, spaceId, workPlanId, null));
      db.run('INSERT INTO work_plan_moves (source, space_id, work_plan_id, moved_at) VALUES (?, ?, ?, ?)', [source, spaceId, workPlanId, decision.at]);
      this.#write(db, spaceId, workPlanId, decision);
      return true;
    });
  }

  count(spaceId: string): { readonly workPlans: number; readonly tasks: number } {
    return countWorkPlanTasksInSpace(this.#open().db, spaceId);
  }

  recordIds(spaceId: string): string[] {
    return listWorkPlanTaskRecordIds(this.#open().db, spaceId);
  }

  importRecord(recordId: string): { readonly source: Record<string, unknown> | null; readonly generation: string | null } {
    return readWorkPlanTaskImportRecord(this.#open().db, recordId);
  }

  /**
   * Calls `listener` once per event-loop turn in which the file changed: another
   * program committed (the file's WAL is watched, no polling, and the
   * connection's `data_version` confirms it), or a commit went through this
   * handle. A listener compares the revisions it holds, so its own commits cost
   * it one indexed read and announce nothing.
   */
  onExternalCommit(listener: () => void): () => void {
    this.#listeners.add(listener);
    this.#startWatching();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stopWatching();
    };
  }

  close(): void {
    this.#stopWatching();
    this.#listeners.clear();
    const file = this.#file;
    this.#file = null;
    this.#db = null;
    file?.close();
  }

  #readDataVersion(): number {
    const row = this.#file?.db.query<{ data_version: number }, []>('PRAGMA data_version').get();
    return typeof row?.data_version === 'number' ? row.data_version : -1;
  }

  #startWatching(): void {
    if (this.#watcher || this.path === ':memory:') return;
    this.#open();
    const wal = `${this.path}-wal`;
    const onChange = (): void => {
      this.#schedule(false);
      // The look after the burst settles: one PRAGMA, and only after an event.
      if (this.#settleTimer) clearTimeout(this.#settleTimer);
      this.#settleTimer = setTimeout(() => { this.#settleTimer = null; this.#schedule(false); }, WAL_BURST_SETTLE_MS);
      this.#settleTimer.unref?.();
    };
    try {
      // In WAL mode every commit appends to the -wal file while any program holds the file open, as this one does.
      this.#watcher = watch(wal, { persistent: false }, onChange);
    } catch {
      try {
        this.#watcher = watch(dirname(this.path), { persistent: false }, (_event, name) => {
          if (name === basename(this.path) || name === basename(wal)) onChange();
        });
      } catch (error) {
        // Without a watch, a surface still compares the plan's revision when it draws.
        logger.debug('Work plan file is not watched for other programs\' edits', { path: this.path, error: summarizeError(error) });
        return;
      }
    }
    this.#watcher.on('error', () => this.#stopWatching());
  }

  /** Once per event-loop turn: confirm another program committed (unless a commit here is known), then call the listeners. */
  #schedule(known: boolean): void {
    this.#knownChange ||= known;
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      const known = this.#knownChange;
      this.#knownChange = false;
      if (!this.#file) return;
      const version = this.#readDataVersion();
      if (version === this.#dataVersion && !known) return;
      this.#dataVersion = version;
      for (const listener of [...this.#listeners]) {
        try { listener(); } catch (error) { logger.warn('Work plan change listener failed', { error: summarizeError(error) }); }
      }
    });
  }

  #stopWatching(): void {
    const watcher = this.#watcher;
    this.#watcher = null;
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    try { watcher?.close(); } catch { /* already closed */ }
  }
}

const shared = new Map<string, { readonly rows: WorkPlanRows; refs: number }>();

/**
 * The process's one handle on the plan file at `path`: every planning service in
 * a program shares it, so a program holds one connection and one watch per file.
 * `release` closes it when the last holder lets go. `:memory:` is never shared.
 */
export function acquireWorkPlanRows(path: string): { readonly rows: WorkPlanRows; release(): void } {
  if (path === ':memory:') {
    const rows = new WorkPlanRows(path);
    return { rows, release: () => rows.close() };
  }
  let entry = shared.get(path);
  if (!entry) { entry = { rows: new WorkPlanRows(path), refs: 0 }; shared.set(path, entry); }
  entry.refs += 1;
  const held = entry;
  let released = false;
  return {
    rows: held.rows,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs === 0) {
        shared.delete(path);
        held.rows.close();
      }
    },
  };
}
