/** Local catalog retrieval. Scores measure literal token overlap, never model confidence. */
export interface ClassicCatalogDescription { readonly id: string; readonly description: string; }
export interface ClassicCatalogMatch<T> {
  readonly entry: T; readonly index: number; readonly score: number; readonly provenance: 'classic';
}
export function rankClassicCatalog<T>(entries: readonly T[], query: string,
  describe: (entry: T) => ClassicCatalogDescription): readonly ClassicCatalogMatch<T>[] {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  if (!terms.length) return [];
  return entries.map((entry, index) => {
    const value = describe(entry);
    const text = `${value.id}\n${value.description}`.toLocaleLowerCase();
    const score = terms.filter(term => text.includes(term)).length / terms.length;
    return { entry, index, score, provenance: 'classic' as const };
  }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
}

/** Automatic selection requires one exact declared identifier. Search results are suggestions only. */
export function selectClassicCatalog<T>(entries: readonly T[], query: string,
  describe: (entry: T) => ClassicCatalogDescription): T | null {
  const id = query.trim().toLocaleLowerCase();
  if (!id) return null;
  const matches = entries.filter(entry => describe(entry).id.toLocaleLowerCase() === id);
  return matches.length === 1 ? matches[0] ?? null : null;
}
