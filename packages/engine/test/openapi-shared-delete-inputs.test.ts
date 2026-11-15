import { expect, test } from 'bun:test';
import type { OperatorMethodContract } from '../contracts/src/types.ts';
import { buildParameters, hasDeleteBody } from '../scripts/openapi-shared.ts';

function method(verb: 'GET' | 'DELETE', path: string, properties: Record<string, unknown>): OperatorMethodContract {
  return {
    id: 'x.y', http: { method: verb, path },
    inputSchema: { type: 'object', properties, required: [] },
  } as unknown as OperatorMethodContract;
}

test('a DELETE publishes its confirm input as a body, not a query parameter the gateway would ignore', () => {
  const del = method('DELETE', '/api/channels/routing/{id}', { id: { type: 'string' }, confirm: { type: 'boolean' } });
  expect(buildParameters(del).map((p) => p['name'])).toEqual(['id']);
  expect(hasDeleteBody(del)).toBe(true);
});

test('a DELETE whose only input is in its path has no body, and a GET keeps its query parameters', () => {
  expect(hasDeleteBody(method('DELETE', '/api/x/{id}', { id: { type: 'string' } }))).toBe(false);
  const get = method('GET', '/api/x', { status: { type: 'string' } });
  expect(buildParameters(get).map((p) => [p['name'], p['in']])).toEqual([['status', 'query']]);
});
