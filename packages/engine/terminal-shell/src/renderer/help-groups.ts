/**
 * Filter titled groups by a query: a group whose title matches keeps all its
 * items, otherwise only the items that match; groups left empty are dropped
 * (also for an empty query, so no title is drawn over nothing). The keyboard
 * shortcuts overlay filters its groups with it.
 */
export function filterTitledGroups<G extends { readonly title: string }, I>(
  groups: readonly G[],
  query: string,
  itemsOf: (group: G) => readonly I[],
  withItems: (group: G, items: readonly I[]) => G,
  matches: (item: I, lowerQuery: string) => boolean,
): G[] {
  const q = query.trim().toLowerCase();
  return groups
    .map((g) => (q === '' || g.title.toLowerCase().includes(q) ? g : withItems(g, itemsOf(g).filter((item) => matches(item, q)))))
    .filter((g) => itemsOf(g).length > 0);
}
