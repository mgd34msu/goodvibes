import type { NativeConversationContinuation } from '../workflow/work-ledger/native-continuation-context.js';
import type { ReviewInventory } from './review-inventory.js';
import type { ReviewedFileReference } from './review-file-observations.js';
import type { DurableContractAdmission } from './durable-admission.js';
/**
 * The contract runner's data model (docs/design/contract-runner.md section 2.3):
 * a contract, its groups and units, their criteria with every reading, checks,
 * nudges, escalations and decisions, and the status transition tables.
 *
 * A contract is the unit of work the runner owns. Jev judges every unit
 * against its criteria while the unit's sub-agent works, and the agent is
 * nudged until every criterion reads met; nothing else can pass a unit.
 *
 * The status strings and other closed sets are declared once in the event
 * vocabulary (events/contract.ts) and re-exported here, so the persisted tree
 * and the wire events cannot drift apart.
 */
import type { ContractInputSnapshot } from './input-snapshot.js';

import type { NativeContractDecisionState, NativeContractProgress, NativeContractTransportProgress } from './native-decisions.js';
import type { JsonValue, Outcome, ReplyReadingName } from '@goodvibes/judgment';
import type {
  CheckResult,
  CheckTrigger,
  ClaimVerificationKind,
  ContractAgentRole,
  ContractDecisionAction,
  ContractFailureKind,
  ContractGroupStatus,
  ContractOrigin,
  ContractShapeReading,
  ContractStatus,
  ContractUnitStatus,
  CriterionDisposition,
  CriterionOrigin,
  CriterionSeverity,
  CriterionStatus,
  CriterionVerdict,
  EscalationReason,
  EscalationScope,
  GroupKind,
  NudgeDelivery,
  NudgeKind,
  QualityItem,
  UnitRole,
  YesNoVerdict,
} from '../../events/contract.js';
import type { CompletionReport } from '../agents/completion-report.js';
import type { BudgetCeiling, WorkItemUsage } from '../orchestration/types.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import type { AgentProviderRoutingPolicy } from '../tools/agent/schema.js';
import type { QualityGateResult } from './gates.js';

export type {
  CheckResult,
  CheckTrigger,
  ContractAgentRole,
  ContractDecisionAction,
  ContractFailureKind,
  ContractOrigin,
  ContractStatus,
  CriterionDisposition,
  CriterionOrigin,
  CriterionSeverity,
  CriterionStatus,
  CriterionVerdict,
  EscalationReason,
  EscalationScope,
  GroupKind,
  NudgeDelivery,
  NudgeKind,
  QualityItem,
  UnitRole,
  YesNoVerdict,
};
export {
  CONTRACT_AGENT_ROLES,
  CONTRACT_DECISION_ACTIONS,
  CONTRACT_FAILURE_KINDS,
  CONTRACT_GROUP_STATUSES,
  CONTRACT_ORIGINS,
  CONTRACT_STATUSES,
  CONTRACT_UNIT_STATUSES,
  CRITERION_SEVERITIES,
  QUALITY_ITEMS,
} from '../../events/contract.js';

export type GroupStatus = ContractGroupStatus;
export type UnitStatus = ContractUnitStatus;

/** The AgentManager surface the runner and the phase runner use. */
export type AgentManagerLike = Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'listByCohort' | 'clear'>;

// ── Ids ────────────────────────────────────────────────────────────────────────

/** Schema version of a persisted contract; `deserializeContract` refuses a newer one. */
// Version 5 composes durable admission, immutable native source, semantic ownership and captured input authority.
// Older v2/v4 readers must refuse it rather than auto-resume a partially understood binding.
// Version 6 retains native physical review observations as private checkpoint
// bookkeeping. Older readers must refuse it rather than erase those records.
export const CURRENT_CONTRACT_SCHEMA_VERSION = 6;

/** Full 128-bit UUID ids are emitted. Saved 8-hex ids and saved UUIDs spelled
 * with the letters a to p (an earlier spelling) stay readable. */
