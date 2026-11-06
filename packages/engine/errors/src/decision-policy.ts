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
/** Authenticated host observation; never accepts a client's policy as execution authority. */
export const DECISION_MODEL_POLICY_HEADER = 'x-goodvibes-decision-policy';
export function readDecisionModelPolicyHeader(headers: Pick<Headers, 'get'>): DecisionModelPolicyState | undefined {
  const raw = headers.get(DECISION_MODEL_POLICY_HEADER);
  if (!raw || raw.length > 512) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const state = value as Record<string, unknown>;
    const policy = parseDecisionModelPolicy(state.policy);
    if (state.policy === undefined || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) return undefined;
    const reason = state.reason;
    if (reason !== null && reason !== 'selected' && reason !== 'unavailable') return undefined;
    if (state.operation !== (reason === null ? 'decision' : 'classic')
      || (policy === 'Default - On' && reason !== null) || (policy === 'Classic - Off' && reason !== 'selected')
      || (policy === 'Preferred' && reason === 'selected')) return undefined;
    return Object.freeze({ policy, operation: reason === null ? 'decision' : 'classic', reason, revision: state.revision as number });
  } catch { return undefined; }
}

const defaultState: DecisionModelPolicyState = Object.freeze({
  policy: 'Default - On', operation: 'decision', reason: null, revision: 0,
});
let observe: () => DecisionModelPolicyState = () => defaultState;
let fallback: (error: unknown) => boolean = () => false;
type OperationOwner = <T>(operation: () => T) => T;
let ownOperation: OperationOwner = operation => operation();

/** Install host policy observation without importing a server runtime into browser consumers. */
export function installDecisionModelPolicyObserver(observer: () => DecisionModelPolicyState,
  onUnavailable?: (error: unknown) => boolean, operationOwner?: <T>(operation: () => T) => T): void {
  observe = observer;
  fallback = onUnavailable ?? (() => false);
  ownOperation = operationOwner ?? (operation => operation());
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

/** Runtime-neutral pure-phase dispatch. The installed host owns operation
 * lifetime and exact availability classification; no host runtime is imported
 * by shared batteries or browser consumers. Neither callback may replay an effect.
 */
export function runDecisionOrClassic<T>(decision: () => Promise<T>, classic: () => T | Promise<T>,
  fallbackAllowed: () => boolean = () => true): Promise<T> {
  return ownOperation(async () => {
    if (decisionModelPolicyState().operation === 'classic') {
      if (!fallbackAllowed()) throw new DecisionModelsDisabledError('fresh resolution of an existing semantic refusal');
      return classic();
    }
    try { return await decision(); }
    catch (error) {
      const switchedBySibling = error instanceof DecisionModelsDisabledError && decisionModelPolicyState().operation === 'classic';
      if (!fallbackAllowed() || !switchedBySibling && !tryClassicDecisionFallback(error)) throw error;
      return classic();
    }
  });
}
