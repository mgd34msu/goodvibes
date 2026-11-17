import { LIMITS, type JsonValue } from '@goodvibes-jev/judgment';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { registrySelect, ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { isClassicOperation, rankClassicCatalog } from '@goodvibes-jev/engine/platform/platform/runtime';

const ALLOWED_OPTIONS: readonly string[] = ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource', 'semantic'];

/**
 * A reader's request, captured once at the tool boundary: a frozen copy of the
 * input and one answer to "is this call still wanted" (the call's signal plus
 * the caller's own check, once each). A frozen copy cannot change, so nothing
 * re-compares it, and a listing is correct for the moment it was taken.
 */
export function captureCatalogReadRequest<T>(input: T, options: CatalogRankingOptions) {
  if (Reflect.ownKeys(options).some(key => typeof key !== 'string' || !ALLOWED_OPTIONS.includes(key))) throw new ToolInputProjectionError('invalid');
  const { signal, sourceOwner, assertCurrent: callerCurrent, requirePreservedSource } = options;
  if (callerCurrent !== undefined && typeof callerCurrent !== 'function') throw new ToolInputProjectionError('invalid');
  const assertCurrent = (): void => { signal?.throwIfAborted(); callerCurrent?.(); };
  // Kept so existing readers can still name what they read; nothing is re-read on a later check.
  const retain = (_guard: () => void, _key?: string): void => { signal?.throwIfAborted(); };
  assertCurrent();
  return { input: captureCatalogData(input), assertCurrent, retain,
    options: Object.freeze({ signal, sourceOwner, assertCurrent, retainCurrent: retain,
      ...(requirePreservedSource === undefined ? {} : { requirePreservedSource }) }) };
}

/** Most catalog rows the one selection request is shown. */
const SELECTION_SHORTLIST = 8;
/** Shared context goes once, and only when it is small; a large context is the caller's own state, not a clue. */
const MAX_CONTEXT_CHARACTERS = 2_000;

/**
 * The one record selector. Code decides first, for free: an exact id
 * (ignoring case), a sole id prefix, then the only row carrying every query
 * word. Nothing matching in code is "unknown" (the caller lists the valid
 * ids); several partial matches are settled by ONE selection request over the
 * best few, each candidate carrying only its id and description, with any
 * shared context sent once. A failed or unsettled reading selects nothing.
 */
export async function selectHarnessCatalog<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  options: CatalogRankingOptions = {}, site = 'agent.catalog.select', contextEvidence?: unknown): Promise<T | null> {
  options.signal?.throwIfAborted();
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text || entries.length === 0) return null;
  const rows = entries.map((entry, index) => {
    const { id, description } = describe(entry);
    return { id: String(id), description: typeof description === 'string' ? description : '', index };
  });
  const wanted = text.toLocaleLowerCase();
  const exact = rows.filter(row => row.id.toLocaleLowerCase() === wanted);
  if (exact.length === 1) return entries[exact[0]!.index] ?? null;
  const prefix = rows.filter(row => row.id.toLocaleLowerCase().startsWith(wanted));
  if (prefix.length === 1) return entries[prefix[0]!.index] ?? null;
  const literal = rankClassicCatalog(rows, text, row => row);
  if (literal.length === 0) return null;
  if (literal.length === 1) return entries[literal[0]!.entry.index] ?? null;
  const complete = literal.filter(match => match.score === 1);
  if (complete.length === 1) return entries[complete[0]!.entry.index] ?? null;
  if (isClassicOperation()) return null;
  const shortlist = literal.slice(0, Math.min(SELECTION_SHORTLIST, LIMITS.maxChoiceOptions - 1)).map(match => match.entry);
  let contextJson: string | undefined;
  if (contextEvidence !== undefined) {
    try { contextJson = JSON.stringify(contextEvidence); } catch { contextJson = undefined; }
    if (typeof contextJson !== 'string' || contextJson.length > MAX_CONTEXT_CHARACTERS) contextJson = undefined;
  }
  try {
    const authority = captureJudgmentPort(site, { signal: options.signal, prepareResultCapture: prepareJudgmentResult });
    try {
      const result = await registrySelect.select(authority.port, { query: text, ...(contextJson === undefined ? {} : { contextJson }) },
        shortlist.map((row, index) => ({ id: String(index), content: { name: row.id, description: row.description } satisfies JsonValue })),
        { site, signal: authority.signal });
      result.recordAction('read-only catalog detail selection');
      // An unsettled selection or "none" selects nothing; the caller reports the lookup as unresolved.
      if (result.outcome !== 'act' || result.pick.choice === 'none' || result.chosen === undefined) return null;
      const row = /^(0|[1-9][0-9]*)$/.test(result.chosen) ? shortlist[Number(result.chosen)] : undefined;
      return row ? entries[row.index] ?? null : null;
    } finally { authority.consumeObservation(); }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // No reading could be taken (no decision model, an outage): several partial matches stay unresolved.
    return null;
  }
}
