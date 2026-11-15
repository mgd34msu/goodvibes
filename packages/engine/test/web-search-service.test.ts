/**
 * WebSearchService and its providers: evidence the caller asked for reaches the
 * response (or says why not), provider requests carry the owner's service
 * credentials, and the default provider is one the owner configured.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { WebSearchProviderRegistry } from '../platform/src/platform/web-search/provider-registry.js';
import { WebSearchService } from '../platform/src/platform/web-search/service.js';
import { createDuckDuckGoProvider } from '../platform/src/platform/web-search/providers/duckduckgo.js';
import { createSearxngSearchProvider } from '../platform/src/platform/web-search/providers/searxng.js';
import type { WebSearchProvider } from '../platform/src/platform/web-search/types.js';
import type { FetchInput } from '../platform/src/platform/tools/fetch/schema.js';
import { createConfiguredFetchDeps } from '../platform/src/platform/tools/fetch/runtime-deps.js';

type Served = { url: URL; headers: Headers };
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function serve(respond: (request: Request) => Response, seen: Served[] = []): { base: string; seen: Served[] } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      seen.push({ url: new URL(request.url), headers: request.headers });
      return respond(request);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

const localhostOk = { isLocalhostAllowed: () => true };
const noServices = { get: () => null };

function stubProvider(urls: readonly string[]): WebSearchProvider {
  return {
    id: 'stub',
    label: 'Stub',
    capabilities: ['search', 'evidence'],
    async search() {
      return {
        results: urls.map((url, index) => ({
          rank: index + 1, url, title: `T${index}`, snippet: `S${index}`, type: 'organic' as const, providerId: 'stub', metadata: {},
        })),
        metadata: {},
      };
    },
  };
}

function serviceWith(provider: WebSearchProvider, deps = {}): WebSearchService {
  const registry = new WebSearchProviderRegistry({ env: {}, serviceRegistry: noServices });
  registry.register(provider, { replace: true });
  return new WebSearchService(registry, deps);
}

describe('evidence', () => {
  test('includeEvidence with the default verbosity returns the fetched evidence', async () => {
    const { base } = serve(() => new Response('<html><body><p>the page text</p></body></html>', { headers: { 'content-type': 'text/html' } }));
    const response = await serviceWith(stubProvider([`${base}/page`]), localhostOk).search({ query: 'q', providerId: 'stub', includeEvidence: true, evidenceExtract: 'text' });
    expect(response.results[0]?.evidenceError).toBeUndefined();
    expect(response.verbosity).toBe('snippets');
    expect(response.results[0]?.evidence?.[0]?.content).toContain('the page text');
    expect(response.metadata.evidence).toEqual({ requested: 1, attached: 1, failed: 0 });
  });

  test('a page that could not be fetched names why and is counted', async () => {
    const { base } = serve(() => new Response('<p>fine</p>', { headers: { 'content-type': 'text/html' } }));
    // Nothing listens on port 1, so the second fetch fails.
    const response = await serviceWith(stubProvider([`${base}/ok`, 'http://127.0.0.1:1/missing']), localhostOk)
      .search({ query: 'q', providerId: 'stub', verbosity: 'evidence', evidenceExtract: 'text' });
    expect(response.results[0]?.evidence).toBeDefined();
    expect(response.results[1]?.evidence).toBeUndefined();
    expect(response.results[1]?.evidenceError).toBeTruthy();
    expect(response.metadata.evidence).toEqual({ requested: 2, attached: 1, failed: 1 });
  });

  test('an owner-blocked host is not fetched for evidence', async () => {
    const { base, seen } = serve(() => new Response('<p>secret page</p>', { headers: { 'content-type': 'text/html' } }));
    const response = await serviceWith(stubProvider([`${base}/page`]), { ...localhostOk, defaultBlockedHosts: ['127.0.0.1'] })
      .search({ query: 'q', providerId: 'stub', includeEvidence: true, evidenceExtract: 'text' });
    expect(seen).toHaveLength(0);
    expect(response.results[0]?.evidence).toBeUndefined();
    expect(response.results[0]?.evidenceError).toContain('blocked');
  });

  test('no evidence is requested and no evidence summary is added by default', async () => {
    const response = await serviceWith(stubProvider(['https://example.test/a'])).search({ query: 'q', providerId: 'stub' });
    expect(response.metadata.evidence).toBeUndefined();
  });
});

describe('provider requests use the owner fetch policy', () => {
  test('a service entry credential is sent to the provider', async () => {
    const { base, seen } = serve(() => Response.json({ web: { results: [{ url: 'https://example.test/r', title: 'R', description: 'D' }] } }));
    const serviceRegistry = {
      get: (name: string) => name === 'brave-search' ? { baseUrl: base } : null,
      resolveAuth: async () => ({ 'X-Subscription-Token': 'service-credential' }),
    };
    const registry = new WebSearchProviderRegistry({ env: {}, serviceRegistry: serviceRegistry as never });
    const service = new WebSearchService(registry, { serviceRegistry: serviceRegistry as never, ...localhostOk });
    const response = await service.search({ query: 'q', providerId: 'brave' });
    expect(response.results[0]?.url).toBe('https://example.test/r');
    expect(seen[0]?.headers.get('x-subscription-token')).toBe('service-credential');
  });

  test('a self-hosted SearXNG on loopback works once localhost is approved', async () => {
    const { base } = serve(() => Response.json({ results: [{ url: 'https://example.test/s', title: 'S', content: 'C' }] }));
    const registry = new WebSearchProviderRegistry({ env: { SEARXNG_BASE_URL: base }, serviceRegistry: noServices });
    const response = await new WebSearchService(registry, localhostOk).search({ query: 'q', providerId: 'searxng' });
    expect(response.results[0]?.url).toBe('https://example.test/s');
  });

  test('a blank base-url variable falls back to the service entry, as the descriptor reports', async () => {
    const urls: string[] = [];
    const provider = createSearxngSearchProvider({
      env: { SEARXNG_BASE_URL: '  ' },
      serviceRegistry: { get: () => ({ baseUrl: 'https://searx.example.test/' }) as never },
      fetcher: async (input: FetchInput) => {
        urls.push(input.urls[0]!.url);
        return { success: true, summary: { total: 1, succeeded: 1, failed: 0 }, results: [{ url: input.urls[0]!.url, status: 200, content: '{"results":[]}' }] };
      },
    });
    expect(provider.descriptor?.().configured).toBe(true);
    await provider.search({ query: 'q', providerId: 'stub' });
    expect(urls[0]).toBe('https://searx.example.test/search');
  });
});

describe('fetch deps built from configuration', () => {
  const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] } as never);
  const searxngAt = (base: string) => new WebSearchProviderRegistry({ env: { SEARXNG_BASE_URL: base }, serviceRegistry: noServices });
  const respond = () => Response.json({ results: [{ url: 'https://example.test/s', title: 'S', content: 'C' }] });

  test('a loopback search works when the project setting allows localhost', async () => {
    const { base } = serve(respond);
    const deps = createConfiguredFetchDeps({ serviceRegistry: noServices as never, featureFlags: null, configManager: config({ 'fetch.allowLocalhost': true }) });
    const response = await new WebSearchService(searxngAt(base), deps).search({ query: 'q', providerId: 'searxng' });
    expect(response.results[0]?.url).toBe('https://example.test/s');
  });

  test('a loopback search is refused when nothing approves it, and a late-bound approval is read when the request is made', async () => {
    const { base } = serve(respond);
    let approval: (() => Promise<boolean>) | undefined;
    const deps = createConfiguredFetchDeps({
      serviceRegistry: noServices as never, featureFlags: null, configManager: config({ 'fetch.allowLocalhost': false }),
      localhostFetchApprovalSource: () => approval as never,
    });
    const service = new WebSearchService(searxngAt(base), deps);
    await expect(service.search({ query: 'q', providerId: 'searxng' })).rejects.toThrow();
    approval = async () => true;
    expect((await service.search({ query: 'q', providerId: 'searxng' })).results[0]?.url).toBe('https://example.test/s');
  });

  test('blocked hosts from configuration apply to search evidence', async () => {
    const { base, seen } = serve(() => new Response('page'));
    const deps = createConfiguredFetchDeps({
      serviceRegistry: noServices as never, featureFlags: null,
      configManager: config({ 'fetch.allowLocalhost': true, 'fetch.blockedHosts': '127.0.0.1' }),
    });
    const response = await serviceWith(stubProvider([`${base}/page`]), deps).search({ query: 'q', providerId: 'stub', includeEvidence: true, evidenceExtract: 'text' });
    expect(seen).toHaveLength(0);
    expect(response.results[0]?.evidenceError).toContain('blocked');
  });
});

describe('DuckDuckGo result links', () => {
  test('a target with percent escapes is returned as written, not decoded twice', async () => {
    const target = 'https://x.example/a%20b?q=a%26b&p=100%25';
    const html = `<table><tr><td valign="top">1.&nbsp;</td><td><a class="result-link" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc">Title</a></td></tr></table>`;
    const provider = createDuckDuckGoProvider({
      fetcher: async () => ({ success: true, summary: { total: 1, succeeded: 1, failed: 0 }, results: [{ url: 'x', status: 200, content: html }] }),
    });
    const response = await provider.search({ query: 'q', includeInstantAnswer: false });
    expect(response.results[0]?.url).toBe(target);
  });
});

describe('choosing a provider', () => {
  test('with a configured keyed provider, a search without an id uses it', () => {
    const configured = new WebSearchProviderRegistry({ env: { BRAVE_SEARCH_API_KEY: 'k' }, serviceRegistry: noServices });
    expect(configured.find()?.id).toBe('brave');
    const none = new WebSearchProviderRegistry({ env: {}, serviceRegistry: noServices });
    expect(none.find()?.id).toBe('duckduckgo');
  });

  test('an unknown id names the registered ones', async () => {
    const registry = new WebSearchProviderRegistry({ env: {}, serviceRegistry: noServices });
    await expect(new WebSearchService(registry).search({ query: 'q', providerId: 'bing' })).rejects.toThrow(/Registered providers:.*duckduckgo/);
  });

  test('a known provider with no credential is refused by name before any request', async () => {
    const registry = new WebSearchProviderRegistry({ env: {}, serviceRegistry: noServices });
    await expect(new WebSearchService(registry).search({ query: 'q', providerId: 'brave' })).rejects.toThrow(/"brave" is not configured.*Configured providers:.*duckduckgo/);
  });
});

