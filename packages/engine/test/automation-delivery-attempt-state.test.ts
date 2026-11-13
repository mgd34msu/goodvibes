import { expect, test } from 'bun:test';
import { AutomationDeliveryManager } from '../platform/src/platform/automation/delivery-manager.ts';
import type { AutomationJob } from '../platform/src/platform/automation/jobs.ts';
import type { AutomationRun } from '../platform/src/platform/automation/runs.ts';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.ts';
import type { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

const job = {
  id: 'job-1', name: 'Digest',
  delivery: { mode: 'surface', targets: [], fallbackTargets: [], includeLinks: false },
  failure: { retryPolicy: { maxAttempts: 1, delayMs: 0, strategy: 'fixed' } },
} as unknown as AutomationJob;
const run = { id: 'run-1', jobId: 'job-1', status: 'completed', target: { kind: 'background' } } as unknown as AutomationRun;
const target = { kind: 'surface', surfaceKind: 'webhook', address: 'https://fixture.invalid' } as const;

function manager(send: () => Promise<string>, bus: { emit(domain: string, event: { type: string }): void }) {
  return new AutomationDeliveryManager({
    routeBindings: { start: async () => undefined, getBinding: () => undefined } as unknown as RouteBindingManager,
    featureFlags: { isEnabled: () => true },
    deliveryRouter: { setControlPlaneGateway() {}, deliver: send } as never,
    runtimeBus: bus as unknown as RuntimeEventBus,
  });
}

function busThatThrowsOnStart() {
  const seen: string[] = [];
  return {
    seen,
    emit(_domain: string, event: { type: string }) {
      seen.push(event.type);
      if (event.type === 'DELIVERY_STARTED') throw new Error('bus rejected the started event');
    },
  };
}

test('a throwing start report does not abort the delivery or leave the attempt pending', async () => {
  const bus = busThatThrowsOnStart();
  let sends = 0;
  const attempts = await manager(async () => { sends++; return 'message-1'; }, bus).deliverText(job, run, 'body', [target]);
  expect(sends).toBe(1);
  expect(attempts.map(a => a.status)).toEqual(['sent']);
  expect(bus.seen).toContain('DELIVERY_SUCCEEDED');
});

test('a throwing start report with a failing send still settles the attempt as failed', async () => {
  const bus = busThatThrowsOnStart();
  const attempts = await manager(async () => { throw Object.assign(new Error('rejected'), { status: 404 }); }, bus)
    .deliverText(job, run, 'body', [target]);
  expect(attempts).toHaveLength(1);
  expect(['failed', 'dead_lettered']).toContain(attempts[0]!.status);
  expect(bus.seen).toContain('DELIVERY_FAILED');
});
