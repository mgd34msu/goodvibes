/**
 * scheduler-capacity.test.ts
 *
 * Tests for GET /api/runtime/scheduler scheduler capacity endpoint.
 *
 * - Route handler and dispatcher: pass the automation manager's report through unchanged
 *   (the report is a stub here, so these tests only pin the wiring and shape)
 * - Real counters: the capacity computation and the manager's configured slot total
 */

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { computeSchedulerCapacity } from '../platform/src/platform/automation/scheduler-capacity.js';
import type { AutomationRun } from '../platform/src/platform/automation/runs.js';
import { automationMutationFixture } from './_helpers/automation-mutation-fixture.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { createDaemonRuntimeAutomationRouteHandlers } from '../daemon-api/src/runtime-automation-routes.js';
import { dispatchOperatorRoutes } from '../daemon-api/src/operator.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import type { DaemonApiRouteHandlers } from '../daemon-api/src/context.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type CapacitySnapshot = {
  slotsTotal: number;
  slotsInUse: number;
  queueDepth: number;
  oldestQueuedAgeMs: number | null;
};

function makeContext(capacity: CapacitySnapshot): DaemonRuntimeRouteContext {
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
    sessionBroker: {
      start: async () => {},
      submitMessage: async () => { throw new Error('not expected'); },
      steerMessage: async () => { throw new Error('not expected'); },
      followUpMessage: async () => { throw new Error('not expected'); },
      bindAgent: async () => {},
      createSession: async () => ({ id: 'stub' }),
      register: async () => ({ record: { id: 'stub' }, reopened: false }),
      getSession: () => null,
      getMessages: () => [],
      getInputs: () => [],
      getInputsSince: () => [],
      markInputDelivered: async () => null,
      closeSession: async () => null,
      reopenSession: async () => null,
      detachParticipant: async () => null,
      deleteSession: async () => 'not-found' as const,
      cancelInput: async () => null,
      completeAgent: async () => {},
      appendCompanionMessage: async () => {},
    },
    agentManager: { getStatus: () => null, cancel: () => {} },
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
      getSchedulerCapacity: () => capacity,
    },
    normalizeAtSchedule: () => ({}),
    normalizeEverySchedule: () => ({}),
    normalizeCronSchedule: () => ({}),
    routeBindings: { start: async () => {}, getBinding: () => undefined },
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

describe('GET /api/runtime/scheduler: empty state', () => {
  test('empty state returns documented shape with zero counters', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 0,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = await handlers.getSchedulerCapacity(new Request('http://localhost/api/runtime/scheduler'));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['slotsTotal']).toBe('number');
    expect(typeof body['slotsInUse']).toBe('number');
    expect(typeof body['queueDepth']).toBe('number');
    // oldestQueuedAgeMs is null when queue is empty
    expect(body['oldestQueuedAgeMs']).toBeNull();
    expect(body['slotsTotal']).toBe(4);
    expect(body['slotsInUse']).toBe(0);
    expect(body['queueDepth']).toBe(0);
  });
});

describe('GET /api/runtime/scheduler: live state', () => {
  test('with running runs: slotsInUse reflects executing count', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 2,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = await handlers.getSchedulerCapacity(new Request('http://localhost/api/runtime/scheduler'));
    const body = await res.json() as Record<string, unknown>;
    expect(body['slotsInUse']).toBe(2);
    expect(body['queueDepth']).toBe(0);
  });

  test('with queued runs: queueDepth and oldestQueuedAgeMs populated', async () => {
    const oldestAgeMs = 12_500;
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 4,
      queueDepth: 3,
      oldestQueuedAgeMs: oldestAgeMs,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = await handlers.getSchedulerCapacity(new Request('http://localhost/api/runtime/scheduler'));
    const body = await res.json() as Record<string, unknown>;
    expect(body['slotsInUse']).toBe(4);
    expect(body['queueDepth']).toBe(3);
    expect(body['oldestQueuedAgeMs']).toBe(oldestAgeMs);
  });

  test('oldestQueuedAgeMs is null when queue is empty even when slotsInUse > 0', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 2,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = await handlers.getSchedulerCapacity(new Request('http://localhost/api/runtime/scheduler'));
    const body = await res.json() as Record<string, unknown>;
    expect(body['oldestQueuedAgeMs']).toBeNull();
  });
});

