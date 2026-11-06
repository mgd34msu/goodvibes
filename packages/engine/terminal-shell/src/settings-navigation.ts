interface SettingsSelectionState {
  editingMode: boolean;
  contextScroll: number;
  searchFocused: boolean;
  selectedIndex: number;
  readonly searchResults: readonly unknown[];
  readonly currentCategory: string;
  subscriptionLogoutConfirmationTarget: string | null;
}
export function moveSettingsSelection(
  state: SettingsSelectionState,
  direction: -1 | 1,
  policy: {
    readonly items: () => number;
    readonly specialItems: () => number;
    readonly clearSearchConfirmation: boolean;
  },
): void {
  if (state.editingMode) return;
  state.contextScroll = 0;
  if (state.searchFocused) {
    const count = state.searchResults.length;
    if (count > 0) {
      state.selectedIndex = (state.selectedIndex + direction + count) % count;
      if (policy.clearSearchConfirmation) state.subscriptionLogoutConfirmationTarget = null;
    }
    return;
  }
  const count = policy.items();
  if (count > 0) {
    state.selectedIndex = (state.selectedIndex + direction + count) % count;
    state.subscriptionLogoutConfirmationTarget = null;
    return;
  }
  const special = policy.specialItems();
  if (special > 0) {
    state.selectedIndex = (state.selectedIndex + direction + special) % special;
    if (state.currentCategory === 'subscriptions') state.subscriptionLogoutConfirmationTarget = null;
  }
}
export function selectSettingsTarget<Category extends string>(
  state: { categoryIndex: number; selectedIndex: number; contextScroll: number },
  target: string | undefined,
  categories: readonly Category[],
  groups: ReadonlyMap<Category, readonly { readonly setting: { readonly key: string } }[]>,
  policy: { readonly resetScroll: boolean; readonly focusSettings: () => void },
): void {
  const normalized = target?.trim();
  if (!normalized) return;
  if (policy.resetScroll) state.contextScroll = 0;
  const categoryIndex = categories.findIndex((category) => category === normalized);
  if (categoryIndex >= 0) {
    state.categoryIndex = categoryIndex;
    state.selectedIndex = 0;
    policy.focusSettings();
    return;
  }
  for (const [index, category] of categories.entries()) {
    const entryIndex = (groups.get(category) ?? []).findIndex((entry) => entry.setting.key === normalized);
    if (entryIndex >= 0) {
      state.categoryIndex = index;
      state.selectedIndex = entryIndex;
      policy.focusSettings();
      return;
    }
  }
}

export function selectedSettingsCategoryEntry<Entry>(
  category: string,
  expected: string,
  entries: readonly Entry[],
  index: number,
): Entry | null {
  if (category !== expected || entries.length === 0) return null;
  return entries[Math.max(0, Math.min(entries.length - 1, index))] ?? null;
}
