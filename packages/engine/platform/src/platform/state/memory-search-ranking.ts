import { captureMemoryOperation, assertMemoryOperationCurrent, awaitMemoryOperation, type MemoryOperationOptions } from './memory-operation.js';
/**
 * memory-search-ranking.ts, the ranking half of memory search. Retrieval (the
 * SQL filter and the vector index in memory-store.ts) builds a shortlist; the
 * `engine.state.memory-search` rerank orders it here.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { memorySearchRerank, rerankContent, rerankShortlistSize } from './batteries/memory-search-rerank.js';
import type { MemoryRecord, MemorySearchFilter, MemorySemanticSearchResult } from './memory-store.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { classicLexicalOverlap } from './classic-ranking.js';

const SEARCH_SITE = 'state.memory-search';

/** The rerank's probability for each record against the query, by record id. */
export async function rerankProbabilities(query: string, records: readonly MemoryRecord[], options?: MemoryOperationOptions): Promise<Map<string, number>> {
  return decisionOrClassic(() => readRerankProbabilities(query, records, options), () => {
    assertMemoryOperationCurrent(captureMemoryOperation(options));
    return new Map<string, number>();
  });
}

/**
 * Readings kept per process, keyed by the query, the record id and the
 * record's updatedAt (every write moves it), so a reading is never reused for
 * a changed record or another question, and repeating a search asks nothing.
 */
const READING_CACHE_LIMIT = 1024;
const readingCache = new Map<string, number>();
function readingKey(query: string, record: MemoryRecord): string {
  return `${query}\0${record.id}\0${record.updatedAt}`;
}
function cachedReading(key: string): number | undefined {
  const value = readingCache.get(key);
  if (value !== undefined) { readingCache.delete(key); readingCache.set(key, value); }
  return value;
}
function rememberReading(key: string, probability: number): void {
  readingCache.set(key, probability);
  if (readingCache.size > READING_CACHE_LIMIT) readingCache.delete(readingCache.keys().next().value!);
}
/** Tests reset the process-scope readings. */
export function forgetMemorySearchReadings(): void { readingCache.clear(); }

/**
 * One rerank request over every candidate not read before for this query
 * (the battery reads the list together); none when all were read.
 */
async function readRerankProbabilities(query: string, records: readonly MemoryRecord[], options?: MemoryOperationOptions): Promise<Map<string, number>> {
  const operation = captureMemoryOperation(options);
  assertMemoryOperationCurrent(operation);
  if (records.length === 0) return new Map();
  const unread = records.filter((record) => cachedReading(readingKey(query, record)) === undefined);
  if (unread.length > 0) {
    const { ranked } = await awaitMemoryOperation(() => memorySearchRerank.rerank(
      judgmentPort(SEARCH_SITE),
      query,
      unread.map((record) => ({ id: record.id, content: rerankContent(record) })),
      { site: SEARCH_SITE, ...(operation.signal === undefined ? {} : { signal: operation.signal }), beforeAttempt: () => assertMemoryOperationCurrent(operation) },
    ), operation);
    for (const entry of ranked) {
      const record = unread.find((candidate) => candidate.id === entry.id);
      if (record) rememberReading(readingKey(query, record), entry.probability);
    }
  }
  const probabilities = new Map<string, number>();
  for (const record of records) {
    const probability = cachedReading(readingKey(query, record));
    if (probability !== undefined) probabilities.set(record.id, probability);
  }
  return probabilities;
}

/**
 * Reranks the first rerankShortlistSize(limit) retrieved records against the
 * query and puts them first, best first; records past the shortlist follow in
 * retrieval order with no probability.
 */
export async function rerankRetrieved(
  query: string,
  retrieved: readonly MemoryRecord[],
  limit: number | undefined,
  options?: MemoryOperationOptions,
): Promise<Array<{ readonly record: MemoryRecord; readonly probability: number | undefined }>> {
  return decisionOrClassic(() => rerankDecisionRetrieved(query, retrieved, limit, options), () => {
    assertMemoryOperationCurrent(captureMemoryOperation(options));
    return retrieved.map(record => ({ record, probability: undefined }));
  });
}

async function rerankDecisionRetrieved(query: string, retrieved: readonly MemoryRecord[], limit: number | undefined, options?: MemoryOperationOptions): Promise<Array<{ readonly record: MemoryRecord; readonly probability: number | undefined }>> {
  const operation = captureMemoryOperation(options);
  assertMemoryOperationCurrent(operation);
  const size = rerankShortlistSize(limit);
  const shortlist = retrieved.slice(0, size);
  const probabilities = await awaitMemoryOperation(() => readRerankProbabilities(query, shortlist, operation), operation);
  const ranked = shortlist
    .map((record) => ({ record, probability: probabilities.get(record.id) }))
    .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
  return [...ranked, ...retrieved.slice(size).map((record) => ({ record, probability: undefined }))];
}

