import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Ranked, Rerank } from '@goodvibes-jev/judgment';
import { isClassicOperation, rankClassicCatalog } from '@goodvibes-jev/engine/platform/platform/runtime';


export interface CatalogRankingOptions {
  readonly signal?: AbortSignal | undefined;
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Retain only acquired backend identities, never a released source receipt. */
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
  /** Accepted for existing callers; catalog rows are written in code and are not screened. */
  readonly requirePreservedSource?: boolean;
  /**
   * The caller needs a reading of meaning (planning a route for a prose task),
   * not a lookup: the best literal matches are read in one request even when
   * code found some. Without it a lookup with any literal match costs nothing.
   */
  readonly semantic?: boolean;
}

/** Capture private DTO metadata without interpreting fields that will never be sent. */
export function captureCatalogData<T>(value: T, budget = { nodes: 0, characters: 0, slots: 0 }): T {
  return visitCatalogData(value, budget, true);
}

/**
 * Validate the same complete DTO grammar without allocating another frozen
 * graph. Answers each object's own property names (hidden ones included).
 */
export function inspectCatalogData(value: unknown): WeakMap<object, readonly string[]> {
  const names = new WeakMap<object, readonly string[]>();
  visitCatalogData(value, { nodes: 0, characters: 0, slots: 0 }, false, names);
  return names;
}

const isEnumerable = (entry: object, key: string): boolean => Object.prototype.propertyIsEnumerable.call(entry, key);

/**
 * The plain-data grammar: plain objects and arrays, finite numbers, strings,
 * booleans, null and undefined, no functions, symbols or `toJSON`, within the
 * budgets. Hidden (non-enumerable) fields are data too and keep their
 * enumerability in the copy. Values are read directly: the data is the
 * program's own or arguments the registry already validated and froze.
 */
