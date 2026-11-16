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

  const build = (page: readonly unknown[], trimmed: boolean): Record<string, unknown> => {
    const selected = new Set(page);
    const displayed = groups ? Object.fromEntries(groups.map(([name, rows]) => [name, rows.filter(row => selected.has(row))]).filter(([, rows]) => (rows as unknown[]).length)) : page;
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
  if (fullPage.length <= 1 || JSON.stringify(complete).length <= budgetChars) return complete;
  // The largest prefix of the page that fits; at least one row so a
  // continuation always makes progress.
  let low = 1;
  let high = fullPage.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(build(fullPage.slice(0, middle), true)).length <= budgetChars) low = middle;
    else high = middle - 1;
  }
  return build(fullPage.slice(0, low), true);
}
