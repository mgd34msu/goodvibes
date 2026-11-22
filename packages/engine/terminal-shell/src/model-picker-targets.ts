import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { getProviderIdFromModel } from '@goodvibes/engine/platform/platform/providers';
import { gatePresetLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import type { ModelPickerTarget, ModelPickerTargetInfo } from './model-picker-types.js';
import { decisionModelChoices } from './settings-choice-actions.js';

/** Each target's name, for what it does: the picker's tabs, its hints and the line a choice writes all use these. */
const TARGET_LABELS: Readonly<Record<ModelPickerTarget, string>> = {
  main: 'Main chat',
  helper: 'Side work',
  tool: 'Tool work',
  tts: 'Spoken replies',
  embeddings: 'Search index',
  decision: 'Decision model',
};

export function modelPickerTargetLabel(target: ModelPickerTarget): string {
  return TARGET_LABELS[target];
}

/** What the search-index target is for, in one line (the terminal app lists it; it is not a chat model). */
export const SEARCH_INDEX_TARGET_DESCRIPTION = 'Turns memories and code into a form GoodVibes can search. A service, not a chat model.';

export function buildConversationModelPickerTargets(
  configManager: Pick<ConfigManager, 'get'>,
  runtime: { readonly model: string; readonly provider: string },
  resolveProvider: (model: unknown) => string = getProviderIdFromModel,
): ModelPickerTargetInfo<'main' | 'helper' | 'tool' | 'tts' | 'decision'>[] {
  const mainProvider = resolveProvider(configManager.get('provider.model') || runtime.provider).trim();
  const mainModel = String(configManager.get('provider.model') || runtime.model || '').trim();
  const helperProvider = String(configManager.get('helper.globalProvider') ?? '').trim();
  const helperModel = String(configManager.get('helper.globalModel') ?? '').trim();
  const toolProvider = String(configManager.get('tools.llmProvider') ?? '').trim();
  const toolModel = String(configManager.get('tools.llmModel') ?? '').trim();
  const ttsProvider = String(configManager.get('tts.llmProvider') ?? '').trim();
  const ttsModel = String(configManager.get('tts.llmModel') ?? '').trim();
  const decisionChoices = decisionModelChoices(configManager);
  const decisionCurrent = decisionChoices.find((choice) => choice.current);
  const decisionModel = String(configManager.get('judgment.model') ?? '').trim();
  const decisionEndpoint = String(configManager.get('judgment.endpoint') ?? '').trim();

  return [
    {
      target: 'main',
      label: TARGET_LABELS.main,
      description: 'Answers you in conversations and does the work you ask for.',
      provider: mainProvider,
      model: mainModel,
      enabled: true,
      inherited: false,
    },
    {
      target: 'helper',
      label: TARGET_LABELS.helper,
      description: 'Writes the summaries that keep long sessions going and the session titles; none chosen, the tool-work model or the main chat model does it.',
      provider: helperProvider || mainProvider,
      model: helperModel || mainModel,
      enabled: Boolean(configManager.get('helper.enabled')),
      inherited: helperProvider.length === 0 && helperModel.length === 0,
    },
    {
      target: 'tool',
      label: TARGET_LABELS.tool,
      description: 'Does GoodVibes\'s own background work: commit messages, repairing a failed edit, summarizing changes. Choosing a model turns it on.',
      provider: toolProvider || mainProvider,
      model: toolModel || mainModel,
      enabled: Boolean(configManager.get('tools.llmEnabled')),
      inherited: toolProvider.length === 0 && toolModel.length === 0,
    },
    {
      target: 'tts',
      label: TARGET_LABELS.tts,
      description: 'Writes the answers that are read aloud (/voice speak); none chosen, the main chat model writes them.',
      provider: ttsProvider || mainProvider,
      model: ttsModel || mainModel,
      enabled: true,
      inherited: ttsProvider.length === 0 && ttsModel.length === 0,
    },
    {
      target: 'decision',
      label: TARGET_LABELS.decision,
      description: `Decides which actions are safe to run when the mode is ${gatePresetLabel('jev-decides')}; with none set, GoodVibes asks you instead.`,
      provider: decisionEndpoint,
      model: decisionModel,
      enabled: true,
      inherited: false,
      configuredNote: decisionCurrent === undefined || decisionCurrent.id === '__none__'
        ? decisionModelSetNote(decisionCurrent, decisionModel)
        : [decisionCurrent.label, decisionModel, decisionEndpoint].filter(Boolean).join(' · '),
      choices: decisionChoices,
    },
  ];
}

/** The decision target's current line when no listed profile is in force: none, or one set by a custom model id, a key or a fallback. */
function decisionModelSetNote(current: { readonly id: string } | undefined, model: string): string {
  if (current?.id === '__none__') return 'not set';
  return model ? `custom: ${model}` : 'set by a key, an address or a backup model';
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
  readonly picker: { pinnedIds: Set<string>; pinEdits?: number | undefined; loadRecentModels(): Promise<void>; keepingSelection?(change: () => void): void };
  readonly getPinned: () => Promise<string[]>;
  readonly refreshLiveModels: () => Promise<readonly { readonly added: readonly unknown[]; readonly removed: readonly unknown[] }[]>;
}) {
  return {
    refreshLiveModels: async () =>
      (await options.refreshLiveModels()).some((result) => result.added.length > 0 || result.removed.length > 0),
    prefetch: async () => {
      const editsBefore = options.picker.pinEdits;
      const stored = await options.getPinned();
      // A pin flipped while the stored list was loading is newer than that list.
      // The pinned models move to the top: the highlight stays on the model it was on.
      const apply = (): void => { options.picker.pinnedIds = new Set(stored); };
      if (options.picker.pinEdits === editsBefore) {
        if (options.picker.keepingSelection) options.picker.keepingSelection(apply);
        else apply();
      }
      await options.picker.loadRecentModels();
    },
  };
}
