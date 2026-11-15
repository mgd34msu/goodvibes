/**
 * The production knowledge route context hands the caller's captured read
 * scope to the service for every scoped read, and the ingest functions refuse
 * the caller's own bad input with a 400-carrying error.
 */
import { describe, expect, test } from 'bun:test';
import { buildKnowledgeRouteContext } from '../platform/src/platform/daemon/http/router-route-contexts.js';
import { ingestKnowledgeArtifact, ingestKnowledgeConnectorInput } from '../platform/src/platform/knowledge/ingest-inputs.js';
import { serviceFailureStatus } from '../daemon-api/src/error-response.js';

type Seen = { readonly method: string; readonly options: unknown };

describe('knowledge route context forwards the captured scope options', () => {
  test('search, ask and projection render receive the options the route passed', async () => {
    const seen: Seen[] = [];
    const record = (method: string) => async (_input: unknown, options?: unknown) => { seen.push({ method, options }); return []; };
    const context = buildKnowledgeRouteContext({
      knowledgeService: {
        searchScoped: record('searchScoped'),
        ask: record('ask'),
        renderProjection: record('renderProjection'),
      },
    } as never);
    const options = { signal: new AbortController().signal, assertCurrent: () => undefined };
    await context.knowledgeService.searchScoped({ query: 'q' }, options);
    await context.knowledgeService.ask({ query: 'q' }, options);
    await context.knowledgeService.renderProjection({ kind: 'bundle' } as never, options);
    expect(seen).toEqual([
      { method: 'searchScoped', options },
      { method: 'ask', options },
      { method: 'renderProjection', options },
    ]);
  });
});

describe('knowledge ingest refusing the caller\'s own input', () => {
  async function statusOf(run: () => Promise<unknown>): Promise<number> {
    try { await run(); } catch (error) { return serviceFailureStatus(error); }
    throw new Error('expected a refusal');
  }

  test('a connector ingest with no connector id or no input is a 400', async () => {
    expect(await statusOf(() => ingestKnowledgeConnectorInput({} as never, { connectorId: '  ' }))).toBe(400);
    expect(await statusOf(() => ingestKnowledgeConnectorInput({} as never, { connectorId: 'c' }))).toBe(400);
  });

  test('an artifact ingest naming nothing, or an artifact that does not exist, is a 400', async () => {
    const context = { store: { init: async () => undefined }, artifactStore: { getRecord: () => null } } as never;
    expect(await statusOf(() => ingestKnowledgeArtifact(context, {}))).toBe(400);
    expect(await statusOf(() => ingestKnowledgeArtifact(context, { artifactId: 'ghost' }))).toBe(400);
  });
});
