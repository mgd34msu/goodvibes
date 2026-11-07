import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import {
  describeServingEffort,
  resolveRequestedEffortForServingModel,
  type EffortModelLike,
} from '@goodvibes-jev/engine/sdk/platform/providers/reasoning-effort-surface';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { activeTokens } from './renderer/theme.js';
export interface TerminalModelSelection {
  readonly model: {
    readonly id: string;
    readonly provider: string;
    readonly displayName: string;
    readonly registryKey?: string | undefined;
  };
  readonly effort: string;
  readonly contextCap?: number | null | undefined;
  readonly target?: string | undefined;
  readonly effortChosenByUser?: boolean | undefined;
}
export function createModelSelectionAction(
  options: {
    readonly providerRegistry: Pick<ProviderRegistry, 'setCurrentModel' | 'setModelContextCap'>;
    readonly configManager: ConfigManager;
    readonly conversation: { log(message: string, style: { readonly fg: string }): unknown };
    readonly runtime: { model: string; provider: string; reasoningEffort: string };
    readonly requestRender: () => void;
    readonly completeModelSelectionSideEffect?: (() => void) | undefined;
  },
  policy: {
    readonly setToolEnabled: () => void;
    readonly effortModel: (model: TerminalModelSelection['model']) => EffortModelLike;
    readonly publishEffortOptions: (model: EffortModelLike) => void;
    readonly alwaysShowEffort: boolean;
    readonly noteColor: () => string;
  },
) {
  const { providerRegistry, configManager, conversation, runtime, requestRender, completeModelSelectionSideEffect } = options;
  const select: (selection: TerminalModelSelection) => void = ({ model, effort, contextCap, target, effortChosenByUser }) => {
    if (!model) return;
    const def = model;
    const key = def.registryKey ?? `${def.provider}:${def.id}`;
    const resolvedTarget = target ?? 'main';
    try {
      if (resolvedTarget === 'helper') {
        // Write to helper config keys and enable the helper
        configManager.set('helper.globalProvider', def.provider);
        configManager.set('helper.globalModel', key);
        configManager.set('helper.enabled', true);
        conversation.log(`Helper model set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
      } else if (resolvedTarget === 'tool') {
        // Write to tool LLM config keys and enable the tool LLM
        configManager.set('tools.llmProvider', def.provider);
        configManager.set('tools.llmModel', key);
        policy.setToolEnabled();
        conversation.log(`Tool LLM set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
      } else if (resolvedTarget === 'tts') {
        configManager.set('tts.llmProvider', def.provider);
        configManager.set('tts.llmModel', key);
        conversation.log(`TTS LLM set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
      } else {
        // Default: main provider/model
        if (contextCap != null && contextCap > 0) {
          providerRegistry.setModelContextCap(key, contextCap);
        }
        providerRegistry.setCurrentModel(key);
        runtime.model = key;
        runtime.provider = def.provider;
        // Two levels, kept apart on purpose. Config `provider.reasoningEffort`
        // holds what the USER asked for; `runtime.reasoningEffort` holds what
        // the model now serving will actually receive, which is the requested
        // level snapped DOWN to this model's own levels.
        //
        // Only the picker's effort STEP is a user choice, and only it writes
        // the preference. Every other route into this callback (model-only
        // commit, context-cap commit) carries a level merely carried over
        // from the previous model; storing that is what used to ratchet the
        // preference down for good, one hop through a model that caps at
        // 'medium' and 'xhigh' was gone from config, so hopping back could
        // not restore it.
        //
        // A stored 'xhigh' that becomes 'high' on the wire would make a
        // single-value display a lie, so the display carries BOTH values with
        // their provenance instead (describeServingEffort) rather than the
        // preference being corrupted to match.
        const effortModel = policy.effortModel(def);
        // Publish this model's real levels first, so both the preference
        // write below and a later `config set provider.reasoningEffort` are
        // validated against them.
        policy.publishEffortOptions(effortModel);
        if (effortChosenByUser && effort) configManager.set('provider.reasoningEffort', effort);
        const serving = resolveRequestedEffortForServingModel(configManager, effortModel);
        runtime.reasoningEffort = serving.effective ?? '';
        configManager.set('provider.model', key);
        const ctxNote = contextCap != null && contextCap > 0 ? `, context cap: ${contextCap.toLocaleString()}` : '';
        const effortNote =
          policy.alwaysShowEffort || serving.requested !== '' ? `, effort: ${describeServingEffort(serving, effortModel)}` : '';
        conversation.log(`Switched to model: ${def.displayName} (${def.provider})${effortNote}${ctxNote}`, {
          fg: activeTokens().secondary,
        });
        // The switch receipt already includes requested and effective effort.
      }
    } catch (e) {
      conversation.log(`Error switching model: ${summarizeError(e)}`, { fg: activeTokens().error });
    }
    completeModelSelectionSideEffect?.();
    requestRender();
  };
  return select;
}
