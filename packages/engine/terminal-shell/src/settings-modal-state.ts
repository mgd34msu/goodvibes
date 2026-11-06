import type { McpEntry } from './settings-model-types.js';
import type { SubscriptionEntry } from './settings-subscriptions.js';
/** One private state instance per settings surface; product types keep their exact target/action vocabulary. */
export class TerminalSettingsModalState<Category extends string, Entry, Target extends string, Action extends string> {
  public active = false;
  public categoryIndex = 0;
  public selectedIndex = 0;
  public editingMode = false;
  public editBuffer = '';
  public contextScroll = 0;
  public mcpAllowAllConfirmationTarget: string | null = null;
  public pendingModelPickerTarget: Target | null = null;
  public pendingProviderModelPickerTarget: Target | null = null;
  public pendingSettingsPickerAction: Action | null = null;
  public subscriptionLogoutConfirmationTarget: string | null = null;
  public groups: Map<Category, Entry[]> = new Map();
  public mcpEntries: McpEntry[] = [];
  public subscriptionEntries: SubscriptionEntry[] = [];
  public searchFocused = false;
  public searchQuery = '';
  public searchResults: Entry[] = [];
  public lastSettingEffectMessage: string | null = null;
  public pendingSecretWrite: Promise<boolean> | null = null;
  protected resetSettingsInteraction(): void {
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSettingEffectMessage = null;
  }
}
