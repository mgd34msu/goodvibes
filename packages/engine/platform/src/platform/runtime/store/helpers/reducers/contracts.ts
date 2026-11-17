/**
 * The contracts domain reducer: folds `contracts` events into contract records
 * (docs/design/contract-runner.md section 8.2). Events may arrive for a
 * group or unit the domain has not seen yet (a fix unit added after planning),
 * so those handlers create what they need. A contract itself is created only by
 * an event that describes one (creation, a status change or a plan, which is
 * how a surface that attached mid-run learns of it); any other event for an
 * unknown contract is dropped rather than inventing a queued contract that
 * never ends.
 */
import type { ContractEvent, ContractStatus, CriterionVerdict } from '../../../../../events/contract.js';
import type {
  ContractDomainState,
  ContractGroupRecord,
  ContractRecord,
  ContractUnitRecord,
} from '../../domains/contracts.js';
import { now, updateDomainMetadata } from './shared.js';

const TERMINAL_STATUSES: ReadonlySet<ContractStatus> = new Set(['passed', 'failed', 'cancelled']);

/** Ended contracts kept for surfaces; the oldest ended ones go first past this. Live contracts are never dropped. */
export const MAX_RETAINED_CONTRACTS = 200;

/** Evicted ids remembered so late events for them are dropped. */
const MAX_REMEMBERED_EVICTIONS = 1000;

/** Drops the oldest ended contracts past the cap and returns their ids. */
function evictEnded(contracts: Map<string, ContractRecord>): string[] {
  const evicted: string[] = [];
  if (contracts.size <= MAX_RETAINED_CONTRACTS) return evicted;
  const ended = [...contracts.values()]
    .filter((contract) => TERMINAL_STATUSES.has(contract.status))
    .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
  for (const contract of ended) {
    if (contracts.size <= MAX_RETAINED_CONTRACTS) break;
    contracts.delete(contract.id);
    evicted.push(contract.id);
  }
  return evicted;
}

/** Events that move a contract's status; none of them may move an ended contract. */
function movesStatus(event: ContractEvent): boolean {
  return event.type === 'CONTRACT_STATUS_CHANGED' || event.type === 'CONTRACT_PASSED'
    || event.type === 'CONTRACT_FAILED' || event.type === 'CONTRACT_CANCELLED';
}

/** The terminal status a terminal event records, or undefined for any other event. */
function terminalStatusOf(event: ContractEvent): ContractStatus | undefined {
  if (event.type === 'CONTRACT_PASSED') return 'passed';
  if (event.type === 'CONTRACT_FAILED') return 'failed';
  if (event.type === 'CONTRACT_CANCELLED') return 'cancelled';
  return undefined;
}

/** Events that describe a contract well enough to start a record for one the domain has not seen. */
function describesContract(event: ContractEvent): boolean {
  return event.type === 'CONTRACT_CREATED' || event.type === 'CONTRACT_STATUS_CHANGED' || event.type === 'CONTRACT_PLANNED';
}

function emptyContract(contractId: string, timestamp: number): ContractRecord {
  return {
    id: contractId,
    ask: '',
    status: 'queued',
    criteria: [],
    groups: new Map(),
    units: new Map(),
    nudges: 0,
    openEscalations: [],
    createdAt: timestamp,
  };
}

function emptyGroup(groupId: string): ContractGroupRecord {
  return { id: groupId, title: groupId, kind: 'work', status: 'pending', unitIds: [], verdicts: {} };
}

function emptyUnit(unitId: string, groupId: string): ContractUnitRecord {
  return { id: unitId, groupId, status: 'pending', verdicts: {}, nudges: 0 };
}

function withStatus(contract: ContractRecord, status: ContractStatus, timestamp: number): ContractRecord {
  return {
    ...contract,
    status,
    ...(TERMINAL_STATUSES.has(status) ? { endedAt: contract.endedAt ?? timestamp } : {}),
  };
}

function withGroup(contract: ContractRecord, groupId: string, patch: (group: ContractGroupRecord) => ContractGroupRecord): ContractRecord {
  const groups = new Map(contract.groups);
  groups.set(groupId, patch(groups.get(groupId) ?? emptyGroup(groupId)));
  return { ...contract, groups };
}

