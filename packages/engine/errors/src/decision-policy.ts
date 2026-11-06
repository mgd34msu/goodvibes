/** Runtime-neutral policy facts. The platform owns configuration and operation scopes. */
export type DecisionModelPolicy = 'Default - On' | 'Preferred' | 'Classic - Off';
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

/** Install host policy observation without importing a server runtime into browser consumers. */
export function installDecisionModelPolicyObserver(observer: () => DecisionModelPolicyState): void {
  observe = observer;
}

export function decisionModelPolicyState(): DecisionModelPolicyState { return observe(); }

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
