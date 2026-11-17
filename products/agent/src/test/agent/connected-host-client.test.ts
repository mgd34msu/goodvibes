// Proves: The Agent's client presents its credential on the contract route, a write is never sent twice, a path value cannot turn one method into another route, and the owner's switch stops it dialling.
// Red when: A write goes to another route, without the credential or the explicit-request header, or more than once (also after a 500 or 504), a `..` path value is sent, or the Agent dials while daemon.connectedHost.enabled is false.
/**
 * The connected-host client's contract: which credential it presents, what a
 * failure says about the host and about the request, that a write is never
 * replayed, and that no failure costs a model request.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import {
  createConnectedHost,
  EXPLICIT_USER_REQUEST_HEADER,
  HostFailure,
  resolveConnectedHost,
  type ConnectedHostConnection,
} from '../../agent/connected-host-client.ts';
import { invokeOperatorGatewayMethod, type OperatorGatewayCallResult } from '../../agent/operator-gateway-call.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const baseUrl = 'http://127.0.0.1:3421';
const connection: ConnectedHostConnection = { baseUrl, token: 'fixture-token', credential: '/fixture/token' };
const methodId = 'profile.forget';
const payload = { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' } as const;

let requests: { url: string; method: string; headers: Headers; body: unknown }[];
let respond: (url: string, init: RequestInit | undefined) => Promise<Response>;
let modelRequests: number;
let previousPort: ReturnType<typeof installJudgmentPort>;
const fetchImpl = mockFetch(async (input, init) => {
  requests.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body });
  return respond(String(input), init);
});
const host = createConnectedHost(() => connection, { fetchImpl });

async function failureOf(pending: Promise<unknown>): Promise<HostFailure> {
  const error = await pending.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HostFailure);
  return error as HostFailure;
}

beforeEach(() => {
  requests = [];
  respond = async () => Response.json({ ok: true, changes: [], disclosure: 'removed' });
  modelRequests = 0;
  previousPort = installJudgmentPort({ model: 'counting-fixture', ask: async () => { modelRequests += 1; throw new Error('no model here'); } });
});
afterEach(() => {
  installJudgmentPort(previousPort);
  expect(modelRequests).toBe(0);
});

describe('connected-host client calls', () => {
  test('a write goes to the contract route once, with the credential and the explicit-request header', async () => {
    expect(await host.invoke(methodId, payload, { explicitUserRequest: true })).toEqual({ ok: true, changes: [], disclosure: 'removed' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: `${baseUrl}/api/profile/forget`, method: 'POST', body: JSON.stringify(payload) });
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer fixture-token');
    expect(requests[0]!.headers.get(EXPLICIT_USER_REQUEST_HEADER)).toBe('true');
  });

  test('a path value that would leave the route refuses before anything is sent', async () => {
    const failure = await failureOf(host.invoke('principals.get', { principalId: '..' }));
    expect(failure.refusal.code).toBe('bad_input');
    expect(requests).toHaveLength(0);
  });

  test.each([
    [400, 'connected_host_error', 'host_refused', 'no'],
    [409, 'connected_host_error', 'host_refused', 'no'],
    [401, 'auth_required', 'auth_rejected', 'no'],
    [403, 'auth_required', 'forbidden', 'no'],
    [429, 'connected_host_error', 'rate_limited', 'no'],
    [500, 'connected_host_error', 'host_failed', 'unknown'],
    [504, 'connected_host_unavailable', 'host_timeout', 'unknown'],
  ] as const)('HTTP %s on a write: %s, sent once, the host\'s own reason kept', async (status, kind, code, applied) => {
    respond = async () => Response.json({ error: 'host says why' }, { status });
    const failure = await failureOf(host.invoke(methodId, payload));
    expect(failure).toMatchObject({ kind, applied, refusal: { code, status } });
    expect(failure.refusal.reason).toContain('host says why');
    expect(requests).toHaveLength(1);
  });
});

describe('connected-host resolution', () => {
  let home: string;
  const saved = { a: process.env.GOODVIBES_CONNECTED_HOST_TOKEN, b: process.env.GOODVIBES_DAEMON_TOKEN };
  const config = (values: Record<string, unknown> = {}) => ({ get: (key: string) => values[key] });
  const writeToken = (token: string) => {
    const path = connectedHostOperatorTokenPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ token }));
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'connected-host-'));
    delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
    delete process.env.GOODVIBES_DAEMON_TOKEN;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of [['GOODVIBES_CONNECTED_HOST_TOKEN', saved.a], ['GOODVIBES_DAEMON_TOKEN', saved.b]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  test('dialing turned off is a refusal naming the setting', () => {
    writeToken('file-token');
    expect(resolveConnectedHost({ configManager: config({ 'daemon.connectedHost.enabled': false }), homeDirectory: home })).toMatchObject({
      token: null, unavailable: { code: 'dial_disabled' },
    });
  });
});

// Never executed: the compiler keeps method-specific inputs and outputs across the client.
function assertTypes(): void {
  const input: OperatorMethodInput<'workLedger.execution.status'> = {
    projectId: 'p', workId: 'w', attemptId: 'a', expectedRevision: { work: 1, criteria: 1, attempt: 1 },
  };
  const exact: Promise<OperatorMethodOutput<'workLedger.execution.status'>> = host.invoke('workLedger.execution.status', input);
  const viaGateway: Promise<OperatorGatewayCallResult<OperatorMethodOutput<'workLedger.execution.status'>>> = invokeOperatorGatewayMethod(
    { baseUrl, token: 't', tokenPath: 'p' }, 'workLedger.execution.status', 'label', input);
  // @ts-expect-error A method-specific required field cannot be omitted.
  void host.invoke('workLedger.execution.status', { projectId: 'p' });
  // @ts-expect-error The output cannot be read as an unrelated shape.
  const wrong: Promise<{ unrelated: true }> = host.invoke('workLedger.execution.status', input);
  void exact; void viaGateway; void wrong;
}
void assertTypes;
