/**
 * resolveOperatorRpc hands every consumer one client. A verb the contract
 * declares for the websocket only still has to reach the daemon, over the
 * generic gateway route; an HTTP-bound verb keeps its own route; and a state
 * directory that cannot hold the token is a refusal value, not a throw.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GoodVibesError } from '@goodvibes-jev/engine/platform';
import { describeOperatorRpcError, resolveOperatorRpc } from '../../runtime/client/operator-endpoint.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let home: string;
beforeEach(() => { home = makeProjectTempDir('gv-operator-endpoint'); });
afterEach(() => { if (existsSync(home)) rmSync(home, { recursive: true, force: true }); });

function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as never;
}
const ENABLED = { 'daemon.enabled': true, 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 3421, 'controlPlane.tls.mode': 'off' };

function recordingFetch() {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

describe('operator verbs declared for the websocket only', () => {
  for (const methodId of ['tailscale.get', 'cost.attribution.get', 'fleet.attempts.list', 'acp.agents.list']) {
    test(`${methodId} is sent over the generic gateway route instead of being refused locally`, async () => {
      const { requests, fetchImpl } = recordingFetch();
      const rpc = resolveOperatorRpc({ configManager: config(ENABLED), homeDirectory: home, fetch: fetchImpl });
      if (!rpc.available) throw new Error(rpc.reason);

      await rpc.platformClient.operator.invoke(methodId as never, {} as never);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`http://127.0.0.1:3421/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`);
      expect(requests[0]!.method).toBe('POST');
      expect(JSON.parse(requests[0]!.body!)).toEqual({ body: {} });
    });
  }

  test('a verb with its own HTTP route keeps it and never touches the gateway route', async () => {
    const { requests, fetchImpl } = recordingFetch();
    const rpc = resolveOperatorRpc({ configManager: config(ENABLED), homeDirectory: home, fetch: fetchImpl });
    if (!rpc.available) throw new Error(rpc.reason);

    await rpc.platformClient.operator.invoke('sessions.list' as never, {} as never).catch(() => undefined);

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => !request.url.includes('/api/control-plane/methods/'))).toBe(true);
  });

  test('a refusal from the daemon on the gateway route keeps its status', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'no such verb' }), { status: 404 })) as unknown as typeof fetch;
    const rpc = resolveOperatorRpc({ configManager: config(ENABLED), homeDirectory: home, fetch: fetchImpl });
    if (!rpc.available) throw new Error(rpc.reason);

    const error = await rpc.platformClient.operator.invoke('tailscale.get' as never, {} as never).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoodVibesError);
    expect((error as GoodVibesError).status).toBe(404);
  });
});

describe('a state directory that cannot hold the daemon token', () => {
  test('is an unavailable refusal that says what to check, not a throw', () => {
    // The daemon state directory path is occupied by a file, so no token can be created in it.
    mkdirSync(join(home, '.goodvibes'), { recursive: true });
    writeFileSync(join(home, '.goodvibes', 'daemon'), 'not a directory');

    const rpc = resolveOperatorRpc({ configManager: config(ENABLED), homeDirectory: home });

    expect(rpc.available).toBe(false);
    if (!rpc.available) {
      expect(rpc.reason).toContain('access token');
      expect(rpc.reason).toContain(join(home, '.goodvibes', 'daemon'));
    }
  });
});

describe('describeOperatorRpcError', () => {
  test('a contract disagreement names it as a version mismatch with a next step', () => {
    const error = new GoodVibesError('Operator method "x" does not expose an HTTP binding.', { category: 'contract', source: 'contract', recoverable: false });
    const line = describeOperatorRpcError(error);
    expect(line).toContain('disagree');
    expect(line).toContain('Update');
  });
});
