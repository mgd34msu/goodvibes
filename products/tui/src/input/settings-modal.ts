import { SETTINGS_CHOICE_ACTIONS, type SettingsChoiceAction } from '@goodvibes/engine/terminal-shell/settings-choice-actions';
import { readSecureAddressRows, runSecureAddressRowAction, selectedSettingsCategoryEntry, SECURE_ADDRESS_CHECKING_ROWS, type SecureAddressRow } from '@goodvibes/engine/terminal-shell/settings-navigation';
import type {
  SettingsModalChange as PlatformSettingsModalChange,
  SettingsModalChangeResult as PlatformSettingsModalChangeResult,
  SettingsModalChangeHandler as PlatformSettingsModalChangeHandler,
} from '@goodvibes/engine/terminal-shell/settings-model-types';
import { TerminalSettingsModalState } from '@goodvibes/engine/terminal-shell/settings-modal-state';
import {
  buildSettingsTopics,
  findSettingsTopicTarget,
  moveSettingsSelection,
  settingsTopicEntries,
  type SettingsTargetOutcome,
  type SettingsTopicList,
  type SettingsTopicRow,
} from '@goodvibes/engine/terminal-shell/settings-navigation';
import { searchSettingsInOrder } from '@goodvibes/engine/terminal-shell/settings-search';
import { settingSourceWords } from '@goodvibes/engine/terminal-shell/renderer/settings-context';
/**
 * SettingsModal, state management for the /settings fullscreen workspace.
 *
 * Loads CONFIG_SCHEMA, groups settings by category, and tracks UI state:
 *   - Active category (Tab to cycle)
 *   - Selected setting index within category (↑↓)
 *   - Editing mode for inline string/number input
 *   - Feature-unit headers (each capability's real enablement row in its domain)
 *
 * Every save is a plain configManager.set(key, value) on a domain settings
 * key, except a daemon-owned key, which the daemon alone writes while it is
 * reachable (settings-modal-mutations.ts); the platform settings bridge keeps the runtime gate manager in sync, and
 * this modal re-reads the manager after enablement writes so pending-restart
 * markers are shown honestly at the point of change.
 *
 * Data assembly delegates to settings-modal-data.ts (buildSettingGroups, etc.).
 * Mutation logic delegates to settings-modal-mutations.ts (applySettingValue, etc.).
 */

import { isDaemonOwnedConfigKey, type ConfigKey } from '@goodvibes/engine/platform/platform/config';
import type { ModelPickerTarget } from './model-picker.ts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import { setSecretBackedSettingValue, type SettingsDaemonCredentialWriter, type SettingsSecretsManager } from './settings-modal-secrets.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes/engine/platform/platform/payments';
import { PAYMENTS_CVV_HANDLING_CONFIG_KEY } from './payments-config.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import type { GatewayMethodCatalog } from '@goodvibes/engine/platform/platform/control-plane';
import type { ConnectionStatus } from './commands/connection-status.ts';
import { initialConnectionEntries, refreshConnectionEntries } from './settings-modal-connections.ts';

import {
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusRegion,
  type SubscriptionEntry,
} from './settings-modal-types.ts';
import {
  buildSettingGroups,
  buildMcpEntries,
  buildSubscriptionEntries,
  buildNetworkFilteredItems,
  readSettingsPolicy,
  refreshEntryValues,
  refreshSettingsPolicyAvailability,
  type SettingsPolicyRead,
} from './settings-modal-data.ts';
import { getSettingLabel } from '../renderer/settings-modal-helpers.ts';
import {
  applySettingValue,
  applyHostSettingValue,
  syncFlagEntryFromManager,
  type DaemonOwnedConfigWriter,
  type SettingAppliedCallback,
} from './settings-modal-mutations.ts';
import { featureEnablementWrite, isFeatureValueEnabled } from '@goodvibes/engine/terminal-shell';
import {
  activateSelected as _activateSelected,
  handleSubscriptionLogoutKey as _handleSubscriptionLogoutKey,
} from './settings-modal-activation.ts';
import { adjustSelected as _adjustSelected } from './settings-modal-adjustment.ts';
import {
  resetSelected as _resetSelected,
  initiateResetCategory as _initiateResetCategory,
  initiateResetAll as _initiateResetAll,
  handleResetConfirmKey as _handleResetConfirmKey,
  type ResetConfirmKeyResult,
} from './settings-modal-reset.ts';
import { commitEditValue as _commitEditValue } from './settings-modal-commit.ts';

export type SettingsModalChange = PlatformSettingsModalChange<string>;

export type SettingsModalChangeResult = PlatformSettingsModalChangeResult;

export type SettingsModalChangeHandler = PlatformSettingsModalChangeHandler<string>;

export interface SettingsModalOpenOptions {
  readonly onSettingApplied?: SettingsModalChangeHandler;
  /**
   * The daemon's credential write. A daemon-scoped credential (a mailbox
   * password, a bot token, a card) must land where the daemon reads it, this
   * surface storing a copy is a credential in a place nothing consults.
   */
  readonly daemonCredentials?: SettingsDaemonCredentialWriter | null;
  /**
   * Where a daemon-owned setting is written. Present when a daemon is
   * configured; without it every write stays local, which is right only when
   * there is no daemon to disagree with.
   */
  readonly daemonConfig?: DaemonOwnedConfigWriter | null;
  /** Renders a refused credential write, so a failed save is never silent. */
  readonly reportError?: (message: string) => void;
  /** In-process catalog the Connections category probes; see that module. */
  readonly gatewayMethods?: GatewayMethodCatalog;
  /** Called when an async connection refresh has new rows to paint. */
  readonly requestRender?: () => void;
}

