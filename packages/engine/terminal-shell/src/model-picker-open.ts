import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelPickerCatalogFill, ConfiguredVia } from './model-picker-catalog.js';
import type { EmbeddingProviderPickerEntry } from './model-picker-types.js';
export interface ModelPickerOpenDeps<Info> {
    readonly picker: {
        configuredProviders: Set<string>;
        configuredViaMap: ConfiguredVia;
        readonly embeddingProviders?: EmbeddingProviderPickerEntry[] | undefined;
        setTargetInfos(infos: Info[]): void;
        openProviders(providers: string[], id: string): void;
        openAllModels(models: ModelDefinition[], id: string): void;
        beginCatalogLoad(): number;
        isCatalogLoadCurrent(ticket: number): boolean;
        fillCatalog(ticket: number, fill: ModelPickerCatalogFill<Info>, done?: boolean | undefined): boolean;
    };
    /** Register the picker as the open modal (input focus, modal stack). */
    readonly modalOpened: () => void;
    readonly render: () => void;
    /** The selectable models from the cached catalog (synchronous). */
    readonly listModels: () => ModelDefinition[];
    /** The selectable provider ids from the cached catalog (synchronous). */
    readonly listProviders: () => string[];
    readonly currentModelId: () => string;
    readonly currentProviderId: () => string;
    readonly configuredProviderIds: () => ReadonlySet<string>;
    /** Which credential source configured each provider, given the providers the credential store holds keys for. */
    readonly buildConfiguredVia: (providerIds: readonly string[], configured: ReadonlySet<string>, secretProviderIds: ReadonlySet<string>) => ConfiguredVia;
    readonly buildTargets: (embeddingProviders: EmbeddingProviderPickerEntry[]) => Info[];
    /** Slow: one credential store read per configured provider. */
    readonly resolveSecretProviderIds: () => Promise<ReadonlySet<string>>;
    /** Slow: the embedding registry's status probe. */
    readonly resolveEmbeddingProviders?: (() => Promise<EmbeddingProviderPickerEntry[]>) | undefined;
    /** Optional live re-check of each provider's served models; resolves true when a list changed. */
    readonly refreshLiveModels?: (() => Promise<boolean>) | undefined;
    /** Best-effort prefetches (pinned and recent models); failures stay silent. */
    readonly prefetch?: (() => Promise<void>) | undefined;
    readonly onError: (error: unknown) => void;
}
/**
 * Open the picker on the cached catalog right now (it is visible when this
 * returns), then fill in the slow parts. `mode` picks the model list (/model)
 * or the provider list (/provider). The returned promise settles when every
 * fill has landed or been dropped; callers do not need to await it.
 */
export function openModelPickerNow<Info>(deps: ModelPickerOpenDeps<Info>, mode: 'models' | 'providers' = 'models'): Promise<void> {
    const { picker } = deps;
    const configured = new Set(deps.configuredProviderIds());
    const models = deps.listModels();
    const providers = mode === 'providers' ? deps.listProviders() : [...new Set(models.map((m) => m.provider))];
    picker.configuredProviders = configured;
    picker.configuredViaMap = deps.buildConfiguredVia(providers, configured, new Set());
    deps.modalOpened();
    picker.setTargetInfos(deps.buildTargets(picker.embeddingProviders ?? []));
    if (mode === 'providers')
        picker.openProviders(providers, deps.currentProviderId());
    else
        picker.openAllModels(models, deps.currentModelId());
    const ticket = picker.beginCatalogLoad();
    deps.render();
    const ownsCatalog = () => picker.isCatalogLoadCurrent(ticket);
    const prefetch = (deps.prefetch?.() ?? Promise.resolve()).catch(() => { }).then(() => { if (ownsCatalog())
        deps.render(); });
    const decorations = (async () => {
        const [secretIds, embedding] = await Promise.all([deps.resolveSecretProviderIds(), deps.resolveEmbeddingProviders?.() ?? Promise.resolve([])]);
        const fill: ModelPickerCatalogFill<Info> = {
            configuredViaMap: deps.buildConfiguredVia(providers, configured, secretIds),
            embeddingProviders: embedding,
            targetInfos: deps.buildTargets(embedding),
        };
        if (picker.fillCatalog(ticket, fill, false))
            deps.render();
    })();
    const live = (async () => {
        if (!deps.refreshLiveModels)
            return;
        const changed = await deps.refreshLiveModels().catch(() => false);
        if (!changed)
            return;
        const fresh = mode === 'providers' ? { providers: deps.listProviders() } : { models: deps.listModels() };
        if (picker.fillCatalog(ticket, fresh, false))
            deps.render();
    })();
    return Promise.all([decorations, live])
        .catch((error: unknown) => deps.onError(error))
        .finally(() => {
        // Loaded or failed, the loading row goes: the picker keeps what it has.
        if (picker.fillCatalog(ticket, {}))
            deps.render();
        return prefetch;
    })
        .then(() => { });
}
