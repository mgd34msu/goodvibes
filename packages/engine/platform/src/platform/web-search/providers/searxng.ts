import type { WebSearchProvider, WebSearchProviderCall, WebSearchProviderResponse, WebSearchRequest } from '../types.js';
import {
  buildDescriptor,
  executeJsonRequest,
  firstString,
  ignoredFilterMetadata,
  resolveBaseUrl,
  resultFromRecord,
  type SearchProviderContext,
} from './shared.js';

const SEARXNG_ENV_KEYS = ['SEARXNG_BASE_URL'] as const;
const SEARXNG_SERVICE_NAME = 'searxng';

/** SearXNG's `time_range` has day, month and year; a week filter is reported as ignored. */
function mapTimeRange(value: WebSearchRequest['timeRange']): string | undefined {
  switch (value) {
    case 'day':
      return 'day';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return undefined;
  }
}

/** SearXNG's `safesearch`: 0 off, 1 moderate, 2 strict. */
function mapSafeSearch(value: WebSearchRequest['safeSearch']): string | undefined {
  switch (value) {
    case 'off':
      return '0';
    case 'moderate':
      return '1';
    case 'strict':
      return '2';
    default:
      return undefined;
  }
}

export function createSearxngSearchProvider(context: SearchProviderContext): WebSearchProvider {
  const env = context.env;
  const serviceRegistry = context.serviceRegistry;
  return {
    id: 'searxng',
    label: 'SearXNG',
    capabilities: ['search', 'evidence'],
    descriptor() {
      return buildDescriptor({
        id: 'searxng',
        label: 'SearXNG',
        note: 'Uses a SearXNG instance via its JSON search API. Configure SEARXNG_BASE_URL or a searxng service entry.',
        requiresAuth: false,
        serviceName: SEARXNG_SERVICE_NAME,
        baseUrlEnvCandidates: SEARXNG_ENV_KEYS,
      }, { env, serviceRegistry });
    },
    async search(request: WebSearchRequest, call?: WebSearchProviderCall): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(25, request.maxResults ?? 10));
      const baseUrl = resolveBaseUrl(serviceRegistry, env, SEARXNG_ENV_KEYS, SEARXNG_SERVICE_NAME) ?? '';
      if (!baseUrl) {
        throw new Error('SearXNG requires SEARXNG_BASE_URL or a searxng service entry with baseUrl.');
      }
      const region = request.region?.trim();
      const timeRange = mapTimeRange(request.timeRange);
      const safesearch = mapSafeSearch(request.safeSearch);
      const { payload } = await executeJsonRequest<Record<string, unknown>>({
        url: `${baseUrl}/search`,
        params: {
          q: request.query,
          format: 'json',
          pageno: '1',
          ...(region ? { language: region } : {}),
          ...(timeRange ? { time_range: timeRange } : {}),
          ...(safesearch ? { safesearch } : {}),
        },
        headers: { Accept: 'application/json' },
        service: serviceRegistry.get(SEARXNG_SERVICE_NAME) ? SEARXNG_SERVICE_NAME : undefined,
        fetcher: context.fetcher ?? call?.fetcher,
      });
      const results = Array.isArray(payload.results)
        ? payload.results
            .slice(0, maxResults)
            .map((entry, index) => {
              if (!entry || typeof entry !== 'object') return null;
              const record = entry as Record<string, unknown>;
              return resultFromRecord('searxng', index + 1, record, {
                urlKeys: ['url'],
                titleKeys: ['title'],
                snippetKeys: ['content'],
                metadata: {
                  engine: firstString(record, ['engine']),
                  publishedDate: firstString(record, ['publishedDate', 'published_date']),
                },
              });
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        : [];
      return {
        results,
        metadata: {
          numberOfResults: typeof payload.number_of_results === 'number' ? payload.number_of_results : undefined,
          ...ignoredFilterMetadata(request, [
            ...(region ? ['region' as const] : []),
            ...(timeRange ? ['timeRange' as const] : []),
            ...(safesearch ? ['safeSearch' as const] : []),
          ]),
        },
      };
    },
  };
}
