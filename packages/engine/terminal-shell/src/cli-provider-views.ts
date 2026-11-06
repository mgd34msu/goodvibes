import { yesNo, formatJsonOrText } from './cli-output.js';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  formatProviderModel,
  getModelIdFromProviderModel,
  listProviderRuntimeSnapshots,
  classifyProviderSetup,
  type ProviderRegistry,
  type FavoritesStore,
  type CanonicalModel,
} from '@goodvibes-jev/engine/sdk/platform/providers';
import { summarizeProviderAuthRoutes } from '@goodvibes-jev/engine/sdk/platform/providers/auth-route-presentation';
import type { formatProviderAuthRoute as ProviderAuthRouteFormatter } from '@goodvibes-jev/engine/sdk/platform/providers/auth-route-presentation';

export interface CliProviderRuntime {
  readonly cli: { readonly commandArgs: readonly string[]; readonly flags: { readonly outputFormat?: string | undefined } };
  readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic'>;
}
export interface CliProviderServices {
  readonly providerRegistry: ProviderRegistry;
  readonly favoritesStore: FavoritesStore;
}

function inferProviderFromRegistryKey(modelKey: string): string {
  if (modelKey.includes(':')) return modelKey.split(':')[0] || 'openai';
  if (modelKey.includes('/')) return modelKey.split('/')[0] || 'openai';
  return 'openai';
}

export function buildSyntheticChainEntries(
  canonicalModels: readonly CanonicalModel[],
  filterKey?: string,
): Array<{
  id: string;
  tier: string;
  backendCount: number;
  keyedBackendCount: number;
  backends: Array<{ position: number; provider: string; model: string; registryKey: string }>;
}> {
  const filtered = filterKey ? canonicalModels.filter((m) => m.id.toLowerCase().includes(filterKey)) : canonicalModels;
  return filtered.map((m) => ({
    id: m.id,
    tier: m.tier,
    backendCount: m.backendCount,
    keyedBackendCount: m.keyedBackendCount,
    backends: m.backends.map((b, idx) => ({
      position: idx,
      provider: b.providerName,
      model: b.modelId,
      registryKey: b.registryKey ?? `${b.providerName}:${b.modelId}`,
    })),
  }));
}

