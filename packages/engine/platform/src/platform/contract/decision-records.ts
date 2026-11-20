/**
 * What the runner reads back from its decisions after a restart lives in the
 * decision's typed `record`, beside the one short sentence people read. A
 * receipt (an acceptance, a final-answer review, obligation proofs,
 * publication readings, a saved planner candidate) is stored as JSON in the
 * record; a scheduled repair round names its group there.
 *
 * Checkpoints written before decisions carried records kept the receipt as the
 * decision's whole sentence; `decisionReceipt` still reads those, and only
 * those, so a contract saved then resumes without being re-judged.
 */
import type { JsonValue } from '@goodvibes/judgment';
import type { ContractRun } from './run-context.js';
import type { ContractDecision, ContractDecisionRecord, DeepReadonly } from './types.js';

/** A decision as stored or as a read-only contract view hands it out. */
type DecisionView = DeepReadonly<ContractDecision>;

type DecideArgs = Parameters<ContractRun['decide']>;

/** Records one decision with the typed record the runner reads back. */
export function decideRecorded(
  run: Pick<ContractRun, 'contract' | 'decide'>,
  action: DecideArgs[0],
  targetId: string,
  reason: string,
  record: ContractDecisionRecord,
  decisionIds: readonly string[] = [],
  route?: DecideArgs[4],
): void {
  run.decide(action, targetId, reason, decisionIds, route);
  const decisions = run.contract.decisions;
  const last = decisions[decisions.length - 1];
  if (last !== undefined) decisions[decisions.length - 1] = { ...last, record };
}

/** A receipt record from a JSON-shaped value (a plain object built for this decision). */
export function receiptRecord(value: object): ContractDecisionRecord {
  return { kind: 'receipt', value: value as JsonValue };
}

/** The receipt a decision carries, or undefined when it carries none. */
export function decisionReceipt(decision: DecisionView): unknown {
  if (decision.record !== undefined) return decision.record.kind === 'receipt' ? decision.record.value : undefined;
  try { return JSON.parse(decision.reason) as unknown; } catch { return undefined; }
}

/** The receipt as text for a model or a person; the sentence when there is no receipt. */
export function decisionReceiptText(decision: DecisionView): string {
  const receipt = decisionReceipt(decision);
  return receipt === undefined ? decision.reason : JSON.stringify(receipt);
}

/** The repair round a `fix-planned` decision scheduled; undefined for any other decision. */
export function scheduledFix(decision: DecisionView): { readonly round: number; readonly groupId: string } | undefined {
  if (decision.action !== 'fix-planned') return undefined;
  if (decision.record !== undefined) return decision.record.kind === 'fix-scheduled' ? { round: decision.record.round, groupId: decision.record.groupId } : undefined;
  const legacy = /^round (\d+): group (\S+) with /.exec(decision.reason);
  return legacy === null ? undefined : { round: Number(legacy[1]), groupId: legacy[2]! };
}

/** Whether an `owner-replied` decision amended its target. */
export function isAmendment(decision: DecisionView): boolean {
  if (decision.action !== 'owner-replied') return false;
  if (decision.record !== undefined) return decision.record.kind === 'amended';
  return decision.reason.startsWith('amended as the owner instructed:');
}
