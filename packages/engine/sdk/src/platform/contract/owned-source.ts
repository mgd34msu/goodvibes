/** Live, original-source custody for a seeded compatibility contract. Never recovered from prose. */
import { captureAutonomousSource, retainAutonomousSource } from '../permissions/autonomous.js';
import { bindContractActionSource, bindContractActionSignal, getContractActionSource, getContractActionSignal } from '../tools/agent/contract-binding.js';
import type { Contract } from './types.js';
import type { AutonomousToolSource } from '../permissions/autonomous.js';
import type { ContractPlan, PlanProblem } from './plan-schema.js';
import { checkNativeSourcePlan } from './native-source.js';

/** Empty original criteria do not turn planner checks into user-authored requirements. */
export function hasDerivedAcceptanceChecks(source: AutonomousToolSource | undefined): boolean {
  return source !== undefined && source.criteria.length === 0;
}
export function checkOwnedSourcePlan(plan: ContractPlan, source: AutonomousToolSource): PlanProblem[] {
  if (!hasDerivedAcceptanceChecks(source)) return checkNativeSourcePlan(plan, source);
  return plan.goal === source.goal ? [] : [{ code: 'native-source-changed', message: 'Keep the complete original goal unchanged. Acceptance checks are derived evidence requirements, not replacement source requirements.' }];
}

export function bindOwnedContractSource(contract: Contract, owner: object): void {
  const sourceOf = getContractActionSource(owner);
  if (!sourceOf || !contract.originalSource) return;
  const source = captureAutonomousSource(sourceOf());
  const sourceIsCurrent = retainAutonomousSource(source);
  const signal = getContractActionSignal(owner);
  bindContractActionSignal(contract, signal);
  bindContractActionSource(contract, () => {
    signal?.throwIfAborted();
    if (!sourceIsCurrent(sourceOf()) || !sourceIsCurrent(contract.originalSource)) {
      throw new Error('Original contract source changed');
    }
    return source;
  });
}
export function assertOwnedContractSource(contract: Contract): void {
  if (!contract.originalSource) return;
  const sourceOf = getContractActionSource(contract);
  if (!sourceOf) throw new Error('Original contract source owner is unavailable; saved evidence cannot authorize replay');
  sourceOf();
  if (contract.goal !== contract.originalSource.goal) throw new Error('Original contract goal changed');
}
