import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.js';
import { createRuntimeServices } from '../platform/src/platform/runtime/services.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { platformTracer } from '../platform/src/platform/runtime/metrics.js';
import { releaseComposedTelemetry } from '../platform/src/platform/runtime/telemetry/index.js';
import { emitMcpConnected, emitMcpDisconnected } from '../platform/src/platform/runtime/emitters/mcp.js';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The tracer is process-wide and counted per live runtime, so runtimes other
// test files in the same process left open would keep this file's closes from
// being the last. Releasing until a release shuts a tracer down means no hold is left.
async function dropLeftoverTelemetryHolds() {
  for (;;) {
    const shutdown = spyOn(platformTracer(), 'shutdown');
    await releaseComposedTelemetry();
    const released = shutdown.mock.calls.length > 0;
    shutdown.mockRestore();
    if (released) return;
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'platform-services-teardown-'));
  roots.push(root);
  const workingDir = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDir); mkdirSync(homeDirectory);
  seedBenchmarkCache(homeDirectory, 'goodvibes');
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes-test', workingDir, homeDir: homeDirectory });
  await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
  const runtimeBus = new RuntimeEventBus();
  const build = () => createRuntimeServices({ configManager, workingDir, homeDirectory, surfaceRoot: 'goodvibes', runtimeBus, runtimeStore: createRuntimeStore() });
  return { configManager, runtimeBus, build };
}

test('closing the runtime closes the memory and code index database handles it opened', async () => {
  const { build } = await fixture();
  const services = build();
  const memoryClose = spyOn(services.memoryStore, 'close');
  const codeIndexClose = spyOn(services.codeIndexStore, 'close');
  await services.close();
  expect(memoryClose).toHaveBeenCalled();
  expect(codeIndexClose).toHaveBeenCalled();
}, 30_000);

test('closing the runtime shuts down the tracer it composed so held spans are sent', async () => {
  await dropLeftoverTelemetryHolds();
  const { build } = await fixture();
  const services = build();
  const shutdown = spyOn(platformTracer(), 'shutdown');
  await services.close();
  expect(shutdown).toHaveBeenCalled();
}, 30_000);

test('closing one of two live runtimes leaves the shared tracer sending spans until the last closes', async () => {
  await dropLeftoverTelemetryHolds();
  const first = await fixture();
  const second = await fixture();
  const servicesA = first.build();
  const servicesB = second.build();
  const tracer = platformTracer();
  const shutdown = spyOn(tracer, 'shutdown');
  await servicesB.close();
  expect(shutdown).not.toHaveBeenCalled();
  expect(platformTracer()).toBe(tracer);
  await servicesA.close();
  expect(shutdown).toHaveBeenCalledTimes(1);
}, 30_000);

test('a construction failure after the timers started stops them', async () => {
  const { configManager, build } = await fixture();
  const stopWatch = spyOn(configManager, 'stopWatchingConfigFiles');
  const realGet = configManager.get.bind(configManager);
  // The token auditor reads this key after the config watch and schedulers are running.
  spyOn(configManager, 'get').mockImplementation(((key: string) => {
    if (key === 'security.tokenAudit.managed') throw new Error('construction failed');
    return realGet(key as never);
  }) as never);
  expect(() => build()).toThrow('construction failed');
  expect(stopWatch).toHaveBeenCalled();
}, 30_000);

test('a token finding reaches the security domain once however often the audit runs', async () => {
  const { runtimeBus, build } = await fixture();
  const services = build();
  const seen: string[] = [];
  runtimeBus.onDomain('security', (envelope: { type: string }) => { seen.push(envelope.type); });
  const day = 24 * 60 * 60 * 1000;
  services.tokenAuditor.registerPolicy({ id: 'p', name: 'p', allowedScopes: ['read'], rotationCadenceMs: 10 * day, rotationWarningThresholdMs: 2 * day });
  services.tokenAuditor.registerToken({ id: 't', label: 'ci', issuedAt: 0, grantedScopes: ['read'], policyId: 'p' });
  services.tokenAuditor.runAudit(11 * day);
  services.tokenAuditor.runAudit(12 * day);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  expect(seen.filter((type) => type === 'TOKEN_ROTATION_EXPIRED')).toHaveLength(1);
  await services.close();
}, 30_000);

test('closing the runtime detaches the feature-flag settings bridge from the config manager', async () => {
  const { configManager, build } = await fixture();
  const live = new Set<symbol>();
  const subscribe = configManager.subscribe.bind(configManager);
  spyOn(configManager, 'subscribe').mockImplementation(((key: never, listener: never) => {
    const token = Symbol('subscription');
    live.add(token);
    const off = subscribe(key, listener);
    return () => { live.delete(token); off(); };
  }) as never);
  const services = build();
  const before = live.size;
  expect(before).toBeGreaterThan(0);
  await services.close();
  expect(live.size).toBeLessThan(before);
}, 30_000);

test('runtime health follows the event bus until the runtime is closed', async () => {
  const { runtimeBus, build } = await fixture();
  const services = build();
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const ctx = { sessionId: 's', source: 'test', traceId: 'trace-teardown' };
  emitMcpDisconnected(runtimeBus, ctx, { serverId: 'a', willRetry: false });
  await flush();
  expect(services.healthAggregator.getDomainHealth('mcp').status).toBe('failed');
  await services.close();
  emitMcpConnected(runtimeBus, ctx, { serverId: 'a', toolCount: 0, resourceCount: 0 });
  await flush();
  expect(services.healthAggregator.getDomainHealth('mcp').status).toBe('failed');
}, 30_000);
