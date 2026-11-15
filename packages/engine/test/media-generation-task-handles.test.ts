import { afterEach, beforeEach, expect, test } from 'bun:test';
import { builtinGenerationProviders } from '../platform/src/platform/media/builtin-generation-providers.ts';
import type { MediaProvider } from '../platform/src/platform/media/provider-registry.ts';

const KEYS = ['FAL_KEY', 'FAL_API_KEY', 'COMFY_BASE_URL', 'COMFY_API_KEY', 'COMFY_WORKFLOW_DIR'];
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
beforeEach(() => { for (const key of KEYS) { saved.set(key, process.env[key]); delete process.env[key]; } });
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of KEYS) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

function provider(id: string): MediaProvider {
  const found = builtinGenerationProviders().find((entry) => entry.id === id);
  if (!found?.generate) throw new Error(`${id} generation provider unavailable`);
  return found;
}
interface Call { readonly url: string; readonly method: string }
function stubFetch(answer: (url: string, method: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    return answer(url, method);
  }) as typeof globalThis.fetch;
  return calls;
}
const submitted = { request_id: 'req-7', status_url: 'https://queue.fal.run/status/req-7', response_url: 'https://queue.fal.run/result/req-7', cancel_url: 'https://queue.fal.run/cancel/req-7' };
const request = { prompt: 'synthetic fixture', options: { image: true }, metadata: {} };

test('an aborted generation names its remote task and cancels it', async () => {
  process.env['FAL_KEY'] = 'synthetic-key';
  const controller = new AbortController();
  const calls = stubFetch((url, method) => {
    if (method === 'PUT') return Response.json({});
    if (url.includes('/status/')) { setImmediate(() => controller.abort()); return Response.json({ status: 'IN_PROGRESS' }); }
    return Response.json(submitted);
  });
  const error = await provider('fal').generate!(request, { signal: controller.signal }).catch((failure: unknown) => failure) as Error;
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('fal task req-7 was cancelled');
  expect((error as unknown as { providerTask: unknown }).providerTask).toEqual({ providerId: 'fal', taskId: 'req-7' });
  expect(calls.filter((call) => call.method === 'PUT').map((call) => call.url)).toEqual([submitted.cancel_url]);
});

test('a job the provider reported as failed is not described as still running', async () => {
  process.env['FAL_KEY'] = 'synthetic-key';
  const calls = stubFetch((url) => url.includes('/status/') ? Response.json({ status: 'FAILED', detail: 'bad prompt' }) : Response.json(submitted));
  const error = await provider('fal').generate!(request).catch((failure: unknown) => failure) as Error;
  expect(error.message).toBe('bad prompt');
  expect((error as unknown as { providerTask: { taskId: string } }).providerTask.taskId).toBe('req-7');
  expect(calls.some((call) => call.method === 'PUT')).toBe(false);
});

test('the provider key is never sent to a host outside the vendor domain', async () => {
  process.env['FAL_KEY'] = 'synthetic-key';
  const calls = stubFetch(() => Response.json(submitted));
  await expect(provider('fal').generate!({ ...request, options: { image: true, baseUrl: 'https://evil.example' } })).rejects.toThrow('options.baseUrl');
  expect(calls).toHaveLength(0);
});

test('queue URLs returned by the provider must stay on the queue host', async () => {
  process.env['FAL_KEY'] = 'synthetic-key';
  const calls = stubFetch(() => Response.json({ ...submitted, status_url: 'https://evil.example/status' }));
  await expect(provider('fal').generate!(request)).rejects.toThrow('outside');
  expect(calls).toHaveLength(1);
});

test('the Comfy key is never sent to a host other than the configured server or Comfy Cloud', async () => {
  process.env['COMFY_API_KEY'] = 'synthetic-key';
  process.env['COMFY_BASE_URL'] = 'http://127.0.0.1:8188';
  const calls = stubFetch(() => Response.json({}));
  const workflow = { '1': { inputs: {} } };
  for (const baseUrl of ['http://evil.example', 'http://evil.example/cloud.comfy.org', 'https://cloud.comfy.org.evil.example', 'http://cloud.comfy.org']) {
    await expect(provider('comfy').generate!({ prompt: 'x', options: { workflow, baseUrl }, metadata: {} })).rejects.toThrow('options.baseUrl');
  }
  expect(calls).toHaveLength(0);
});

test('a Comfy workflow file outside the working directory is not read or posted', async () => {
  process.env['COMFY_BASE_URL'] = 'http://127.0.0.1:8188';
  const calls = stubFetch(() => Response.json({}));
  await expect(provider('comfy').generate!({ prompt: 'x', options: { workflowPath: '/etc/hostname' }, metadata: {} })).rejects.toThrow('workflowPath');
  expect(calls).toHaveLength(0);
});

test('a Comfy job that failed is reported as failed on the first poll instead of timing out', async () => {
  process.env['COMFY_BASE_URL'] = 'http://127.0.0.1:8188';
  stubFetch((url) => url.includes('/history/')
    ? Response.json({ 'prompt-1': { status: { status_str: 'error' }, outputs: {} } })
    : Response.json({ prompt_id: 'prompt-1' }));
  const error = await provider('comfy').generate!({ prompt: 'x', options: { workflow: { '1': { inputs: {} } } }, metadata: {} }).catch((failure: unknown) => failure) as Error;
  expect(error.message).toBe('Comfy generation failed');
  expect((error as unknown as { providerTask: { taskId: string } }).providerTask.taskId).toBe('prompt-1');
});
