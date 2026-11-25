import { cliCommandDone, cliCommandRefusal, yesNo, formatJsonOrText, type CliCommandOutput } from './cli-output.js';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import {
  formatProviderModel,
  listProviderRuntimeSnapshots,
  classifyProviderSetup,
  type ProviderRegistry,
  type FavoritesStore,
  type CanonicalModel,
  type ModelDefinition,
} from '@goodvibes/engine/platform/platform/providers';
import { summarizeProviderAuthRoutes } from '@goodvibes/engine/platform/platform/providers/auth-route-presentation';
import type { formatProviderAuthRoute as ProviderAuthRouteFormatter } from '@goodvibes/engine/platform/platform/providers/auth-route-presentation';

const MODEL_LISTING_LIMIT = 200;

export interface CliProviderRuntime {
  readonly cli: { readonly commandArgs: readonly string[]; readonly flags: { readonly outputFormat?: string | undefined } };
  readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic'>;
}
export interface CliProviderServices {
  readonly providerRegistry: ProviderRegistry;
  readonly favoritesStore: FavoritesStore;
}

/**
 * The model in force, or why the saved one cannot be used. A saved model whose
 * provider is not registered (a scanned server that was removed, a typo) must
 * not stop the commands that list and change models.
 */
type CurrentModelReading =
  | { readonly model: ModelDefinition; readonly problem?: undefined }
  | { readonly model?: undefined; readonly problem: string };

