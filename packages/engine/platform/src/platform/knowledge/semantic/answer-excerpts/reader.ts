import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { judgeSome } from '../../../runtime/judge.js';
import { knowledgeTerms } from '../../passages.js';
import { ANSWER_EXCERPT_SLOTS, answerExcerptSelection, answerExcerptState, type AnswerExcerptReadingSource } from './battery.js';
import { answerExcerptSpans } from './spans.js';
import { ANSWER_EXCERPT_LIMITS as LIMITS, type AnswerExcerptDocument, type AnswerExcerptSpan } from './types.js';
export * from './types.js';
export { answerExcerptSpans } from './spans.js';

export interface AnswerExcerptReading {
  readonly spans: readonly AnswerExcerptSpan[];
  /** `model`/`cache`: the reading chose the spans; `local`: it did not settle and the best-matching passages were kept. */
  readonly decidedBy: 'model' | 'cache' | 'local';
  /** Spans of the source that were not shown to the reading. */
  readonly omitted: number;
  readonly decisionId?: string | undefined;
}

function termScore(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const term of terms) if (lower.includes(term)) total += term.length >= 5 || /\d/.test(term) ? 2 : 1;
  return total;
}

/**
 * The spans one reading is shown: those sharing the most words with the
 * question (and the caller's hints) first, at most `passages` of them within
 * `requestBytes`, returned in document order. When no span shares a word the
 * leading spans are taken. `ranked` is best first, for the local fallback.
 */
export function shortlistAnswerExcerptSpans(query: string, hints: readonly unknown[], documents: readonly AnswerExcerptDocument[]): {
  readonly shortlist: readonly AnswerExcerptSpan[]; readonly ranked: readonly AnswerExcerptSpan[]; readonly omitted: number;
} {
  const spans = answerExcerptSpans(documents);
  const terms = knowledgeTerms([query, ...hints]);
  const scored = spans.map((span, order) => ({ span, order, score: termScore(span.text, terms) }));
  const matching = scored.filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.order - right.order);
  const ranked = matching.length ? matching : scored;
  const encoder = new TextEncoder();
  const chosen: typeof scored = [];
  let bytes = 0;
  for (const entry of ranked) {
    if (chosen.length >= LIMITS.passages) break;
    const size = encoder.encode(entry.span.text).byteLength;
    if (bytes + size > LIMITS.requestBytes) continue;
    bytes += size;
    chosen.push(entry);
  }
  return { shortlist: [...chosen].sort((left, right) => left.order - right.order).map((entry) => entry.span),
    ranked: chosen.map((entry) => entry.span), omitted: spans.length - chosen.length };
}

/**
 * One request reads the shortlisted spans of one source. A span the reading
 * says yes to is kept; when no span settles (no decision model, deadline,
 * unsure) the best-matching spans are kept instead, so a packet or a search
 * hit still quotes the source. Never throws for an unsettled reading.
 */
export async function readAnswerExcerpts(input: {
  readonly query: string;
  readonly source: AnswerExcerptReadingSource;
  readonly context: string;
  readonly hints?: readonly unknown[] | undefined;
  readonly documents: readonly AnswerExcerptDocument[];
  readonly signal?: AbortSignal | undefined;
}): Promise<AnswerExcerptReading> {
  const { shortlist, ranked, omitted } = shortlistAnswerExcerptSpans(input.query, input.hints ?? [], input.documents);
  if (shortlist.length === 0) return { spans: [], decidedBy: 'local', omitted };
  const state = answerExcerptState({ query: input.query, source: input.source, context: input.context, passages: shortlist });
  assertJudgmentInput(state);
  const slots = ANSWER_EXCERPT_SLOTS.slice(0, shortlist.length);
  const outcome = await judgeSome({
    site: answerExcerptSelection.name, battery: answerExcerptSelection, only: slots, state,
    ...(input.signal ? { signal: input.signal } : {}),
    settle: (readings): readonly number[] | null | undefined => {
      let settled = false;
      const kept = slots.flatMap((slot, index) => {
        const reading = readings[slot];
        if (reading?.outcome === 'act' && (reading.verdict === 'yes' || reading.verdict === 'no')) settled = true;
        return reading?.outcome === 'act' && reading.verdict === 'yes' ? [index] : [];
      });
      return settled ? kept : undefined;
    },
    fallback: (): readonly number[] | null => null,
    describe: (kept) => kept === null ? 'best-matching passages kept' : `passages: ${kept.length} of ${slots.length}`,
  });
  if (outcome.value === null) {
    const local = new Set(ranked.slice(0, LIMITS.fallbackPassages));
    return { spans: shortlist.filter((span) => local.has(span)), decidedBy: 'local', omitted };
  }
  const kept = new Set(outcome.value);
  return { spans: shortlist.filter((_span, index) => kept.has(index)), decidedBy: outcome.source === 'cache' ? 'cache' : 'model', omitted,
    ...(outcome.decisionId ? { decisionId: outcome.decisionId } : {}) };
}
