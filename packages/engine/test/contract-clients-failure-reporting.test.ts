import { describe, expect, test } from 'bun:test';
import { createOperatorApiClient } from '../operator-client/src/client.js';
import { createOperatorContractWorkAdapter } from '../operator-client/src/contract-work-adapter.js';
import { createPeerApiClient } from '../peer-client/src/client.js';
import { ContractError } from '../errors/src/index.js';

function jsonFetch(body: unknown): typeof fetch {
  const impl = async (): Promise<Response> => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

const BASE = { baseUrl: 'http://127.0.0.1:3210', authToken: 'tok' };

describe('operator client failures reach the returned promise', () => {
  test('an unknown method id rejects instead of throwing', async () => {
    const client = createOperatorApiClient({ ...BASE, fetch: jsonFetch({}) });
    let thrown: unknown;
    let pending: Promise<unknown> | undefined;
    try {
      pending = client.invoke('no.such.method' as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  test('an unknown stream method id rejects instead of throwing', async () => {
    const client = createOperatorApiClient({ ...BASE, fetch: jsonFetch({}) });
    let thrown: unknown;
    let pending: Promise<unknown> | undefined;
    try {
      pending = client.stream('no.such.stream' as never, { handlers: {} } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });
});

describe('response-shape failures say whether the request was applied', () => {
  test('a mutation whose response does not match tells the caller it was applied', async () => {
    const client = createOperatorApiClient({ ...BASE, fetch: jsonFetch({ unexpected: true }) });
    const error = await client.sessions.create({} as never).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).message).toContain('this request was applied');
    expect((error as ContractError).hint).toContain('Do not repeat the request');
  });

  test('a read whose response does not match does not claim anything was applied', async () => {
    const client = createOperatorApiClient({ ...BASE, fetch: jsonFetch({ unexpected: true }) });
    const error = await client.sessions.list().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).message).not.toContain('was applied');
  });

  test('the peer client says the same for a mutation', async () => {
    const client = createPeerApiClient({ ...BASE, fetch: jsonFetch({ unexpected: true }) });
    const error = await client.work.complete('work-1', { status: 'completed' } as never).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).message).toContain('this request was applied');
  });

  test('the peer client rejects an unknown endpoint id instead of throwing', async () => {
    const client = createPeerApiClient({ ...BASE, fetch: jsonFetch({}) });
    let thrown: unknown;
    let pending: Promise<unknown> | undefined;
    try {
      pending = client.invoke('no.such.endpoint' as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });
});

describe('contract work adapter dispatch', () => {
  test('a dispatch idempotency key is sent as the Idempotency-Key header', async () => {
    const calls: { methodId: string; input: unknown; options: unknown }[] = [];
    const adapter = createOperatorContractWorkAdapter({
      invoke: (async (methodId: string, input: unknown, options: unknown) => {
        calls.push({ methodId, input, options });
        return { contract: { id: 'c1', status: 'running', ask: 'x' } };
      }) as never,
    });
    await adapter.dispatch({ task: 'do the thing', metadata: { idempotencyKey: ' dispatch-1 ' } }).catch(() => undefined);
    expect(calls[0]?.methodId).toBe('contracts.start');
    expect(calls[0]?.options).toEqual({ headers: { 'Idempotency-Key': 'dispatch-1' } });
  });
});