function readCurrentModel(registry: ProviderRegistry): CurrentModelReading {
  try {
    const model = registry.getCurrentModel();
    return registry.isUnregisteredModel(model) ? { problem: registry.unregisteredModelMessage(model.registryKey) } : { model };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Only an explicit `provider:model` names a provider; a bare or slash id is never guessed into one. */
function explicitProviderOfRegistryKey(modelKey: string): string | null {
  const colon = modelKey.indexOf(':');
  return colon > 0 && colon < modelKey.length - 1 ? modelKey.slice(0, colon) : null;
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

export function formatSyntheticChainText(
  entries: ReturnType<typeof buildSyntheticChainEntries>,
  filterKey?: string,
): string {
  return [
    `GoodVibes synthetic model chains${filterKey ? ` (${filterKey})` : ''}`,
    ...entries.flatMap((m) => [
      `  ${m.id}  [${m.tier}]  ${m.keyedBackendCount}/${m.backendCount} backends configured`,
      ...m.backends.map((b) => `    ${b.position}. ${b.provider}/${b.model}`),
    ]),
  ].join('\n');
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
  function modelReceipt(verb: string, model: string, known: boolean, provider?: string): string {
    const warning =
      'model catalog entry was not available locally; saved explicit selection' + (provider ? ' under provider ' + provider : '') + '.';
    if (policy.inlineReceipts) return 'Model ' + verb + ': ' + model + (!known ? '\n  warning: ' + warning : '');
    return ['Model ' + verb, '  model ' + model, ...(!known ? ['  warning ' + warning] : [])].join('\n');
  }
  async function renderProviders(runtime: Runtime): Promise<CliCommandOutput> {
    const usage = (text: string): CliCommandOutput => cliCommandRefusal(runtime.cli, 'usage', text);
    return await withRuntimeServices(runtime, async (services): Promise<CliCommandOutput> => {
      const [sub = 'list', ...rest] = runtime.cli.commandArgs;
      const snapshots = await listProviderRuntimeSnapshots(
        services.providerRegistry,
        policy.enrichModelFamilies ? {} : { modelFamilyEnrichment: 'none' },
      );
      const reading = readCurrentModel(services.providerRegistry);
      const current = reading.model;
      if (sub === 'current') {
        if (!current) return unregisteredCurrentModel(runtime, reading.problem ?? '');
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
        return cliCommandDone(formatJsonOrText(runtime.cli)(
          value,
          [
            'GoodVibes current provider',
            `  provider: ${current.provider}`,
            `  model: ${current.registryKey}`,
            `  configured: ${yesNo(value.configured)}`,
            `  via: ${value.configuredVia}`,
            `  auth routes: ${value.authRouteSummary}`,
          ].join('\n'),
        ));
      }
      if (sub === 'use' || sub === 'set') {
        const named = rest[0];
        if (!named) return usage(`Usage: ${policy.binary(runtime)} providers use <provider> [modelRegistryKey]`);
        // A provider is named by its id or display name, without regard to case.
        const provider = services.providerRegistry.resolveProviderReference(named);
        if (provider === undefined) {
          const known = snapshots.map((snapshot) => snapshot.providerId);
          return cliCommandRefusal(runtime.cli, 'provider_not_found',
            `Unknown provider: ${named}. Nothing was changed. Registered providers: ${known.join(', ') || 'none'}.`,
            [`${policy.binary(runtime)} providers list`]);
        }
        const providerModels = services.providerRegistry
          .getSelectableModels()
          .filter((model) => model.provider === provider || model.registryKey.startsWith(`${provider}:`));
        const requestedModel = rest[1];
        const selected = requestedModel
          ? providerModels.find((model) => model.registryKey === requestedModel || model.id === requestedModel)
          : (providerModels.find((model) => model.registryKey === current?.registryKey) ?? providerModels[0]);
        if (providerModels.length === 0 || !selected) {
          // A registered provider whose model list names nothing yet: only a named model can be saved.
          if (!requestedModel) {
            return cliCommandRefusal(runtime.cli, 'model_not_found',
              `Provider ${provider} lists no models here. Nothing was changed. Name its model: ${policy.binary(runtime)} providers use ${provider} <model>`,
              [`${policy.binary(runtime)} providers use ${provider} <model>`]);
          }
          runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, requestedModel));
          return cliCommandDone(providerReceipt(provider, requestedModel, false));
        }
        runtime.configManager.setDynamic('provider.model', selected.registryKey);
        return cliCommandDone(providerReceipt(selected.provider, selected.registryKey, true));
      }
      if (sub === 'inspect' || sub === 'show') {
        const provider = rest[0];
        if (!provider) return usage(`Usage: ${policy.binary(runtime)} providers inspect <provider>`);
        const snapshot = snapshots.find((candidate) => candidate.providerId === provider);
        if (!snapshot) {
          return cliCommandRefusal(runtime.cli, 'provider_not_found', `No provider found${policy.inlineReceipts ? ': ' : ' '}${provider}`,
            [`${policy.binary(runtime)} providers list`]);
        }
        const setup = await classifyProviderSetup(snapshot, { site: policy.surface + '.providers.inspect.setup' });
        const authRoutes = snapshot.runtime.auth?.routes ?? [];
        return cliCommandDone(formatJsonOrText(runtime.cli)(
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
        ));
      }
      if (sub !== 'list')
        return usage(`Usage: ${policy.binary(runtime)} providers [list|current|inspect <provider>|use <provider> [modelRegistryKey]]`);
      const value = await Promise.all(
        snapshots.map(async (snapshot) => ({
          ...(await classifyProviderSetup(snapshot, { site: policy.surface + '.providers.list.setup' })),
          provider: snapshot.providerId,
          active: snapshot.active,
          configured: snapshot.runtime.auth?.configured ?? true,
          configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
          models: snapshot.modelCount,
          current: current?.provider === snapshot.providerId,
          detail: snapshot.runtime.auth?.detail ?? snapshot.runtime.notes?.join('; ') ?? '',
          authRoutes: snapshot.runtime.auth?.routes ?? [],
          authRouteSummary: summarizeProviderAuthRoutes(snapshot.runtime.auth?.routes),
        })),
      );
      return cliCommandDone(formatJsonOrText(runtime.cli)(
        value,
        [
          'GoodVibes providers',
          ...(reading.problem ? [`  ${reading.problem}`] : []),
          ...value.map((provider) =>
            `  ${provider.current ? '*' : ' '} ${provider.provider.padEnd(18)} setup${policy.inlineReceipts ? '=' : ' '}${provider.setupClass} configured${policy.inlineReceipts ? '=' : ' '}${yesNo(provider.configured)} via${policy.inlineReceipts ? '=' : ' '}${provider.configuredVia ?? 'n/a'} models${policy.inlineReceipts ? '=' : ' '}${provider.models} routes${policy.inlineReceipts ? '=' : ' '}${provider.authRouteSummary} ${provider.detail ?? ''}`.trimEnd(),
          ),
        ].join('\n'),
      ));
    });
  }

  async function renderModels(runtime: Runtime): Promise<CliCommandOutput> {
    const usage = (text: string): CliCommandOutput => cliCommandRefusal(runtime.cli, 'usage', text);
    return await withRuntimeServices(runtime, async (services): Promise<CliCommandOutput> => {
      const [subOrFilter, ...rest] = runtime.cli.commandArgs;
      const reading = readCurrentModel(services.providerRegistry);
      const current = reading.model?.registryKey;
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
        const model = reading.model;
        if (!model) return unregisteredCurrentModel(runtime, reading.problem ?? '');
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
        return cliCommandDone(formatJsonOrText(runtime.cli)(
          value,
          [
            'GoodVibes current model',
            `  model: ${model.registryKey}`,
            `  provider: ${model.provider}`,
            `  setup: ${setup.setupLabel}`,
            `  provider configured: ${yesNo(value.providerConfigured)}`,
            `  context: ${value.contextWindowKnown ? value.contextWindow.toLocaleString() : 'unknown'}`,
          ].join('\n'),
        ));
      }
      if (subOrFilter === 'use' || subOrFilter === 'set') {
        const modelKey = rest[0];
        if (!modelKey) return usage(`Usage: ${policy.binary(runtime)} models use <registryKey>`);
        const selectable = services.providerRegistry.getSelectableModels();
        const find = (key: string) => selectable.find((candidate) => candidate.registryKey === key || candidate.id === key);
        // The provider half names a registered provider by id or display name, without regard to case.
        const canonicalKey = services.providerRegistry.canonicalModelKey(modelKey);
        const model = find(modelKey) ?? (canonicalKey === null ? undefined : find(canonicalKey));
        if (!model) {
          const named = explicitProviderOfRegistryKey(modelKey);
          if (!named) {
            return cliCommandRefusal(runtime.cli, 'model_not_found',
              `Unknown model: ${modelKey}. Nothing was changed. Name the provider to save a model that is not in the local catalog: ${policy.binary(runtime)} models use <provider>:${modelKey}`,
              [`${policy.binary(runtime)} models use <provider>:${modelKey}`]);
          }
          if (canonicalKey === null) {
            const known = services.providerRegistry.listProviders().map((candidate) => candidate.name).filter((name) => name !== 'decision-router');
            return cliCommandRefusal(runtime.cli, 'provider_not_found',
              `Unknown provider: ${named} (in ${modelKey}). Nothing was changed. Registered providers: ${known.join(', ') || 'none'}. A model server on this computer is added by finding it: \`${policy.binary(runtime)} do models.scan\`, or "Find model servers on this computer" in Models and providers.`,
              [`${policy.binary(runtime)} providers list`, `${policy.binary(runtime)} models`]);
          }
          const provider = canonicalKey.slice(0, canonicalKey.indexOf(':'));
          runtime.configManager.setDynamic('provider.model', canonicalKey);
          await services.favoritesStore.recordUsage(canonicalKey);
          return cliCommandDone(modelReceipt('selected', canonicalKey, false, provider));
        }
        runtime.configManager.setDynamic('provider.model', model.registryKey);
        await services.favoritesStore.recordUsage(model.registryKey);
        return cliCommandDone(modelReceipt('selected', model.registryKey, true));
      }
      if (subOrFilter === 'pin' || subOrFilter === 'unpin') {
        const modelKey = rest[0];
        if (!modelKey) return usage(`Usage: ${policy.binary(runtime)} models ${subOrFilter} <registryKey>`);
        if (subOrFilter === 'pin') {
          const known = services.providerRegistry
            .getSelectableModels()
            .some((candidate) => candidate.registryKey === modelKey);
          if (!known) {
            return cliCommandRefusal(runtime.cli, 'model_not_found',
              `Unknown model: ${modelKey}. Nothing was pinned. Use a registry key from \`${policy.binary(runtime)} models\`.`,
              [`${policy.binary(runtime)} models`]);
          }
          await services.favoritesStore.pinModel(modelKey);
        } else await services.favoritesStore.unpinModel(modelKey);
        return cliCommandDone(modelReceipt(subOrFilter === 'pin' ? 'pinned' : 'unpinned', modelKey, true));
      }
      if (subOrFilter === 'pinned') {
        const pinned = await services.favoritesStore.getPinned();
        return cliCommandDone(formatJsonOrText(runtime.cli)(
          { pinned },
          [`GoodVibes pinned models (${pinned.length})`, ...pinned.map((model) => `  ${model}`)].join('\n'),
        ));
      }
      if (subOrFilter === 'recent') {
        const recent = await services.favoritesStore.getRecentModels(25);
        return cliCommandDone(formatJsonOrText(runtime.cli)(
          { recent },
          [`GoodVibes recent models (${recent.length})`, ...recent.map((model) => `  ${model}`)].join('\n'),
        ));
      }
      if (policy.syntheticCatalog && (subOrFilter === 'chain' || subOrFilter === 'chains')) {
        // List synthetic model fallback ladders, backend composition for each synthetic model.
        const canonicalModels = services.providerRegistry.getSyntheticCanonicalModels();
        if (canonicalModels.length === 0) {
          return cliCommandDone(formatJsonOrText(runtime.cli)([], 'No synthetic models found in the current catalog.'));
        }
        const filterKey = rest[0]?.toLowerCase();
        const filtered = filterKey ? canonicalModels.filter((m) => m.id.toLowerCase().includes(filterKey)) : canonicalModels;
        const value = buildSyntheticChainEntries(filtered);
        return cliCommandDone(formatJsonOrText(runtime.cli)(value, formatSyntheticChainText(value, filterKey)));
      }
      const filter = subOrFilter === 'list' ? rest[0]?.toLowerCase() : subOrFilter?.toLowerCase();
      const matching = services.providerRegistry
        .getSelectableModels()
        .filter((model) => !filter || model.provider.toLowerCase() === filter || model.registryKey.toLowerCase().includes(filter));
      // The cut only keeps the text listing readable; JSON has no place for a "showing N of M" note, so it carries every match.
      const models = runtime.cli.flags.outputFormat === 'json' ? matching : matching.slice(0, MODEL_LISTING_LIMIT);
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
      return cliCommandDone(formatJsonOrText(runtime.cli)(
        value,
        [
          `GoodVibes models${filter ? ` (${filter})` : ''}`,
          ...(reading.problem ? [`  ${reading.problem}`] : []),
          ...(matching.length > models.length
            ? [`  showing ${models.length} of ${matching.length}; add a provider or text filter to narrow the list`]
            : []),
          ...value.map((model) => {
            const synthLabel = model.isSynthetic ? ` [synthetic ${model.syntheticConfiguredBackends}/${model.syntheticBackends}p]` : '';
            return `  ${model.current ? '*' : ' '} ${model.registryKey.padEnd(42)} setup${policy.inlineReceipts ? '=' : ' '}${model.setupClass} ${policy.inlineReceipts ? 'ctx=' : 'context '}${model.contextWindowKnown ? model.contextWindow.toLocaleString() : 'unknown'}${synthLabel} ${model.displayName}`;
          }),
        ].join('\n'),
      ));
    });
  }
  /** `models current` and `providers current` when the saved model cannot be used: what is wrong and how to choose another. */
  function unregisteredCurrentModel(runtime: Runtime, problem: string): CliCommandOutput {
    const binary = policy.binary(runtime);
    return cliCommandRefusal(runtime.cli, 'model_not_registered', problem, [`${binary} models`, `${binary} models use <provider>:<model>`]);
  }
  return { renderProviders, renderModels };
}