const opaqueContractPattern = /^ctr-[0-9a-p]{8}(?:-[0-9a-p]{4}){3}-[0-9a-p]{12}$/;
const contractIdPattern = /^ctr-(?:[0-9a-f]{8}|[0-9a-p]{8}(?:-[0-9a-p]{4}){3}-[0-9a-p]{12})$/;
export const CONTRACT_ID_PATTERN = new RegExp(contractIdPattern.source);
export function isContractId(value: unknown): value is string {
  return typeof value === 'string' && contractIdPattern.test(value);
}
export function isOpaqueContractId(value: unknown): value is string {
  return typeof value === 'string' && opaqueContractPattern.test(value);
}
/** A fresh full 128-bit contract id. */
export function newContractId(): string { return `ctr-${crypto.randomUUID()}`; }

// ── Routing ────────────────────────────────────────────────────────────────────

/** The model a unit (or the planner) runs on, with the selector's reason (design 2.2). */
export interface UnitRoute {
  readonly model: string;
  readonly provider: string;
  readonly fallbackModels?: readonly string[] | undefined;
  readonly routing?: AgentProviderRoutingPolicy | undefined;
  readonly reasoningEffort?: AgentRecord['reasoningEffort'] | undefined;
  /** Recorded on the unit, copied to the agent record's routeReason, and carried by the spawned event. */
  readonly reason: string;
}

/**
 * The fields of a contract a route pick reads. Callers pass the live contract
 * (read-only), never a copy: a group's routes are picked side by side, and a
 * copy of the whole record per pick grows with the file manifest.
 */
export type ContractRouteSubject = Pick<ContractView, 'id' | 'ask' | 'goal' | 'criteria' | 'selectedModel' | 'nativeSource'>;
/** The fields of a unit a route pick reads. */
export type ContractRouteUnit = Pick<ContractUnitView, 'id' | 'role' | 'title' | 'goal' | 'brief'>;

/** Picks the route for the planner, a unit, a fresh unit agent, or an integration unit. Required: there is no default model. */
export type ContractRouteSelector = (request: {
  readonly purpose: 'planner' | 'unit' | 'fresh-unit' | 'integration';
  readonly signal?: AbortSignal | undefined;
  readonly beforeAttempt?: (() => void) | undefined;
  readonly onRetry?: ((progress: import('@goodvibes/judgment').JudgmentRetryProgress) => void) | undefined;
  readonly contract: ContractRouteSubject;
  readonly unit?: ContractRouteUnit | undefined;
}) => Promise<UnitRoute>;

// ── Starting a contract ───────────────────────────────────────────────────────

/** Host-owned immutable native input. Revisions identify exact content; they are not execution authority. */
export interface NativeContractSource {
  /** Host-captured prior conversation evidence, never generated requirements or authority. */
  readonly continuation?: NativeConversationContinuation;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly inputRevision: string;
  readonly criteriaId: string;
  readonly criteriaRevision: string;
  /** Complete original goal, without trimming or generated summarization. */
  readonly goal: string;
  /** Complete original criteria in source order. Empty/missing criteria are invalid. */
  readonly criteria: readonly string[];
}

export interface StartContractInput {
  /** User-selected connection and family at submission, retained for every agent and fallback. */
  readonly selectedModel?: Pick<import('../providers/registry-types.js').ModelDefinition, 'id' | 'provider' | 'registryKey' | 'displayName'> | undefined;
  /** Untrusted CI context; never original requirements or authority. */
  readonly taskEvidence?: string | undefined;
  /** Native callers supply the complete immutable source. Absence explicitly retains legacy ask-derived planning. */
  readonly nativeSource?: NativeContractSource | undefined;
  /** Legacy request words verbatim; native runs retain this display request separately from authoritative nativeSource. */
  readonly ask: string;
  readonly sessionId: string;
  readonly origin: ContractOrigin;
  readonly projectRoot: string;
  /** The identified principal that started it over the operator surface; recorded as the contract's owner. */
  readonly ownerPrincipalId?: string | undefined;
  /** True when its hosted session was created for this contract by contracts.dispatch; recorded on the contract. */
  readonly sessionCreatedForDispatch?: true | undefined;
  /** Units proposed by an agent-tool batch or AgentInput.proposedUnits; the planner weighs them. */
  readonly proposedUnits?: readonly { readonly task: string; readonly template?: string | undefined }[] | undefined;
  /** The conversation agent that asked, when there is one. */
  readonly parentAgentId?: string | undefined;
  readonly budget?: BudgetCeiling | undefined;
  readonly isolation?: 'auto' | 'worktree' | 'shared' | undefined;
}

