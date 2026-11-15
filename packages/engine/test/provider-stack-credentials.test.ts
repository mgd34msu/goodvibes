/**
 * The provider stack's credential chain: refreshes run one at a time with a
 * trailing run, and a disposed stack stops reacting to secrets changes.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProviderStack,
  hasLiveCredentialRefresh,
  type ProviderRegistryConstructionOptions,
} from '../platform/src/platform/runtime/provider-stack.ts';
import { ProviderRegistry } from '../platform/src/platform/providers/registry.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { ServiceRegistry } from '../platform/src/platform/config/service-registry.ts';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.ts';
import { createRuntimeSecretsManager } from '../platform/src/platform/runtime/secrets-composition.ts';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
import { resolveRuntimeFeatureFlags } from '../platform/src/platform/runtime/feature-flag-composition.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createDurabilityServices, type DurabilityServicesInput } from '../platform/src/platform/runtime/durability-services.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gv-provider-stack-credentials-'));
  roots.push(root);
  const workingDirectory = join(root, 'work');
  const surfaceRoot = 'tui';
  seedBenchmarkCache(root, surfaceRoot);
  const configManager = new ConfigManager({ workingDir: workingDirectory, homeDir: root, surfaceRoot });
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory: root });
  const realSecrets = createRuntimeSecretsManager({ projectRoot: workingDirectory, globalHome: root, surfaceRoot, configManager });
  // Secrets changes are fired by the test instead of by a store write.
  const listeners = new Set<(key: string) => void>();
  const secretsManager = new Proxy(realSecrets, {
    get(target, property) {
      if (property === 'onDidChange') {
        return (listener: (key: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as SecretsManager;
  const subscriptionManager = new SubscriptionManager(shellPaths.resolveUserPath(surfaceRoot, 'subscriptions.json'));
  const runs: Array<() => void> = [];
  class Controlled extends ProviderRegistry {
    public override refreshProviderCredentials(): Promise<void> {
      return new Promise<void>((resolve) => { runs.push(resolve); });
    }
  }
  const releases: Array<() => void> = [];
  const stack = createProviderStack({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry: new ServiceRegistry(shellPaths.resolveProjectPath(surfaceRoot, 'services.json'), { secretsManager, subscriptionManager }),
    featureFlags: resolveRuntimeFeatureFlags({ configManager }),
    runtimeBus: new RuntimeEventBus(),
    shellPaths,
    surfaceRoot,
    modelDiscovery: 'skip',
    providerRegistryFactory: (options: ProviderRegistryConstructionOptions) => new Controlled(options),
    registerDispose: (release) => { releases.push(release); },
  });
  return { stack, listeners, runs, releases };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('provider stack credential refreshes', () => {
  test('changes during a running refresh share one trailing run that starts after it finishes', async () => {
    const { listeners, runs } = setup();
    expect(runs).toHaveLength(1); // the boot refresh is running
    for (const listener of listeners) { listener('A'); listener('B'); listener('C'); }
    await flush();
    // Nothing else started: a second run now could finish first and re-register stale keys.
    expect(runs).toHaveLength(1);
    runs[0]!();
    await flush();
    expect(runs).toHaveLength(2); // one trailing run for all three changes
    runs[1]!();
    await flush();
    expect(runs).toHaveLength(2);
  });

  test('the stack records that it owns the registry credential refresh', () => {
    const { stack } = setup();
    expect(hasLiveCredentialRefresh(stack.providerRegistry)).toBe(true);
  });

  test('a disposed stack no longer reacts to secrets changes', async () => {
    const { listeners, runs, releases } = setup();
    expect(listeners.size).toBe(1);
    runs[0]!();
    await flush();
    for (const release of releases) release();
    expect(listeners.size).toBe(0);
  });

  test('durability services leave a registry the stack already refreshes alone', async () => {
    const { stack, listeners, runs } = setup();
    expect(listeners.size).toBe(1);
    const root = mkdtempSync(join(tmpdir(), 'gv-durability-owned-'));
    roots.push(root);
    const services = createDurabilityServices({
      configManager: { getControlPlaneConfigDir: () => root, get: () => undefined, watchConfigFiles: () => () => undefined },
      secretsManager: { onDidChange: (listener: (key: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
      providerRegistry: stack.providerRegistry,
      memoryDbPath: join(root, 'memory.sqlite'),
      codeIndexDbPath: join(root, 'code.sqlite'),
      surface: { workingDirectory: root, surfaceRoot: undefined, homeDirectory: root },
      shellPaths: { resolveUserPath: (...segments: string[]) => join(root, ...segments) },
    } as unknown as DurabilityServicesInput);
    try {
      await flush();
      // No second listener and no second boot refresh next to the stack's own.
      expect(listeners.size).toBe(1);
      expect(runs).toHaveLength(1);
    } finally {
      services.stopConfigWatch(); services.stopDurabilityHousekeeping();
      services.storeSnapshotScheduler.stop(); services.appendOnlyRetentionScheduler.stop();
    }
  });
});
