import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { getProviderIdFromModel } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelPickerTargetInfo } from './model-picker-types.js';
export function buildConversationModelPickerTargets(
  configManager: Pick<ConfigManager, 'get'>,
  runtime: { readonly model: string; readonly provider: string },
  resolveProvider: (model: unknown) => string = getProviderIdFromModel,
): ModelPickerTargetInfo<'main' | 'helper' | 'tool' | 'tts'>[] {
  const mainProvider = resolveProvider(configManager.get('provider.model') || runtime.provider).trim();
  const mainModel = String(configManager.get('provider.model') || runtime.model || '').trim();
  const helperProvider = String(configManager.get('helper.globalProvider') ?? '').trim();
  const helperModel = String(configManager.get('helper.globalModel') ?? '').trim();
  const toolProvider = String(configManager.get('tools.llmProvider') ?? '').trim();
  const toolModel = String(configManager.get('tools.llmModel') ?? '').trim();
  const ttsProvider = String(configManager.get('tts.llmProvider') ?? '').trim();
  const ttsModel = String(configManager.get('tts.llmModel') ?? '').trim();

  return [
    {
      target: 'main',
      label: 'Main Chat',
      description: 'Default provider and model for normal chat turns in this TUI session.',
      provider: mainProvider,
      model: mainModel,
      enabled: true,
      inherited: false,
    },
    {
      target: 'helper',
      label: 'Helper Model',
      description: 'Optional helper route used for supporting work. Empty provider/model values inherit Main Chat.',
      provider: helperProvider || mainProvider,
      model: helperModel || mainModel,
      enabled: Boolean(configManager.get('helper.enabled')),
      inherited: helperProvider.length === 0 && helperModel.length === 0,
    },
    {
      target: 'tool',
      label: 'Tool LLM',
      description: 'Optional LLM route for tool-specific reasoning. Selecting a model enables the tool LLM route.',
      provider: toolProvider || mainProvider,
      model: toolModel || mainModel,
      enabled: Boolean(configManager.get('tools.llmEnabled')),
      inherited: toolProvider.length === 0 && toolModel.length === 0,
    },
    {
      target: 'tts',
      label: 'TTS LLM',
      description: 'Optional LLM override for /tts response generation. Empty values use the current chat model.',
      provider: ttsProvider || mainProvider,
      model: ttsModel || mainModel,
      enabled: true,
      inherited: ttsProvider.length === 0 && ttsModel.length === 0,
    },
  ];
}
export function selectedModelPickerRoute(
  configManager: Pick<ConfigManager, 'get'>,
  runtime: { readonly model: string; readonly provider: string },
  target: string,
  embeddingProvider?: () => string,
): { readonly model: string; readonly provider: string } {
  if (target === 'embeddings' && embeddingProvider) {
    const provider = embeddingProvider();
    return { model: provider, provider };
  }
  const fields =
    target === 'helper'
      ? ({ model: 'helper.globalModel', provider: 'helper.globalProvider' } as const)
      : target === 'tool'
        ? ({ model: 'tools.llmModel', provider: 'tools.llmProvider' } as const)
        : target === 'tts'
          ? ({ model: 'tts.llmModel', provider: 'tts.llmProvider' } as const)
          : undefined;
  return fields
    ? {
        model: String(configManager.get(fields.model) || runtime.model),
        provider: String(configManager.get(fields.provider) || runtime.provider),
      }
    : { model: runtime.model, provider: runtime.provider };
}

/** Shared asynchronous decorations; a catalog-load ticket in the picker owns publication. */
export function modelPickerCatalogServices(options: {
  readonly picker: { pinnedIds: Set<string>; loadRecentModels(): Promise<void> };
  readonly getPinned: () => Promise<string[]>;
  readonly refreshLiveModels: () => Promise<readonly { readonly added: readonly unknown[]; readonly removed: readonly unknown[] }[]>;
}) {
  return {
    refreshLiveModels: async () =>
      (await options.refreshLiveModels()).some((result) => result.added.length > 0 || result.removed.length > 0),
    prefetch: async () => {
      options.picker.pinnedIds = new Set(await options.getPinned());
      await options.picker.loadRecentModels();
    },
  };
}
