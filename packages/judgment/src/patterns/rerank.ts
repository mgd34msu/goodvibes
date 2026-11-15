import { checkEachFixture, decisionHeader, fixtureCheck, NONE, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type EntryType, type JsonValue, type JudgmentPort } from '../port/types.ts';
import { captureChoiceAnswer } from '../port/answers.ts';
import { LIMITS } from '../port/limits.ts';
import { assertBand, type YesNoBand } from '../readings/bands.ts';
import { readYesNo, type YesNoReading } from '../readings/readings.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';
import { mapLimit } from './common.ts';

/**
 * Rerank: one yes/no per query-candidate pair, each in its own request so no
 * candidate becomes context for another, then sorted by probability (the
 * re-ranking cookbook). Fast search builds the shortlist; this orders it.
 * With `together`, every candidate is read in one request instead.
 */
export interface RerankSpec extends PatternHeader {
  /** What makes a candidate right for the query. Refer to `query` and `candidate`. */
  readonly instructions?: EntryType;
  readonly criteria?: { readonly true: EntryType; readonly false: EntryType };
  /** Band on the top candidate's probability; below it nothing is a confident match. */
  readonly band: YesNoBand;
  /** Pair requests in flight at once; default 8. */
  readonly concurrency?: number;
  /**
   * Read every candidate in one request: one Choice over the candidate ids and
   * "none". A candidate's yes-probability is its share against the "none"
   * share. For orderings that are enrichment, where a request per candidate
   * costs more than the order is worth; candidates are then read side by side.
   */
  readonly together?: boolean;
  readonly fixtures: readonly RerankFixture[];
}

export interface Candidate {
  readonly id: string;
  readonly content: JsonValue;
}

export interface RerankFixture {
  readonly name: string;
  readonly query: JsonValue;
  readonly candidates: readonly Candidate[];
  /** The candidate that should rank first, or 'none' when no candidate fits. */
  readonly expect: { readonly top: string };
}

export interface Ranked {
  readonly id: string;
  readonly probability: number;
  readonly reading: YesNoReading;
  readonly decisionId: string | undefined;
  /** `together` only: the candidate's share of the one Choice, "none" included. */
  readonly share?: number;
}

export interface Reranking {
  /** Every candidate, best first. */
  readonly ranked: readonly Ranked[];
  /** The best candidate when its reading is a yes; undefined when nothing fits. */
  readonly top: Ranked | undefined;
}

export interface Rerank extends NamedDecision {
  rerank(port: JudgmentPort, query: JsonValue, candidates: readonly Candidate[], options?: CallOptions): Promise<Reranking>;
}

const DEFAULT_INSTRUCTIONS = 'Does `candidate` answer or satisfy `query`?';
const DEFAULT_CRITERIA = {
  true: 'The candidate directly provides what the query is looking for.',
  false: 'The candidate is only on a similar topic, or does not provide what the query asks for.',
};

const DEFAULT_CONCURRENCY = 8;
/** Candidates one `together` request can offer beside "none". */
export const MAX_TOGETHER_CANDIDATES = LIMITS.maxChoiceOptions - 1;
const NONE_FITS = 'No candidate satisfies the test.';

function topCheck(fixture: RerankFixture, best: Ranked, top: Ranked | undefined): FixtureCheck {
  const { probability, reading } = best;
  return fixtureCheck(fixture.name, 'top', fixture.expect.top, top?.id ?? NONE, top === undefined ? 1 - probability : probability, reading.outcome);
}

export function defineRerank(spec: RerankSpec): Rerank {
  const header = decisionHeader(spec);
  assertBand(spec.band);
  for (const fixture of spec.fixtures) {
    const ids = new Set(fixture.candidates.map((candidate) => candidate.id));
    if (ids.size !== fixture.candidates.length) throw new RangeError(`rerank ${spec.name}: fixture ${fixture.name} repeats a candidate id`);
    if (fixture.expect.top !== NONE && !ids.has(fixture.expect.top)) {
      throw new RangeError(`rerank ${spec.name}: fixture ${fixture.name} expects unknown candidate "${fixture.expect.top}"`);
    }
  }
  const question = noul(spec.instructions ?? DEFAULT_INSTRUCTIONS, spec.criteria ?? DEFAULT_CRITERIA);
  const criteria = spec.criteria ?? DEFAULT_CRITERIA;
  const togetherInstructions = {
    task: 'Each entry of `candidates` is one candidate. Pick the candidate that best passes the test for `query`, or "none" when no candidate passes it.',
    test: spec.instructions ?? DEFAULT_INSTRUCTIONS,
    passes: criteria.true,
    fails: criteria.false,
  };

  const rankTogether = async (port: JudgmentPort, query: JsonValue, candidates: readonly Candidate[], options: CallOptions): Promise<Reranking> => {
    if (candidates.length === 0) return { ranked: [], top: undefined };
    const ids = candidates.map((candidate) => candidate.id);
    if (candidates.length > MAX_TOGETHER_CANDIDATES) throw new RangeError(`rerank ${spec.name}: one request holds at most ${MAX_TOGETHER_CANDIDATES} candidates, got ${candidates.length}`);
    if (new Set(ids).size !== ids.length || ids.includes(NONE)) throw new RangeError(`rerank ${spec.name}: candidate ids must be unique and not "${NONE}"`);
    const optionMap = { ...Object.fromEntries(ids.map((id) => [id, null])), [NONE]: NONE_FITS };
    const state = { query, candidates: candidates.map(({ id, content }) => ({ id, content })) };
    const result = await askAs(port, spec, 'rerank', state, { rank: choice(togetherInstructions, optionMap) }, options);
    const { probabilities } = captureChoiceAnswer(result.answers.rank);
    const none = probabilities[NONE] ?? 0;
    const ranked = candidates.map(({ id }): Ranked => {
      const share = probabilities[id] ?? 0;
      const reading = readYesNo({ type: 'noul', noul: share + none > 0 ? share / (share + none) : 0 }, spec.band);
      return { id, probability: reading.probability, reading, decisionId: result.decisionId, share };
    }).sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
    recordReadings(port, result, { none, top: ranked.slice(0, 5).map(({ id, share, reading }) => ({ id, share: share ?? 0, verdict: reading.verdict })) });
    const [best] = ranked;
    return { ranked, top: best?.reading.verdict === 'yes' ? best : undefined };
  };

  const rerank: Rerank = {
    ...header,
    async rerank(port, query, candidates, options = {}) {
      if (spec.together) return rankTogether(port, query, candidates, options);
      const scorePair = async ({ id, content }: Candidate): Promise<Ranked> => {
        const result = await askAs(port, spec, 'rerank', { query, candidate: content }, { match: question }, options);
        const reading = readYesNo(result.answers.match, spec.band);
        recordReadings(port, result, { candidate: id, match: reading });
        return { id, probability: reading.probability, reading, decisionId: result.decisionId };
      };
      const ranked = (await mapLimit(candidates, spec.concurrency ?? DEFAULT_CONCURRENCY, scorePair)).sort((a, b) => b.probability - a.probability);
      const [best] = ranked;
      return { ranked, top: best?.reading.verdict === 'yes' ? best : undefined };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const { ranked, top } = await rerank.rerank(port, fixture.query, fixture.candidates, run);
        return topCheck(fixture, ranked[0]!, top);
      }),
  };
  return rerank;
}
