import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ContractError, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { createOperatorRemoteClient, type OperatorRemoteClientOptions } from '../operator-client/src/client-core.ts';
import { createHttpTransport } from '../transport-http/src/http.ts';
import { firstJsonSchemaFailureAsync } from '../transport-http/src/client-plumbing.ts';
import { retainJsonSchemaSource } from '../transport-http/src/retained-schema-source.ts';
import { buildOperatorContract } from '../platform/src/platform/control-plane/operator-contract.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function clientFor(schema: Record<string, unknown>, response: () => Promise<unknown>) {
  const native = buildOperatorContract(new GatewayMethodCatalog());
  const original = native.operator.methods.find(method => method.id === 'sessions.create');
  if (!original) throw new Error('Native sessions.create contract missing.');
  const method = { ...original, outputSchema: schema };
  const methods = native.operator.methods.map(item => item === original ? method : item);
  const contract = { ...native, operator: { ...native.operator, methods } };
  const options: OperatorRemoteClientOptions = {};
  let requests = 0;
  const fetch = Object.assign(async () => {
    requests++;
    return new Response(JSON.stringify(await response()), { headers: { 'Content-Type': 'application/json' } });
  }, { preconnect: () => {} });
  const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:3210', fetch });
  return { client: createOperatorRemoteClient(transport, contract, options), method, methods, options, requests: () => requests };
}

function recursiveSchema() {
  const scalar = { type: 'string', pattern: '^native$' };
  const schema: Record<string, unknown> = { type: 'object', properties: { first: scalar, second: scalar }, additionalProperties: false };
  schema.$defs = { self: schema };
  return { schema, scalar, properties: schema.properties as Record<string, unknown> };
}

describe('native recursive response schema source lifetime', () => {
  test('detached capture preserves cycles, aliases and hidden native slots', () => {
    const { schema, scalar } = recursiveSchema();
    Object.defineProperty(schema, 'hidden', { value: scalar, writable: true, configurable: true });
    const retained = retainJsonSchemaSource(schema);
    expect(retained.snapshot).not.toBe(schema);
    const properties = retained.snapshot.properties as Record<string, unknown>;
    expect(properties.first).toBe(properties.second);
    expect(properties.first).not.toBe(scalar);
    expect(retained.snapshot.hidden).toBe(properties.first);
    expect((retained.snapshot.$defs as Record<string, unknown>).self).toBe(retained.snapshot);
    retained.assertCurrent();
    Object.defineProperty(schema, 'hidden', { value: { ...scalar } });
    expect(retained.assertCurrent).toThrow(ContractError);
  });

  test('large shared graphs retain hidden nodes and still detect mutation', () => {
    const shared = { type: 'string' };
    const source = { rows: Array.from({ length: 6_000 }, (_, index) => ({ index, shared })) };
    const hidden = { value: 'original' };
    Object.defineProperty(source.rows[5_999]!, 'hidden', { value: hidden });
    const retained = retainJsonSchemaSource(source);
    expect(retained.snapshot.rows).toHaveLength(6_000);
    expect(retained.snapshot.rows[0]!.shared).toBe(retained.snapshot.rows[5_999]!.shared);
    expect(retained.snapshot.rows[0]!.shared).not.toBe(shared);
    retained.assertCurrent();
    hidden.value = 'changed';
    expect(retained.assertCurrent).toThrow(ContractError);
  });

  test('pending cancellation refuses the returned value without a reading', async () => {
    const { schema } = recursiveSchema();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const peer = clientFor(schema, async () => { entered.resolve(); await release.promise; return { first: 'native' }; });
    const pending = peer.client.sessions.create({ title: 'native' }, { signal: controller.signal });
    await entered.promise;
    controller.abort(); release.resolve();
    await expect(pending).rejects.toThrow();
    expect(peer.requests()).toBe(1);
  });

  test('unchanged recursive aliases validate through the isolated pattern worker', async () => {
    const { schema } = recursiveSchema();
    const readings = fakePort(() => { throw new Error('Worker validation needs no probability reading.'); });
    installJudgmentPort(readings.port);
    expect(await firstJsonSchemaFailureAsync(schema, { first: 'native', second: 'native' })).toBeUndefined();
    expect(readings.requests).toHaveLength(0);
  });

  test('a native recursive schema still refuses an invalid nested response', async () => {
    const native = buildOperatorContract(new GatewayMethodCatalog());
    const method = native.operator.methods.find(item => item.id === 'sessions.create');
    if (!method?.outputSchema) throw new Error('Native session response schema missing.');
    const invalid = {
      session: { id: 'native', kind: 'tui', title: 'native', status: 'active', createdAt: 1,
        updatedAt: 1, lastActivityAt: 1, messageCount: 0, pendingInputCount: 0,
        routeIds: [], surfaceKinds: [], participants: 7, metadata: { recursive: [{ child: true }] } },
    };
    const peer = clientFor(method.outputSchema, async () => invalid);
    await expect(peer.client.sessions.create({ title: 'native' })).rejects.toThrow('$.session.participants');
    expect(peer.requests()).toBe(1);
  });
});
