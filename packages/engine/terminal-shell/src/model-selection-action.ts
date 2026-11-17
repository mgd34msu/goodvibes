import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import {
  describeServingEffort,
  resolveRequestedEffortForServingModel,
  type EffortModelLike,
} from '@goodvibes-jev/engine/platform/platform/providers/reasoning-effort-surface';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { activeTokens } from './renderer/theme.js';
/** Keys a model selection writes that hold text. */
type SelectionTextKey =
  | 'helper.globalProvider'
  | 'helper.globalModel'
  | 'tools.llmProvider'
  | 'tools.llmModel'
  | 'tts.llmProvider'
  | 'tts.llmModel'
  | 'provider.reasoningEffort'
  | 'provider.model';

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
    readonly providerRegistry: Pick<ProviderRegistry, 'setCurrentModel' | 'setModelContextCap' | 'getCurrentModel'>;
    readonly configManager: ConfigManager;
    readonly conversation: { log(message: string, style: { readonly fg: string }): unknown };
    readonly runtime: { model: string; provider: string; reasoningEffort: string };
    readonly requestRender: () => void;
    readonly completeModelSelectionSideEffect?: (() => void) | undefined;
  },
  policy: {
    readonly setToolEnabled: () => void;
    readonly effortModel: (model: TerminalModelSelection['model']) => EffortModelLike;
    readonly alwaysShowEffort: boolean;
    readonly noteColor: () => string;
  },
) {
  const { providerRegistry, configManager, conversation, runtime, requestRender, completeModelSelectionSideEffect } = options;
  // True while the picker's own switch runs: its writes to `provider.model` and
  // `provider.reasoningEffort` must not start the reaction below a second time.
  let selecting = false;
  const select: (selection: TerminalModelSelection) => void = (selection) => {
    selecting = true;
    try {
      selectModel(selection);
    } finally {
      selecting = false;
    }
  };
  const selectModel = ({ model, effort, contextCap, target, effortChosenByUser }: TerminalModelSelection): void => {
    if (!model) return;
    const def = model;
    const key = def.registryKey ?? `${def.provider}:${def.id}`;
    const resolvedTarget = target ?? 'main';
    // Every write is recorded so a failure part-way leaves the previous selection, not a mixture of old and new.
    const undo: Array<() => void> = [];
    const write = (configKey: SelectionTextKey, value: string): void => {
      const previous = configManager.get(configKey);
      configManager.set(configKey, value);
      undo.push(() => configManager.set(configKey, previous));
    };
    const enableHelper = (): void => {
      const previous = configManager.get('helper.enabled');
      configManager.set('helper.enabled', true);
      undo.push(() => configManager.set('helper.enabled', previous));
    };
    const previousRuntime = { model: runtime.model, provider: runtime.provider, reasoningEffort: runtime.reasoningEffort };
    try {
      if (resolvedTarget === 'helper') {
        // Write to helper config keys and enable the helper
        write('helper.globalProvider', def.provider);
        write('helper.globalModel', key);
        enableHelper();
        conversation.log(`Helper model set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
      } else if (resolvedTarget === 'tool') {
        // Write to tool LLM config keys and enable the tool LLM
        write('tools.llmProvider', def.provider);
        write('tools.llmModel', key);
        policy.setToolEnabled();
        conversation.log(`Tool LLM set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
      } else if (resolvedTarget === 'tts') {
        write('tts.llmProvider', def.provider);
        write('tts.llmModel', key);
        conversation.log(`TTS LLM set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
      } else {
        // Default: main provider/model
        if (contextCap != null && contextCap > 0) {
          providerRegistry.setModelContextCap(key, contextCap, (reason) => {
            conversation.log(`Context window cap for ${def.displayName} not saved: ${reason}.`, { fg: policy.noteColor() });
          });
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
        if (effortChosenByUser && effort) write('provider.reasoningEffort', effort);
        const serving = resolveRequestedEffortForServingModel(configManager, effortModel);
        runtime.reasoningEffort = serving.effective ?? '';
        write('provider.model', key);
        const ctxNote = contextCap != null && contextCap > 0 ? `, context cap: ${contextCap.toLocaleString()}` : '';
        const effortNote =
          policy.alwaysShowEffort || serving.requested !== '' ? `, effort: ${describeServingEffort(serving, effortModel)}` : '';
        conversation.log(`Switched to model: ${def.displayName} (${def.provider})${effortNote}${ctxNote}`, {
          fg: activeTokens().secondary,
        });
        // The switch receipt already includes requested and effective effort.
      }
    } catch (e) {
      for (const revert of undo.reverse()) {
        try {
          revert();
        } catch {
          /* best effort: the error below is still reported */
        }
      }
      if (runtime.model !== previousRuntime.model) {
        try {
          providerRegistry.setCurrentModel(previousRuntime.model);
        } catch {
          /* the registry keeps the new model; the log line says the switch failed */
        }
      }
      Object.assign(runtime, previousRuntime);
      conversation.log(`Error switching model: ${summarizeError(e)}. The previous selection was restored.`, { fg: activeTokens().error });
      requestRender();
      return;
    }
    completeModelSelectionSideEffect?.();
    requestRender();
  };
  /**
   * Every other writer of the model setting (`/config set`, `/managed apply`,
   * settings sync, a reset in Settings, `/setup transfer import`) changes only
   * the setting. The session follows it here, through the same steps as the
   * picker, so the footer, the saved session and the turns name one model.
   */
  const followModelSetting = (value: unknown): void => {
    const reference = typeof value === 'string' ? value.trim() : '';
    if (selecting || reference === '' || reference === runtime.model) return;
    const previousRuntime = { model: runtime.model, provider: runtime.provider, reasoningEffort: runtime.reasoningEffort };
    try {
      providerRegistry.setCurrentModel(reference);
      const def = providerRegistry.getCurrentModel();
      // A bare id naming the model already in use is the same selection.
      if (def.registryKey === previousRuntime.model) return;
      runtime.model = def.registryKey;
      runtime.provider = def.provider;
      const effortModel = policy.effortModel(def);
      const serving = resolveRequestedEffortForServingModel(configManager, effortModel);
      runtime.reasoningEffort = serving.effective ?? '';
      const effortNote =
        policy.alwaysShowEffort || serving.requested !== '' ? `, effort: ${describeServingEffort(serving, effortModel)}` : '';
      conversation.log(`Switched to model: ${def.displayName} (${def.provider})${effortNote}, from the provider.model setting`, {
        fg: activeTokens().secondary,
      });
      completeModelSelectionSideEffect?.();
    } catch (error) {
      Object.assign(runtime, previousRuntime);
      conversation.log(
        `provider.model is now ${reference}, but this session cannot use it: ${summarizeError(error)}. ` +
          `The session stays on ${previousRuntime.model}; choose a model with /model.`,
        { fg: activeTokens().error },
      );
    }
    requestRender();
  };
  const followEffortSetting = (): void => {
    if (selecting) return;
    try {
      const def = providerRegistry.getCurrentModel();
      const effortModel = policy.effortModel(def);
      const serving = resolveRequestedEffortForServingModel(configManager, effortModel);
      runtime.reasoningEffort = serving.effective ?? '';
      // Any level on the ladder is stored; say when this model will send a different one.
      if (serving.capped) {
        conversation.log(`Reasoning effort saved; this model uses ${describeServingEffort(serving, effortModel)}.`, { fg: policy.noteColor() });
      }
    } catch (error) {
      conversation.log(`Reasoning effort setting not applied to this session: ${summarizeError(error)}.`, { fg: policy.noteColor() });
    }
    requestRender();
  };
  // A narrow host reader without change notices (as the provider registry allows) gets the picker alone.
  configManager.subscribe?.('provider.model', followModelSetting);
  configManager.subscribe?.('provider.reasoningEffort', followEffortSetting);
  return select;
}