/** One unit of a plan drafted before the contract started (a plan proposal or a workstream draft, design 10.4). */
export interface DraftedUnit {
  /** `u<n>`, assigned in draft order when the contract starts. */
  readonly id: string;
  readonly title: string;
  /** The unit's brief, kept verbatim by the planner. */
  readonly brief: string;
  /** Ids of drafted units this one depends on. */
  readonly dependsOn: readonly string[];
  readonly files?: readonly string[] | undefined;
  /** Best-of-N attempts the draft asked for; absent keeps the configured default. */
  readonly attempts?: number | undefined;
}

/** A plan drafted before the contract started: the planner writes only the criteria (and the groups that hold the units); every plan check runs. */
export interface DraftedPlan {
  readonly goal: string;
  readonly units: readonly DraftedUnit[];
}

/** Starts a contract from a drafted plan (design 2.2 `startFromPlan`). */
export interface StartFromPlanInput extends Omit<StartContractInput, 'proposedUnits'> {
  readonly draft: DraftedPlan;
}

// ── Request shape (design 3.1) ────────────────────────────────────────────────

/** One request-shape question as it was read. */
export type ShapeReading = ContractShapeReading;

/** The four request-shape readings, keyed by the battery's question names, and the decision-log ids behind them. */
export interface RequestShape {
  readonly project_review?: ShapeReading;
  readonly forbids_delegation: ShapeReading;
  readonly requests_parallel_agents: ShapeReading;
  readonly forbids_writing: ShapeReading;
  readonly asks_for_attempts: ShapeReading;
  readonly decisionIds: readonly string[];
}

// ── Criteria and readings ─────────────────────────────────────────────────────


export interface CriterionReading {
  readonly checkId: string;
  readonly at: number;
  /** The judge's yes/no probability, where yes means the criterion fails. */
  readonly probabilityUnmet: number;
  readonly verdict: CriterionVerdict;
  readonly outcome: Outcome;
  readonly severity?: CriterionSeverity | undefined;
  readonly decisionId: string | undefined;
  /** The `contract.unmet-severity` reading behind `severity` (recorded even when it did not settle, so the severity stayed unknown). */
  readonly severityDecisionId?: string | undefined;
  /** One sentence on what evidence was missing when the criterion read unmet or not shown, shown to the worker in the nudge. */
  readonly rationale?: string | undefined;
}

/** Role in the original requested result, separate from execution status. */
export interface WorkContribution {
  readonly kind: 'outcome' | 'support' | 'scaffolding' | 'secondary';
  readonly reason: string;
  /** The observable behavior or evidence which settles this part. */
  readonly verification: string;
}

export interface Criterion {
  readonly id: string;
  text: string;
  readonly origin: CriterionOrigin;
  /** Verbatim source words: stated requirements, or provenance for goal-derived acceptance checks. */
  readonly quote?: string | undefined;
  /** Ids of the criteria this one serves; empty for contract roots (including goal-derived checks). */
  readonly serves: readonly string[];
  /** A checked plan's categorization; never an exemption from acceptance. */
  readonly contribution?: WorkContribution;
  /** 'excluded' only for topology-only criteria the plan cannot satisfy; 'met-by-structure' when the plan's shape meets it. */
  disposition: CriterionDisposition;
  dispositionReason?: string | undefined;
  status: CriterionStatus;
  /** Every reading, oldest first. */
  readings: CriterionReading[];
}

// ── Checks and nudges ─────────────────────────────────────────────────────────

