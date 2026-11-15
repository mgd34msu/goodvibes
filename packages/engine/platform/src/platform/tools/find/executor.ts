import { assertCurrentToolInvocation, relaxCurrentToolReadFences } from '../registry.js';
import type { Tool, ToolExecuteOptions } from '../../types/tools.js';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.js';
import { findSchema } from './schema.js';
import type { FindInput, FindQuery, OutputOptions } from './shared.js';
import { executeFilesQuery } from './files.js';
import { executeContentQuery } from './content.js';
import { executeReferencesQuery, type FindCodeIntelligence } from './references.js';
import { CodeIntelligence } from '../../intelligence/index.js';
import { executeStructuralQuery } from './structural.js';
import { executeSymbolsQuery } from './symbols.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { FindRuntimeService, withFindWarnings } from './shared.js';
import { summarizeError } from '../../utils/error-display.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { isInsideProductWorktrees } from '../../utils/walk-dir.js';
import type { ReadAccessFilter } from '../shared/read-access.js';

const MAX_PARALLEL_FIND_QUERIES = 5;
/** Default per-call deadline; a query still running then reports a timeout instead of holding the turn. */
export const DEFAULT_FIND_TIMEOUT_MS = 60_000;
/** Queries at least this slow report their wall time. */
const SLOW_QUERY_MS = 2_000;
/** Share of timeout_ms after which a scan stops by itself and reports a partial result. */
const SOFT_BUDGET_RATIO = 0.8;

