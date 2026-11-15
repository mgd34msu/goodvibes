/**
 * Local provider context window ingestion tests.
 *
 * Tests for:
 * - Parsing max_context_length from /v1/models responses
 * - Fallback when field is missing or invalid
 * - Provenance ladder (provider_api > configured_cap > fallback)
 * - Cache TTL and per-provider isolation (service tests with an injected fetch and clock)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  FALLBACK_CONTEXT_WINDOW,
  LocalContextIngestionService,
} from '@goodvibes-jev/engine/platform/platform/providers';

// ---------------------------------------------------------------------------
// resolveContextWindow, unit tests (pure function, no network)
// ---------------------------------------------------------------------------

describe('resolveContextWindow: provenance ladder', () => {
  test('provider_api wins when apiContextLength is valid', () => {
    const result = resolveContextWindow('my-model', 131072, 32768);
    expect(result.tokens).toBe(131072);
    expect(result.provenance).toBe('provider_api');
    expect(result.apiReportedTokens).toBe(131072);
    expect(result.safeCap).toBe(131072);
  });

  test('provider_api wins even when configured_cap is larger', () => {
    const result = resolveContextWindow('my-model', 8192, 200_000);
    expect(result.tokens).toBe(8192);
    expect(result.provenance).toBe('provider_api');
  });

  test('configured_cap used when apiContextLength is null', () => {
    const result = resolveContextWindow('my-model', null, 65536);
    expect(result.tokens).toBe(65536);
    expect(result.provenance).toBe('configured_cap');
    expect(result.apiReportedTokens).toBeUndefined();
  });

  test('configured_cap used when apiContextLength is 0', () => {
    const result = resolveContextWindow('my-model', 0, 65536);
    expect(result.tokens).toBe(65536);
    expect(result.provenance).toBe('configured_cap');
  });

  test('fallback used when both api and config are 0/null', () => {
    const result = resolveContextWindow('my-model', null, 0);
    expect(result.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(result.provenance).toBe('fallback');
  });

  test('fallback used when api is null and config is 0', () => {
    const result = resolveContextWindow('unknown-model', null, 0);
    expect(result.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(result.provenance).toBe('fallback');
  });

  test('an unknown local model gets the same fallback window as a remote one', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  test('negative apiContextLength is treated as invalid (falls through)', () => {
    const result = resolveContextWindow('my-model', -1, 32768);
    // -1 is <= 0 so falls through to configured_cap
    expect(result.tokens).toBe(32768);
    expect(result.provenance).toBe('configured_cap');
  });
});

// ---------------------------------------------------------------------------
// LocalContextIngestionService: probing, caching, failure and isolation
// ---------------------------------------------------------------------------

describe('LocalContextIngestionService', () => {
  const originalFetch = globalThis.fetch;
  /** Every URL requested, in order. */
  let requested: string[];
  /** Bodies served for `<base>/models`, keyed by base URL; absent means the server is down. */
  let modelsByBase: Map<string, unknown>;
  let clock: number;
  let service: LocalContextIngestionService;

  beforeEach(() => {
    requested = [];
    modelsByBase = new Map();
    clock = 1_000_000;
    service = new LocalContextIngestionService(() => clock);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      for (const [base, body] of modelsByBase) {
        if (url === `${base}/models`) {
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const modelsRequests = (base: string) => requested.filter((url) => url === `${base}/models`).length;

  test('reads max_context_length from the /v1/models listing', async () => {
    const base = 'http://local-a.test/v1';
    modelsByBase.set(base, { data: [{ id: 'big', max_context_length: 131072 }, { id: 'small', max_context_length: 4096 }] });
    const windows = await service.ingestProviderContextWindows('local-a', base);
    expect(windows?.get('big')).toBe(131072);
    expect(windows?.get('small')).toBe(4096);
  });

  test('a model with a missing or invalid field is left out so the ladder falls through', async () => {
    const base = 'http://local-a.test/v1';
    modelsByBase.set(base, {
      data: [{ id: 'good', max_context_length: 16384 }, { id: 'absent' }, { id: 'zero', max_context_length: 0 }, { id: 'text', max_context_length: 'big' }],
    });
    const windows = await service.ingestProviderContextWindows('local-a', base);
    expect([...(windows?.keys() ?? [])]).toEqual(['good']);
    expect(resolveContextWindow('absent', windows?.get('absent') ?? null, 0).provenance).toBe('fallback');
  });

  test('a second call inside the TTL is served from the cache without fetching', async () => {
    const base = 'http://local-a.test/v1';
    modelsByBase.set(base, { data: [{ id: 'm', max_context_length: 8000 }] });
    await service.ingestProviderContextWindows('local-a', base);
    const after = requested.length;
    clock += 59_000;
    const again = await service.ingestProviderContextWindows('local-a', base);
    expect(again?.get('m')).toBe(8000);
    expect(requested.length).toBe(after);
  });

  test('after the TTL the provider is probed again and a changed window is picked up', async () => {
    const base = 'http://local-a.test/v1';
    modelsByBase.set(base, { data: [{ id: 'm', max_context_length: 8000 }] });
    await service.ingestProviderContextWindows('local-a', base);
    modelsByBase.set(base, { data: [{ id: 'm', max_context_length: 32000 }] });
    clock += 60_000;
    const fresh = await service.ingestProviderContextWindows('local-a', base);
    expect(modelsRequests(base)).toBe(2);
    expect(fresh?.get('m')).toBe(32000);
  });

  test('an offline provider yields null, is not re-probed inside the TTL, and recovers after it', async () => {
    const base = 'http://local-a.test/v1';
    expect(await service.ingestProviderContextWindows('local-a', base)).toBeNull();
    const after = requested.length;
    expect(await service.ingestProviderContextWindows('local-a', base)).toBeNull();
    expect(requested.length).toBe(after);
    expect(service.getDiagnostics()).toEqual([{ providerName: 'local-a', fetchedAt: clock, modelCount: 0, failed: true }]);

    modelsByBase.set(base, { data: [{ id: 'm', max_context_length: 8000 }] });
    clock += 60_000;
    expect((await service.ingestProviderContextWindows('local-a', base))?.get('m')).toBe(8000);
  });

  test('providers are cached independently, and clearing one leaves the other', async () => {
    const a = 'http://local-a.test/v1';
    const b = 'http://local-b.test/v1';
    modelsByBase.set(a, { data: [{ id: 'm', max_context_length: 8000 }] });
    modelsByBase.set(b, { data: [{ id: 'm', max_context_length: 64000 }] });
    expect((await service.ingestProviderContextWindows('local-a', a))?.get('m')).toBe(8000);
    expect((await service.ingestProviderContextWindows('local-b', b))?.get('m')).toBe(64000);

    service.clearProviderCache('local-a');
    const bBefore = modelsRequests(b);
    await service.ingestProviderContextWindows('local-a', a);
    await service.ingestProviderContextWindows('local-b', b);
    expect(modelsRequests(a)).toBe(2);
    expect(modelsRequests(b)).toBe(bBefore);
  });

  test('clearAllCaches forgets every provider', async () => {
    const base = 'http://local-a.test/v1';
    modelsByBase.set(base, { data: [{ id: 'm', max_context_length: 8000 }] });
    await service.ingestProviderContextWindows('local-a', base);
    expect(service.getDiagnostics()).toHaveLength(1);
    service.clearAllCaches();
    expect(service.getDiagnostics()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractContextLength field coverage (via resolveContextWindow)
// ---------------------------------------------------------------------------

describe('resolveContextWindow: field validation', () => {
  test('large context windows (e.g. 1M tokens) are passed through', () => {
    const result = resolveContextWindow('gemini-ultra', 1_048_576, 0);
    expect(result.tokens).toBe(1_048_576);
    expect(result.provenance).toBe('provider_api');
  });

  test('exact DEFAULT_CONTEXT_WINDOW value from configured_cap is valid', () => {
    const result = resolveContextWindow('old-model', null, DEFAULT_CONTEXT_WINDOW);
    expect(result.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(result.provenance).toBe('configured_cap');
  });

  test('very small context window (e.g. 1024) from API is respected', () => {
    const result = resolveContextWindow('tiny-model', 1024, 0);
    expect(result.tokens).toBe(1024);
    expect(result.provenance).toBe('provider_api');
  });
});
