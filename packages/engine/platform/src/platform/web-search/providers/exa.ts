import type { WebSearchProvider, WebSearchProviderCall, WebSearchProviderResponse, WebSearchRequest } from '../types.js';
import {
  buildDescriptor,
  executeJsonRequest,
  firstString,
  ignoredFilterMetadata,
  jsonAnswerBytes,
  resolveBaseUrl,
  resultFromRecord,
  withInlineApiKey,
  type SearchProviderContext,
} from './shared.js';

const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai';
const EXA_ENV_KEYS = ['EXA_API_KEY'] as const;
const EXA_SERVICE_NAME = 'exa';

const RANGE_MS: Readonly<Record<string, number>> = { day: 86_400_000, week: 7 * 86_400_000, month: 31 * 86_400_000, year: 366 * 86_400_000 };

/** Exa's `startPublishedDate`: the start of the requested window, as an ISO date-time. */
function startPublishedDate(value: WebSearchRequest['timeRange'], now: number): string | undefined {
  const span = value ? RANGE_MS[value] : undefined;
  return span ? new Date(now - span).toISOString() : undefined;
}

export function createExaSearchProvider(context: SearchProviderContext): WebSearchProvider {
  const env = context.env;
  const serviceRegistry = context.serviceRegistry;
  return {
    id: 'exa',
    label: 'Exa',
    capabilities: ['search', 'evidence'],
    descriptor() {
      return buildDescriptor({
        id: 'exa',
        label: 'Exa',
        note: 'Uses Exa Search JSON results. Configure via EXA_API_KEY or an exa service entry.',
        envKeyCandidates: EXA_ENV_KEYS,
        serviceName: EXA_SERVICE_NAME,
        defaultBaseUrl: EXA_DEFAULT_BASE_URL,
      }, { env, serviceRegistry });
    },
    async search(request: WebSearchRequest, call?: WebSearchProviderCall): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(25, request.maxResults ?? 10));
      const evidenceRequested = request.includeEvidence || request.verbosity === 'evidence' || request.verbosity === 'full';
      const baseUrl = resolveBaseUrl(serviceRegistry, env, undefined, EXA_SERVICE_NAME, EXA_DEFAULT_BASE_URL)!;
      const since = startPublishedDate(request.timeRange, Date.now());
      const { payload } = await executeJsonRequest<Record<string, unknown>>({
        url: `${baseUrl}/search`,
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
          query: request.query,
          numResults: maxResults,
          ...(evidenceRequested ? { text: true } : {}),
          ...(since ? { startPublishedDate: since } : {}),
        },
        service: serviceRegistry.get(EXA_SERVICE_NAME) ? EXA_SERVICE_NAME : undefined,
        auth: serviceRegistry.get(EXA_SERVICE_NAME) ? undefined : withInlineApiKey(env, EXA_ENV_KEYS, 'x-api-key'),
        fetcher: context.fetcher ?? call?.fetcher,
        maxContentLength: jsonAnswerBytes(maxResults, evidenceRequested === true),
      });
      const results = Array.isArray(payload.results)
        ? payload.results
            .map((entry, index) => {
              if (!entry || typeof entry !== 'object') return null;
              const record = entry as Record<string, unknown>;
              const result = resultFromRecord('exa', index + 1, record, {
                urlKeys: ['url', 'id'],
                titleKeys: ['title'],
                snippetKeys: ['text', 'snippet'],
                evidenceKeys: ['text'],
                metadata: {
                  publishedDate: firstString(record, ['publishedDate', 'published_date']),
                  author: firstString(record, ['author']),
                },
              });
              return result;
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        : [];
      return {
        results,
        metadata: {
          autopromptString: firstString(payload, ['autopromptString']),
          requestId: firstString(payload, ['requestId']),
          ...ignoredFilterMetadata(request, since ? ['timeRange'] : []),
        },
      };
    },
  };
}
