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
/** Where a settings target landed. `not-found`: no category or key has that name, so the text became the search. */
export type SettingsTargetOutcome = 'category' | 'setting' | 'not-found' | 'none';

/** What `/settings <target>` and `/settings <target>` print when the target named no category or setting. */
export function settingsTargetNotFoundMessage(target: string): string {
  return `No setting or category is named "${target}"; the settings workspace is showing a search for it.`;
}

export function selectSettingsTarget<Category extends string>(
  state: { categoryIndex: number; selectedIndex: number; contextScroll: number },
  target: string | undefined,
  categories: readonly Category[],
  groups: ReadonlyMap<Category, readonly { readonly setting: { readonly key: string } }[]>,
  policy: {
    readonly resetScroll: boolean;
    readonly focusSettings: () => void;
    /** Show the settings search for `query`; how a prefix such as `fetch.` or a near-miss key still lands somewhere useful. */
    readonly search?: ((query: string) => void) | undefined;
  },
): SettingsTargetOutcome {
  const normalized = target?.trim();
  if (!normalized) return 'none';
  if (policy.resetScroll) state.contextScroll = 0;
  const lower = normalized.toLowerCase();
  const categoryIndex = categories.findIndex((category) => category.toLowerCase() === lower);
  if (categoryIndex >= 0) {
    state.categoryIndex = categoryIndex;
    state.selectedIndex = 0;
    policy.focusSettings();
    return 'category';
  }
  for (const [index, category] of categories.entries()) {
    const entryIndex = (groups.get(category) ?? []).findIndex((entry) => entry.setting.key.toLowerCase() === lower);
    if (entryIndex >= 0) {
      state.categoryIndex = index;
      state.selectedIndex = entryIndex;
      policy.focusSettings();
      return 'setting';
    }
  }
  policy.search?.(normalized);
  return 'not-found';
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