/** One catalog/auth/selection view; runtime ownership and product presentation remain supplied ports. */
export function createCliProviderViews<Runtime extends CliProviderRuntime, Services extends CliProviderServices>(
  withRuntimeServices: <T>(runtime: Runtime, fn: (services: Services) => Promise<T> | T) => Promise<T>,
  policy: {
    readonly surface: string;
    readonly enrichModelFamilies: boolean;
    readonly syntheticCatalog: boolean;
    readonly inlineReceipts: boolean;
    readonly binary: (runtime: Runtime) => string;
    readonly formatProviderAuthRoute: typeof ProviderAuthRouteFormatter;
  },
) {
  const formatProviderAuthRoute = policy.formatProviderAuthRoute;
  function providerReceipt(provider: string, model: string | undefined, known: boolean): string {
    const warning =
      'model catalog entry was not available locally; ' + (model ? 'saved explicit selection.' : 'model selection was left unchanged.');
    if (policy.inlineReceipts)
      return 'Provider selected: ' + provider + (model ? ' (' + model + ')' : '') + (!known ? '\n  warning: ' + warning : '');
    return [
      'Provider selected',
      '  provider ' + provider,
      ...(model ? ['  model ' + model] : []),
      ...(!known ? ['  warning ' + warning] : []),
    ].join('\n');
  }
  function modelReceipt(verb: string, model: string, known: boolean): string {
    const warning = 'model catalog entry was not available locally; saved explicit selection.';
    if (policy.inlineReceipts) return 'Model ' + verb + ': ' + model + (!known ? '\n  warning: ' + warning : '');
    return ['Model ' + verb, '  model ' + model, ...(!known ? ['  warning ' + warning] : [])].join('\n');
  }
  async function renderProviders(runtime: Runtime): Promise<string> {
    return await withRuntimeServices(runtime, async (services) => {
      const [sub = 'list', ...rest] = runtime.cli.commandArgs;
      const snapshots = await listProviderRuntimeSnapshots(
        services.providerRegistry,
        policy.enrichModelFamilies ? {} : { modelFamilyEnrichment: 'none' },
      );
      const current = services.providerRegistry.getCurrentModel();
      if (sub === 'current') {
        const snapshot = snapshots.find((candidate) => candidate.providerId === current.provider);
        const authRoutes = snapshot?.runtime.auth?.routes ?? [];
        const value = {
          provider: current.provider,
          model: current.registryKey,
          configured: snapshot?.runtime.auth?.configured ?? true,
          configuredVia: snapshot?.runtime.auth?.mode ?? 'unknown',
          authRoutes,
          authRouteSummary: summarizeProviderAuthRoutes(authRoutes),
        };
        return formatJsonOrText(runtime.cli)(
          value,
          [
            'GoodVibes current provider',
            `  provider: ${current.provider}`,
            `  model: ${current.registryKey}`,
            `  configured: ${yesNo(value.configured)}`,
            `  via: ${value.configuredVia}`,
            `  auth routes: ${value.authRouteSummary}`,
          ].join('\n'),
        );
      }
      if (sub === 'use' || sub === 'set') {
        const provider = rest[0];
        if (!provider) return `Usage: ${policy.binary(runtime)} providers use <provider> [modelRegistryKey]`;
        const providerModels = services.providerRegistry
          .getSelectableModels()
          .filter((model) => model.provider === provider || model.registryKey.startsWith(`${provider}:`));
        const requestedModel = rest[1];
        const selected = requestedModel
          ? providerModels.find((model) => model.registryKey === requestedModel || model.id === requestedModel)
          : (providerModels.find((model) => model.registryKey === current.registryKey) ?? providerModels[0]);
        if (providerModels.length === 0 || !selected) {
          if (requestedModel) {
            runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, requestedModel));
          } else {
            runtime.configManager.setDynamic(
              'provider.model',
              formatProviderModel(provider, getModelIdFromProviderModel(runtime.configManager.get('provider.model'))),
            );
          }
          return providerReceipt(provider, requestedModel, false);
        }
        runtime.configManager.setDynamic('provider.model', selected.registryKey);
        return providerReceipt(selected.provider, selected.registryKey, true);
      }
      if (sub === 'inspect' || sub === 'show') {
        const provider = rest[0];
        if (!provider) return `Usage: ${policy.binary(runtime)} providers inspect <provider>`;
        const snapshot = snapshots.find((candidate) => candidate.providerId === provider);
        if (!snapshot) return `No provider found${policy.inlineReceipts ? ': ' : ' '}${provider}`;
        const setup = await classifyProviderSetup(snapshot, { site: policy.surface + '.providers.inspect.setup' });
        const authRoutes = snapshot.runtime.auth?.routes ?? [];
        return formatJsonOrText(runtime.cli)(
          {
            ...snapshot,
            setup,
            authRoutes,
            authRouteSummary: summarizeProviderAuthRoutes(authRoutes),
          },
          [
            `Provider ${snapshot.providerId}`,
            `  active: ${yesNo(snapshot.active)}`,
            `  setup: ${setup.setupLabel}`,
            `  configured: ${yesNo(snapshot.runtime.auth?.configured ?? true)}`,
            `  via: ${snapshot.runtime.auth?.mode ?? 'unknown'}`,
            `  models: ${snapshot.modelCount}`,
            `  auth routes: ${summarizeProviderAuthRoutes(authRoutes)}`,
            ...authRoutes.map((route) => `    ${formatProviderAuthRoute(route)}`),
            `  detail: ${snapshot.runtime.auth?.detail ?? snapshot.runtime.notes?.join('; ') ?? ''}`,
          ].join('\n'),
        );
      }
      if (sub !== 'list')
        return `Usage: ${policy.binary(runtime)} providers [list|current|inspect <provider>|use <provider> [modelRegistryKey]]`;
      const value = await Promise.all(
        snapshots.map(async (snapshot) => ({
          ...(await classifyProviderSetup(snapshot, { site: policy.surface + '.providers.list.setup' })),
          provider: snapshot.providerId,
          active: snapshot.active,
          configured: snapshot.runtime.auth?.configured ?? true,
          configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
          models: snapshot.modelCount,
          current: current.provider === snapshot.providerId,
          detail: snapshot.runtime.auth?.detail ?? snapshot.runtime.notes?.join('; ') ?? '',
          authRoutes: snapshot.runtime.auth?.routes ?? [],
          authRouteSummary: summarizeProviderAuthRoutes(snapshot.runtime.auth?.routes),
        })),
      );
      return formatJsonOrText(runtime.cli)(
        value,
        [
          'GoodVibes providers',
          ...value.map((provider) =>
            `  ${provider.current ? '*' : ' '} ${provider.provider.padEnd(18)} setup${policy.inlineReceipts ? '=' : ' '}${provider.setupClass} configured${policy.inlineReceipts ? '=' : ' '}${yesNo(provider.configured)} via${policy.inlineReceipts ? '=' : ' '}${provider.configuredVia ?? 'n/a'} models${policy.inlineReceipts ? '=' : ' '}${provider.models} routes${policy.inlineReceipts ? '=' : ' '}${provider.authRouteSummary} ${provider.detail ?? ''}`.trimEnd(),
          ),
        ].join('\n'),
      );
    });
  }

  async function renderModels(runtime: Runtime): Promise<string> {
    return await withRuntimeServices(runtime, async (services) => {
      const [subOrFilter, ...rest] = runtime.cli.commandArgs;
      const current = services.providerRegistry.getCurrentModel().registryKey;
      const providerSnapshots = await listProviderRuntimeSnapshots(
        services.providerRegistry,
        policy.enrichModelFamilies ? {} : { modelFamilyEnrichment: 'none' },
      );
      const setupReads = new Map<string, ReturnType<typeof classifyProviderSetup>>();
      const classifyModelProvider = (providerId: string) => {
        let reading = setupReads.get(providerId);
        if (!reading) {
          const snapshot = providerSnapshots.find((candidate) => candidate.providerId === providerId);
          reading = classifyProviderSetup(snapshot ?? { providerId }, { site: policy.surface + '.models.setup' });
          setupReads.set(providerId, reading);
        }
        return reading;
      };
      if (subOrFilter === 'current') {
        const model = services.providerRegistry.getCurrentModel();
        const setup = await classifyModelProvider(model.provider);
        const providerSnapshot = providerSnapshots.find((candidate) => candidate.providerId === model.provider);
        const value = {
          registryKey: model.registryKey,
          provider: model.provider,
          id: model.id,
          displayName: model.displayName,
          contextWindow: services.providerRegistry.getContextWindowForModel(model),
          // False when nothing states the window (a guess, or disproven by a larger accepted request).
          contextWindowKnown: services.providerRegistry.getKnownContextWindowForModel(model) !== null,
          providerConfigured: providerSnapshot?.runtime.auth?.configured ?? true,
          setup,
        };
        return formatJsonOrText(runtime.cli)(
          value,
          [
            'GoodVibes current model',
            `  model: ${model.registryKey}`,
            `  provider: ${model.provider}`,
            `  setup: ${setup.setupLabel}`,
            `  provider configured: ${yesNo(value.providerConfigured)}`,
            `  context: ${value.contextWindowKnown ? value.contextWindow.toLocaleString() : 'unknown'}`,
          ].join('\n'),
        );
      }
      if (subOrFilter === 'use' || subOrFilter === 'set') {
        const modelKey = rest[0];
        if (!modelKey) return `Usage: ${policy.binary(runtime)} models use <registryKey>`;
        const model = services.providerRegistry
          .getSelectableModels()
          .find((candidate) => candidate.registryKey === modelKey || candidate.id === modelKey);
        if (!model) {
          const provider = inferProviderFromRegistryKey(modelKey);
          runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, modelKey));
          await services.favoritesStore.recordUsage(modelKey);
          return modelReceipt('selected', modelKey, false);
        }
        runtime.configManager.setDynamic('provider.model', model.registryKey);
        await services.favoritesStore.recordUsage(model.registryKey);
        return modelReceipt('selected', model.registryKey, true);
      }
      if (subOrFilter === 'pin' || subOrFilter === 'unpin') {
        const modelKey = rest[0];
        if (!modelKey) return `Usage: ${policy.binary(runtime)} models ${subOrFilter} <registryKey>`;
        if (subOrFilter === 'pin') await services.favoritesStore.pinModel(modelKey);
        else await services.favoritesStore.unpinModel(modelKey);
        return modelReceipt(subOrFilter === 'pin' ? 'pinned' : 'unpinned', modelKey, true);
      }
      if (subOrFilter === 'pinned') {
        const pinned = await services.favoritesStore.getPinned();
        return formatJsonOrText(runtime.cli)(
          { pinned },
          [`GoodVibes pinned models (${pinned.length})`, ...pinned.map((model) => `  ${model}`)].join('\n'),
        );
      }
      if (subOrFilter === 'recent') {
        const recent = await services.favoritesStore.getRecentModels(25);
        return formatJsonOrText(runtime.cli)(
          { recent },
          [`GoodVibes recent models (${recent.length})`, ...recent.map((model) => `  ${model}`)].join('\n'),
        );
      }
      if (policy.syntheticCatalog && (subOrFilter === 'chain' || subOrFilter === 'chains')) {
        // List synthetic model fallback ladders, backend composition for each synthetic model.
        const canonicalModels = services.providerRegistry.getSyntheticCanonicalModels();
        if (canonicalModels.length === 0) {
          return formatJsonOrText(runtime.cli)([], 'No synthetic models found in the current catalog.');
        }
        const filterKey = rest[0]?.toLowerCase();
        const filtered = filterKey ? canonicalModels.filter((m) => m.id.toLowerCase().includes(filterKey)) : canonicalModels;
        const value = buildSyntheticChainEntries(filtered);
        return formatJsonOrText(runtime.cli)(
          value,
          [
            `GoodVibes synthetic model chains${filterKey ? ` (${filterKey})` : ''}`,
            ...value.flatMap((m) => [
              `  ${m.id}  [${m.tier}]  ${m.keyedBackendCount}/${m.backendCount} backends configured`,
              ...m.backends.map((b) => `    ${b.position}. ${b.provider}/${b.model}`),
            ]),
          ].join('\n'),
        );
      }
      const filter = subOrFilter === 'list' ? rest[0]?.toLowerCase() : subOrFilter?.toLowerCase();
      const models = services.providerRegistry
        .getSelectableModels()
        .filter((model) => !filter || model.provider.toLowerCase() === filter || model.registryKey.toLowerCase().includes(filter))
        .slice(0, 200);
      const value = await Promise.all(
        models.map(async (model) => {
          const synthInfo =
            policy.syntheticCatalog && model.provider === 'synthetic'
              ? services.providerRegistry.getSyntheticModelInfoFromCatalog(model.id)
              : null;
          return {
            registryKey: model.registryKey,
            provider: model.provider,
            ...(await classifyModelProvider(model.provider)),
            id: model.id,
            displayName: model.displayName,
            contextWindow: services.providerRegistry.getContextWindowForModel(model),
            contextWindowKnown: services.providerRegistry.getKnownContextWindowForModel(model) !== null,
            current: model.registryKey === current,
            ...(synthInfo !== null
              ? {
                  isSynthetic: true,
                  syntheticTier: synthInfo.tier,
                  syntheticBackends: synthInfo.backendCount,
                  syntheticConfiguredBackends: synthInfo.keyedBackendCount,
                }
              : {}),
          };
        }),
      );
      return formatJsonOrText(runtime.cli)(
        value,
        [
          `GoodVibes models${filter ? ` (${filter})` : ''}`,
          ...value.map((model) => {
            const synthLabel = model.isSynthetic ? ` [synthetic ${model.syntheticConfiguredBackends}/${model.syntheticBackends}p]` : '';
            return `  ${model.current ? '*' : ' '} ${model.registryKey.padEnd(42)} setup${policy.inlineReceipts ? '=' : ' '}${model.setupClass} ${policy.inlineReceipts ? 'ctx=' : 'context '}${model.contextWindowKnown ? model.contextWindow.toLocaleString() : 'unknown'}${synthLabel} ${model.displayName}`;
          }),
        ].join('\n'),
      );
    });
  }
  return { renderProviders, renderModels };
}
