/**
 * The shapes the planner events and a plan proposal still carry. The adaptive
 * planner that chose a strategy per turn is gone: a piece of work has its plan,
 * written by its planning agent (plan-decomposition.ts), and nothing chooses a
 * strategy any more. These types stay readable for older event and history
 * consumers.
 */

/** The strategy names older events and plan proposals carry. */
export type ExecutionStrategy = 'auto' | 'single' | 'cohort' | 'background' | 'remote';

/** The reason codes older strategy events carry. */
export type StrategyReasonCode =
  | 'NO_DECISION_MODEL_SINGLE'
  | 'JUDGMENT_SELECTED'
  | 'JUDGMENT_UNSETTLED'
  | 'PINNED_MODE'
  | 'OVERRIDE_IN_EFFECT'
  | 'HIGH_RISK_SINGLE_PREFERRED'
  | 'LOW_LATENCY_SINGLE'
  | 'COHORT_CAPABLE'
  | 'BACKGROUND_DEFERRED'
  | 'REMOTE_CAPABLE'
  | 'AUTO_FALLBACK_SINGLE'
  | 'USER_OVERRIDE'
  | 'INVALID_STRATEGY';

/** Inputs an older strategy event recorded. */
export interface PlannerInputs {
  riskScore: number | null;
  latencyBudgetMs: number;
  isMultiStep: boolean;
  remoteAvailable: boolean;
  backgroundEligible: boolean;
  taskDescription?: string | undefined;
}

export interface StrategyCandidate {
  strategy: ExecutionStrategy;
  score: number;
  reasonCode: StrategyReasonCode;
}

/** How a goal was taken for decomposition: today always split by the planning agent. */
export interface DecompositionGate {
  readonly provenance?: 'classic';
  decompose: boolean;
  strategy: ExecutionStrategy;
  reasonCode: StrategyReasonCode;
}

/** An older strategy decision, as its event carries it. */
export interface PlannerDecision {
  readonly provenance?: 'classic';
  selected: ExecutionStrategy;
  reasonCode: StrategyReasonCode;
  candidates: StrategyCandidate[];
  overrideActive: boolean;
  timestamp: number;
  inputs: PlannerInputs;
  decisionId?: string | undefined;
}
