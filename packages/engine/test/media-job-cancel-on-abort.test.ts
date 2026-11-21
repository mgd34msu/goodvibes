// Proves: Stopping the collect of a paid media job cancels that job at the provider, so the owner pays for output he never receives.
// Red when: An aborted collect is handled like an aborted generate (`finish` given the remote cancel from `collect`), so a cancel request for the job reaches the provider.
/**
 * A generation job is paid for once the provider accepts it. Aborting the
 * generate request that submitted it cancels it there; aborting a later collect
 * of the same job only stops waiting, and the job keeps running for a later
 * collect. The real fal provider; the fal queue is a stand-in at the HTTP wire
 * that records every request and aborts the caller when the status is asked.
 */
import { afterEach, expect, test } from 'bun:test';
import { builtinGenerationProviders } from '../platform/src/platform/media/builtin-generation-providers.ts';

const QUEUE = 'https://queue.fal.run/fal-ai/flux';
const originalFetch = globalThis.fetch;
const originalKey = process.env['FAL_KEY'];
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env['FAL_KEY'];
  else process.env['FAL_KEY'] = originalKey;
});

test('an aborted collect leaves the paid job running; an aborted generate cancels it', async () => {
  process.env['FAL_KEY'] = 'fixture-fal-key';
  const fal = builtinGenerationProviders().find((provider) => provider.id === 'fal')!;
  let stop: AbortController = new AbortController();
  const arrived: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    arrived.push(`${method} ${url}`);
    if (method === 'POST') {
      return Response.json({ request_id: 'job-1', status_url: `${QUEUE}/requests/job-1/status`, response_url: `${QUEUE}/requests/job-1`, cancel_url: `${QUEUE}/requests/job-1/cancel` });
    }
    // The caller stops while the job is still running at the provider.
    if (url.endsWith('/status')) stop.abort();
    return Response.json({ status: 'IN_PROGRESS' });
  }) as typeof fetch;
  const cancels = () => arrived.filter((line) => line.startsWith('PUT ') && line.endsWith('/job-1/cancel'));

  const task = { providerId: 'fal', taskId: 'job-1', resume: { model: 'fal-ai/flux', statusUrl: `${QUEUE}/requests/job-1/status`, responseUrl: `${QUEUE}/requests/job-1`, cancelUrl: `${QUEUE}/requests/job-1/cancel`, output: 'image' } };
  const collected = await fal.collect!(task, {}, { signal: stop.signal }).then(() => null, (error: unknown) => error);
  expect({ aborted: collected instanceof Error, statusAsked: arrived.some((line) => line.endsWith('/status')), cancels: cancels() }).toEqual({ aborted: true, statusAsked: true, cancels: [] });

  // Control: the generate request that submitted the job, aborted the same way, cancels it.
  stop = new AbortController();
  arrived.length = 0;
  const generated = await fal.generate!({ prompt: 'a lighthouse', options: {} }, { signal: stop.signal }).then(() => null, (error: unknown) => error);
  expect({ aborted: generated instanceof Error, cancels: cancels() }).toEqual({ aborted: true, cancels: [`PUT ${QUEUE}/requests/job-1/cancel`] });
});
