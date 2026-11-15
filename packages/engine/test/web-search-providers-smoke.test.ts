/**
 * Web-search providers: each provider is driven through a recording fetcher
 * and its parsed results, request and credential handling are asserted.
 */

import { describe, expect, test } from 'bun:test';
import { createBraveSearchProvider } from '../platform/src/platform/web-search/providers/brave.js';
import { createDuckDuckGoProvider } from '../platform/src/platform/web-search/providers/duckduckgo.js';
import { createExaSearchProvider } from '../platform/src/platform/web-search/providers/exa.js';
import { createFirecrawlSearchProvider } from '../platform/src/platform/web-search/providers/firecrawl.js';
import { createPerplexitySearchProvider } from '../platform/src/platform/web-search/providers/perplexity.js';
import { createSearxngSearchProvider } from '../platform/src/platform/web-search/providers/searxng.js';
import { createTavilySearchProvider } from '../platform/src/platform/web-search/providers/tavily.js';
import type { FetchInput, FetchUrlInput } from '../platform/src/platform/tools/fetch/schema.js';
import type { FetchOutput } from '../platform/src/platform/tools/fetch/index.js';

type Env = Record<string, string | undefined>;

/** A fetcher that records every input and answers each requested URL with the next canned body. */
function recordingFetcher(...bodies: readonly string[]) {
  const inputs: FetchInput[] = [];
  const fetcher = async (input: FetchInput) => {
    inputs.push(input);
    return {
      success: true,
      summary: { total: bodies.length, succeeded: bodies.length, failed: 0 },
      results: bodies.map((content, index) => ({ url: `https://example.test/${index}`, status: 200, content })),
    };
  };
  return { fetcher, inputs };
}

function contextFor(env: Env, fetcher: (input: FetchInput) => Promise<FetchOutput>) {
  return { env, serviceRegistry: { get: (_id: string) => null }, fetcher };
}

/** The single URL request a JSON-API provider sent. */
function sentRequest(inputs: readonly FetchInput[]): FetchUrlInput {
  expect(inputs).toHaveLength(1);
  const urls = inputs[0]!.urls as FetchUrlInput[];
  expect(urls).toHaveLength(1);
  return urls[0]!;
}