/** The host fields shown only while their mode is `custom`. */
const NETWORK_HOST_KEYS: ReadonlySet<string> = new Set(['controlPlane.host', 'httpListener.host', 'web.host']);

export {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusRegion,
  type SubscriptionEntry,
} from './settings-modal-types.ts';

/** The lists a topic opens in place of a setting. */
const TOPIC_LISTS: readonly SettingsTopicList<SettingsCategory>[] = [
  { category: 'mcp', label: 'Tool servers (MCP)', description: 'what each connected tool server may do', topic: 'permissions', sectionId: 'permissions' },
  { category: 'subscriptions', label: 'Provider sign-ins', description: 'subscriptions you signed in to, and signing out', topic: 'models', sectionId: 'credentials' },
  { category: 'connections', label: 'Mail and calendar', description: 'whether your mail and calendar answer right now', topic: 'account', sectionId: 'account' },
  { category: 'secure-address-now', label: 'Secure address now', description: 'what the https address serves now, why not when it does not, and each of the four ways explained', topic: 'general', sectionId: 'secure-address' },
];

// ---------------------------------------------------------------------------
// SettingsModal
// ---------------------------------------------------------------------------

export class SettingsModal extends TerminalSettingsModalState<
  SettingsCategory,
  SettingEntry,
  ModelPickerTarget,
  'tts-provider' | 'tts-voice' | 'theme' | SettingsChoiceAction | 'payments-cards'