function visitCatalogData<T>(value: T, budget: { nodes: number; characters: number; slots: number }, copy: boolean,
  observations?: WeakMap<object, readonly string[]>): T {
  const ancestors = new Set<object>();
  const copies = new WeakMap<object, object>();
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++budget.nodes > 100_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { budget.characters += entry.length; if (budget.characters > 1_000_000) return invalid(); return entry; }
    if (entry === null || entry === undefined || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || ancestors.has(entry)) return invalid();
    const existing = copies.get(entry); if (existing) return existing;
    const array = Array.isArray(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const names = Object.getOwnPropertyNames(entry);
    observations?.set(entry, names);
    if (Object.getOwnPropertySymbols(entry).length > 0 || Object.hasOwn(entry, 'toJSON')
      || (array && Object.hasOwn(entry, 'constructor'))) return invalid();
    const length = array ? (entry as unknown[]).length : 0;
    if (length > 20_000) return invalid();
    if (array && (budget.slots += length) > 100_000) return invalid();
    const record = entry as Record<string, unknown>;
    const result: object = copy ? (array ? new Array(length) : Object.create(null) as object) : entry;
    ancestors.add(entry);
    try {
      for (const key of names) {
        if (array && key === 'length') continue;
        const field = record[key];
        if (typeof field === 'function') return invalid();
        budget.characters += key.length;
        if (budget.characters > 1_000_000) return invalid();
        const child = capture(field, depth + 1);
        if (copy) Object.defineProperty(result, key, { value: child, enumerable: isEnumerable(entry, key) });
      }
      if (copy) Object.freeze(result);
      copies.set(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  return capture(value, 0) as T;
}

/** Retain the existing complete frozen copy alongside its fresh-data guard. */
export function captureCatalogSnapshot<T>(source: T): {
  readonly captured: T;
  readonly assertCurrent: (current: unknown) => void;
} {
  const captured = captureCatalogData(source);
  return { captured, assertCurrent: compileCatalogSnapshotGuard(captured) };
}

/** Compare fresh complete DTOs without copying them. Every call keeps the
 * original capture grammar and budgets, including alias and hidden-slot rules. */
export function captureCatalogSnapshotGuard(source: unknown): (current: unknown) => void {
  return compileCatalogSnapshotGuard(captureCatalogData(source));
}

/**
 * Compare fresh plain data with a captured copy: the same keys in the same
 * order and equal values, as JSON-shaped data. A frozen graph that matched
 * once cannot change, so it is not compared again. The data is the program's
 * own (catalog rows, store records, captured arguments); nothing here guards
 * against code in this process replacing built-ins or properties.
 */
function compileCatalogSnapshotGuard(captured: unknown): (current: unknown) => void {
  const matchedFrozen = new WeakSet<object>();
  return current => {
    if (current !== null && typeof current === 'object' && matchedFrozen.has(current)) return;
    if (!sameCatalogData(captured, current, 0)) throw new ToolInputProjectionError('held');
    if (current !== null && typeof current === 'object' && Object.isFrozen(current)) matchedFrozen.add(current);
  };
}

function sameCatalogData(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || depth > 64) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index]!;
    if (key !== rightKeys[index]) return false;
    if (!sameCatalogData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}

/** Kept for callers that still name the methods they use; a method of the program's own objects is not re-checked. */
const immutableCatalogSlots = (): void => {};
export function captureCatalogMethods(_subject: object, _keys: readonly string[]): () => void {
  return immutableCatalogSlots;
}
/** One guard for many retained slots; slots proven unchangeable cost nothing per boundary. */
export function combineCatalogGuards(guards: readonly (() => void)[]): () => void {
  const live = guards.filter(guard => guard !== immutableCatalogSlots);
  if (live.length === 0) return immutableCatalogSlots;
  return live.length === 1 ? live[0]! : () => { for (const guard of live) guard(); };
}

type CatalogDescription = { readonly id: string; readonly description: string; readonly evidence?: unknown };
type CatalogRow = { readonly id: string; readonly description: string };
/** Rows described once for a catalog that is read many times. */
const preparedCatalogs = new WeakMap<object, { readonly describe: object; readonly rows: readonly CatalogRow[] }>();

function captureCatalogEntries<T>(entries: readonly T[]): T[] {
  if (!Array.isArray(entries) || entries.length >= SOURCE_SCREENING_LIMITS.parts * SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  const budget = { nodes: 0, characters: 0, slots: 0 };
  return entries.map(entry => captureCatalogData(entry, budget));
}

/** Freeze a catalog and describe its rows once; later lookups reuse both. */
export function prepareHarnessCatalog<T>(entries: readonly T[], describe: (entry: T) => CatalogDescription): readonly T[] {
  const captured = Object.freeze(captureCatalogEntries(entries));
  preparedCatalogs.set(captured, Object.freeze({ describe, rows: Object.freeze(captured.map(entry => catalogRow(describe(entry)))) }));
  return captured;
}

function catalogRow({ id, description }: CatalogDescription): CatalogRow {
  return { id: String(id), description: typeof description === 'string' ? description : '' };
}

export interface HarnessCatalogRanking<T> {
  /** 'classic': the matches are literal word matches found by code; no reading was taken. */
  readonly provenance?: 'classic';
  readonly matches: readonly { readonly entry: T; readonly judgment: Ranked | undefined; readonly id?: string; readonly score?: number; readonly provenance?: 'classic' }[];
  /** Settled readings only (and the one code decision for an exact id or a sole full match). */
  readonly judgments: readonly Ranked[];
  /** Candidates whose reading did not settle; they are left out of `matches`, never fatal. */
  readonly unsettled?: number;
}

/** Most candidates one reading is shown. */
const READING_SHORTLIST = 8;
/** Most rows of a small catalog one together-reading is shown when no row matched literally. */
const TOGETHER_CATALOG = 48;
/** Decisions that read every candidate in one request. */
const TOGETHER_DECISIONS: ReadonlySet<string> = new Set(['engine.tools.registry-rank', 'engine.tools.registry-catalog-group']);
/** Shared context is sent once and only when small; a large context is the caller's own data, not a clue. */
const MAX_CONTEXT_CHARACTERS = 2_000;

/** The row code selected: an exact id, or the only row carrying every query word. */
function codeDecision(id: string): Ranked & { readonly decidedBy: 'code' } {
  return { id, probability: 1, reading: { kind: 'yes-no', probability: 1, verdict: 'yes', outcome: 'act' }, decisionId: undefined, decidedBy: 'code' };
}

/**
 * The one catalog selector. Code decides first and for free: an exact id
 * (ignoring case), then the literal ranker over id and description. A reading
 * is taken only when nothing matched literally in a small catalog, or when the
 * caller asks for meaning (`semantic`), and then it is one reading over the
 * best few candidates carrying id and description only. A failed or unsettled
 * reading leaves the literal result standing; it never fails the lookup.
 */
export async function rankHarnessCatalog<T>(
  entries: readonly T[],
  query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  site: string,
  options: CatalogRankingOptions = {},
  decisionName = 'engine.tools.registry-rank',
  contextEvidence?: unknown,
): Promise<HarnessCatalogRanking<T>> {
  options.signal?.throwIfAborted();
  const text = typeof query === 'string' ? query.trim() : '';
  if (entries.length === 0 || !text) return { provenance: 'classic', matches: [], judgments: [] };
  const prepared = preparedCatalogs.get(entries);
  const described = prepared?.describe === describe ? prepared.rows : entries.map(entry => catalogRow(describe(entry)));
  const rows = described.map((row, index) => ({ ...row, index }));
  const decided = (index: number): HarnessCatalogRanking<T> => {
    const judgment = codeDecision(rows[index]!.id);
    return { matches: [{ entry: entries[index]!, judgment, id: judgment.id }], judgments: [judgment] };
  };
  const wanted = text.toLocaleLowerCase();
  const exact = rows.filter(row => row.id.toLocaleLowerCase() === wanted);
  if (exact.length === 1 && options.semantic !== true) return decided(exact[0]!.index);
  const literal = rankClassicCatalog(rows, text, row => row);
  const literalResult: HarnessCatalogRanking<T> = { provenance: 'classic', judgments: [], matches: literal.map(match => ({
    entry: entries[match.entry.index]!, id: match.entry.id, judgment: undefined, score: match.score, provenance: 'classic' as const })) };
  if (options.semantic !== true) {
    const complete = literal.filter(match => match.score === 1);
    if (complete.length === 1 && literal.length > 0) return decided(complete[0]!.entry.index);
    if (literal.length > 0) return literalResult;
  }
  if (isClassicOperation()) return literalResult;
  const together = TOGETHER_DECISIONS.has(decisionName);
  const shortlist = literal.length > 0 ? literal.slice(0, READING_SHORTLIST).map(match => match.entry)
    : rows.length <= (together ? TOGETHER_CATALOG : READING_SHORTLIST) ? rows : [];
  if (shortlist.length === 0) return literalResult;
  const decision = gateJudgmentRegistry.get(decisionName) as Rerank | undefined;
  if (!decision || typeof decision.rerank !== 'function') return literalResult;
  let contextJson: string | undefined;
  if (contextEvidence !== undefined) {
    try { contextJson = JSON.stringify(contextEvidence); } catch { contextJson = undefined; }
    if (typeof contextJson !== 'string' || contextJson.length > MAX_CONTEXT_CHARACTERS) contextJson = undefined;
  }
  try {
    const installation = captureJudgmentPort(site, { signal: options.signal, prepareResultCapture: prepareJudgmentResult });
    let ranked: readonly Ranked[];
    try {
      // Opaque request ids keep a row's own id from standing in for its reading.
      ({ ranked } = await decision.rerank(installation.port, contextJson === undefined ? text : { query: text, contextJson },
        shortlist.map((row, index) => ({ id: String(index), content: { type: 'tool', name: row.id, description: row.description } })),
        { site, ...(options.signal ? { signal: options.signal } : {}) }));
    } finally { installation.consumeObservation(); }
    options.signal?.throwIfAborted();
    const judgments: Ranked[] = [], matches: { entry: T; judgment: Ranked; id: string }[] = [];
    let unsettled = 0;
    for (const judgment of ranked) {
      const row = /^(0|[1-9][0-9]*)$/.test(judgment.id) ? shortlist[Number(judgment.id)] : undefined;
      if (!row) continue;
      if (judgment.reading.outcome !== 'act' || judgment.reading.verdict === 'uncertain') { unsettled++; continue; }
      const settled = { ...judgment, id: row.id };
      judgments.push(settled);
      if (judgment.reading.verdict === 'yes') matches.push({ entry: entries[row.index]!, judgment: settled, id: row.id });
    }
    return { matches, judgments, ...(unsettled > 0 ? { unsettled } : {}) };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // No reading could be taken (no decision model, an outage, a refused request): the literal result stands.
    return literalResult;
  }
}
