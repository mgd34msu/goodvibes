import { createModelPickerCommandOpeners } from '@goodvibes/engine/terminal-shell/model-picker-open';
import { choosableProviderIds } from '@goodvibes/engine/terminal-shell/first-run';
import { shortcutGroups } from '../renderer/shortcut-groups.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import type { SettingsScreenProgram } from '@goodvibes/engine/terminal-shell/places';
import { openTtsProviderPicker, openTtsVoicePicker } from '../input/tts-settings-actions.ts';
import { openThemePicker } from '../input/theme-settings-actions.ts';
import { modelPickerCatalogServices } from '@goodvibes/engine/terminal-shell/model-picker-targets';
import { createCommonShellUiOpeners } from '@goodvibes/engine/terminal-shell/shell-ui-openers';
import { runPickedCommand } from '@goodvibes/engine/terminal-shell/command-registry';
import {
  buildConversationModelPickerTargets,
  modelPickerTargetLabel,
  SEARCH_INDEX_TARGET_DESCRIPTION,
  selectedModelPickerRoute,
} from '@goodvibes/engine/terminal-shell/model-picker-targets';
import {
  buildConfiguredViaMap,
  resolveSecretProviderIds as readSecretProviders,
} from '@goodvibes/engine/terminal-shell/model-picker-auth-facts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { type ModelPickerOpenDeps } from '../input/model-picker-open.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { ShellViews } from '../views/builtin-views.ts';
import type { ViewPanelAdapter } from '../views/view-panel-adapter.ts';
import { wireViewOpeners } from './view-openers.ts';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import type { SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import type { SecretsManager } from '@goodvibes/engine/platform/platform/config';
import type { MemoryEmbeddingProviderRegistry } from '@goodvibes/engine/platform/platform/state';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import type { EmbeddingProviderPickerEntry, ModelPickerTargetInfo } from '../input/model-picker.ts';
import { openCommandPaletteOn, type PaletteShortcut } from '@goodvibes/engine/terminal-shell/command-palette';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { AGENT_VIEW_NAMES, CHANGES_VIEW_NAMES } from '../input/views.ts';
import { confirmThrough } from '../input/confirm-dialog.ts';
import { categorizeBuiltinCommands } from '../input/commands.ts';
import { syncServiceSettingToPlatform } from './service-settings-sync.ts';
import { takeAppliedThemeMessage } from '../renderer/theme-mode-config.ts';
import { routeSettingWrites } from '@goodvibes/engine/terminal-shell/settings-writes';
import { runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { isSecretConfigKey } from '@goodvibes/engine/platform/platform/config';
import { capabilityBinding } from '../input/commands/capability-binding.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { buildFirstOpenItems, decodeFirstOpenChoice, readFolderTrustFacts, selfRecordWorkspaceRegistration } from '../cli/tui-startup.ts';
import { WorkspaceTrustDecisionUnsettledError, type WorkspaceTrustLevel } from '@goodvibes/engine/platform/platform/runtime/operations';

type WireShellUiOpenersOptions = {
  commandContext: CommandContext;
  input: InputHandler;
  /** The read models and config-modal surfaces behind the built-in modals. */
  views: ShellViews;
  /** The operator API's panels.list / panels.open, answered by the modal views. */
  viewPanelAdapter: ViewPanelAdapter;
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  runtime: MutableRuntimeState;
  featureFlags: FeatureFlagManager;
  mcpRegistry: McpRegistry;
  subscriptionManager: SubscriptionManager;
  secretsManager?: Pick<SecretsManager, 'delete' | 'get' | 'set'>;
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  /** Backs the model picker's 'embeddings' target and its own item-list mode. */
  memoryEmbeddingRegistry: Pick<MemoryEmbeddingProviderRegistry, 'getDefaultProviderId' | 'setDefaultProvider' | 'status'>;
  workingDirectory: string;
  homeDirectory: string;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  /** Hear PROVIDERS_CHANGED, so an open model picker shows a fresh list when it arrives. */
  onProvidersChanged?: ((listener: () => void) => () => void) | undefined;
  render: () => void;
  /** Trust-at-consequence-time bridge, patched here with the real modal-driving implementation. */
  trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel>; awaitingOwner?: boolean };
};

let commandCategoryMapCache: Map<string, string> | null = null;

/** The TUI's former view names find the modal that holds them now (the palette's extra search words). */
const PALETTE_VIEW_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['agents', AGENT_VIEW_NAMES],
  ['changes', CHANGES_VIEW_NAMES],
]);

