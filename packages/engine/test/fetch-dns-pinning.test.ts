// Proves: The fetch tool reaches a loopback, private or cloud-metadata address through a host name, a redirect or a second DNS answer; or serves a response fetched with one credential to a request with another.
// Red when: A name resolving to a refused range is requested, a redirect hop is followed unchecked, the request goes to the name instead of the checked address, or the response cache is keyed without the credential.

// The fetch tool checks where a host name resolves, not only how it is
// written: every A and AAAA answer is compared with the refused address ranges
// before each request hop (the first and every redirect), and the request is
// pinned to the checked address so a second lookup cannot rebind it.
//
// The resolver is injected and the network is the stand-in: `fetch` records
// every request that would have left the machine, so "refused" means nothing
// was sent.
import { afterEach, describe, expect, test } from 'bun:test';
import { executeFetchInput, FetchRuntimeService } from '../platform/src/platform/tools/fetch/runtime.ts';
import type { HostResolver } from '../platform/src/platform/runtime/network/destination.ts';

const DNS: Readonly<Record<string, readonly string[]>> = {
  'loopback.test': ['127.0.0.1'],
  'metadata.test': ['169.254.169.254'],
  'private.test': ['10.0.0.5'],
  'mixed.test': ['203.0.113.10', '192.168.1.20'],
  'v6-local.test': ['fd00::5'],
  'mapped.test': ['::ffff:127.0.0.1'],
  'public.test': ['203.0.113.10', '2001:db8::10'],
  'hop.test': ['203.0.113.20'],
  'metadata.google.internal': ['169.254.169.254'],
  'app.localhost': ['127.0.0.1'],
  'private-172.test': ['172.16.0.1'],
  'private-192.test': ['192.168.0.1'],
  'unspecified.test': ['0.0.0.0'],
  'v6-loopback.test': ['::1'],
  'v6-link-local.test': ['fe80::1'],
  'mapped-metadata.test': ['::ffff:a9fe:a9fe'],
};

const lookups: string[] = [];
const resolver: HostResolver = async (hostname) => {
  lookups.push(hostname);
  const answers = DNS[hostname];
  if (!answers) throw new Error(`ENOTFOUND ${hostname}`);
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

interface SeenRequest { readonly url: string; readonly host: string | null; readonly serverName?: string | undefined }
const seen: SeenRequest[] = [];
const originalFetch = globalThis.fetch;

function stubNetwork(respond: (request: SeenRequest) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit & { tls?: { serverName?: string } }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = { url, host: new Headers(init?.headers).get('host'), serverName: init?.tls?.serverName };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  seen.length = 0;
  lookups.length = 0;
});

async function fetchOne(url: string) {
  const output = await executeFetchInput({ urls: [{ url }] }, { resolveHost: resolver });
  return output.results?.[0];
}

describe('fetch resolves, checks and pins every hop', () => {
  test('a name resolving to a loopback, metadata, private, unique-local or mapped-loopback address is refused before anything is sent', async () => {
    stubNetwork(() => new Response('reached'));
    for (const url of ['http://loopback.test/admin', 'http://metadata.test/latest/meta-data/', 'http://private.test/',
      'http://v6-local.test/', 'http://mapped.test/', 'http://metadata.google.internal/computeMetadata/v1/',
      'http://private-172.test/', 'http://private-192.test/', 'http://unspecified.test/', 'http://v6-loopback.test/',
      'http://v6-link-local.test/', 'http://mapped-metadata.test/']) {
      const result = await fetchOne(url);
      expect(result?.error, url).toBeDefined();
      expect(result?.content, url).toBeUndefined();
    }
    expect(seen).toEqual([]);
  });

  test('a redirect to a name resolving to a refused range is refused before it is followed', async () => {
    stubNetwork((request) => new Response('', { status: 302, headers: { location: request.host === 'hop.test' ? 'http://loopback.test/steal' : '/' } }));
    const result = await fetchOne('http://hop.test/start');
    expect(result?.error).toBeDefined();
    expect(seen.map((request) => request.host)).toEqual(['hop.test']);
    expect(lookups).toEqual(['hop.test', 'loopback.test']);
  });

  test('a public answer passes and the request is pinned to the checked address', async () => {
    stubNetwork(() => new Response('public page', { headers: { 'content-type': 'text/plain' } }));
    const result = await fetchOne('https://public.test/doc?x=1');
    expect(result?.error).toBeUndefined();
    expect(result?.content).toContain('public page');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://203.0.113.10/doc?x=1');
    expect(seen[0]!.host).toBe('public.test');
    expect(seen[0]!.serverName).toBe('public.test');
    expect(lookups).toEqual(['public.test']);
  });
});

test('a cached response fetched with one credential is never served to a request with another or none', async () => {
  let calls = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls++;
    return new Response(new Headers(init?.headers).get('authorization') ?? 'anonymous payload', { headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const runtime = new FetchRuntimeService();
  const get = async (headers?: Record<string, string>) =>
    (await runtime.execute({ urls: [{ url: 'https://public.test/data', headers }], cache_ttl_seconds: 60, extract: 'raw' }, { resolveHost: resolver })).results?.[0];
  expect((await get({ Authorization: 'Bearer A' }))?.content).toBe('Bearer A');
  expect((await get({ Authorization: 'Bearer B' }))?.content).toBe('Bearer B');
  expect((await get())?.content).toBe('anonymous payload');
  // The cache is live: the same anonymous request is answered without another fetch.
  expect((await get())?.content).toBe('anonymous payload');
  expect(calls).toBe(3);
});
