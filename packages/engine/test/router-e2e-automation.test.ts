/**
 * router-e2e-automation.test.ts
 *
 * Router-level E2E tests for the automation route family.
 * Exercises dispatchAutomationRoutes which handles:
 *   GET  /api/review
 *   GET  /api/automation/jobs
 *   GET  /api/automation/runs
 *   GET  /api/automation/runs/:id
 *   POST /api/automation/runs/:id/(cancel|retry)
 *   (create, update, delete, enable, disable are gateway-table only)
 *   POST /api/automation/jobs/:id/(pause|resume|run)
 */

import { describe, expect, test } from 'bun:test';
import { dispatchAutomationRoutes } from '../daemon-api/src/automation.js';
import type { DaemonApiRouteHandlers } from '../daemon-api/src/context.js';
import { makeRequest } from './_helpers/router-requests.js';

function makeJob(id = 'job-1') {
  return {
    id,
    name: `Job ${id}`,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeRun(id = 'run-1', status: 'running' | 'completed' | 'failed' = 'completed') {
  return { id, status, jobId: 'job-1', createdAt: Date.now() };
}

/**
 * Minimal stub satisfying the Pick used by dispatchAutomationRoutes.
 */
function makeAutomationHandlers(
  overrides: Partial<DaemonApiRouteHandlers> = {},
): DaemonApiRouteHandlers {
  const defaults: Partial<DaemonApiRouteHandlers> = {
    getReview: () => Response.json({ review: { status: 'ok' } }),
    getIntegrationSession: () => Response.json({ session: null }),
    getIntegrationAutomation: () => Response.json({ automation: {} }),
    getAutomationJobs: () => Response.json({ jobs: [makeJob()] }),
    postAutomationJob: async (_req) => {
      return Response.json(makeJob('job-new'), { status: 201 });
    },
    getAutomationRuns: () => Response.json({ runs: [makeRun()] }),
    getAutomationRun: (runId) => {
      if (runId === 'run-1') return Response.json(makeRun('run-1'));
      return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
    },
    automationRunAction: (runId, action) =>
      Response.json({ ok: true, runId, action }),
    patchAutomationJob: (jobId, _req) =>
      Response.json({ ...makeJob(jobId), name: 'Updated Job' }),
    deleteAutomationJob: (jobId, _req) =>
      Response.json({ ok: true, jobId }),
    setAutomationJobEnabled: (jobId, enabled, _req) =>
      Response.json({ ok: true, jobId, enabled }),
    runAutomationJobNow: (jobId, _req) =>
      Response.json({ ok: true, jobId }),
    getDeliveries: () => Response.json({ deliveries: [] }),
    getDelivery: (id) => Response.json({ id, status: 'delivered' }),
    getSchedules: () => Response.json({ schedules: [] }),
    postSchedule: async () => Response.json({ id: 'sched-1' }, { status: 201 }),
    deleteSchedule: (id, _req) => Response.json({ ok: true, id }),
    setScheduleEnabled: (id, enabled, _req) => Response.json({ ok: true, id, enabled }),
    runScheduleNow: (id, _req) => Response.json({ ok: true, id }),
  };

  return { ...defaults, ...overrides } as DaemonApiRouteHandlers;
}

// ---------------------------------------------------------------------------
// describe: automation routes, happy paths
// ---------------------------------------------------------------------------

describe('router-e2e automation: GET /api/automation/jobs (happy path)', () => {
  test('returns 200 with jobs array', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/jobs');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { jobs: unknown[] };
    expect(body.jobs).toBeInstanceOf(Array);
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('router-e2e automation: runs (happy path)', () => {
  test('GET /api/automation/runs returns run list', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/runs');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { runs: unknown[] };
    expect(body.runs).toBeInstanceOf(Array);
  });

  test('GET /api/automation/runs/:id retrieves specific run', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/runs/run-1');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.id).toBe('run-1');
  });

  test('POST /api/automation/runs/:id/cancel cancels the run', async () => {
    const capturedAction: { value: string | null } = { value: null };
    const handlers = makeAutomationHandlers({
      automationRunAction: (runId, action) => {
        capturedAction.value = action;
        return Response.json({ ok: true, runId, action });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/automation/runs/run-1/cancel');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(capturedAction.value).toBe('cancel');
  });
});

// ---------------------------------------------------------------------------
// describe: automation routes, failure paths
// ---------------------------------------------------------------------------

describe('router-e2e automation: failure paths', () => {
  test('GET /api/automation/runs/:id returns 404 for unknown run', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/runs/nonexistent-run');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');
  });

  test('returns null for unmatched route', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/no-such-automation-route');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('job and schedule create, update, delete, enable and disable are not served here, only by the gateway table', async () => {
    const calls: string[] = [];
    const handlers = makeAutomationHandlers({
      postAutomationJob: () => { calls.push('postAutomationJob'); return Response.json({}); },
      patchAutomationJob: () => { calls.push('patchAutomationJob'); return Response.json({}); },
      deleteAutomationJob: () => { calls.push('deleteAutomationJob'); return Response.json({}); },
      setAutomationJobEnabled: () => { calls.push('setAutomationJobEnabled'); return Response.json({}); },
      postSchedule: () => { calls.push('postSchedule'); return Response.json({}); },
      deleteSchedule: () => { calls.push('deleteSchedule'); return Response.json({}); },
      setScheduleEnabled: () => { calls.push('setScheduleEnabled'); return Response.json({}); },
    });
    const paths: Array<[string, string]> = [
      ['POST', '/api/automation/jobs'],
      ['PATCH', '/api/automation/jobs/j'],
      ['DELETE', '/api/automation/jobs/j'],
      ['POST', '/api/automation/jobs/j/enable'],
      ['POST', '/api/automation/jobs/j/disable'],
      ['POST', '/api/automation/schedules'],
      ['DELETE', '/api/automation/schedules/s'],
      ['POST', '/api/automation/schedules/s/enable'],
      ['POST', '/api/automation/schedules/s/disable'],
    ];
    for (const [method, path] of paths) {
      expect(await dispatchAutomationRoutes(makeRequest(method, `http://localhost${path}`), handlers)).toBeNull();
    }
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// describe: every mutating route reaches its handler with the exact arguments
// ---------------------------------------------------------------------------

describe('router-e2e automation: handler arguments per route', () => {
  type Call = { handler: string; args: unknown[]; req: Request };

  function recordingHandlers(calls: Call[]): DaemonApiRouteHandlers {
    const record = (handler: string) => (...all: unknown[]) => {
      const req = all.find((a): a is Request => a instanceof Request) as Request;
      calls.push({ handler, args: all.filter((a) => !(a instanceof Request)), req });
      return Response.json({ ok: true });
    };
    return {
      patchAutomationJob: record('patchAutomationJob'),
      deleteAutomationJob: record('deleteAutomationJob'),
      setAutomationJobEnabled: record('setAutomationJobEnabled'),
      runAutomationJobNow: record('runAutomationJobNow'),
      automationRunAction: record('automationRunAction'),
      setScheduleEnabled: record('setScheduleEnabled'),
      runScheduleNow: record('runScheduleNow'),
    } as unknown as DaemonApiRouteHandlers;
  }

  const cases: Array<{ method: string; path: string; handler: string; args: unknown[] }> = [
    { method: 'POST', path: '/api/automation/jobs/job-9/resume', handler: 'setAutomationJobEnabled', args: ['job-9', true] },
    { method: 'POST', path: '/api/automation/jobs/job-9/pause', handler: 'setAutomationJobEnabled', args: ['job-9', false] },
    { method: 'POST', path: '/api/automation/jobs/job-9/run', handler: 'runAutomationJobNow', args: ['job-9'] },
    { method: 'POST', path: '/api/automation/runs/run-7/retry', handler: 'automationRunAction', args: ['run-7', 'retry'] },
    { method: 'POST', path: '/api/automation/runs/run-7/cancel', handler: 'automationRunAction', args: ['run-7', 'cancel'] },
    { method: 'POST', path: '/api/automation/schedules/s-1/run', handler: 'runScheduleNow', args: ['s-1'] },
  ];

  for (const c of cases) {
    test(`${c.method} ${c.path} calls ${c.handler}(${c.args.map(String).join(', ')}) with the request`, async () => {
      const calls: Call[] = [];
      const req = makeRequest(c.method, `http://localhost${c.path}`);
      const res = await dispatchAutomationRoutes(req, recordingHandlers(calls));
      expect(res?.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.handler).toBe(c.handler);
      expect(calls[0]!.args).toEqual(c.args);
      expect(calls[0]!.req).toBe(req);
    });
  }

  test('a percent-encoded job id is decoded before it reaches the handler', async () => {
    const calls: Call[] = [];
    const req = makeRequest('POST', 'http://localhost/api/automation/jobs/job%2Fwith%20space/pause');
    await dispatchAutomationRoutes(req, recordingHandlers(calls));
    expect(calls[0]!.args).toEqual(['job/with space', false]);
  });

  test('a method that does not match the route is not dispatched', async () => {
    const calls: Call[] = [];
    const res = await dispatchAutomationRoutes(
      makeRequest('GET', 'http://localhost/api/automation/jobs/job-9/pause'),
      recordingHandlers(calls),
    );
    expect(res).toBeNull();
    expect(calls).toEqual([]);
  });
});
