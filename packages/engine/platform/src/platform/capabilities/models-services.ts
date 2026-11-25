/**
 * The services the model, provider and services capabilities run with in the
 * daemon (builtin/models.ts, builtin/services.ts), built from the daemon's
 * own provider stack and stores: its provider registry and optimizer, its
 * favourites (pins), its subscription manager and services file, its secret
 * store and its settings. Something the daemon was composed without makes
 * every use of it say so, in one sentence.
 */
import { join, resolve } from 'node:path';
// `shellPaths` is named for where the daemon keeps its files; the providers folder is its settings manager's.
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { ServiceRegistry } from '../config/service-registry.js';
import type { SubscriptionManager } from '../config/subscriptions.js';
import { createProviderApi, type ProviderApiBenchmarkStore, type ProviderApiFavoritesStore } from '../providers/provider-api.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { emitProvidersChanged } from '../runtime/emitters/providers.js';
import { noteListChanged } from '../runtime/list-changes.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { CapabilityRefusal, type CapabilityCaller } from './types.js';
import type { MediaProviderStatusLike, ModelsCapabilityServices } from './builtin/models.js';
import type { ServicesCapabilityServices } from './builtin/services.js';

/** What the daemon hands these capabilities; named as its runtime graph names them. */
export interface ModelsServiceSources {
  readonly configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory' | 'setDynamic'>;
  readonly secretsManager: SecretsManager;
  readonly providerRegistry?: ProviderRegistry | undefined;
  readonly providerOptimizer?: ProviderOptimizer | undefined;
  readonly favoritesStore?: ProviderApiFavoritesStore | undefined;
  readonly benchmarkStore?: ProviderApiBenchmarkStore | undefined;
  readonly subscriptionManager?: SubscriptionManager | undefined;
  readonly serviceRegistry?: ServiceRegistry | undefined;
  readonly mediaProviders?: { status(): Promise<readonly MediaProviderStatusLike[]> } | undefined;
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly shellPaths?: Pick<ShellPathService, 'resolveUserPath'> | undefined;
}

/** A service the daemon was composed without: any use says so. */
function absent<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() { throw new CapabilityRefusal(`This daemon was started without ${what}; nothing was read or changed.`, undefined, 'UNAVAILABLE'); },
  });
}

export function createModelsCapabilityServices(sources: ModelsServiceSources): ModelsCapabilityServices & ServicesCapabilityServices {
  // Every daemon composition hands its whole settings manager (with `set` and the custom providers folder).
  const settings = sources.configManager;
  const registry = sources.providerRegistry;
  const providerApi = registry && sources.favoritesStore && sources.benchmarkStore
    ? createProviderApi({ providerRegistry: registry, favoritesStore: sources.favoritesStore, benchmarkStore: sources.benchmarkStore })
    : absent<ReturnType<typeof createProviderApi>>('its model list');
  const ownServices = sources.serviceRegistry;
  const projects = new Map<string, ServiceRegistry>();
  const workingDirectory = (): string => settings.getWorkingDirectory() ?? process.cwd();
  return {
    models: {
      providerRegistry: registry ?? absent<ProviderRegistry>('its providers'),
      providerApi,
      providerOptimizer: sources.providerOptimizer ?? absent<ProviderOptimizer>('its request routing'),
      subscriptionManager: sources.subscriptionManager ?? absent<SubscriptionManager>('its subscription sign-ins'),
      serviceRegistry: ownServices ?? absent<ServiceRegistry>('its services file'),
      secretsManager: sources.secretsManager,
      // The daemon's own settings manager (its file holds the shared default model, the backups and the routing).
      configManager: settings as unknown as ModelsCapabilityServices['models']['configManager'],
      mediaProviders: sources.mediaProviders ?? absent<{ status(): Promise<readonly MediaProviderStatusLike[]> }>('its media providers'),
      announce: (change) => {
        // Every screen showing the models and providers reads them again (LIST_CHANGED, the place's follow).
        noteListChanged({ list: 'models', change: (change.added?.length ?? 0) > 0 ? 'created' : (change.removed?.length ?? 0) > 0 ? 'deleted' : 'changed' });
        if (!sources.runtimeBus) return;
        emitProvidersChanged(sources.runtimeBus, { sessionId: 'system', traceId: `providers:capability:${Date.now()}`, source: 'capabilities' }, {
          added: [...(change.added ?? [])], removed: [...(change.removed ?? [])], updated: [...(change.updated ?? [])],
        });
      },
    },
    apiServices: {
      workingDirectory,
      forProject(caller: CapabilityCaller): ServiceRegistry {
        if (!ownServices || !sources.subscriptionManager) throw new CapabilityRefusal('This daemon was started without its services file; nothing was read or changed.', undefined, 'UNAVAILABLE');
        const daemonDirectory = settings.getWorkingDirectory();
        const directory = caller.workingDirectory ? resolve(caller.workingDirectory) : undefined;
        if (!directory || (daemonDirectory && resolve(daemonDirectory) === directory && (caller.program ?? 'tui') === 'tui')) return ownServices;
        const program = caller.program ?? 'tui';
        const key = `${program}\u0000${directory}`;
        let found = projects.get(key);
        if (!found) {
          // The daemon's own services file, with the caller's project file as that program reads it (`<project>/.goodvibes/<program>/services.json`).
          found = new ServiceRegistry({ user: ownServices.userServicesFilePath, project: join(directory, '.goodvibes', program, 'services.json') }, {
            secretsManager: sources.secretsManager, subscriptionManager: sources.subscriptionManager,
          });
          // A few projects at most are managed from one daemon; the oldest is let go past that.
          if (projects.size >= 32) projects.delete(projects.keys().next().value!);
          projects.set(key, found);
        }
        return found;
      },
    },
  };
}
