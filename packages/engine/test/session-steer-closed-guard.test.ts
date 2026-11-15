/**
 * session-steer-closed-guard.test.ts
 *
 * Acceptance re-replay, the HTTP route surface for
 * `POST /api/sessions/:id/steer`. The broker (session-broker.ts) now throws
 * `{ code: 'SESSION_CLOSED', status: 409 }` before any mutation when the
 * target session is closed (see session-steer-surface-routing.test.ts for the
 * broker-level no-side-effects proof). This file proves the route handler
 * converts that thrown error into a structured 409 JSON response, the same
 * shape the messages route already returns for kind='message' on a closed
 * session, instead of letting it propagate as an unhandled rejection, and
 * that a normal (non-closed) steer submission still reaches the caller
 * unchanged.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createDaemonRuntimeSessionRouteHandlers } from '../daemon-api/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import { makeSessionRouteContext } from './_helpers/session-route-context.ts';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/sessions/s-1/steer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeContext(steerMessage: (input: unknown) => Promise<unknown>): DaemonRuntimeRouteContext {
  return makeSessionRouteContext({ steerMessage });
}

describe('POST /api/sessions/:id/steer: closed-session guard', () => {
  test('returns 409 { code: SESSION_CLOSED } when the broker rejects a closed session', async () => {
    const ctx = makeContext(async () => {
      throw Object.assign(new Error('Session is closed: s-1'), { code: 'SESSION_CLOSED', status: 409 });
    });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);

    const res = await handlers.postSharedSessionSteer('s-1', makeRequest({ body: 'steer a closed session' }));

    expect(res.status).toBe(409);
    const payload = await res.json() as { code?: string; error?: string };
    expect(payload.code).toBe('SESSION_CLOSED');
    expect(typeof payload.error).toBe('string');
  });

  test('returns 404 { code: SESSION_NOT_FOUND } and starts no agent when the broker has no such session', async () => {
    const ctx = makeContext(async () => {
      throw Object.assign(new Error('Unknown shared session "s-1"'), { code: 'SESSION_NOT_FOUND', status: 404 });
    });
    let spawned = 0;
    (ctx as unknown as { trySpawnAgent: () => unknown }).trySpawnAgent = () => { spawned += 1; return null; };
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);

    const res = await handlers.postSharedSessionSteer('s-1', makeRequest({ body: 'steer a session nobody holds', allowSpawnFallback: true }));

    expect(res.status).toBe(404);
    expect((await res.json() as { code?: string }).code).toBe('SESSION_NOT_FOUND');
    expect(spawned).toBe(0);
  });

  test('an unrelated thrown error from the broker is not swallowed as SESSION_CLOSED', async () => {
    const ctx = makeContext(async () => {
      throw new Error('boom');
    });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);

    await expect(handlers.postSharedSessionSteer('s-1', makeRequest({ body: 'steer' }))).rejects.toThrow('boom');
  });

  test('an open-session steer submission still reaches the caller (spawn fallback)', async () => {
    const sessionId = randomUUID();
    const ctx = makeContext(async (input) => ({
      mode: 'spawn',
      input: { id: randomUUID(), state: 'pending' },
      session: { id: sessionId, status: 'active' },
      task: (input as { body: string }).body,
      routeBinding: undefined,
      activeAgentId: null,
      userMessage: null,
    }));
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);

    const res = await handlers.postSharedSessionSteer(sessionId, makeRequest({ body: 'steer an open session' }));

    expect(res.status).toBe(202);
    const payload = await res.json() as { mode?: string; agentId?: string };
    expect(payload.mode).toBe('spawn');
    expect(typeof payload.agentId).toBe('string');
  });
});