describe('GET /api/runtime/scheduler: HTTP route wiring', () => {
  test('getSchedulerCapacity handler returns 200 with required field keys', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 1,
      queueDepth: 2,
      oldestQueuedAgeMs: 5000,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = await handlers.getSchedulerCapacity(new Request('http://localhost/api/runtime/scheduler'));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // Verify all four documented fields are present
    expect('slotsTotal' in body).toBe(true);
    expect('slotsInUse' in body).toBe(true);
    expect('queueDepth' in body).toBe(true);
    expect('oldestQueuedAgeMs' in body).toBe(true);
  });

  // Dispatcher integration: the following tests go through dispatchOperatorRoutes
  // to verify the scheduler route is correctly wired at the HTTP dispatch layer.

  test('happy path via dispatcher: GET /api/runtime/scheduler returns 200 with documented shape', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 1,
      queueDepth: 2,
      oldestQueuedAgeMs: 5000,
    });
    const channelHandlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const handlers = {
      ...channelHandlers,
    } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/runtime/scheduler', { method: 'GET' });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body['slotsTotal']).toBe('number');
    expect(typeof body['slotsInUse']).toBe('number');
    expect(typeof body['queueDepth']).toBe('number');
    expect(body['slotsTotal']).toBe(4);
    expect(body['slotsInUse']).toBe(1);
    expect(body['queueDepth']).toBe(2);
    expect(body['oldestQueuedAgeMs']).toBe(5000);
  });

  test('non-200 pass-through via dispatcher: handler returning 403 is plumbed through by dispatcher', async () => {
    // Simulates a non-200 response scenario: the handler returns a 403 Response.
    // Verifies the dispatcher faithfully plumbs through non-200 responses
    // without replacing or overriding them.
    const forbidden = new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    const handlers = {
      getSchedulerCapacity: () => forbidden,
    } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/runtime/scheduler', { method: 'GET' });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe('scheduler capacity counters (real computation)', () => {
  function run(id: string, status: AutomationRun['status'], queuedAt: number): AutomationRun {
    return {
      id,
      labels: [],
      createdAt: queuedAt,
      updatedAt: queuedAt,
      jobId: 'job-1',
      status,
      triggeredBy: { id: 'source-1', kind: 'manual', label: 'test', enabled: true, createdAt: 1, updatedAt: 1, metadata: {} },
      target: { kind: 'background' },
      execution: { target: { kind: 'background' } },
      queuedAt,
      forceRun: false,
      dueRun: false,
      attempt: 1,
      deliveryIds: [],
    };
  }

  test('counts running runs as slots in use and queued runs as depth, aging from the oldest queued run', () => {
    const report = computeSchedulerCapacity(4, [
      run('a', 'running', 100),
      run('b', 'queued', 4_000),
      run('c', 'queued', 2_500),
      run('d', 'completed', 10),
    ], 10_000);
    expect(report).toEqual({ slotsTotal: 4, slotsInUse: 1, queueDepth: 2, oldestQueuedAgeMs: 7_500 });
  });

  test('an empty queue has no oldest age', () => {
    expect(computeSchedulerCapacity(4, [run('a', 'running', 100)], 10_000).oldestQueuedAgeMs).toBeNull();
  });

  test('the manager reports the default of four slots, follows automation.maxConcurrentRuns, and counts a started run', async () => {
    const dir = makeProjectTempDir('scheduler-capacity-manager');
    const f = automationMutationFixture(dir);
    try {
      expect(f.manager.getSchedulerCapacity()).toMatchObject({ slotsTotal: 4, slotsInUse: 0, queueDepth: 0, oldestQueuedAgeMs: null });
      f.config.set('automation.maxConcurrentRuns', 2);
      const job = await f.create();
      await f.manager.start();
      await f.manager.runNow(job.id);
      expect(f.manager.getSchedulerCapacity()).toMatchObject({ slotsTotal: 2, slotsInUse: 1 });
    } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
