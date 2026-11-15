import type { Tool, ToolExecuteOptions } from '../../types/tools.js';
import { summarizeError } from '../../utils/error-display.js';
import type { WebSearchService } from '../../web-search/index.js';
import { WEB_SEARCH_TOOL_SCHEMA } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';

export function createWebSearchTool(service: WebSearchService): Tool {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web through a provider-backed search layer.'
        + ' Returns normalized ranked results, optional instant-answer data, and optional fetched evidence.',
      parameters: toRecord(WEB_SEARCH_TOOL_SCHEMA),
      sideEffects: ['network'],
      concurrency: 'parallel',
    },

    async execute(args: Record<string, unknown>, options?: ToolExecuteOptions) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { success: false, error: 'Missing query' };
      const signal = options?.signal;
      if (signal?.aborted) return { success: false, error: 'Web search was cancelled before it started.', cancelled: true };
      const search = service.search({
        query,
        ...(typeof args.providerId === 'string' ? { providerId: args.providerId } : {}),
        ...(typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? { maxResults: Math.min(25, Math.max(1, Math.floor(args.maxResults))) } : {}),
        ...(typeof args.verbosity === 'string' ? { verbosity: args.verbosity as import('../../web-search/types.js').WebSearchVerbosity } : {}),
        ...(typeof args.region === 'string' ? { region: args.region } : {}),
        ...(typeof args.safeSearch === 'string' ? { safeSearch: args.safeSearch as import('../../web-search/types.js').WebSearchSafeSearch } : {}),
        ...(typeof args.timeRange === 'string' ? { timeRange: args.timeRange as import('../../web-search/types.js').WebSearchTimeRange } : {}),
        ...(typeof args.includeInstantAnswer === 'boolean' ? { includeInstantAnswer: args.includeInstantAnswer } : {}),
        ...(typeof args.includeEvidence === 'boolean' ? { includeEvidence: args.includeEvidence } : {}),
        ...(typeof args.evidenceTopN === 'number' ? { evidenceTopN: args.evidenceTopN } : {}),
        ...(typeof args.evidenceExtract === 'string' ? { evidenceExtract: args.evidenceExtract as import('../fetch/schema.js').FetchExtractMode } : {}),
      });
      try {
        // The providers take no cancellation signal, so the turn stops waiting for the answer when it is cancelled.
        const output = signal
          ? await Promise.race([search, new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('Web search was cancelled.')), { once: true });
          })])
          : await search;
        return { success: true, output: JSON.stringify(output) };
      } catch (error) {
        search.catch(() => undefined);
        if (signal?.aborted) return { success: false, error: 'Web search was cancelled. Any answer that arrives later is discarded.', cancelled: true };
        return { success: false, error: `Web search failed: ${summarizeError(error)}` };
      }
    },
  };
}
