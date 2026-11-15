import { describe, expect, test } from 'bun:test';
import { createSystemOnePort, endpointKind, JudgmentContextLimitError, noul, type JudgmentConfig } from '../src/index.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const hosted = (baseURL: string) => ({ kind: 'hosted' as const, baseURL, apiKey: 'test-key' });
const request = { state: 'Complete source', questions: { urgent: noul('Does this convey urgency?') } };

function config(fetch: NonNullable<JudgmentConfig['fetch']>, extra: Partial<JudgmentConfig> = {}): JudgmentConfig {
  return { signal: new AbortController().signal, endpoint: hosted('https://primary.test'), model: 'jev-latest', timeoutMs: 1000, retry: {}, fetch, ...extra };
}

describe('judgment targets', () => {
  test('a context-limit refusal from every target reaches the caller as a context-limit error', async () => {
    const hosts: string[] = [];
    const port = createSystemOnePort(config(async url => {
      hosts.push(new URL(String(url)).host);
      return json(400, { detail: { error_type: 'max_tokens_exceeded' } });
    }, { fallbacks: [{ endpoint: hosted('https://backup.test'), model: 'jev-latest' }] }));
    await expect(port.ask(request)).rejects.toBeInstanceOf(JudgmentContextLimitError);
    expect(new Set(hosts)).toEqual(new Set(['primary.test', 'backup.test']));
  });

  test('an availability failure on every target still reports the halt notice', async () => {
    const port = createSystemOnePort(config(async () => json(503, {}),
      { fallbacks: [{ endpoint: hosted('https://backup.test'), model: 'jev-latest' }] }));
    await expect(port.ask(request)).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringContaining('Check API keys') });
  });

  test('a rate-limited single target names the wait on the next ask', async () => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls++; return json(429, {}, { 'retry-after': '60' }); }));
    await expect(port.ask(request)).rejects.toMatchObject({ kind: 'unavailable' });
    const second = await port.ask(request).catch((error: unknown) => error);
    expect(second).toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/retry in about \d+ s/) });
    expect((second as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  test('an unauthenticated endpoint is never sent a key', async () => {
    const seen: Array<string | null> = [];
    const port = createSystemOnePort(config(async (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return json(200, { model: 'jev-latest', answers: { urgent: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } });
    }, { endpoint: { ...hosted('https://primary.test'), authentication: 'none' } }));
    await port.ask(request);
    expect(seen).toEqual([null]);
  });
});

describe('endpointKind', () => {
  test('only literal loopback addresses are local', () => {
    expect(endpointKind('http://127.0.0.1')).toBe('local');
    expect(endpointKind('http://127.8.9.10:8080')).toBe('local');
    expect(endpointKind('http://localhost:11434')).toBe('local');
    expect(endpointKind('http://[::1]:8080')).toBe('local');
    expect(endpointKind('http://127.example.com')).toBe('hosted');
    expect(endpointKind('http://127.0.0.1.attacker.test')).toBe('hosted');
    expect(endpointKind('https://api.typesafe.ai')).toBe('hosted');
  });
});
