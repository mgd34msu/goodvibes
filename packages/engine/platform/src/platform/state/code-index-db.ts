/**
 * Code-index SQL layer, schema plus every direct table operation for
 * CodeIndexStore's bun:sqlite database (see CHANGELOG 0.38.0; extracted from
 * code-index-store.ts to keep that file within the 800-line source discipline).
 *
 * Three tables:
 *  - `code_chunks`    chunk metadata (path/lang/symbol/kind/lines/source revision)
 *  - `code_vectors`   vec0 virtual table keyed by rowid
 *  - `code_index_meta` key/value build provenance, currently the embedding
 *    space (provider, model and width) the index was last fully built in, so
 *    search() can refuse to compare query vectors from another space against
 *    the stored vectors (see CodeIndexStore.getProviderMismatch).
 *
 * Every function takes the Database handle explicitly, this module holds no
 * state and never opens/closes connections; CodeIndexStore owns the lifecycle.
 */

import type { Database } from 'bun:sqlite';
import { MEMORY_VECTOR_DIMS } from './embedding-dims.js';
import type { CodeChunk } from './code-index-chunking.js';

export type ChunkRow = {
  rowid: number;
  chunk_id: string;
  path: string;
  lang: string;
  symbol: string;
  kind: string;
  start_line: number;
  end_line: number;
  mtime: number;
  file_revision: string;
};

export type VectorRow = {
  rowid: number;
  distance: number;
};

/** Meta key for the embedding provider id the index was last fully built with. */
/** The embedding space (`<provider>:<model>:<dimensions>`, state/embedding-space.ts) every stored vector was made in. */
export const EMBEDDING_PROVIDER_META_KEY = 'embedding_space';

export const CHUNK_ROW_COLUMNS =
  'rowid, chunk_id, path, lang, symbol, kind, start_line, end_line, mtime, file_revision';

/** Target `PRAGMA user_version` for the code index store. */
/** Bump with MEMORY_VECTOR_DIMS (embedding-dims.ts): the vector table's width is fixed when it is created. */
/** v5: file_revision is the SHA-256 of the file's bytes, chunk_id is `path#ordinal`, vectors join on rowid. */
export const CODE_INDEX_SCHEMA_VERSION = 5;

