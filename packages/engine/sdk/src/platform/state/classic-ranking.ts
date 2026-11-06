/** Literal retrieval score, never a probability or a semantic verification result. */
export function classicLexicalOverlap(query: string, text: string): number {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  if (!terms.length) return 0;
  const haystack = text.toLocaleLowerCase();
  return terms.filter(term => haystack.includes(term)).length / terms.length;
}