export interface UnitCheck {
  /** Actual file versions supplied to this passed research assessment. */
  readonly reviewedFiles?: readonly ReviewedFileReference[];
  /** `${unitId}.k${n}` for a unit; the group or contract id in place of the unit id for group and deliverable checks. */
  readonly id: string;
  readonly at: number;
  readonly trigger: CheckTrigger;
  readonly claims?: { readonly kind: ClaimVerificationKind; readonly summary: string } | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly goal: { readonly probabilityUnmet: number; readonly verdict: CriterionVerdict; readonly outcome: Outcome };
  /** Every quality item for a unit check; group and deliverable checks read no quality items. */
  readonly quality: Readonly<Partial<Record<QualityItem, { readonly verdict: YesNoVerdict; readonly outcome: Outcome }>>>;
  readonly result: CheckResult;
  /**
   * Every problem kind the check found, whatever its result (a turn-end check
   * records problems it does not nudge on). Progress, stall and the unsettled
   * count read this history.
   */
  readonly problems?: readonly NudgeKind[] | undefined;
  /** The quality items read as problems. */
  readonly qualityProblems?: readonly QualityItem[] | undefined;
  readonly decisionIds: readonly string[];
  /**
   * Why the set decision model could not judge this check (it failed, refused
   * the request or did not answer): the work was kept as delivered and checked
   * by code alone. Absent when a decision model judged it, or none is in use.
   */
  readonly notJudged?: string;
  /** Exact saved evidence commitment for nonpass refusal replay. Historical
   * pass checks may retain it; fresh pass checks use actual check/decision IDs. */
  readonly evidenceDigest?: string;
}

export interface Nudge {
  readonly id: string;
  readonly checkId: string;
  readonly at: number;
  readonly kinds: readonly NudgeKind[];
  readonly criterionIds: readonly string[];
  readonly text: string;
  readonly delivery: NudgeDelivery;
  readonly agentId: string;
  consumedAt?: number | undefined;
}

// ── The tree ──────────────────────────────────────────────────────────────────

/**
 * HEAD and what each uncommitted path held when the baseline was taken.
 * Version 4 (written now) stores git object ids: `file:<oid>`,
 * `executable:<oid>`, `symlink:<sha256 of the target>`, `other` (cannot be
 * named) or null (absent). Versions 2 and earlier store sha256 commitments of
 * the bytes, version 3 physical facts only; both are still read.
 */
export interface TreeBaseline {
  readonly version?: 2 | 3 | 4;
  readonly head: string | null;
  readonly dirty: Readonly<Record<string, string | null>>;
}

export interface ContractUnit {
  readonly id: string;
  readonly groupId: string;
  title: string;
  goal: string;
  brief: string;
  readonly role: UnitRole;
  readonly dependsOn: readonly string[];
  readonly files: readonly string[];
  /** 1 unless best-of-N. */
  readonly attempts: number;
  criteria: Criterion[];
  status: UnitStatus;
  /** Every agent that ever ran this unit. */
  agentIds: string[];
  activeAgentId?: string | undefined;
  route?: UnitRoute | undefined;
  checks: UnitCheck[];
  nudges: Nudge[];
  fixRounds: number;
  freshAgents: number;
  transportRetries: number;
  touchedPaths: string[];
  /**
   * The working tree the unit's diff is measured against, taken when its
   * first agent is spawned: in the shared project root, or in the unit's
   * item worktree in worktree mode (where it is the item branch's base).
   */
  baseline?: TreeBaseline | undefined;
  usage: WorkItemUsage;
  /** The unit's completion summary. */
  answer?: string | undefined;
  /**
   * The private candidate read by the latest completion check, retained for
   * fresh verification after restart. Its presence grants no acceptance or
   * permission to publish; only a passed unit has a deliverable answer.
   */
  lastOutput?: string | undefined;
  /** Captured read-only observations retained for fresh checks after restart; never an approval. */
  readEvidence?: readonly import('./evidence.js').SourceReadEvidence[] | undefined;
  /** Actual command results retained across restarts and worker-worktree cleanup; never approval. */
  commandEvidence?: readonly import('./evidence.js').CommandExecutionReceipt[] | undefined;
  /**
   * The completion report parsed from the output of the unit's last completion
   * check, whole. `lastOutput` is capped head and tail, so a long report is cut
   * there; a check after a restart reads this instead of re-parsing it
   * (design 7.2). Absent when the output carried no report.
   */
  lastReport?: CompletionReport | undefined;
  failureReason?: string | undefined;
  /**
   * Best-of-N (design 6.2), on a plan unit with `attempts > 1` in worktree
   * mode: one attempt unit per sibling, each run and checked on its own. The
   * plan unit runs no agent itself; it passes with the selected attempt's work.
   */
  attemptUnits?: ContractUnit[] | undefined;
  /** On an attempt unit: the plan unit it is an attempt of. */
  readonly attemptOf?: string | undefined;
  /** On an attempt unit: its index among the plan unit's attempts, from 0. */
  readonly attemptIndex?: number | undefined;
  /** On a plan unit with attempts: the selection over its passing attempts, once read. */
  attemptSelection?: AttemptSelectionRecord | undefined;
}

