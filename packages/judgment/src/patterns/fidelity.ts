import { checkEachFixture, decisionHeader, fixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, type ChoiceResponse, type JudgmentPort, type JudgmentResult, type Questions } from '../port/types.ts';
import { assertChoiceBand, type ChoiceBand, type Outcome } from '../readings/bands.ts';
import { readChoice, type ChoiceReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

export type Fidelity = 'supported' | 'contradicted' | 'unsupported' | 'fabricated';

const RELATIONS = {
  supports: 'The source states the claim or directly implies that it is true.',
  contradicts: 'The source states the opposite of the claim or implies it is false.',
  says_nothing: 'The source does not address what the claim asserts, either way.',
} as const;
type Relation = keyof typeof RELATIONS;
const TO_FIDELITY: Readonly<Record<Relation, Fidelity>> = {
  supports: 'supported',
  contradicts: 'contradicted',
  says_nothing: 'unsupported',
};

/**
 * Fidelity check (double-checking citations): is a claim faithful to its
 * source? A quote the claim rests on is first looked up in the source by
 * plain string match, since a missing quote is fabricated and needs no
 * model. Otherwise one Choice reads how the source relates to the claim.
 * Used for citations, compaction summaries and extracted facts alike.
 */
export interface FidelitySpec extends PatternHeader {
  readonly band: ChoiceBand<Relation>;
  readonly fixtures: readonly {
    readonly name: string;
    readonly claim: string;
    readonly source: string;
    readonly quote?: string;
    readonly expect: Fidelity;
  }[];
}

export interface FidelityResult {
  readonly fidelity: Fidelity;
  /** Absent when a missing quote settled the case without asking. */
  readonly reading: ChoiceReading<Relation> | undefined;
  readonly outcome: Outcome;
  readonly decisionId: string | undefined;
  /** The call's token usage; absent when a missing quote settled the case without asking. */
  readonly usage: JudgmentResult<Questions>['usage'] | undefined;
  recordAction(action: string): void;
}

export interface FidelityClaim {
  readonly claim: string;
  readonly quote?: string;
}

export interface FidelityChecker extends NamedDecision {
  check(port: JudgmentPort, claim: string, source: string, quote?: string, options?: CallOptions): Promise<FidelityResult>;
  /**
   * Several claims against one source in a single reading: the source is sent
   * once and every claim gets its own question. Results are in claim order; a
   * claim whose quote is missing is settled as fabricated without asking.
   */
  checkAll(port: JudgmentPort, claims: readonly FidelityClaim[], source: string, options?: CallOptions): Promise<readonly FidelityResult[]>;
}

/** Whitespace collapsed and curly quotes folded, so a quote matches across line wraps. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function defineFidelityChecker(spec: FidelitySpec): FidelityChecker {
  const header = decisionHeader(spec);
  assertChoiceBand(`fidelity ${spec.name}`, spec.band as ChoiceBand, Object.keys(RELATIONS));
  const question = choice('How does `source` relate to `claim`?', RELATIONS);

  const checker: FidelityChecker = {
    ...header,
    async check(port, claim, source, quote, options = {}) {
      // A quote with no text (empty or only whitespace) is contained in every source; it is not evidence.
      const needle = quote === undefined ? undefined : normalizeForMatch(quote);
      if (needle !== undefined && (needle === '' || !normalizeForMatch(source).includes(needle))) {
        return { fidelity: 'fabricated', reading: undefined, outcome: 'act', decisionId: undefined, usage: undefined, recordAction: () => {} };
      }
      const result = await askAs(port, spec, 'fidelity', { claim, source }, { relation: question }, options);
      const reading = readChoice(result.answers.relation, spec.band as ChoiceBand) as ChoiceReading<Relation>;
      const fidelity = TO_FIDELITY[reading.choice];
      recordReadings(port, result, { fidelity, relation: reading });
      return {
        fidelity,
        reading,
        outcome: reading.outcome,
        decisionId: result.decisionId,
        usage: result.usage,
        recordAction: (action) => recordAction(port, result.decisionId, action),
      };
    },
    async checkAll(port, claims, source, options = {}) {
      const normalizedSource = normalizeForMatch(source);
      const fabricated = claims.map((item) => {
        const needle = item.quote === undefined ? undefined : normalizeForMatch(item.quote);
        return needle !== undefined && (needle === '' || !normalizedSource.includes(needle));
      });
      const asked = claims.flatMap((item, index) => (fabricated[index] ? [] : [{ index, claim: item.claim }]));
      const settled = (): FidelityResult => ({ fidelity: 'fabricated', reading: undefined, outcome: 'act', decisionId: undefined, usage: undefined, recordAction: () => {} });
      if (asked.length === 0) return claims.map(settled);
      const questions: Questions = Object.fromEntries(asked.map((_item, position) =>
        [`relation_${position}`, choice(`How does \`source\` relate to \`claims[${position}]\`?`, RELATIONS)]));
      const result = await askAs(port, spec, 'fidelity', { claims: asked.map((item) => item.claim), source }, questions, options);
      const readings = asked.map((_item, position) =>
        readChoice(result.answers[`relation_${position}`] as ChoiceResponse, spec.band as ChoiceBand) as ChoiceReading<Relation>);
      recordReadings(port, result, { relations: readings.map((reading) => ({ fidelity: TO_FIDELITY[reading.choice], relation: reading })) });
      const byIndex = new Map(asked.map((item, position) => [item.index, readings[position]!] as const));
      return claims.map((_item, index): FidelityResult => {
        const reading = byIndex.get(index);
        if (!reading) return settled();
        return {
          fidelity: TO_FIDELITY[reading.choice],
          reading,
          outcome: reading.outcome,
          decisionId: result.decisionId,
          usage: result.usage,
          recordAction: (action) => recordAction(port, result.decisionId, action),
        };
      });
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const got = await checker.check(port, fixture.claim, fixture.source, fixture.quote, run);
        return fixtureCheck(fixture.name, 'fidelity', fixture.expect, got.fidelity, got.reading?.confidence ?? 1, got.outcome, {
          answers: Object.values(TO_FIDELITY),
        });
      }),
  };
  return checker;
}
