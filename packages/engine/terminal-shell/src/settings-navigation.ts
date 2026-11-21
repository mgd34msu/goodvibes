import { SETTING_TOPICS, UNCLAIMED_SETTINGS_SECTION, sectionOfNamespace, type SettingTopicId } from '@goodvibes/engine/platform/platform/config/setting-topics';

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
/** Where a settings target landed. `not-found`: no topic or setting has that name, so the text became the search. */
export type SettingsTargetOutcome = 'category' | 'setting' | 'not-found' | 'none';

/** What `/settings open <target>` prints when the target named no topic or setting. */
export function settingsTargetNotFoundMessage(target: string): string {
  return `No topic or setting is named "${target}"; settings is showing a search for it.`;
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

// ---------------------------------------------------------------------------
// Topics: the seven the web UI shows, each listing its sections' settings
// ---------------------------------------------------------------------------

/** Where a setting is filed: a topic and a section. */
export interface SettingPlace {
  readonly topic: SettingTopicId;
  readonly sectionId: string;
  /** The section's name; `/settings <section>` lands on its first row. */
  readonly section: string;
}

/**
 * Where a setting is filed: its key's own section, as the web UI files it. A
 * key no section claims (a program's own setting) is filed with the group
 * the program lists it in, so a terminal-only row sits beside its neighbours.
 */
export function settingPlace(key: string, listedUnder: string): SettingPlace {
  const own = sectionOfNamespace(key.split('.', 1)[0] ?? key);
  const place = own.section.id === UNCLAIMED_SETTINGS_SECTION ? sectionOfNamespace(listedUnder) : own;
  return { topic: place.topic, sectionId: place.section.id, section: place.section.label };
}

/** A list a topic opens in place of a setting: MCP servers, provider sign-ins, features, connections. */
export interface SettingsTopicList<Category extends string> {
  readonly category: Category;
  /** Its name in a topic's rows. */
  readonly label: string;
  /** What it is, in a sentence: the help under the rows when it is selected. */
  readonly description: string;
  readonly topic: SettingTopicId;
  /** The section id it is filed under. */
  readonly sectionId: string;
}

export type SettingsTopicRow<Entry, Category extends string> =
  | { readonly kind: 'setting'; readonly entry: Entry; readonly place: SettingPlace }
  | { readonly kind: 'list'; readonly list: SettingsTopicList<Category>; readonly place: SettingPlace };

export interface SettingsTopicView<Entry, Category extends string> {
  readonly id: SettingTopicId;
  readonly label: string;
  readonly description: string;
  /** Every setting and list in this topic, section by section; a setting listed twice appears once. */
  readonly rows: readonly SettingsTopicRow<Entry, Category>[];
}

/**
 * Build the seven topics' rows once from a program's groups (category to
 * entries, in the program's order) and the lists it opens. Rows within a
 * section follow the section's own namespace order, then the program's order.
 */
export function buildSettingsTopics<Category extends string, Entry extends { readonly setting: { readonly key: string } }>(
  groups: ReadonlyMap<Category, readonly Entry[]>,
  lists: readonly SettingsTopicList<Category>[],
): SettingsTopicView<Entry, Category>[] {
  const bySection = new Map<string, { readonly rank: number; readonly row: SettingsTopicRow<Entry, Category> }[]>();
  const sectionOf = new Map<string, readonly string[]>();
  for (const topic of SETTING_TOPICS) for (const section of topic.sections) sectionOf.set(`${topic.id}/${section.id}`, section.namespaces);
  const seen = new Set<string>();
  let order = 0;
  const add = (place: SettingPlace, namespace: string, row: SettingsTopicRow<Entry, Category>): void => {
    const id = `${place.topic}/${place.sectionId}`;
    const namespaces = sectionOf.get(id) ?? [];
    const index = namespaces.indexOf(namespace);
    const rank = (index < 0 ? namespaces.length : index) * 100_000 + order++;
    const rows = bySection.get(id);
    if (rows) rows.push({ rank, row });
    else bySection.set(id, [{ rank, row }]);
  };
  for (const [category, entries] of groups) {
    for (const entry of entries) {
      const key = entry.setting.key;
      if (seen.has(key)) continue;
      seen.add(key);
      const place = settingPlace(key, category);
      const own = key.split('.', 1)[0] ?? key;
      add(place, sectionOfNamespace(own).section.id === UNCLAIMED_SETTINGS_SECTION ? category : own, { kind: 'setting', entry, place });
    }
  }
  for (const list of lists) {
    const section = SETTING_TOPICS.find((topic) => topic.id === list.topic)?.sections.find((candidate) => candidate.id === list.sectionId);
    if (!section) continue;
    const place: SettingPlace = { topic: list.topic, sectionId: section.id, section: section.label };
    add(place, '\u0000list', { kind: 'list', list, place });
  }
  return SETTING_TOPICS.map((topic) => ({
    id: topic.id,
    label: topic.label,
    description: topic.description,
    rows: topic.sections.flatMap((section) =>
      (bySection.get(`${topic.id}/${section.id}`) ?? []).sort((a, b) => a.rank - b.rank).map((item) => item.row),
    ),
  }));
}

/** Every setting entry of the topics, once each, in browse order: what search filters. */
export function settingsTopicEntries<Entry, Category extends string>(topics: readonly SettingsTopicView<Entry, Category>[]): Entry[] {
  const entries: Entry[] = [];
  for (const topic of topics) for (const row of topic.rows) if (row.kind === 'setting') entries.push(row.entry);
  return entries;
}

/** Where `/settings open <target>` lands: a topic, a section's first row, a list, or a setting by key or name. */
export type SettingsTopicTarget<Category extends string> =
  | { readonly kind: 'topic'; readonly topicIndex: number; readonly rowIndex: number }
  | { readonly kind: 'list'; readonly topicIndex: number; readonly rowIndex: number; readonly category: Category }
  | { readonly kind: 'setting'; readonly topicIndex: number; readonly rowIndex: number };

export function findSettingsTopicTarget<Entry extends { readonly setting: { readonly key: string } }, Category extends string>(
  topics: readonly SettingsTopicView<Entry, Category>[],
  target: string,
  label: (entry: Entry) => string,
): SettingsTopicTarget<Category> | null {
  const wanted = target.trim().toLowerCase();
  if (!wanted) return null;
  const topicIndex = topics.findIndex((topic) => topic.id === wanted || topic.label.toLowerCase() === wanted);
  if (topicIndex >= 0) return { kind: 'topic', topicIndex, rowIndex: 0 };
  for (const [index, topic] of topics.entries()) {
    for (const [rowIndex, row] of topic.rows.entries()) {
      if (row.kind === 'list' && (row.list.category.toLowerCase() === wanted || row.list.label.toLowerCase() === wanted))
        return { kind: 'list', topicIndex: index, rowIndex, category: row.list.category };
      if (row.kind === 'setting' && (row.entry.setting.key.toLowerCase() === wanted || label(row.entry).toLowerCase() === wanted))
        return { kind: 'setting', topicIndex: index, rowIndex };
    }
  }
  // A section's name or id, or a namespace ("network", "sandbox"): the first row filed there.
  for (const [index, topic] of topics.entries()) {
    const rowIndex = topic.rows.findIndex(
      (row) =>
        row.place.section.toLowerCase() === wanted ||
        row.place.sectionId === wanted ||
        (row.kind === 'setting' && (row.entry.setting.key.split('.', 1)[0] ?? '').toLowerCase() === wanted),
    );
    if (rowIndex >= 0) return { kind: 'topic', topicIndex: index, rowIndex };
  }
  return null;
}
