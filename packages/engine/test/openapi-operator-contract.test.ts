/**
 * openapi-operator-contract.test.ts
 *
 * Proves the published OpenAPI 3.1 operator contract is complete and honest:
 *
 *   - every cataloged operator method appears (REST-bound methods as path
 *     operations, invoke-only methods listed on the generic invoke endpoint,
 *     and ALL methods in the x-operator-methods index);
 *   - replay keys declared on the methods are named, header and body alike;
 *   - auth schemes mirror the contract's auth block.
 *
 * Version-decoupled: assertions compare committed artifacts to each other
 * (operator-openapi.json vs operator-contract.json), never to the live build
 * VERSION.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const openapiText = readFileSync(join(ROOT, 'contracts/artifacts/operator-openapi.json'), 'utf8');

interface MethodIndexEntry {
  id: string;
  rest: string | null;
  inputSchemaCoverage: string;
  outputSchemaCoverage: string;
}

const doc = JSON.parse(openapiText) as {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, { operationId?: string; 'x-invoke-only-methods'?: string[] }>>;
  components: { securitySchemes: Record<string, { type: string; name?: string }> };
  'x-operator-methods': MethodIndexEntry[];
};

const contract = JSON.parse(
  readFileSync(join(ROOT, 'contracts/artifacts/operator-contract.json'), 'utf8'),
) as {
  product: { version: string };
  auth: { sessionCookie: { name: string } };
  operator: { methods: { id: string; http?: { method: string; path: string } }[] };
};

describe('published OpenAPI operator contract', () => {
  test('is OpenAPI 3.1 and carries the contract product version', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(contract.product.version);
  });

  test('every cataloged method appears in the index; REST-bound ones as operations', () => {
    const methods = contract.operator.methods;
    expect(doc['x-operator-methods'].length).toBe(methods.length);
    const indexIds = new Set(doc['x-operator-methods'].map((m) => m.id));
    for (const m of methods) expect(indexIds.has(m.id)).toBe(true);

    const operationIds = new Set<string>();
    for (const pathItem of Object.values(doc.paths)) {
      for (const op of Object.values(pathItem)) {
        if (op.operationId) operationIds.add(op.operationId);
      }
    }
    for (const m of methods.filter((x) => x.http)) {
      expect(operationIds.has(m.id)).toBe(true);
    }
  });

  test('invoke-only methods are listed on the generic invoke endpoint, not dropped', () => {
    const invokeOp = doc.paths['/api/control/gateway-methods/{methodId}/invoke']?.post;
    expect(invokeOp).toBeDefined();
    const listed = new Set(invokeOp!['x-invoke-only-methods'] ?? []);
    const invokeOnly = contract.operator.methods.filter((m) => !m.http);
    expect(listed.size).toBe(invokeOnly.length);
    for (const m of invokeOnly) expect(listed.has(m.id)).toBe(true);
  });

  test('auth schemes mirror the contract auth block', () => {
    expect(doc.components.securitySchemes.bearerAuth?.type).toBe('http');
    expect(doc.components.securitySchemes.sessionCookie?.name).toBe(contract.auth.sessionCookie.name);
  });

  test('streams are typed as text/event-stream and replay keys are named', () => {
    const stream = doc.paths['/api/control-plane/events']?.get as unknown as { responses: Record<string, { content?: Record<string, unknown> }> };
    expect(Object.keys(stream.responses['200']!.content!)).toEqual(['text/event-stream']);
    const register = doc.paths['/api/sessions/register']?.post as unknown as { 'x-replay-key'?: { in: string; name: string } };
    expect(register['x-replay-key']).toMatchObject({ in: 'body', name: 'sessionId' });
    const submit = doc.paths['/api/work-ledger/submissions']?.post as unknown as { 'x-replay-key'?: { name: string }; description: string };
    expect(submit['x-replay-key']?.name).toBe('requestId');
    const start = doc.paths['/api/contracts']?.post as unknown as { 'x-replay-key'?: { in: string; name: string } };
    expect(start['x-replay-key']).toMatchObject({ in: 'header', name: 'Idempotency-Key' });
  });
});
