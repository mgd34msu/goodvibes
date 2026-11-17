/**
 * The services a one-shot CLI command reads, built for that command alone.
 *
 * A listing (`providers`, `models`, `subscription`, `sessions`, `tasks`,
 * `bundle export`) needs a handful of stores, not the interactive runtime: no
 * checkpoint repository, decision store, contract runner, scheduler, auth
 * bootstrap or project activation. So nothing here claims the home, writes a
 * `.goodvibes/` tree into the directory the command was typed in, or takes up
 * a contract another process left on disk.
 */
import { createProviderStack } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { composeJudgment } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createAsyncDisposalScope } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { createFeatureFlagManager, deriveFeatureStates } from '@goodvibes-jev/engine/platform/platform/runtime/feature-flags';
import { ServiceRegistry, SubscriptionManager, sharedSubscriptionsPath } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderCatalogOptions, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom, createShellPathService } from '@/runtime/index.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { SecretsManager } from '../config/secrets.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { CliCommandRuntime } from './management.ts';

type ProviderStackServices = ReturnType<typeof createProviderStack>;

export interface OneShotProviderServices {
  readonly configManager: CliCommandRuntime['configManager'];
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly favoritesStore: ProviderStackServices['favoritesStore'];
  readonly benchmarkStore: ProviderStackServices['benchmarkStore'];
}

export interface OneShotProviderOptions {
  /** `skip` when the command reads no model catalog (a credential listing). */
  readonly modelData?: 'background' | 'skip';
  readonly catalog?: ProviderCatalogOptions;
}

/** Providers, models, subscriptions and the support bundle: the credential stores and the stored model catalog. */
export async function withProviderServices<T>(
  runtime: CliCommandRuntime,
  fn: (services: OneShotProviderServices) => Promise<T> | T,
  options: OneShotProviderOptions = {},
): Promise<T> {
  const { configManager } = runtime;
  const shellPaths = createShellPathService({ workingDirectory: runtime.workingDirectory, homeDirectory: runtime.homeDirectory });
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => configManager.get(key)));
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
  const secretsManager = new SecretsManager({
    projectRoot: runtime.workingDirectory,
    globalHome: runtime.homeDirectory,
    configManager,
  });
  const subscriptionManager = new SubscriptionManager(sharedSubscriptionsPath(shellPaths), {
    legacyPath: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'subscriptions.json'),
  });
  const serviceRegistry = new ServiceRegistry({ user: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'services.json'), project: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'services.json') }, {
    secretsManager,
    subscriptionManager,
  });
  const scope = createAsyncDisposalScope('one-shot command services');
  let stack: ReturnType<typeof createProviderStack> | undefined;
  try {
    // The decision model the support bundle and provider setup readings ask. Its
    // decision log lives in this user's Agent home, not in the directory the
    // command was typed in.
    composeJudgment({
      config: configManager,
      secrets: secretsManager,
      env: process.env,
      stateRoot: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
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
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
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
    return await fn({
      configManager,
      secretsManager,
      subscriptionManager,
      serviceRegistry,
      providerRegistry: stack.providerRegistry,
      favoritesStore: stack.favoritesStore,
      benchmarkStore: stack.benchmarkStore,
    });
  } finally {
    await stack?.providerRegistry.closeWatching().catch(() => undefined);
    await scope.close();
  }
}

export interface OneShotSessionServices {
  readonly sessionManager: SessionManager;
  readonly shellPaths: ReturnType<typeof createShellPathService>;
  readonly runtimeStore: ReturnType<typeof createRuntimeStore>;
}

/** Sessions and tasks: the session store reader. Tasks live in a running Agent, so a one-shot store is empty. */
export async function withSessionServices<T>(
  runtime: CliCommandRuntime,
  fn: (services: OneShotSessionServices) => Promise<T> | T,
): Promise<T> {
  const shellPaths = createShellPathService({ workingDirectory: runtime.workingDirectory, homeDirectory: runtime.homeDirectory });
  return fn({
    sessionManager: new SessionManager(runtime.workingDirectory, { surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT }),
    shellPaths,
    runtimeStore: createRuntimeStore(),
  });
}
