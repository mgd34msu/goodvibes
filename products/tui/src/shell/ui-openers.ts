import { createModelPickerCommandOpeners } from '@goodvibes/engine/terminal-shell/model-picker-open';
import { shortcutGroups } from '../renderer/shortcut-groups.ts';
import { createSettingsWorkspaceOpener } from '@goodvibes/engine/terminal-shell/shell-ui-openers';
import { modelPickerCatalogServices } from '@goodvibes/engine/terminal-shell/model-picker-targets';
import { createCommonShellUiOpeners } from '@goodvibes/engine/terminal-shell/shell-ui-openers';
import { runPickedCommand } from '@goodvibes/engine/terminal-shell/command-registry';
import { buildConversationModelPickerTargets, selectedModelPickerRoute } from '@goodvibes/engine/terminal-shell/model-picker-targets';
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
import { AGENT_VIEW_NAMES, CHANGES_VIEW_NAMES, USAGE_VIEW_NAMES } from '../input/views.ts';
import { confirmThrough } from '../input/confirm-dialog.ts';
import { categorizeBuiltinCommands } from '../input/commands.ts';
import { syncServiceSettingToPlatform } from './service-settings-sync.ts';
import { classifyServiceSettingChange } from '@goodvibes/engine/terminal-shell/service-setting-change';
import { takeAppliedThemeMessage } from '../renderer/theme-mode-config.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { buildFirstOpenItems, decodeFirstOpenChoice, selfRecordWorkspaceRegistration } from '../cli/tui-startup.ts';
import type { SettingsDaemonCredentialWriter } from '../input/settings-modal-secrets.ts';
import type { DaemonOwnedConfigWriter } from '../input/settings-modal-mutations.ts';
import type { WorkspaceTrustLevel } from '@goodvibes/engine/platform/platform/runtime/operations';

/** Longer than one frame of the render coalescer (16 ms), so the "applying" message is on screen first. */
const SERVICE_APPLY_AFTER_PAINT_MS = 20;

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
  /**
   * The daemon's credential write. Present when a daemon is configured; a
   * daemon-scoped credential goes there rather than into this surface's own
   * store, which the daemon never reads.
   */
  daemonCredentials?: SettingsDaemonCredentialWriter | null;
  /**
   * Where a daemon-owned setting is written. `surfaces.*`, `watchers.*`,
   * `automation.*` and the rest are applied by the daemon; writing one into
   * this surface's own file reports success and configures nothing.
   */
  daemonConfig?: DaemonOwnedConfigWriter | null;
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  /** Backs the model picker's 'embeddings' target and its own item-list mode. */
  memoryEmbeddingRegistry: Pick<MemoryEmbeddingProviderRegistry, 'getDefaultProviderId' | 'setDefaultProvider' | 'status'>;
  workingDirectory: string;
  homeDirectory: string;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  render: () => void;
  /** Trust-at-consequence-time bridge, patched here with the real modal-driving implementation. */
  trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel>; awaitingOwner?: boolean };
};

let commandCategoryMapCache: Map<string, string> | null = null;

/** The TUI's former view names find the modal that holds them now (the palette's extra search words). */
const PALETTE_VIEW_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['agents', AGENT_VIEW_NAMES],
  ['usage', USAGE_VIEW_NAMES],
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

