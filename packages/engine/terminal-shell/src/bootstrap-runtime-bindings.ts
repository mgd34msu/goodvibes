import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { resolveDaemonEnabled } from '@goodvibes/engine/platform/platform/config';
import type { ProviderRegistry, BenchmarkStore } from '@goodvibes/engine/platform/platform/providers';
import type { RouteBindingManager, SurfaceRegistry } from '@goodvibes/engine/platform/platform/channels';
import type { WatcherRegistry } from '@goodvibes/engine/platform/platform/watchers';
import type { AutomationManager, AutomationDeliveryManager } from '@goodvibes/engine/platform/platform/automation';
import type { ControlSurfaceEntry, ControlToolOptions } from '@goodvibes/engine/platform/platform/tools';
import type { MemoryRegistry } from '@goodvibes/engine/platform/platform/state';
import type { DomainDispatch, RuntimeEventBus, RuntimeStore } from '@goodvibes/engine/platform/platform/runtime/state';
import { resolveRuntimeEndpointBinding } from './cli-endpoints.js';
export function initializeTerminalCatalog(
  provider: ProviderRegistry,
  benchmarks: BenchmarkStore,
  loadKeybindings: () => void,
): void {
  provider.initModelLimits();
  benchmarks.initBenchmarks();
  provider.initCatalog();
  loadKeybindings();
}
/**
 * The terminal is not a control-plane client, so it is not recorded as one: the
 * client list holds the devices and surfaces that connect to the listener.
 */
export function seedTerminalControlPlane(
  dispatch: DomainDispatch,
  config: Pick<ConfigManager, 'get'>,
): void {
  // The control plane serves this machine whenever the daemon runs;
  // controlPlane.enabled only says whether other machines are served too.
  const enabled = resolveDaemonEnabled(config);
  // The address is the one the platform would bind; nothing has started yet, so the state is not running until the gateway reports it.
  const binding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  dispatch.syncControlPlaneState(
    {
      enabled,
      host: binding.host,
      port: binding.port,
      connectionState: enabled ? 'initializing' : 'disabled',
      isRunning: false,
    },
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

export { createAutomationAgentControls, createAutomationSpawnTask } from '@goodvibes/engine/platform/platform/automation';

/**
 * Local memory consolidation runs only while this process is the memory
 * store's one writer. When the terminal is attached to a daemon, the daemon
 * owns the store and runs its own consolidation; the local registry is only the
 * image loaded at boot, and a local pass over it would write into the daemon's
 * file as a second writer. So while the memory spine routes through the daemon
 * the scheduler is shown an empty store; once the spine returns to local access
 * it reloads the store and consolidation resumes.
 */
export function gateConsolidationToLocalWriter(registry: MemoryRegistry, spine: { readonly active: boolean }): MemoryRegistry {
  return new Proxy(registry, {
    get(target, property) {
      if (property === 'getAll') return () => (spine.active ? [] : target.getAll());
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The control tool is registered with the engine's tools, before the shell's
 * command registry exists. It reads the registry when a model calls it: every
 * non-hidden command with its one-line description, so a command a product
 * adds is listed with no engine change. Until the registry is bound it names
 * none. `panels` is the product's view registry; a product without one passes
 * nothing and the tool says it has no panels.
 */
export function createControlSurfaces<Registry extends { getVisible(): readonly { readonly name: string; readonly description: string }[] }>(
  panels?: () => readonly ControlSurfaceEntry[],
): {
  readonly bindControlCommands: (services: object, registry: Registry) => void;
  readonly controlSurfacesFor: (services: object) => ControlToolOptions;
} {
  const commandRegistries = new WeakMap<object, Registry>();
  return {
    bindControlCommands: (services, registry) => { commandRegistries.set(services, registry); },
    controlSurfacesFor: (services) => ({
      commands: () => (commandRegistries.get(services)?.getVisible() ?? [])
        .map((command) => ({ name: command.name, description: command.description })),
      ...(panels ? { panels } : {}),
    }),
  };
}
