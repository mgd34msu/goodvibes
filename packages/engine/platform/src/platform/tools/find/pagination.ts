import type { OutputOptions } from './shared.js';
import { DEFAULT_CEILING_TOKENS } from '../../runtime/tools/output-policy.js';

/**
 * Ceiling on one query's serialized page when the caller sets no
 * `output.max_tokens`: a page that would exceed it is shortened and continued
 * through `next_offset`, so no single call can flood the context.
 */
const CHARS_PER_TOKEN = 4;
export const DEFAULT_FIND_PAGE_CHARS = DEFAULT_CEILING_TOKENS.find * CHARS_PER_TOKEN;
/** Rows on a page when the caller sets neither max_results nor max_total_matches. */
export const DEFAULT_PAGE_SIZE = 100;
/** Room kept per query for its id, wrapper keys and the fields added after paging. */
const PER_QUERY_WRAPPER_CHARS = 512;
/** Room kept for the call's own wrapper. */
const CALL_WRAPPER_CHARS = 512;

/**
 * Each query's page size in characters, so the whole call fits the ceiling the
 * conversation applies to one tool result (the caller's `max_tokens`, or the
 * default result ceiling): the ceiling is shared among the queries. Find owns
 * the size of its result; nothing downstream has to cut it.
 */
export function findPageChars(output: OutputOptions, queryCount: number): number {
  const explicit = output.max_tokens !== undefined && Number.isSafeInteger(output.max_tokens) && output.max_tokens > 0
    ? output.max_tokens * CHARS_PER_TOKEN
    : undefined;
  const callChars = explicit ?? DEFAULT_CEILING_TOKENS.read * CHARS_PER_TOKEN;
  const share = Math.floor((callChars - CALL_WRAPPER_CHARS) / Math.max(1, queryCount)) - PER_QUERY_WRAPPER_CHARS;
  return Math.max(1, Math.min(explicit ?? DEFAULT_FIND_PAGE_CHARS, share));
}

/** Pagination limits output, never search coverage or the reported total. */
export function paginateFindResult(result: Record<string, unknown>, output: OutputOptions): Record<string, unknown> {
  if (result.error || output.format === 'count_only') return result;
  const key = ['files', 'locations', 'matches', 'symbols'].find(key => result[key] !== undefined);
  if (!key) return result;
  const value = result[key];
  const grouped = !Array.isArray(value) && value !== null && typeof value === 'object';
  const groups = grouped ? Object.entries(value as Record<string, unknown[]>) : undefined;
  const rows: unknown[] = groups ? groups.flatMap(([, rows]) => rows) : value as unknown[];
  if (!Array.isArray(rows)) return result;
  const offset = output.offset ?? 0;
  const limit = output.max_total_matches ?? output.max_results ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) return { error: 'Pagination offset and page size must be nonnegative integers' };
  // A page of zero rows could never be continued: has_more would be true with no next_offset.
  if (limit === 0) return { error: "max_results and max_total_matches must be at least 1 (use output.format 'count_only' to get only the count)" };
  const perFile = output.max_per_item;
  if (perFile !== undefined && (!Number.isSafeInteger(perFile) || perFile < 0)) return { error: 'max_per_item must be a nonnegative integer' };
  const budgetChars = output.page_chars ?? findPageChars(output, 1);
  const counts = new Map<string, number>();
  const eligible = perFile === undefined || key === 'files' ? rows : rows.filter(row => {
    const file = row && typeof row === 'object' ? (row as { file?: string }).file : undefined;
    if (file === undefined) return true;
    const count = counts.get(file) ?? 0;
    counts.set(file, count + 1);
    return count < perFile;
  });
  const fullPage = eligible.slice(offset, offset + limit);
  if (offset === 0 && fullPage.length === rows.length && JSON.stringify(result).length <= budgetChars) return result;

  // `shown` replaces a row with a shortened copy of it (a single row too large for the page).
  const build = (page: readonly unknown[], trimmed: boolean, shown?: ReadonlyMap<unknown, unknown>): Record<string, unknown> => {
    const selected = new Set(page);
    const show = (row: unknown): unknown => shown?.get(row) ?? row;
    const displayed = groups
      ? Object.fromEntries(groups.map(([name, rows]) => [name, rows.filter(row => selected.has(row)).map(show)]).filter(([, rows]) => (rows as unknown[]).length))
      : page.map(show);
    const hasMore = offset + page.length < eligible.length;
    return {
      ...result, [key]: displayed, total: result.count ?? rows.length, returned: page.length,
      offset, has_more: hasMore,
      ...(hasMore && page.length > 0 ? { next_offset: offset + page.length } : {}),
      ...(trimmed ? { page_shortened_to_fit: output.max_tokens !== undefined && output.max_tokens > 0 ? 'max_tokens' : 'default_size_limit' } : {}),
      ...(eligible.length < rows.length ? { omitted_by_per_file_limit: rows.length - eligible.length } : {}),
      ...(result.relationships && typeof result.relationships === 'object' ? { relationships: Object.fromEntries(Object.entries(result.relationships).filter(([file]) => page.some(row => row && typeof row === 'object' && (row as { file?: string }).file === file))) } : {}),
    };
  };

  const complete = build(fullPage, false);
  if (JSON.stringify(complete).length <= budgetChars) return complete;
  if (fullPage.length <= 1) return fitSingleRow(build, fullPage, budgetChars) ?? complete;
  // The largest prefix of the page that fits; at least one row so a
  // continuation always makes progress.
  let low = 1;
  let high = fullPage.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(build(fullPage.slice(0, middle), true)).length <= budgetChars) low = middle;
    else high = middle - 1;
  }
  const page = build(fullPage.slice(0, low), true);
  if (low > 1 || JSON.stringify(page).length <= budgetChars) return page;
  return fitSingleRow(build, fullPage.slice(0, 1), budgetChars) ?? page;
}

