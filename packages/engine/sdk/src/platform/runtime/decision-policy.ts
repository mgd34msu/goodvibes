import { AsyncLocalStorage } from 'node:async_hooks';
import { JudgmentError } from '@goodvibes-jev/judgment';
import {
  DecisionModelsDisabledError, JudgmentPortMissingError, decisionModelPolicyState,
  installDecisionModelPolicyObserver, type DecisionModelPolicy, type DecisionModelPolicyState,
} from '@goodvibes-jev/engine/errors';

export type { DecisionModelPolicy, DecisionModelPolicyState } from '@goodvibes-jev/engine/errors';
export const DECISION_MODEL_POLICIES = ['Default - On', 'Preferred', 'Classic - Off'] as const;

export function parseDecisionModelPolicy(value: unknown): DecisionModelPolicy {
  if (value === undefined) return 'Default - On';
  if (value === 'Default - On' || value === 'Preferred' || value === 'Classic - Off') return value;
  throw new Error('Invalid decision-model policy');
}

export class DecisionModelPolicyChangedError extends Error {
  constructor() { super('Decision-model policy changed. Start a fresh operation with the current policy.'); this.name = 'DecisionModelPolicyChangedError'; }
}

interface PolicyScope {
  readonly policy: DecisionModelPolicy;
  readonly current: () => void;
  readonly onChange: ((state: DecisionModelPolicyState) => void) | undefined;
  reason: DecisionModelPolicyState['reason'];
  revision: number;
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
installDecisionModelPolicyObserver(observe);

export function isClassicOperation(): boolean { return decisionModelPolicyState().operation === 'classic'; }

/** Pin one operation. Changing policy revokes it; fallback changes no host permission or completed action. */
export function withDecisionModelPolicy<T>(read: () => unknown, operation: () => T,
  onChange?: (state: DecisionModelPolicyState) => void): T {
  if (scopes.getStore()) return operation();
  const policy = parseDecisionModelPolicy(read());
  const current = () => { if (parseDecisionModelPolicy(read()) !== policy) throw new DecisionModelPolicyChangedError(); };
  return scopes.run({ policy, current, onChange, reason: policy === 'Classic - Off' ? 'selected' : null, revision: 0 }, () => {
    current();
    if (policy === 'Classic - Off') onChange?.(observe());
    return operation();
  });
}

/** Only explicit availability exhaustion may downgrade Preferred; never unwrap unrelated failures. */
export function activateClassicFallback(error: unknown): boolean {
  const scope = scopes.getStore();
  scope?.current();
  if (!scope || scope.policy !== 'Preferred') return false;
  if (!(error instanceof JudgmentPortMissingError) && !(error instanceof JudgmentError && error.kind === 'unavailable')) return false;
  if (scope.reason === null) {
    scope.reason = 'unavailable'; scope.revision++;
    scope.onChange?.(observe());
  }
  return true;
}

/** Re-enter only a caller's side-effect-free decision phase, never replay its executed operation. */
export function decisionOrClassic<T>(decision: () => Promise<T>, classic: () => T | Promise<T>): Promise<T> {
  return withDecisionModelPolicy(configured, async () => {
    if (isClassicOperation()) return classic();
    try { return await decision(); }
    catch (error) {
      if (!activateClassicFallback(error)) throw error;
      return classic();
    }
  });
}

/** Explicit capability report for genuinely decision-only features. */
export function requireDecisionFeature(feature: string): void {
  if (isClassicOperation()) throw new DecisionModelsDisabledError(feature);
}
