/**
 * Search over the settings screen of both terminal apps: every word of the
 * query must occur in a setting's key, name or description.
 */

export interface SearchSettingEntry {
  readonly setting: { readonly key: string; readonly description?: string | undefined };
}

// ---------------------------------------------------------------------------
// fuzzyScoreSettingEntry, score an entry against a query for ranked search
// ---------------------------------------------------------------------------

/** Score of one query word in one entry: the best field it occurs in, earlier is better. */
function wordScore(word: string, key: string, label: string, description: string): number | null {
  const keyIdx = key.indexOf(word);
  if (keyIdx !== -1) return 3000 + Math.max(0, 999 - keyIdx);
  const labelIdx = label.indexOf(word);
  if (labelIdx !== -1) return 2000 + Math.max(0, 999 - labelIdx);
  const descIdx = description.indexOf(word);
  if (descIdx !== -1) return 1000 + Math.max(0, 999 - descIdx);
  return null;
}

/**
 * Score a single SettingEntry against a search query.
 *
 * The query is split on spaces and every word must occur, as written, in the
 * key, the label or the description. Each word scores by the best field it
 * occurs in (key 3000, label 2000, description 1000, plus up to 999 for an
 * earlier position), and the entry's score is the sum. A query whose words all
 * occur together in one field gets that field's score once more, so the exact
 * phrase ranks first.
 *
 * Returns null when any word does not occur: a typo matches nothing.
 *
 * @param query - The search string.
 * @param entry - The setting entry to test.
 * @param getLabel - Pure function mapping an entry to its display label.
 */
export function fuzzyScoreSettingEntry<Entry extends SearchSettingEntry>(
  query: string,
  entry: Entry,
  getLabel: (e: Entry) => string,
): number | null {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return 0;
  const key = entry.setting.key.toLowerCase();
  const label = getLabel(entry).toLowerCase();
  const description = (entry.setting.description ?? '').toLowerCase();
  let score = 0;
  for (const word of words) {
    const scored = wordScore(word, key, label, description);
    if (scored === null) return null;
    score += scored;
  }
  if (words.length > 1) score += wordScore(words.join(' '), key, label, description) ?? 0;
  return score;
}

/**
 * The settings every word of the query occurs in (by name, key or
 * description), in the order the topics list them, as the web UI's settings
 * search keeps its own order. Entries arrive once each, in browse order.
 */
export function searchSettingsInOrder<Entry extends SearchSettingEntry>(
  query: string,
  entries: readonly Entry[],
  getLabel: (e: Entry) => string,
): Entry[] {
  if (query.trim().length === 0) return [];
  const lq = query.trim().toLowerCase();
  const found = entries.filter((entry) => fuzzyScoreSettingEntry(lq, entry, getLabel) !== null);
  // A setting named exactly, by key or name, leads; the rest keep the topics' order.
  const exact = found.findIndex((entry) => entry.setting.key.toLowerCase() === lq || getLabel(entry).toLowerCase() === lq);
  if (exact > 0) found.unshift(...found.splice(exact, 1));
  return found;
}
