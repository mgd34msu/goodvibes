import { ModelPickerModal as PlatformModelPicker } from '@goodvibes-jev/engine/terminal-shell/model-picker';
import type { FavoritesStore, BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
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
}
