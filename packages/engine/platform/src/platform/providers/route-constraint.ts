/**
 * route-constraint.ts, a label as a selection rule.
 *
 * A model or a run that carries a label ("free", "local") is a promise about
 * every route it may take: a free model never bills, a local benchmark never
 * leaves the machine. The promise holds only when the code that builds a list
 * of candidates admits each one through the same rule, so the rule lives here
 * once and every list builder calls it: the synthetic catalog's backend pool
 * (failover stays inside the tier) and a benchmark's candidate list (a local
 * run fills from local routes only).
 *
 * Cost: one predicate per candidate when a list is built; nothing per request.
 */
import type { SyntheticTier } from './synthetic.js';

/** What a label promises about every route taken under it. Absent fields constrain nothing. */
export interface RouteConstraint {
  /** Only routes billed this way. */
  readonly tier?: SyntheticTier | undefined;
  /** `local`: only routes served on this machine or its local network. */
  readonly locality?: 'local' | 'any' | undefined;
}

/** One route a list may hold: its registry key, how it bills, and whether it is served locally. */
export interface RouteCandidate {
  readonly registryKey: string;
  readonly tier: SyntheticTier;
  readonly local: boolean;
}

/** Whether `candidate` keeps the promise `constraint` makes. */
export function admitsCandidate(constraint: RouteConstraint, candidate: RouteCandidate): boolean {
  if (constraint.tier !== undefined && candidate.tier !== constraint.tier) return false;
  if (constraint.locality === 'local' && !candidate.local) return false;
  return true;
}

/** The candidates that keep the promise, in the order given. */
export function admittedCandidates<C extends RouteCandidate>(constraint: RouteConstraint, candidates: readonly C[]): C[] {
  return candidates.filter((candidate) => admitsCandidate(constraint, candidate));
}