/** Text a shortened field keeps at least, so the row still says what it matched. */
const MIN_FIELD_CHARS = 64;

/** Fields that say where a row is; never shortened. */
const ROW_LOCATION_FIELDS: ReadonlySet<string> = new Set(['file', 'path', 'line', 'column', 'name', 'kind']);

/**
 * One row larger than the page on its own (a match on a minified line): its
 * largest field is shortened (text) or replaced by a note of its size (lists,
 * objects), saying what was left out, until the page fits. The result stays
 * whole JSON, so nothing downstream cuts it. Undefined when nothing is left to
 * shorten.
 */
function fitSingleRow(build: (page: readonly unknown[], trimmed: boolean, shown?: ReadonlyMap<unknown, unknown>) => Record<string, unknown>,
  page: readonly unknown[], budgetChars: number): Record<string, unknown> | undefined {
  const row = page[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  const shown = new Map<unknown, unknown>([[row, copy]]);
  for (let attempt = 0; attempt < 16; attempt++) {
    const result = build(page, true, shown);
    const excess = JSON.stringify(result).length - budgetChars;
    if (excess <= 0) return { ...result, row_shortened_to_fit: true };
    let largest: string | undefined, largestSize = MIN_FIELD_CHARS;
    for (const [name, value] of Object.entries(copy)) {
      if (ROW_LOCATION_FIELDS.has(name)) continue;
      const size = JSON.stringify(value)?.length ?? 0;
      if (size > largestSize) { largest = name; largestSize = size; }
    }
    if (largest === undefined) return undefined;
    const value = copy[largest];
    if (typeof value === 'string') {
      const keep = Math.max(MIN_FIELD_CHARS, value.length - excess - MIN_FIELD_CHARS);
      copy[largest] = `${value.slice(0, keep)}... [${value.length - keep} characters not shown]`;
    } else {
      copy[largest] = `[not shown: ${largestSize} characters, larger than this page allows]`;
    }
  }
  return undefined;
}
