// What the fetch tool refuses to send, what it reports about the response it got,
// and what it does not repeat: non-http schemes (including through a redirect),
// the address ranges that reach internal services, credentials that are missing,
// error statuses that must not be cached, and request bodies that go out as the
// caller wrote them.
import { afterEach, describe, expect, test } from 'bun:test';
import { executeFetchInput, FetchRuntimeService } from '../platform/src/platform/tools/fetch/runtime.ts';
import { classifyResolvedAddress, extractHostname } from '../platform/src/platform/tools/fetch/trust-tiers.ts';
import { applySanitizer } from '../platform/src/platform/tools/fetch/sanitizer.ts';
import type { HostResolver } from '../platform/src/platform/tools/fetch/pinned-request.ts';

const DNS: Readonly<Record<string, readonly string[]>> = {
  'example.com': ['203.0.113.10'],
  'hop.test': ['203.0.113.20'],
  'multi.test': ['203.0.113.30', '203.0.113.31'],
};
const resolver: HostResolver = async (hostname) => {
  const answers = DNS[hostname];
  if (!answers) throw new Error(`ENOTFOUND ${hostname}`);
  return answers.map((address) => ({ address, family: 4 }));
};

interface SeenRequest { readonly url: string; readonly method: string; readonly headers: Headers; readonly body: unknown }
const seen: SeenRequest[] = [];
const originalFetch = globalThis.fetch;

function stubNetwork(respond: (request: SeenRequest) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  seen.length = 0;
});

const deps = { resolveHost: resolver };

describe('fetch only sends http and https requests', () => {
  test('a file URL on a public host name is refused, and nothing is sent', async () => {
    stubNetwork(() => new Response('secret file text'));
    const output = await executeFetchInput({ urls: [{ url: 'file://example.com/etc/hostname' }] }, deps);
    const result = output.results?.[0];
    expect(result?.error).toMatch(/file: scheme is not fetchable/);
    expect(JSON.stringify(output)).not.toContain('secret file text');
    expect(seen).toEqual([]);
  });

  test('a redirect to a file URL is refused instead of followed', async () => {
    stubNetwork(() => new Response(null, { status: 302, headers: { location: 'file:///etc/hostname' } }));
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/start' }] }, deps)).results?.[0];
    expect(result?.error).toMatch(/Redirect blocked: .*file:/);
    expect(seen).toHaveLength(1);
  });

  test('the host is read from the URL itself, whatever its scheme', () => {
    expect(extractHostname('file://example.com/x')).toBe('example.com');
    expect(extractHostname('example.com:8080/x')).toBe('example.com');
    expect(extractHostname('localhost')).toBe('localhost');
  });
});

