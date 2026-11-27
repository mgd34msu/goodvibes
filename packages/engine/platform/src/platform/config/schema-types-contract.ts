/**
 * The contract runner's config types: the `contract` category shape, from
 * which the `contract.*` keys and their values are read. Defaults and setting
 * definitions live in schema-domain-contract.ts.
 */
import type { QualityGate } from '../contract/gates.js';

export interface ContractSettings {
  autoCommit: boolean;
  commitScope: 'off' | 'scoped' | 'all';
  gates: QualityGate[];
  acceptanceStakes: 'high' | 'critical';
  midRunChecks: boolean;
  evidenceNudgeLimit: number;
  stallLimit: number;
  maxNudgesPerUnit: number;
  maxFixRounds: number;
  planRepairLimit: number;
  maxUnits: number;
  judgmentCallBudget: number;
  defaultAttempts: number;
  maxActiveContracts: number;
  maxParallelUnits: number;
  isolation: 'auto' | 'worktree' | 'shared';
  transportRetryLimit: number;
  nudgeTtlMs: number;
}