/** What `contract.best-of-n` read over a unit's passing attempts, and the attempt taken. */
export interface AttemptSelectionRecord {
  /** The engine's best-of-N group the attempts belong to. */
  readonly engineGroupId: string;
  /** The attempt units that passed their checks: the only candidates. */
  readonly candidateIds: readonly string[];
  /** The fitting winner the selector proposed, when there was one. */
  readonly proposedId?: string | undefined;
  readonly outcome: Outcome;
  /** Built in code from the readings. */
  readonly reasons: string;
  readonly decisionId?: string | undefined;
  /** The attempt accepted (by the selection at act, or by the owner); set once it is picked. */
  pickedId?: string | undefined;
}

export interface ContractGroup {
  readonly id: string;
  title: string;
  goal: string;
  readonly kind: GroupKind;
  readonly repairs?: {
    readonly scope: 'unit' | 'group' | 'deliverable';
    readonly targetId: string;
    readonly criterionIds: readonly string[];
  } | undefined;
  readonly dependsOn: readonly string[];
  criteria: Criterion[];
  unitIds: string[];
  status: GroupStatus;
  checks: UnitCheck[];
  fixRounds: number;
  /** The tree the group check's diff is measured against, taken when the group starts (design 6.4). */
  baseline?: TreeBaseline | undefined;
  usage: WorkItemUsage;
}

export interface Escalation {
  readonly id: string;
  readonly at: number;
  readonly scope: EscalationScope;
  readonly targetId: string;
  readonly reason: EscalationReason;
  /** Built in code (design 6.3). */
  readonly question: string;
  readonly unmetCriterionIds: readonly string[];
  /** The decision-log ids of the readings behind the question (what the owner is asked to settle). */
  readonly decisionIds?: readonly string[] | undefined;
  /**
   * Set only on the question a native session contract asks when its turn keeps
   * failing: the one answer pair is retry or cancel. It is never an approval,
   * and no reading of a reply is involved.
   */
  readonly failurePause?: true | undefined;
  /**
   * Set on the question asked after the owner's change to a group's or the
   * deliverable's criteria was applied but checking the work against it could
   * not run: approving it runs that check again and nothing else (the change is
   * not applied a second time and no budget is reset). `summary` is the change
   * that was applied, as the question names it.
   */
  readonly recheckPending?: { readonly summary: string } | undefined;
  resolvedAt?: number | undefined;
  reply?: {
    readonly text: string;
    readonly reading: ReplyReadingName;
    readonly outcome: Outcome;
    readonly decisionId: string | undefined;
  } | undefined;
}


/**
 * What the runner reads back from a decision after a restart, stored beside
 * its sentence and never recovered from it: a scheduled repair round, an
 * owner amendment, or a receipt (acceptance, final-answer review, obligation
 * proofs, publication readings, a saved planner candidate).
 */
export type ContractDecisionRecord =
  | { readonly kind: 'fix-scheduled'; readonly round: number; readonly groupId: string }
  | { readonly kind: 'amended' }
  | { readonly kind: 'receipt'; readonly value: JsonValue };

