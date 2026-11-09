import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderRegistry, BenchmarkStore } from '@goodvibes-jev/engine/platform/platform/providers';
import type { RouteBindingManager, SurfaceRegistry } from '@goodvibes-jev/engine/platform/platform/channels';
import type { WatcherRegistry } from '@goodvibes-jev/engine/platform/platform/watchers';
import type { AutomationManager, AutomationDeliveryManager } from '@goodvibes-jev/engine/platform/platform/automation';
import type { DomainDispatch, RuntimeEventBus, RuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/state';
export function initializeTerminalCatalog(
  provider: ProviderRegistry,
  benchmarks: BenchmarkStore,
  loadKeybindings: () => void,
  wirePricing?: ((provider: ProviderRegistry) => void) | undefined,
): void {
  provider.initModelLimits();
  benchmarks.initBenchmarks();
  provider.initCatalog();
  wirePricing?.(provider);
  loadKeybindings();
}
export function seedTerminalControlPlane(
  dispatch: DomainDispatch,
  config: Pick<ConfigManager, 'get'>,
  sessionId: string,
  client: Pick<Parameters<DomainDispatch['syncControlPlaneClient']>[0], 'id' | 'kind' | 'label' | 'capabilities' | 'metadata'>,
): void {
  dispatch.syncControlPlaneState(
    {
      enabled: Boolean(config.get('controlPlane.enabled')),
      host: String(config.get('controlPlane.host') ?? '127.0.0.1'),
      port: Number(config.get('controlPlane.port') ?? 3421),
      connectionState: config.get('controlPlane.enabled') ? 'connected' : 'disabled',
      isRunning: Boolean(config.get('controlPlane.enabled')),
    },
    'bootstrap.control-plane',
  );
  dispatch.syncControlPlaneClient(
    { ...client, transport: 'local', connected: true, sessionId, authenticatedAt: Date.now(), lastSeenAt: Date.now() },
    'bootstrap.control-plane',
  );
}
/** Runtime observers share attachment order, heartbeat identity and teardown ownership. */
export function attachTerminalRuntimeBindings(
  services: {
    readonly routeBindings: Pick<RouteBindingManager, 'attachRuntime'>;
    readonly surfaceRegistry: Pick<SurfaceRegistry, 'attachRuntime' | 'syncConfiguredSurfaces'>;
    readonly watcherRegistry: Pick<WatcherRegistry, 'attachRuntime' | 'registerPollingWatcher' | 'startWatcher' | 'stopWatcher'>;
    readonly automationManager: Pick<AutomationManager, 'attachRuntime'>;
    readonly deliveryManager: AutomationDeliveryManager;
  },
  runtimeBus: RuntimeEventBus,
  runtimeStore: RuntimeStore,
  config: Pick<ConfigManager, 'get'>,
): () => void {
  services.routeBindings.attachRuntime({ runtimeBus, runtimeStore });
  services.surfaceRegistry.attachRuntime(runtimeStore);
  services.surfaceRegistry.syncConfiguredSurfaces();
  services.watcherRegistry.attachRuntime({ runtimeBus, runtimeStore });
  const heartbeatEnabled = Boolean(config.get('watchers.enabled'));
  if (heartbeatEnabled) {
    services.watcherRegistry.registerPollingWatcher({
      id: 'runtime-heartbeat',
      label: 'Runtime heartbeat',
      source: {
        id: 'source:runtime-heartbeat',
        kind: 'watcher',
        label: 'Runtime heartbeat',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
      intervalMs: Number(config.get('watchers.heartbeatIntervalMs') ?? 30_000),
      run: () => new Date().toISOString(),
    });
    services.watcherRegistry.startWatcher('runtime-heartbeat');
  }
  services.automationManager.attachRuntime({ runtimeBus, runtimeStore, deliveryManager: services.deliveryManager });
  return () => {
    if (heartbeatEnabled) services.watcherRegistry.stopWatcher('runtime-heartbeat');
  };
}