/** The two retrieval paths a semantic search ranks over; MemoryStore provides both. */
export interface SemanticRetrieval {
  retrieve(filter: MemorySearchFilter, options?: MemoryOperationOptions): MemoryRecord[];
  semanticCandidates(filter: MemorySearchFilter, options?: MemoryOperationOptions): MemorySemanticSearchResult[];
}

/**
 * Semantic search: the vector index builds the shortlist, the
 * `engine.state.memory-search` rerank orders it. `score` is the rerank's
 * probability on a 0 to 100 scale (the old field mixed similarity*100 with a
 * quarter of the lexical points, so it ran roughly 0 to 125).
 *
 * With no query there is nothing to rank against: records come back in
 * retrieval order with `score` = the record's confidence. When the index
 * returns nothing the literal search runs instead, reranked, with similarity
 * 0; records past its shortlist carry no reading and score 0.
 */
export async function rankSemanticSearch(store: SemanticRetrieval, filter: MemorySearchFilter, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
  return decisionOrClassic(() => rankDecisionSemanticSearch(store, filter, options), () => {
    const operation = captureMemoryOperation(options);
    assertMemoryOperationCurrent(operation);
    const candidates = store.semanticCandidates(filter, operation);
    const result = candidates.length ? candidates.map(entry => ({ ...entry, provenance: 'classic' as const, scoreSource: 'vector-similarity' as const, score: entry.similarity * 100 }))
      : store.retrieve({ ...filter, semantic: false, limit: undefined }, operation).map(record => ({ record,
        distance: Number.POSITIVE_INFINITY, similarity: 0,
        score: classicLexicalOverlap(filter.query ?? '', JSON.stringify(rerankContent(record))) * 100,
        provenance: 'classic' as const, scoreSource: 'literal-overlap' as const }));
    assertMemoryOperationCurrent(operation);
    const sorted = result.sort((a, b) => b.score - a.score);
    return filter.limit === undefined ? sorted : sorted.slice(0, filter.limit);
  });
}

async function rankDecisionSemanticSearch(store: SemanticRetrieval, filter: MemorySearchFilter, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
  const operation = captureMemoryOperation(options);
  assertMemoryOperationCurrent(operation);
  const query = filter.query?.trim();
  if (!query) {
    return store.retrieve({ ...filter, semantic: false }, operation).map((record) => ({
      record,
      distance: Number.POSITIVE_INFINITY,
      similarity: 0,
      score: record.confidence,
    }));
  }

  const candidates = store.semanticCandidates(filter, operation);
  if (candidates.length === 0) {
    const ranked = await awaitMemoryOperation(() => rerankDecisionRetrieved(query, store.retrieve({ ...filter, semantic: false, limit: undefined }, operation), filter.limit, operation), operation);
    const results = ranked.map(({ record, probability }) => ({
      record,
      distance: Number.POSITIVE_INFINITY,
      similarity: 0,
      score: (probability ?? 0) * 100,
    }));
    return filter.limit !== undefined ? results.slice(0, filter.limit) : results;
  }

  const requestedLimit = Math.max(1, filter.limit ?? 10);
  const shortlist = candidates.slice(0, rerankShortlistSize(requestedLimit));
  const probabilities = await awaitMemoryOperation(() => readRerankProbabilities(query, shortlist.map((entry) => entry.record), operation), operation);
  return shortlist
    .map((entry) => ({ ...entry, score: (probabilities.get(entry.record.id) ?? 0) * 100 }))
    .sort((a, b) => b.score - a.score || a.distance - b.distance || b.record.updatedAt - a.record.updatedAt)
    .slice(0, requestedLimit);
}

/** Review states in order of need: a disagreement first, then superseded, then never reviewed. */
const REVIEW_NEED: Readonly<Record<MemoryRecord['reviewState'], number>> = { contradicted: 0, stale: 1, fresh: 2, reviewed: 3 };

/**
 * Which record most needs a person, from the stored fields: flagged first
 * (contradicted, then stale), then never reviewed, then lowest confidence,
 * then the longest untouched. No model request: every field is a fact the
 * store holds.
 */
export function compareReviewNeed(a: MemoryRecord, b: MemoryRecord): number {
  return REVIEW_NEED[a.reviewState] - REVIEW_NEED[b.reviewState]
    || a.confidence - b.confidence
    || a.updatedAt - b.updatedAt
    || a.createdAt - b.createdAt;
}

/** The review queue: the records most in need of a person first, at most `limit`. */
export function rankReviewQueue(candidates: readonly MemoryRecord[], limit: number): MemoryRecord[] {
  return [...candidates].sort(compareReviewNeed).slice(0, limit);
}
