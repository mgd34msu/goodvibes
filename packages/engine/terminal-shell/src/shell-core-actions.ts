import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProviderRegistry, ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import {
  describeEffortForModel,
  describeServingEffort,
  effortPresentationForModel,
  requestedEffortLevel,
  resolveEffortForModelSurface,
  resolveRequestedEffortForServingModel,
  servingEffortForLevel,
  toEffortModel,
} from '@goodvibes-jev/engine/sdk/platform/providers/reasoning-effort-surface';
import { summarizeError, logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { OpenSelection } from './selection-modal.js';
import type { TerminalSlashCommand } from './command-registry.js';
import type { KeyCombo } from './keybindings.js';
interface ShellCoreContext {
  readonly session: { readonly runtime: { model: string; provider: string; reasoningEffort: string; sessionId: string } };
  readonly provider: { readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'> };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'set'> };
  readonly openSelection?: OpenSelection | undefined;
  readonly openModelPicker?: (() => void) | undefined;
  readonly openShortcutsOverlay?: (() => void) | undefined;
  readonly isGenerating?: (() => boolean) | undefined;
  print(message: string): void;
  renderRequest(): void;
}
interface KeybindingsView {
  getConfigPath(): string;
  getAll(): { action: string; combos: KeyCombo[]; description: string }[];
  formatCombo(combo: KeyCombo): string;
}
export function createShellCoreActions<Context extends ShellCoreContext>(
  services: {
    readonly requireProviderApi: (context: Context) => ProviderApi;
    readonly requireKeybindingsManager: (context: Context) => KeybindingsView;
    readonly startFreshConversation: (context: Context) => { readonly savedAs: string | null };
  },
  policy: {
    readonly hidden: boolean;
    readonly modelHint: string;
    readonly choiceMarker: string;
    readonly offeredIndent: string;
    readonly shortcutOverlay: boolean;
    readonly unsupportedEffortAdvice: boolean;
    readonly beforeSelection: (context: Context, provider: string, complete: () => void) => void;
    readonly publishEffort: (context: Context, model: ReturnType<typeof toEffortModel>) => void;
    readonly modelSelected: (model: string, provider: string) => string;
    readonly effortMessage: (level: string, changed: boolean) => string;
    readonly error: (detail: string) => string;
    readonly freshConversation: (context: Context, savedAs: string) => void;
  },
) {
  return {
    model: {
      name: 'model',
      aliases: ['m'],
      description: 'Select or display the current LLM model',
      usage: '[model-id]',
      argsHint: policy.modelHint,
      async handler(args: string[], ctx: Context) {
        const providerApi = services.requireProviderApi(ctx);
        if (args.length === 0) {
          if (ctx.openModelPicker) {
            ctx.openModelPicker();
          } else {
            const models = await providerApi.listModels({ selectableOnly: true });
            const lines = [
              'Available models:',
              ...models.map(
                (model) => `  ${model.current ? '▶' : ' '} ${model.registryKey.padEnd(36)} ${model.displayName} (${model.providerId})`,
              ),
            ];
            ctx.print(lines.join('\n'));
          }
        } else {
          const modelId = args[0];
          if (modelId === undefined) return;
          try {
            const selected = await providerApi.selectModel(modelId);
            // Capture the key for an unconfigured provider inline before the
            // selection is announced, so the switch lands ready to chat.
            policy.beforeSelection(ctx, selected.providerId, () => {
              ctx.session.runtime.model = selected.registryKey;
              ctx.session.runtime.provider = selected.providerId;
              ctx.platform.configManager.set('provider.model', selected.registryKey);
              ctx.print(policy.modelSelected(selected.displayName, selected.providerId));
              // The REQUESTED level may not exist on the model just selected.
              // Re-resolve it here, exactly as the picker's commit path does, so
              // `/model x` and picking x from the picker cannot disagree about
              // what is actually being sent.
              //
              // The resolution reads config (the requested preference) and writes
              // only the session's effective level. Writing the snapped value back
              // over the preference is what used to make the downgrade permanent.
              const switchedTo = toEffortModel(ctx.provider.providerRegistry.getCurrentModel());
              policy.publishEffort(ctx, switchedTo);
              const serving = resolveRequestedEffortForServingModel(ctx.platform.configManager, switchedTo);
              ctx.session.runtime.reasoningEffort = serving.effective ?? '';
              if (serving.requested !== '') {
                ctx.print(policy.effortMessage(describeServingEffort(serving, switchedTo), false));
                if (serving.note) ctx.print(serving.note);
              }
              void providerApi.recordModelUsage(selected.registryKey).catch((err) => {
                logger.debug('model usage record failed', { err });
              });
            });
          } catch (e) {
            ctx.print(policy.error(summarizeError(e)));
          }
        }
      },
    } satisfies TerminalSlashCommand<Context>,
    effort: {
      name: 'effort',
      hidden: policy.hidden,
      aliases: ['e'],
      description: 'Show or set reasoning effort level',
      usage: '[level]',
      // No fixed list here. The accepted levels belong to the serving model, so
      // the old '[instant|low|medium|high]' hint was wrong for every model that
      // offers 'none', 'minimal', 'xhigh' or 'max', and for every model that
      // rejects 'instant'. Running `/effort` with no argument prints the real
      // ones for the model currently in use.
      argsHint: '[level]',
      async handler(args: string[], ctx: Context) {
        // The ModelDefinition (not the provider-api record) is what carries the
        // structured ReasoningEffortSpec the honest wording is generated from.
        const definition = ctx.provider.providerRegistry.getCurrentModel();
        const model = toEffortModel(definition);
        const presentation = effortPresentationForModel(model);
        // Validation of provider.reasoningEffort now happens against these real
        // levels rather than a fixed four-value list.
        policy.publishEffort(ctx, model);

        if (!presentation.configurable) {
          ctx.print(presentation.headline);
          if (presentation.caveat) ctx.print(presentation.caveat);
          return;
        }

        // The user's REQUESTED level, not the session's effective one: this
        // command is where the preference is read back and re-chosen, so it must
        // show what was asked for even while a capped model is serving.
        const current = requestedEffortLevel(ctx.platform.configManager);
        // What the list should open on, though, is the level in EFFECT, the
        // requested level snapped to this model. The requested level may not be
        // in the list at all when the model caps lower, and preselecting a
        // missing id lands the cursor on the lowest level instead of on what is
        // actually running.
        const inEffect = servingEffortForLevel(current, model).effective ?? current;

        const applyLevel = (level: string): void => {
          // An explicit user choice, the one kind of write that is allowed to
          // change the stored preference.
          ctx.platform.configManager.set('provider.reasoningEffort', level);
          const serving = servingEffortForLevel(level, model);
          ctx.session.runtime.reasoningEffort = serving.effective ?? '';
          ctx.print(policy.effortMessage(describeServingEffort(serving, model), true));
          if (serving.note) ctx.print(serving.note);
        };

        if (args.length === 0) {
          if (ctx.openSelection) {
            const items = presentation.choices.map((choice) => ({
              id: choice.level,
              label: choice.level,
              detail: choice.level === inEffect ? `${policy.choiceMarker} ${choice.description}` : choice.description,
            }));
            const options = { preSelectId: inEffect, allowSearch: false };
            ctx.openSelection('Reasoning Effort', items, options, (result) => {
              if (!result) return;
              applyLevel(result.item.id);
              ctx.renderRequest();
            });
            return;
          }
          ctx.print(describeEffortForModel(model, current || undefined).join('\n'));
          return;
        }

        const requested = args[0];
        if (requested === undefined) return;
        if (!presentation.choices.some((choice) => choice.level === requested)) {
          const offered = presentation.choices.map((choice) => choice.level).join(', ');
          // Name the model: "invalid" alone reads as a typo when the real reason
          // is that this particular model does not offer the level.
          const lines = [
            `${definition.displayName} does not offer reasoning effort '${requested}'.`,
            `${policy.offeredIndent}Levels it offers: ${offered}`,
          ];
          if (policy.unsupportedEffortAdvice) {
            const resolved = resolveEffortForModelSurface(requested, model);
            if (resolved.note) lines.push(resolved.note);
            if (presentation.caveat) lines.push(presentation.caveat);
          }
          ctx.print(lines.join('\n'));
          return;
        }

        applyLevel(requested);
      },
    } satisfies TerminalSlashCommand<Context>,
    clear: {
      name: 'clear',
      aliases: ['cls'],
      description: 'Start a fresh conversation (the current one is saved as its own session)',
      handler(_args: string[], ctx: Context) {
        if (ctx.isGenerating?.()) {
          ctx.print('A turn is still running. Stop it with Esc or let it finish, then /clear.');
          return;
        }
        let result: { readonly savedAs: string | null };
        try {
          result = services.startFreshConversation(ctx);
        } catch (e) {
          ctx.print(`Could not save the current conversation, so nothing was cleared: ${summarizeError(e)}`);
          return;
        }
        if (result.savedAs) {
          policy.freshConversation(ctx, result.savedAs);
        }
        ctx.renderRequest();
      },
    } satisfies TerminalSlashCommand<Context>,
    keybindings: {
      name: 'keybindings',
      hidden: policy.hidden,
      aliases: ['kb'],
      description: 'List current keyboard bindings and their config file path',
      handler(_args: string[], ctx: Context) {
        const km = services.requireKeybindingsManager(ctx);
        if (policy.shortcutOverlay) {
          ctx.print(
            'Keybindings config: ' +
              km.getConfigPath() +
              '  (create it to override any binding: { "action": { "key": "x", "ctrl": true } })',
          );
          if (ctx.openShortcutsOverlay) {
            ctx.openShortcutsOverlay();
            return;
          }
        }
        const all = km.getAll();
        const lines: string[] = [
          ...(!policy.shortcutOverlay ? ['Keybindings config: ' + km.getConfigPath(), ''] : []),
          `  ${'Action'.padEnd(28)}  ${'Binding'.padEnd(20)}  Description`,
          `  ${'─'.repeat(28)}  ${'─'.repeat(20)}  ${'─'.repeat(34)}`,
        ];
        for (const { action, combos, description } of all) {
          const label = combos.map((combo) => km.formatCombo(combo)).join(', ');
          lines.push(`  ${action.padEnd(28)}  ${label.padEnd(20)}  ${description}`);
        }
        if (!policy.shortcutOverlay) lines.push('', 'To customize: create the config file with { "action": { "key": "x", "ctrl": true } }');
        ctx.print(lines.join('\n'));
      },
    } satisfies TerminalSlashCommand<Context>,
  };
}
