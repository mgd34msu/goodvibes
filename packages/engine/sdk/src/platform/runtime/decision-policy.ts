import { AsyncLocalStorage } from 'node:async_hooks';
import { JudgmentError } from '@goodvibes-jev/judgment';
import {
  DecisionModelsDisabledError, JudgmentPortMissingError, decisionModelPolicyState,
  installDecisionModelPolicyObserver, type DecisionModelPolicy, type DecisionModelPolicyState,
  parseDecisionModelPolicy, runDecisionOrClassic,
} from '@goodvibes-jev/engine/errors';

export type { DecisionModelPolicy, DecisionModelPolicyState } from '@goodvibes-jev/engine/errors';
export { DECISION_MODEL_POLICIES, parseDecisionModelPolicy } from '@goodvibes-jev/engine/errors';

export class DecisionModelPolicyChangedError extends Error {
  constructor() {
    super('Decision-model policy changed. Start a fresh operation with the current policy.');
    this.name = 'DecisionModelPolicyChangedError';
    hostState.revocations.add(this);
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && hostState.revocations.has(value);
  }
}

interface PolicyScope {
  readonly policy: DecisionModelPolicy;
  readonly current: () => void;
  readonly onChange: ((state: DecisionModelPolicyState) => void) | undefined;
  readonly state: {
    reason: DecisionModelPolicyState['reason'];
    revision: number;
    readonly refusals: Set<string>;
  };
}
interface PolicyHostState {
  readonly schemaVersion: 1;
  readonly scopes: AsyncLocalStorage<PolicyScope>;
  readonly configurations: { readonly read: () => unknown; active: boolean }[];
  readonly revocations: WeakSet<object>;
}
// Source and published entrypoints may coexist in an embedding process. They
// must share operation ownership, configuration lifetime and refusal memory;
// installing a second observer cannot erase the first entrypoint's scope.
const hostStateKey = Symbol.for('goodvibes-jev.engine.decision-policy.host.v1');
function sharedPolicyHostState(): PolicyHostState {
  const existing = Object.getOwnPropertyDescriptor(globalThis, hostStateKey);
  if (existing) {
    if (!('value' in existing) || (existing.value as PolicyHostState | undefined)?.schemaVersion !== 1)
      throw new Error('Decision-model policy host state is unavailable.');
    return existing.value as PolicyHostState;
  }
  const created: PolicyHostState = Object.freeze({ schemaVersion: 1,
    scopes: new AsyncLocalStorage<PolicyScope>(), configurations: [], revocations: new WeakSet<object>() });
  Object.defineProperty(globalThis, hostStateKey, { value: created });
  return created;
}
const hostState = sharedPolicyHostState();
const { scopes, configurations } = hostState;
const configured = (): unknown => configurations.findLast(source => source.active)?.read();

/** A composition owns the default; retiring it cannot replace a newer composition. */
export function configureDecisionModelPolicy(read: () => unknown): () => void {
  const source = { read, active: true };
  configurations.push(source);
  return () => {
    source.active = false;
    while (configurations.at(-1)?.active === false) configurations.pop();
  };
}

function observe(): DecisionModelPolicyState {
  const scope = scopes.getStore();
  scope?.current();
  const policy = scope?.policy ?? parseDecisionModelPolicy(configured());
  const reason = scope?.state.reason ?? (policy === 'Classic - Off' ? 'selected' : null);
  return Object.freeze({ policy, operation: reason === null ? 'decision' : 'classic', reason, revision: scope?.state.revision ?? 0 });
}
installDecisionModelPolicyObserver(observe, activateClassicFallback, withConfiguredDecisionModelPolicy);

export function isClassicOperation(): boolean { return decisionModelPolicyState().operation === 'classic'; }

/** Pin one operation. Changing policy revokes it; fallback changes no host permission or completed action. */
export function withDecisionModelPolicy<T>(read: () => unknown, operation: () => T,
  onChange?: (state: DecisionModelPolicyState) => void): T {
  const parent = scopes.getStore();
  if (parent) {
    if (!onChange) return operation();
    // Nested consumers observe this operation without replacing its pinned
    // policy, refusal memory or fallback state. ALS owns callback lifetime;
    // another operation cannot retain this consumer's notice sink.
    return scopes.run({ ...parent, onChange(state) { parent.onChange?.(state); onChange(state); } }, () => {
      const state = observe();
      if (state.operation === 'classic') onChange(state);
      return operation();
    });
  }
  const readPolicy = () => parseDecisionModelPolicy(read() ?? configured());
  const policy = readPolicy();
  const current = () => { if (readPolicy() !== policy) throw new DecisionModelPolicyChangedError(); };
  return scopes.run({ policy, current, onChange, state: { reason: policy === 'Classic - Off' ? 'selected' : null, revision: 0, refusals: new Set() } }, () => {
    current();
    if (policy === 'Classic - Off') onChange?.(observe());
    return operation();
  });
}

/** Entry point for owned daemon/background operations that use the composition's policy source. */
export function withConfiguredDecisionModelPolicy<T>(operation: () => T, onChange?: (state: DecisionModelPolicyState) => void): T {
  return withDecisionModelPolicy(configured, operation, onChange);
}

/** Re-enter one owned operation across separate events; fallback persists and a setting change revokes it. */
export function captureDecisionModelPolicyOperation(onChange?: (state: DecisionModelPolicyState) => void): <T>(operation: () => T) => T {
  return withConfiguredDecisionModelPolicy(() => {
    const scope = scopes.getStore();
    if (!scope) throw new Error('Decision-model operation has no policy owner');
    return <T>(operation: () => T): T => scopes.run(scope, () => { scope.current(); return operation(); });
  }, onChange);
}

/** Only explicit availability exhaustion may downgrade Preferred; never unwrap unrelated failures. */
export function activateClassicFallback(error: unknown): boolean {
  const scope = scopes.getStore();
  scope?.current();
  if (!scope || scope.policy !== 'Preferred') return false;
  if (!(error instanceof JudgmentPortMissingError) && !(error instanceof JudgmentError && error.kind === 'unavailable')) return false;
  return inheritClassicDecisionFallback();
}

/** Continue an authenticated host admission's fallback after its request scope ends.
 * Callers must validate the retained admission capability first; request fields are not authority.
 */
export function inheritClassicDecisionFallback(): boolean {
  const scope = scopes.getStore();
  scope?.current();
  if (!scope || scope.policy !== 'Preferred') return false;
  if (scope.state.reason === null) {
    scope.state.reason = 'unavailable'; scope.state.revision++;
    scope.onChange?.(observe());
  }
  return true;
}

/** Re-enter only a caller's side-effect-free decision phase, never replay its executed operation. */
export function decisionOrClassic<T>(decision: () => Promise<T>, classic: () => T | Promise<T>, fallbackAllowed: () => boolean = () => true): Promise<T> {
  return runDecisionOrClassic(decision, classic, fallbackAllowed);
}

/** A later outage cannot reopen the same refused action within its owning operation. Keys stay host-private. */
export function rememberDecisionRefusal(action: string): void { scopes.getStore()?.state.refusals.add(action); }
export function wasDecisionRefused(action: string): boolean { return scopes.getStore()?.state.refusals.has(action) ?? false; }

/** Explicit capability report for genuinely decision-only features. */
export function requireDecisionFeature(feature: string): void {
  if (isClassicOperation()) throw new DecisionModelsDisabledError(feature);
}
