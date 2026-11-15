import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import {
  createDaemonApiRouteProbe,
  reconcileCatalogRoutes,
} from '../platform/src/platform/control-plane/method-catalog-route-reconcile.ts';
import { BATCH_JOB_SCHEMA } from '../platform/src/platform/control-plane/method-catalog-batch.ts';
import { BATCH_ROUTES, dispatchBatchRoutes } from '../platform/src/platform/daemon/http/batch-routes.ts';
import { CLOUDFLARE_ROUTES, dispatchCloudflareRoutes } from '../platform/src/platform/daemon/http/cloudflare-routes.ts';
import { firstJsonSchemaFailure } from '../transport-http/src/index.js';

const descriptors = new GatewayMethodCatalog().list().filter((d) => d.id.startsWith('batch.') || d.id.startsWith('cloudflare.'));

describe('batch and cloudflare route families are described by the catalog', () => {
  test('every described path is served by its sub-router', async () => {
    expect(descriptors.length).toBeGreaterThan(0);
    const results = await reconcileCatalogRoutes(descriptors, createDaemonApiRouteProbe());
    expect(results.filter((r) => r.status !== 'live').map((r) => `${r.methodId}: ${r.reason}`)).toEqual([]);
  });

  test('every route a sub-router serves has a descriptor, except the listed aliases of one that does', () => {
    const described = new Set(descriptors.flatMap((d) => (d.http ? [`${d.http.method} ${d.http.path}`] : [])));
    const aliases = new Set([
      'GET /api/batch', 'GET /api/batch/config',
      'GET /api/cloudflare', 'GET /api/cloudflare/token/requirements',
    ]);
    const undescribed = [...BATCH_ROUTES, ...CLOUDFLARE_ROUTES]
      .map((r) => `${r.method} ${r.path}`)
      .filter((route) => !described.has(route) && !aliases.has(route));
    expect(undescribed).toEqual([]);
  });

  test('the write verbs of both families need an admin, and every cloudflare verb does', () => {
    for (const d of descriptors) {
      const writes = d.http !== undefined && d.http.method !== 'GET' && d.id.startsWith('batch.');
      if (d.id.startsWith('cloudflare.') || writes) expect(d.access, d.id).toBe('admin');
    }
    expect(descriptors.find((d) => d.id === 'batch.jobs.list')?.access).toBe('authenticated');
  });

  test('a job the batch route returns validates against the published job schema', async () => {
    const job = {
      id: 'batch-job-1', provider: 'anthropic', model: 'm', status: 'completed', createdAt: 1, updatedAt: 2, attempts: 1,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      source: { kind: 'client' },
      result: { content: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
      error: { message: 'x', code: 'y', raw: { provider: 'detail' } },
    };
    const context = {
      batchManager: { getJob: async () => job },
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
    } as unknown as Parameters<typeof dispatchBatchRoutes>[1];
    const res = await dispatchBatchRoutes(new Request('http://daemon.invalid/api/batch/jobs/batch-job-1'), context);
    const body = await res!.json() as { job: unknown };
    expect(firstJsonSchemaFailure(BATCH_JOB_SCHEMA, body.job)).toBeUndefined();
  });

  test('the cloudflare disable result carries its remote outcome through the published schema', async () => {
    const outputSchema = descriptors.find((d) => d.id === 'cloudflare.disable')!.outputSchema!;
    const store = new Map<string, unknown>();
    const context = {
      configManager: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => { store.set(key, value); } },
      secretsManager: { get: async () => null },
      authToken: '',
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => ({ persistConfig: false }),
    } as unknown as Parameters<typeof dispatchCloudflareRoutes>[1];
    const res = await dispatchCloudflareRoutes(new Request('http://daemon.invalid/api/cloudflare/disable', { method: 'POST', body: '{}' }), context);
    const body = await res!.json();
    expect(body).toMatchObject({ ok: true, remote: 'not-disabled' });
    expect(firstJsonSchemaFailure(outputSchema, body)).toBeUndefined();
  });
});