/** One runner decision, with the decision-log ids of the Jev readings behind it. */
export interface ContractDecision {
  readonly id: string;
  readonly at: number;
  readonly action: ContractDecisionAction;
  readonly targetId: string;
  /** One short sentence for people; nothing reads it back. */
  readonly reason: string;
  readonly decisionIds: readonly string[];
  readonly route?: UnitRoute | undefined;
  readonly record?: ContractDecisionRecord | undefined;
}

/** One agent's usage as its contract last saw it. */
export interface KnownAgentUsage {
  /** Priced, as a unit's usage merges it. */
  readonly usage: WorkItemUsage;
  /** The agent's own counts, as the owner record sums them. */
  readonly agent?: NonNullable<AgentRecord['usage']> | undefined;
  readonly toolCallCount: number;
}

export interface JudgmentUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Contract {
  reviewInventory?: ReviewInventory;
  reviewExclusions?: readonly { readonly files: readonly string[]; readonly reason: string }[];
  /** Captured at submission; changing another session's selection does not reroute this contract. */
  readonly selectedModel?: Pick<import('../providers/registry-types.js').ModelDefinition, 'id' | 'provider' | 'registryKey' | 'displayName'> | undefined;
  /** Original live source evidence; serialized data cannot recreate its owner. */
  readonly originalSource?: import('../permissions/autonomous.js').AutonomousToolSource | undefined;
  readonly taskEvidence?: string | undefined;
  /** Versioned native semantic receipts/counters, separate from transport waiting progress. */
  nativeDecisions?: NativeContractDecisionState | undefined;
  nativeProgress?: NativeContractProgress | undefined;
  nativeWaiting?: NativeContractTransportProgress | undefined;
  /** Present only for native source-bound runs; preserved across planning, correction, persistence and verification. */
  readonly nativeSource?: NativeContractSource | undefined;
  /** Native-bound contracts are resumed only through resumeDurable with fresh host validation. */
  readonly durableAdmission?: DurableContractAdmission | undefined;
  durableLaunchState?: 'prepared' | 'launch-claimed' | undefined;
  readonly id: string;
  /** CURRENT_CONTRACT_SCHEMA_VERSION when written. */
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly origin: ContractOrigin;
  /**
   * The identified principal that started it over the operator surface. Only
   * that principal (and the daemon itself) sees and acts on it there, whoever
   * is attached to its session later; absent, the session's owners decide.
   */
  readonly ownerPrincipalId?: string | undefined;
  /**
   * True when contracts.dispatch created its hosted session for it: the session
   * ends when the contract settles, also after a daemon restart. Absent on
   * contracts from before it was recorded (their session is kept, as then).
   */
  readonly sessionCreatedForDispatch?: true | undefined;
  readonly ask: string;
  readonly ownerAgentId: string;
  readonly parentAgentId?: string | undefined;
  readonly projectRoot: string;
  /** Versioned local input provenance; absent on legacy/shared contracts, never a content permission grant. */
  inputSnapshot?: ContractInputSnapshot | undefined;
  /** Settled when the contract is shaped: a session-mode contract (design 6.6) works in the shared tree. */
  isolation: 'worktree' | 'shared';
  /** Worktree mode: `contract/<short>`. */
  branch?: string | undefined;
  worktreePath?: string | undefined;
  baseBranch?: string | undefined;
  /** The contract's tree when its groups started: the deliverable diff and the shared-mode commit are measured against it. */
  baseline?: TreeBaseline | undefined;
  /** The user forbade delegation (design 6.6): the session's own turns do the one unit, and no sub-agent is ever spawned. */
  sessionMode?: boolean | undefined;
  /** Units an agent-tool batch or AgentInput.proposedUnits proposed; kept so planning that starts again after a restart weighs them too. */
  readonly proposedUnits?: readonly { readonly task: string; readonly template?: string | undefined }[] | undefined;
  /** The plan drafted before the contract started (startFromPlan): the planner keeps its units and writes their criteria. */
  readonly draftPlan?: DraftedPlan | undefined;
  /** The whole contract's token and cost ceiling; each group's workstream gets what remains of it when the group starts. */
  readonly budget?: BudgetCeiling | undefined;
  goal: string;
  /** Contract-level criteria; every one has origin 'stated' or 'owner'. */
  criteria: Criterion[];
  groups: ContractGroup[];
  units: ContractUnit[];
  shape?: RequestShape | undefined;
  status: ContractStatus;
  /**
   * The status the contract left for its owner (design 6.3): it returns there
   * once its last open escalation is answered. Kept on the contract so a
   * contract waiting on its owner across a restart still knows it.
   */
  statusBeforeOwner?: ContractStatus | undefined;
  /**
   * A resumed contract that found the active-contract cap full waits in
   * `queued` (design 7.2 and 7.3): the step it was on, which it resumes from
   * when a slot opens.
   */
  resumeFrom?: ContractStatus | undefined;
  /** Deliverable checks. */
  checks: UnitCheck[];
  fixRounds: number;
  escalations: Escalation[];
  decisions: ContractDecision[];
  usage: WorkItemUsage;
  judgmentUsage: JudgmentUsage;
  plannerAgentIds: string[];
  /**
   * What the contract last saw of each agent's usage, by agent id (usage.ts).
   * The roll-ups read this, refreshed from an agent's live record while it
   * exists, so a record pruned or lost in a crash changes no total.
   */
  agentUsage?: Record<string, KnownAgentUsage> | undefined;
  answer?: string | undefined;
  statusLine?: string | undefined;
  commit?: { readonly status: 'committed' | 'applied' | 'skipped' | 'failed'; readonly hash?: string | undefined; readonly note: string } | undefined;
  failureKind?: ContractFailureKind | undefined;
  error?: string | undefined;
  readonly createdAt: number;
  completedAt?: number | undefined;
  /**
   * When the status last moved, set by every move (transitionContract), so a
   * poller sees updatedAt change on a move that records no decision. Absent on
   * contracts written before it was recorded; their other times stand in.
   */
  statusChangedAt?: number | undefined;
}

