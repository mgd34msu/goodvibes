/** Runtime-neutral policy facts. The platform owns configuration and operation scopes. */
export type DecisionModelPolicy = 'Decision Model Only' | 'Hybrid' | 'No Decision Model';
export const DECISION_MODEL_POLICIES = ['Decision Model Only', 'Hybrid', 'No Decision Model'] as const;
/** The shipped default: use a decision model when one is set and answers, and continue without it otherwise. */
export const DEFAULT_DECISION_MODEL_POLICY: DecisionModelPolicy = 'Hybrid';
/** How a policy value is shown to a person; the default carries "(default)", which is never stored. */
export function decisionModelPolicyLabel(policy: DecisionModelPolicy): string {
  return policy === DEFAULT_DECISION_MODEL_POLICY ? `${policy} (default)` : policy;
}
export function parseDecisionModelPolicy(value: unknown): DecisionModelPolicy {
  if (value === undefined) return 'Hybrid';
  if (value === 'Decision Model Only' || value === 'Hybrid' || value === 'No Decision Model') return value;
  throw new Error('Invalid decision-model policy');
}
/**
 * Why an operation runs without a decision model: the owner selected `No Decision Model`; no
 * decision model is set (nothing to ask, so every decision takes its fallback
 * with no error); or `Hybrid` found the set models unavailable.
 */
export type NoDecisionModelReason = 'selected' | 'not-set' | 'unavailable';
/** A set decision model that is failing, as the user is told: its name, what failed and the next step. */
export interface DecisionModelFailureState {
  readonly model: string;
  readonly what: string;
  readonly nextStep: string;
  /** When this failure episode began (milliseconds since the epoch). */
  readonly since: number;
}
export interface DecisionModelPolicyState {
  readonly policy: DecisionModelPolicy;
  readonly operation: 'decision' | 'no-decision-model';
  readonly reason: NoDecisionModelReason | null;
  readonly revision: number;
  /** Present while the set decision model is failing; cleared when it answers again. */
  readonly failure?: DecisionModelFailureState;
}
/** Authenticated host observation; never accepts a client's policy as execution authority. */
export const DECISION_MODEL_POLICY_HEADER = 'x-goodvibes-decision-policy';
export function readDecisionModelPolicyHeader(headers: Pick<Headers, 'get'>): DecisionModelPolicyState | undefined {
  const raw = headers.get(DECISION_MODEL_POLICY_HEADER);
  if (!raw || raw.length > 2048) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const state = value as Record<string, unknown>;
    const policy = parseDecisionModelPolicy(state.policy);
    if (state.policy === undefined || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) return undefined;
    const reason = state.reason;
    if (reason !== null && reason !== 'selected' && reason !== 'not-set' && reason !== 'unavailable') return undefined;
    if (state.operation !== (reason === null ? 'decision' : 'no-decision-model')
      || (policy === 'Decision Model Only' && reason !== null && reason !== 'not-set') || (policy === 'No Decision Model' && reason !== 'selected')
      || (policy === 'Hybrid' && reason === 'selected')) return undefined;
    const failure = readFailure(state.failure);
    return Object.freeze({ policy, operation: reason === null ? 'decision' : 'no-decision-model', reason, revision: state.revision as number,
      ...(failure === undefined ? {} : { failure }) });
  } catch { return undefined; }
}

function readFailure(value: unknown): DecisionModelFailureState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { model, what, nextStep, since } = value as Record<string, unknown>;
  if (typeof model !== 'string' || typeof what !== 'string' || typeof nextStep !== 'string' || typeof since !== 'number') return undefined;
  return Object.freeze({ model, what, nextStep, since });
}

const defaultState: DecisionModelPolicyState = Object.freeze({
  policy: 'Hybrid', operation: 'decision', reason: null, revision: 0,
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
    super(`No decision model is in use, so this part is not available: ${feature}.`);
    this.name = 'DecisionModelsDisabledError';
  }
}

export function assertDecisionModelsEnabled(feature: string): void {
  if (decisionModelPolicyState().operation === 'no-decision-model') throw new DecisionModelsDisabledError(feature);
}

/** Runtime-neutral pure-phase dispatch. The installed host owns operation
 * lifetime and exact availability classification; no host runtime is imported
 * by shared batteries or browser consumers. Neither callback may replay an effect.
 */
export function runDecisionOrClassic<T>(decision: () => Promise<T>, classic: () => T | Promise<T>,
  fallbackAllowed: () => boolean = () => true): Promise<T> {
  return ownOperation(async () => {
    if (decisionModelPolicyState().operation === 'no-decision-model') {
      if (!fallbackAllowed()) throw new DecisionModelsDisabledError('fresh resolution of an existing semantic refusal');
      return classic();
    }
    try { return await decision(); }
    catch (error) {
      const switchedBySibling = error instanceof DecisionModelsDisabledError && decisionModelPolicyState().operation === 'no-decision-model';
      if (!fallbackAllowed() || !switchedBySibling && !tryClassicDecisionFallback(error)) throw error;
      return classic();
    }
  });
}

/** The one line a failing set model is reported with: the model, what failed, what the work does, and the next step. */
export function decisionModelFailingLine(failure: Pick<DecisionModelFailureState, 'model' | 'what' | 'nextStep'>, policy: DecisionModelPolicy): string {
  const then = policy === 'Decision Model Only'
    ? 'work that needs it stops (judgment.policy is Decision Model Only; Hybrid would continue without it)'
    : 'continuing without it';
  return `The decision model ${failure.model} is unavailable (${failure.what}); ${then}. Next: ${failure.nextStep}`;
}

/** Whether a decision model is in use and, if not, why: the standing indication status, doctor and headless output carry. */
export interface DecisionModelUse {
  readonly inUse: boolean;
  /** The stored policy; shown with {@link decisionModelPolicyLabel}. */
  readonly policy: DecisionModelPolicy;
  /** Why none is in use: none is set, the owner chose No Decision Model, or the set model is unavailable. */
  readonly reason: 'not-set' | 'selected' | 'unavailable' | null;
  readonly failure?: DecisionModelFailureState;
  /** One line for a person. */
  readonly line: string;
}

/** The standing indication, read from the current policy state; costs a few settings reads. */
export function decisionModelUse(state: DecisionModelPolicyState = decisionModelPolicyState()): DecisionModelUse {
  const label = decisionModelPolicyLabel(state.policy);
  const failure = state.failure;
  if (state.reason === 'selected') return { inUse: false, policy: state.policy, reason: 'selected',
    line: 'No decision model is in use: judgment.policy is No Decision Model, so decisions take their fallbacks.' };
  if (state.reason === 'not-set') return { inUse: false, policy: state.policy, reason: 'not-set',
    line: 'No decision model is in use: none is set, so decisions take their fallbacks. Next: to use one, set judgment.model, judgment.endpoint or TYPESAFE_API_KEY.' };
  if (failure !== undefined) return { inUse: false, policy: state.policy, reason: 'unavailable', failure, line: decisionModelFailingLine(failure, state.policy) };
  if (state.reason === 'unavailable') return { inUse: false, policy: state.policy, reason: 'unavailable',
    line: 'The decision model is unavailable; continuing without it.' };
  return { inUse: true, policy: state.policy, reason: null, line: `A decision model is in use (judgment.policy ${label}).` };
}
