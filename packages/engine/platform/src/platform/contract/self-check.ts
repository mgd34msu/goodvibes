/**
 * How a unit's criteria read now, for the worker that is doing the unit.
 *
 * A worker normally learns how its criteria read only by ending its turn and
 * receiving a nudge. This answers the same question from what the host has
 * already recorded, with no new reading: the criteria's latest verdicts and the
 * reasons the last check gave, the problems that check found, and what is still
 * open. It is read-only, grants nothing, and says which check it describes so a
 * worker does not mistake it for a verdict on work done since.
 */
import type { ContractView, CriterionVerdict } from './types.js';

/** The read-only tool a unit's agent calls to read this; the tool answers with {@link describeUnitSelfCheck}. */
export const UNIT_SELF_CHECK_TOOL = 'contract_self_check';

export interface UnitSelfCheckCriterion {
  readonly id: string;
  readonly text: string;
  /** 'unread' until a check has read it. */
  readonly status: string;
  readonly verdict: CriterionVerdict | null;
  /** The last check's one-sentence reason it is not met yet, when it gave one. */
  readonly why?: string | undefined;
  readonly severity?: string | undefined;
}

export interface UnitSelfCheck {
  readonly contractId: string;
  readonly unitId: string;
  readonly unitStatus: string;
  /** The check these readings come from, or null before the unit's first check. */
  readonly asOfCheck: { readonly id: string; readonly trigger: string; readonly result: string; readonly at: number } | null;
  readonly criteria: readonly UnitSelfCheckCriterion[];
  /** Problem kinds the last check found (unmet, unshown, regression, quality, gate, claims). */
  readonly problems: readonly string[];
  readonly note: string;
}

export type UnitSelfCheckResult =
  | { readonly found: true; readonly selfCheck: UnitSelfCheck }
  | { readonly found: false; readonly reason: string };

/**
 * The self-check for the unit an agent works on. `contracts` are the runner's
 * views; the agent is identified by the id the host gave it, never one it names.
 */
export function describeUnitSelfCheck(contracts: readonly ContractView[], agentId: string): UnitSelfCheckResult {
  for (const contract of contracts) {
    const unit = contract.units.find((candidate) => candidate.activeAgentId === agentId || candidate.agentIds.includes(agentId));
    if (unit === undefined) continue;
    const last = unit.checks.at(-1);
    const criteria = unit.criteria.filter((criterion) => criterion.disposition === 'judged').map((criterion): UnitSelfCheckCriterion => {
      const reading = criterion.readings.at(-1);
      const severity = [...criterion.readings].reverse().find((entry) => entry.severity !== undefined)?.severity;
      return {
        id: criterion.id,
        text: criterion.text,
        status: criterion.status,
        verdict: reading?.verdict ?? null,
        ...(reading?.rationale === undefined || criterion.status === 'met' ? {} : { why: reading.rationale }),
        ...(severity === undefined || criterion.status === 'met' ? {} : { severity }),
      };
    });
    return {
      found: true,
      selfCheck: {
        contractId: contract.id,
        unitId: unit.id,
        unitStatus: unit.status,
        asOfCheck: last === undefined ? null : { id: last.id, trigger: last.trigger, result: last.result, at: last.at },
        criteria,
        problems: last?.problems ?? [],
        note: last === undefined
          ? 'No check has read this unit yet. Finishing your turn runs one; criteria stay unread until then.'
          : `These are the readings of check ${last.id}; work you have done since is not reflected until the next check. This is not an approval and passes nothing.`,
      },
    };
  }
  return { found: false, reason: `Agent ${agentId} is not working on a contract unit, so there are no criteria to read.` };
}
