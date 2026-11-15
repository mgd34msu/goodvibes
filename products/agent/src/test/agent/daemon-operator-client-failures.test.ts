/**
 * daemon-operator-client-failures.test.ts, a failed call says why, an address
 * the host echoes back is not passed on, and a call the caller cancelled is not
 * reported as a dead host.
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonOperatorInvoke } from '../../agent/daemon-operator-client.ts';

const connection = { baseUrl: 'http://127.0.0.1:3421', token: 'fixture-token' };
const invokeWith = (fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) =>
  createDaemonOperatorInvoke(() => connection, fetchImpl);

describe('a refusal carries the daemon\'s reason', () => {
  test('a validation message in the body reaches the caller with the status', async () => {
    const invoke = invokeWith(async () => Response.json({ error: 'Field status must be one of: draft, queued' }, { status: 400 }));

    const result = await invoke('services.status', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('connected_host_error');
    expect(result.refusal?.status).toBe(400);
    expect(result.error).toContain('Field status must be one of: draft, queued');
  });

  test('the reason is bounded and has addresses and control characters removed', async () => {
    const invoke = invokeWith(async () => Response.json({ message: `bad\u0007 target https://hooks.example.test/T0/secret ${'x'.repeat(500)}` }, { status: 422 }));

    const result = await invoke('services.status', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('[address]');
    expect(result.error).not.toContain('secret');
    expect(result.error).not.toContain('\u0007');
    expect(result.refusal!.reason.length).toBeLessThanOrEqual(203);
  });
});

describe('a cancelled call is not a dead host', () => {
  test('an aborted signal is reported as cancelled', async () => {
    const controller = new AbortController();
    const invoke = invokeWith(async (_input, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return new Response('{}');
    });

    const result = await invoke('services.status', {}, { signal: controller.signal });

    expect(result).toMatchObject({ ok: false, kind: 'cancelled' });
  });

  test('a refused connection is reported as an unreachable host that did not act', async () => {
    const invoke = invokeWith(async () => { throw Object.assign(new Error('Unable to connect'), { code: 'ECONNREFUSED' }); });

    const result = await invoke('services.status', {});

    expect(result).toMatchObject({ ok: false, kind: 'connected_host_unavailable', applied: 'no' });
  });
});
