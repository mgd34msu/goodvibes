/**
 * The Gemini context cache is an optimisation: an unsettled reading of its
 * rejection never fails the chat, and parallel requests with the same large
 * prompt share one cache-creation request.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { GeminiProvider } from '../platform/src/platform/providers/gemini.js';
import { forgetProviderCacheReadings } from '../platform/src/platform/routing/provider-cache-readings.js';
import { decisionPort } from './helpers/decision-port.ts';

const originalFetch = globalThis.fetch;
let previousPort: ReturnType<typeof installJudgmentPort>;
const LONG_PROMPT = 'x'.repeat(90_000);
const REJECTION = '{"error":{"code":400,"message":"Cached content is too small","status":"INVALID_ARGUMENT"}}';

beforeEach(() => {
  previousPort = installJudgmentPort(undefined);
  forgetProviderCacheReadings();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  installJudgmentPort(previousPort);
  forgetProviderCacheReadings();
});

describe('Gemini optional context cache', () => {
  test('a 400 cache rejection with an uncertain reading still lets the chat succeed, uncached', async () => {
    installJudgmentPort(decisionPort(['routing.cache-minimum'], () => noulAnswer(0.55)).port);
    const generateBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/cachedContents')) return new Response(REJECTION, { status: 400 });
      generateBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
      return new Response(`data: ${chunk}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const response = await new GeminiProvider('key').chat({
      model: 'gemini-2.5-pro',
      systemPrompt: LONG_PROMPT,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.content).toBe('done');
    expect(generateBodies).toHaveLength(1);
    expect(generateBodies[0]!['cachedContent']).toBeUndefined();
    expect(generateBodies[0]!['systemInstruction']).toBeDefined();
  });

  test('parallel requests with the same large prompt create one cache resource', async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') posts++;
      await gate;
      return new Response(JSON.stringify({ name: 'cachedContents/one', expireTime: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new GeminiProvider('key') as unknown as {
      ensureCachedContent(systemPrompt: string, tools: undefined, model: string): Promise<string | null>;
    };
    const first = provider.ensureCachedContent(LONG_PROMPT, undefined, 'gemini-2.5-pro');
    const second = provider.ensureCachedContent(LONG_PROMPT, undefined, 'gemini-2.5-pro');
    release();
    expect(await first).toBe('cachedContents/one');
    expect(await second).toBe('cachedContents/one');
    expect(posts).toBe(1);
  });
});

describe('Gemini stream retry', () => {
  test('a dropped stream after streamed text is final instead of repeating the answer', async () => {
    let generateCalls = 0;
    globalThis.fetch = (async () => {
      generateCalls++;
      const chunk = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial ' }] } }] });
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        // An error raised in start() would discard the queued chunk; pull() lets the reader see it first.
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`));
            return;
          }
          controller.error(Object.assign(new Error('connection dropped'), { statusCode: 502 }));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const deltas: string[] = [];
    await expect(new GeminiProvider('key', undefined, undefined, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 }).chat({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (delta) => { if (delta.content) deltas.push(delta.content); },
    })).rejects.toThrow();
    expect(generateCalls).toBe(1);
    expect(deltas).toEqual(['partial ']);
  });
});
