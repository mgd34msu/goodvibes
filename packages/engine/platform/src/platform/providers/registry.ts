import { providerDisplayLabel } from './provider-labels.js';
import { DecisionRouterProvider } from './decision-router.js';
import { installCatalogModelFacts } from './model-catalog-facts.js';
import { isDeepStrictEqual } from 'node:util';
import type { LLMProvider, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps, RegistrableProvider } from './interface.js';
import { ProviderNotFoundError } from './provider-not-found-error.js';
import { snapshotRuntimeMetadataDeps } from './runtime-metadata.js';
import { resolveProviderConfiguredStatus, type ProviderConfiguredStatus } from './configured-status.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { ProviderCapabilityRegistry, type ProviderCapability, type RequestProfile, type RouteExplanation } from './capabilities.js';
import { recordProviderAdapterKind } from './adapter-kind.js';
import type { DiscoveredServer } from '../discovery/scanner.js';
import { createDiscoveredProvider } from './discovered-factory.js';
import { getDiscoveredTraits } from './discovered-traits.js';
import { getConfiguredApiKeys, getConfiguredModelId, resolveApiKeys } from '../config/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitProvidersChanged, emitProviderWarning, emitModelChanged } from '../runtime/emitters/index.js';
import { loadCustomProviders, watchCustomProviders, type CustomProviderFileSkip } from './custom-loader.js';
import { builtinProviderNames } from './provider-names.js';
import { clearProviderHealth, readProviderHealth, type ProviderHealthEntry } from './provider-health.js';
import {
  buildSyntheticCanonicalModels, getCatalogCachePath, getCatalogModelDefinitionsFrom, getCatalogTmpPath, modelCapabilityFactsFromCatalog,
  getCostFromPricingCatalog, getSyntheticBackendModelIds, getSyntheticModelDefinitions, getSyntheticModelInfo,
  type CatalogModel, type CatalogModelPricing, type CatalogProvider, type MinimalModelDefinition, type PricingCatalog,
} from './model-catalog.js';
import {
  buildRegistryModelPricingDeps, cacheRatiosFromCatalog, resolveModelPricing as resolveModelPricingFromDeps,
  type CacheRatio, type ResolvedModelPricing,
} from './model-pricing.js';
import { GatewayPricingService } from './gateway-pricing.js';
import { registerBuiltinProviders, CATALOG_PROVIDER_NAME_ALIASES, CLOUDFLARE_GATEWAY_SETTING_KEYS } from './builtin-registry.js';
import type { CacheHitTracker } from './cache-strategy.js';
import type { ConfigManager } from '../config/manager.js';
import type { SubscriptionManager } from '../config/subscriptions.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { FavoritesStore } from './favorites.js';
import type { BenchmarkStore } from './model-benchmarks.js';
import type { CanonicalModel } from './synthetic.js';
import { LocalContextIngestionService, type LocalContextReadings } from './local-context-ingestion.js';
import { getModelLimitsCachePath, ModelLimitsService } from './model-limits.js';
import { getGitHubCopilotTokenCachePath } from './github-copilot.js';
import { summarizeError } from '../utils/error-display.js';
import { knownFallbackContextWindow } from './context-window-fallback.js';
import { ContextWindowOverrideStore, getContextWindowOverridesPath } from './context-window-overrides.js';
import { CatalogContextWindowResolver } from './context-window-catalog.js';
import { splitModelRegistryKey, withRegistryKey } from './registry-helpers.js';
import { computeConfiguredProviderIds } from './registry-configured-ids.js';
import { initProviderCatalog, refreshProviderCatalog } from './registry-catalog-lifecycle.js';
import { RegistryRoutingReadings } from './registry-routing.js';
import { chooseFailover, readFallbackOrder, type FailoverChoice } from './failover.js';
import type { ModelTierStore } from '../routing/model-tiers.js';
import { buildModelRegistry, diffCustomModels, findModelDefinition, findModelDefinitionForProvider } from './registry-models.js';
import { assertProviderCredentialAuthority } from './credential-authority-contract.js';
import { resolveModelReference } from './model-id-resolution.js';
import { ConfiguredModelFollower } from './registry-configured-model.js';
import { LiveModelListings, type LentModelListings, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { applyProviderNativeModelBaseline, removeProviderNativeModels, StartupModelDiscovery, sweepLiveModelDiscovery } from './registry-live-model-discovery.js';
import type {
  ModelDefinition, ProviderCatalogOptions, ProviderRegistryOptions, RuntimeProviderRegistration, TokenLimits,
} from './registry-types.js';
export type {
  ContextWindowOrigin, ContextWindowProvenance, ModelDefinition, ModelTier, ProviderCatalogOptions, ProviderRegistryOptions, RuntimeProviderRegistration, TokenLimits,
} from './registry-types.js';

/**
 * ProviderRegistry, manages LLM provider instances and model selection.
 * Lazily instantiates providers on first use.
 */
/**
 * `status` names the provider a saved model reference resolves to from
 * builtinProviderNames() without building a registry (provider-names.ts); a
 * builtin added or renamed here without that list would make it answer wrong.
 */
function assertBuiltinProviderNames(registered: Iterable<string>): void {
  const expected = builtinProviderNames();
  const actual = new Set(registered);
  const missing = [...actual].filter((name) => !expected.has(name));
  const extra = [...expected].filter((name) => !actual.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`provider-names.ts does not list the built-in providers: not listed ${missing.join(', ') || 'none'}; listed but not registered ${extra.join(', ') || 'none'}.`);
  }
}

/** Model registry and catalog lookups by id, for pricing. */
interface PricingIndex {
  readonly registry: readonly ModelDefinition[];
  readonly catalog: readonly CatalogModel[];
  readonly definitions: ReadonlyMap<string, ModelDefinition>;
  readonly definitionsById: ReadonlyMap<string, ModelDefinition>;
  readonly catalogById: ReadonlyMap<string, readonly CatalogModel[]>;
  readonly catalogProviderIds: ReadonlySet<string>;
}

/** What one custom-provider load reports: its warnings and the model names it added, removed or changed. */
interface CustomProviderLoadResult {
  warnings: string[];
  added: string[];
  removed: string[];
  updated: string[];
}

