/**
 * router-e2e-session.test.ts
 *
 * Router-level E2E tests for the session route family.
 * Exercises dispatchSessionRoutes which handles:
 *   GET  /api/sessions
 *   POST /api/sessions
 *   GET  /api/sessions/:id
 *   POST /api/sessions/:id/close
 *   GET  /api/sessions/:id/messages
 *   POST /api/sessions/:id/messages
 *   GET  /api/sessions/:id/inputs
 *   POST /api/sessions/:id/steer
 *   POST /api/sessions/:id/follow-up
 *   POST /api/sessions/:id/inputs/:inputId/cancel
 *   GET  /api/sessions/:id/events
 */

import { describe, expect, test } from 'bun:test';
import { dispatchSessionRoutes } from '../daemon-api/src/sessions.js';
import type { DaemonApiRouteHandlers } from '../daemon-api/src/context.js';
import { makeRequest } from './_helpers/router-requests.js';

function makeSession(id = 'sess-1') {
  return {
    id,
    status: 'active' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeMessage(id = 'msg-1') {
  return {
    id,
    role: 'assistant' as const,
    content: 'Hello from test',
    createdAt: Date.now(),
  };
}

/**
 * Minimal stub satisfying the Pick used by dispatchSessionRoutes.
 */
function makeSessionHandlers(
  overrides: Partial<DaemonApiRouteHandlers> = {},
): DaemonApiRouteHandlers {
  const defaults: Partial<DaemonApiRouteHandlers> = {
    getIntegrationSessions: () =>
      Response.json({ sessions: [makeSession()] }),

    createSharedSession: async (_req) =>
      Response.json(makeSession('sess-new'), { status: 200 }),

    getSharedSession: (sessionId) =>
      Response.json(makeSession(sessionId)),

    closeSharedSession: (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    reopenSharedSession: (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    getSharedSessionMessages: (sessionId, _url) =>
      Response.json({ messages: [makeMessage()], sessionId }),

    postSharedSessionMessage: async (sessionId, _req) =>
      Response.json({ messageId: 'msg-queued', sessionId }),

    getSharedSessionInputs: (sessionId, _url) =>
      Response.json({ inputs: [], sessionId }),

    postSharedSessionSteer: async (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    postSharedSessionFollowUp: async (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    cancelSharedSessionInput: (sessionId, inputId, _req) =>
      Response.json({ ok: true, sessionId, inputId }),

    getSharedSessionEvents: (_sessionId, _req) =>
      new Response('data: {"type":"ready"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  };

  return { ...defaults, ...overrides } as DaemonApiRouteHandlers;
}

// ---------------------------------------------------------------------------
// describe: session routes, happy paths
// ---------------------------------------------------------------------------

describe('router-e2e session: POST /api/sessions (happy path)', () => {
  test('creates a session and returns 200 with session id', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('POST', 'http://localhost/api/sessions', {
      modelId: 'inception:mercury-2',
    });
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.id).toBe('string'); // id is a string session ID
    expect(body.status).toBe('active');
  });

  test('GET /api/sessions returns integration session list', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/sessions');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { sessions: unknown[] };
    expect(body.sessions).toBeInstanceOf(Array);
  });
});

describe('router-e2e session: messages (happy path)', () => {
  test('GET /api/sessions/:id/messages returns message list', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/sessions/sess-1/messages');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { messages: unknown[] };
    expect(body.messages).toBeInstanceOf(Array);
  });

  test('POST /api/sessions/:id/messages submits message and returns messageId', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('POST', 'http://localhost/api/sessions/sess-1/messages', {
      content: 'Run the tests',
    });
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.messageId).toBe('string'); // messageId is a string
  });

  test('POST /api/sessions/:id/close closes session', async () => {
    let capturedId: string | null = null;
    const handlers = makeSessionHandlers({
      closeSharedSession: (sessionId, _req) => {
        capturedId = sessionId;
        return Response.json({ ok: true, sessionId });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/sessions/sess-1/close');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // `capturedId` is reassigned inside the `closeSharedSession` handler
    // closure above; TS's control-flow analysis can't see across that
    // boundary, so its narrowed type here is stuck at the `null` initializer.
    expect(capturedId as unknown as string).toBe('sess-1');
    const body = await res!.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: session routes, failure paths
// ---------------------------------------------------------------------------

describe('router-e2e session: failure paths', () => {
  test('returns null for unmatched path', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/no-such-session-route');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('returns null for unknown sub-path on session', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/sessions/sess-1/unknown-sub');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('POST /api/sessions/:id/inputs/:inputId/cancel cancels input', async () => {
    let capturedInput: string | null = null;
    const handlers = makeSessionHandlers({
      cancelSharedSessionInput: (sessionId, inputId, _req) => {
        capturedInput = inputId;
        return Response.json({ ok: true, sessionId, inputId });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/sessions/sess-1/inputs/input-99/cancel');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // Same closure-narrowing note as above: `capturedInput` is reassigned
    // inside the `cancelSharedSessionInput` handler closure.
    expect(capturedInput as unknown as string).toBe('input-99');
  });
});

// ---------------------------------------------------------------------------
// describe: every remaining route reaches its handler with the exact arguments
// ---------------------------------------------------------------------------

describe('router-e2e session: handler arguments per route', () => {
  type Call = { handler: string; args: unknown[]; req: Request | null };

  function recordingHandlers(calls: Call[]): DaemonApiRouteHandlers {
    const names = [
      'getSharedSession', 'deleteSharedSession', 'closeSharedSession', 'reopenSharedSession',
      'detachSharedSession', 'getSharedSessionMessages', 'postSharedSessionMessage',
      'getSharedSessionInputs', 'postSharedSessionSteer', 'postSharedSessionFollowUp',
      'cancelSharedSessionInput', 'deliverSharedSessionInput', 'getSharedSessionEvents',
      'registerSharedSession', 'createSharedSession',
    ];
    const out: Record<string, unknown> = {};
    for (const name of names) {
      out[name] = (...all: unknown[]) => {
        const req = all.find((a): a is Request => a instanceof Request) ?? null;
        calls.push({ handler: name, args: all.filter((a) => !(a instanceof Request) && !(a instanceof URL)), req });
        return Response.json({ ok: true });
      };
    }
    return out as unknown as DaemonApiRouteHandlers;
  }

  const base = 'http://localhost/api/sessions';
  const cases: Array<{ method: string; path: string; handler: string; args: unknown[] }> = [
    { method: 'GET', path: `${base}/s-1`, handler: 'getSharedSession', args: ['s-1'] },
    { method: 'DELETE', path: `${base}/s-1`, handler: 'deleteSharedSession', args: ['s-1'] },
    { method: 'POST', path: `${base}/s-1/close`, handler: 'closeSharedSession', args: ['s-1'] },
    { method: 'POST', path: `${base}/s-1/reopen`, handler: 'reopenSharedSession', args: ['s-1'] },
    { method: 'POST', path: `${base}/s-1/detach`, handler: 'detachSharedSession', args: ['s-1'] },
    { method: 'GET', path: `${base}/s-1/messages`, handler: 'getSharedSessionMessages', args: ['s-1'] },
    { method: 'POST', path: `${base}/s-1/messages`, handler: 'postSharedSessionMessage', args: ['s-1'] },
    { method: 'GET', path: `${base}/s-1/inputs`, handler: 'getSharedSessionInputs', args: ['s-1'] },
    { method: 'POST', path: `${base}/s-1/steer`, handler: 'postSharedSessionSteer', args: ['s-1'] },
    { method: 'POST', path: `${base}/s-1/follow-up`, handler: 'postSharedSessionFollowUp', args: ['s-1'] },
    { method: 'POST', path: `${base}/s-1/inputs/in-2/cancel`, handler: 'cancelSharedSessionInput', args: ['s-1', 'in-2'] },
    { method: 'POST', path: `${base}/s-1/inputs/in-2/deliver`, handler: 'deliverSharedSessionInput', args: ['s-1', 'in-2'] },
    { method: 'GET', path: `${base}/s-1/events`, handler: 'getSharedSessionEvents', args: ['s-1'] },
    { method: 'POST', path: `${base}/register`, handler: 'registerSharedSession', args: [] },
    { method: 'POST', path: base, handler: 'createSharedSession', args: [] },
  ];

  for (const c of cases) {
    test(`${c.method} ${c.path.replace('http://localhost', '')} calls ${c.handler}(${c.args.join(', ')})`, async () => {
      const calls: Call[] = [];
      const req = makeRequest(c.method, c.path);
      const res = await dispatchSessionRoutes(req, recordingHandlers(calls));
      expect(res?.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.handler).toBe(c.handler);
      expect(calls[0]!.args).toEqual(c.args);
    });
  }

  test('the close, steer and cancel routes hand the original request to the handler', async () => {
    for (const path of [`${base}/s-1/close`, `${base}/s-1/steer`, `${base}/s-1/inputs/in-2/cancel`]) {
      const calls: Call[] = [];
      const req = makeRequest('POST', path);
      await dispatchSessionRoutes(req, recordingHandlers(calls));
      expect(calls[0]!.req).toBe(req);
    }
  });

  test('a percent-encoded session id is decoded before it reaches the handler', async () => {
    const calls: Call[] = [];
    await dispatchSessionRoutes(makeRequest('POST', `${base}/a%2Fb%20c/steer`), recordingHandlers(calls));
    expect(calls[0]!.args).toEqual(['a/b c']);
  });

  test('a method that does not match the route is not dispatched', async () => {
    const calls: Call[] = [];
    const res = await dispatchSessionRoutes(makeRequest('GET', `${base}/s-1/steer`), recordingHandlers(calls));
    expect(res).toBeNull();
    expect(calls).toEqual([]);
  });
});