export function wireShellUiOpeners(options: WireShellUiOpenersOptions): void {
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
    daemonCredentials,
    daemonConfig,
    serviceRegistry,
    memoryEmbeddingRegistry,
    workingDirectory,
    homeDirectory,
    getConfiguredProviderIds,
    getPinned,
    render,
    trustPromptRef,
  } = options;

  // Trust-at-consequence-time: raised by trustGatedAsk on the first non-read
  // request in an undecided workspace; the answer persists via setLevel().
  // Registration self-records here too when trusted (never for restricted,
  // see selfRecordWorkspaceRegistration's doc).
  trustPromptRef.requestTrustDecision = () =>
    new Promise((resolve) => {
      const { title, items } = buildFirstOpenItems();
      if (!commandContext.openSelection) {
        resolve('restricted');
        return;
      } // no selection surface (should not happen live)
      // While the question is open the turn waits on the owner, not the model (the throbber says so).
      trustPromptRef.awaitingOwner = true;
      commandContext.openSelection(title, items, { allowSearch: false, primaryVerbLabel: 'Choose' }, (result) => {
        trustPromptRef.awaitingOwner = false;
        const level = decodeFirstOpenChoice(result?.item.id ?? null);
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
        label: 'Embeddings',
        description: 'Embedding provider used for memory search and the code index. Not an LLM route: no model concept.',
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
      refreshLiveModels: async () => (await providerRegistry.refreshLiveModelDiscovery?.()) ?? [],
    }),
    picker: input.modelPicker,
    render,
    listModels: () => providerRegistry.getSelectableModels().filter((m) => providerRegistry.has(m.provider)),
    listProviders: () => [...new Set(providerRegistry.listModels().map((m) => m.provider))].filter((id) => providerRegistry.has(id)),
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

  commandContext.openOnboardingWizard = (modeOrOptions) => {
    input.openOnboardingWizard(modeOrOptions);
  };

  // Mirrors the Ctrl+F chord's own toggle exactly (handler-shortcuts.ts's
  // 'search' case); the transcript search bar is not a modal on the stack.
  commandContext.openTranscriptSearch = () => {
    if (input.searchManager.active) input.searchManager.close(input.conversationManager);
    else input.searchManager.open();
    render();
  };

  commandContext.openSettingsModal = createSettingsWorkspaceOpener({
    configure: () => {
      input.settingsModal.open(configManager, featureFlags, subscriptionManager, serviceRegistry, mcpRegistry, secretsManager, {
        // The Connections category probes through this app's catalog, which is
        // empty by construction, so those rows read 'unreachable' rather than
        // inventing a settled state nothing established. Retargeting that probe
        // at the daemon is the remaining half of this seam.
        ...(commandContext.workspace?.gatewayMethods ? { gatewayMethods: commandContext.workspace.gatewayMethods } : {}),
        // A daemon-scoped credential goes to the daemon, which writes the secret,
        // verifies it reads back, and only then points the config key at it.
        ...(daemonCredentials ? { daemonCredentials } : {}),
        // A daemon-owned setting is applied by the daemon, so it is written there.
        ...(daemonConfig ? { daemonConfig } : {}),
        reportError: (message: string) => {
          commandContext.print?.(message);
        },
        requestRender: render,
        onSettingApplied: (change) => {
          // A theme change was applied by the start-up theme subscription
          // (renderer/terminal-bg-probe.ts); this only reports what it did.
          const themeMessage = takeAppliedThemeMessage(String(change.key));
          if (themeMessage !== undefined) return { message: themeMessage };
          const builtinSetting = configManager.getSchema().find((setting) => setting.key === change.key);
          if (!builtinSetting) return;
          const serviceChange = { ...change, key: builtinSetting.key };
          const serviceRuntime = { configManager, workingDirectory, homeDirectory };
          if (classifyServiceSettingChange(serviceChange) !== 'changed') return syncServiceSettingToPlatform(serviceRuntime, serviceChange);
          // The service manager's commands are synchronous (each one time-bounded),
          // so they run after the "applying" frame is painted rather than inside
          // this key handler; the result then replaces that message.
          setTimeout(() => {
            // A later change of the same setting, made before this one ran, owns
            // the outcome: its own deferred run applies it, and this one does nothing.
            const result = JSON.stringify(configManager.get(serviceChange.key)) === JSON.stringify(serviceChange.value)
              ? syncServiceSettingToPlatform(serviceRuntime, serviceChange)
              : { handled: true, message: 'A later change to this setting replaced this one before it ran' };
            const modal = input.settingsModal;
            if (modal.active) {
              modal.lastSettingEffectMessage = result.message ?? null;
              modal.refreshPickerValues();
            } else if (result.message) {
              commandContext.print?.(result.message);
            }
            render();
          }, SERVICE_APPLY_AFTER_PAINT_MS);
          return { message: 'Applying the service change…' };
        },
      });
    },
    selectTarget: (target) => input.settingsModal.selectTarget(target),
    render,
  });

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
      commands: () => input.commandRegistry?.getAll(),
      categories: getCommandCategoryMap,
      extraKeywords: PALETTE_VIEW_KEYWORDS,
      // The keyboard shortcuts, the list's last group, from the live key table.
      shortcuts: () => paletteShortcuts(commandContext.workspace?.keybindingsManager),
      describe: (id) => (id === 'model' ? commandContext.session.runtime.model || undefined : undefined),
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
}

/** Every row of the shortcut groups, as the help palette lists them. */
function paletteShortcuts(keybindingsManager: KeybindingsManager | undefined): readonly PaletteShortcut[] {
  if (!keybindingsManager) return [];
  return [
    ...shortcutGroups(keybindingsManager).flatMap((group) => group.items.map(([key, description]) => ({ key, description }))),
    { key: 'keybindings.json', description: 'Change any key in its file', detail: `Edit ${keybindingsManager.getConfigPath()}: { "action": { "key": "x", "ctrl": true } }.` },
  ];
}
