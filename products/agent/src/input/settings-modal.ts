import { SETTINGS_CHOICE_ACTIONS, type SettingsChoiceAction } from '@goodvibes-jev/engine/terminal-shell/settings-choice-actions';
import { selectedSettingsCategoryEntry } from '@goodvibes-jev/engine/terminal-shell/settings-navigation';
import { cycleSettingChoice, adjustedSettingValue } from '@goodvibes-jev/engine/terminal-shell/settings-behavior';
import { TerminalSettingsModalState } from '@goodvibes-jev/engine/terminal-shell/settings-modal-state';
import { moveSettingsSelection, selectSettingsTarget } from '@goodvibes-jev/engine/terminal-shell/settings-navigation';
import { hasActiveExecutionMode, readExecutionMode, refreshExecutionMode, setExecutionMode } from '../permissions/execution-mode.ts';
import { postalConfigKey, readConfigSettingForDisplay } from '@goodvibes-jev/engine/platform/platform/config';
/** SettingsModal state for the /settings and /config fullscreen workspace. */

import type { ModelPickerTarget } from './model-picker.ts';
import type { ConfigManager, ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { isAgentHostSettingKey } from '../config/host-settings.ts';
import { getAgentSettingsSchema, type AgentSettingKey } from '../config/settings-catalog.ts';
import { getResolvedSettingLookup } from '@/runtime/index.ts';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { agentDaemonConfigClient, agentDaemonConfigClientInstalled, isDaemonOwnedConfigKey, openEffectiveConfigView } from '../config/daemon-config-routing.ts';
import { routeSettingWriteToConnectedHost } from './settings-modal-daemon-writes.ts';
import { isDeepStrictEqual } from 'node:util';
import { modelPickerLaunchForKey, parseNumberEditBuffer } from './settings-modal-behavior.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes-jev/engine/platform/platform/payments';
import { setSecretBackedSettingValue, type SettingsSecretsManager } from './settings-modal-secrets.ts';
import { buildSubscriptionEntries } from './settings-modal-subscriptions.ts';
import { buildMcpEntries } from './settings-modal-mcp-entries.ts';
import { buildFlagEntries } from './settings-modal-flag-entries.ts';
import { buildPaymentsCardsRow, PAYMENTS_CARDS_ROW_KEY } from './payments-config.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FlagState } from '@/runtime/index.ts';
import '@/runtime/index.ts';
import { resolveFeatureEnablementWrite } from '../runtime/feature-enablement.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
  CROSS_LISTED_SETTING_ROOTS,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusPane,
  type SettingsModalChangeHandler,
  type SettingsModalOpenOptions,
  type SubscriptionEntry,
} from './settings-modal-types.ts';
import { isAgentHiddenSettingKey } from './settings-modal-agent-policy.ts';
import { searchSettingEntries } from './settings-modal-search.ts';
import { getSettingLabel } from '../renderer/settings-modal-helpers.ts';

export {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusPane,
  type SettingsModalChange,
  type SettingsModalChangeHandler,
  type SettingsModalChangeResult,
  type SettingsModalOpenOptions,
  type SubscriptionEntry,
} from './settings-modal-types.ts';
export { isAgentHiddenSettingKey } from './settings-modal-agent-policy.ts';

const MCP_TRUST_MODES: readonly McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];

// ---------------------------------------------------------------------------
// SettingsModal
// ---------------------------------------------------------------------------

export class SettingsModal extends TerminalSettingsModalState<
  SettingsCategory,
  SettingEntry,
  ModelPickerTarget,
  'tts-provider' | 'tts-voice' | 'theme' | SettingsChoiceAction | 'daemon-timezone'
