import { createProviderApi, type ProviderApi } from '../providers/provider-api.js';
import type { RuntimeServices } from './services.js';

export interface RuntimeProviderApiServices extends Pick<
  RuntimeServices,
  'benchmarkStore' | 'favoritesStore' | 'providerRegistry'
>, Partial<Pick<RuntimeServices, 'helperModel'>> {}

export function createRuntimeProviderApi(
  runtimeServices: RuntimeProviderApiServices,
): ProviderApi {
  return createProviderApi({
    providerRegistry: runtimeServices.providerRegistry,
    favoritesStore: runtimeServices.favoritesStore,
    benchmarkStore: runtimeServices.benchmarkStore,
    ...(runtimeServices.helperModel ? { helperModel: runtimeServices.helperModel } : {}),
  });
}
