import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { EmbeddingProviderPickerEntry } from './model-picker-types.js';
export type ConfiguredVia = Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'>;
export interface ModelPickerCatalogFill<Info> {
 readonly models?: ModelDefinition[] | undefined;
 readonly providers?: string[] | undefined;
 readonly configuredViaMap?: ConfiguredVia | undefined;
 readonly embeddingProviders?: EmbeddingProviderPickerEntry[] | undefined;
 readonly targetInfos?: Info[] | undefined;
}
export interface ModelPickerCatalogState<Info> {
 active: boolean; mode: string; selectedIndex: number; catalogTicket: number; catalogLoading: boolean;
 models: ModelDefinition[]; providers: string[]; configuredViaMap: ConfiguredVia;
 embeddingProviders?: EmbeddingProviderPickerEntry[] | undefined; targetInfos?: Info[] | undefined;
 getFilteredModels(): ModelDefinition[]; getFilteredProviders(): string[];
}
export function beginModelPickerCatalogLoad(picker: Pick<ModelPickerCatalogState<unknown>, 'catalogLoading' | 'catalogTicket'>): number {
 picker.catalogLoading = true; return ++picker.catalogTicket;
}
export function isModelPickerCatalogCurrent(picker: Pick<ModelPickerCatalogState<unknown>, 'active' | 'catalogTicket'>, ticket: number): boolean {
 return picker.active && ticket === picker.catalogTicket;
}
/** Preserve the selected item by identity, query and filters; superseded loads cannot publish. */
export function fillModelPickerCatalog<Info>(picker: ModelPickerCatalogState<Info>, ticket: number, fill: ModelPickerCatalogFill<Info>, clearCaches: () => void, done = true): boolean {
 if (!isModelPickerCatalogCurrent(picker, ticket)) return false;
 const selectedId = picker.mode === 'model' ? picker.getFilteredModels()[picker.selectedIndex]?.id ?? null
  : picker.mode === 'provider' ? picker.getFilteredProviders()[picker.selectedIndex] ?? null
  : picker.mode === 'embeddingProvider' ? picker.embeddingProviders?.[picker.selectedIndex]?.id ?? null : null;
 if (fill.models) picker.models = fill.models;
 if (fill.providers) picker.providers = fill.providers;
 if (fill.configuredViaMap) picker.configuredViaMap = fill.configuredViaMap;
 if (fill.embeddingProviders) picker.embeddingProviders = fill.embeddingProviders;
 if (fill.targetInfos) picker.targetInfos = fill.targetInfos;
 clearCaches();
 if (selectedId !== null) {
  const ids = picker.mode === 'model' ? picker.getFilteredModels().map(model => model.id)
   : picker.mode === 'provider' ? picker.getFilteredProviders() : picker.embeddingProviders?.map(provider => provider.id) ?? [];
  const index = ids.indexOf(selectedId);
  picker.selectedIndex = index >= 0 ? index : Math.min(picker.selectedIndex, Math.max(0, ids.length - 1));
 }
 if (done) picker.catalogLoading = false;
 return true;
}
