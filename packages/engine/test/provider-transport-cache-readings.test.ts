/**
 * provider-transport-cache-readings.test.ts
 *
 * GitHub Copilot's transport per model: the /models entry decides in code
 * when it carries `supported_endpoints` or `vendor`; otherwise a `claude-` id
 * takes the Anthropic path. No decision request either way.
 *
 * Gemini context caches: a resource is created only for an input seen twice,
 * reused per exact input, deleted on eviction and dispose, and a 400 naming the
 * minimum marks the input uncacheable. No decision request either way.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { GitHubCopilotProvider } from '../platform/src/platform/providers/github-copilot.js';
import { GeminiProvider } from '../platform/src/platform/providers/gemini.js';
import { forgetProviderCacheReadings } from '../platform/src/platform/routing/provider-cache-readings.js';
import { decisionPort } from './helpers/decision-port.ts';

let dir: string;
let previousPort: ReturnType<typeof installJudgmentPort>;
const originalFetch = globalThis.fetch;
const originalToken = process.env['COPILOT_GITHUB_TOKEN'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transport-cache-readings-'));
  previousPort = installJudgmentPort(undefined);
  forgetProviderCacheReadings();
  process.env['COPILOT_GITHUB_TOKEN'] = 'gh-token-abc';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  installJudgmentPort(previousPort);
  forgetProviderCacheReadings();
  if (originalToken === undefined) delete process.env['COPILOT_GITHUB_TOKEN'];
  else process.env['COPILOT_GITHUB_TOKEN'] = originalToken;
  rmSync(dir, { recursive: true, force: true });
});

/** A port answering one yes/no question with `probability`, recording every request. */
function yesNoPort(question: string, probability: number) {
  return decisionPort(['routing.copilot-claude-model', 'routing.cache-minimum'], (name) => {
    if (name !== question) throw new Error(`unexpected question ${name}`);
    return noulAnswer(probability);
  });
}

// ---------------------------------------------------------------------------
// Copilot transport
// ---------------------------------------------------------------------------

function copilotProvider(models: unknown[]) {
  const fetchFn = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('/v2/token')) {
      return new Response(JSON.stringify({ token: 'session-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    }
    if (href.endsWith('/models')) return new Response(JSON.stringify({ data: models }), { status: 200 });
    throw new Error(`unexpected fetch ${href}`);
  }) as typeof fetch;
  return new GitHubCopilotProvider({ tokenCachePath: join(dir, 'token.json'), fetchFn });
}

/** Sends one chat for `model` and returns the path the chat request went to. */
async function chatPath(provider: GitHubCopilotProvider, model: string): Promise<string> {
  let path = '';
  globalThis.fetch = (async (url: string | URL | Request) => {
    path = new URL(String(url)).pathname;
    return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 403 });
  }) as unknown as typeof fetch;
  await provider.chat({ model, messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
  return path;
}

describe('Copilot transport', () => {
  test('supported_endpoints decides, with no reading', async () => {
    const { port, requests } = yesNoPort('claude', 0.99);
    installJudgmentPort(port);
    const provider = copilotProvider([
      { id: 'claude-sonnet-5', vendor: 'Anthropic', supported_endpoints: ['/chat/completions', '/v1/messages'] },
      { id: 'gpt-5.6', vendor: 'OpenAI', supported_endpoints: ['/chat/completions', '/responses'] },
    ]);
    await provider.refreshModels(true);
    expect(await chatPath(provider, 'claude-sonnet-5')).toBe('/v1/messages');
    expect(await chatPath(provider, 'gpt-5.6')).toBe('/v1/chat/completions');
    expect(requests).toHaveLength(0);
  });

  test('vendor decides when the entry has no endpoint list, with no reading', async () => {
    const { port, requests } = yesNoPort('claude', 0.01);
    installJudgmentPort(port);
    const provider = copilotProvider([{ id: 'opus-next', vendor: 'Anthropic' }, { id: 'claude-lookalike', vendor: 'OpenAI' }]);
    await provider.refreshModels(true);
    expect(await chatPath(provider, 'opus-next')).toBe('/v1/messages');
    expect(await chatPath(provider, 'claude-lookalike')).toBe('/v1/chat/completions');
    expect(requests).toHaveLength(0);
  });

  test('an entry with neither field: a claude- id takes the Anthropic path, any other the OpenAI path, with no reading', async () => {
    const { port, requests } = yesNoPort('claude', 0.5);
    installJudgmentPort(port);
    const provider = copilotProvider([{ id: 'claude-sonnet-5' }, { id: 'gpt-4.1' }]);
    await provider.refreshModels(true);
    expect(await chatPath(provider, 'claude-sonnet-5')).toBe('/v1/messages');
    expect(await chatPath(provider, 'gpt-4.1')).toBe('/v1/chat/completions');
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gemini cache minimum
// ---------------------------------------------------------------------------

/** A system prompt long enough to pass the size estimate before cache creation. */
const LONG_PROMPT = 'x'.repeat(90_000);
const BELOW_MINIMUM = '{"error":{"code":400,"message":"Cached content is too small. total_token_count=30000, min_total_token_count=32768","status":"INVALID_ARGUMENT"}}';

type CacheEnsurer = { ensureCachedContent(systemPrompt: string, tools: undefined, model: string): Promise<string | null> };

/** Counts cache-creation POSTs; every one fails with `status` and `body`. */
function failCacheCreation(status: number, body: string): { posts: () => number } {
  let posts = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') posts++;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { posts: () => posts };
}

function gemini(): CacheEnsurer {
  return new GeminiProvider('key') as unknown as CacheEnsurer;
}

describe('Gemini context caches', () => {
  test('a 400 naming the minimum marks the input uncacheable, so it is not tried again', async () => {
    const cache = failCacheCreation(400, BELOW_MINIMUM);
    const provider = gemini();
    for (let i = 0; i < 4; i++) expect(await provider.ensureCachedContent(LONG_PROMPT, undefined, 'gemini-2.5-pro')).toBeNull();
    expect(cache.posts()).toBe(1);
  });

  test('two alternating inputs over ten requests create two resources, and dispose deletes both', async () => {
    let posts = 0;
    const deleted: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deleted.push(String(url)); return new Response('{}', { status: 200 }); }
      posts++;
      return new Response(JSON.stringify({ name: `cachedContents/c${posts}`, expireTime: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new GeminiProvider('key') as unknown as CacheEnsurer & { dispose(): Promise<void> };
    for (let i = 0; i < 10; i++) {
      await provider.ensureCachedContent(i % 2 === 0 ? LONG_PROMPT : `${LONG_PROMPT}y`, undefined, 'gemini-2.5-pro');
    }
    expect(posts).toBe(2);
    await provider.dispose();
    expect(deleted.map((url) => url.slice(url.lastIndexOf('/') + 1)).sort()).toEqual(['c1', 'c2']);
  });
});