export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private currentModelRegistryKey: string;
  private readonly configuredModel: ConfiguredModelFollower; // live `provider.model` view, re-read at use time
  private discoveredProviderNames: Set<string> = new Set();
  /** The servers the last registerDiscoveredProviders call was given, verbatim. */
  private discoveredServers: readonly DiscoveredServer[] = [];
  private runtimeProviderNames: Set<string> = new Set();
  private liveModelDiscoveryTail: Promise<void> = Promise.resolve();
  /**
   * Providers the custom-provider loader put in `providers`, by name. A reload
   * that no longer lists a name removes it.
   */
  private customProviderNames: Set<string> = new Set();
  /** Each custom provider's `displayName`, by provider name; a model reference may name a provider by it. */
  private customProviderDisplayNames: Map<string, string> = new Map();
  /** How many times registerDiscoveredProviders ran; a restore from the scan cache yields to a newer registration. */
  private discoveredRegistrations = 0;
  /** Registries that hold this one's discovered servers (lendDiscoveredServers), given each new registration as it happens. */
  private readonly discoveryBorrowers = new Set<ProviderRegistry>();
  /**
   * The API key each builtin was last built with, by provider id (the same
   * names `apiKey(name)` is asked for). A credential refresh rebuilds only the
   * providers whose entry changed.
   */
  private builtinKeys: Readonly<Record<string, string>> = {};
  private customModels: ModelDefinition[] = [];
  private runtimeModels: ModelDefinition[] = [];
  private discoveredModels: ModelDefinition[] = [];
  /** Provider-sourced models, see registry-live-model-discovery.ts. */
  private providerNativeModels: ModelDefinition[] = [];
  private readonly runtimeCatalogSuppressedRegistryKeys = new Map<string, readonly string[]>();
  private _watcher: ReturnType<typeof watchCustomProviders> | undefined;
  private readonly _watcherDrains = new Set<Promise<void>>();
  private _watcherFailed = false;
  private _watcherGeneration = 0;
  private _watchingClosed: Promise<void> | undefined;
  private _readyPromise: Promise<void> | null = null;
  private readonly startupDiscovery = new StartupModelDiscovery();
  /** Every listing this registry's refreshes take, for a second registry to borrow (LiveModelListings). */
  private readonly ownModelListings = new LiveModelListings();
  /** A host registry's listings this one takes instead (ProviderRegistryOptions.liveModelListings). */
  private readonly hostModelListings: LentModelListings | null;
  private readonly configManager: ProviderRegistryOptions['configManager'];
  private readonly subscriptionManager: Pick<SubscriptionManager, 'get' | 'getPending' | 'saveSubscription' | 'resolveAccessToken'>;
  private readonly capabilityRegistry: ProviderCapabilityRegistry;
  private readonly cacheHitTracker: CacheHitTracker;
  private readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;
  private readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  private readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks' | 'getKnownBenchmarks' | 'readBenchmarks' | 'getTopBenchmarkModelIds' | 'benchmarksSettled'>;
  private readonly modelLimitsService: ModelLimitsService;
  private readonly gatewayPricing: GatewayPricingService;
  private readonly runtimeMetadataDeps: ProviderRuntimeMetadataDeps;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly localContextIngestionService: LocalContextReadings;
  /** What `localContextReadings` lends: its own service's lending view, or the host's view it was given. */
  private readonly lendableContextReadings: LocalContextReadings;
  private catalogModels: CatalogModel[] = [];
  private pricingCatalog: PricingCatalog | null = null;
  private syntheticCanonicalModels: CanonicalModel[] = [];
  private readonly routingReadings = new RegistryRoutingReadings({ root: () => this.getPersistenceRoot() });
  private _cachedModelRegistry: ModelDefinition[] | null = null;
  private _modelRegistryRevision = 0;
  /** Persisted per-model context-window overrides; lazy-constructed (needs persistence root). */
  private _contextWindowOverrideStore: ContextWindowOverrideStore | null = null;
  private readonly catalogWindows = new CatalogContextWindowResolver(
    () => this.catalogModels,
    (name) => this.discoveredProviderNames.has(name),
    (name) => this.providers.get(name),
    CATALOG_PROVIDER_NAME_ALIASES,
    (providerId, modelId) => {
      // One completed reading changes one window, not the entire registry.
      // Rebuilding every model here made the next keystroke repeat catalog work.
      if (this._cachedModelRegistry === null) return;
      let changed = false;
      const updated = this._cachedModelRegistry.map((model) => {
        if (model.provider !== providerId || model.id !== modelId) return model;
        const resolved = this.contextWindowOverrideStore().apply(this.catalogWindows.apply(model));
        // A completed identity lookup may leave the same fallback window.
        // Keep the catalog incarnation when no published model fact changed.
        if (isDeepStrictEqual(model, resolved)) return model;
        changed = true;
        return resolved;
      });
      if (changed) {
        this._cachedModelRegistry = updated;
        this._modelRegistryRevision++;
      }
    },
  );

  constructor(options: ProviderRegistryOptions) {
    this.configManager = options.configManager;
    this.subscriptionManager = options.subscriptionManager;
    this.capabilityRegistry = options.capabilityRegistry;
    this.cacheHitTracker = options.cacheHitTracker;
    this.favoritesStore = options.favoritesStore;
    this.benchmarkStore = options.benchmarkStore;
    if (options.localContextIngestion) {
      this.localContextIngestionService = options.localContextIngestion;
      this.lendableContextReadings = options.localContextIngestion;
    } else {
      const ownContextReadings = new LocalContextIngestionService();
      this.localContextIngestionService = ownContextReadings;
      this.lendableContextReadings = ownContextReadings.lend();
    }
    this.hostModelListings = options.liveModelListings ?? null;
    this.modelLimitsService = options.modelLimitsService
      ?? new ModelLimitsService({ cachePath: getModelLimitsCachePath(this.getPersistenceRoot()) });
    this.gatewayPricing = new GatewayPricingService({ cacheDir: this.getPersistenceRoot() });
    this.runtimeMetadataDeps = {
      secretsManager: options.secretsManager, serviceRegistry: options.serviceRegistry, subscriptionManager: options.subscriptionManager,
    };
    this.featureFlags = options.featureFlags ?? null;
    this.runtimeBus = options.runtimeBus ?? null;
    this.registerBuiltins(); // builtins register BEFORE the configured model is read: a bare id resolves against the real registry
    this.configuredModel = new ConfiguredModelFollower({
      readConfiguredModel: () => getConfiguredModelId(this.configManager),
      listModelCandidates: () => this.listModels().map((m) => ({ id: m.id, provider: m.provider, registryKey: m.registryKey })),
      runtimeBus: this.runtimeBus,
    });
    this.currentModelRegistryKey = this.configuredModel.initialRegistryKey();
    const stopModelConfiguration = this.configManager.subscribe?.('provider.model', () => {
      this.configuredModel.configurationChanged();
      this._modelRegistryRevision += 1;
    });
    if (stopModelConfiguration) {
      try { options.registerDispose?.(stopModelConfiguration); }
      catch (error) { stopModelConfiguration(); throw error; }
    }
    // The Cloudflare AI Gateway's URL is built from these settings; a change rebuilds that one provider at once.
    for (const key of CLOUDFLARE_GATEWAY_SETTING_KEYS) {
      const stop = this.configManager.subscribe?.(key, () => this.rebuildBuiltins(new Set(['cloudflare-ai-gateway'])));
      if (!stop) continue;
      try { options.registerDispose?.(stop); }
      catch (error) { stop(); throw error; }
    }
  }

  /**
   * Construction registers every builtin with the environment's keys. A
   * credential refresh passes the resolved keys and the provider ids whose key
   * changed: only those are rebuilt and replaced, so every other provider keeps
   * its live model list, its Gemini tool-loop signatures, its warm caches and
   * its exchanged sessions.
   */
  private registerBuiltins(refresh?: { readonly keys: Readonly<Record<string, string>>; readonly changed: ReadonlySet<string> }): void {
    if (!refresh) this.builtinKeys = getConfiguredApiKeys();
    const keys = this.builtinKeys;
    const apiKey = (name: string): string => keys[name] ?? '';
    // A plugin's runtime provider under a builtin's name stays in place.
    const replaceChanged = (provider: RegistrableProvider): void => {
      if (refresh?.changed.has(provider.name) && !this.runtimeProviderNames.has(provider.name)) this.register(provider);
    };
    const registrar = refresh ? { register(provider: RegistrableProvider): void { replaceChanged(provider); } } : this;
    // The compat loop builds a provider only when this says it is missing.
    const hasProvider = refresh ? (name: string) => !refresh.changed.has(name) : (name: string) => this.providers.has(name);
    registerBuiltinProviders(registrar, hasProvider, apiKey, {
      cacheHitTracker: this.cacheHitTracker,
      resolveProvider: (providerName) => this.require(providerName),
      getCatalogModels: () => this.syntheticCanonicalModels,
      getBenchmarks: (modelId) => this.benchmarkStore.getKnownBenchmarks(modelId),
      githubCopilotTokenCachePath: getGitHubCopilotTokenCachePath(this.getPersistenceRoot()),
      subscriptionManager: this.subscriptionManager,
      runtimeBus: this.runtimeBus,
      persistenceRoot: this.getPersistenceRoot(),
      cachePolicy: this.configManager, // cache.enabled / cache.stableTtl, read per request like their hit-rate siblings
      settings: this.configManager, // cloudflare.accountId and cloudflare.aiGatewayId for the Cloudflare AI Gateway base URL
      refreshModels: (providerId) => this.refreshModelsSoon(providerId),
    });
    if (!this.providers.has('decision-router')) this.register(new DecisionRouterProvider({
      settings: () => this.configManager.get('provider.decisionRouter'),
      resolveTarget: target => {
        const definition = findModelDefinitionForProvider(target.model, target.provider, this.getModelRegistry(), CATALOG_PROVIDER_NAME_ALIASES);
        if (!definition) throw new Error(`No model '${target.model}' for Decision Router provider '${target.provider}'.`);
        const provider = this.getForModel(definition.registryKey, target.provider);
        return { provider, model: { ...definition, provider: provider.name, registryKey: `${provider.name}:${definition.id}` } };
      },
    }));
    if (!refresh) assertBuiltinProviderNames(this.providers.keys());
  }

  /**
   * Live credential refresh: re-resolves every builtin key (env -> secrets
   * store) and replaces only the builtins whose key changed, so a key written
   * to the secrets store is usable in the SAME process and an unrelated secret
   * change replaces nothing. Runs at boot and on secrets changes.
   */
  async refreshProviderCredentials(): Promise<void> {
    // One refresh at a time, in call order: each reads the stores after the
    // previous one applied, so the last change is the one read last.
    const run = (): Promise<void> => this.applyResolvedCredentials();
    const result = this.credentialRefreshTail.then(run, run);
    this.credentialRefreshTail = result.then(() => undefined, () => undefined);
    this._credentialsResolved ??= this.credentialRefreshTail;
    return result;
  }

  private credentialRefreshTail: Promise<void> = Promise.resolve();

  /** Settled once the first credential refresh has run (the boot one); resolved, never rejected. */
  private _credentialsResolved: Promise<void> | null = null;

  /**
   * Resolves once every builtin carries the key a request would send: the
   * environment and every secret store the turn reads, applied by the first
   * credential refresh. Waits for the boot refresh when one started; starts
   * one when none did. Never rejects: a failed refresh leaves the environment's keys.
   */
  credentialsResolved(): Promise<void> {
    return this._credentialsResolved ?? this.refreshProviderCredentials().then(() => undefined, () => undefined);
  }

  private async applyResolvedCredentials(): Promise<void> {
    const resolved = await resolveApiKeys(this.runtimeMetadataDeps.secretsManager);
    const previous = this.builtinKeys;
    const changed = new Set<string>();
    for (const name of new Set([...Object.keys(previous), ...Object.keys(resolved)])) {
      if ((previous[name] ?? '') !== (resolved[name] ?? '')) changed.add(name);
    }
    if (changed.size === 0) return;
    this.builtinKeys = { ...resolved };
    this.rebuildBuiltins(changed);
  }

  /** Replace the named builtins with ones built from the current keys and settings, and announce the change. */
  private rebuildBuiltins(changed: ReadonlySet<string>): void {
    this.registerBuiltins({ keys: this.builtinKeys, changed });
    // Which failover groups have a callable backend follows the keys.
    this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels, this.catalogProviderUsable);
    this._invalidateModelRegistry();
    const updated = [...changed].filter((name) => this.providers.has(name));
    if (this.runtimeBus && updated.length > 0) {
      emitProvidersChanged(this.runtimeBus, { sessionId: 'system', traceId: `providers:credentials:${Date.now()}`, source: 'provider-registry' }, { added: [], removed: [], updated });
    }
  }

  /** When each provider's list was last read again because an endpoint refused a model as unknown. */
  private readonly unknownModelRefreshes = new Map<string, number>();

  /**
   * Read one provider's model list again, in the background, after its
   * endpoint refused a model as unknown: at most once a minute per provider,
   * so a run of refusals costs one listing, and never on the request's path.
   */
  private refreshModelsSoon(providerId: string): void {
    const now = Date.now();
    if (now - (this.unknownModelRefreshes.get(providerId) ?? 0) < 60_000) return;
    this.unknownModelRefreshes.set(providerId, now);
    void this.refreshLiveModelDiscovery(providerId, { force: true }).catch((error: unknown) => {
      logger.warn('[providers] model list refresh after an unknown-model refusal failed', { providerId, error: summarizeError(error) });
    });
  }

  /**
   * A subscription sign-in of `provider` started, changed or ended in this
   * process: what reads it (configured state, the sign-in order, prices) is
   * recomputed, and the provider's model list is read again in the background
   * (a new account's list is fetched; the stored one belonged to another).
   */
  noteSignInChanged(provider: string): void {
    this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels, this.catalogProviderUsable);
    this._invalidateModelRegistry();
    if (!this.providers.has(provider)) return;
    void this.refreshLiveModelDiscovery(provider).catch((error: unknown) => {
      logger.warn('[providers] model list refresh after a sign-in change failed', { provider, error: summarizeError(error) });
    });
    if (this.runtimeBus) {
      emitProvidersChanged(this.runtimeBus, { sessionId: 'system', traceId: `providers:sign-in:${Date.now()}`, source: 'provider-registry' }, { added: [], removed: [], updated: [provider] });
    }
  }

  /** Release what providers hold outside this process (Gemini's server-side cache resources). Call once at shutdown. */
  async disposeProviders(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => disposeProvider(provider)));
  }

  private getPersistenceRoot(): string {
    return this.configManager.getControlPlaneConfigDir();
  }

  private getCustomProvidersDir(): string {
    return join(this.getPersistenceRoot(), 'providers');
  }

  private getCatalogCachePaths(): { cachePath: string; tmpPath: string } {
    const root = this.getPersistenceRoot();
    return { cachePath: getCatalogCachePath(root), tmpPath: getCatalogTmpPath(root) };
  }

  /**
   * The catalog's rows as model definitions. A catalog provider that is one
   * sign-in of a registered provider (`openai-codex`, OpenAI on a ChatGPT
   * plan) lists the same models as that provider: its rows are folded into
   * the provider's own, so each model is listed once per maker.
   */
  private getCatalogBuiltins(): ModelDefinition[] {
    return (getCatalogModelDefinitionsFrom(this.catalogModels, this.routingReadings.tiers) as ModelDefinition[])
      .filter((model) => !SIGN_IN_CATALOG_IDS.has(model.provider));
  }

  private getSyntheticBuiltins(): ModelDefinition[] { return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels) as ModelDefinition[]; }

  private updateCatalogState(models: readonly CatalogModel[], fetchedAt = Date.now()): void {
    this.catalogModels = [...models];
    installCatalogModelFacts(this.catalogModels);
    this.pricingCatalog = { fetchedAt, models: this.catalogModels };
    this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels, this.catalogProviderUsable);
    this.capabilityRegistry.setModelFactsSource(modelCapabilityFactsFromCatalog(this.catalogModels));
    this._invalidateModelRegistry();
  }

  /** A catalog provider can be called when a provider answers for it and says it is configured (environment or stored key). */
  private readonly catalogProviderUsable = (providerId: string): boolean => {
    const provider = this.tryGet(providerId);
    return provider !== undefined && (provider.isConfigured?.() ?? true);
  };

  private getSuppressedCatalogModelRegistryKeys(): Set<string> {
    return new Set([...this.runtimeCatalogSuppressedRegistryKeys.values()].flat());
  }

  /** Value-free registration/catalog incarnation for owned asynchronous proposal work. */
  getModelRegistryRevision(): number { return this._modelRegistryRevision; }

  private _invalidateModelRegistry(): void {
    this._cachedModelRegistry = null;
    this._modelRegistryRevision++;
  }

  private getModelRegistry(): ModelDefinition[] {
    if (this._cachedModelRegistry !== null) return this._cachedModelRegistry;
    // One read of the overrides file for the whole list, not one stat per model.
    const applyOverrides = this.contextWindowOverrideStore().snapshot();
    this._cachedModelRegistry = buildModelRegistry({
      customModels: this.customModels,
      runtimeModels: this.runtimeModels,
      providerNativeModels: this.providerNativeModels,
      syntheticModels: this.getSyntheticBuiltins(),
      catalogModels: this.getCatalogBuiltins(),
      discoveredModels: this.discoveredModels,
      suppressedCatalogRegistryKeys: this.getSuppressedCatalogModelRegistryKeys(),
    }).map((model) => applyOverrides(this.catalogWindows.apply(model)));
    return this._cachedModelRegistry;
  }

  private contextWindowOverrideStore(): ContextWindowOverrideStore {
    this._contextWindowOverrideStore ??= new ContextWindowOverrideStore(
      getContextWindowOverridesPath(this.getPersistenceRoot()),
    );
    return this._contextWindowOverrideStore;
  }

  /**
   * Register a provider. Overwrites any existing entry with the same name. The
   * type requires a declared model source; the credential authority is checked
   * at admission.
   */
  register(provider: RegistrableProvider): void {
    this.admit(provider, { nativeModels: true });
    this._invalidateModelRegistry();
  }

  /**
   * The one way into `providers`, shared by builtin, custom, runtime and
   * discovered registration: the credential authority is checked, the adapter
   * kind recorded, the provider's own model list seeded (unless the caller
   * lists its models itself) and a replaced provider disposed.
   */
  private admit(provider: LLMProvider, options: { readonly nativeModels: boolean }): void {
    assertProviderCredentialAuthority(provider);
    const replaced = this.providers.get(provider.name);
    this.providers.set(provider.name, provider);
    // A new registration (credentials, endpoint) is not judged by the old one's failures.
    if (replaced !== provider) clearProviderHealth(provider.name);
    recordProviderAdapterKind(provider);
    this.providerNativeModels = options.nativeModels
      ? applyProviderNativeModelBaseline(this.providerNativeModels, provider)
      : removeProviderNativeModels(this.providerNativeModels, provider.name);
    if (replaced && replaced !== provider) void disposeProvider(replaced);
  }

  private readonly liveDiscoveryParticipants = new Set<() => void>();

  /**
   * Run `participant`, without waiting for it, at each live re-check: the
   * moment a picker opens or a model list is read. A host adds its scan for
   * model servers on its own computer here, so one started after the host is
   * listed without a restart. Returns its removal.
   */
  addLiveDiscoveryParticipant(participant: () => void): () => void {
    this.liveDiscoveryParticipants.add(participant);
    return () => { this.liveDiscoveryParticipants.delete(participant); };
  }

  /** The picker-open re-check hook (see registry-live-model-discovery.ts): force bypasses each provider's TTL cache. */
  async refreshLiveModelDiscovery(
    providerId?: string,
    options: { force?: boolean } = {},
  ): Promise<Array<{ providerId: string } & LiveModelDiscoveryResult>> {
    for (const participant of [...this.liveDiscoveryParticipants]) {
      try { participant(); } catch (error) {
        logger.warn('ProviderRegistry: a live discovery participant failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    // Sweeps run one after another so two overlapping calls cannot finish out of
    // order and leave the older answer in place.
    const run = async () => {
      const { providerNativeModels, reports } = await sweepLiveModelDiscovery(
        this.providers.values(),
        () => this.providerNativeModels,
        providerId,
        {
          ...options,
          isRegistered: (name) => this.providers.has(name),
          // A borrower takes the host's listings and records none: the host's store holds only what the host read.
          ...(this.hostModelListings ? { borrowFrom: this.hostModelListings.listings } : { recordTo: this.ownModelListings }),
        },
      );
      this.providerNativeModels = providerNativeModels;
      if (reports.length > 0) { this._invalidateModelRegistry(); }
      return reports;
    };
    const result = this.liveModelDiscoveryTail.then(run, run);
    this.liveModelDiscoveryTail = result.then(() => undefined, () => undefined);
    const reports = await result;
    return reports;
  }

  /**
   * List a model of an already registered provider before any listing names it
   * (fallback-model.ts). Only the model is added: the provider keeps its owner,
   * so a builtin stays on the credential chain and a key from the secret store
   * still reaches it. A no-op for an unregistered provider or a listed model.
   */
  addFallbackModel(model: ModelDefinition): void {
    const provider = this.tryGet(model.provider);
    if (!provider) return;
    const registryKey = model.registryKey || `${model.provider}:${model.id}`;
    if (this.runtimeModels.some((entry) => entry.registryKey === registryKey)) return;
    this.runtimeModels = [...this.runtimeModels, withRegistryKey({ ...model, provider: provider.name, registryKey })];
    this.capabilityRegistry.invalidate();
    this._invalidateModelRegistry();
  }

  /** Register a runtime/plugin-owned provider + optional models; returns an unregister callback. */
  registerRuntimeProvider(registration: RuntimeProviderRegistration): () => void {
    const { provider, models = [], suppressCatalogModelRegistryKeys = [], replace = false, appendModels = false } = registration;
    if (this.providers.has(provider.name) && !this.runtimeProviderNames.has(provider.name) && !replace) {
      throw new Error(`Provider '${provider.name}' is already registered.`);
    }
    // A plugin's models are the explicit `models` list below (this.runtimeModels);
    // the provider's own list is seeded too when it declares a model source.
    this.admit(provider, { nativeModels: true });
    this.runtimeProviderNames.add(provider.name);
    const incoming = models.map((model) => withRegistryKey({
      ...model,
      provider: provider.name,
      registryKey: model.registryKey || `${provider.name}:${model.id}`,
    }));
    const incomingKeys = new Set(incoming.map((model) => model.registryKey));
    this.runtimeModels = [
      ...this.runtimeModels.filter((model) => appendModels
        ? !incomingKeys.has(model.registryKey)
        : model.provider !== provider.name),
      ...incoming,
    ];
    const keptSuppressions = appendModels ? this.runtimeCatalogSuppressedRegistryKeys.get(provider.name) ?? [] : [];
    this.runtimeCatalogSuppressedRegistryKeys.set(provider.name, [...new Set([...keptSuppressions, ...suppressCatalogModelRegistryKeys])]);
    this.capabilityRegistry.invalidate();
    this._invalidateModelRegistry();
    return () => {
      // Only the registration that is still live may remove it: a later
      // registration under the same name (a replace) belongs to its own owner.
      if (this.providers.get(provider.name) !== provider || !this.runtimeProviderNames.has(provider.name)) return;
      this.providers.delete(provider.name);
      this.runtimeProviderNames.delete(provider.name);
      this.runtimeModels = this.runtimeModels.filter((model) => model.provider !== provider.name);
      this.providerNativeModels = removeProviderNativeModels(this.providerNativeModels, provider.name);
      recordProviderAdapterKind({ name: provider.name });
      this.runtimeCatalogSuppressedRegistryKeys.delete(provider.name);
      this.capabilityRegistry.invalidate();
      this._invalidateModelRegistry();
    };
  }

  /**
   * The locally discovered servers this registry currently holds.
   *
   * Exposed because a process may build a SECOND registry that has to see the
   * same local models, the daemon composes one per hosted-session workspace,
   * and without this the machine's own Ollama or LM Studio would be routable
   * for the daemon's agents and invisible to a hosted session on the same box.
   * Returns what was registered, so a caller re-registers the same servers
   * rather than reconstructing them from provider objects.
   * This privileged in-process getter includes raw routing URLs, which may
   * contain private data. It is not a redacted catalog or wire projection.
   */
  listDiscoveredServers(): readonly DiscoveredServer[] {
    return this.discoveredServers;
  }

  /**
   * Keep `borrower`'s discovered servers the same as this registry's: now, and
   * at every later registration (a scan that finds a model server started after
   * the borrower was built). The daemon lends its discoveries to each hosted
   * workspace's registry, so a model the daemon lists is one a live floor can
   * run. Returns the call that stops lending (the floor closing).
   */
  lendDiscoveredServers(borrower: ProviderRegistry): () => void {
    if (borrower === this) throw new Error('A provider registry cannot borrow its own discoveries');
    this.discoveryBorrowers.add(borrower);
    if (this.discoveredServers.length > 0) borrower.registerDiscoveredProviders([...this.discoveredServers]);
    return () => { this.discoveryBorrowers.delete(borrower); };
  }

  listProviders(): readonly LLMProvider[] {
    return [...this.providers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Register providers discovered by the local LLM scanner.
   * Clears previously discovered providers before re-registering.
   * Does not overwrite built-in or custom-loaded providers/models.
   */
  registerDiscoveredProviders(servers: DiscoveredServer[]): void {
    this.discoveredRegistrations += 1;
    this.discoveredServers = [...servers];
    for (const borrower of this.discoveryBorrowers) borrower.registerDiscoveredProviders([...servers]);
    // Unregister previously discovered providers
    for (const name of this.discoveredProviderNames) {
      this.providers.delete(name);
      recordProviderAdapterKind({ name });
    }
    this.discoveredProviderNames.clear();
    this.discoveredModels = [];
    for (const server of servers) {
      // Skip if a non-discovered provider already holds this name
      if (this.providers.has(server.name)) continue;
      // Skip servers with no models, defaultModel would be undefined
      if (server.models.length === 0) continue;

      const traits = getDiscoveredTraits(server.serverType);
      // The scanner's answer carries each model's window and output limit, so
      // its definitions below are the model list, not the provider's own.
      this.admit(createDiscoveredProvider(server), { nativeModels: false });
      this.discoveredProviderNames.add(server.name);

      for (const modelId of server.models) {
        this.discoveredModels.push({
          id: modelId,
          provider: server.name,
          registryKey: `${server.name}:${modelId}`,
          displayName: modelId,
          description: `Discovered ${server.serverType} model`,
          capabilities: traits.modelCapabilities,
          ...(traits.reasoningEffort ? { reasoningEffort: traits.reasoningEffort } : {}),
          contextWindow: server.modelContextWindows?.[modelId] ?? 8192,
          ...(server.modelContextWindows?.[modelId] != null
            ? { contextWindowProvenance: 'provider_api' as const }
            : { contextWindowProvenance: 'fallback' as const }),
          ...(server.modelOutputLimits?.[modelId] != null
            ? { tokenLimits: { maxOutputTokens: server.modelOutputLimits[modelId] } }
            : {}),
          selectable: true,
          tier: 'standard',
        });
      }
    }
    this._invalidateModelRegistry();
  }

  /**
   * Returns `true` if a provider with the given name (or its catalog alias) is registered.
   *
   * @param id - Provider name as registered (e.g. `'anthropic'`, `'openai'`).
   */
  has(id: string): boolean {
    if (this.providers.has(id)) return true;
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[id]!;
    return aliased !== undefined && this.providers.has(aliased);
  }

  /**
   * Retrieve a provider by name (or its catalog alias).
   * Throws a {@link ProviderNotFoundError} if no provider with that name is registered.
   *
   * The error message includes the list of all currently registered provider IDs
   * to aid discoverability.
   *
   * @param id - Provider name as registered (e.g. `'anthropic'`, `'openai'`).
   * @throws {ProviderNotFoundError} When no matching provider is registered.
   */
  require(id: string): LLMProvider {
    const provider = this.tryGet(id);
    if (provider) return provider;
    const available = [...this.providers.keys()].sort();
    throw new ProviderNotFoundError(id, available);
  }

  /**
   * Retrieve the provider registered under a name (or its catalog alias).
   * Returns `undefined` if no provider with that name (or its catalog alias) is registered.
   *
   * Prefer {@link require} when you know the provider must exist and want a clear
   * error when it does not.
   *
   * @param name - Provider name as registered (e.g. `'anthropic'`, `'openai'`).
   */
  tryGet(name: string): LLMProvider | undefined {
    const p = this.providers.get(name);
    if (p) return p;
    // Check alias map. The catalog may use a different name than the registered provider
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[name]!;
    if (aliased) {
      const pa = this.providers.get(aliased);
      if (pa) return pa;
    }
    return undefined;
  }

  get(name: string): LLMProvider | undefined {
    return this.tryGet(name);
  }

  /**
   * Retrieve the directly-registered provider. Throws if no provider with that
   * name (or its catalog alias) is registered.
   */
  getRegistered(name: string): LLMProvider {
    const p = this.providers.get(name);
    if (p) return p;
    // Check alias map. The catalog may use a different name than the registered provider
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[name]!;
    if (aliased) {
      const pa = this.providers.get(aliased);
      if (pa) return pa;
    }
    throw new ProviderNotFoundError(name, [...this.providers.keys()].sort());
  }

  /**
   * A provider's runtime metadata. A listing passes one `runtimeMetadataSnapshot()`
   * to every call so the stores are read once for all providers.
   */
  async describeRuntime(name: string, deps: ProviderRuntimeMetadataDeps = this.runtimeMetadataDeps): Promise<ProviderRuntimeMetadata | null> {
    const provider = this.getRegistered(name);
    if (!provider.describeRuntime) return null;
    return await provider.describeRuntime(deps);
  }

  /** One reading of the secret, service and subscription stores, shared by every provider of one listing. */
  runtimeMetadataSnapshot(): ProviderRuntimeMetadataDeps {
    return snapshotRuntimeMetadataDeps(this.runtimeMetadataDeps);
  }

  /**
   * Whether each provider is set up and by what means: the one answer for the
   * model picker, the current-model read and the model switch. The stores are
   * read once for the whole list.
   */
  async describeConfiguredProviders(providerIds: readonly string[]): Promise<ReadonlyMap<string, ProviderConfiguredStatus>> {
    const snapshot = this.runtimeMetadataSnapshot();
    const configuredIds = new Set(this.getConfiguredProviderIds());
    const storedKeys = new Set((await snapshot.secretsManager.listDetailed())
      .filter((record) => record.source !== 'env').map((record) => record.key));
    const entries = await Promise.all([...new Set(providerIds)].map(async (providerId) => {
      let runtime: ProviderRuntimeMetadata | null | undefined;
      try {
        runtime = await this.describeRuntime(providerId, snapshot);
      } catch (error) {
        // Not registered (a catalog-only provider) or its metadata failed: judged by the environment and the stores.
        if (!(error instanceof ProviderNotFoundError)) {
          logger.warn('[providers] Failed to read provider runtime metadata', { providerId, error: summarizeError(error) });
        }
        runtime = undefined;
      }
      return [providerId, resolveProviderConfiguredStatus({
        providerId, runtime, storedKeys, selfConfigured: configuredIds.has(providerId),
      })] as const;
    }));
    return new Map(entries);
  }

  /** Return the provider responsible for a model, a registryKey, or a bare id resolved via the shared resolver. */
  getForModel(modelId: string, provider?: string): LLMProvider {
    const registry = this.getModelRegistry();
    // findModelDefinitionForProvider already resolves bare ids when a provider is given.
    const resolvedModelId = !provider ? resolveModelReference(modelId, registry) : modelId;
    const def = provider
      ? findModelDefinitionForProvider(resolvedModelId, provider, registry, CATALOG_PROVIDER_NAME_ALIASES)
      : findModelDefinition(resolvedModelId, registry);
    if (!def) {
      // A model of a provider that is not registered: say so, and how to choose another.
      const named = provider ?? (modelId.includes(':') ? modelId.slice(0, modelId.indexOf(':')) : undefined);
      if (named !== undefined && this.resolveProviderReference(named) === undefined) {
        throw new Error(this.unregisteredModelMessage(provider && !modelId.startsWith(`${provider}:`) ? `${provider}:${modelId}` : modelId));
      }
      if (provider) throw new Error(`No model '${modelId}' for provider '${provider}' in registry.`);
      throw new Error(`No model '${modelId}' in registry.`);
    }
    return this.require(provider ?? def.provider);
  }

  /** All registered model definitions. */
  listModels(): ModelDefinition[] {
    return this.getModelRegistry();
  }

  /** Host-owned complete ID inventory for browser catalog alignment; no provider/model values leave this boundary. */
  captureProviderCatalogIds(): {
    readonly providerIds: readonly string[];
    readonly catalogProviderIds: readonly string[];
    readonly assertCurrent: () => void;
  } {
    const models = this.listModels();
    const revision = this._modelRegistryRevision;
    const providers = [...this.providers.entries()];
    const readProviderId = (model: ModelDefinition): string => {
      const descriptor = Object.getOwnPropertyDescriptor(model, 'provider');
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
        throw new Error('Provider catalog source unavailable.');
      }
      return descriptor.value;
    };
    const modelOwners = [...models];
    const modelProviderIds = modelOwners.map(readProviderId);
    const catalogProviderIds = Object.freeze([...new Set(modelProviderIds)]);
    const providerIds = Object.freeze([...new Set([...providers.map(([id]) => id), ...catalogProviderIds])]);
    return { providerIds, catalogProviderIds, assertCurrent: () => {
      if (this._modelRegistryRevision !== revision || this.listModels() !== models || this.providers.size !== providers.length
        || providers.some(([id, owner]) => this.providers.get(id) !== owner)
        || models.length !== modelProviderIds.length || models.some((model, index) => model !== modelOwners[index] || readProviderId(model) !== modelProviderIds[index])) {
        throw new Error('Provider catalog source changed.');
      }
    } };
  }

  /** Legacy string-keyed catalog lookup, null when unpriced. Prefer resolveModelPricing. */
  getCostFromCatalog(modelId: string): CatalogModelPricing | null {
    return getCostFromPricingCatalog(modelId, this.pricingCatalog ?? { fetchedAt: Date.now(), models: this.catalogModels }, this.modelLimitsService);
  }

  /**
   * ONE pricing resolution per (provider, model): manual config price ('user')
   * -> registration price ('user') -> provider-served ('provider', dated) ->
   * catalog ('catalog', dated) -> subscription -> honest unknown (never $0).
   * Manual prices are read live on every call, no restart.
   *
   * `signInRoute` is the sign-in that served the request being priced, as its
   * response reports it (`ChatResponse.signInRoute.route`): a request is priced
   * by its own route, never by whichever route last answered the same model
   * (another request, running at the same time, may have moved it). Only a
   * caller with no response (a restored transcript, a quote) leaves it out and
   * gets the provider's current route.
   */
  resolveModelPricing(modelRef: string, providerId?: string, signInRoute?: string | null): ResolvedModelPricing {
    // A provider with more than one sign-in (OpenAI) prices by the one serving the model: a plan has no per-token price.
    const signedIn = signInRoute !== undefined ? signInRoute : this.signInRouteFor(modelRef, providerId);
    if (signedIn === 'subscription') return { status: 'subscription' };
    const index = this.pricingIndex();
    return resolveModelPricingFromDeps(buildRegistryModelPricingDeps({
      getManualPrices: () => this.configManager.get('pricing.modelPrices'),
      findModelPricing: (provider, modelId) =>
        (provider ? index.definitions.get(`${provider}\u0000${modelId}`) : index.definitionsById.get(modelId))?.pricing ?? null,
      openRouterPricing: (modelId) => {
        const served = this.modelLimitsService.getPricingForModel(modelId, 'openrouter');
        return served ? { ...served, fetchedAt: this.modelLimitsService.getPricingFetchedAt() ?? undefined } : null;
      },
      gatewayPricing: (provider, modelId) => this.gatewayPricing.getPricing(provider, modelId),
      getCatalog: () => this.pricingCatalog ?? { fetchedAt: 0, models: this.catalogModels },
      catalogEntriesById: (modelId) => index.catalogById.get(modelId) ?? [],
      providerAliases: CATALOG_PROVIDER_NAME_ALIASES,
      isKnownProviderId: (id) => this.providers.has(id) || index.catalogProviderIds.has(id),
    }), modelRef, providerId);
  }

  private _cacheRatios: { readonly catalog: readonly CatalogModel[]; readonly ratios: (provider: string) => Partial<CacheRatio> | undefined } | null = null;

  /**
   * A provider's published cache-read and cache-write rates as multiples of
   * its input rate, from this registry's own catalog (the table is built once
   * per catalog); undefined when the provider publishes none. Every cost
   * computation passes it for the provider that billed the usage, so a price
   * with no cache rates of its own prices cache tokens the same way on every
   * surface.
   */
  cacheRatios(provider: string): Partial<CacheRatio> | undefined {
    const catalog = this.catalogModels;
    let entry = this._cacheRatios;
    if (!entry || entry.catalog !== catalog) {
      entry = { catalog, ratios: cacheRatiosFromCatalog(catalog) };
      this._cacheRatios = entry;
    }
    return entry.ratios(provider);
  }

  /**
   * Which sign-in serves a model on a provider that has more than one (OpenAI:
   * `subscription` or `api-key`), or null for a provider with one way in.
   */
  signInRouteFor(modelRef: string, providerId?: string): string | null {
    const separator = modelRef.indexOf(':');
    const providerName = providerId ?? (separator > 0 ? modelRef.slice(0, separator) : undefined);
    if (!providerName) return null;
    const provider = this.tryGet(providerName) as (LLMProvider & { activeSignInRoute?: (modelId?: string) => string | null }) | undefined;
    if (typeof provider?.activeSignInRoute !== 'function') return null;
    const modelId = separator > 0 && modelRef.slice(0, separator) === providerName ? modelRef.slice(separator + 1) : modelRef;
    return provider.activeSignInRoute(modelId);
  }

  /**
   * Lookups by id over the model registry and the catalog, built once per
   * registry or catalog change, so pricing a listing of models is one map read
   * per model instead of a pass over the whole catalog.
   */
  private _pricingIndex: PricingIndex | null = null;

  private pricingIndex(): PricingIndex {
    const registry = this.getModelRegistry();
    const catalog = this.catalogModels;
    const current = this._pricingIndex;
    if (current && current.registry === registry && current.catalog === catalog) return current;
    const definitions = new Map<string, ModelDefinition>();
    const definitionsById = new Map<string, ModelDefinition>();
    // First definition wins, as the linear find it replaces did.
    for (const def of registry) {
      const key = `${def.provider}\u0000${def.id}`;
      if (!definitions.has(key)) definitions.set(key, def);
      if (!definitionsById.has(def.id)) definitionsById.set(def.id, def);
    }
    const catalogById = new Map<string, CatalogModel[]>();
    const catalogProviderIds = new Set<string>();
    for (const model of catalog) {
      const list = catalogById.get(model.id);
      if (list) list.push(model); else catalogById.set(model.id, [model]);
      catalogProviderIds.add(model.providerId);
    }
    this._pricingIndex = { registry, catalog, definitions, definitionsById, catalogById, catalogProviderIds };
    return this._pricingIndex;
  }

  getContextWindowForModel(modelDef: ModelDefinition): number {
    return this.modelLimitsService.getContextWindowForModel(modelDef);
  }

  /** The window a source states, or null when unknown (a guess, or disproven by a larger accepted request): what meters and compaction use. */
  getKnownContextWindowForModel(modelDef: ModelDefinition): number | null { return this.modelLimitsService.getKnownContextWindowForModel(modelDef); }

  getTokenLimitsForModel(modelDef: ModelDefinition): Required<TokenLimits> {
    return this.modelLimitsService.getTokenLimitsForModel(modelDef);
  }

  getPricingForModel(modelId: string, provider: string): { prompt: number; completion: number } | null {
    return this.modelLimitsService.getPricingForModel(modelId, provider);
  }

  getToolResultMaxCharsForModel(model: ModelDefinition | null | undefined): number {
    return this.modelLimitsService.getToolResultMaxCharsForModel(model);
  }

  initModelLimits(): void {
    this.modelLimitsService.init();
  }

  refreshModelLimits(): Promise<number> {
    return this.modelLimitsService.refresh();
  }

  getRawCatalogModels(): readonly CatalogModel[] {
    return [...this.catalogModels];
  }

  getCatalogModelDefinitions(): readonly MinimalModelDefinition[] {
    return getCatalogModelDefinitionsFrom(this.catalogModels);
  }

  getSyntheticModelDefinitions(): readonly MinimalModelDefinition[] {
    return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels);
  }

  getSyntheticCanonicalModels(): readonly CanonicalModel[] {
    return [...this.syntheticCanonicalModels];
  }

  getSyntheticBackendModelIds(): Set<string> {
    return getSyntheticBackendModelIds(this.syntheticCanonicalModels);
  }

  getSyntheticModelInfoFromCatalog(modelId: string) {
    return getSyntheticModelInfo(
      modelId,
      this.syntheticCanonicalModels,
      (candidateId) => this.benchmarkStore.getKnownBenchmarks(candidateId),
    );
  }

  getConfiguredProviderIds(): string[] {
    return computeConfiguredProviderIds(
      this.catalogModels,
      this.providers,
      () => this.getSyntheticBackendModelIds(),
    );
  }

  /** Only the models the user can switch to. */
  getSelectableModels(): ModelDefinition[] {
    return this.getModelRegistry().filter((m) => m.selectable);
  }

  /** Currently active model definition. Follows a `provider.model` write made after startup. */
  getCurrentModel(): ModelDefinition {
    const previous = this.currentModelRegistryKey;
    this.currentModelRegistryKey = this.configuredModel.adopt(previous);
    if (previous !== this.currentModelRegistryKey) this._modelRegistryRevision += 1;
    const registry = this.getModelRegistry();
    const def = findModelDefinition(this.currentModelRegistryKey, registry);
    if (def) return def;
    // `Ollama:x` and `ollama:x` name the same provider: the provider half is
    // resolved by id or display name without regard to case.
    const canonical = this.canonicalModelKey(this.currentModelRegistryKey);
    if (canonical !== null && canonical !== this.currentModelRegistryKey) {
      this.currentModelRegistryKey = canonical;
      this._modelRegistryRevision += 1;
      const resolved = findModelDefinition(canonical, registry);
      if (resolved) return resolved;
    }
    const fallback = this.buildConfiguredModelFallback(this.currentModelRegistryKey);
    if (fallback) return fallback;
    // The selection names no registered provider (a scanned server that is gone, a typo). Reading
    // it must not stop the program: the definition says so, and a request to it fails with
    // unregisteredModelMessage (getForModel), which says how to choose another.
    return this.unregisteredModelDefinition(this.currentModelRegistryKey);
  }

  /** Whether `getCurrentModel()` names a model of a provider that is not registered. */
  isUnregisteredModel(model: Pick<ModelDefinition, 'provider'>): boolean {
    return !this.providers.has(model.provider);
  }

  /** The name a provider is shown by: a custom provider's own `displayName`, else the built-in label. */
  providerDisplayName(name: string): string {
    return this.customProviderDisplayNames.get(name)?.trim() || providerDisplayLabel(name);
  }

  private unregisteredModelDefinition(registryKey: string): ModelDefinition {
    const separator = registryKey.indexOf(':');
    const providerId = separator > 0 ? registryKey.slice(0, separator) : registryKey;
    const modelId = separator > 0 ? registryKey.slice(separator + 1) : registryKey;
    return {
      id: modelId,
      provider: providerId,
      registryKey,
      displayName: modelId,
      description: this.unregisteredModelMessage(registryKey),
      capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
      contextWindow: knownFallbackContextWindow(providerId, modelId),
      contextWindowProvenance: 'fallback', contextWindowOrigin: { kind: 'family_default' },
      selectable: false,
      tier: 'standard',
    };
  }

  /**
   * The registered provider a model reference's provider half names: its id
   * exactly, a catalog alias, or, without regard to case, a provider id or a
   * custom provider's display name (a scanned server's name is its display
   * name, such as `Ollama` or `LM Studio`). Undefined when it names none, or
   * when the case-blind match is ambiguous.
   */
  resolveProviderReference(reference: string): string | undefined {
    const wanted = reference.trim();
    if (!wanted) return undefined;
    if (this.providers.has(wanted)) return wanted;
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[wanted];
    if (aliased !== undefined && this.providers.has(aliased)) return aliased;
    const lowered = wanted.toLowerCase();
    const byId = [...this.providers.keys()].filter((name) => name.toLowerCase() === lowered);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) return undefined;
    const byDisplayName = [...this.customProviderDisplayNames]
      .filter(([name, displayName]) => this.providers.has(name) && displayName.trim().toLowerCase() === lowered)
      .map(([name]) => name);
    return byDisplayName.length === 1 ? byDisplayName[0] : undefined;
  }

  /** `registryKey` with its provider half replaced by the registered provider it names, or null when it names none. */
  canonicalModelKey(registryKey: string): string | null {
    const separator = registryKey.indexOf(':');
    if (separator <= 0) return null;
    const provider = this.resolveProviderReference(registryKey.slice(0, separator));
    return provider === undefined ? null : `${provider}:${registryKey.slice(separator + 1)}`;
  }

  /**
   * Why a model reference cannot be used and how to choose another: its
   * provider half names no registered provider. Lists the registered ones.
   */
  unregisteredModelMessage(registryKey: string): string {
    const separator = registryKey.indexOf(':');
    const provider = separator > 0 ? registryKey.slice(0, separator) : registryKey;
    const registered = this.listProviders().map((candidate) => candidate.name).filter((name) => name !== 'decision-router');
    return [
      `The model '${registryKey}' cannot be used: no registered provider is named '${provider}'.`,
      `Registered providers: ${registered.join(', ') || 'none'}.`,
      'Choose another model with /model, or on the command line with `models use <provider>:<model>` (`models` lists them).',
      'A local server found by a scan is registered from the saved scan; if it is not running or has moved, start it and scan again (/scan).',
    ].join(' ');
  }

  /**
   * Synthesize a minimal model definition for the configured registryKey when
   * the catalog-backed registry hasn't materialized it yet, e.g. a fresh
   * daemon home before the models.dev catalog fetch has completed (or while
   * offline, where it never will). `buildModelRegistry()` only draws from
   * custom/runtime/synthetic/catalog/discovered models, none of which are
   * populated synchronously at construction time, so a stock default like
   * 'openrouter:openrouter/free' can otherwise be unresolvable for the entire
   * lifetime of a catalog-less boot.
   *
   * Resolves when `providerId` is a registered provider: the configured model
   * is the person's own choice, attempted as written even when no list knows
   * it yet, and the provider's refusal, if it refuses, is reported as it is.
   * A key whose provider is not registered still falls through to the "not in
   * registry" error below.
   */
  private buildConfiguredModelFallback(registryKey: string): ModelDefinition | null {
    let providerId: string;
    let resolvedModelId: string;
    try {
      ({ providerId, resolvedModelId } = splitModelRegistryKey(registryKey));
    } catch {
      return null;
    }
    const provider = this.tryGet(providerId);
    if (!provider) return null;
    return this.contextWindowOverrideStore().apply({
      id: resolvedModelId,
      provider: providerId,
      registryKey: `${providerId}:${resolvedModelId}`,
      displayName: resolvedModelId,
      description: `${resolvedModelId}, the configured model; no model list names it yet.`,
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: knownFallbackContextWindow(providerId, resolvedModelId),
      contextWindowProvenance: 'fallback', contextWindowOrigin: { kind: 'family_default' },
      selectable: true,
      tier: 'standard',
    });
  }

  /**
   * Set a user-configured context window (tokens) for any model, custom,
   * discovered, or catalog. Applied as a 'configured_cap' overlay and
   * persisted to the control-plane config dir, so it survives restarts and
   * reaches every consumer of the same home. Keys for models not yet
   * registered are allowed, discovered models pick the override up when
   * they materialize. A valid cap applies to this session even when it cannot be
   * written; `onNotSaved` is told why in that case, or why an invalid cap was rejected.
   */
  setModelContextCap(registryKey: string, cap: number, onNotSaved?: (reason: string) => void): void {
    if (!this.contextWindowOverrideStore().set(registryKey, cap, onNotSaved)) {
      logger.warn('[registry] setModelContextCap: rejecting invalid cap', { registryKey, cap });
      onNotSaved?.('not a whole number of tokens within the supported range');
      return;
    }
    this._invalidateModelRegistry();
  }

  /**
   * Clear the user-configured context window AND any learned provider limit,
   * returning the model to fully automatic resolution (catalog / provider
   * API / family fallback). Returns true when anything was cleared.
   */
  clearModelContextCap(registryKey: string): boolean {
    const existed = this.contextWindowOverrideStore().clear(registryKey);
    if (existed) this._invalidateModelRegistry();
    return existed;
  }

  /** The user-configured context window for a model, or null when automatic. */
  getModelContextCap(registryKey: string): number | null {
    return this.contextWindowOverrideStore().get(registryKey);
  }

  /** The learned provider context ceiling for a model, or null when none observed. */
  getObservedContextWindow(registryKey: string): number | null {
    return this.contextWindowOverrideStore().getObserved(registryKey);
  }

  /**
   * A provider rejected a request of ~`rejectedAtTokens` as too long, learn
   * that ceiling so window math, compaction thresholds, and meters use the
   * endpoint's REAL limit instead of an over-stated catalog value.
   */
  recordContextWindowRejection(registryKey: string, rejectedAtTokens: number): void {
    this.contextWindowOverrideStore().recordRejection(registryKey, rejectedAtTokens);
    this._invalidateModelRegistry();
  }

  /** A request with real billed input succeeded (see ContextWindowOverrideStore.reconcileSuccessfulInput). */
  reconcileObservedContextWindow(registryKey: string, successfulInputTokens: number): void {
    const model = (): ModelDefinition | undefined => {
      const definition = findModelDefinition(registryKey, this.getModelRegistry());
      // A resolved OpenRouter ceiling can be smaller than a raw registry
      // estimate; success must be compared with the number callers use.
      return definition ? { ...definition, contextWindow: this.modelLimitsService.getContextWindowForModel(definition) } : undefined;
    };
    if (this.contextWindowOverrideStore().reconcileSuccessfulInput(registryKey, successfulInputTokens, model)) this._invalidateModelRegistry();
  }

  /** Switch to a different model. Accepts a registryKey or a bare model id (resolved via the shared resolver). */
  setCurrentModel(modelReference: string): void {
    // Intent invalidates retained proposal readers, including failed/no-op and ABA switches.
    this._modelRegistryRevision += 1;
    const registryKey = resolveModelReference(modelReference, this.getModelRegistry());
    const def = findModelDefinition(registryKey, this.getModelRegistry());
    if (!def) throw new Error(`Model '${registryKey}' not found.`);
    if (!def.selectable) throw new Error(`Model '${registryKey}' is not selectable.`);
    const previousRegistryKey = this.currentModelRegistryKey;
    const previousProvider = splitModelRegistryKey(previousRegistryKey).providerId;
    this.configuredModel.noteExplicitSelection();
    // Store the registryKey for unambiguous future lookups
    this.currentModelRegistryKey = def.registryKey;
    if (this.runtimeBus) {
      const traceId = `model:changed:${Date.now()}`;
      emitModelChanged(this.runtimeBus, { sessionId: 'system', source: 'provider-registry', traceId }, {
        registryKey: this.currentModelRegistryKey,
        provider: def.provider ?? '',
        ...(previousRegistryKey !== this.currentModelRegistryKey
          ? { previous: { registryKey: previousRegistryKey, provider: previousProvider ?? '' } }
          : {}),
      });
    }
  }

  /**
   * Load custom providers from the configured providers directory and merge them
   * into the live model registry. Returns any warnings collected during loading.
   * Call this after construction to populate custom providers.
   *
   * One load runs at a time. A call while one runs gets the single follow-up
   * load that starts, reading the files afresh, once the running one settles;
   * every call made meanwhile shares that follow-up. A slower load of older
   * file content can therefore never commit after a newer one.
   */
  loadCustomProviders(): Promise<{ warnings: string[]; added: string[]; removed: string[]; updated: string[] }> {
    const running = this.customLoadInFlight;
    if (!running) return this.startCustomLoad();
    this.customLoadQueued ??= running.then(() => undefined, () => undefined).then(() => {
      this.customLoadQueued = null;
      return this.startCustomLoad();
    });
    return this.customLoadQueued;
  }

  private lastCustomSkips: readonly CustomProviderFileSkip[] = [];
  private customLoadInFlight: Promise<CustomProviderLoadResult> | null = null;
  private customLoadQueued: Promise<CustomProviderLoadResult> | null = null;

  private startCustomLoad(): Promise<CustomProviderLoadResult> {
    const run = this.runCustomLoad();
    this.customLoadInFlight = run;
    const settle = (): void => {
      if (this.customLoadInFlight === run) this.customLoadInFlight = null;
    };
    run.then(settle, settle);
    return run;
  }

  private async runCustomLoad(): Promise<CustomProviderLoadResult> {
    // A file may not replace a built-in or runtime provider; names a previous
    // custom load registered stay reloadable.
    const reservedNames = new Set([...this.providers.keys()].filter((name) => !this.customProviderNames.has(name)));
    const result = await loadCustomProviders({
      providersDir: this.getCustomProvidersDir(),
      reservedNames,
      ingestContextWindows: this.featureFlags?.isEnabled('local-provider-context-ingestion') ?? false,
      contextIngestion: this.localContextIngestionService,
    });
    const diff = diffCustomModels(this.customModels, result.models, this.getCatalogBuiltins());
    const warnings = [...result.warnings, ...diff.collisionWarnings];
    this.lastCustomSkips = result.skipped;

    // A single misconfigured provider is skipped with a warning, not an abort of the rest.
    const loadedNames = new Set<string>();
    for (const { provider } of result.providers) {
      try {
        this.register(provider);
        this.customProviderNames.add(provider.name);
        loadedNames.add(provider.name);
      } catch (err) {
        warnings.push(`[registry] Custom provider '${provider.name}' rejected at registration: ${summarizeError(err)}`);
      }
    }
    // A provider whose file was deleted or renamed is no longer offered. A
    // file can never hold a built-in's name (`reservedNames`), so nothing is
    // restored in its place.
    for (const name of [...this.customProviderNames]) {
      if (loadedNames.has(name)) continue;
      this.customProviderNames.delete(name);
      if (this.runtimeProviderNames.has(name)) continue;
      this.providerNativeModels = removeProviderNativeModels(this.providerNativeModels, name);
      recordProviderAdapterKind({ name });
      this.providers.delete(name);
    }

    this.customModels = result.models;
    this.customProviderDisplayNames = new Map(result.providers
      .filter(({ provider }) => loadedNames.has(provider.name))
      .map(({ provider, config }) => [provider.name, config.displayName]));
    this.catalogWindows.setCustomProviders(result.providers.map(({ config }) => config));
    this._invalidateModelRegistry();

    return { warnings, added: diff.added, removed: diff.removed, updated: diff.updated };
  }

  /**
   * Start watching the configured providers directory for file changes.
   * On change, reloads custom providers and emits typed provider runtime events.
   * Safe to call multiple times, stops the previous watcher first.
   */
  startWatching(runtimeBus: RuntimeEventBus | null = null): void {
    if (this._watchingClosed) throw new Error('Provider watcher ownership is closed.');
    const generation = ++this._watcherGeneration;
    this.stopWatcher();
    const providersDir = this.getCustomProvidersDir();
    if (this._watchingClosed) throw new Error('Provider watcher ownership is closed.');
    if (generation !== this._watcherGeneration) return;
    this._watcher = watchCustomProviders(runtimeBus, async () => {
      const result = await this.loadCustomProviders();
      for (const msg of result.warnings) {
        if (runtimeBus) {
          emitProviderWarning(runtimeBus, {
            sessionId: 'system',
            traceId: `providers:warning:${Date.now()}`,
            source: 'provider-registry',
          }, { message: msg });
        }
      }
      if (runtimeBus) {
        emitProvidersChanged(runtimeBus, {
          sessionId: 'system',
          traceId: `providers:changed:${Date.now()}`,
          source: 'provider-registry',
        }, {
          added: result.added,
          removed: result.removed,
          updated: result.updated,
        });
      }
    }, providersDir);
  }

  /** Stop admission without waiting for reloads. A later startWatching() may restart. */
  stopWatching(): void {
    ++this._watcherGeneration;
    this.stopWatcher();
  }

  private stopWatcher(): void {
    const watcher = this._watcher;
    this._watcher = undefined;
    if (!watcher) return;
    let settled!: () => void;
    const drain = new Promise<void>((resolve) => { settled = resolve; });
    // Publish the old generation before native close can reenter the registry.
    this._watcherDrains.add(drain);
    void watcher.closeAndDrain().then(settled, () => {
      this._watcherFailed = true;
      settled();
    });
    void drain.then(() => { this._watcherDrains.delete(drain); });
  }

  /**
   * Terminal watcher shutdown: fence restart and await all admitted reloads,
   * including generations previously stopped by stopWatching(). Failures reject
   * after settlement; repeated calls return the same promise. Does not close
   * other registry services or own direct loadCustomProviders() calls.
   * A reload callback may request shutdown, but must not await its own drain.
   */
  closeWatching(): Promise<void> {
    if (this._watchingClosed) return this._watchingClosed;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this._watchingClosed = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
    this.stopWatching();
    void Promise.all([...this._watcherDrains]).then(() => {
      if (this._watcherFailed) {
        reject(new Error('Provider registry watcher drain failed.'));
      } else resolve();
    }, reject);
    return this._watchingClosed;
  }

  /**
   * Returns a promise that resolves when the initial custom provider load
   * completes. Callers can await this before looking up a custom registryKey.
   */
  ready(): Promise<void> {
    return this._readyPromise ?? Promise.resolve();
  }

  /** The provider files the last custom load left out, each with what to change in it. */
  customProviderSkips(): readonly CustomProviderFileSkip[] {
    return this.lastCustomSkips;
  }

  /**
   * What follows when `registryKey` failed on every sign-in of its provider
   * (providers/failover.ts): the next model of the person's fallback order
   * (`provider.fallbackModels`) not in `visited`, or a stop with its reason
   * and next step. Never a model of the registry's own choosing.
   */
  chooseFailover(registryKey: string, visited: Iterable<string> = []): FailoverChoice {
    const definition = findModelDefinition(registryKey, this.getModelRegistry());
    const separator = registryKey.indexOf(':');
    const current = definition ?? {
      registryKey,
      provider: separator > 0 ? registryKey.slice(0, separator) : registryKey,
      displayName: separator > 0 ? registryKey.slice(separator + 1) : registryKey,
    };
    return chooseFailover({ registry: this, current, visited, fallbackOrder: this.fallbackOrder() });
  }

  /** The person's fallback order (`provider.fallbackModels`), read now. */
  fallbackOrder(): readonly string[] {
    return readFallbackOrder(this.configManager.get('provider.fallbackModels'));
  }

  /** Model tier readings (routing.model-tier), for the route planner. */
  get modelTiers(): ModelTierStore { return this.routingReadings.tiers; }

  /** The context-window readings of local and custom servers, as lent to a second registry over the same providers (LocalContextIngestionService.lend). */
  get localContextReadings(): LocalContextReadings { return this.lendableContextReadings; }

  /** This registry's live model listings, as lent to a second registry over the same providers and persistence root (LiveModelListings). */
  get liveModelListings(): LentModelListings {
    return this.hostModelListings ?? { listings: this.ownModelListings, settled: () => this.modelDiscoverySettled() };
  }

  /** The benchmark leaderboard, for the route planner's ordering of each tier's candidates. */
  get benchmarks(): Pick<BenchmarkStore, 'getKnownBenchmarks' | 'readBenchmarks' | 'benchmarksSettled'> { return this.benchmarkStore; }

  /**
   * Resolve the full capability record for a model.
   *
   * @param modelReference - A provider-qualified registryKey (`provider:modelId`) or a bare model id (resolved via the shared resolver).
   * @returns A fully-resolved, immutable `ProviderCapability`.
   */
  getCapabilityForModel(modelReference: string): ProviderCapability {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(modelReference);
    return this.capabilityRegistry.getCapability(providerId, resolvedModelId, provider);
  }

  /**
   * Check whether a model can handle a request described by `profile`.
   * Fails early with a typed explanation when unsupported, avoids mid-stream errors.
   *
   * @param modelReference - A provider-qualified registryKey or a bare model id (resolved via the shared resolver).
   * @param profile - The capability requirements for this request.
   * @returns A `RouteExplanation` with `accepted` flag, rejections, and capability.
   */
  explainRoute(modelReference: string, profile: RequestProfile): RouteExplanation {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(modelReference);
    return this.capabilityRegistry.getRouteExplanation(providerId, resolvedModelId, profile, provider);
  }

  /**
   * Resolve the provider identity and instance for a registryKey.
   * Shared by `getCapabilityForModel` and `explainRoute` to avoid duplication.
   *
   * @param registryKey - Provider-qualified registryKey (`provider:modelId`).
   */
  private _resolveModelContext(modelReference: string): {
    providerId: string;
    resolvedModelId: string;
    provider: LLMProvider | undefined;
  } {
    const registry = this.getModelRegistry();
    const registryKey = resolveModelReference(modelReference, registry);
    const def = findModelDefinition(registryKey, registry);
    if (def) {
      return { providerId: def.provider, resolvedModelId: def.id, provider: this.tryGet(def.provider) };
    }
    throw new Error(`Model '${registryKey}' is not in registry.`);
  }

  /** Kick off async custom provider loading. Called once from bootstrap-owned construction. */
  initCustomProviders(options: {
    /**
     * The local servers a scan saved, to register once the custom providers
     * have loaded (so a saved server cannot take a custom provider's name),
     * unless another registration of discovered servers came first. `ready()`
     * resolves after it, so every command that waits for the registry knows a
     * scanned model saved as the default.
     */
    readonly restoreDiscovered?: (() => readonly DiscoveredServer[]) | undefined;
  } = {}): void {
    const generation = this.discoveredRegistrations;
    const restoreDiscovered = (): void => {
      if (!options.restoreDiscovered || this.discoveredRegistrations !== generation) return;
      try {
        const servers = options.restoreDiscovered();
        if (servers.length > 0) this.registerDiscoveredProviders([...servers]);
      } catch (error) {
        logger.warn('[registry] Saved local servers could not be registered', { error: summarizeError(error) });
      }
    };
    this._readyPromise = this.loadCustomProviders()
      .then((result) => {
        // To the log, not console.warn (it corrupts the TUI); a file left out is
        // also announced once to the owner (runtime-graph.ts, customProviderSkips).
        for (const warning of result.warnings) logger.warn(warning);
        // Invalidate the capability cache so custom providers' self-declared
        // capabilities are reflected in subsequent getCapabilityForModel calls.
        this.capabilityRegistry.invalidate();
        restoreDiscovered();
        this._readyPromise = null;
      })
      .catch((err) => {
        // Not console.warn: it corrupts the TUI. The logger and the provider
        // warning event reach the operator without it.
        restoreDiscovered();
        this._readyPromise = null;
        const message = `[registry] Custom providers could not be loaded: ${summarizeError(err)}. Their keys will report as not in the registry until a reload succeeds.`;
        logger.warn(message);
        if (this.runtimeBus) {
          emitProviderWarning(this.runtimeBus, { sessionId: 'system', traceId: `providers:warning:${Date.now()}`, source: 'provider-registry' }, { message });
        }
      });
  }

  initCatalog(options: ProviderCatalogOptions = {}): void {
    initProviderCatalog(this._catalogLifecycleCtx(options.contextWindowEnrichment ?? 'background'));
  }

  /** Background, TTL-respecting live model discovery sweep (never blocks/throws); separate from initCatalog() so tests calling that without mocking a provider API aren't surprised by a live network call. Real callers invoke this once at startup too. */
  initProviderModelDiscovery(): void {
    const host = this.hostModelListings;
    // A borrower waits for the host's own startup sweep, already running, rather than repeating it.
    this.startupDiscovery.start(host
      ? async () => { await host.settled(); return this.refreshLiveModelDiscovery(); }
      : () => this.refreshLiveModelDiscovery());
  }

  /** When the startup sweep settled (StartupModelDiscovery); at once when none was started. */
  modelDiscoverySettled(): Promise<void> { return this.startupDiscovery.settled(); }
  /** Providers whose model listing failed in the startup sweep, with the failure (StartupModelDiscovery). */
  unreachableAtStartup(): ReadonlyMap<string, string> { return this.startupDiscovery.unreachable(); }

  /**
   * Every registered provider that cannot serve, or is limited, now: what its
   * calls this session showed and the startup sweep's failures, until a call
   * succeeds or the hold ends (provider-health.ts). A provider absent is
   * healthy or not yet known.
   */
  health(): ReadonlyMap<string, ProviderHealthEntry> {
    const health = new Map<string, ProviderHealthEntry>();
    for (const [providerId, entry] of readProviderHealth()) {
      if (this.providers.has(providerId)) health.set(providerId, entry);
    }
    return health;
  }

  async refreshCatalog(options: ProviderCatalogOptions = {}): Promise<void> {
    await refreshProviderCatalog(this._catalogLifecycleCtx(options.contextWindowEnrichment ?? 'background'));
  }

  private _catalogLifecycleCtx(contextWindowEnrichment: 'background' | 'none' = 'background') {
    return {
      getCatalogCachePaths: () => this.getCatalogCachePaths(),
      updateCatalogState: (models: readonly CatalogModel[], fetchedAt?: number) =>
        this.updateCatalogState(models, fetchedAt),
      getCatalogModels: () => this.catalogModels as readonly CatalogModel[],
      favoritesStore: this.favoritesStore,
      benchmarkStore: this.benchmarkStore,
      refreshCatalog: () => this.refreshCatalog({ contextWindowEnrichment }),
      afterCatalogApplied: () => {},
    };
  }
}

/** Catalog providers that are a sign-in of a registered provider, listed under that provider instead. */
const SIGN_IN_CATALOG_IDS: ReadonlySet<string> = new Set(['openai-codex']);

/** A provider's own cleanup, logged and never thrown: a replaced or closing provider must not fail its caller. */
async function disposeProvider(provider: LLMProvider): Promise<void> {
  try {
    await provider.dispose?.();
  } catch (error) {
    logger.warn('[registry] provider cleanup failed', { provider: provider.name, error: summarizeError(error) });
  }
}
