import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createRuntimeShutdown, type RuntimeShutdownDependencies } from '@/runtime/bootstrap-shutdown.ts';
import { makeLongLivedProjectTempDir } from '../helpers/project-temp.ts';

const workingDirectory = makeLongLivedProjectTempDir('agent-shutdown-timer-order');
afterAll(() => { rmSync(workingDirectory, { recursive: true, force: true }); });

test('the agent-status interval is cleared before any slow teardown step runs', async () => {
  const order: string[] = [];
  const noop = (): void => {};
  const interval = setInterval(noop, 1_000_000);
  const slot = { value: interval as ReturnType<typeof setInterval> | null };
  const deps = {
    sessionId: 's', model: 'm', provider: 'p', conversationTitle: () => '',
    sessionSpineClient: { close: noop, dispose: noop },
    takeMemorySpineTimer: () => null,
    bootstrapUnsubs: [], runtimeUnsubs: [],
    forensicsCollector: { dispose: noop }, executionLedger: { dispose: noop },
    deferredStartup: { drain: async () => { order.push(`drain:${slot.value === null ? 'cleared' : 'armed'}`); } },
    agentExternalServices: { stop: async () => { order.push(`services:${slot.value === null ? 'cleared' : 'armed'}`); } },
    agentStatusIntervalRef: slot,
    scheduleManager: { destroy: noop } as unknown as RuntimeShutdownDependencies['scheduleManager'],
    hookDispatcher: null as RuntimeShutdownDependencies['hookDispatcher'],
    providerRegistry: { stopWatching: noop } as unknown as RuntimeShutdownDependencies['providerRegistry'],
    sessionOrchestration: { dispose: noop } as unknown as RuntimeShutdownDependencies['sessionOrchestration'],
    shutdownOptions: { workingDirectory } as unknown as RuntimeShutdownDependencies['shutdownOptions'],
    disposeRuntimeGraph: noop,
  } satisfies RuntimeShutdownDependencies;
  try {
    await createRuntimeShutdown(deps)({ messages: [] } as unknown as Parameters<ReturnType<typeof createRuntimeShutdown>>[0]);
  } finally { clearInterval(interval); }
  expect(order).toEqual(['drain:cleared', 'services:cleared']);
});