describe('web-search providers', () => {
  test('brave parses web results and sends the key as the subscription token', async () => {
    const { fetcher, inputs } = recordingFetcher(JSON.stringify({
      query: { more_results_available: true },
      web: { results: [
        { url: 'https://example.com/a', title: 'Alpha', description: 'First hit', age: '2 days' },
        { title: 'no url, dropped' },
        { url: 'https://example.org/b', title: 'Beta', description: 'Second hit', profile: { long_name: 'Example Org' } },
      ] },
    }));
    const provider = createBraveSearchProvider(contextFor({ BRAVE_SEARCH_API_KEY: ' brave-key ' }, fetcher));
    const response = await provider.search({ query: 'cats', maxResults: 3, safeSearch: 'strict' });
    // rank is the provider's own position, so the dropped second entry leaves a gap
    expect(response.results.map((r) => [r.rank, r.url, r.title, r.snippet, r.domain, r.providerId])).toEqual([
      [1, 'https://example.com/a', 'Alpha', 'First hit', 'example.com', 'brave'],
      [3, 'https://example.org/b', 'Beta', 'Second hit', 'example.org', 'brave'],
    ]);
    expect(response.results[0]!.metadata.age).toBe('2 days');
    expect(response.results[1]!.displayUrl).toBe('Example Org');
    expect(response.metadata.moreResultsAvailable).toBe(true);
    const request = sentRequest(inputs);
    expect(request.url).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(request.params).toEqual({ q: 'cats', count: '3', safesearch: 'strict' });
    expect(request.auth).toEqual({ type: 'api-key', header: 'X-Subscription-Token', key: 'brave-key' });
  });

  test('exa parses results, requests page text only for evidence, and sends x-api-key', async () => {
    const { fetcher, inputs } = recordingFetcher(JSON.stringify({
      requestId: 'req-1',
      results: [{ url: 'https://example.com/e', title: 'Exa hit', text: 'Full page text', author: 'Ann' }],
    }));
    const provider = createExaSearchProvider(contextFor({ EXA_API_KEY: 'exa-key' }, fetcher));
    const response = await provider.search({ query: 'q', maxResults: 5, includeEvidence: true });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.title).toBe('Exa hit');
    expect(response.results[0]!.evidence?.[0]?.content).toBe('Full page text');
    expect(response.results[0]!.metadata.author).toBe('Ann');
    expect(response.metadata.requestId).toBe('req-1');
    const request = sentRequest(inputs);
    expect(request.url).toBe('https://api.exa.ai/search');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body as string)).toEqual({ query: 'q', numResults: 5, text: true });
    expect(request.auth).toEqual({ type: 'api-key', header: 'x-api-key', key: 'exa-key' });
  });

  test('firecrawl parses data results and sends a bearer token', async () => {
    const { fetcher, inputs } = recordingFetcher(JSON.stringify({
      id: 'fc-1',
      data: [{ url: 'https://example.com/f', title: 'Crawled', description: 'Described', markdown: '# Body' }],
    }));
    const provider = createFirecrawlSearchProvider(contextFor({ FIRECRAWL_API_KEY: 'fc-key' }, fetcher));
    const response = await provider.search({ query: 'q', timeRange: 'week' });
    expect(response.results.map((r) => [r.url, r.title, r.snippet])).toEqual([['https://example.com/f', 'Crawled', 'Described']]);
    expect(response.metadata.requestId).toBe('fc-1');
    const request = sentRequest(inputs);
    expect(request.url).toBe('https://api.firecrawl.dev/v1/search');
    expect(JSON.parse(request.body as string)).toEqual({ query: 'q', limit: 10, tbs: 'qdr:w' });
    expect(request.auth).toEqual({ type: 'bearer', token: 'fc-key' });
  });

  test('perplexity parses results and sends region, recency and bearer token', async () => {
    const { fetcher, inputs } = recordingFetcher(JSON.stringify({
      results: [{ url: 'https://example.com/p', title: 'Pplx', snippet: 'Snip', date: '2026-01-02' }],
    }));
    const provider = createPerplexitySearchProvider(contextFor({ PERPLEXITY_API_KEY: 'px-key' }, fetcher));
    const response = await provider.search({ query: 'q', maxResults: 50, region: 'US', timeRange: 'day' });
    expect(response.results.map((r) => [r.url, r.title, r.snippet, r.metadata.published])).toEqual([
      ['https://example.com/p', 'Pplx', 'Snip', '2026-01-02'],
    ]);
    const request = sentRequest(inputs);
    expect(JSON.parse(request.body as string)).toMatchObject({ query: 'q', max_results: 10, country: 'US' });
    expect(request.auth).toEqual({ type: 'bearer', token: 'px-key' });
  });

  test('searxng parses results from the configured instance and caps them at maxResults', async () => {
    const { fetcher, inputs } = recordingFetcher(JSON.stringify({
      number_of_results: 42,
      results: [
        { url: 'https://example.com/1', title: 'One', content: 'c1', engine: 'duck' },
        { url: 'https://example.com/2', title: 'Two', content: 'c2' },
      ],
    }));
    const provider = createSearxngSearchProvider(contextFor({ SEARXNG_BASE_URL: 'https://searx.test/' }, fetcher));
    const response = await provider.search({ query: 'q', maxResults: 1 });
    expect(response.results.map((r) => [r.url, r.snippet, r.metadata.engine])).toEqual([['https://example.com/1', 'c1', 'duck']]);
    expect(response.metadata.numberOfResults).toBe(42);
    const request = sentRequest(inputs);
    expect(request.url).toBe('https://searx.test/search');
    expect(request.params).toMatchObject({ q: 'q', format: 'json' });
  });

  test('searxng without an instance rejects with the configuration it needs', async () => {
    const { fetcher, inputs } = recordingFetcher('{}');
    const provider = createSearxngSearchProvider(contextFor({}, fetcher));
    await expect(provider.search({ query: 'q' })).rejects.toThrow('SEARXNG_BASE_URL');
    expect(inputs).toHaveLength(0);
  });

  test('tavily parses results and the answer, and sends a bearer token', async () => {
    const { fetcher, inputs } = recordingFetcher(JSON.stringify({
      answer: 'Forty-two',
      request_id: 'tv-1',
      results: [{ url: 'https://example.com/t', title: 'Tav', content: 'Body', score: 0.9, raw_content: 'Raw page' }],
    }));
    const provider = createTavilySearchProvider(contextFor({ TAVILY_API_KEY: 'tv-key' }, fetcher));
    const response = await provider.search({ query: 'q', verbosity: 'full' });
    expect(response.results[0]!.title).toBe('Tav');
    expect(response.results[0]!.metadata.score).toBe(0.9);
    expect(response.results[0]!.evidence?.[0]?.content).toBe('Raw page');
    expect(response.instantAnswer?.answer).toBe('Forty-two');
    expect(response.metadata.requestId).toBe('tv-1');
    const request = sentRequest(inputs);
    expect(JSON.parse(request.body as string)).toMatchObject({ query: 'q', include_answer: true, search_depth: 'advanced' });
    expect(request.auth).toEqual({ type: 'bearer', token: 'tv-key' });
  });

  test('a provider surfaces the fetch error instead of returning an empty list', async () => {
    const fetcher = async () => ({
      success: false,
      summary: { total: 1, succeeded: 0, failed: 1 },
      results: [{ url: 'https://example.test', status: 401, error: 'unauthorized' }],
    });
    const provider = createTavilySearchProvider(contextFor({}, fetcher));
    await expect(provider.search({ query: 'q' })).rejects.toThrow('unauthorized');
  });

  test('a provider rejects a non-JSON body', async () => {
    const { fetcher } = recordingFetcher('<html>not json</html>');
    const provider = createBraveSearchProvider(contextFor({}, fetcher));
    await expect(provider.search({ query: 'q' })).rejects.toThrow('invalid JSON');
  });

  test('duckduckgo parses organic results and the instant answer and posts the query form', async () => {
    const { fetcher, inputs } = recordingFetcher(
      `
        <td valign="top">1.&nbsp;</td>
        <a class="result-link" href="https://example.com/result">Example result</a>
        <td class="result-snippet">Example snippet</td>
        <span class="link-text">example.com/result</span>
      `,
      JSON.stringify({ Abstract: 'Example instant answer', AbstractURL: 'https://example.com/answer' }),
    );
    const provider = createDuckDuckGoProvider({ fetcher });
    const response = await provider.search({ query: 'x', region: 'us-en', safeSearch: 'strict' });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ url: 'https://example.com/result', title: 'Example result', snippet: 'Example snippet', providerId: 'duckduckgo' });
    expect(response.instantAnswer?.abstract).toBe('Example instant answer');
    expect(response.instantAnswer?.url).toBe('https://example.com/answer');
    const [lite, instant] = inputs[0]!.urls as FetchUrlInput[];
    expect(lite!.method).toBe('POST');
    expect(lite!.body_data).toMatchObject({ q: 'x', kl: 'us-en' });
    expect(instant!.params).toMatchObject({ q: 'x', format: 'json' });
  });

  test('duckduckgo fails when the organic fetch errors', async () => {
    const fetcher = async () => ({
      success: false,
      summary: { total: 1, succeeded: 0, failed: 1 },
      results: [{ url: 'https://lite.duckduckgo.com/lite/', status: 500, error: 'upstream down' }],
    });
    await expect(createDuckDuckGoProvider({ fetcher }).search({ query: 'x' })).rejects.toThrow('upstream down');
  });
});
