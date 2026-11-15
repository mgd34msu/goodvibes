import { describe, expect, test } from 'bun:test';
import { createOperatorApiClient } from '../operator-client/src/client.js';
import { ContractError } from '../errors/src/index.js';
import { createWebSocketRemoteError } from '../transport-realtime/src/runtime-events.js';

function jsonFetch(body: unknown): typeof fetch {
  const impl = async (): Promise<Response> => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

const BASE = { baseUrl: 'http://127.0.0.1:3210', authToken: 'tok' };

describe('a response that does not match its schema after a successful answer', () => {
  test('a state-changing method with a registered schema says the request was applied', async () => {
    const client = createOperatorApiClient({ ...BASE, fetch: jsonFetch({ unexpected: true }) });
    const error = await client.invoke('control.auth.login', { username: 'u', password: 'p' } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    const failure = error as ContractError;
    expect(failure.message).toContain('Response validation failed');
    expect(failure.message).toContain('Do not repeat the request');
    expect(failure.phase).toBe('response-validation');
    expect(failure.hint).toContain('Do not repeat the request');
  });

  test('a read-only method does not claim anything was applied', async () => {
    const client = createOperatorApiClient({ ...BASE, fetch: jsonFetch({ unexpected: true }) });
    const error = await client.invoke('control.auth.current' as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).message).not.toContain('Do not repeat the request');
  });
});

describe('createWebSocketRemoteError reads wire fields by their declared type', () => {
  test('mistyped fields are dropped instead of copied', () => {
    const error = createWebSocketRemoteError('fallback', {
      error: 'x', category: 'contract', recoverable: 'yes', requestId: 7, status: '500', provider: 3, hint: 9,
    });
    expect(error.message).toBe('x');
    expect(error.category).not.toBe('contract');
    expect(typeof error.recoverable).toBe('boolean');
    expect(error.requestId).toBeUndefined();
    expect(error.provider).toBeUndefined();
  });

  test('well-typed fields are kept', () => {
    const error = createWebSocketRemoteError('fallback', {
      error: 'slow down', category: 'rate_limit', recoverable: true, requestId: 'req-1', hint: 'wait',
    });
    expect(error.category).toBe('rate_limit');
    expect(error.recoverable).toBe(true);
    expect(error.requestId).toBe('req-1');
    expect(error.hint).toBe('wait');
  });
});
