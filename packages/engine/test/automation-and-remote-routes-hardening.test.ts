/** Automation job patches and listing, the heartbeat queue, remote payload sizing and error statuses, telemetry read failures. */
import { describe, expect, test } from 'bun:test';
import { createDaemonRuntimeAutomationRouteHandlers } from '../daemon-api/src/runtime-automation-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import { createDaemonRemoteRouteHandlers, estimateJsonByteLengthWithinLimit } from '../daemon-api/src/remote-routes.js';
import { createDaemonTelemetryRouteHandlers } from '../daemon-api/src/telemetry-routes.js';
import { paginateItems, encodeCursor } from '../daemon-api/src/pagination.js';

function automation(jobs: Array<{ id: string }>, wakes?: unknown[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let body: Record<string, unknown> = {};
  const context = {
    requireAdmin: () => null,
    parseJsonBody: async () => body,
    automationManager: {
      listJobs: () => jobs,
      listRuns: () => [],
      updateJob: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return { id }; },
      ...(wakes ? { listHeartbeatWakes: () => wakes } : {}),
    },
  } as unknown as DaemonRuntimeRouteContext;
  return {
    handlers: createDaemonRuntimeAutomationRouteHandlers(context),
    updates,
    withBody: (next: Record<string, unknown>) => { body = next; },
  };
}
function automationThrowing(error: unknown) {
  const context = {
    requireAdmin: () => null,
    parseJsonBody: async () => ({ enabled: true }),
    automationManager: {
      listJobs: () => [{ id: 'j1' }],
      updateJob: async () => { throw error; },
      runNow: async () => { throw error; },
    },
  } as unknown as DaemonRuntimeRouteContext;
  return createDaemonRuntimeAutomationRouteHandlers(context);
}
const patchRequest = () => new Request('http://daemon.invalid/api/automation/jobs/j1', { method: 'PATCH' });

describe('PATCH /api/automation/jobs/:id', () => {
  test('a string where a boolean belongs is refused and the job is not touched', async () => {
    const f = automation([{ id: 'j1' }]);
    f.withBody({ enabled: 'false' });
    const response = await f.handlers.patchAutomationJob('j1', patchRequest());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_SCHEDULE_PATCH' });
    expect(f.updates).toEqual([]);
  });

  test.each([
    ['autoApprove', 'yes'], ['toolAllowlist', 'bash'], ['target', 'x'], ['timeoutMs', -1], ['prompt', 7],
  ])('%s with the wrong type is refused', async (field, value) => {
    const f = automation([{ id: 'j1' }]);
    f.withBody({ [field]: value });
    expect((await f.handlers.patchAutomationJob('j1', patchRequest())).status).toBe(400);
    expect(f.updates).toEqual([]);
  });

  test('well-typed fields reach the manager', async () => {
    const f = automation([{ id: 'j1' }]);
    f.withBody({ enabled: false, prompt: 'new', toolAllowlist: ['read'] });
    expect((await f.handlers.patchAutomationJob('j1', patchRequest())).status).toBe(200);
    expect(f.updates).toEqual([{ id: 'j1', patch: { enabled: false, prompt: 'new', toolAllowlist: ['read'] } }]);
  });
});

describe('automation service failures', () => {
  const full = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL', retryable: true });

  test('a failure that carries no status while updating a job is a refused request (400)', async () => {
    const response = await automationThrowing(new Error('Automation route target requires a provider')).patchAutomationJob('j1', patchRequest());
    expect(response.status).toBe(400);
  });

  test('a retryable storage failure while updating a job is a 503, not a mistake in the request', async () => {
    expect((await automationThrowing(full).patchAutomationJob('j1', patchRequest())).status).toBe(503);
  });

  test('an error with its own status keeps it when running a job now', async () => {
    const response = await automationThrowing(Object.assign(new Error('busy'), { status: 409 })).runScheduleNow('j1', patchRequest());
    expect(response.status).toBe(409);
  });
});

