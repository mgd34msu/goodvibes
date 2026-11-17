import { FetchRuntimeService, type FetchRuntimeDeps } from '../tools/fetch/index.js';
import type { FetchExtractMode } from '../tools/fetch/schema.js';
import { WebSearchProviderRegistry } from './provider-registry.js';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import type {
  WebSearchEvidence,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
  WebSearchVerbosity,
} from './types.js';

export interface WebSearchServiceStatus {
  readonly enabled: boolean;
  readonly providerCount: number;
  readonly providers: ReturnType<WebSearchProviderRegistry['list']>;
  readonly note: string;
}

function selectEvidenceExtract(request: WebSearchRequest, verbosity: WebSearchVerbosity): FetchExtractMode {
  if (request.evidenceExtract) return request.evidenceExtract;
  return verbosity === 'full' ? 'readable' : 'summary';
}

/**
 * Trims a result to the asked-for verbosity. Evidence the caller asked for
 * (`includeEvidence`) is kept at every verbosity, with the reason it is missing
 * when it could not be fetched, so a requested fetch is never discarded silently.
 */
function shapeResultForVerbosity(result: WebSearchResult, verbosity: WebSearchVerbosity, keepEvidence: boolean): WebSearchResult {
  switch (verbosity) {
    case 'urls_only':
      return {
        rank: result.rank,
        url: result.url,
        ...(result.domain ? { domain: result.domain } : {}),
        type: result.type,
        providerId: result.providerId,
        metadata: result.metadata,
        ...(keepEvidence && result.evidence ? { evidence: result.evidence } : {}),
        ...(keepEvidence && result.evidenceError ? { evidenceError: result.evidenceError } : {}),
      };
    case 'titles':
      return {
        ...shapeResultForVerbosity(result, 'urls_only', keepEvidence),
        ...(result.title ? { title: result.title } : {}),
        ...(result.displayUrl ? { displayUrl: result.displayUrl } : {}),
      };
    case 'snippets':
      return {
        ...shapeResultForVerbosity(result, 'titles', keepEvidence),
        ...(result.snippet ? { snippet: result.snippet } : {}),
      };
    default:
      return result;
  }
}

export class WebSearchService {
  private readonly fetchRuntime = new FetchRuntimeService();

  constructor(
    private readonly registry: WebSearchProviderRegistry,
    private readonly fetchDeps: FetchRuntimeDeps = {},
  ) {}

  async getStatus(): Promise<WebSearchServiceStatus> {
    const providers = this.registry.list();
    return {
      enabled: providers.length > 0,
      providerCount: providers.length,
      providers,
      note: 'Web search uses provider-backed discovery and normalizes results before they reach the model.',
    };
  }

