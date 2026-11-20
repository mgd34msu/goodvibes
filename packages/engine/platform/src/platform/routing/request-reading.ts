import { isClassicOperation } from '../runtime/decision-policy.js';
/**
 * Reads a piece of work before any model token is spent on it: the six
 * request batteries asked in one request (speculative fan-out), then the tier
 * composed in code from the readings and the policy floors. With no decision
 * model in use the work is not read: the tier is the purpose's floor (standard
 * when the purpose has none) and the reading says it is unassessed.
 */
import { fanOut, type ChoiceReading, type ScoreReading } from '@goodvibes/judgment';
import { judgmentPort } from '@goodvibes/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { REQUEST_BATTERIES, type RequestDomain, type RequestIntent, type RequestLanguage } from './batteries/request.js';
import {
  TIER_FLOOR_FOR_PURPOSE,
  TIER_FLOOR_FOR_RISK,
} from './policy.js';
import { higherTier, type RouteTier } from './tiers.js';

/** A piece of work to route: who does it and the brief as written. */
export interface RoutingRequest {
  /** Who does the work: 'planner', 'unit', 'fresh-unit', 'integration', 'conversation', or another short label. */
  readonly purpose: string;
  readonly brief: string;
  /** Complete immutable requirements for native work, separate from the bounded display/derived brief. */
  readonly originalSource?: { readonly goal: string; readonly criteria: readonly string[] } | undefined;
}

export interface RequestReading {
  /** The tier the work needs, composed from the readings and the policy floors. */
  readonly tier: RouteTier;
  /** How the tier was composed, one clause per step, for the route's reason string. */
  readonly tierBecause: string;
  /** The battery readings; absent when no decision model read the work (`unassessed`). */
  readonly readings?: {
    readonly tier: ChoiceReading<RouteTier>;
    readonly intent: ChoiceReading<RequestIntent>;
    readonly difficulty: ScoreReading;
    readonly risk: ScoreReading;
    readonly domain: ChoiceReading<RequestDomain>;
    readonly language: ChoiceReading<RequestLanguage>;
  } | undefined;
  readonly decisionId: string | undefined;
  /** No decision model read the work; the tier comes from the purpose alone. */
  readonly unassessed?: true | undefined;
  recordAction(action: string): void;
}

/** Every battery reads the complete brief; the shared port enforces context limits. */
export function requestState(request: RoutingRequest): { purpose: string; work: string; originalSource?: { goal: string; criteria: string[] } } {
  const state = { purpose: request.purpose, work: request.brief,
    ...(request.originalSource === undefined ? {} : { originalSource: { goal: request.originalSource.goal, criteria: [...request.originalSource.criteria] } }),
  };
  assertJudgmentInput(state);
  return state;
}

const pct = (value: number): string => value.toFixed(2);

/**
 * Jev's most probable tier determines the assignment. Confidence describes
 * the reading; it is not permission to execute the user's request.
 */
export function composeTier(
  readings: NonNullable<RequestReading['readings']>,
  purpose: string,
): { readonly tier: RouteTier; readonly because: string } {
  const clauses: string[] = [];
  let tier = readings.tier.choice;
  clauses.push(`tier read ${tier} (${pct(readings.tier.confidence)})`);
  const raise = (floor: RouteTier | undefined, why: string): void => {
    if (floor === undefined) return;
    const next = higherTier(tier, floor);
    if (next !== tier) clauses.push(`${why} raises it to ${next}`);
    tier = next;
  };
  raise(TIER_FLOOR_FOR_RISK[readings.risk.level], `risk ${readings.risk.score.toFixed(1)}/3`);
  raise(TIER_FLOOR_FOR_PURPOSE[purpose], `purpose ${purpose}`);
  return { tier, because: clauses.join('; ') };
}

/** The tier code gives work no decision model read: the purpose's floor, else standard. */
export function unassessedRequestReading(request: Pick<RoutingRequest, 'purpose'>): RequestReading {
  const floor = TIER_FLOOR_FOR_PURPOSE[request.purpose];
  return {
    tier: floor ?? 'standard',
    tierBecause: floor === undefined
      ? 'not read (no decision model is in use): standard by default'
      : `not read (no decision model is in use): the floor for purpose ${request.purpose}`,
    decisionId: undefined,
    unassessed: true,
    recordAction() { /* nothing was read */ },
  };
}

/**
 * Reads the work with every request battery in one request and composes its
 * tier; with no decision model in use, returns the unassessed reading without a request.
 */
export async function readRequest(
  request: RoutingRequest,
  options: import('@goodvibes/judgment').CallOptions = {},
): Promise<RequestReading> {
  if (isClassicOperation()) { options.signal?.throwIfAborted(); return unassessedRequestReading(request); }
  const site = options.site ?? 'routing.request';
  const state = requestState(request);
  const run = await fanOut(judgmentPort(site), state, REQUEST_BATTERIES, {
    site,
    label: 'routing.request',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.beforeAttempt === undefined ? {} : { beforeAttempt: options.beforeAttempt }),
    ...(options.beforeAsyncAttempt === undefined ? {} : { beforeAsyncAttempt: options.beforeAsyncAttempt }),
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
  });
  const readings = {
    tier: run.readings.tier.tier,
    intent: run.readings.intent.intent,
    difficulty: run.readings.difficulty.difficulty,
    risk: run.readings.risk.risk,
    domain: run.readings.domain.domain,
    language: run.readings.language.language,
  };
  const { tier, because } = composeTier(readings, request.purpose);
  return { tier, tierBecause: because, readings, decisionId: run.decisionId, recordAction: run.recordAction };
}
