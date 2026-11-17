/**
 * The services a one-shot CLI command reads, built for that command alone.
 *
 * A listing (`providers`, `models`, `subscription`, `sessions`, `tasks`,
 * `bundle export`) needs a handful of stores, not the interactive runtime: no
 * checkpoint repository, decision store, contract runner, scheduler, auth
 * bootstrap or project activation. So nothing here claims the home, writes a
 * `.goodvibes/` tree into the directory the command was typed in, or takes up
 * a contract another process left on disk. Both terminal apps bind these to
 * their own surface root.
 */
import { createProviderStack } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { composeJudgment } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createAsyncDisposalScope } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { createFeatureFlagManager } from '@goodvibes-jev/engine/platform/platform/runtime/feature-flags/manager';
import { deriveFeatureStates } from '@goodvibes-jev/engine/platform/platform/runtime/feature-flags/feature-settings';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell-paths';
import {
  ServiceRegistry,
  SubscriptionManager,
  createRuntimeSecretsManager,
  resolveGoodVibesDaemonHome,
  sharedSubscriptionsPath,
  type ConfigManager,
  type SecretsManager,
} from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderCatalogOptions, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

type ProviderStackServices = ReturnType<typeof createProviderStack>;

/** What a one-shot command needs from the process it runs in. */
export interface OneShotRuntime {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

export interface OneShotProviderServices {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly favoritesStore: ProviderStackServices['favoritesStore'];
  readonly benchmarkStore: ProviderStackServices['benchmarkStore'];
}

export interface OneShotProviderOptions {
  /** `skip` when the command reads no model catalog (a credential listing). */
  readonly modelData?: 'background' | 'skip' | undefined;
  readonly catalog?: ProviderCatalogOptions | undefined;
}

export interface OneShotSessionServices {
  readonly sessionManager: SessionManager;
  readonly shellPaths: ReturnType<typeof createShellPathService>;
  readonly runtimeStore: ReturnType<typeof createRuntimeStore>;
}

export interface OneShotServices {
  /** Providers, models, subscriptions and the support bundle: the credential stores and the stored model catalog. */
  withProviderServices<T>(
    runtime: OneShotRuntime,
    fn: (services: OneShotProviderServices) => Promise<T> | T,
    options?: OneShotProviderOptions,
  ): Promise<T>;
  /** Sessions and tasks: the session store reader. Tasks live in a running host, so a one-shot store is empty. */
  withSessionServices<T>(
    runtime: OneShotRuntime,
    fn: (services: OneShotSessionServices) => Promise<T> | T,
  ): Promise<T>;
}

/** The one-shot service builders for the product whose files live under `surfaceRoot`. */
export function createOneShotServices(surfaceRoot: string): OneShotServices {
  async function withProviderServices<T>(
    runtime: OneShotRuntime,
    fn: (services: OneShotProviderServices) => Promise<T> | T,
    options: OneShotProviderOptions = {},
  ): Promise<T> {
    const { configManager } = runtime;
    const shellPaths = createShellPathService({ workingDirectory: runtime.workingDirectory, homeDirectory: runtime.homeDirectory });
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => configManager.get(key)));
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    const secretsManager = createRuntimeSecretsManager({
      projectRoot: runtime.workingDirectory,
      globalHome: runtime.homeDirectory,
      surfaceRoot,
      configManager,
      daemonHome: resolveGoodVibesDaemonHome(runtime.homeDirectory),
    });
    const subscriptionManager = new SubscriptionManager(sharedSubscriptionsPath(shellPaths), { secrets: secretsManager });
    const serviceRegistry = new ServiceRegistry({
      user: shellPaths.resolveUserPath(surfaceRoot, 'services.json'),
      project: shellPaths.resolveProjectPath(surfaceRoot, 'services.json'),
    }, {
      secretsManager,
      subscriptionManager,
    });
    const scope = createAsyncDisposalScope('one-shot command services');
    let stack: ProviderStackServices | undefined;
    try {
      // The decision model the support bundle and provider setup readings ask. Its
      // decision log lives in this user's home, not in the directory the command
      // was typed in.
      composeJudgment({
        config: configManager,
        secrets: secretsManager,
        env: process.env,
        stateRoot: shellPaths.resolveUserPath(surfaceRoot),
        disposal: scope.registry,
      });
      stack = createProviderStack({
        configManager,
        subscriptionManager,
        secretsManager,
        serviceRegistry,
        featureFlags,
        runtimeBus: new RuntimeEventBus(),
        shellPaths,
        surfaceRoot,
        // The command reads the stored catalog; a discovery pass would outlive it.
        modelDiscovery: 'skip',
        registerDispose: (release) => { scope.registry.add('provider model configuration', release); },
      });
      if (options.modelData !== 'skip') {
        stack.providerRegistry.initModelLimits();
        stack.benchmarkStore.initBenchmarks();
        stack.providerRegistry.initCatalog(options.catalog);
      }
      await stack.providerRegistry.ready();
      // Credentials from the secrets store and subscriptions, so `providers` reports what is configured.
      await stack.providerRegistry.refreshProviderCredentials();
      const result = await fn({
        configManager,
        secretsManager,
        subscriptionManager,
        serviceRegistry,
        providerRegistry: stack.providerRegistry,
        favoritesStore: stack.favoritesStore,
        benchmarkStore: stack.benchmarkStore,
      });
      // A daemon setting the command changed went to the daemon; wait for its
      // answer before this process exits, and say which ones it refused.
      for (const refused of await configManager.settleDaemonWrites()) {
        process.stderr.write(`The daemon refused ${refused.key}; it was not changed: ${summarizeError(refused.error)}\n`);
      }
      return result;
    } finally {
      await stack?.providerRegistry.closeWatching().catch(() => undefined);
      await scope.close();
    }
  }

  async function withSessionServices<T>(
    runtime: OneShotRuntime,
    fn: (services: OneShotSessionServices) => Promise<T> | T,
  ): Promise<T> {
    const shellPaths = createShellPathService({ workingDirectory: runtime.workingDirectory, homeDirectory: runtime.homeDirectory });
    return await fn({
      sessionManager: new SessionManager(runtime.workingDirectory, { surfaceRoot }),
      shellPaths,
      runtimeStore: createRuntimeStore(),
    });
  }

  return { withProviderServices, withSessionServices };
}
