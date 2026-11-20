import type { McpEntry } from './settings-model-types.js';
import type { SettingsGuidedAction } from './settings-mcp-entries.js';
import type { SubscriptionEntry } from './settings-subscriptions.js';
import type { SettingsTopicRow, SettingsTopicView } from './settings-navigation.js';
/** One private state instance per settings surface; product types keep their exact target/action vocabulary. */
export class TerminalSettingsModalState<Category extends string, Entry, Target extends string, Action extends string> {
  public active = false;
  /** Index into `topics`: the topic the rail has chosen. */
  public topicIndex = 0;
  /** The seven topics' rows, built once when the screen opens (and again when the program rebuilds its rows). */
  public topics: SettingsTopicView<Entry, Category>[] = [];
  /** A list a topic row opened (MCP servers, sign-ins, features), shown in place of the topic's rows until Left or Esc. */
  public openList: Category | null = null;
  /** The topic's row the open list was opened from, selected again when it closes. */
  public openListRow = 0;
  public selectedIndex = 0;
  public editingMode = false;
  public editBuffer = '';
  public contextScroll = 0;
  public mcpAllowAllConfirmationTarget: string | null = null;
  public pendingModelPickerTarget: Target | null = null;
  public pendingProviderModelPickerTarget: Target | null = null;
  public pendingSettingsPickerAction: Action | null = null;
  /** A described command's action the route opens as its guided path once Settings closes. */
  public pendingGuidedAction: SettingsGuidedAction | null = null;
  public subscriptionLogoutConfirmationTarget: string | null = null;
  public groups: Map<Category, Entry[]> = new Map();
  public mcpEntries: McpEntry[] = [];
  public subscriptionEntries: SubscriptionEntry[] = [];
  public searchQuery = '';
  public searchResults: Entry[] = [];
  public lastSettingEffectMessage: string | null = null;
  public pendingSecretWrite: Promise<boolean> | null = null;
  editBackspace(): void {
    if (this.editingMode) this.editBuffer = this.editBuffer.slice(0, -1);
  }
  /** The chosen topic's name. */
  get topicLabel(): string {
    return this.topics[this.topicIndex]?.label ?? 'Settings';
  }
  /** The chosen topic's rows. */
  get topicRows(): readonly SettingsTopicRow<Entry, Category>[] {
    return this.topics[this.topicIndex]?.rows ?? [];
  }
  /** The topic row the selection is on, while browsing a topic (not searching, no list open). */
  protected selectedTopicRow(rows: readonly SettingsTopicRow<Entry, Category>[]): SettingsTopicRow<Entry, Category> | null {
    if (rows.length === 0) return null;
    return rows[Math.max(0, Math.min(rows.length - 1, this.selectedIndex))] ?? null;
  }
  protected resetSettingsInteraction(): void {
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.pendingGuidedAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSettingEffectMessage = null;
  }
}