export function createCodeIndexSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id     TEXT NOT NULL UNIQUE,
      path         TEXT NOT NULL,
      lang         TEXT NOT NULL,
      symbol       TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT '',
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      mtime        INTEGER NOT NULL,
      file_revision TEXT NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS code_chunks_path_idx ON code_chunks(path)');
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_vectors USING vec0(
      embedding float[${MEMORY_VECTOR_DIMS}]
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS code_index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/** The index is a reconstructible cache: an older layout is dropped whole and the next build re-embeds. */
export function migrateCodeIndexSchema(db: Database): void {
  // The vector table is dropped, not emptied: an index made at another embedding width keeps that
  // width for as long as the table exists.
  db.run('DROP TABLE IF EXISTS code_vectors');
  db.run('DROP TABLE IF EXISTS code_chunks');
  db.run('DROP TABLE IF EXISTS code_index_meta');
  createCodeIndexSchema(db);
}

export function getCodeIndexMeta(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>(
    'SELECT value FROM code_index_meta WHERE key = ? LIMIT 1',
  ).get(key);
  return row?.value ?? null;
}

export function setCodeIndexMeta(db: Database, key: string, value: string): void {
  db.query(
    'INSERT INTO code_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function ensureChunkRowId(db: Database, chunk: CodeChunk): number {
  db.query(
    `INSERT OR IGNORE INTO code_chunks
       (chunk_id, path, lang, symbol, kind, start_line, end_line, mtime, file_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chunk.chunkId,
    chunk.path,
    chunk.lang,
    chunk.symbol,
    chunk.kind,
    chunk.startLine,
    chunk.endLine,
    chunk.mtimeMs,
    chunk.fileRevision,
  );
  const row = db.query<{ rowid: number }, [string]>(
    'SELECT rowid FROM code_chunks WHERE chunk_id = ? LIMIT 1',
  ).get(chunk.chunkId);
  if (!row) throw new Error(`Code index row id not found for ${chunk.chunkId}`);
  return Number(row.rowid);
}

export function writeChunk(db: Database, chunk: CodeChunk, embedding: Float32Array): void {
  const rowid = ensureChunkRowId(db, chunk);
  db.query('DELETE FROM code_vectors WHERE rowid = ?').run(rowid);
  db.query('INSERT INTO code_vectors (rowid, embedding) VALUES (?, ?)').run(rowid, embedding);
}

/**
 * Replace every chunk of one file in a single transaction: either the old chunks
 * stay, or the new ones land complete (never a partial file carrying the new
 * revision). `stampProvider` records the embedding provider in the same
 * transaction, for the first write into an index that has never been stamped.
 * The caller computes every embedding first; nothing here awaits.
 */
export function replaceFileChunks(
  db: Database,
  relPath: string,
  entries: readonly { readonly chunk: CodeChunk; readonly embedding: Float32Array }[],
  options: { readonly stampProvider?: string | undefined } = {},
): void {
  db.transaction(() => {
    deleteChunksForPath(db, relPath);
    for (const entry of entries) writeChunk(db, entry.chunk, entry.embedding);
    if (options.stampProvider !== undefined) setCodeIndexMeta(db, EMBEDDING_PROVIDER_META_KEY, options.stampProvider);
  })();
}

export function deleteChunksForPath(db: Database, relPath: string): void {
  const rows = db.query<{ rowid: number }, [string]>(
    'SELECT rowid FROM code_chunks WHERE path = ?',
  ).all(relPath);
  for (const row of rows) {
    db.query('DELETE FROM code_vectors WHERE rowid = ?').run(row.rowid);
  }
  db.query('DELETE FROM code_chunks WHERE path = ?').run(relPath);
}

export function getFileRevision(db: Database, relPath: string): string | null {
  const row = db.query<{ file_revision: string }, [string]>(
    'SELECT file_revision FROM code_chunks WHERE path = ? LIMIT 1',
  ).get(relPath);
  return row?.file_revision ?? null;
}

export function getChunkByRowId(db: Database, rowid: number): CodeChunk | null {
  const row = db.query<ChunkRow, [number]>(
    `SELECT ${CHUNK_ROW_COLUMNS} FROM code_chunks WHERE rowid = ? LIMIT 1`,
  ).get(rowid);
  return row ? rowToChunk(row) : null;
}

export function countChunksForPath(db: Database, relPath: string): number {
  const row = db.query<{ count: number }, [string]>(
    'SELECT count(*) AS count FROM code_chunks WHERE path = ?',
  ).get(relPath);
  return Number(row?.count ?? 0);
}

export function countIndexedFiles(db: Database): number {
  const row = db.query<{ count: number }, []>(
    'SELECT count(DISTINCT path) AS count FROM code_chunks',
  ).get();
  return Number(row?.count ?? 0);
}

export function countIndexedChunks(db: Database): number {
  const row = db.query<{ count: number }, []>(
    'SELECT count(*) AS count FROM code_chunks',
  ).get();
  return Number(row?.count ?? 0);
}

export function listIndexedPaths(db: Database): string[] {
  const rows = db.query<{ path: string }, []>('SELECT DISTINCT path FROM code_chunks').all();
  return rows.map((row) => row.path);
}

export function rowToChunk(row: ChunkRow): CodeChunk {
  return {
    chunkId: row.chunk_id,
    path: row.path,
    lang: row.lang,
    symbol: row.symbol,
    kind: row.kind,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    mtimeMs: Number(row.mtime),
    fileRevision: row.file_revision,
  };
}