> {
  /** Index into SETTINGS_CATEGORIES. */

  /** Selected setting index within the current category. */

  /** Which pane receives up/down navigation and Enter/Space actions. */
  public focusPane: SettingsFocusPane = 'settings';

  /** Whether we're in inline edit mode for the selected string/number setting. */

  /** Current value of the inline edit buffer. */

  /** Server awaiting explicit allow-all confirmation, if any. */

  /**
   * Set by activateSelected() when the highlighted setting should open the
   * model picker rather than entering inline text edit mode.
   * Consumed and cleared by the route handler after each Enter/Space action.
   */

  /** Set when the highlighted setting should open provider selection before model selection. */

  /** Set when a highlighted setting needs an external picker owned by the shell route. */

  /** Provider awaiting explicit logout confirmation, if any. */

  /** Settings grouped by category. */

  /** Feature entries grouped by settings domain (populated when the features tab is active). */
  public flagEntries: FlagEntry[] = [];
  /** MCP server trust entries (populated when mcp tab is active). */

  /** Provider subscription entries (populated when subscriptions tab is active). */

  /** Accepted secret edits finish here; commitEdit remains a synchronous keystroke API. */

  private secretWriteSession = 0;
  /**
   * Daemon-owned keys with a write in flight. One write per key at a time keeps the host's order;
   * the newest value asked for meanwhile is kept here and sent when the first settles.
   */
  private readonly routedWrites = new Map<string, { next?: { readonly value: unknown } }>();
  /** Values the connected host confirmed this session; the local store never holds them, so every rebuild of the rows re-applies them. */
  private readonly hostHeldValues = new Map<string, unknown>();
  /** Host-owned keys whose value the connected host has not given this opening, with why; shown instead of this machine's copy. */
  private readonly hostUnreadable = new Map<string, string>();
  /** The always-live search row: a non-empty query lists ranked matches from every category. */

  get searchFocused(): boolean {
    return this.searchQuery.length > 0;
  }
  /** Rows the selected setting's documentation is scrolled (PgUp/PgDn); reset when the selection moves. */

  scrollContext(delta: number): void {
    this.contextScroll = Math.max(0, this.contextScroll + delta);
  }

  private configManager: ConfigManager | null = null;
  private unsubscribeHostSetting: (() => void) | null = null;
  private requestHostSettingRender: (() => void) | null = null;
  private reportError: ((message: string) => void) | null = null;
  private secretsManager: SettingsSecretsManager | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null = null;
  private onSettingApplied: SettingsModalChangeHandler | null = null;

  /**
   * Open the modal, loading current config values from configManager.
   *
   * @param configManager - Config manager instance for reading/writing settings.
   * @param featureFlagManager - Feature flag manager for the flags tab.
   */
  open(
    configManager: ConfigManager,
    featureFlagManager: FeatureFlagManager,
    subscriptionManager: SubscriptionManager,
    serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>,
    mcpRegistry?: McpRegistry,
    secretsManager?: SettingsSecretsManager,
    options?: SettingsModalOpenOptions,
  ): void {
    this.secretWriteSession++;
    this.routedWrites.clear();
    this.hostHeldValues.clear();
    this.hostUnreadable.clear();
    this.unsubscribeHostSetting?.();
    this.unsubscribeHostSetting = null;
    this.requestHostSettingRender = options?.requestRender ?? null;
    this.reportError = options?.reportError ?? null;
    this.configManager = configManager;
    this.secretsManager = secretsManager ?? null;
    this.featureFlagManager = featureFlagManager;
    this.subscriptionManager = subscriptionManager;
    this.serviceRegistry = serviceRegistry;
    this.mcpRegistry = mcpRegistry ?? null;
    this.onSettingApplied = options?.onSettingApplied ?? null;
    this._loadGroups(configManager);
    this._loadFlagEntries();
    this._loadMcpEntries();
    this._loadSubscriptionEntries();
    this.categoryIndex = 0;
    this.selectedIndex = 0;
    this.focusPane = 'categories';
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSettingEffectMessage = null;
    this.clearSearch();
    this.active = true;
    this._readHostValues(configManager);
    const hostSubscriptions: Array<() => void> = [];
    for (const setting of configManager.getHostSettingsSchema?.() ?? []) {
      if (!isAgentHostSettingKey(setting.key)) continue;
      hostSubscriptions.push(
        configManager.getHostBooleanSetting(setting.key).subscribe(() => {
          if (!this.active || this.configManager !== configManager) return;
          for (const entries of this.groups.values()) {
            for (const entry of entries) this._refreshHostEntry(entry);
          }
          this.requestHostSettingRender?.();
        }),
      );
    }
    this.unsubscribeHostSetting = () => {
      for (const unsubscribe of hostSubscriptions) unsubscribe();
    };
    if (hasActiveExecutionMode(configManager)) {
      const opened = this.secretWriteSession;
      void refreshExecutionMode(configManager).then(
        () => {
          if (!this.active || this.configManager !== configManager || opened !== this.secretWriteSession) return;
          this._refreshAllEntries();
          this.requestHostSettingRender?.();
        },
        () => {
          if (!this.active || this.configManager !== configManager || opened !== this.secretWriteSession) return;
          this.lastSettingEffectMessage = 'The active hosted execution mode is unavailable.';
          this._refreshAllEntries();
          this.requestHostSettingRender?.();
        },
      );
    }
  }

  /** Replace the search query and recompute the ranked results (an empty query clears the search). */
  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.searchResults = query.trim().length === 0 ? [] : searchSettingEntries(query, this.groups, getSettingLabel);
    this.selectedIndex = 0;
    this.contextScroll = 0;
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.searchResults = [];
  }

  close(): void {
    this.active = false;
    this.secretWriteSession++;
    this.routedWrites.clear();
    this.hostHeldValues.clear();
    this.hostUnreadable.clear();
    this.unsubscribeHostSetting?.();
    this.unsubscribeHostSetting = null;
    this.requestHostSettingRender = null;
    this.resetSettingsInteraction();

    this.serviceRegistry = null;
    this.secretsManager = null;
    this.onSettingApplied = null;
    this.focusPane = 'settings';
  }

  /** Cycle to the next category (Tab). */
  nextCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex + 1) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    } else if (this.currentCategory === 'mcp') {
      this._loadMcpEntries();
    } else if (this.currentCategory === 'subscriptions') {
      this._loadSubscriptionEntries();
    }
  }

  /** Cycle to the previous category (Shift+Tab). */
  prevCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    } else if (this.currentCategory === 'mcp') {
      this._loadMcpEntries();
    } else if (this.currentCategory === 'subscriptions') {
      this._loadSubscriptionEntries();
    }
  }

  focusCategories(): void {
    if (this.editingMode) return;
    this.focusPane = 'categories';
  }

  focusSettings(): void {
    if (this.editingMode) return;
    this.focusPane = 'settings';
  }

  toggleFocusPane(): void {
    if (this.editingMode) return;
    this.focusPane = this.focusPane === 'settings' ? 'categories' : 'settings';
  }

  moveFocusedUp(): void {
    if (this.focusPane === 'categories') this.prevCategory();
    else this.moveUp();
  }

  moveFocusedDown(): void {
    if (this.focusPane === 'categories') this.nextCategory();
    else this.moveDown();
  }

  moveUp(): void {
    moveSettingsSelection(this, -1, {
      items: () => this._currentItems().length,
      specialItems: () =>
        this.currentCategory === 'mcp'
          ? this.mcpEntries.length
          : this.currentCategory === 'subscriptions'
            ? this.subscriptionEntries.length
            : this.currentCategory === 'flags'
              ? this.flagEntries.length
              : 0,
      clearSearchConfirmation: true,
    });
  }

  moveDown(): void {
    moveSettingsSelection(this, 1, {
      items: () => this._currentItems().length,
      specialItems: () =>
        this.currentCategory === 'mcp'
          ? this.mcpEntries.length
          : this.currentCategory === 'subscriptions'
            ? this.subscriptionEntries.length
            : this.currentCategory === 'flags'
              ? this.flagEntries.length
              : 0,
      clearSearchConfirmation: true,
    });
  }

  getSelected(): SettingEntry | null {
    const items = this.searchFocused ? this.searchResults : this._currentItems();
    if (items.length === 0) return null;
    return items[Math.max(0, Math.min(items.length - 1, this.selectedIndex))] ?? null;
  }

  /** Get the currently selected flag entry (flags tab only). */
  getSelectedFlag(): FlagEntry | null {
    if (this.currentCategory !== 'flags') return null;
    if (this.flagEntries.length === 0) return null;
    return this.flagEntries[Math.max(0, Math.min(this.flagEntries.length - 1, this.selectedIndex))] ?? null;
  }

  getSelectedMcp(): McpEntry | null {
    return selectedSettingsCategoryEntry(this.currentCategory, 'mcp', this.mcpEntries, this.selectedIndex);
  }

  getSelectedSubscription(): SubscriptionEntry | null {
    return selectedSettingsCategoryEntry(this.currentCategory, 'subscriptions', this.subscriptionEntries, this.selectedIndex);
  }

  get currentCategory(): SettingsCategory {
    return SETTINGS_CATEGORIES[this.categoryIndex];
  }

  get currentItems(): SettingEntry[] {
    return this._currentItems();
  }

  selectTarget(target?: string): void {
    selectSettingsTarget(this, target, SETTINGS_CATEGORIES, this.groups, {
      resetScroll: false,
      focusSettings: () => {
        this.focusPane = 'settings';
      },
    });
  }

  /**
   * Toggle boolean or begin cycling enum values, or enter edit mode for string/number.
   */
  setPickerExecutionMode(value: string): void { this._setValue('permissions.mode', value); }

  refreshPickerValues(): void {
    this._refreshAllEntries();
    this.contextScroll = 0;
  }

  activateSelected(): void {
    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry) return;
      this.editingMode = true;
      this.editBuffer = entry.trustMode;
      this.mcpAllowAllConfirmationTarget = null;
      return;
    }

    if (this.currentCategory === 'subscriptions') {
      const entry = this.getSelectedSubscription();
      if (!entry) return;
      if (entry.state === 'active' || entry.state === 'pending') {
        if (this.subscriptionLogoutConfirmationTarget !== entry.provider) {
          this.subscriptionLogoutConfirmationTarget = entry.provider;
          return;
        }
        this.subscriptionManager?.logout(entry.provider);
        this._loadSubscriptionEntries();
        this.subscriptionLogoutConfirmationTarget = null;
      }
      return;
    }

    if (!this._canEditSettings()) return;
    const entry = this.getSelected();
    if (!entry || !this.configManager) return;

    const { setting } = entry;

    const choice = SETTINGS_CHOICE_ACTIONS[setting.key];
    if (choice) { this.pendingSettingsPickerAction = choice; return; }

    // Delegate provider/model picker settings to the model picker UI
    if (setting.key === 'tts.provider') {
      this.pendingSettingsPickerAction = 'tts-provider';
      return;
    }
    if (setting.key === 'tts.voice') {
      this.pendingSettingsPickerAction = 'tts-voice';
      return;
    }
    if (setting.key === 'daemon.timezone') {
      this.pendingSettingsPickerAction = 'daemon-timezone';
      return;
    }
    // The theme row opens a picker with live preview instead of cycling values.
    if (setting.key === 'display.theme') {
      this.pendingSettingsPickerAction = 'theme';
      return;
    }

    const pickerLaunch = modelPickerLaunchForKey(setting.key);
    if (pickerLaunch !== null) {
      if (pickerLaunch.flow === 'providerModel') {
        this.pendingProviderModelPickerTarget = pickerLaunch.target;
      } else {
        this.pendingModelPickerTarget = pickerLaunch.target;
      }
      return;
    }

    if (setting.type === 'boolean') {
      const newVal = !entry.currentValue;
      this._setValue(setting.key, newVal);
    } else if (setting.type === 'enum' && setting.enumValues) {
      const idx = setting.enumValues.indexOf(entry.currentValue as string);
      const nextIdx = (idx + 1) % setting.enumValues.length;
      this._setValue(setting.key, setting.enumValues[nextIdx]);
    } else if (setting.type === 'object') {
      this.editingMode = true;
      this.editBuffer = JSON.stringify(entry.currentValue ?? {});
    } else if (setting.type === 'string' || setting.type === 'number') {
      // Enter inline edit mode
      this.editingMode = true;
      this.editBuffer = String(entry.currentValue ?? '');
    }
  }

  adjustSelected(direction: 'left' | 'right', step = 1): void {
    if (this.editingMode) return;

    if (this.currentCategory === 'flags') {
      const flagEntry = this.getSelectedFlag();
      if (!flagEntry || !this.configManager) return;
      const targetState: FlagState = direction === 'right' ? 'enabled' : 'disabled';
      if (flagEntry.state !== targetState) this._setSelectedFlagState(flagEntry, targetState);
      return;
    }

    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry || !this.mcpRegistry) return;
      const nextMode = cycleSettingChoice(MCP_TRUST_MODES, entry.trustMode, direction);
      if (nextMode !== undefined) this._requestTrustMode(entry, nextMode);
      return;
    }

    if (!this._canEditSettings()) return;
    const entry = this.getSelected();
    if (!entry || !this.configManager) return;
    const { setting } = entry;

    const adjustment = adjustedSettingValue(setting, entry.currentValue, direction, step);
    if (adjustment) this._setValue(setting.key, adjustment.value);
  }

  /**
   * Toggle the currently selected feature by writing its enablement domain
   * settings key (there is no separate enablement namespace). The live
   * settings bridge propagates the change into the gate manager; features
   * that require a restart record an honest pending-restart state instead.
   *
   * Always-available features (constant enablement) refuse with guidance
   * naming their real settings keys.
   */
  toggleSelectedFlag(): void {
    const flagEntry = this.getSelectedFlag();
    if (!flagEntry || !this.configManager) return;

    const newState: FlagState = flagEntry.state === 'enabled' ? 'disabled' : 'enabled';

    this._setSelectedFlagState(flagEntry, newState);
  }

  private _setSelectedFlagState(flagEntry: FlagEntry, newState: FlagState): void {
    if (!this.configManager || !this._canEditSettings()) return;
    const feature = flagEntry.feature;

    try {
      const write = resolveFeatureEnablementWrite(feature.id, newState === 'enabled' ? 'enabled' : 'disabled');
      // The same write path as every other setting: a key the connected host owns goes to the
      // host, and the apply hooks run (so a refused key such as service.enabled is refused here too).
      this.lastSettingEffectMessage = null;
      const accepted = this._setValue(write.key as AgentSettingKey, write.value);
      this._loadFlagEntries();
      if (!accepted) return;
      // A routed write reports and updates the row when the host answers.
      if (this.routedWrites.has(write.key)) return;
      this.lastSettingEffectMessage ??= feature.restartRequired
        ? `${write.key} = ${String(write.value)} saved; takes effect on the next launch.`
        : `${write.key} = ${String(write.value)}`;
    } catch (e) {
      logger.error('SettingsModal: failed to set feature enablement', { feature: feature.id, error: summarizeError(e) });
      this.lastSettingEffectMessage = `Save failed: ${summarizeError(e)}`;
    }
  }

  /**
   * Commit the current editBuffer to the config.
   * Returns true when accepted, false if validation failed or a secret write is pending.
   */
  commitEdit(): boolean {
    if (this.pendingSecretWrite) return false;
    if (!this.editingMode) return false;

    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry || !this.mcpRegistry) return false;
      if (this.mcpAllowAllConfirmationTarget) {
        const expected = `ALLOW ALL ${this.mcpAllowAllConfirmationTarget}`;
        if (this.editBuffer.trim() !== expected) {
          return this._rejectEdit(`Not changed: type ${expected} exactly to allow all, or press Esc to cancel.`);
        }
        return this._applyTrustMode(entry, 'allow-all');
      }

      const nextMode = this.editBuffer.trim() as McpEntry['trustMode'];
      if (!MCP_TRUST_MODES.includes(nextMode)) {
        return this._rejectEdit(`Not changed: "${this.editBuffer.trim()}" is not a trust mode. Use ${MCP_TRUST_MODES.join(', ')}.`);
      }
      return this._requestTrustMode(entry, nextMode);
    }

    if (!this._canEditSettings()) return false;
    const entry = this.getSelected();
    if (!entry || !this.configManager) return false;

    const { setting } = entry;
    let parsed: unknown = this.editBuffer;

    if (setting.type === 'number') {
      parsed = parseNumberEditBuffer(this.editBuffer);
      if (parsed === null) {
        return this._rejectEdit(`Not saved: "${this.editBuffer}" is not a number for ${setting.key}. The value is unchanged.`);
      }
    }

    if (setting.type === 'object') {
      try { parsed = JSON.parse(this.editBuffer); }
      catch { return this._rejectEdit(`Not saved: the text is not valid JSON for ${setting.key}. The value is unchanged.`); }
    }

    if (setting.validate && !setting.validate(parsed)) {
      return this._rejectEdit(`Not saved: "${this.editBuffer}" is outside what ${setting.key} accepts. The value is unchanged.`);
    }

    if (setting.type === 'string' && isSecretConfigKey(setting.key)) {
      this._writeSecretSetting(setting.key, String(parsed ?? ''));
    } else {
      this._setValue(setting.key, parsed);
    }
    this.editingMode = false;
    this.editBuffer = '';
    return true;
  }

  /**
   * The one way this screen changes a server's trust mode, from the arrow keys or a typed mode.
   * A move INTO allow-all opens the typed confirmation; every other move applies at once.
   */
  private _requestTrustMode(entry: McpEntry, mode: McpEntry['trustMode']): boolean {
    if (mode === 'allow-all' && entry.trustMode !== 'allow-all') {
      this.editingMode = true;
      this.editBuffer = '';
      this.mcpAllowAllConfirmationTarget = entry.name;
      return false;
    }
    return this._applyTrustMode(entry, mode);
  }

  private _applyTrustMode(entry: McpEntry, mode: McpEntry['trustMode']): boolean {
    if (!this.mcpRegistry) return false;
    this.editingMode = false;
    this.editBuffer = '';
    this.mcpAllowAllConfirmationTarget = null;
    try {
      this.mcpRegistry.setServerTrustMode(entry.name, mode);
      this.lastSettingEffectMessage = `${entry.name} trust mode is ${mode} for this session only; edit the server in /mcp to keep it after a restart.`;
    } catch (error) {
      this.lastSettingEffectMessage = `Trust mode not changed: ${summarizeError(error)}`;
    }
    this._loadMcpEntries();
    return true;
  }

  /** An edit the setting refused: say why and keep the editor open on what was typed, so it can be corrected. */
  private _rejectEdit(message: string): false {
    this.lastSettingEffectMessage = message;
    return false;
  }

  /** Capture the owner once for edits and resets; publication follows storage completion. */
  private _writeSecretSetting(key: ConfigKey, value: string): void {
    const configManager = this.configManager;
    if (!configManager) return;
    const onApplied = this.onSettingApplied;
    const configClient = agentDaemonConfigClient();
    let effectMessage: string | null = null;
    let warning: string | null = null;
    let routedValue: { readonly value: unknown } | null = null;
    const session = this.secretWriteSession;
    // The transcript outlives the modal: a credential save that fails after
    // Esc is still reported there. Only the status line belongs to the session.
    const reportFailure = this.reportError;
    this.lastSettingEffectMessage = 'Saving credential…';
    this.pendingSecretWrite = setSecretBackedSettingValue({
      key,
      value,
      configManager,
      secretsManager: this.secretsManager,
      setConfigValue: async (key, value) => {
        if (configClient?.ownsKey(key)) {
          await configClient.set(key, value);
          routedValue = { value };
          effectMessage = 'Applied by the connected host; it takes effect for every client.';
          return;
        }
        const previousValue = configManager.get(key);
        configManager.setDynamic(key, value);
        if (previousValue !== value) effectMessage = onApplied?.({ key, previousValue, value })?.message ?? null;
      },
      onWriteReported: (report) => {
        if (report.ok) effectMessage = report.message;
        // A cleared credential whose stored value could not be removed still completes; keep that warning.
        else {
          warning = report.message;
          reportFailure?.(report.message);
        }
        if (session === this.secretWriteSession) this.lastSettingEffectMessage = report.message;
      },
    })
      .then((ok) => {
        if (session === this.secretWriteSession) {
          if (ok) {
            this.lastSettingEffectMessage = warning ?? effectMessage ?? 'Credential saved.';
            this._refreshAllEntries();
            // The local store does not hold a value the host owns; show what was written there.
            if (routedValue) this._applyRoutedValue(key, routedValue.value);
          }
          this.requestHostSettingRender?.();
        }
        return ok;
      })
      .finally(() => {
        this.pendingSecretWrite = null;
      });
  }

  /** Cancel inline edit without saving. */
  cancelEdit(): void {
    this.editingMode = false;
    this.editBuffer = '';
    this.mcpAllowAllConfirmationTarget = null;
  }

  resetSelected(): { key: AgentSettingKey; value: unknown } | null {
    if (this.pendingSecretWrite || this.editingMode || !this.configManager) return null;
    if (!this._canEditSettings()) return null;
    const entry = this.getSelected();
    if (!entry) return null;
    const key = entry.setting.key;
    if (isSecretConfigKey(key)) {
      this._writeSecretSetting(key, String(entry.setting.default ?? ''));
      return null; // Accepted asynchronously, not yet a completed reset.
    }
    // A refused write must not be copied into the live session (provider.model, reasoningEffort).
    const applied = this._setValue(key, entry.setting.default);
    return applied ? { key, value: entry.setting.default } : null;
  }

  /** Handle a keystroke in edit mode: regular chars appended, Backspace removes last char. */
  editChar(char: string): void {
    if (!this.editingMode) return;
    this.editBuffer += char;
  }

  // ── Private helpers ────────────────────────────────────────────

  private _loadGroups(configManager: ConfigManager): void {
    // Pure host metadata must run before the legacy builtin lookup, whose
    // malformed-policy recovery can otherwise erase evidence of unknown locks.
    const policyError = this._hostPolicyMetadataError();
    this.groups.clear();
    for (const cat of SETTINGS_CATEGORIES) {
      if (cat === 'flags') continue; // flags tab handled separately
      this.groups.set(cat, []);
    }

    for (const setting of getAgentSettingsSchema(configManager)) {
      if (isAgentHiddenSettingKey(setting.key)) continue;
      const rawCat = setting.key.split('.')[0] as string;
      const cat = rawCat as SettingsCategory;
      const display = readConfigSettingForDisplay(() =>
        setting.key === 'permissions.mode'
          ? readExecutionMode(configManager)
          : setting.kind === 'host'
            ? configManager.getHostBooleanSetting(setting.key).get()
            : configManager.get(setting.key),
      );
      const currentValue = display.value;
      const resolved = setting.kind === 'host' || policyError ? undefined : getResolvedSettingLookup(configManager, setting.key)?.entry;
      const entry: SettingEntry = {
        setting,
        currentValue,
        isDefault: currentValue === setting.default,
        effectiveSource: policyError || display.held ? 'unavailable' : resolved?.effectiveSource,
        metadataUnavailable: policyError ?? display.held,
        // `locked`/`lockReason` now come only from a genuine higher-priority
        // config layer. The blanket host-owned lock that used to force them here
        // is gone, those keys route to the daemon that owns them.
        locked: resolved?.locked,
        conflict: resolved?.conflict,
        sourceLabel:
          setting.key === 'permissions.mode' && hasActiveExecutionMode(configManager) ? 'Active hosted session' : resolved?.sourceLabel,
        lockReason: resolved?.lockReason,
      };
      this._refreshHostEntry(entry);
      if (this.groups.has(cat)) this.groups.get(cat)!.push(entry);
      // A root with no category of its own is listed where it belongs instead
      // of being dropped, see CROSS_LISTED_SETTING_ROOTS.
      const crossListed = CROSS_LISTED_SETTING_ROOTS[rawCat];
      if (crossListed !== undefined && this.groups.has(crossListed)) {
        this.groups.get(crossListed)!.push(entry);
      }
    }

    // Cards are not settings: one locked row points to /payments card, where
    // they are added and removed. Settings takes no card material.
    const paymentsEntries = this.groups.get('payments');
    if (paymentsEntries && !paymentsEntries.some((existing) => existing.setting.key === PAYMENTS_CARDS_ROW_KEY)) {
      paymentsEntries.push(buildPaymentsCardsRow());
    }
    if (policyError) {
      for (const entries of this.groups.values())
        for (const entry of entries) {
          Object.assign(entry, {
            effectiveSource: 'unavailable',
            metadataUnavailable: policyError,
            locked: undefined,
            conflict: undefined,
            sourceLabel: undefined,
            lockReason: undefined,
          });
        }
    }

    const uiEntries = this.groups.get('ui');
    if (uiEntries) {
      const uiPriority: Record<string, number> = {
        'ui.systemMessages': 0,
        'ui.operationalMessages': 1,
        'ui.voiceEnabled': 2,
      };
      uiEntries.sort((a, b) => (uiPriority[a.setting.key] ?? 99) - (uiPriority[b.setting.key] ?? 99));
    }
    this._reapplyHostValues();
    if (this.searchQuery) this.searchResults = searchSettingEntries(this.searchQuery, this.groups, getSettingLabel);
  }

  /**
   * Host-owned rows show the connected host's values: one snapshot per opening,
   * the read `/settings get` makes. Until it answers, and for any key it could
   * not give, the row says so instead of showing this machine's copy, which is
   * normally the default.
   */
  private _readHostValues(configManager: ConfigManager): void {
    if (!agentDaemonConfigClientInstalled()) return;
    const keys = new Set<string>();
    for (const entries of this.groups.values()) for (const entry of entries) if (isDaemonOwnedConfigKey(entry.setting.key)) keys.add(entry.setting.key);
    for (const flag of this.flagEntries) if (isDaemonOwnedConfigKey(flag.feature.enablement.key)) keys.add(flag.feature.enablement.key);
    for (const key of keys) this.hostUnreadable.set(key, 'reading from the connected host');
    this._reapplyHostValues();
    const opened = this.secretWriteSession;
    void openEffectiveConfigView(configManager).then(
      (view) => {
        if (!this.active || opened !== this.secretWriteSession) return;
        for (const key of keys) {
          // A write made since opening already set what the host holds.
          if (!this.hostUnreadable.has(key)) continue;
          const entry = view.describe(key);
          if (entry.status === 'ok') {
            this.hostUnreadable.delete(key);
            this.hostHeldValues.set(key, entry.value);
          } else this.hostUnreadable.set(key, `host value unavailable: ${entry.error ?? entry.reason}`);
        }
        // Rebuilt rather than patched, so a row's source no longer says it is waiting.
        this._loadGroups(configManager);
        this._loadFlagEntries();
        this.requestHostSettingRender?.();
      },
      (error: unknown) => {
        if (!this.active || opened !== this.secretWriteSession) return;
        for (const key of this.hostUnreadable.keys()) this.hostUnreadable.set(key, `host value unavailable: ${summarizeError(error)}`);
        this._reapplyHostValues();
        this.requestHostSettingRender?.();
      },
    );
  }

  /** Re-show what the host holds (and what it could not give) after rows were rebuilt from the local store. */
  private _reapplyHostValues(): void {
    for (const [key, value] of this.hostHeldValues) this._showRoutedValue(key, value);
    for (const [key, reason] of this.hostUnreadable) {
      for (const entries of this.groups.values()) {
        for (const entry of entries) {
          if (entry.setting.key !== key) continue;
          entry.currentValue = undefined;
          entry.isDefault = false;
          entry.effectiveSource = 'unavailable';
          entry.sourceLabel = reason;
        }
      }
    }
  }

  /**
   * Load or refresh the features tab from FEATURE_SETTINGS, grouped by
   * settings domain. State prefers the live gate manager (kill-switch and
   * pending-restart aware); without a manager it derives from the feature's
   * bound domain settings key.
   */
  private _loadFlagEntries(): void {
    this.flagEntries = buildFlagEntries(this.configManager, this.featureFlagManager);
    this._reapplyHostValues();
  }

  private _loadMcpEntries(): void {
    this.mcpEntries = buildMcpEntries(this.mcpRegistry);
  }

  private _loadSubscriptionEntries(): void {
    this.subscriptionEntries = buildSubscriptionEntries(this.subscriptionManager, this.serviceRegistry);
  }

  /** Returns [] for the flags category (flags use flagEntries instead). */
  private _currentItems(): SettingEntry[] {
    if (this.currentCategory === 'flags' || this.currentCategory === 'mcp' || this.currentCategory === 'subscriptions') return [];
    return this.groups.get(this.currentCategory) ?? [];
  }

  private _refreshAllEntries(): void {
    if (!this.configManager) return;
    for (const entries of this.groups.values()) {
      for (const entry of entries) {
        if (entry.setting.kind === 'host') {
          this._refreshHostEntry(entry);
          continue;
        }
        const display = readConfigSettingForDisplay(() =>
          entry.setting.key === 'permissions.mode'
            ? readExecutionMode(this.configManager!)
            : this.configManager!.get(entry.setting.key as never),
        );
        entry.currentValue = display.value;
        entry.metadataUnavailable = display.held;
        entry.isDefault = entry.currentValue === entry.setting.default;
        if (entry.setting.key === 'permissions.mode')
          entry.sourceLabel = hasActiveExecutionMode(this.configManager) ? 'Active hosted session' : undefined;
        this._refreshHostEntry(entry);
      }
    }
    this._reapplyHostValues();
  }

  /**
   * Show a value the connected host now holds. The Agent's own config store does not hold a
   * host-owned value (a host on another machine never writes this process's file, and a local
   * host is only noticed on the next file poll), so rows are set from the host's reply rather
   * than re-read locally.
   */
  private _applyRoutedValue(key: string, value: unknown): void {
    this.hostUnreadable.delete(key);
    this.hostHeldValues.set(key, value);
    this._showRoutedValue(key, value);
  }

  private _showRoutedValue(key: string, value: unknown): void {
    for (const entries of this.groups.values()) {
      for (const entry of entries) {
        if (entry.setting.key !== key) continue;
        entry.currentValue = value;
        entry.isDefault = isDeepStrictEqual(value, entry.setting.default);
        entry.sourceLabel = 'the connected host';
        delete entry.metadataUnavailable;
      }
    }
    for (const flag of this.flagEntries) {
      if (flag.feature.enablement.key !== key) continue;
      flag.enablementValue = String(value);
      try {
        flag.state = isDeepStrictEqual(value, resolveFeatureEnablementWrite(flag.feature.id, 'enabled').value) ? 'enabled' : 'disabled';
      } catch {
        // A feature with no writable enablement keeps the state it had.
      }
    }
  }

  /** Keep the registered host row's canonical source/lock metadata live too. */
  private _refreshHostEntry(entry: SettingEntry): void {
    if (!this.configManager || entry.setting.kind !== 'host') return;
    const handle = this.configManager.getHostBooleanSetting(entry.setting.key);
    entry.currentValue = handle.get();
    entry.isDefault = entry.currentValue === entry.setting.default;
    try {
      const resolved = handle.getResolved();
      Object.assign(entry, {
        effectiveSource: resolved.source,
        locked: resolved.managedLock !== null,
        metadataUnavailable: undefined,
        conflict: undefined,
        sourceLabel: undefined,
        lockReason: resolved.managedLock ? `${resolved.managedLock.source}: ${resolved.managedLock.reason}` : undefined,
      });
    } catch (error) {
      Object.assign(entry, {
        effectiveSource: 'unavailable',
        metadataUnavailable: summarizeError(error),
        locked: undefined,
        conflict: undefined,
        sourceLabel: undefined,
        lockReason: undefined,
      });
    }
  }

  private _setValue(key: AgentSettingKey, value: unknown): boolean {
    if (!this.configManager) return false;
    if (!this._canEditSettings()) return false;
    if (isAgentHostSettingKey(key)) {
      try {
        const handle = this.configManager.getHostBooleanSetting(key);
        handle.getResolved(); // Unknown policy metadata must never be presented as editable.
        if (typeof value !== 'boolean') throw new Error(`${key} requires a literal boolean.`);
        handle.set(value);
        this.lastSettingEffectMessage = null;
        this._refreshAllEntries();
        return true;
      } catch (error) {
        this.lastSettingEffectMessage = `Save failed: ${summarizeError(error)}`;
        for (const entries of this.groups.values()) for (const entry of entries) this._refreshHostEntry(entry);
        return false;
      }
    }
    if (key === 'permissions.mode') {
      this.lastSettingEffectMessage = 'Saving execution mode…';
      const owner = this.configManager;
      const opened = this.secretWriteSession;
      void setExecutionMode(owner, value).then(
        () => {
          if (!this.active || this.configManager !== owner || opened !== this.secretWriteSession) return;
          this.lastSettingEffectMessage = 'Execution mode updated.';
          this._refreshAllEntries();
          this.requestHostSettingRender?.();
        },
        (error) => {
          if (!this.active || this.configManager !== owner || opened !== this.secretWriteSession) return;
          this.lastSettingEffectMessage = `Save failed: ${summarizeError(error)}`;
          this.requestHostSettingRender?.();
        },
      );
      return true;
    }
    const previousValue = postalConfigKey(key) ? this.configManager.getStored(key) : this.configManager.get(key);
    // A setting the DAEMON acts on is written where it is acted on. Writing it
    // into this process's own store is the defect this routing exists to end:
    // the modal accepted the value, reported success, and configured nothing,
    // because the runtime that reads the key reads a different file.
    //
    // This runs before the local write and returns instead of it, so a
    // daemon-owned key never has two writers. The modal cannot await from a
    // keystroke handler, so the outcome lands on `lastSettingEffectMessage` a
    // moment later, including the refusal, which is the message that matters.
    const inFlight = this.routedWrites.get(key);
    if (inFlight) {
      inFlight.next = { value };
      this.lastSettingEffectMessage = 'Saving on the connected host…';
      return true;
    }
    const opened = this.secretWriteSession;
    const write: { next?: { readonly value: unknown } } = {};
    const routed = routeSettingWriteToConnectedHost(key, value, (update) => {
      // The modal may have been closed or reopened while the host answered.
      if (!this.active || opened !== this.secretWriteSession) return;
      this.lastSettingEffectMessage = update.message;
      if (update.applied) {
        this._applyRoutedValue(key, update.applied.value);
        // Same warning as a local write, set after the host's report so the report does not replace it.
        if (key === 'payments.cvvHandling' && update.applied.value === 'prompt') this.lastSettingEffectMessage = CVV_PROMPT_TRADEOFF_WARNING;
      }
      if (update.settled) {
        this.routedWrites.delete(key);
        if (write.next && !isDeepStrictEqual(write.next.value, value)) this._setValue(key, write.next.value);
      }
      this.requestHostSettingRender?.();
    });
    if (routed) {
      this.routedWrites.set(key, write);
      return true;
    }
    try {
      this.configManager.setDynamic(key, value);
      for (const entries of this.groups.values()) {
        const entry = entries.find((candidate) => candidate.setting.key === key);
        if (entry) {
          const display = readConfigSettingForDisplay(() => this.configManager!.get(key));
          entry.currentValue = display.value;
          entry.metadataUnavailable = display.held;
          entry.isDefault = entry.currentValue === entry.setting.default;
          this._refreshHostEntry(entry);
        }
      }
      if (previousValue !== value && this.onSettingApplied) {
        const result = this.onSettingApplied({ key, previousValue, value });
        this.lastSettingEffectMessage = result?.message ?? null;
        this._refreshAllEntries();
      }
      // The platform's own trade-off wording, shown at the moment of selection, not
      // authored here, and never shown against the 'stored' default.
      if (key === 'payments.cvvHandling' && value === 'prompt') {
        this.lastSettingEffectMessage = CVV_PROMPT_TRADEOFF_WARNING;
      } else if (key === 'payments.cvvHandling' && this.lastSettingEffectMessage === CVV_PROMPT_TRADEOFF_WARNING) {
        this.lastSettingEffectMessage = null;
      }
      return true;
    } catch (e) {
      logger.error('SettingsModal: failed to set config value', { key, error: summarizeError(e) });
      this.lastSettingEffectMessage = `Save failed: ${summarizeError(e)}`;
      return false;
    }
  }

  private _hostPolicyMetadataError(): string | undefined {
    const config = this.configManager;
    if (!config) return undefined;
    try {
      for (const setting of config.getHostSettingsSchema?.() ?? []) {
        if (isAgentHostSettingKey(setting.key)) config.getHostBooleanSetting(setting.key).getResolved();
      }
      return undefined;
    } catch (error) {
      return summarizeError(error);
    }
  }

  private _canEditSettings(): boolean {
    if (!this.configManager) return false;
    const error = this._hostPolicyMetadataError();
    if (error) {
      for (const entries of this.groups.values())
        for (const entry of entries) {
          Object.assign(entry, {
            effectiveSource: 'unavailable',
            metadataUnavailable: error,
            locked: undefined,
            conflict: undefined,
            sourceLabel: undefined,
            lockReason: undefined,
          });
        }
      this.lastSettingEffectMessage = `Editing unavailable: ${error}`;
      return false;
    }
    if ([...this.groups.values()].some((entries) => entries.some((entry) => entry.metadataUnavailable)))
      this._loadGroups(this.configManager);
    return true;
  }
}
