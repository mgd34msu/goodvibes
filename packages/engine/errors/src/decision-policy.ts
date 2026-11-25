/**
 * Runtime-neutral policy facts. The platform owns configuration and operation scopes.
 * The stored values of `judgment.policy` ("If Jev can't answer", only meaningful in
 * Jev decides and Just vibes): `Hybrid` is shown as "Ask me" (the default) and
 * `Decision Model Only` as "Refuse the action".
 */
export type DecisionModelPolicy = 'Decision Model Only' | 'Hybrid';
export const DECISION_MODEL_POLICIES = ['Hybrid', 'Decision Model Only'] as const;
/** The shipped default: use a decision model when one is set and answers, and continue without it otherwise. */
export const DEFAULT_DECISION_MODEL_POLICY: DecisionModelPolicy = 'Hybrid';
/** What a person reads for each stored value. */
export const DECISION_MODEL_POLICY_LABELS: Readonly<Record<DecisionModelPolicy, string>> = Object.freeze({
  Hybrid: 'Ask me',
  'Decision Model Only': 'Refuse the action',
});
/** How a policy value is shown to a person; the default carries "(default)", which is never stored. */
export function decisionModelPolicyLabel(policy: DecisionModelPolicy): string {
  const label = DECISION_MODEL_POLICY_LABELS[policy];
  return policy === DEFAULT_DECISION_MODEL_POLICY ? `${label} (default)` : label;
}
export function parseDecisionModelPolicy(value: unknown): DecisionModelPolicy {
  if (value === undefined) return 'Hybrid';
  if (value === 'Decision Model Only' || value === 'Hybrid') return value;
  throw new Error('Invalid decision-model policy');
}
/**
 * Why an operation runs without a decision model: no decision model is set
 * (nothing to ask, so every decision takes its fallback with no error); or
 * `Hybrid` found the set models unavailable.
 */
export type NoDecisionModelReason = 'not-set' | 'unavailable';
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
    if (reason !== null && reason !== 'not-set' && reason !== 'unavailable') return undefined;
    if (state.operation !== (reason === null ? 'decision' : 'no-decision-model')
      || (policy === 'Decision Model Only' && reason !== null && reason !== 'not-set')) return undefined;
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
let decisionFailed: (error: unknown) => boolean = () => false;
type OperationOwner = <T>(operation: () => T) => T;
let ownOperation: OperationOwner = operation => operation();

/**
 * Install host policy observation without importing a server runtime into browser consumers.
 * `onUnavailable` moves a Hybrid operation to its no-model path; `isDecisionFailure` is the
 * judgment layer's one rule for an error that means the decision model gave no usable answer.
 */
export function installDecisionModelPolicyObserver(observer: () => DecisionModelPolicyState,
  onUnavailable?: (error: unknown) => boolean, operationOwner?: <T>(operation: () => T) => T,
  isDecisionFailure?: (error: unknown) => boolean): void {
  observe = observer;
  fallback = onUnavailable ?? (() => false);
  ownOperation = operationOwner ?? (operation => operation());
  decisionFailed = isDecisionFailure ?? (() => false);
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
 * lifetime and exact failure classification; no host runtime is imported
 * by shared batteries or browser consumers. Neither callback may replay an effect.
 *
 * A decision the decision model did not make, for whatever reason, takes its
 * declared fallback (`classic`) under every policy and the caller carries on;
 * `classic` is handed that failure, so a fallback that acts for the owner can
 * say why (the permission gate refuses the call under Decision Model Only).
 * Under Hybrid the whole operation also moves to its no-model path. Only the
 * caller's cancellation, an error that is not the decision model's, and a
 * fallback that `fallbackAllowed` forbids pass through.
 */
export function runDecisionOrClassic<T>(decision: () => Promise<T>, classic: (failure?: unknown) => T | Promise<T>,
  fallbackAllowed: () => boolean = () => true): Promise<T> {
  return ownOperation(async () => {
    if (decisionModelPolicyState().operation === 'no-decision-model') {
      if (!fallbackAllowed()) throw new DecisionModelsDisabledError('fresh resolution of an existing semantic refusal');
      return classic();
    }
    try { return await decision(); }
    catch (error) {
      const switchedBySibling = error instanceof DecisionModelsDisabledError && decisionModelPolicyState().operation === 'no-decision-model';
      if (!fallbackAllowed()) throw error;
      if (!switchedBySibling && !tryClassicDecisionFallback(error) && !decisionFailed(error)) throw error;
      return classic(error);
    }
  });
}

/**
 * The one sentence a failing set model is reported with: the model, what
 * failed, what the work does until it answers again, and the next step.
 */
export function decisionModelFailingLine(failure: Pick<DecisionModelFailureState, 'model' | 'what' | 'nextStep'>, policy: DecisionModelPolicy): string {
  const then = policy === 'Decision Model Only'
    ? 'so a tool call it cannot decide is refused and every other decision takes its fallback until it answers again (you chose Refuse the action for "If Jev can\'t answer"; Ask me would bring such calls to you)'
    : 'so work continues without it until it answers again';
  const step = failure.nextStep.trim().replace(/\.$/, '');
  return `The decision model ${failure.model} is not answering (${failure.what}), ${then}; to fix it, ${step.charAt(0).toLowerCase()}${step.slice(1)}.`;
}

/** Whether a decision model is in use and, if not, why: the standing indication status, doctor and headless output carry. */
export interface DecisionModelUse {
  readonly inUse: boolean;
  /** The stored policy; shown with {@link decisionModelPolicyLabel}. */
  readonly policy: DecisionModelPolicy;
  /** Why none is in use: none is set, or the set model is unavailable. */
  readonly reason: 'not-set' | 'unavailable' | null;
  readonly failure?: DecisionModelFailureState;
  /** One line for a person. */
  readonly line: string;
}

/** The standing indication, read from the current policy state; costs a few settings reads. */
export function decisionModelUse(state: DecisionModelPolicyState = decisionModelPolicyState()): DecisionModelUse {
  const failure = state.failure;
  if (state.reason === 'not-set') return { inUse: false, policy: state.policy, reason: 'not-set',
    line: 'No decision model is in use: none is set, so decisions take their fallbacks. To use one, choose a Decision model in /settings open.' };
  if (failure !== undefined) return { inUse: false, policy: state.policy, reason: 'unavailable', failure, line: decisionModelFailingLine(failure, state.policy) };
  if (state.reason === 'unavailable') return { inUse: false, policy: state.policy, reason: 'unavailable',
    line: 'The decision model is unavailable; continuing without it.' };
  return { inUse: true, policy: state.policy, reason: null, line: 'A decision model is in use.' };
}