// ── Read-only views ───────────────────────────────────────────────────────────

/** Readonly all the way down: what `get`, `list` and events hand out. */
export type DeepReadonly<T> = T extends readonly (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type ContractView = DeepReadonly<Contract>;

/** What decides who may see a contract over the operator surface; a contract and its ended summary both carry it. */
export interface ContractOwnership {
  readonly sessionId: string;
  readonly ownerPrincipalId?: string | undefined;
}
export type ContractGroupView = DeepReadonly<ContractGroup>;
export type ContractUnitView = DeepReadonly<ContractUnit>;
export type CriterionView = DeepReadonly<Criterion>;

// ── Status transitions ────────────────────────────────────────────────────────

/**
 * Legal contract status moves. Every non-terminal status may fail (a judgment
 * outage, a zombie, a planning failure) or be cancelled. `queued` is both the
 * wait for an active-contract slot and where a resumed contract waits when the
 * cap is full, so a resumed contract leaves it for the step it was on; one
 * that was waiting on its owner (a failure pause) waits for its slot queued and
 * goes back to waiting on its owner when it gets one.
 */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  queued: ['shaping', 'planning', 'running', 'judging', 'fixing', 'committing', 'awaiting-owner', 'failed', 'cancelled'],
  shaping: ['planning', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  planning: ['checking-plan', 'queued', 'failed', 'cancelled'],
  'checking-plan': ['planning', 'running', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  running: ['judging', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  judging: ['committing', 'fixing', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  fixing: ['judging', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  committing: ['judging', 'passed', 'queued', 'failed', 'cancelled'],
  'awaiting-owner': ['planning', 'running', 'judging', 'fixing', 'queued', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

/** Legal group status moves. A group with no criteria passes without a group check (running to passed). */
export const GROUP_TRANSITIONS: Readonly<Record<GroupStatus, readonly GroupStatus[]>> = {
  pending: ['blocked', 'running', 'failed', 'cancelled'],
  blocked: ['pending', 'running', 'failed', 'cancelled'],
  running: ['judging', 'passed', 'awaiting-owner', 'failed', 'cancelled'],
  judging: ['passed', 'fixing', 'awaiting-owner', 'failed', 'cancelled'],
  fixing: ['judging', 'awaiting-owner', 'failed', 'cancelled'],
  'awaiting-owner': ['running', 'judging', 'fixing', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

/**
 * Legal unit status moves. `passed` is reachable only from a check (checking
 * or held), from `held-merge` (a passing unit whose branch merged, or a
 * best-of-N selection whose chosen attempt merged), or from the owner
 * confirming unshown readings (awaiting-owner). An owner who picks an attempt
 * moves the unit from awaiting-owner to held-merge; the runner, not this table,
 * enforces that no criterion reads unmet at that moment. `pending` is where a
 * requeued unit (transport retry, silence retry, fresh agent) waits for its
 * next agent.
 */
export const UNIT_TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  pending: ['blocked', 'running', 'failed', 'cancelled'],
  blocked: ['pending', 'running', 'failed', 'cancelled'],
  running: ['checking', 'held', 'pending', 'awaiting-owner', 'failed', 'cancelled'],
  checking: ['running', 'held', 'nudged', 'passed', 'held-merge', 'fixing', 'awaiting-owner', 'pending', 'failed', 'cancelled'],
  held: ['nudged', 'passed', 'held-merge', 'fixing', 'awaiting-owner', 'pending', 'failed', 'cancelled'],
  nudged: ['running', 'checking', 'held', 'pending', 'awaiting-owner', 'failed', 'cancelled'],
  fixing: ['checking', 'awaiting-owner', 'failed', 'cancelled'],
  'awaiting-owner': ['running', 'nudged', 'checking', 'passed', 'held-merge', 'fixing', 'pending', 'failed', 'cancelled'],
  'held-merge': ['passed', 'fixing', 'awaiting-owner', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalContractStatus(status: ContractStatus): boolean {
  return CONTRACT_TRANSITIONS[status].length === 0;
}

export function isTerminalGroupStatus(status: GroupStatus): boolean {
  return GROUP_TRANSITIONS[status].length === 0;
}

export function isTerminalUnitStatus(status: UnitStatus): boolean {
  return UNIT_TRANSITIONS[status].length === 0;
}

/** Thrown for a status move its transition table does not allow. */
export class IllegalContractTransitionError extends Error {
  constructor(
    readonly subject: 'contract' | 'group' | 'unit',
    readonly subjectId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${subject} transition: ${from} -> ${to} for ${subject} ${subjectId}`);
    this.name = 'IllegalContractTransitionError';
  }
}

/** A status move that happened, for the caller to emit. */
export interface StatusChange<S extends string> {
  readonly from: S;
  readonly to: S;
}

function move<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  subject: 'contract' | 'group' | 'unit',
  target: { readonly id: string; status: S },
  to: S,
): StatusChange<S> {
  const from = target.status;
  if (!table[from].includes(to)) throw new IllegalContractTransitionError(subject, target.id, from, to);
  target.status = to;
  return { from, to };
}

/** Moves a contract to `to` at `at` (recorded as statusChangedAt), or throws IllegalContractTransitionError. */
export function transitionContract(contract: Contract, to: ContractStatus, at: number): StatusChange<ContractStatus> {
  const change = move(CONTRACT_TRANSITIONS, 'contract', contract, to);
  contract.statusChangedAt = at;
  return change;
}

/** Moves a group to `to`, or throws IllegalContractTransitionError. */
export function transitionGroup(group: ContractGroup, to: GroupStatus): StatusChange<GroupStatus> {
  return move(GROUP_TRANSITIONS, 'group', group, to);
}

/** Moves a unit to `to`, or throws IllegalContractTransitionError. */
export function transitionUnit(unit: ContractUnit, to: UnitStatus): StatusChange<UnitStatus> {
  return move(UNIT_TRANSITIONS, 'unit', unit, to);
}