function withUnit(
  contract: ContractRecord,
  unitId: string,
  groupId: string | undefined,
  patch: (unit: ContractUnitRecord) => ContractUnitRecord,
): ContractRecord {
  const units = new Map(contract.units);
  const known = units.get(unitId);
  const existing = known ?? emptyUnit(unitId, groupId ?? '');
  units.set(unitId, patch(groupId !== undefined ? { ...existing, groupId } : existing));
  // A unit first seen here (a fix unit added after planning) joins its group's list too.
  if (known !== undefined || groupId === undefined || groupId === '') return { ...contract, units };
  const group = contract.groups.get(groupId) ?? emptyGroup(groupId);
  if (group.unitIds.includes(unitId)) return { ...contract, units };
  const groups = new Map(contract.groups);
  groups.set(groupId, { ...group, unitIds: [...group.unitIds, unitId] });
  return { ...contract, units, groups };
}

function verdictsOf(criteria: readonly { readonly criterionId: string; readonly verdict: CriterionVerdict }[]): Record<string, CriterionVerdict> {
  return Object.fromEntries(criteria.map((criterion) => [criterion.criterionId, criterion.verdict]));
}

/** Applies one event to its contract. Null when the event changes nothing the domain keeps. */
function applyToContract(contract: ContractRecord, event: ContractEvent, timestamp: number): ContractRecord | null {
  switch (event.type) {
    case 'CONTRACT_CREATED':
      return {
        ...contract,
        sessionId: event.sessionId,
        origin: event.origin,
        ask: event.ask,
        ownerAgentId: event.ownerAgentId,
        createdAt: Math.min(contract.createdAt, timestamp),
      };
    case 'CONTRACT_STATUS_CHANGED':
      return withStatus(contract, event.to, timestamp);
    case 'CONTRACT_PLANNED': {
      const groups = new Map<string, ContractGroupRecord>();
      for (const group of event.groups) {
        const existing = contract.groups.get(group.id);
        groups.set(group.id, {
          id: group.id,
          title: group.title,
          kind: group.kind,
          status: existing?.status ?? 'pending',
          unitIds: [...group.unitIds],
          verdicts: existing?.verdicts ?? {},
        });
      }
      const units = new Map<string, ContractUnitRecord>();
      for (const unit of event.units) {
        const existing = contract.units.get(unit.id);
        units.set(unit.id, {
          ...(existing ?? emptyUnit(unit.id, unit.groupId)),
          groupId: unit.groupId,
          title: unit.title,
          role: unit.role,
        });
      }
      return {
        ...contract,
        goal: event.goal,
        criteria: event.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text, disposition: criterion.disposition })),
        groups,
        units,
      };
    }
    case 'CONTRACT_GROUP_STATUS_CHANGED':
      return withGroup(contract, event.groupId, (group) => ({ ...group, status: event.to }));
    case 'CONTRACT_UNIT_STATUS_CHANGED':
      return withUnit(contract, event.unitId, event.groupId, (unit) => ({
        ...unit,
        status: event.to,
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
      }));
    case 'CONTRACT_UNIT_SPAWNED':
      return withUnit(contract, event.unitId, undefined, (unit) => ({ ...unit, agentId: event.agentId }));
    case 'CONTRACT_CHECKED': {
      const lastCheck = { scope: event.scope, targetId: event.targetId, checkId: event.checkId, result: event.result };
      const read = verdictsOf(event.criteria);
      if (event.scope === 'unit') {
        return {
          ...withUnit(contract, event.targetId, undefined, (unit) => ({
            ...unit,
            verdicts: { ...unit.verdicts, ...read },
            lastCheckId: event.checkId,
            lastCheckResult: event.result,
          })),
          lastCheck,
        };
      }
      if (event.scope === 'group') {
        return {
          ...withGroup(contract, event.targetId, (group) => ({ ...group, verdicts: { ...group.verdicts, ...read } })),
          lastCheck,
        };
      }
      return {
        ...contract,
        criteria: contract.criteria.map((criterion) => (
          read[criterion.id] !== undefined ? { ...criterion, verdict: read[criterion.id], checkId: event.checkId } : criterion
        )),
        lastCheck,
      };
    }
    case 'CONTRACT_NUDGED':
      return {
        ...withUnit(contract, event.unitId, undefined, (unit) => ({ ...unit, nudges: unit.nudges + 1 })),
        nudges: contract.nudges + 1,
      };
    case 'CONTRACT_ESCALATED':
      return {
        ...contract,
        openEscalations: [
          ...contract.openEscalations.filter((escalation) => escalation.escalationId !== event.escalationId),
          { escalationId: event.escalationId, scope: event.scope, targetId: event.targetId, reason: event.reason, question: event.question },
        ],
      };
    case 'CONTRACT_OWNER_REPLIED':
      return {
        ...contract,
        openEscalations: contract.openEscalations.filter((escalation) => escalation.escalationId !== event.escalationId),
      };
    case 'CONTRACT_COMMITTED':
      return {
        ...contract,
        commit: { status: event.status, ...(event.hash !== undefined ? { hash: event.hash } : {}), note: event.note },
      };
    case 'CONTRACT_PASSED':
      return withStatus({ ...contract, openEscalations: [] }, 'passed', timestamp);
    case 'CONTRACT_FAILED':
      return withStatus({ ...contract, openEscalations: [], failureKind: event.failureKind, reason: event.reason }, 'failed', timestamp);
    case 'CONTRACT_CANCELLED':
      return withStatus({ ...contract, openEscalations: [], reason: event.reason }, 'cancelled', timestamp);
    case 'CONTRACT_GATE_RESULT': {
      const gateResults = new Map(contract.gateResults);
      gateResults.set(JSON.stringify([event.targetId, event.gate]), {
        targetId: event.targetId, gate: event.gate, passed: event.passed, skipped: event.skipped, durationMs: event.durationMs,
        outcome: event.outcome ?? (event.skipped ? 'unverified' : event.passed ? 'passed' : 'failed'),
        ...(event.required === undefined ? {} : { required: event.required }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
      return { ...contract, gateResults };
    }
    case 'CONTRACT_SHAPED':
    case 'CONTRACT_PLAN_CHECKED':
    case 'CONTRACT_NUDGE_CONSUMED':
    case 'CONTRACT_CRITERION_REGRESSED':
    case 'CONTRACT_STALLED':
    case 'CONTRACT_FIX_PLANNED':
    case 'CONTRACT_UNIT_SILENT':
    case 'CONTRACT_MERGE_CONFLICT':
    case 'CONTRACT_ATTEMPTS_SELECTED':
    case 'CONTRACT_SPAWN_GUARD_TRIGGERED':
      // Carried by the status, check and unit events that follow them.
      return null;
  }
}

/** True when this event moved the contract into `status`. Totals count every contract ever seen, including evicted ones. */
function endedAs(before: ContractRecord, after: ContractRecord, status: ContractStatus): boolean {
  return before.status !== status && after.status === status;
}

export function updateContractsState(domain: ContractDomainState, event: ContractEvent): ContractDomainState {
  if (event.type === 'CONTRACT_SPAWN_GUARD_TRIGGERED') {
    return { ...updateDomainMetadata(domain, event.type), spawnGuardTrips: domain.spawnGuardTrips + 1 };
  }
  const timestamp = now();
  const known = domain.contracts.get(event.contractId);
  // An ended contract keeps its first outcome (a cancel racing a pass must not count both). The
  // runner ends a contract with a status change followed by the terminal event that carries the
  // reason, so that terminal event still lands when it names the status already reached.
  if (known && TERMINAL_STATUSES.has(known.status) && movesStatus(event) && terminalStatusOf(event) !== known.status) return domain;
  // A late event for an evicted contract, or one that does not describe a contract, must not
  // bring back a contract that never ends.
  if (!known && (domain.evictedContractIds?.includes(event.contractId) || !describesContract(event))) return domain;
  const existing = known ?? emptyContract(event.contractId, timestamp);
  const next = applyToContract(existing, event, timestamp);
  if (next === null) return domain;

  const contracts = new Map(domain.contracts);
  contracts.set(next.id, next);
  const evicted = evictEnded(contracts);
  const records = [...contracts.values()];
  return {
    ...updateDomainMetadata(domain, event.type),
    contracts,
    activeContractIds: records
      .filter((contract) => !TERMINAL_STATUSES.has(contract.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((contract) => contract.id),
    ...(evicted.length > 0 ? { evictedContractIds: [...(domain.evictedContractIds ?? []), ...evicted].slice(-MAX_REMEMBERED_EVICTIONS) } : {}),
    totalContracts: domain.totalContracts + (domain.contracts.has(next.id) ? 0 : 1),
    totalPassed: domain.totalPassed + (endedAs(existing, next, 'passed') ? 1 : 0),
    totalFailed: domain.totalFailed + (endedAs(existing, next, 'failed') ? 1 : 0),
    totalCancelled: domain.totalCancelled + (endedAs(existing, next, 'cancelled') ? 1 : 0),
  };
}