> {
  public searchFocused = false;

  /** Selected setting index within the current category. */

  /** Which region (settings list or documentation) receives up/down navigation and Enter/Space actions. */
  public focusRegion: SettingsFocusRegion = 'settings';

  /** Whether we're in inline edit mode for the selected string/number setting. */

  /** Current value of the inline edit buffer. */

  /**
   * Scroll offset (in wrapped lines) of the documentation region for the
   * selected row. The renderer clamps it to the region's real content height
   * and shows honest more-above/below markers, long feature documentation
   * scrolls, it never clips. Reset whenever the selection changes.
   */

  /** Server awaiting explicit allow-all confirmation, if any. */

  /**
   * Set by activateSelected() when the highlighted setting should open the
   * model picker rather than entering inline text edit mode.
   * Consumed and cleared by the route handler after each Enter/Space action.
   */

  /** Set when the highlighted setting should open provider selection before model selection. */

  /** Set when a highlighted setting needs an external picker owned by the shell route. */

  /** Provider awaiting explicit logout confirmation, if any. */

  /** Pending category-reset confirmation gate, or null when inactive. */
  public resetCategoryConfirm: { readonly subject: string } | null = null;
  /** Pending reset-all confirmation gate, or null when inactive. */
  public resetAllConfirm: { readonly subject: 'all' } | null = null;

  /** Settings grouped by category. */

  /** MCP server trust entries (populated when mcp tab is active). */

  /** Provider subscription entries (populated when subscriptions tab is active). */

  /** Connections-tab state; all of it driven by settings-modal-connections.ts. */
  public connectionEntries: ConnectionStatus[] = initialConnectionEntries();
  public gatewayMethods: GatewayMethodCatalog | null = null;
  public requestRender: (() => void) | null = null;
  public connectionsRefreshing = false;
  /** The Secure address list: the daemon's answer as rows (settings-navigation.ts secureAddressRows). */
  public secureAddressRows: readonly SecureAddressRow[] = SECURE_ADDRESS_CHECKING_ROWS;

  /**
   * Whether the user has entered search mode (pressed / or a printable key
   * in the search input). Distinct from searchQuery.length > 0 because the
   * user may have deleted all chars while remaining in search mode.
   * Renderer should display the search prompt when this is true.
   */

  /**
   * Current search query. Non-empty activates cross-category search mode.
   * Renderer should display searchResults instead of the per-category list
   * when searchQuery is non-empty.
   */

  /**
   * Ranked cross-category results when searchQuery is non-empty.
   * Populated by setSearchQuery(); empty when searchQuery is ''.
   */

  /**
   * Set after a network-category save that touches controlPlane or httpListener
   * config keys.  Renderer reads this to display a transient restart notice.
   * Cleared on next open() or close().
   */
  public lastSaveTriggeredRestart: 'control-plane' | 'http-listener' | 'web' | null = null;

  /** Accepted secret edits finish here; commitEdit remains a synchronous keystroke API. */

  private secretWriteSession = 0;

  private configManager: ConfigManager | null = null;
  private unsubscribeHostSetting: (() => void) | null = null;
  /** The managed-policy read of the user action in progress; see _refreshPolicyAvailability. */
  private actionPolicy: SettingsPolicyRead | undefined = undefined;
  private secretsManager: SettingsSecretsManager | null = null;
  private daemonCredentials: SettingsDaemonCredentialWriter | null = null;
  private daemonConfig: DaemonOwnedConfigWriter | null = null;
  private reportError: ((message: string) => void) | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null = null;
  private onSettingApplied: SettingsModalChangeHandler | null = null;
  /** Every setting once, in browse order: what search filters (built with the topics). */
  private searchEntries: SettingEntry[] = [];

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
    this.unsubscribeHostSetting?.();
    this.unsubscribeHostSetting = null;
    this.configManager = configManager;
    this.secretsManager = secretsManager ?? null;
    this.daemonCredentials = options?.daemonCredentials ?? null;
    this.daemonConfig = options?.daemonConfig ?? null;
    this.reportError = options?.reportError ?? null;
    this.featureFlagManager = featureFlagManager;
    this.subscriptionManager = subscriptionManager;
    this.serviceRegistry = serviceRegistry;
    this.mcpRegistry = mcpRegistry ?? null;
    this.onSettingApplied = options?.onSettingApplied ?? null;
    this.groups = buildSettingGroups(configManager, featureFlagManager);
    this.topics = buildSettingsTopics(this.groups, TOPIC_LISTS);
    this.searchEntries = settingsTopicEntries(this.topics);
    this.mcpEntries = buildMcpEntries(this.mcpRegistry);
    this.subscriptionEntries = buildSubscriptionEntries(subscriptionManager, serviceRegistry);
    this.gatewayMethods = options?.gatewayMethods ?? null;
    this.requestRender = options?.requestRender ?? null;
    this.connectionEntries = initialConnectionEntries();
    this.topicIndex = 0;
    this.openList = null;
    this.openListRow = 0;
    this.selectedIndex = 0;
    this.focusRegion = 'categories';
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSaveTriggeredRestart = null;
    this.lastSettingEffectMessage = null;
    this.searchQuery = '';
    this.searchResults = [];
    this.searchFocused = false;
    this.contextScroll = 0;
    this.active = true;
    const unsubscribes = configManager.getHostSettingsSchema().filter((setting) => setting.type === 'boolean').map((setting) =>
      configManager.getHostBooleanSetting(setting.key).subscribe(() => {
        refreshSettingsPolicyAvailability(this.groups, configManager, this._policyRead(configManager));
        this.requestRender?.();
      }),
    );
    this.unsubscribeHostSetting = () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  /** Scroll the documentation region by `delta` wrapped lines (renderer clamps the top end). */
  scrollContext(delta: number): void {
    this.contextScroll = Math.max(0, this.contextScroll + delta);
  }

  close(): void {
    this.secretWriteSession++;
    this.unsubscribeHostSetting?.();
    this.unsubscribeHostSetting = null;
    this.active = false;
    this.resetSettingsInteraction();

    this.lastSaveTriggeredRestart = null;

    this.searchQuery = '';
    this.searchResults = [];
    this.searchFocused = false;
    this.contextScroll = 0;
    // A probe still in flight checks `active` before writing, so a reopen
    // starts from `checking` rather than from a finished session's answer.
    this.gatewayMethods = null;
    this.requestRender = null;
    this.connectionEntries = initialConnectionEntries();
    this.serviceRegistry = null;
    this.secretsManager = null;
    this.onSettingApplied = null;
    this.focusRegion = 'settings';
  }

  /** Enter search mode (focus the search input bar). */
  focusSearch(): void {
    this.searchFocused = true;
    this.selectedIndex = 0;
  }

  /** Exit search mode without clearing the query. */
  blurSearch(): void {
    this.searchFocused = false;
  }

  /**
   * Update the search query and recompute cross-category ranked results.
   * Setting an empty string clears search mode.
   */
  setSearchQuery(query: string): void {
    // A new search starts clean: the last change's message belongs to the row it was made on.
    if (query !== this.searchQuery) this.lastSettingEffectMessage = null;
    this.searchQuery = query;
    this.searchFocused = true;
    this.contextScroll = 0;
    if (query.trim().length === 0) {
      this.searchResults = [];
    } else {
      this.searchResults = searchSettingsInOrder(query, this.searchEntries, getSettingLabel);
    }
    this.selectedIndex = 0;
  }

  /** Clear search query, results, and exit search focus mode. */
  clearSearch(): void {
    this.searchQuery = '';
    this.searchResults = [];
    this.searchFocused = false;
  }

  /** Choose a topic; its first row is selected and any open list closes. */
  selectTopic(index: number): void {
    if (this.editingMode || this.topics.length === 0) return;
    this.topicIndex = ((index % this.topics.length) + this.topics.length) % this.topics.length;
    this.openList = null;
    this.selectedIndex = 0;
    this.contextScroll = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSettingEffectMessage = null;
  }

  /** The next topic (Down in the topic rail). */
  nextCategory(): void {
    this.selectTopic(this.topicIndex + 1);
  }

  /** The previous topic (Up in the topic rail). */
  prevCategory(): void {
    this.selectTopic(this.topicIndex - 1);
  }

  /** Left: back out of an open list, else to the topic rail. */
  focusCategories(): void {
    if (this.editingMode) return;
    if (this.leaveList()) return;
    this.focusRegion = 'categories';
  }

  focusSettings(): void {
    if (this.editingMode) return;
    this.focusRegion = 'settings';
  }

  toggleFocusRegion(): void {
    if (this.editingMode) return;
    if (this.focusRegion === 'settings') this.focusCategories();
    else this.focusRegion = 'settings';
  }

  /** Close the list a topic row opened, back on that row; false when none was open. */
  leaveList(): boolean {
    if (this.openList === null || this.editingMode) return false;
    this.openList = null;
    this.selectedIndex = this.openListRow;
    this.contextScroll = 0;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.focusRegion = 'settings';
    return true;
  }

  /** The chosen topic's rows as shown: a host field shows only while its mode is custom. */
  visibleRows(): readonly SettingsTopicRow<SettingEntry, SettingsCategory>[] {
    const rows = this.topicRows;
    const hidden = new Set(buildNetworkFilteredItems(
      rows.flatMap((row) => (row.kind === 'setting' && NETWORK_HOST_KEYS.has(row.entry.setting.key) ? [row.entry] : [])),
      this.configManager,
    ));
    return rows.filter((row) => row.kind !== 'setting' || !NETWORK_HOST_KEYS.has(row.entry.setting.key) || hidden.has(row.entry));
  }

  /** Where the selected setting's value comes from, in a sentence, when that is not its default. */
  describeSource(entry: SettingEntry): string | undefined {
    if (entry.kind === 'host') return entry.isDefault ? undefined : settingSourceWords({ tier: 'global', program: 'the terminal app' });
    let tier: ReturnType<ConfigManager['describeConfigKeySource']>['tier'] | undefined;
    let runtime = false;
    try {
      const source = this.configManager?.describeConfigKeySource(entry.setting.key);
      tier = source?.tier;
      runtime = source?.effectiveOrigin === 'runtime';
    } catch {
      tier = undefined;
    }
    return settingSourceWords({ effectiveSource: entry.effectiveSource, tier, runtime, program: 'the terminal app' });
  }

  moveFocusedUp(): void {
    if (this.focusRegion === 'categories') this.prevCategory();
    else this.moveUp();
  }

  moveFocusedDown(): void {
    if (this.focusRegion === 'categories') this.nextCategory();
    else this.moveDown();
  }

  moveUp(): void {
    moveSettingsSelection(this, -1, {
      items: () => (this.openList === null ? this.visibleRows().length : 0),
      specialItems: () =>
        this.currentCategory === 'mcp'
          ? this.mcpEntries.length
          : this.currentCategory === 'subscriptions'
            ? this.subscriptionEntries.length
            : this.currentCategory === 'connections'
              ? this.connectionEntries.length
              : this.currentCategory === 'secure-address-now'
                ? this.secureAddressRows.length
                : 0,
      clearSearchConfirmation: false,
    });
  }

  moveDown(): void {
    moveSettingsSelection(this, 1, {
      items: () => (this.openList === null ? this.visibleRows().length : 0),
      specialItems: () =>
        this.currentCategory === 'mcp'
          ? this.mcpEntries.length
          : this.currentCategory === 'subscriptions'
            ? this.subscriptionEntries.length
            : this.currentCategory === 'connections'
              ? this.connectionEntries.length
              : this.currentCategory === 'secure-address-now'
                ? this.secureAddressRows.length
                : 0,
      clearSearchConfirmation: false,
    });
  }

  getSelected(): SettingEntry | null {
    // While searching, only a result is selectable: a search that matches
    // nothing selects nothing (not the category row it was started from).
    if (this.searchFocused) {
      return this.searchResults[Math.max(0, Math.min(this.searchResults.length - 1, this.selectedIndex))] ?? null;
    }
    if (this.openList !== null) return null;
    const row = this.selectedTopicRow(this.visibleRows());
    return row?.kind === 'setting' ? row.entry : null;
  }

  /** The selected topic row when it opens a list, while browsing. */
  getSelectedListRow(): SettingsCategory | null {
    if (this.searchFocused || this.openList !== null) return null;
    const row = this.selectedTopicRow(this.visibleRows());
    return row?.kind === 'list' ? row.list.category : null;
  }

  /**
   * Get the flag entry for the currently selected feature-unit header row, or
   * null when the selected row is a plain config setting. Feature-unit headers
   * now live across topical categories (not a single flags tab), so this reads
   * the selected SettingEntry's attached flag rather than a separate list.
   */
  getSelectedFlag(): FlagEntry | null {
    return this.getSelected()?.flag ?? null;
  }

  getSelectedMcp(): McpEntry | null {
    return selectedSettingsCategoryEntry(this.currentCategory, 'mcp', this.mcpEntries, this.selectedIndex);
  }

  getSelectedSubscription(): SubscriptionEntry | null {
    return selectedSettingsCategoryEntry(this.currentCategory, 'subscriptions', this.subscriptionEntries, this.selectedIndex);
  }

  /** The open list's category; `topic` while a topic's own rows are shown. */
  get currentCategory(): SettingsCategory | 'topic' {
    return this.openList ?? 'topic';
  }

  get currentItems(): SettingEntry[] {
    return this._currentItems();
  }

  /** Lands on a category or setting; any other text becomes the search, and the outcome says which. */
  selectTarget(target?: string): SettingsTargetOutcome {
    const wanted = target?.trim();
    if (!wanted) return 'none';
    this.contextScroll = 0;
    const found = findSettingsTopicTarget(this.topics, wanted, getSettingLabel);
    if (!found) {
      this.setSearchQuery(wanted);
      return 'not-found';
    }
    this.clearSearch();
    this.selectTopic(found.topicIndex);
    const row = this.topicRows[found.rowIndex];
    this.selectedIndex = Math.max(0, this.visibleRows().findIndex((candidate) => candidate === row));
    this.focusRegion = 'settings';
    if (found.kind === 'list') this._openList(found.category);
    return found.kind === 'setting' ? 'setting' : 'category';
  }

  /**
   * Toggle boolean or begin cycling enum values, or enter edit mode for string/number.
   */
  setPickerExecutionMode(value: string): void { this._setValue('permissions.mode', value); }

  refreshPickerValues(): void {
    if (this.configManager) refreshEntryValues(this.groups, this.configManager);
    this.contextScroll = 0;
  }

  activateSelected(): void {
    const list = this.getSelectedListRow();
    if (list !== null) {
      this._openList(list);
      return;
    }
    if (!this.searchFocused && this.currentCategory === 'secure-address-now') {
      this._activateSecureAddressRow();
      return;
    }
    this._refreshPolicyAvailability();
    _activateSelected({
      // While a search is shown the highlighted row is a search result (a setting): the
      // category the search started from never decides what Enter acts on.
      currentCategory: this.searchFocused ? 'search' : this.currentCategory,
      configManager: this.configManager,
      getSelectedMcp: () => this.getSelectedMcp(),
      getSelectedSubscription: () => this.getSelectedSubscription(),
      getSelected: () => this.getSelected(),
      setValue: (key, value) => this._setValue(key, value),
      setHostValue: (key, value) => this._setHostValue(key, value),
      setEditingMode: (v) => {
        this.editingMode = v;
      },
      setEditBuffer: (v) => {
        this.editBuffer = v;
      },
      setMcpAllowAllConfirmationTarget: (v) => {
        this.mcpAllowAllConfirmationTarget = v;
      },
      setSubscriptionLogoutConfirmationTarget: (v) => {
        this.subscriptionLogoutConfirmationTarget = v;
      },
      setPendingSettingsPickerAction: (v) => {
        this.pendingSettingsPickerAction = v;
      },
      setPendingModelPickerTarget: (v) => {
        this.pendingModelPickerTarget = v;
      },
      setPendingProviderModelPickerTarget: (v) => {
        this.pendingProviderModelPickerTarget = v;
      },
    });
  }

  /**
   * Handle a keystroke while a subscription logout confirm is pending.
   *
   * Follows the project-standard confirm contract (confirm-state.ts):
   *   - CONFIRM:  Enter, Return, or y  → executes logout, clears target
   *   - CANCEL:   Esc or n             → clears target, no logout
   *   - ABSORBED: any other key        → keeps confirm pending, swallows key
   *   - INACTIVE: no confirm pending   → returns 'inactive' (caller continues)
   */
  handleSubscriptionLogoutKey(key: string): 'confirmed' | 'cancelled' | 'absorbed' | 'inactive' {
    return _handleSubscriptionLogoutKey(
      {
        subscriptionLogoutConfirmationTarget: this.subscriptionLogoutConfirmationTarget,
        subscriptionManager: this.subscriptionManager,
        serviceRegistry: this.serviceRegistry,
        setSubscriptionEntries: (entries) => {
          this.subscriptionEntries = entries;
        },
        setSubscriptionLogoutConfirmationTarget: (v) => {
          this.subscriptionLogoutConfirmationTarget = v;
        },
        requestRender: () => this.requestRender?.(),
        reportFailure: (message) => {
          this.lastSettingEffectMessage = message;
        },
      },
      key,
    );
  }

  adjustSelected(direction: 'left' | 'right', step = 1): void {
    this._refreshPolicyAvailability();
    _adjustSelected(
      {
        editingMode: this.editingMode,
        currentCategory: this.currentCategory,
        configManager: this.configManager,
        featureFlagManager: this.featureFlagManager,
        mcpRegistry: this.mcpRegistry,
        getSelectedFlag: () => this.getSelectedFlag(),
        getSelectedMcp: () => this.getSelectedMcp(),
        getSelected: () => this.getSelected(),
        setValue: (key, value) => this._setValue(key, value),
        setHostValue: (key, value) => this._setHostValue(key, value),
        setMcpEntries: (entries) => {
          this.mcpEntries = entries;
        },
        setMcpAllowAllConfirmationTarget: (v) => {
          this.mcpAllowAllConfirmationTarget = v;
        },
        setEditingMode: (v) => {
          this.editingMode = v;
        },
        setEditBuffer: (v) => {
          this.editBuffer = v;
        },
        reportMcpTrust: (message) => {
          this.lastSettingEffectMessage = message;
          this.requestRender?.();
        },
      },
      direction,
      step,
    );
  }

  /**
   * Toggle the currently selected feature unit through its real domain
   * settings key: boolean/constant enablements flip the key, enum enablements
   * jump between the feature's stock active mode and its off mode. Killed
   * features cannot be toggled; constant capabilities with no off position
   * (non-boolean keys) are left to their domain settings.
   */
  toggleSelectedFlag(): void {
    this._refreshPolicyAvailability();
    const entry = this.getSelected();
    if (!entry?.flag || entry.metadataUnavailable) return;
    const feature = entry.flag.feature;
    const currentlyOn = isFeatureValueEnabled(feature, entry.currentValue);
    const write = featureEnablementWrite(feature.id, !currentlyOn);
    if (!write) return;
    this._setValue(write.key, write.value);
  }

  /**
   * Commit the current editBuffer to the config.
   * Returns true when accepted, false if validation failed or a secret write is pending.
   */
  commitEdit(): boolean {
    if (this.pendingSecretWrite) return false;
    this._refreshPolicyAvailability();
    return _commitEditValue({
      editingMode: this.editingMode,
      currentCategory: this.currentCategory,
      editBuffer: this.editBuffer,
      configManager: this.configManager,
      secretsManager: this.secretsManager,
      daemonCredentials: this.daemonCredentials,
      ...this._secretWriteContext(),
      mcpRegistry: this.mcpRegistry,
      mcpAllowAllConfirmationTarget: this.mcpAllowAllConfirmationTarget,
      getSelectedMcp: () => this.getSelectedMcp(),
      getSelected: () => this.getSelected(),
      setValue: (key, value) => this._setValue(key, value),
      rejectEdit: (message) => {
        this.lastSettingEffectMessage = message;
      },
      setEditingMode: (v) => {
        this.editingMode = v;
      },
      setEditBuffer: (v) => {
        this.editBuffer = v;
      },
      setMcpEntries: (entries) => {
        this.mcpEntries = entries;
      },
      setMcpAllowAllConfirmationTarget: (v) => {
        this.mcpAllowAllConfirmationTarget = v;
      },
      requestGuidedAction: (action) => {
        this.pendingGuidedAction = action;
      },
      reportMcpToolRule: (message, entries) => {
        this.lastSettingEffectMessage = message;
        this.mcpEntries = entries;
        this.requestRender?.();
      },
    });
  }

  private _secretWriteContext() {
    const configManager = this.configManager;
    const onApplied = this.onSettingApplied;
    const daemonConfig = this.daemonConfig;
    const groups = this.groups;
    let effectMessage: string | null = null;
    let secretWriteError: string | null = null;
    const session = this.secretWriteSession;
    // The transcript outlives the modal: a credential save that fails after
    // Esc is still reported there. Only the status line belongs to the session.
    const report = this.reportError;
    return {
      reportError: (message: string) => {
        secretWriteError = message;
        report?.(message);
        if (session !== this.secretWriteSession) return;
        this.lastSettingEffectMessage = message;
      },
      setSecretConfigValue: async (key: ConfigKey, value: unknown) => {
        if (!configManager) throw new Error('Settings owner unavailable.');
        // The setter validates the value (and the daemon path validates before
        // sending); a daemon-owned key is written by the daemon alone; this waits for its answer.
        const result = applySettingValue({
          key,
          value,
          configManager,
          groups,
          onSettingApplied: onApplied,
          refreshGroups: () => refreshEntryValues(groups, configManager, this._policyRead(configManager)),
          daemonConfig,
        });
        if (result.effectMessage?.startsWith('Save failed:')) throw new Error(result.effectMessage);
        if (result.settled) await result.settled;
        effectMessage = result.settled ? null : result.effectMessage;
      },
      trackSecretWrite: (write: Promise<boolean>, key?: ConfigKey) => {
        if (session === this.secretWriteSession) this.lastSettingEffectMessage = 'Saving credential…';
        this.pendingSecretWrite = write
          .then((ok) => {
            if (session === this.secretWriteSession) {
              if (ok) {
                // A cleared credential whose stored value could not be removed still completes; keep that warning.
                this.lastSettingEffectMessage = secretWriteError ?? effectMessage ?? 'Credential saved.';
                if (configManager) refreshEntryValues(this.groups, configManager);
                if (key && configManager) this._readBackDaemonCredential(key, configManager, session);
              } else this.lastSettingEffectMessage = secretWriteError ?? 'Saving that credential failed.';
              this.requestRender?.();
            }
            return ok;
          })
          .finally(() => {
            this.pendingSecretWrite = null;
          });
      },
    };
  }

  /**
   * A credential the daemon keeps is held there, not in this program's store: ask the daemon what it
   * now holds for the key (the read the save's own read-back makes) and show whether a value is held.
   */
  private _readBackDaemonCredential(key: ConfigKey, configManager: ConfigManager, session: number): void {
    const daemon = this.daemonConfig;
    if (!isDaemonOwnedConfigKey(key) || !daemon?.get) return;
    const show = (held: unknown, unknown: boolean): void => {
      if (session !== this.secretWriteSession) return;
      for (const entries of this.groups.values())
        for (const entry of entries) {
          if (entry.setting.key !== key) continue;
          entry.currentValue = unknown ? undefined : held;
          entry.isDefault = !unknown && (held === '' || held === undefined || held === entry.setting.default);
          entry.effectiveSource = unknown ? 'unavailable' : entry.effectiveSource;
          entry.sourceLabel = unknown ? 'the daemon could not be asked what it holds' : entry.sourceLabel;
        }
      this.requestRender?.();
    };
    void daemon.get(key).then(
      (held) => {
        if (held === undefined) return show(undefined, true);
        try {
          configManager.adoptDaemonValue(key, held);
        } catch {
          // The row still shows what the daemon holds.
        }
        show(held, false);
      },
      () => show(undefined, true),
    );
  }

  private _createSecretResetter(): (entries: ReadonlyArray<{ key: ConfigKey; value: unknown }>) => void {
    const configManager = this.configManager;
    const context = this._secretWriteContext();
    const secretsManager = this.secretsManager;
    const daemonCredentials = this.daemonCredentials;
    return (entries) => {
      if (!configManager || entries.length === 0) return;
      const writes = entries.map(({ key, value }) =>
        setSecretBackedSettingValue({
          key,
          value: String(value ?? ''),
          configManager,
          secretsManager,
          daemonCredentials,
          setConfigValue: context.setSecretConfigValue,
          onError: context.reportError,
        }),
      );
      context.trackSecretWrite(Promise.all(writes).then((results) => results.every(Boolean)));
    };
  }

  /** Cancel inline edit without saving. */
  cancelEdit(): void {
    this.editingMode = false;
    this.editBuffer = '';
    this.mcpAllowAllConfirmationTarget = null;
  }

  resetSelected(): { key: string; value: unknown } | null {
    if (this.pendingSecretWrite) return null;
    this._refreshPolicyAvailability();
    return _resetSelected({
      editingMode: this.editingMode,
      hasConfigManager: this.configManager !== null,
      selected: this.getSelected(),
      secretsManager: this.secretsManager,
      resetSecrets: this._createSecretResetter(),
      setValue: (key, value) => this._setValue(key, value, true),
      setHostValue: (key, value) => this._setHostValue(key, value),
    });
  }

  /** Arm a category-reset confirmation gate for the current category. */
  initiateResetCategory(): void {
    if (this.pendingSecretWrite) return;
    if (this.openList !== null) return;
    _initiateResetCategory({
      hasConfigManager: this.configManager !== null,
      currentCategory: this.topicLabel,
      setResetCategoryConfirm: (v) => {
        this.resetCategoryConfirm = v;
      },
      setResetAllConfirm: (v) => {
        this.resetAllConfirm = v;
      },
    });
  }

  /** Arm a reset-all confirmation gate. */
  initiateResetAll(): void {
    if (this.pendingSecretWrite) return;
    _initiateResetAll({
      hasConfigManager: this.configManager !== null,
      setResetCategoryConfirm: (v) => {
        this.resetCategoryConfirm = v;
      },
      setResetAllConfirm: (v) => {
        this.resetAllConfirm = v;
      },
    });
  }

  /** Route a key through the active reset confirm gate. See ResetConfirmKeyResult for the return contract. */
  handleResetConfirmKey(key: string): ResetConfirmKeyResult {
    if (this.pendingSecretWrite && (this.resetCategoryConfirm || this.resetAllConfirm) && (key === 'enter' || key === 'y'))
      return 'absorbed';
    if (this.resetCategoryConfirm || this.resetAllConfirm) this._refreshPolicyAvailability();
    const outcome = _handleResetConfirmKey({
      key,
      resetCategoryConfirm: this.resetCategoryConfirm,
      resetAllConfirm: this.resetAllConfirm,
      hasConfigManager: this.configManager !== null,
      currentItems: () => this._currentItems(),
      groups: this.groups,
      resetSecrets: this._createSecretResetter(),
      setValue: (k, value) => this._setValue(k, value, true),
      setHostValue: (key, value) => this._setHostValue(key, value),
      setResetCategoryConfirm: (v) => {
        this.resetCategoryConfirm = v;
      },
      setResetAllConfirm: (v) => {
        this.resetAllConfirm = v;
      },
    });
    if (typeof outcome === 'object' && outcome.failedKeys && outcome.failedKeys.length > 0) {
      const failed = outcome.failedKeys;
      const detail = this.lastSettingEffectMessage ? ` Last error: ${this.lastSettingEffectMessage}` : '';
      this.lastSettingEffectMessage = `Reset ${outcome.entries.length} setting(s); ${failed.length} could not be reset and keep their value: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', ...' : ''}.${detail}`;
    }
    return outcome;
  }

  /** Handle a keystroke in edit mode: regular chars appended, Backspace removes last char. */
  editChar(char: string): void {
    if (!this.editingMode) return;
    this.editBuffer += char;
  }

  // ── Private helpers ────────────────────────────────────────────────────────────────

  /** Show the list a topic row opens, reloading what it lists. */
  private _openList(category: SettingsCategory): void {
    this.openListRow = this.openList === null ? this.selectedIndex : this.openListRow;
    this.openList = category;
    this.selectedIndex = 0;
    this.contextScroll = 0;
    this.focusRegion = 'settings';
    this._reloadTabEntries();
  }

  /** Reload mcp/subscription entries when a list opens. */
  private _reloadTabEntries(): void {
    if (this.currentCategory === 'mcp') {
      this.mcpEntries = buildMcpEntries(this.mcpRegistry);
    } else if (this.currentCategory === 'subscriptions') {
      this.subscriptionEntries = buildSubscriptionEntries(this.subscriptionManager, this.serviceRegistry);
    } else if (this.currentCategory === 'connections') {
      void refreshConnectionEntries(this);
    } else if (this.currentCategory === 'secure-address-now') {
      // Asked of the daemon each time the list opens; the rows say "checking" until it answers.
      this.secureAddressRows = SECURE_ADDRESS_CHECKING_ROWS;
      const gateway = this.gatewayMethods;
      void readSecureAddressRows(gateway ? (method, input) => gateway.invoke(method, { context: { clientKind: 'tui' as const }, body: input }) : null).then((rows) => {
        if (!this.active) return;
        this.secureAddressRows = rows;
        this.requestRender?.();
      });
    }
  }

  /** Enter on a "Secure address now" row: an action row runs its daemon method (secureAddress.reissue); the others only explain. */
  private _activateSecureAddressRow(): void {
    const row = this.secureAddressRows[Math.max(0, Math.min(this.secureAddressRows.length - 1, this.selectedIndex))];
    if (!row?.action) return;
    const gateway = this.gatewayMethods;
    this.secureAddressRows = this.secureAddressRows.map((candidate) => candidate === row ? { ...candidate, state: 'issuing…' } : candidate);
    this.requestRender?.();
    void runSecureAddressRowAction(gateway ? (method, input) => gateway.invoke(method, { context: { clientKind: 'tui' as const }, body: input }) : null, row).then((rows) => {
      if (!this.active || !rows) return;
      this.secureAddressRows = rows;
      this.requestRender?.();
    });
  }

  /** The settings of the chosen topic as shown; [] while a list is open (its rows are not settings). */
  private _currentItems(): SettingEntry[] {
    if (this.openList !== null) return [];
    return this.visibleRows().flatMap((row) => (row.kind === 'setting' ? [row.entry] : []));
  }

  /**
   * One read of the managed policy per user action. Every row refresh the
   * action triggers (the write's own refresh, the host-setting subscription,
   * a refresh after an applied effect) takes this read instead of parsing
   * the policy file again; the setter's refusal stays the authority for the
   * write itself. The read is dropped once the action's synchronous work is
   * done, so a later daemon answer or credential save reads policy afresh.
   */
  private _refreshPolicyAvailability(): void {
    const configManager = this.configManager;
    if (!configManager) return;
    const policy = readSettingsPolicy(configManager);
    this.actionPolicy = policy;
    queueMicrotask(() => {
      if (this.actionPolicy === policy) this.actionPolicy = undefined;
    });
    refreshSettingsPolicyAvailability(this.groups, configManager, policy);
  }

  /** The current action's policy read, or a fresh one outside an action. */
  private _policyRead(configManager: ConfigManager): SettingsPolicyRead {
    return this.actionPolicy !== undefined && configManager === this.configManager ? this.actionPolicy : readSettingsPolicy(configManager);
  }

  private _setHostValue(key: string, value: boolean): boolean {
    if (!this.configManager) return false;
    const result = applyHostSettingValue({
      key,
      value,
      configManager: this.configManager,
      groups: this.groups,
      onSettingApplied: this.onSettingApplied,
      policy: this.actionPolicy,
    });
    this.lastSettingEffectMessage = result.effectMessage;
    return result.failed !== true;
  }

  private _setValue(key: ConfigKey, value: unknown, reset = false): boolean {
    if (!this.configManager) return false;

    const groups = this.groups;
    const callback: SettingAppliedCallback | null = this.onSettingApplied ? (change) => this.onSettingApplied!(change) : null;

    const result = applySettingValue({
      key,
      value,
      configManager: this.configManager,
      groups: this.groups,
      onSettingApplied: callback,
      refreshGroups: () => {
        if (this.configManager) refreshEntryValues(this.groups, this.configManager, this._policyRead(this.configManager));
      },
      daemonConfig: this.daemonConfig,
      onAsyncError: (message) => {
        // A late daemon refusal is about this open modal's rows only.
        if (this.groups !== groups) return;
        this.lastSettingEffectMessage = message;
        this.reportError?.(message);
        this.requestRender?.();
      },
      onAsyncSaved: (message) => {
        if (this.groups !== groups) return;
        this.lastSettingEffectMessage = message;
        this._syncFeatureHeadersForKey(key);
        this.requestRender?.();
      },
      ...(reset ? { reset: true } : {}),
    });

    // Feature-unit headers write plain domain keys; the platform settings bridge
    // has already applied the change to the gate manager (live flip for
    // runtime-toggleable features, pending-restart marker for startup-gated
    // ones). Re-read the manager for every header bound to this key so the
    // rows and the context region show the honest state at the point of change.
    this._syncFeatureHeadersForKey(key);

    if (result.restartDomain !== null) {
      this.lastSaveTriggeredRestart = result.restartDomain;
    }
    if (result.effectMessage !== null) {
      this.lastSettingEffectMessage = result.effectMessage;
    }
    // No-op (result.changed === false, effectMessage === null): leave lastSettingEffectMessage untouched.

    // Selecting 'prompt' for payments.cvvHandling states the tradeoff at the
    // moment of selection, not just in the documentation region, see the
    // platform's own CVV_PROMPT_TRADEOFF_WARNING (platform/payments). A refused
    // write keeps its "Save failed" reason: the mode is not in effect.
    if (key === PAYMENTS_CVV_HANDLING_CONFIG_KEY && value === 'prompt' && result.failed !== true) {
      this.lastSettingEffectMessage = CVV_PROMPT_TRADEOFF_WARNING;
    }
    return result.failed !== true;
  }

  /** Refresh live/persisted/pending state for every feature header bound to `key`. */
  private _syncFeatureHeadersForKey(key: ConfigKey): void {
    if (!this.featureFlagManager) return;
    for (const entries of this.groups.values()) {
      for (const entry of entries) {
        if (entry.flag && entry.flag.feature.enablement.key === key) {
          syncFlagEntryFromManager(entry.flag, this.featureFlagManager);
        }
      }
    }
  }
}
