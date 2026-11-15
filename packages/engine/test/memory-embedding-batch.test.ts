/** One provider request per batch, and a rate limit waited out instead of failing the build. */
import { expect, test } from 'bun:test';
import { createBuiltinMemoryEmbeddingProviders } from '../platform/src/platform/state/memory-embedding-http.ts';
import type { BatchMemoryEmbeddingProvider } from '../platform/src/platform/state/memory-embeddings.ts';

const DIMS = 384;
const vector = (): number[] => Array.from({ length: DIMS }, () => 0.1);

function openai(fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): BatchMemoryEmbeddingProvider {
  const provider = createBuiltinMemoryEmbeddingProviders({ env: { OPENAI_API_KEY: 'test-key' }, fetchImpl })
    .find((candidate) => candidate.id === 'openai');
  return provider as BatchMemoryEmbeddingProvider;
}

test('three texts are one request, and the vectors come back in input order', async () => {
  const bodies: unknown[] = [];
  const provider = openai(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ data: [2, 0, 1].map((index) => ({ index, embedding: vector().map((v) => v * (index + 1)) })) });
  });
  const results = await provider.embedMany({ texts: ['a', 'b', 'c'], dimensions: DIMS, usage: 'record' });
  expect(bodies).toHaveLength(1);
  expect((bodies[0] as { input: string[] }).input).toEqual(['a', 'b', 'c']);
  expect(results.map((result) => Number(result.vector[0]!.toFixed(2)))).toEqual([0.1, 0.2, 0.3]);
});

test('a 429 with Retry-After is waited out and the request sent again', async () => {
  let calls = 0;
  const provider = openai(async () => {
    calls += 1;
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ data: [{ index: 0, embedding: vector() }] });
  });
  const results = await provider.embedMany({ texts: ['a'], dimensions: DIMS, usage: 'record' });
  expect(calls).toBe(2);
  expect(results).toHaveLength(1);
});
