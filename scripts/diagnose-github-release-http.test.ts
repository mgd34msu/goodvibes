import { expect, test } from 'bun:test';
import { classifyGithubReleaseResponse, diagnoseGithubReleaseHttp, releaseMetadataUrl } from './diagnose-github-release-http.mjs';

test.each([
  [403, { 'x-ratelimit-remaining': 0 }, '<private-html>', 'primary-rate-limit'],
  [429, { 'x-ratelimit-remaining': 0 }, '{}', 'primary-rate-limit'],
  [403, {}, JSON.stringify({ message: 'API rate limit exceeded for 192.0.2.1. (private suffix)' }), 'primary-rate-limit-message'],
  [429, {}, JSON.stringify({ message: 'You have exceeded a secondary rate limit. Private suffix.' }), 'secondary-rate-limit'],
  [401, {}, JSON.stringify({ message: 'Bad credentials' }), 'bad-credentials'],
  [401, {}, JSON.stringify({ message: 'Requires authentication' }), 'authentication-required'],
  [403, {}, JSON.stringify({ message: 'Resource not accessible by integration' }), 'resource-not-accessible'],
  [404, {}, JSON.stringify({ message: 'Not Found' }), 'not-found'],
  [403, {}, JSON.stringify({ message: 'private unknown message' }), 'unclassified-http-error'],
  [503, {}, JSON.stringify({ message: 'API rate limit exceeded for private value' }), 'unclassified-http-error'],
  [403, {}, 'not-json private body', 'unclassified-http-error'],
  [403, {}, JSON.stringify([{ message: 'Bad credentials' }]), 'unclassified-http-error'],
  [200, {}, 'private release payload', 'http-success'],
] as const)('classifies status %s from bounded private evidence only', (status, headers, body, expected) => {
  expect(classifyGithubReleaseResponse(status, headers, body)).toBe(expected);
});

test('one fixed anonymous request and optional authenticated comparison retain only safe evidence', async () => {
  const secret = 'sentinel-token-body-header';
  const requests: Array<{ url: unknown; options: RequestInit | undefined }> = [];
  const result = await diagnoseGithubReleaseHttp({ token: secret, fetchImpl: (async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ message: `API rate limit exceeded for ${secret}`, documentation_url: secret, errors: [{ secret }] }), {
      status: requests.length === 1 ? 403 : 200,
      headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': requests.length === 1 ? '0' : '4999',
        'x-ratelimit-used': '60', 'x-ratelimit-reset': '1794400000', 'retry-after': '27',
        'x-ratelimit-resource': secret, 'set-cookie': secret, 'x-private': secret },
    });
  }) });
  expect(requests).toHaveLength(2);
  for (const request of requests) { expect(request.url).toBe(releaseMetadataUrl); expect(request.options?.redirect).toBe('error'); }
  expect(requests[0]!.options?.headers).toBeUndefined();
  expect(requests[1]!.options?.headers).toEqual({ authorization: `Bearer ${secret}` });
  expect(result.results.map(value => [value.mode, value.status, value.kind])).toEqual([
    ['unauthenticated', 403, 'primary-rate-limit'], ['authenticated-comparison', 200, 'http-success'],
  ]);
  expect(result.results[0]!.rateLimit).toEqual({ 'x-ratelimit-limit': 60, 'x-ratelimit-remaining': 0,
    'x-ratelimit-used': 60, 'x-ratelimit-reset': 1794400000, 'retry-after': 27 });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('malformed numeric headers and network causes never escape or cause retries', async () => {
  let calls = 0;
  const result = await diagnoseGithubReleaseHttp({ fetchImpl: (async () => {
    calls++;
    return new Response('{"message":"private-unknown"}', { status: 403, headers: {
      'x-ratelimit-limit': '9999999999999999', 'x-ratelimit-remaining': '-1', 'x-ratelimit-used': 'private',
      'x-ratelimit-reset': '1.5', 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT',
    } });
  }) });
  expect(calls).toBe(1); expect(result.results[0]!.rateLimit).toEqual({});
  expect(result.results[0]!.kind).toBe('unclassified-http-error');
  const failed = await diagnoseGithubReleaseHttp({ fetchImpl: (async () => {
    calls++; throw new Error('private target', { cause: { token: 'private-token' } });
  }) });
  expect(calls).toBe(2);
  expect(failed.results).toEqual([{ mode: 'unauthenticated', status: null, rateLimit: {}, kind: 'request-failed' }]);
  expect(JSON.stringify([result, failed])).not.toContain('private');
});

test.each([200, 403])('cancels the owned body after success or the private error-body bound (%s)', async status => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('private'.repeat(3000))); },
    cancel() { cancelled++; } });
  const result = await diagnoseGithubReleaseHttp({ fetchImpl: async () => new Response(stream, { status }) });
  expect(cancelled).toBe(1);
  expect(result.results[0]).toMatchObject({ status, kind: status === 200 ? 'http-success' : 'unclassified-http-error' });
  if (status === 403) expect(result.results[0]!.body).toBe('exceeds-bound');
  expect(JSON.stringify(result)).not.toContain('private');
});
