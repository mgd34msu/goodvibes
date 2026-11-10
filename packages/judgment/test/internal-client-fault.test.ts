import { expect, spyOn, test } from 'bun:test';
import { APIConnectionError, APIError, APIUserAbortError, TypeSafeError } from '@typesafe-ai/sdk';
import { createSystemOnePort, JudgmentError, noul, SqliteDecisionLog, withDecisionLog, type JudgmentConfig } from '../src/index.ts';
import { requestWithoutDeadline, toJudgmentError } from '../src/port/client.ts';
import * as backends from '../src/port/backends.ts';

const PRIVATE = 'private-client-fault-value';
const MESSAGE = 'The decision client failed internally. The operation has stopped.';
const request = { state: 'Synthetic client diagnostic', questions: { yes: noul('Is this synthetic?') } };
function config(fetch: NonNullable<JudgmentConfig['fetch']>): JudgmentConfig {
  return { signal: new AbortController().signal, model: 'jev-latest', timeoutMs: 100,
    endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: '', authentication: 'none' }, retry: {}, fetch,
    fallbacks: [{ model: 'kev-latest', endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: '', authentication: 'none' } }] };
}

test.each([new TypeError(PRIVATE), new Error(PRIVATE, { cause: new Error(PRIVATE) }),
  { message: PRIVATE, name: 'PrivateFaultClass', status: 503, requestId: PRIVATE }, PRIVATE])(
  'an unknown local fault carries no provider attribution or borrowed metadata', error => {
    const failure = toJudgmentError(error);
    expect(failure.kind).toBe('internal'); expect(failure.message).toBe(MESSAGE);
    expect(failure.status).toBeUndefined(); expect(failure.requestId).toBeUndefined(); expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure) + failure.stack).not.toContain(PRIVATE);
    expect(JSON.stringify(failure)).not.toContain('PrivateFaultClass');
  });

test.each(['prototype', 'revoked-proxy', 'api-body', 'api-detail', 'api-detail-kind'] as const)(
  'hostile %s inspection cannot escape the value-free internal boundary', kind => {
    let inspections = 0;
    const fail = () => { inspections++; throw new TypeError(PRIVATE); };
    let original: unknown;
    if (kind === 'prototype') original = new Proxy({}, { getPrototypeOf: fail });
    else if (kind === 'revoked-proxy') {
      const proxy = Proxy.revocable({}, {}); proxy.revoke(); original = proxy.proxy;
    } else {
      const api = APIError.fromResponse(400, {}, new Headers());
      if (kind === 'api-body') Object.defineProperty(api, 'body', { get: fail });
      else {
        const body = kind === 'api-detail'
          ? Object.defineProperty({}, 'detail', { get: fail })
          : { detail: Object.defineProperty({}, 'error_type', { get: fail }) };
        Object.defineProperty(api, 'body', { value: body });
      }
      original = api;
    }
    const failure = toJudgmentError(original);
    if (kind !== 'revoked-proxy') expect(inspections).toBe(1);
    expect(failure).toBeInstanceOf(JudgmentError);
    expect(failure.kind).toBe('internal'); expect(failure.message).toBe(MESSAGE);
    expect(failure.status).toBeUndefined(); expect(failure.requestId).toBeUndefined(); expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure) + failure.stack).not.toContain(PRIVATE);
  });

test('known API, connection, cancellation and configuration errors keep their existing classifications', () => {
  const headers = new Headers({ 'x-typesafe-request-id': 'actual-known-request' });
  expect(toJudgmentError(APIError.fromResponse(503, { error: PRIVATE }, headers)).kind).toBe('unavailable');
  expect(toJudgmentError(APIError.fromResponse(403, { error: PRIVATE }, headers)).kind).toBe('rejected');
  expect(toJudgmentError(new APIConnectionError(PRIVATE)).kind).toBe('unavailable');
  expect(toJudgmentError(new APIUserAbortError()).kind).toBe('aborted');
  expect(toJudgmentError(new TypeSafeError(PRIVATE)).kind).toBe('invalid-request');
});

test('request serialization failures happen before the wire and are not converted into connection outages', async () => {
  let wires = 0;
  const fault = new TypeError(PRIVATE), selected = config(async () => { wires++; throw new Error('Unexpected wire'); });
  const original = await requestWithoutDeadline(selected, 'POST', '/v1/systemone', selected.signal!,
    { toJSON() { throw fault; } }).catch((error: unknown) => error);
  expect(original).toBe(fault); expect(toJudgmentError(original)).toMatchObject({ kind: 'internal', message: MESSAGE });
  expect(wires).toBe(0);
});

test.each(['validation', 'backend'] as const)('an actual %s client fault records one terminal attempt without calling a backup or retry observer', async stage => {
  let wires = 0, retries = 0;
  const selected = config(async () => { wires++; return Response.json({}); });
  const port = createSystemOnePort(selected);
  const fault = spyOn(backends, stage === 'validation' ? 'validateBackendInput' : 'askBackend')
    .mockImplementation(() => { throw new TypeError(PRIVATE); });
  using log = new SqliteDecisionLog(':memory:');
  try {
    await expect(withDecisionLog(port, log).ask({ ...request, onRetry() { retries++; } }))
      .rejects.toMatchObject({ kind: 'internal', message: MESSAGE });
    expect(fault).toHaveBeenCalledTimes(1); expect(wires).toBe(0); expect(retries).toBe(0);
    const [entry] = log.query();
    if (entry?.status !== 'failed') throw new Error('Missing original failed client diagnostic');
    expect(entry.error).toEqual({ kind: 'internal', message: MESSAGE });
    expect(entry.lineage?.attempts).toMatchObject([{ attempt: 1, endpointIndex: 0, dispatched: false, outcome: 'internal' }]);
    expect(JSON.stringify(entry)).not.toContain(PRIVATE);
  } finally { fault.mockRestore(); }
});

test('a malformed provider body remains a protocol failure and retains configured failover', async () => {
  let wires = 0;
  const port = createSystemOnePort(config(async () => { wires++; return Response.json({ model: 'jev-latest', answers: {}, usage: {} }); }));
  await expect(port.ask(request)).rejects.toMatchObject({ kind: 'invalid-response' });
  expect(wires).toBe(2);
});


test('a hostile thrown backend value remains terminal without probing it again for context retry', async () => {
  let wires = 0, retries = 0, inspections = 0;
  const original = new Proxy({}, { getPrototypeOf() { inspections++; throw new TypeError(PRIVATE); } });
  const fault = spyOn(backends, 'askBackend').mockImplementation(() => { throw original; });
  try {
    const port = createSystemOnePort(config(async () => { wires++; return Response.json({}); }));
    await expect(port.ask({ ...request, onRetry() { retries++; } })).rejects.toMatchObject({ kind: 'internal', message: MESSAGE });
    expect(fault).toHaveBeenCalledTimes(1); expect(inspections).toBe(1);
    expect(wires).toBe(0); expect(retries).toBe(0);
  } finally { fault.mockRestore(); }
});