export function createFindTool(
  projectRoot: string,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  runtime = new FindRuntimeService(),
  /**
   * Per-file read-permission decision, wired at the composition root to
   * PermissionManager.readAccess. When present, a candidate file whose
   * read is currently restricted has its CONTENT withheld from results and is
   * flagged in path listings. Omitted → all files allowed (unchanged behavior).
   */
  readAccessFilter?: ReadAccessFilter,
  capturedReadAccess?: ReadAccessFilter,
  allowOutsideProject: () => boolean = () => false,
  /**
   * Code intelligence for `references` (language server) and `expand_to`
   * (tree-sitter). Omitted → one tree-sitter-only instance, initialized on first
   * use and kept for this tool: `expand_to` works, and `references` falls back to
   * text matching because no language server is attached.
   */
  codeIntelligence?: FindCodeIntelligence & { initialize?: () => Promise<void> },
): Tool {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new Error('createFindTool requires projectRoot');
  }
  let ownIntelligence: Promise<FindCodeIntelligence> | undefined;
  const intelligence = (): Promise<FindCodeIntelligence> => {
    // A supplied instance that has an initialize step is initialized once, here, before first use.
    ownIntelligence ??= (async () => {
      const created = codeIntelligence ?? new CodeIntelligence({});
      await created.initialize?.();
      return created;
    })();
    return ownIntelligence;
  };
  return {
    definition: findSchema,

    async execute(args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string }> {
      try {
        const before = JSON.stringify(args);
        const outsideProjectAllowed = allowOutsideProject();
        // What the currentness check threw, so a stale call still ends the whole
        // call while one query's own failure stays that query's result.
        let staleError: unknown;
        const current = () => {
          try {
            opts?.signal?.throwIfAborted(); assertCurrentToolInvocation(args, opts);
            if (JSON.stringify(args) !== before) throw new Error('Find invocation changed');
            if (allowOutsideProject() !== outsideProjectAllowed) throw new Error('Find permission mode changed');
          } catch (error) { staleError ??= error; throw error; }
        };
        current();
        // Find only reads. Its per-entry checkpoints stop work early; the
        // registry verifies completely again before the result is published.
        relaxCurrentToolReadFences(args, opts);
        if (!Array.isArray(args.queries) || (args.queries as unknown[]).length === 0) {
          return { success: false, error: 'Missing or empty "queries" array' };
        }
        const input = args as unknown as FindInput;
        const seenIds = new Set<string>();
        for (const query of input.queries) {
          if (seenIds.has(query.id)) {
            return { success: false, error: `Duplicate query id '${query.id}': results are keyed by id, so the second query would replace the first. Give every query its own id. Nothing was searched.` };
          }
          seenIds.add(query.id);
        }
        const timeoutMs = typeof input.timeout_ms === 'number' && Number.isSafeInteger(input.timeout_ms) && input.timeout_ms > 0
          ? input.timeout_ms
          : DEFAULT_FIND_TIMEOUT_MS;
        const deadline = AbortSignal.timeout(timeoutMs);
        const searchSignal = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
        const reading = { signal: searchSignal, assertCurrent: current };
        // Soft stop ahead of the hard deadline: a scan that reaches it returns what it found and says how far it
        // got, rather than being cut off at the deadline with nothing.
        const callStartedAt = performance.now();
        const softBudgetMs = timeoutMs * SOFT_BUDGET_RATIO;
        const budgetExpired = (): boolean => performance.now() - callStartedAt >= softBudgetMs;
        // Product worktrees are skipped unless the task itself runs inside one.
        const walkOptions = { signal: searchSignal, beforeAttempt: current, allowOutsideProject: outsideProjectAllowed, shouldContinue: () => !budgetExpired(), includeProductWorktrees: isInsideProductWorktrees(projectRoot) };
        const queryOptions = { ...walkOptions, ...reading };

        // Handed to the modes that read file text; they apply it as content mode does.
        const withReadAccess = <T extends object>(options: T): T => (readAccessFilter ? { ...options, readAccessFilter } : options);
        const output: OutputOptions = input.output ?? {};
        const parallel = input.parallel !== false;

        const runQuery = async (query: FindQuery): Promise<[string, Record<string, unknown>]> => {
          let result: Record<string, unknown>;
          const startedAt = performance.now();
          try {
            switch (query.mode) {
              case 'files':
                result = await executeFilesQuery(query, output, projectRoot, readAccessFilter, capturedReadAccess, queryOptions);
                break;
              case 'content':
                result = await executeContentQuery(query, output, runtime, projectRoot, readAccessFilter, queryOptions, intelligence);
                break;
              case 'symbols':
                result = await executeSymbolsQuery(query, output, projectRoot, withReadAccess(queryOptions));
                break;
              case 'references':
                result = await executeReferencesQuery(query, output, projectRoot, walkOptions, readAccessFilter, intelligence);
                break;
              case 'structural':
                result = await executeStructuralQuery(query, output, projectRoot, withReadAccess(walkOptions));
                break;
              default: {
                const exhaustive: never = query;
                result = { error: `Unknown mode: ${(exhaustive as FindQuery).mode}` };
              }
            }
          } catch (error) {
            // A cancel or a currentness failure still ends the call.
            if (opts?.signal?.aborted || error === staleError) throw error;
            if (deadline.aborted) {
              result = {
                error: `Timed out after ${timeoutMs}ms before this ${query.mode} query finished; it returned no results. `
                  + 'Narrow path or patterns, split the query, or pass a larger timeout_ms.',
                timed_out: true,
              };
            } else {
              // This query's own failure (an invalid pattern, say) is its result;
              // the other queries of the call keep theirs.
              result = { error: `${query.mode} query failed: ${summarizeError(error)}` };
            }
          }
          // Files mode is the one walk that stops at the budget without a report of its own; the other modes
          // say how far they got, and one that finished must not be labelled incomplete.
          if (query.mode === 'files' && budgetExpired() && result.timed_out === undefined && result.error === undefined
            && !(Array.isArray(result.warnings) && result.warnings.some((w) => typeof w === 'string' && w.startsWith('Stopped at the time budget')))) {
            result = withFindWarnings(result, [`Stopped at the time budget (${Math.round(softBudgetMs / 1000)}s of the ${Math.round(timeoutMs / 1000)}s timeout_ms): results may be incomplete. `
              + "Narrow 'path' or the patterns, or pass a larger timeout_ms."]);
          }
          const elapsedMs = Math.round(performance.now() - startedAt);
          if (elapsedMs >= SLOW_QUERY_MS) result = { ...result, elapsed_ms: elapsedMs };
          current();
          return [query.id, appendSchemaFingerprint(result, 'find', query.mode, { featureFlags })];
        };

        let pairs: Array<[string, Record<string, unknown>]>;
        if (parallel) {
          pairs = await mapWithConcurrency(input.queries, MAX_PARALLEL_FIND_QUERIES, runQuery);
        } else {
          pairs = [];
          for (const query of input.queries) {
            pairs.push(await runQuery(query));
          }
        }

        const results: Record<string, unknown> = {};
        for (const [id, result] of pairs) {
          results[id] = result;
        }

        const finalResults = input.queries.length > 1
          ? appendSchemaFingerprint(results, 'find', 'multi', { featureFlags })
          : results;

        current();
        // Partial failure stays a success with the per-query errors; a call where
        // every query failed did not search anything and says so.
        const failures = pairs.filter(([, result]) => result.error !== undefined || result.timed_out === true);
        if (failures.length === pairs.length) {
          return {
            success: false,
            output: JSON.stringify(finalResults),
            error: `All ${pairs.length} find quer${pairs.length === 1 ? 'y' : 'ies'} failed: ${failures.slice(0, 3).map(([id, result]) => `${id}: ${String(result.error)}`).join('; ')}. Details are in the per-query results.`,
          };
        }
        return { success: true, output: JSON.stringify(finalResults) };
      } catch (err) {
        return {
          success: false,
          error: summarizeError(err),
        };
      }
    },
  };
}