describe('automation listing and heartbeat', () => {
  test('a jobs cursor whose job is gone is refused so the client restarts on purpose', async () => {
    const f = automation([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const gone = encodeCursor('deleted-job');
    const response = await f.handlers.getAutomationJobs(new URL(`http://daemon.invalid/api/automation/jobs?limit=2&cursor=${gone}`));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('Cursor expired');
  });

  test('other lists keep restarting from the first item by default', () => {
    const result = paginateItems([{ id: 'a' }, { id: 'b' }], 5, encodeCursor('gone'), (item) => item.id);
    expect('items' in result && result.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  test('the heartbeat queue lists the jobs waiting for the next heartbeat', async () => {
    const wake = { jobId: 'j1', queuedAt: 1 };
    const f = automation([], [wake]);
    expect(await (await f.handlers.getAutomationHeartbeat()).json()).toEqual({ pending: [wake] });
  });
});

describe('remote payload size', () => {
  test('a large array of small numbers is within the limit it actually encodes to', () => {
    const value = Array.from({ length: 70_000 }, () => 1);
    const size = estimateJsonByteLengthWithinLimit(value, 1_000_000);
    expect(size).toEqual({ kind: 'ok', byteLength: JSON.stringify(value).length + 1 });
  });

  test('the estimate is within one byte per container of the real encoding', () => {
    const value = { name: 'é', list: [1, 22.5, true, null, 'x'], nested: { deep: { ok: false } } };
    const real = Buffer.byteLength(JSON.stringify(value));
    const size = estimateJsonByteLengthWithinLimit(value, 1_000_000);
    expect(size.kind).toBe('ok');
    if (size.kind === 'ok') {
      expect(size.byteLength).toBeGreaterThanOrEqual(real);
      expect(size.byteLength - real).toBeLessThanOrEqual(5);
    }
  });

  test('keys count toward the limit', () => {
    const value = { [`k${'x'.repeat(2_000_000)}`]: 1 };
    const size = estimateJsonByteLengthWithinLimit(value, 1_000_000);
    expect(size).toEqual({ kind: 'ok', byteLength: 1_000_001 });
  });
});

describe('remote and telemetry error statuses', () => {
  const remote = (invokePeer: () => Promise<unknown>) => createDaemonRemoteRouteHandlers({
    requireAdmin: () => null,
    parseJsonBody: async () => ({ command: 'ping' }),
    requireAuthenticatedSession: () => null,
    distributedRuntime: { invokePeer },
  } as never);
  const invoke = (invokePeer: () => Promise<unknown>) =>
    remote(invokePeer).invokeRemotePeer('peer-1', new Request('http://daemon.invalid/x', { method: 'POST' }));

  test('an unknown peer is a 404', async () => {
    expect((await invoke(async () => { throw new Error('Unknown distributed peer: peer-1'); })).status).toBe(404);
  });

  test('any other failure while invoking is a 500, not an unknown peer', async () => {
    expect((await invoke(async () => { throw new Error('disk full'); })).status).toBe(500);
  });

  test('a retryable failure while invoking keeps its 503', async () => {
    expect((await invoke(async () => { throw Object.assign(new Error('queue full'), { retryable: true }); })).status).toBe(503);
  });

  test('a telemetry read that fails for a reason other than the cursor is a 500', async () => {
    const handlers = createDaemonTelemetryRouteHandlers({
      telemetryApi: { isRawEnabled: () => false, listEventPage: () => { throw new Error('store unavailable'); } },
      resolveAuthenticatedPrincipal: () => ({ principalId: 'u', principalKind: 'user', admin: true, scopes: ['read:telemetry'] }),
      ingestSink: null,
    } as never);
    const response = await handlers.getTelemetryEvents(new Request('http://daemon.invalid/api/v1/telemetry/events'));
    expect(response.status).toBe(500);
    expect((await response.json() as { code: string }).code).toBe('TELEMETRY_READ_FAILED');
  });

  test('a cursor the store rejects is still a 400', async () => {
    const handlers = createDaemonTelemetryRouteHandlers({
      telemetryApi: { isRawEnabled: () => false, listEventPage: () => { throw new Error('Invalid telemetry cursor: nope'); } },
      resolveAuthenticatedPrincipal: () => ({ principalId: 'u', principalKind: 'user', admin: true, scopes: ['read:telemetry'] }),
      ingestSink: null,
    } as never);
    const response = await handlers.getTelemetryEvents(new Request('http://daemon.invalid/api/v1/telemetry/events?cursor=nope'));
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('INVALID_CURSOR');
  });
});
