/** Runtime-neutral policy facts. The platform owns configuration and operation scopes. */
export type DecisionModelPolicy = 'Default - On' | 'Preferred' | 'Classic - Off';
export const DECISION_MODEL_POLICIES = ['Default - On', 'Preferred', 'Classic - Off'] as const;
export function parseDecisionModelPolicy(value: unknown): DecisionModelPolicy {
  if (value === undefined) return 'Default - On';
  if (value === 'Default - On' || value === 'Preferred' || value === 'Classic - Off') return value;
  throw new Error('Invalid decision-model policy');
}
export interface DecisionModelPolicyState {
  readonly policy: DecisionModelPolicy;
  readonly operation: 'decision' | 'classic';
  readonly reason: 'selected' | 'unavailable' | null;
  readonly revision: number;
}

const defaultState: DecisionModelPolicyState = Object.freeze({
  policy: 'Default - On', operation: 'decision', reason: null, revision: 0,
});
let observe: () => DecisionModelPolicyState = () => defaultState;
let fallback: (error: unknown) => boolean = () => false;

/** Install host policy observation without importing a server runtime into browser consumers. */
export function installDecisionModelPolicyObserver(observer: () => DecisionModelPolicyState, onUnavailable?: (error: unknown) => boolean): void {
  observe = observer;
  fallback = onUnavailable ?? (() => false);
}

export function decisionModelPolicyState(): DecisionModelPolicyState { return observe(); }
/** The platform checks exact availability error types and owns any operation transition. */
export function tryClassicDecisionFallback(error: unknown): boolean { return fallback(error); }

/** A feature limitation, never a semantic refusal, transport failure or execution permission. */
export class DecisionModelsDisabledError extends Error {
  readonly code = 'decision-models-disabled';
  constructor(readonly feature: string) {
    super(`This feature requires a decision model and is unavailable during Classic operation: ${feature}.`);
    this.name = 'DecisionModelsDisabledError';
  }
}

export function assertDecisionModelsEnabled(feature: string): void {
  if (decisionModelPolicyState().operation === 'classic') throw new DecisionModelsDisabledError(feature);
}
