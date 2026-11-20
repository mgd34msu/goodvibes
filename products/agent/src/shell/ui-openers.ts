import { createModelPickerCommandOpeners } from '@goodvibes/engine/terminal-shell/model-picker-open';
import { shortcutGroups } from '../renderer/shortcut-groups.ts';
import { openCommandPaletteOn, type PaletteShortcut } from '@goodvibes/engine/terminal-shell/command-palette';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { runPickedCommand } from '@goodvibes/engine/terminal-shell/command-registry';
import { getProviderIdFromModel } from '@goodvibes/engine/terminal-shell/agent-turn/provider-model';
import { createSettingsWorkspaceOpener } from '@goodvibes/engine/terminal-shell/shell-ui-openers';
import { modelPickerCatalogServices } from '@goodvibes/engine/terminal-shell/model-picker-targets';
import { createCommonShellUiOpeners } from '@goodvibes/engine/terminal-shell/shell-ui-openers';
import { buildConversationModelPickerTargets, selectedModelPickerRoute } from '@goodvibes/engine/terminal-shell/model-picker-targets';
import {
  buildConfiguredViaMap,
  resolveSecretProviderIds as readSecretProviders,
} from '@goodvibes/engine/terminal-shell/model-picker-auth-facts';
import type { ConfigManager } from '../config/index.ts';
import type { ConversationManager } from '../core/conversation';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { ModelDefinition, ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import {
  describeServingEffort,
  effortPresentationForModel,
  requestedEffortLevel,
  servingEffortForLevel,
  toEffortModel,
} from '../providers/reasoning-effort-surface.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import type { SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import type { SecretsManager } from '@goodvibes/engine/platform/platform/config';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import type { ModelPickerTargetInfo } from '../input/model-picker.ts';
import { type ModelPickerOpenDeps } from '../input/model-picker-open.ts';
import { buildLocalFitRecommendations, buildSignInRow, LOCAL_REC_PROVIDER } from '../input/model-picker-local-fit.ts';
import { syncServiceSettingToPlatform } from './service-settings-sync.ts';
import { wireNotificationSurfaces } from './notification-surfaces.ts';
import { confirmThrough } from '../input/confirm-dialog.ts';
import {
  applyThemeModeSettingChange,
  applyThemeNameSettingChange,
  THEME_MODE_CONFIG_KEY,
  THEME_NAME_CONFIG_KEY,
} from '../renderer/theme-mode-config.ts';

type WireShellUiOpenersOptions = {
  commandContext: CommandContext;
  input: InputHandler;
  conversation: ConversationManager;
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  runtime: MutableRuntimeState;
  featureFlags: FeatureFlagManager;
  mcpRegistry: McpRegistry;
  subscriptionManager: SubscriptionManager;
  secretsManager?: Pick<SecretsManager, 'delete' | 'get' | 'set'>;
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  workingDirectory: string;
  homeDirectory: string;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  render: () => void;
};

/**
 * Derive the configuredVia tier for a provider.
 * Tier order mirrors platform provider-routes.ts: env → secrets → subscription → undefined.
 * The preResolvedSecretKeys set is pre-fetched async before the sync picker render cycle.
 */

/**
 * Build a configuredViaMap for the given provider list.
 * Pass preResolvedSecretKeys (from an async SecretsManager batch) to surface the 'secrets' tier.
 */

export function wireShellUiOpeners(options: WireShellUiOpenersOptions): void {
  const {
    commandContext,
    input,
    conversation,
    configManager,
    providerRegistry,
    runtime,
    featureFlags,
    mcpRegistry,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    workingDirectory,
    homeDirectory,
    getConfiguredProviderIds,
    getPinned,
    render,
  } = options;

  /**
   * Pre-resolve which provider IDs have secrets-manager keys (async batch, platform tier pattern).
   * Returns a set of provider IDs (not env var names) that are secrets-backed.
   * Falls back to empty set if secretsManager is not provided.
   */
  async function resolveSecretProviderIds(): Promise<ReadonlySet<string>> {
    return readSecretProviders(getConfiguredProviderIds, secretsManager);
  }

  const getCurrentModelForPickerTarget = () =>
    selectedModelPickerRoute(configManager, runtime, input.modelPicker.getSelectedTargetInfo()?.target ?? input.modelPicker.target).model;

  const getCurrentProviderForPickerTarget = () =>
    selectedModelPickerRoute(configManager, runtime, input.modelPicker.getSelectedTargetInfo()?.target ?? input.modelPicker.target)
      .provider;

  const buildModelPickerTargets = (): ModelPickerTargetInfo[] => {
    return buildConversationModelPickerTargets(configManager, runtime, getProviderIdFromModel);
  };

  // The picker opens at once on the cached catalog; the credential-source
  // reads and the live model re-check fill in after (input/model-picker-open.ts).
  // With no provider configured, the list leads with hardware-fit local
  // recommendations and the sign-in row (reachable, but never displacing them),
  // and the best-fit recommendation is preselected.
  const pickerModels = (): ModelDefinition[] => {
    const catalogModels = providerRegistry.getSelectableModels();
    return getConfiguredProviderIds().length === 0
      ? [...buildLocalFitRecommendations(), buildSignInRow(), ...catalogModels]
      : catalogModels;
  };
  const pickerOpenDeps: ModelPickerOpenDeps = {
    ...modelPickerCatalogServices({
      picker: input.modelPicker,
      getPinned,
      refreshLiveModels: async () => (await providerRegistry.refreshLiveModelDiscovery?.()) ?? [],
    }),
    picker: input.modelPicker,
    render,
    listModels: pickerModels,
    listProviders: () => [...new Set(providerRegistry.listModels().map((model) => model.provider))],
    currentModelId: () => {
      const first = getConfiguredProviderIds().length === 0 ? pickerModels()[0] : undefined;
      return first ? (first.registryKey ?? first.id) : getCurrentModelForPickerTarget();
    },
    currentProviderId: getCurrentProviderForPickerTarget,
    configuredProviderIds: () => new Set(getConfiguredProviderIds()),
    unreachableProviders: () => providerRegistry.unreachableAtStartup(),
    buildConfiguredVia: (ids, configured, secretIds) =>
      buildConfiguredViaMap(
        ids.filter((p) => p !== LOCAL_REC_PROVIDER),
        new Set(configured),
        subscriptionManager,
        secretIds,
      ),
    buildTargets: buildModelPickerTargets,
    resolveSecretProviderIds,
    onError: (error) => {
      commandContext.print?.(`Model picker could not load everything: ${error instanceof Error ? error.message : String(error)}`);
      render();
    },
  };

  Object.assign(commandContext, createModelPickerCommandOpeners(pickerOpenDeps, input));

  commandContext.openReasoningEffortPicker = () => {
    const currentModel = providerRegistry.getCurrentModel();
    const model = toEffortModel(currentModel);
    // Only this model's real levels, a fallback-sourced guess does not get an
    // automatic picker step, since the platform's OpenAI/Gemini adapters drop the
    // level entirely for a model nothing recognises.
    const presentation = effortPresentationForModel(model);
    if (!presentation.configurable) {
      return { opened: false, model: currentModel.displayName, levels: [], reason: 'unsupported' };
    }

    // The user's REQUESTED level, not the session's effective one: this picker
    // re-chooses the preference, so it must preselect what was asked for even
    // while a model that caps lower is serving.
    const requested = requestedEffortLevel(configManager);
    // Open on the level in EFFECT, the requested level snapped to this model.
    // A requested level the model caps below is not in the list at all, and
    // preselecting a missing id lands on the lowest level rather than on what
    // is actually running.
    const current =
      (requested ? servingEffortForLevel(requested, model).effective : undefined) ?? requested ?? presentation.choices[0]?.level ?? '';
    input.openSelection(
      'Reasoning Effort',
      presentation.choices.map((choice) => ({
        id: choice.level,
        label: choice.level,
        detail: choice.level === current ? `current - ${choice.description}` : choice.description,
      })),
      { preSelectId: current, allowSearch: false },
      (result) => {
        if (!result) return;
        const level = result.item.id;
        // An explicit user choice, the one kind of write that is allowed to
        // change the stored preference.
        configManager.set('provider.reasoningEffort', level);
        const serving = servingEffortForLevel(level, model);
        runtime.reasoningEffort = serving.effective ?? '';
        commandContext.print(['Reasoning effort set', `  level ${describeServingEffort(serving, model)}`].join('\n'));
        render();
      },
    );
    return {
      opened: true,
      model: currentModel.displayName,
      levels: presentation.choices.map((choice) => choice.level),
    };
  };

  Object.assign(commandContext, createCommonShellUiOpeners({ input, commandContext, render }));

  commandContext.openProcessModal = () => {
    input.processModal.open();
    render();
  };

  commandContext.openLiveTail = (target?: string) => {
    input.processModal.refresh();
    const entries = input.processModal.entries;
    if (entries.length === 0) {
      return { opened: false, reason: 'no_processes' };
    }

    const normalizedTarget = target?.trim().toLowerCase() ?? '';
    const entry =
      normalizedTarget.length > 0
        ? entries.find(
            (candidate) => candidate.id.toLowerCase() === normalizedTarget || candidate.label.toLowerCase().includes(normalizedTarget),
          )
        : (input.processModal.getSelected() ?? entries[0]);

    if (!entry) {
      return { opened: false, reason: 'not_found' };
    }

    // An open monitor comes back when Esc closes the live tail (one stack level).
    input.processModal.close();
    input.liveTailModal.open(entry);
    render();
    return { opened: true, processId: entry.id, label: entry.label };
  };

  commandContext.openConversationSearch = (query?: string) => {
    input.searchManager.open();
    const searchQuery = query?.trim() ?? '';
    if (searchQuery.length > 0) {
      input.searchManager.search(searchQuery, input.getHistory(), conversation);
    }
    render();
  };

  commandContext.openPromptHistorySearch = (query?: string) => {
    input.historySearch.open(input.prompt);
    const searchQuery = query?.trim() ?? '';
    if (searchQuery.length > 0) {
      input.historySearch.search(searchQuery);
    }
    render();
  };

  commandContext.openSlashCommandMode = (query?: string): boolean => {
    const normalizedQuery = query?.trim().replace(/^\/+/, '') ?? '';
    if (input.prompt.length > 0 && !input.prompt.startsWith('/')) {
      return false;
    }

    input.commandMode = true;
    if (input.prompt.length === 0 || !input.prompt.startsWith('/') || normalizedQuery.length > 0) {
      input.saveUndoState();
      input.prompt = `/${normalizedQuery}`;
      input.cursorPos = input.prompt.length;
    }

    input.autocomplete?.update(input.prompt.startsWith('/') ? input.prompt.slice(1) : '');
    input.ensureInputCursorVisible();
    render();
    return true;
  };

  commandContext.openFilePicker = (options): boolean => {
    const injectMode = Boolean(options?.injectMode);
    const query = options?.query?.trim() ?? '';
    const marker = `${injectMode ? '!@' : '@'}${query}`;
    const insertPos = input.cursorPos;
    input.saveUndoState();
    input.prompt = input.prompt.slice(0, insertPos) + marker + input.prompt.slice(insertPos);
    input.cursorPos = insertPos + marker.length;
    input.filePicker.open(insertPos, injectMode);
    if (query.length > 0) input.filePicker.setQuery(query);
    input.ensureInputCursorVisible();
    render();
    return true;
  };

  commandContext.openBlockActions = (): boolean => {
    if (input.prompt.trim().length > 0 || input.commandMode) {
      return false;
    }
    const nearest = conversation.findNearestBlock(input.getScrollTop());
    if (!nearest) {
      return false;
    }
    input.blockActionsMenu.open(nearest);
    render();
    return true;
  };

  // The one confirmation rule for typed commands (command-confirmation.ts) asks here.
  commandContext.confirm = (confirmOptions) => confirmThrough(input.surfaceModals, confirmOptions);
  // A described command's guided panel (command-actions/panel.ts) is a kit modal on the same stack.
  commandContext.pushSurfaceModal = (modal) => input.surfaceModals.push(modal);
  // The command palette the TUI has (terminal-shell/command-palette.ts): every
  // registered command, built when it opens; Enter on a described command opens its guided path.
  commandContext.openCommandPalette = () => openCommandPaletteOn({
    modals: input.surfaceModals,
    commands: () => input.commandRegistry?.getAll(),
    categories: () => new Map((input.commandRegistry?.getAll() ?? []).flatMap((command) => command.described ? [[command.name, command.described.group] as const] : [])),
    // The keyboard shortcuts, the list's last group, from the live key table.
    shortcuts: () => paletteShortcuts(commandContext.workspace?.keybindingsManager),
    run: (name, args) => runPickedCommand(commandContext.executeCommand, name, [...args], (message) => commandContext.print(message)),
    fill: (name) => {
      input.prompt = `/${name} `;
      input.cursorPos = input.prompt.length;
      input.commandMode = true;
      input.autocomplete?.reset();
      commandContext.focusPrompt?.();
    },
    render,
  });
  commandContext.openSettingsModal = createSettingsWorkspaceOpener({
    configure: () => {
      input.settingsModal.open(configManager, featureFlags, subscriptionManager, serviceRegistry, mcpRegistry, secretsManager, {
        requestRender: render,
        reportError: (message: string) => {
          commandContext.print?.(message);
          render();
        },
        onSettingApplied: (change) => {
          // Forced dark/light applies immediately (mode flip + full
          // repaint via clearScreen's resetDiff); auto only re-probes at startup,
          // so it takes effect next launch (stated honestly).
          if (String(change.key) === THEME_MODE_CONFIG_KEY) {
            return applyThemeModeSettingChange(change.value, () => commandContext.clearScreen?.());
          }
          // Theme changes apply immediately: rebuild palettes + full repaint.
          if (String(change.key) === THEME_NAME_CONFIG_KEY) {
            return applyThemeNameSettingChange(change.value, () => commandContext.clearScreen?.());
          }
          // The owner keep-awake toggle no longer needs a bespoke live-apply
          // here: services.ts wires wireRuntimePower's subscribeConfig option
          // (the platform's own PowerManager config subscription), so setDynamic's
          // persist above already flips the real local inhibitor, and a
          // separate configManager.subscribe('power.keepAwake', ...) in
          // services.ts forwards the toggle to an adopted daemon over the wire
          // when one is reachable, both fire from the config change itself,
          // not from this settings-modal callback.
          return syncServiceSettingToPlatform({ configManager, workingDirectory, homeDirectory }, change);
        },
      });
    },
    selectTarget: (target) => input.settingsModal.selectTarget(target),
    render,
  });

  commandContext.openAgentWorkspace = (categoryId?: string) => {
    input.openAgentWorkspace(commandContext, categoryId);
    render();
  };

  commandContext.openAgentSetupRows = (actionIds) => {
    input.openAgentWorkspace(commandContext, 'setup', 'SETUP');
    input.agentWorkspace.showOnlyActions(actionIds);
    render();
  };

  commandContext.dismissAgentWorkspace = () => input.dismissAgentWorkspace();

  commandContext.openWorkspacePicker = () => {
    conversation.setSplashSuppressed(false);
    input.openAgentWorkspace(commandContext, 'home');
    conversation.rebuildHistory();
    render();
  };

  // System notices: toasts plus the /notifications history (notification-surfaces.ts).
  wireNotificationSurfaces({ commandContext, input, render });
}

/** Every row of the shortcut groups, as the help palette lists them. */
function paletteShortcuts(keybindingsManager: KeybindingsManager | undefined): readonly PaletteShortcut[] {
  if (!keybindingsManager) return [];
  return [
    ...shortcutGroups(keybindingsManager).flatMap((group) => group.items.map(([key, description]) => ({ key, description }))),
    { key: 'keybindings.json', description: 'Change any key in its file', detail: `Edit ${keybindingsManager.getConfigPath()}: { "action": { "key": "x", "ctrl": true } }.` },
  ];
}
