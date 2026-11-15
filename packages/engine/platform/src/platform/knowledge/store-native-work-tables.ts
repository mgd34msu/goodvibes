/**
 * Layout checks and retention for the native work execution tables.
 *
 * Each execution, intent, settlement and CI continuation row is checked by the
 * write that publishes it and by the read that loads it, so the current-schema
 * check (which runs again whenever another writer changed the database image)
 * checks only these tables' layout. Every row is walked once when the store
 * opens (and by migrations), so a damaged row still stops the store at start.
 *
 * Retention: a settled execution's outcome lives in the work ledger (its report
 * and evidence events), so its execution, intent, settlement and finished CI
 * continuation rows are only needed to answer a replay or status read of that
 * request. The newest RETAINED_SETTLED_NATIVE_WORK settlements per project keep
 * them; older ones are deleted at store open. A replay of a deleted request is
 * refused as stale, because its attempt is complete. An execution with a CI
 * continuation that can still be claimed is kept, since claiming reads it.
 */
import type { SqlDatabase } from '../state/sqlite-store.js';
import { knowledgeSchemaColumns } from './store-schema-validation-data.js';
import { validateNativeWorkExecutionIntentTable, validateNativeWorkSettlementTable } from './store-native-work-execution.js';
import { validateNativeCiContinuationTable } from './store-native-ci-continuation.js';

export const RETAINED_SETTLED_NATIVE_WORK = 200;

function validateLayout(db: Pick<SqlDatabase, 'exec'>, table: string, expected: readonly (readonly (string | number)[])[]): void {
  const rows = db.exec(`PRAGMA table_info(${table})`)[0]?.values;
  if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = rows.find(value => value[1] === name); return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new Error(`Invalid ${table} table`);
}

/** The intent and settlement tables' columns, without reading their rows. */
export function validateNativeWorkIntentAndSettlementLayouts(db: Pick<SqlDatabase, 'exec'>): void {
  validateLayout(db, 'native_work_execution_intents', knowledgeSchemaColumns.intent);
  validateLayout(db, 'native_work_execution_settlements', knowledgeSchemaColumns.settlement);
}

/** Every intent, settlement and CI continuation row, against its execution and ledger: once, at store open. */
export function validateNativeWorkRows(db: Pick<SqlDatabase, 'exec'>): void {
  validateNativeWorkExecutionIntentTable(db);
  validateNativeWorkSettlementTable(db);
  validateNativeCiContinuationTable(db);
}

/**
 * Delete the rows of settled executions older than the newest `keep` per
 * project. Returns how many executions were retired. A row whose identifying
 * fields cannot be read is left in place.
 */
export function pruneSettledNativeWork(db: Pick<SqlDatabase, 'run' | 'exec'>, keep = RETAINED_SETTLED_NATIVE_WORK): number {
  const crowded = db.exec('SELECT project_id FROM native_work_execution_settlements GROUP BY project_id HAVING COUNT(*) > ?', [keep])[0]?.values ?? [];
  let retired = 0;
  for (const [project] of crowded) {
    if (typeof project !== 'string') continue;
    // A continuation still `issued` can be claimed, and claiming reads its original execution.
    const claimable = new Set<string>();
    const finished = new Map<string, string[]>();
    for (const [id, attempt, state] of db.exec(`SELECT continuation_id, json_extract(state_json, '$.issue.originalKey.attemptId'), json_extract(state_json, '$.state')
      FROM native_ci_continuations WHERE project_id = ?`, [project])[0]?.values ?? []) {
      if (typeof attempt !== 'string') continue;
      if (state !== 'claimed' && state !== 'cancelled') { claimable.add(attempt); continue; }
      finished.set(attempt, [...(finished.get(attempt) ?? []), String(id)]);
    }
    // The ledger's report sequence orders settlements by when they were published.
    const old = db.exec(`SELECT key_hash, json_extract(state_json, '$.target.attemptId') FROM native_work_execution_settlements WHERE project_id = ?
      ORDER BY json_extract(state_json, '$.reportSequence') DESC LIMIT -1 OFFSET ?`, [project, keep])[0]?.values ?? [];
    for (const [keyHash, attempt] of old) {
      if (typeof keyHash !== 'string' || typeof attempt !== 'string' || claimable.has(attempt)) continue;
      const execution = db.exec("SELECT json_extract(state_json, '$.state') FROM native_work_executions WHERE project_id = ? AND attempt_id = ?", [project, attempt])[0]?.values[0];
      // Only a launched execution can have been settled; anything else is left for its owner to read.
      if (execution !== undefined && execution[0] !== 'launch-claimed') continue;
      db.run('DELETE FROM native_work_execution_settlements WHERE project_id = ? AND key_hash = ?', [project, keyHash]);
      db.run('DELETE FROM native_work_executions WHERE project_id = ? AND attempt_id = ?', [project, attempt]);
      db.run('DELETE FROM native_work_execution_intents WHERE project_id = ? AND attempt_id = ?', [project, attempt]);
      for (const id of finished.get(attempt) ?? []) db.run('DELETE FROM native_ci_continuations WHERE project_id = ? AND continuation_id = ?', [project, id]);
      retired++;
    }
  }
  return retired;
}