/**
 * Map each built-in command name to its reference category, memoized. Drives
 * the command palette's category grouping from the same single source of truth
 * as the generated docs (categorizeBuiltinCommands), so the palette is always
 * registry-derived and never a hand-maintained list.
 */
function getCommandCategoryMap(): Map<string, string> {
  if (!commandCategoryMapCache) {
    commandCategoryMapCache = new Map(categorizeBuiltinCommands().map((entry) => [entry.command.name, entry.category]));
  }
  return commandCategoryMapCache;
}

/**
 * Derive the configuredVia tier for a provider.
 * Tier order mirrors platform provider-routes.ts: env → secrets → subscription → undefined.
 * The preResolvedSecretKeys set is pre-fetched async before the sync picker render cycle.
 */

/**
 * Build a configuredViaMap for the given provider list.
 * Pass preResolvedSecretKeys (from an async SecretsManager batch) to surface the 'secrets' tier.
 */

/** What this app gives the settings screen both programs show (terminal-shell settings-screen), wired with the places. */
export interface WiredShellUiOpeners {
  readonly settings: SettingsScreenProgram;
}

export function wireShellUiOpeners(options: WireShellUiOpenersOptions): WiredShellUiOpeners {
  const {
    commandContext,
    input,
    views,
    viewPanelAdapter,
    configManager,
    providerRegistry,
    runtime,
    featureFlags,
    mcpRegistry,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    memoryEmbeddingRegistry,
    workingDirectory,
    homeDirectory,
    getConfiguredProviderIds,
    getPinned,
    render,
    trustPromptRef,
  } = options;

  // The trust prompt: asked as the program opens in a folder with no decision
  // (tui-startup.ts askTrustOnOpen), and by trustGatedAsk when a non-read
  // request reaches it in a folder still undecided; the answer persists via setLevel().
  // Registration self-records here too when trusted (never for restricted,
  // see selfRecordWorkspaceRegistration's doc). A dismissed prompt, or no
  // selection surface to ask on, rejects as unsettled: nothing is saved, the
  // request is refused and the next non-read request asks again.
  trustPromptRef.requestTrustDecision = () =>
    new Promise((resolve, reject) => {
      const { title, items } = buildFirstOpenItems(readFolderTrustFacts(workingDirectory, homeDirectory, String(configManager.get('tools.hooksFile') ?? '')));
      if (!commandContext.openSelection) {
        reject(new WorkspaceTrustDecisionUnsettledError());
        return;
      }
      // While the question is open the turn waits on the owner, not the model (the throbber says so).
      trustPromptRef.awaitingOwner = true;
      // It opens by itself (on opening, or when the folder gained hooks or MCP files): typing in flight stays in the composer.
      // The cursor starts on "Keep restricted": Enter pressed straight away trusts nothing.
      commandContext.openSelection(title, items, { allowSearch: false, primaryVerbLabel: 'Choose', unprompted: true, preSelectId: 'restricted' }, (result) => {
        trustPromptRef.awaitingOwner = false;
        const level = decodeFirstOpenChoice(result?.item.id ?? null);
        if (level === null) {
          reject(new WorkspaceTrustDecisionUnsettledError());
          render();
          return;
        }
        resolve(level);
        if (level === 'trusted') void selfRecordWorkspaceRegistration(commandContext.workspace?.workspaceRegistrationManager);
        render();
      });
    });

  /**
   * Pre-resolve which provider IDs have secrets-manager keys (async batch, platform tier pattern).
   * Returns a set of provider IDs (not env var names) that are secrets-backed.
   * Falls back to empty set if secretsManager is not provided.
   */
  async function resolveSecretProviderIds(): Promise<ReadonlySet<string>> {
    return readSecretProviders(getConfiguredProviderIds, secretsManager);
  }

  const getCurrentModelForPickerTarget = () =>
    selectedModelPickerRoute(configManager, runtime, input.modelPicker.getSelectedTargetInfo()?.target ?? input.modelPicker.target, () =>
      memoryEmbeddingRegistry.getDefaultProviderId(),
    ).model;

  const getCurrentProviderForPickerTarget = () =>
    selectedModelPickerRoute(configManager, runtime, input.modelPicker.getSelectedTargetInfo()?.target ?? input.modelPicker.target, () =>
      memoryEmbeddingRegistry.getDefaultProviderId(),
    ).provider;

  /**
   * Fetch the embedding-provider status list once per picker-open and shape
   * it into the picker's own tiny item type. Uses the registry's async
   * `.status()` (not the sync `.list()`) specifically because `.list()` does
   * not carry `configured`, and unconfigured providers must be shown
   * honestly, not hidden.
   */
  async function resolveEmbeddingProviderEntries(): Promise<EmbeddingProviderPickerEntry[]> {
    const statuses = await memoryEmbeddingRegistry.status();
    return statuses.map((status) => ({
      id: status.id,
      label: status.label,
      dimensions: status.dimensions,
      configured: status.configured,
      ...(status.detail ? { detail: status.detail } : {}),
    }));
  }

  const buildModelPickerTargets = (embeddingEntries: EmbeddingProviderPickerEntry[]): ModelPickerTargetInfo[] => {
    const embeddingProviderId = memoryEmbeddingRegistry.getDefaultProviderId();
    const embeddingEntry = embeddingEntries.find((entry) => entry.id === embeddingProviderId);
    const embeddingNote = embeddingEntry
      ? `${embeddingEntry.id} · ${embeddingEntry.dimensions}d${embeddingEntry.configured ? '' : ' · unconfigured'}`
      : `${embeddingProviderId} · unregistered`;

    return [
      ...buildConversationModelPickerTargets(configManager, runtime),
      {
        target: 'embeddings',
        label: modelPickerTargetLabel('embeddings'),
        description: SEARCH_INDEX_TARGET_DESCRIPTION,
        provider: embeddingProviderId,
        model: '',
        enabled: true,
        inherited: false,
        configuredNote: embeddingNote,
      },
    ];
  };

  // The picker opens at once on the cached catalog; the credential-source
  // reads, the embeddings probe and the live model re-check fill in after
  // (input/model-picker-open.ts). getSelectableModels() and listModels() can
  // name catalog providers this runtime never registered; both lists keep
  // runtime-registered providers only, so the picker never offers a model
  // that fails with "Provider not registered" at turn time.
  const pickerOpenDeps: ModelPickerOpenDeps = {
    ...modelPickerCatalogServices({
      picker: input.modelPicker,
      getPinned,
      // An empty picker reads every list again past each stored one (force); otherwise each list's own age decides.
      refreshLiveModels: async (force) => (await providerRegistry.refreshLiveModelDiscovery?.(undefined, force ? { force: true } : {})) ?? [],
    }),
    picker: input.modelPicker,
    render,
    ...(options.onProvidersChanged ? { onModelsChanged: options.onProvidersChanged } : {}),
    listModels: () => providerRegistry.getSelectableModels().filter((m) => providerRegistry.has(m.provider)),
    // The same list first run counts: providers with a model, the internal router left out.
    listProviders: () => choosableProviderIds(providerRegistry),
    currentModelId: getCurrentModelForPickerTarget,
    currentProviderId: getCurrentProviderForPickerTarget,
    configuredProviderIds: () => new Set(getConfiguredProviderIds()),
    unreachableProviders: () => providerRegistry.unreachableAtStartup(),
    buildConfiguredVia: (ids, configured, secretIds) =>
      buildConfiguredViaMap([...ids], new Set(configured), subscriptionManager, secretIds),
    buildTargets: buildModelPickerTargets,
    resolveSecretProviderIds,
    resolveEmbeddingProviders: resolveEmbeddingProviderEntries,
    onError: (error) => {
      commandContext.print?.(`Model picker could not load everything: ${summarizeError(error)}`);
      render();
    },
  };

  Object.assign(commandContext, createModelPickerCommandOpeners(pickerOpenDeps, input));

  commandContext.completeEmbeddingProviderSelection = (providerId: string) => {
    try {
      memoryEmbeddingRegistry.setDefaultProvider(providerId);
    } catch (error: unknown) {
      commandContext.print?.(`Failed to set embedding provider: ${summarizeError(error)}`);
    }
    render();
  };

  Object.assign(commandContext, createCommonShellUiOpeners({ input, commandContext, render }));

  commandContext.openOnboardingWizard = (modeOrOptions) => input.openOnboardingWizard(modeOrOptions);

  // Mirrors the Ctrl+F chord's own toggle exactly (handler-shortcuts.ts's
  // 'search' case); the transcript search bar is not a modal on the stack.
  commandContext.openTranscriptSearch = () => {
    if (input.searchManager.active) input.searchManager.close(input.conversationManager);
    else input.searchManager.open();
    render();
  };

  // A setting this app's own pickers and switches change goes through the daemon's settings.set (settings-writes.ts).
  routeSettingWrites(async (ctx, key, value) => {
    await runDaemonCapability('settings.set', { key, value: isSecretConfigKey(key) ? String(value ?? '') : JSON.stringify(value ?? '') }, ctx as CommandContext, capabilityBinding);
  });
  // The settings screen both programs show (terminal-shell settings-screen), opened through the places
  // (interactive.ts sets openSettingsModal once they are wired): what this app keeps and the pickers it draws.
  const settings: SettingsScreenProgram = {
    program: 'tui',
    configManager,
    featureFlags,
    mcpRegistry,
    subscriptions: { manager: subscriptionManager, services: serviceRegistry },
    // Only the providers this runtime registered, as the model picker lists them.
    models: () => providerRegistry.getSelectableModels().filter((model) => providerRegistry.has(model.provider))
      .map((model) => ({ id: model.id, provider: model.provider, displayName: model.displayName })),
    pickers: {
      theme: (context) => openThemePicker(context as CommandContext),
      ttsProvider: (context) => openTtsProviderPicker(context as CommandContext),
      ttsVoice: (context) => openTtsVoicePicker(context as CommandContext),
    },
    afterChange: (change) => {
      // A theme change was applied by the start-up theme subscription
      // (renderer/terminal-bg-probe.ts); this only reports what it did.
      const themeMessage = takeAppliedThemeMessage(String(change.key));
      if (themeMessage !== undefined) return { message: themeMessage };
      const builtinSetting = configManager.getSchema().find((setting) => setting.key === change.key);
      if (!builtinSetting) return;
      // This machine's service follows a change of the service settings (installed, started, stopped, removed):
      // the daemon keeps the setting, and this app does the service manager's part, after the daemon took it.
      return syncServiceSettingToPlatform({ configManager, workingDirectory, homeDirectory }, { ...change, key: builtinSetting.key });
    },
  };

  // Open a config-modal surface by name (or by an old name that redirects to
  // one, e.g. 'accounts' opens 'providers-modal'). Surfaces are registered in
  // builtin-modals.ts; a name with no registered surface degrades honestly to
  // a print rather than a blank modal.
  // There is one config modal at a time (opening another swaps the surface),
  // so it is one object on the modal stack, 'config' (input/handler.ts).
  // Some legacy view-name redirects (and migrated front-doors) resolve to a NATIVE
  // modal that is not a ConfigModalSurface, e.g. `sessions` -> `sessionPicker`,
  // where 'sessionPicker' is the real session-picker modal opened by
  // commandContext.openSessionPicker below, NOT a registered config surface.
  // getModalSurface can never find these, so consult this small name->opener
  // dispatch FIRST. Each entry reuses the same opener the front-door command
  // uses (no duplicated open logic); resolved lazily so wiring order does not
  // matter. Any name that is neither a native modal nor a registered surface
  // still falls through to the honest "not available" print below.
  const nativeModalOpeners: Record<string, () => void> = {
    // openSessionPicker is wired below in this same function; call it lazily
    // (optional-chained for the type, always present at invoke time).
    sessionPicker: () => commandContext.openSessionPicker?.(),
  };

  commandContext.openModal = (name: string) => {
    const openNative = nativeModalOpeners[name];
    if (openNative) {
      openNative();
      return;
    }
    const registry = views.modalSurfaces;
    const surface = registry.getModalSurface(name) ?? registry.getModalSurface(registry.getModalRedirect(name) ?? '');
    if (!surface) {
      commandContext.print(`'${name}' is not available yet in this build.`);
      render();
      return;
    }
    input.configModal.open(surface, render);
    render();
  };

  // Registry-driven surfaces built inside command handlers (/help) group by
  // the same categories as the palette and the generated reference.
  commandContext.getCommandCategories = () => getCommandCategoryMap();

  input.surfaceModals.onChange = render;
  commandContext.confirm = (options) => confirmThrough(input.surfaceModals, options);
  // A described command's guided panel (command-actions/panel.ts) is a kit modal on the same stack.
  commandContext.pushSurfaceModal = (modal) => input.surfaceModals.push(modal);

  commandContext.openCommandPalette = () => {
    // Built live from the command registry when it opens; category labels come
    // from the same source the generated docs use (getCommandCategoryMap).
    openCommandPaletteOn({
      modals: input.surfaceModals,
      // The listed commands only: an unlisted one (it opens its place) is typed, never offered.
      commands: () => input.commandRegistry?.getVisible(),
      categories: getCommandCategoryMap,
      extraKeywords: PALETTE_VIEW_KEYWORDS,
      // The keyboard shortcuts, the list's last group, from the live key table.
      shortcuts: () => paletteShortcuts(commandContext.workspace?.keybindingsManager),
      describe: (id) => (id === 'model' ? commandContext.session.runtime.model || undefined : undefined),
      // Suggested's counts, kept beside input history, and only where history is kept.
      usageFile: configManager.get('behavior.saveHistory') === false ? undefined : commandContext.workspace?.shellPaths?.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'palette-usage.json'),
      // A command gone since the palette opened, or one that refuses, says so like a typed one.
      run: (name, args) => runPickedCommand(commandContext.executeCommand, name, [...args], (message) => commandContext.print(message)),
      fill: (name) => {
        // The command and a trailing space so the inline args hint shows what it wants.
        input.prompt = `/${name} `;
        input.cursorPos = input.prompt.length;
        input.commandMode = true;
        input.autocomplete?.reset();
        commandContext.focusPrompt?.();
      },
      render,
    });
  };

  wireViewOpeners({ commandContext, input, views, viewPanelAdapter, render });
  return { settings };
}

/** Every row of the shortcut groups, as the help palette lists them. */
function paletteShortcuts(keybindingsManager: KeybindingsManager | undefined): readonly PaletteShortcut[] {
  if (!keybindingsManager) return [];
  return [
    ...shortcutGroups(keybindingsManager).flatMap((group) => group.items.map(([key, description]) => ({ key, description }))),
    { key: 'keybindings.json', description: 'Change any key in its file', detail: `Edit ${keybindingsManager.getConfigPath()}: { "action": { "key": "x", "ctrl": true } }.` },
  ];
}
