import { tokenizeSemanticQuery } from './semantic/utils.js';

/** One paragraph-sized span of an extracted document, with where it came from. */
export interface KnowledgePassage {
  readonly origin: number;
  readonly index: number;
  readonly text: string;
}

export interface KnowledgePassageSelection {
  readonly passages: readonly KnowledgePassage[];
  /** Passages and characters that were not selected, so a reading can say what it did not see. */
  readonly omitted: { readonly passages: number; readonly characters: number };
}

const SENTENCE_END = /(?<=[.!?;:])\s+/u;

/** Cut a long run of text at sentence ends, then at the hard limit. */
function cut(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of text.split(SENTENCE_END)) {
    if (current && current.length + 1 + sentence.length > maxChars) { out.push(current); current = ''; }
    if (sentence.length > maxChars) {
      for (let at = 0; at < sentence.length; at += maxChars) out.push(sentence.slice(at, at + maxChars));
      continue;
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split each text into paragraph-sized passages. Short consecutive lines are
 * joined up to `maxChars`; identical passages are kept once.
 */
export function splitKnowledgePassages(texts: readonly (readonly unknown[])[], maxChars: number): KnowledgePassage[] {
  const seen = new Set<string>();
  const passages: KnowledgePassage[] = [];
  texts.forEach((values, origin) => {
    let index = 0;
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim()) continue;
      let current = '';
      const flush = () => {
        for (const piece of cut(current.trim(), maxChars)) {
          const key = piece.replace(/\s+/g, ' ').toLowerCase();
          if (!piece || seen.has(key)) continue;
          seen.add(key);
          passages.push({ origin, index: index++, text: piece });
        }
        current = '';
      };
      for (const line of value.split(/\r?\n/)) {
        if (!line.trim()) { if (current) flush(); continue; }
        if (current && current.length + 1 + line.length > maxChars) flush();
        current = current ? `${current}\n${line}` : line;
      }
      if (current) flush();
    }
  });
  return passages;
}

/** Distinct search terms of the values a reading is about (stop words dropped). */
export function knowledgeTerms(values: readonly unknown[]): string[] {
  const terms = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') { for (const token of tokenizeSemanticQuery(value)) if (token.length >= 3 || /\d/.test(token)) terms.add(token); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { terms.add(String(value)); return; }
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    if (value && typeof value === 'object') for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  for (const value of values) visit(value, 0);
  return [...terms];
}

function score(text: string, terms: readonly string[], phrases: readonly string[]): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const term of terms) if (lower.includes(term)) total += term.length >= 5 || /\d/.test(term) ? 2 : 1;
  for (const phrase of phrases) if (lower.includes(phrase)) total += 10;
  return total;
}

/**
 * Pick the passages that mention the terms, best first, until `budgetBytes`
 * (UTF-8) is spent; the chosen passages are returned in document order. When
 * no passage mentions any term, the leading passages are taken instead so the
 * reader still sees how the document starts.
 */
export function selectKnowledgePassages(passages: readonly KnowledgePassage[], terms: readonly string[], budgetBytes: number,
  phrases: readonly string[] = []): KnowledgePassageSelection {
  const encoder = new TextEncoder();
  const lowered = phrases.map((phrase) => phrase.trim().toLowerCase()).filter((phrase) => phrase.length >= 8);
  const scored = passages.map((passage, order) => ({ passage, order, score: score(passage.text, terms, lowered) }));
  const matching = scored.filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.order - right.order);
  const ranked = matching.length ? matching : scored;
  const chosen: typeof scored = [];
  let used = 0;
  for (const entry of ranked) {
    const bytes = encoder.encode(entry.passage.text).byteLength;
    if (used + bytes > budgetBytes) continue;
    used += bytes;
    chosen.push(entry);
  }
  chosen.sort((left, right) => left.order - right.order);
  const chosenSet = new Set(chosen.map((entry) => entry.order));
  let characters = 0;
  for (const entry of scored) if (!chosenSet.has(entry.order)) characters += entry.passage.text.length;
  return { passages: chosen.map((entry) => entry.passage), omitted: { passages: passages.length - chosen.length, characters } };
}
