import { ModelPickerModal as PlatformModelPicker } from '@goodvibes/engine/terminal-shell/model-picker';
import type { FavoritesStore, BenchmarkStore, ProviderRegistry, CatalogTextWork, ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
import { LOCAL_REC_PROVIDER } from './model-picker-local-fit.ts';
import type { PickerMode, ModelPickerTarget, ModelPickerTargetInfo, ModelPickerFocusPane } from './model-picker-types.ts';
export * from './model-picker-types.ts';
/** Agent keeps its existing focus and effort presentation over platform-owned picker state. */
export class ModelPickerModal extends PlatformModelPicker {
  constructor(
    favorites: Pick<FavoritesStore, 'getRecentModels'>,
    benchmarks: Pick<BenchmarkStore, 'getBenchmarks'>,
    providers: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>,
  ) {
    super(favorites, benchmarks, providers, { searchFocusedOnOpen: false, resetAvailabilityOnOpen: false, effortStyle: 'descriptions' });
  }
  override mode: PickerMode = 'model';
  override target: ModelPickerTarget = 'main';
  override targetInfos: ModelPickerTargetInfo[] = [];
  get focusPane(): ModelPickerFocusPane {
    return this.focusRegion;
  }
  set focusPane(value: ModelPickerFocusPane) {
    this.focusRegion = value;
  }
  override getSelectedTargetInfo(): ModelPickerTargetInfo | null {
    return this.targetInfos[this.targetIndex] ?? null;
  }
  /** The placeholder rows shown before any provider is signed in (a local model to install, "Sign in to a provider") keep their place: they are not catalog models. */
  override textWork(model: ModelDefinition): CatalogTextWork {
    return model.provider === LOCAL_REC_PROVIDER ? 'text' : super.textWork(model);
  }
}
