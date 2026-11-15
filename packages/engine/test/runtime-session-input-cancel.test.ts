/**
 * runtime-session-input-cancel.test.ts
 *
 * Tests for cancelSharedSessionInput state-transition guard.
 *
 * queued input → cancel returns 200, input state transitions to cancelled
 * spawned input → cancel returns 409 CANCEL_NOT_ALLOWED
 * unknown input id → 404
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createDaemonRuntimeSessionRouteHandlers } from '../daemon-api/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { buildRouterSessionBrokerAdapter } from '../platform/src/platform/daemon/http/router-session-broker-adapter.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const ADMIN_REQUEST = new Request('http://localhost/api/sessions/test-session/inputs/input/cancel', { method: 'POST' });

// ---------------------------------------------------------------------------
// Minimal context stub
// ---------------------------------------------------------------------------

/**
 * The real shared-session broker owns the input states; the rest of the route
 * context is a stub, because cancel only reads the broker.
 */
function makeContext(broker: SharedSessionBroker): DaemonRuntimeRouteContext {
  return {
    parseJsonBody: async (req) => {
      try { return await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    parseOptionalJsonBody: async (req) => {
      const text = await req.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    recordApiResponse: (_req, _path, response) => response,
    requireAdmin: () => null,
    sessionBroker: buildRouterSessionBrokerAdapter(broker),
    agentManager: {
      getStatus: () => null,
      cancel: () => {},
    },
    automationManager: {
      listJobs: () => [],
      listRuns: () => [],
      getRun: () => null,
      triggerHeartbeat: async () => ({}),
      cancelRun: async () => null,
      retryRun: async () => { throw new Error('not expected'); },
      createJob: async () => ({ id: 'stub-job' }),
      updateJob: async () => null,
      removeJob: async () => {},
      setEnabled: async () => null,
      runNow: async () => ({ id: 'stub-run', status: 'running' }),
      getSchedulerCapacity: () => ({ slotsTotal: 4, slotsInUse: 0, queueDepth: 0, oldestQueuedAgeMs: null }),
    },
    normalizeAtSchedule: () => ({}),
    normalizeEverySchedule: () => ({}),
    normalizeCronSchedule: () => ({}),
    routeBindings: {
      start: async () => {},
      getBinding: () => undefined,
    },
    trySpawnAgent: () => new Response(JSON.stringify({ error: 'not expected' }), { status: 500 }),
    queueSurfaceReplyFromBinding: () => {},
    completeSurfaceReplyFromSurface: async () => false,
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response('', { status: 200 }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const disposables = trackDisposables();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeBroker(): SharedSessionBroker {
  const dir = mkdtempSync(join(tmpdir(), 'gv-input-cancel-'));
  dirs.push(dir);
  return disposables.add(new SharedSessionBroker({
    storePath: join(dir, 'sessions.json'),
    routeBindings: { start: async () => {}, getBinding: () => null, resolve: () => null, patchBinding: async () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: (id) => ({ id, status: 'running' }) },
    messageSender: { send: () => false },
  }));
}

/** A session holding one input; `bound` hands it to an agent first, the way a spawned run does. */
async function withInput(bound: boolean) {
  const broker = makeBroker();
  await broker.createSession({ id: 'test-session' });
  const { input } = await broker.submitMessage({ sessionId: 'test-session', surfaceKind: 'web', surfaceId: 'surface:web', body: 'hello' });
  if (bound) await broker.bindAgent('test-session', 'agent-1', input.id);
  const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext(broker));
  const cancel = (inputId = input.id) => handlers.cancelSharedSessionInput('test-session', inputId, ADMIN_REQUEST);
  const state = () => broker.getInputs('test-session').find((entry) => entry.id === input.id)?.state;
  return { broker, input, cancel, state };
}

describe('cancelSharedSessionInput: queued → cancelled', () => {
  test('queued input → cancel returns 200, input state is cancelled', async () => {
    const { cancel, state } = await withInput(false);
    expect(state()).toBe('queued');
    const res = await cancel();
    expect(res.status).toBe(200);
    const body = await res.json() as { input: { state: string } };
    expect(body.input.state).toBe('cancelled');
    expect(state()).toBe('cancelled');
  });

  test('already-cancelled input → cancel returns 200 (idempotent)', async () => {
    const { cancel, state } = await withInput(false);
    expect((await cancel()).status).toBe(200);
    const again = await cancel();
    expect(again.status).toBe(200);
    expect(state()).toBe('cancelled');
  });
});

describe('cancelSharedSessionInput: an input already being answered → 409 CANCEL_NOT_ALLOWED', () => {
  test('a spawned input is refused, left as it was, and named in the refusal', async () => {
    const { cancel, state } = await withInput(true);
    const before = state();
    expect(before).not.toBe('queued');
    const res = await cancel();
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; error: string; input: { state: string } };
    expect(body.code).toBe('CANCEL_NOT_ALLOWED');
    expect(body.error).toContain(`'${before}'`);
    expect(body.input.state).toBe(before!);
    expect(state()).toBe(before);
  });
});

describe('cancelSharedSessionInput: unknown input → 404', () => {
  test('unknown input id → 404', async () => {
    const { cancel } = await withInput(false);
    const res = await cancel('no-such-input');
    expect(res.status).toBe(404);
  });
});
