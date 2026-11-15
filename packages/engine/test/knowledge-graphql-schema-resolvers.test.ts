/**
 * graphql-js answers a declared field that has no resolver with a null-field
 * error that names nothing about the cause, so every field the schema declares
 * must have an implementation behind it.
 */
import { describe, expect, test } from 'bun:test';
import { buildSchema } from 'graphql';
import { getKnowledgeGraphqlSchemaText, KnowledgeGraphqlService } from '../platform/src/platform/knowledge/graphql.js';
import type { KnowledgeService } from '../platform/src/platform/knowledge/service.js';

interface Call { readonly method: string; readonly args: readonly unknown[] }

function stubService(calls: Call[]): KnowledgeService {
  const batch = { imported: 1, failed: 0, sources: [], errors: [] };
  const record = (method: string, value: unknown) => (...args: unknown[]) => { calls.push({ method, args }); return Promise.resolve(value); };
  return {
    importBookmarksFromFile: record('importBookmarksFromFile', batch),
    importUrlsFromFile: record('importUrlsFromFile', batch),
    ingestBookmarkSeeds: record('ingestBookmarkSeeds', batch),
    ingestWithConnector: record('ingestWithConnector', batch),
    ingestConnectorInput: record('ingestConnectorInput', batch),
    decideConsolidationCandidate: record('decideConsolidationCandidate', { id: 'candidate-1' }),
    listUsageRecords: (...args: unknown[]) => { calls.push({ method: 'listUsageRecords', args }); return [{ id: 'usage-1' }]; },
  } as unknown as KnowledgeService;
}

describe('knowledge GraphQL schema and resolvers', () => {
  test('every declared query and mutation field has a resolver', () => {
    const service = new KnowledgeGraphqlService(stubService([]));
    const root = (service as unknown as { createRootValue(options: object): Record<string, unknown> }).createRootValue({});
    const schema = buildSchema(getKnowledgeGraphqlSchemaText());
    const missing = [schema.getQueryType(), schema.getMutationType()]
      .flatMap((type) => Object.keys(type?.getFields() ?? {}).map((field) => `${type?.name}.${field}`)
        .filter((qualified) => typeof root[qualified.split('.')[1]!] !== 'function'));
    expect(missing).toEqual([]);
  });

  test('the file, seed, connector, candidate and usage fields run and reach the service with their arguments', async () => {
    const calls: Call[] = [];
    const service = new KnowledgeGraphqlService(stubService(calls));
    const run = (query: string) => service.execute({ query, admin: true, scopes: ['read:knowledge', 'write:knowledge'] });
    const result = await run(`mutation {
      a: importBookmarksFromFile(path: "/tmp/b.html") { imported }
      b: importUrlsFromFile(path: "/tmp/u.txt") { imported }
      c: ingestBookmarkSeeds(seeds: ["https://example.com/a"], sessionId: "s") { imported }
      d: ingestWithConnector(connectorId: "url", input: "https://example.com") { imported }
      e: ingestConnectorInput(connectorId: "url", input: "https://example.com") { imported }
      f: decideConsolidationCandidate(id: "candidate-1", status: "accepted", decidedBy: "me", memoryClass: "fact") { id }
    }`);
    expect(result.errors).toBeUndefined();
    const decision = calls.find((call) => call.method === 'decideConsolidationCandidate');
    expect(decision?.args[0]).toBe('candidate-1');
    expect(decision?.args[1]).toBe('accept');
    expect(decision?.args[2]).toMatchObject({ decidedBy: 'me', memoryClass: 'fact' });
    expect(calls.find((call) => call.method === 'ingestBookmarkSeeds')?.args[0]).toEqual([{ url: 'https://example.com/a' }]);
    const usage = await run('{ usageRecords { id } }');
    expect(usage.errors).toBeUndefined();
    expect(usage.data).toEqual({ usageRecords: [{ id: 'usage-1' }] });
  });

  test('an unknown candidate status is refused with the allowed values', async () => {
    const calls: Call[] = [];
    const service = new KnowledgeGraphqlService(stubService(calls));
    const result = await service.execute({ query: 'mutation { decideConsolidationCandidate(id: "x", status: "maybe") { id } }', admin: true, scopes: ['write:knowledge'] });
    expect(result.errors?.[0]?.message).toContain('accepted, rejected or superseded');
    expect(calls).toEqual([]);
  });
});