describe('addresses that reach internal services are refused', () => {
  test.each([
    ['100.100.100.200', 'shared'],
    ['100.64.0.1', 'shared'],
    ['100.127.255.255', 'shared'],
    ['198.18.0.1', 'reserved'],
    ['192.0.0.192', 'reserved'],
    ['fec0::1', 'reserved'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['2002:7f00:1::', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
  ])('%s is %s', (address, range) => {
    expect(classifyResolvedAddress(address)).toBe(range as never);
  });

  test.each(['100.63.255.255', '100.128.0.1', '8.8.8.8', '2002:808:808::', '64:ff9b::808:808', '2606:4700::1111'])('%s is reachable', (address) => {
    expect(classifyResolvedAddress(address)).toBeNull();
  });
});

describe('credentials the call names must exist', () => {
  test('an unknown service is an error and sends nothing', async () => {
    stubNetwork(() => new Response('ok'));
    const result = (await executeFetchInput({ urls: [{ url: 'http://example.com/', service: 'ghost' }] },
      { ...deps, serviceRegistry: { resolveAuth: async () => null } })).results?.[0];
    expect(result?.error).toMatch(/Credential missing: service "ghost" has no credential/);
    expect(seen).toEqual([]);
  });

  test('a bearer auth with an empty token is an error and sends nothing', async () => {
    stubNetwork(() => new Response('ok'));
    const result = (await executeFetchInput({ urls: [{ url: 'http://example.com/', auth: { type: 'bearer', token: '' } }] }, deps)).results?.[0];
    expect(result?.error).toMatch(/Credential missing: auth type "bearer" has no token/);
    expect(seen).toEqual([]);
  });
});

describe('what the result says about where it came from', () => {
  test('final_url is the URL as written after redirects, not the pinned address, and redirected is true', async () => {
    stubNetwork((request) => request.url.endsWith('/a')
      ? new Response(null, { status: 302, headers: { location: '/b' } })
      : new Response('landed'));
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/a' }] }, deps)).results?.[0];
    expect(result?.content).toBe('landed');
    expect(result?.final_url).toBe('http://hop.test/b');
    expect(result?.redirected).toBe(true);
  });

  test('a request with no redirect reports redirected false and no final_url', async () => {
    stubNetwork(() => new Response('plain'));
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/a' }] }, deps)).results?.[0];
    expect(result?.redirected).toBe(false);
    expect(result?.final_url).toBeUndefined();
  });
});

describe('an error status is not cached', () => {
  test('a 503 is fetched again, and the success that follows is cached', async () => {
    let calls = 0;
    stubNetwork(() => (++calls === 1 ? new Response('busy', { status: 503 }) : new Response('fine')));
    const runtime = new FetchRuntimeService();
    const input = { urls: [{ url: 'http://hop.test/page' }], cache_ttl_seconds: 300 };
    expect((await runtime.execute(input, deps)).results?.[0]?.status).toBe(503);
    const second = (await runtime.execute(input, deps)).results?.[0];
    expect(second?.status).toBe(200);
    expect(second?.from_cache).toBeUndefined();
    const third = (await runtime.execute(input, deps)).results?.[0];
    expect(third?.from_cache).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('a request that has side effects is not repeated against another address', () => {
  const reset = (code: string): Error => Object.assign(new Error(code), { code });

  test('a POST whose connection resets is sent once', async () => {
    stubNetwork(() => { throw reset('ECONNRESET'); });
    const result = (await executeFetchInput({ urls: [{ url: 'http://multi.test/pay', method: 'POST', body: 'x' }] }, deps)).results?.[0];
    expect(result?.error).toBeDefined();
    expect(seen).toHaveLength(1);
  });

  test('a POST whose connection is refused moves on to the next address', async () => {
    stubNetwork((request) => { if (request.url.includes('203.0.113.30')) throw reset('ECONNREFUSED'); return new Response('ok'); });
    const result = (await executeFetchInput({ urls: [{ url: 'http://multi.test/pay', method: 'POST', body: 'x' }] }, deps)).results?.[0];
    expect(result?.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test('a GET whose connection resets moves on to the next address', async () => {
    stubNetwork((request) => { if (request.url.includes('203.0.113.30')) throw reset('ECONNRESET'); return new Response('ok'); });
    const result = (await executeFetchInput({ urls: [{ url: 'http://multi.test/read' }] }, deps)).results?.[0];
    expect(result?.status).toBe(200);
    expect(seen).toHaveLength(2);
  });
});

describe('request bodies go out as written', () => {
  test('body_base64 is sent as the decoded bytes, labelled as binary', async () => {
    stubNetwork(() => new Response('ok'));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await executeFetchInput({ urls: [{ url: 'http://hop.test/upload', method: 'PUT', body_base64: Buffer.from(bytes).toString('base64') }] }, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBeInstanceOf(Uint8Array);
    expect([...(seen[0]!.body as Uint8Array)]).toEqual([...bytes]);
    expect(seen[0]!.headers.get('content-type')).toBe('application/octet-stream');
  });

  test('a raw body gets no Content-Type of the tool\'s choosing, a json body does', async () => {
    stubNetwork(() => new Response('ok'));
    await executeFetchInput({ urls: [{ url: 'http://hop.test/x', method: 'POST', body_type: 'raw', body: '<a/>' }] }, deps);
    await executeFetchInput({ urls: [{ url: 'http://hop.test/x', method: 'POST', body_type: 'json', body: '{}' }] }, deps);
    expect(seen[0]!.headers.get('content-type')).toBeNull();
    expect(seen[1]!.headers.get('content-type')).toBe('application/json');
  });
});

describe('response size', () => {
  test('a response larger than the default cap is cut and says so', async () => {
    const chunk = new Uint8Array(1_000_000).fill(97);
    stubNetwork(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (let i = 0; i < 6; i++) controller.enqueue(chunk); controller.close(); },
    })));
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/big' }] }, deps)).results?.[0];
    expect(result?.truncated).toBe(true);
    expect(result?.byteSize).toBeLessThanOrEqual(5_000_000);
  });
});

describe('sanitization', () => {
  test('a result whose content the sanitizer changed says so; an untouched one does not', async () => {
    stubNetwork(() => new Response('{"city":"Zürich"}', { headers: { 'content-type': 'application/json' } }));
    const changed = (await executeFetchInput({ urls: [{ url: 'http://hop.test/j' }], extract: 'json', sanitize_mode: 'strict' }, deps)).results?.[0];
    expect(changed?.sanitized).toBe(true);
    const untouched = (await executeFetchInput({ urls: [{ url: 'http://hop.test/j' }], extract: 'json', sanitize_mode: 'safe-text' }, deps)).results?.[0];
    expect(untouched?.sanitized).toBeUndefined();
  });

  test('safe-text removes tag characters and other invisible text', () => {
    const hidden = `a${String.fromCodePoint(0xe0041)}​b‮c`;
    const result = applySanitizer(hidden, 'safe-text');
    expect(result.content).toBe('abc');
    expect(result.modified).toBe(true);
  });

  test('a call cannot make its own host trusted to lift sanitization', async () => {
    stubNetwork(() => new Response('hello'));
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/' }], trusted_hosts: ['hop.test'], sanitize_mode: 'none' }, deps)).results?.[0];
    expect(result?.host_trust_tier).toBe('unknown');
    expect(result?.sanitization_tier).toBe('safe-text');
  });
});

describe('structured extraction', () => {
  const html = '<div class="a b">first</div><div class="a">second</div><p id="x">third</p>';
  const page = () => new Response(html, { headers: { 'content-type': 'text/html' } });

  test('an unsupported selector is an error naming it, not an empty result', async () => {
    stubNetwork(page);
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/', extract: 'structured', selectors: ['table td a[href]'] }] }, deps)).results?.[0];
    expect(result?.error).toMatch(/Unsupported selector.*table td a\[href\]/);
  });

  test('a tag with several classes matches only elements that carry all of them', async () => {
    stubNetwork(page);
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/', extract: 'structured', selectors: ['div.a.b', '#x'] }] }, deps)).results?.[0];
    expect(JSON.parse(result?.content ?? '[]')).toEqual(['first', 'third']);
  });

  test('an escaped ampersand decodes once', async () => {
    stubNetwork(() => new Response('<p>&amp;lt;b&amp;gt;</p>', { headers: { 'content-type': 'text/html' } }));
    const result = (await executeFetchInput({ urls: [{ url: 'http://hop.test/', extract: 'text' }] }, deps)).results?.[0];
    expect(result?.content).toBe('&lt;b&gt;');
  });
});
