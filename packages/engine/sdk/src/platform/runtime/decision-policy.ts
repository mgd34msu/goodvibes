import { AsyncLocalStorage } from 'node:async_hooks';
import { JudgmentError } from '@goodvibes-jev/judgment';
import {
  DecisionModelsDisabledError, JudgmentPortMissingError, decisionModelPolicyState,
  installDecisionModelPolicyObserver, type DecisionModelPolicy, type DecisionModelPolicyState,
  parseDecisionModelPolicy,
} from '@goodvibes-jev/engine/errors';

export type { DecisionModelPolicy, DecisionModelPolicyState } from '@goodvibes-jev/engine/errors';
export { DECISION_MODEL_POLICIES, parseDecisionModelPolicy } from '@goodvibes-jev/engine/errors';

export class DecisionModelPolicyChangedError extends Error {
  constructor() { super('Decision-model policy changed. Start a fresh operation with the current policy.'); this.name = 'DecisionModelPolicyChangedError'; }
}

interface PolicyScope {
  readonly policy: DecisionModelPolicy;
  readonly current: () => void;
  readonly onChange: ((state: DecisionModelPolicyState) => void) | undefined;
  reason: DecisionModelPolicyState['reason'];
  revision: number;
  readonly refusals: Set<string>;
}
const scopes = new AsyncLocalStorage<PolicyScope>();
const configurations: { readonly read: () => unknown; active: boolean }[] = [];
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
  const reason = scope?.reason ?? (policy === 'Classic - Off' ? 'selected' : null);
  return Object.freeze({ policy, operation: reason === null ? 'decision' : 'classic', reason, revision: scope?.revision ?? 0 });
}
installDecisionModelPolicyObserver(observe, activateClassicFallback);

export function isClassicOperation(): boolean { return decisionModelPolicyState().operation === 'classic'; }

/** Pin one operation. Changing policy revokes it; fallback changes no host permission or completed action. */
export function withDecisionModelPolicy<T>(read: () => unknown, operation: () => T,
  onChange?: (state: DecisionModelPolicyState) => void): T {
  if (scopes.getStore()) return operation();
  const readPolicy = () => parseDecisionModelPolicy(read() ?? configured());
  const policy = readPolicy();
  const current = () => { if (readPolicy() !== policy) throw new DecisionModelPolicyChangedError(); };
  return scopes.run({ policy, current, onChange, reason: policy === 'Classic - Off' ? 'selected' : null, revision: 0, refusals: new Set() }, () => {
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
  if (scope.reason === null) {
    scope.reason = 'unavailable'; scope.revision++;
    scope.onChange?.(observe());
  }
  return true;
}

/** Re-enter only a caller's side-effect-free decision phase, never replay its executed operation. */
export function decisionOrClassic<T>(decision: () => Promise<T>, classic: () => T | Promise<T>, fallbackAllowed: () => boolean = () => true): Promise<T> {
  return withDecisionModelPolicy(configured, async () => {
    if (isClassicOperation()) {
      if (!fallbackAllowed()) throw new DecisionModelsDisabledError('fresh resolution of an existing semantic refusal');
      return classic();
    }
    try { return await decision(); }
    catch (error) {
      const switchedBySibling = error instanceof DecisionModelsDisabledError && isClassicOperation();
      if (!fallbackAllowed() || !switchedBySibling && !activateClassicFallback(error)) throw error;
      return classic();
    }
  });
}

/** A later outage cannot reopen the same refused action within its owning operation. Keys stay host-private. */
export function rememberDecisionRefusal(action: string): void { scopes.getStore()?.refusals.add(action); }
export function wasDecisionRefused(action: string): boolean { return scopes.getStore()?.refusals.has(action) ?? false; }

/** Explicit capability report for genuinely decision-only features. */
export function requireDecisionFeature(feature: string): void {
  if (isClassicOperation()) throw new DecisionModelsDisabledError(feature);
}
