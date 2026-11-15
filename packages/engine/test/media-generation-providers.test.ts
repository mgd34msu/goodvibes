import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { builtinGenerationProviders, pollTask } from '../platform/src/platform/media/builtin-generation-providers.ts';
import type { MediaGenerationProvider } from '../platform/src/platform/media/provider-registry.ts';

const KEYS = ['FAL_KEY', 'FAL_API_KEY', 'RUNWAYML_API_SECRET', 'RUNWAY_API_KEY'];
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
beforeEach(() => { for (const key of KEYS) { saved.set(key, process.env[key]); delete process.env[key]; } });
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of KEYS) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

function provider(id: string): MediaGenerationProvider {
  const found = builtinGenerationProviders().find((entry) => entry.id === id);
  if (!found?.generate) throw new Error(`${id} generation provider unavailable`);
  return found;
}

interface Call { readonly url: string; readonly method: string; readonly body?: string | undefined }
function stubFetch(answer: (url: string, method: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    return answer(url, method);
  }) as typeof globalThis.fetch;
  return calls;
}

const falSubmitted = { request_id: 'req-1', status_url: 'https://queue.fal.run/status/req-1', response_url: 'https://queue.fal.run/result/req-1' };

describe('media generation providers', () => {
  test('cancellation interrupts a provider polling delay before the next request', async () => {
    process.env.FAL_KEY = 'synthetic-key';
    const controller = new AbortController();
    const calls = stubFetch((url) => {
      if (url.includes('/status/')) {
        setImmediate(() => controller.abort());
        return Response.json({ status: 'IN_PROGRESS' });
      }
      return Response.json(falSubmitted);
    });
    await expect(provider('fal').generate!({ prompt: 'synthetic fixture', options: { image: true }, metadata: {} }, { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  test('a poll that fails once with a transient status does not lose the paid job', async () => {
    let polls = 0;
    const waited = await pollTask(async () => {
      polls += 1;
      if (polls === 1) throw Object.assign(new Error('synthetic unavailable'), { status: 503 });
      return { state: 'done' as const, value: 'output' };
    }, { deadline: Date.now() + 60_000, intervalMs: 5_000, sleep: async () => {} });
    expect(waited).toEqual({ done: true, value: 'output' });
    expect(polls).toBe(2);
  });

  test('a job still running when the wait ends is returned pending and collected later by its task id', async () => {
    process.env.FAL_KEY = 'synthetic-key';
    const submitCalls = stubFetch(() => Response.json(falSubmitted));
    const fal = provider('fal');
    const first = await fal.generate!({ prompt: 'synthetic fixture', outputMimeType: 'image/png', options: { waitSeconds: 0 }, metadata: {} });
    expect(first.artifacts).toEqual([]);
    expect(first.pending).toMatchObject({ providerId: 'fal', taskId: 'req-1' });
    expect(submitCalls.map((call) => call.method)).toEqual(['POST']);

    stubFetch((url) => url.includes('/status/')
      ? Response.json({ status: 'COMPLETED' })
      : Response.json({ image: { url: 'https://cdn.example/generated.png' } }));
    const collected = await fal.collect!(first.pending!);
    expect(collected.pending).toBeUndefined();
    expect(collected.artifacts.map((artifact) => artifact.uri)).toEqual(['https://cdn.example/generated.png']);
  });

  test('a collect request never sends the key to a queue address outside the vendor queue host', async () => {
    process.env.FAL_KEY = 'synthetic-key';
    const calls = stubFetch(() => Response.json({ status: 'COMPLETED' }));
    await expect(provider('fal').collect!({
      providerId: 'fal',
      taskId: 'req-1',
      resume: { statusUrl: 'https://evil.example/status', responseUrl: 'https://evil.example/result', output: 'image' },
    })).rejects.toThrow('outside');
    expect(calls).toHaveLength(0);
  });

  test('a video-only provider refuses an image request before anything is sent', async () => {
    process.env.RUNWAYML_API_SECRET = 'synthetic-key';
    const calls = stubFetch(() => Response.json({ id: 'task-1' }));
    await expect(provider('runway').generate!({ prompt: 'a cat', outputMimeType: 'image/png', metadata: {} }))
      .rejects.toMatchObject({ code: 'MEDIA_OUTPUT_UNSUPPORTED' });
    expect(calls).toHaveLength(0);
  });

  test('fal uses the model asked for an image, and Runway uses an image given by URL', async () => {
    process.env.FAL_KEY = 'synthetic-key';
    process.env.RUNWAYML_API_SECRET = 'synthetic-key';
    const calls = stubFetch((url) => url.includes('runwayml') ? Response.json({ id: 'task-1' }) : Response.json(falSubmitted));
    await provider('fal').generate!({ prompt: 'a cat', outputMimeType: 'image/png', modelId: 'fal-ai/recraft-v3', options: { waitSeconds: 0 }, metadata: {} });
    await provider('runway').generate!({ prompt: 'a cat', options: { imageUrl: 'https://cdn.example/cat.png', waitSeconds: 0 }, metadata: {} });
    expect(calls[0]!.url).toBe('https://queue.fal.run/fal-ai/recraft-v3');
    expect(calls[1]!.url).toBe('https://api.dev.runwayml.com/v1/image_to_video');
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ promptImage: 'https://cdn.example/cat.png' });
  });
});