  /**
   * Runs one search. `signal` reaches the provider's request and every
   * evidence fetch, so a cancelled search stops its network work too.
   */
  async search(request: WebSearchRequest, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<WebSearchResponse> {
    options.signal?.throwIfAborted();
    const provider = this.registry.find(request.providerId);
    if (!provider) {
      const ids = this.registry.list().map((entry) => entry.id).join(', ');
      throw new RefusalError(refusal({
        code: 'WEB_SEARCH_PROVIDER_UNKNOWN',
        state: request.providerId ? `no web search provider is registered as ${request.providerId}` : 'no web search provider is registered',
        reason: request.providerId
          ? `Web search provider unavailable: ${request.providerId}. Registered providers: ${ids || 'none'}.`
          : 'No web search provider is registered',
        next: [ids ? `Pass providerId as one of: ${ids}, or leave it out` : 'Register a web search provider'],
        status: 400,
      }));
    }
    // A provider without its credential would only fail at the vendor: say which ones can search now instead.
    const descriptor = provider.descriptor?.();
    if (descriptor && !descriptor.configured) {
      const configured = this.registry.list().filter((entry) => entry.configured).map((entry) => entry.id).join(', ');
      throw new RefusalError(refusal({
        code: 'PROVIDER_NOT_CONFIGURED',
        state: `web search provider ${provider.id} has no credential`,
        reason: `Web search provider "${provider.id}" is not configured. ${descriptor.note ?? ''} Configured providers: ${configured || 'none'}.`.replace(/\s+/g, ' '),
        next: [configured ? `Pass providerId as one of: ${configured}, or leave it out` : (descriptor.note ?? `Configure ${provider.id}`)],
        status: 400,
      }));
    }

    const verbosity = request.verbosity ?? 'snippets';
    const signal = options.signal && this.fetchDeps.signal ? AbortSignal.any([options.signal, this.fetchDeps.signal]) : options.signal ?? this.fetchDeps.signal;
    const fetchDeps: FetchRuntimeDeps = signal ? { ...this.fetchDeps, signal } : this.fetchDeps;
    // The provider's own requests go through the same fetch policy (service
    // credentials, host lists, localhost approval) as the evidence fetch.
    const baseResponse = await provider.search(request, {
      fetcher: (input) => this.fetchRuntime.execute(input, fetchDeps),
    });
    signal?.throwIfAborted();
    const evidenceEnabled = request.includeEvidence || verbosity === 'evidence' || verbosity === 'full';
    const evidenceRun = evidenceEnabled
      ? await this.attachEvidence(baseResponse.results, request, fetchDeps)
      : undefined;
    signal?.throwIfAborted();
    const resultsWithEvidence = evidenceRun?.results ?? baseResponse.results;
    const shapedResults = resultsWithEvidence.map((result) => shapeResultForVerbosity(result, verbosity, request.includeEvidence === true));

    return {
      providerId: provider.id,
      providerLabel: provider.label,
      query: request.query,
      verbosity,
      results: shapedResults,
      ...(baseResponse.instantAnswer ? { instantAnswer: baseResponse.instantAnswer } : {}),
      metadata: evidenceRun
        ? { ...baseResponse.metadata, evidence: evidenceRun.summary }
        : baseResponse.metadata,
    };
  }

  private async attachEvidence(
    results: readonly WebSearchResult[],
    request: WebSearchRequest,
    fetchDeps: FetchRuntimeDeps,
  ): Promise<{ readonly results: readonly WebSearchResult[]; readonly summary: { readonly requested: number; readonly attached: number; readonly failed: number } }> {
    const evidenceTopN = Math.max(1, Math.min(10, request.evidenceTopN ?? 3));
    const extract = selectEvidenceExtract(request, request.verbosity ?? 'snippets');
    const selectedIndexes = results
      .map((result, index) => ({ result, index }))
      .filter(({ result, index }) => index < evidenceTopN && (!result.evidence || result.evidence.length === 0));
    if (selectedIndexes.length === 0) return { results, summary: { requested: 0, attached: 0, failed: 0 } };

    const fetched = await this.fetchRuntime.execute({
      urls: selectedIndexes.map(({ result }) => ({
        url: result.url,
        extract,
        max_content_length: extract === 'readable' ? 20_000 : 10_000,
      })),
      parallel: true,
      verbosity: 'standard',
      // No sanitize_mode: the owner's configured fetch.sanitizeMode (default safe-text) applies, as it does to the fetch tool.
      ...(request.blockedHosts ? { blocked_hosts: [...request.blockedHosts] } : {}),
    }, fetchDeps);

    const evidenceByUrl = new Map<string, WebSearchEvidence>();
    const failureByUrl = new Map<string, string>();
    for (const result of fetched.results ?? []) {
      if (!result.content || result.error) {
        failureByUrl.set(result.url, result.error ?? 'The page had no extractable content.');
        continue;
      }
      evidenceByUrl.set(result.url, {
        url: result.final_url ?? result.url,
        extract,
        content: result.content,
        tokensUsed: result.tokens_used ?? Math.ceil(result.content.length / 4),
        ...(result.status ? { status: result.status } : {}),
        ...(result.contentType ? { contentType: result.contentType } : {}),
        ...(result.truncated ? { truncated: true } : {}),
        metadata: {
          redirected: result.redirected ?? false,
        },
      });
    }

    const attachedResults = results.map((result, index) => {
      if (!selectedIndexes.some((selected) => selected.index === index)) return result;
      const evidence = evidenceByUrl.get(result.url);
      if (!evidence) {
        return { ...result, evidenceError: failureByUrl.get(result.url) ?? 'The page was not fetched.' };
      }
      return {
        ...result,
        evidence: [...(result.evidence ?? []), evidence],
      };
    });
    const attached = selectedIndexes.filter(({ result }) => evidenceByUrl.has(result.url)).length;
    return {
      results: attachedResults,
      summary: { requested: selectedIndexes.length, attached, failed: selectedIndexes.length - attached },
    };
  }
}
