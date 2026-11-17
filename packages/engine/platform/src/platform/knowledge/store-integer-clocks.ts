import type { SqlDatabase } from '../state/sqlite-store.js';

/** A clock column: declared INTEGER and named `*_at`. */
function clockColumns(db: Pick<SqlDatabase, 'exec'>, table: string): string[] {
  const rows = db.exec(`PRAGMA table_info(${JSON.stringify(table)})`)[0]?.values ?? [];
  const columns: string[] = [];
  for (const row of rows) {
    const name = row[1];
    if (typeof name === 'string' && name.endsWith('_at') && String(row[2]).toUpperCase() === 'INTEGER') columns.push(name);
  }
  return columns;
}

/**
 * Rewrites every knowledge clock an older build stored as ISO text in an
 * INTEGER column as its integer milliseconds, in the migration's one
 * transaction, so each clock column holds one type and compares as numbers.
 * Text that is not a date is left as it is; reads still accept either form.
 */
export function rewriteKnowledgeTextClocks(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  const tables = (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge\\_%' ESCAPE '\\'")[0]?.values ?? [])
    .map(row => row[0])
    .filter((name): name is string => typeof name === 'string');
  for (const table of tables) {
    for (const column of clockColumns(db, table)) {
      const quoted = JSON.stringify(column);
      db.run(`UPDATE ${JSON.stringify(table)} SET ${quoted} = CAST(ROUND((julianday(${quoted}) - 2440587.5) * 86400000) AS INTEGER)
        WHERE typeof(${quoted}) = 'text' AND julianday(${quoted}) IS NOT NULL`);
    }
  }
}
