/**
 * code-index-lexical.ts, the ranking half of the code index's lexical search.
 * CodeIndexStore.searchLexical recalls chunks whose symbol or path contains a
 * query token (SQL LIKE, code); the `engine.state.code-search` rerank orders
 * them here. The index stores no chunk text, so each chunk's code is read
 * back from its file for the reading; a file that cannot be read is judged on
 * its path and symbol alone.
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { retainStrictJudgmentJson, prepareJudgmentResult } from '../gate/judgment-result.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { codeChunkView, rerankCodeParts } from './batteries/code-search-rerank.js';
import type { CodeChunk } from './code-index-chunking.js';
import type { CodeContextResult } from './code-index-types.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { classicLexicalOverlap } from './classic-ranking.js';

const CODE_SEARCH_SITE = 'state.code-index-search';

/** Largest source file read back for a reading; a bigger one is judged on its path and symbol alone. */
const MAX_LEXICAL_SOURCE_BYTES = 1024 * 1024;
/** A chunk whose recorded modification time is further than this from the file's now describes older text. */
const STALE_MTIME_TOLERANCE_MS = 1;

interface LexicalSource { readonly code?: string; readonly version: string; readonly mtimeMs?: number }

const fileIdentity = (value: Stats) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;

/** Where a chunk's file is and what version it is at, from stat alone (no content read). */
function locateLexicalSource(root: string, path: string): { version: string; actual?: string; before?: Stats } {
  const candidate = join(root, path), rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Code search source is outside its root');
  let actual: string;
  try { actual = realpathSync(candidate); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return { version: `unavailable:${code}` };
    throw error;
  }
  const actualRelative = relative(root, actual);
  if (!actualRelative || actualRelative === '..' || actualRelative.startsWith('..' + sep) || isAbsolute(actualRelative)) throw new Error('Code search source is outside its root');
  const before = lstatSync(actual);
  if (!before.isFile()) throw new Error('Code search source is not a regular file');
  return { version: `${actual}:${fileIdentity(before)}`, actual, before };
}

/** Retain the native source (up to the byte cap), including text outside the indexed chunk. */
function readLexicalSource(root: string, path: string): LexicalSource {
  const located = locateLexicalSource(root, path);
  const { actual, before } = located;
  if (!actual || !before) return { version: located.version };
  if (before.size > MAX_LEXICAL_SOURCE_BYTES) return { version: located.version, mtimeMs: before.mtimeMs };
  const candidate = join(root, path);
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fileIdentity(fstatSync(fd)) !== fileIdentity(before)) throw new Error('Code search source changed');
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== before.size || fileIdentity(fstatSync(fd)) !== fileIdentity(before) || fileIdentity(lstatSync(actual)) !== fileIdentity(before)
      || realpathSync(candidate) !== actual) throw new Error('Code search source changed');
    return { code: buffer.subarray(0, offset).toString('utf8'), version: located.version, mtimeMs: before.mtimeMs };
  } finally { closeSync(fd); }
}

/**
 * The lines a chunk covers, or undefined when the text cannot be vouched for: the file
 * was not read, or its modification time no longer matches the one the chunk was indexed
 * at, in which case the stored line numbers point into different code.
 */
function chunkText(chunk: CodeChunk, source: LexicalSource | undefined): string | undefined {
  if (source?.code === undefined) return undefined;
  if (source.mtimeMs !== undefined && Math.abs(source.mtimeMs - chunk.mtimeMs) >= STALE_MTIME_TOLERANCE_MS) return undefined;
  return source.code.split('\n').slice(Math.max(0, chunk.startLine - 1), chunk.endLine).join('\n');
}

/**
 * Reranks recalled chunks against the query and returns the best `limit`,
 * best first, leaving out chunks the rerank reads as not matching.
 * `similarity` is the rerank's probability; `distance` is its complement on
 * the vector path's 0 to 2 scale.
 */
export async function rankLexicalChunks(
  rootDir: string,
  query: string,
  chunks: readonly CodeChunk[],
  limit: number,
): Promise<CodeContextResult[]> {
  return decisionOrClassic(() => rankDecisionLexicalChunks(rootDir, query, chunks, limit), () => {
    const original = retainStrictJudgmentJson({ rootDir, query, chunks, limit });
    const root = realpathSync(original.snapshot.rootDir);
    const sources = new Map<string, LexicalSource>();
    const result = original.snapshot.chunks.map(chunk => {
      let source = sources.get(chunk.path);
      if (!source) { source = readLexicalSource(root, chunk.path); sources.set(chunk.path, source); }
      const text = chunkText(chunk, source) ?? '';
      const similarity = classicLexicalOverlap(query, `${chunk.path}\n${chunk.symbol ?? ''}\n${text}`);
      return { chunk, similarity, distance: 2 * (1 - similarity), label: 'lexical' as const,
        provenance: 'classic' as const, scoreSource: 'literal-overlap' as const };
    }).sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(0, limit));
    original.assertCurrent();
    if (realpathSync(rootDir) !== root) throw new Error('Code search root changed');
    return result;
  });
}

async function rankDecisionLexicalChunks(rootDir: string, query: string, chunks: readonly CodeChunk[], limit: number): Promise<CodeContextResult[]> {
  if (chunks.length === 0) return [];
  const original = retainStrictJudgmentJson({ rootDir, query, chunks, limit });
  const snapshot = original.snapshot;
  const root = realpathSync(snapshot.rootDir);
  const sources = new Map(snapshot.chunks.map(chunk => [chunk.path, readLexicalSource(root, chunk.path)]));
  // Admit every complete source before projecting any chunk or dispatching any pair.
  assertJudgmentInput({ query: snapshot.query, sources: [...sources].map(([path, source]) => ({ path, code: source.code })),
    chunks: snapshot.chunks.map(chunk => ({ path: chunk.path, symbol: chunk.symbol, kind: chunk.kind, startLine: chunk.startLine, endLine: chunk.endLine })) });
  const candidates = snapshot.chunks.map(chunk => ({ id: chunk.chunkId,
    content: codeChunkView(chunk, chunkText(chunk, sources.get(chunk.path))) }));
  const current = () => {
    original.assertCurrent();
    if (realpathSync(snapshot.rootDir) !== root) throw new Error('Code search root changed');
    // Stat identity (device, inode, size, modification and change time) retires a source that was
    // edited mid-ranking without re-reading every file on every attempt.
    for (const [path, source] of sources) {
      if (locateLexicalSource(root, path).version !== source.version) throw new Error('Code search source changed during ranking');
    }
  };
  const owner = captureJudgmentPort(CODE_SEARCH_SITE, { assertCurrent: current, prepareResultCapture: prepareJudgmentResult });
  const { ranked } = await rerankCodeParts(owner.port, snapshot.query, candidates,
    { site: CODE_SEARCH_SITE, signal: owner.signal, beforeAttempt: owner.assertCurrent });
  owner.assertCurrent();
  const byId = new Map(snapshot.chunks.map(chunk => [chunk.chunkId, chunk]));
  return ranked
    .filter((entry) => entry.reading.outcome !== 'act' || entry.reading.verdict !== 'no')
    .slice(0, snapshot.limit)
    .map((entry) => ({
      chunk: byId.get(entry.id)!,
      distance: 2 * (1 - entry.probability),
      similarity: entry.probability,
      label: 'lexical' as const,
    }));
}
