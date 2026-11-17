/**
 * Permissions domain state: the gate's decisions this session, with the most
 * recent one in full.
 */

import type {
  PermissionCategory,
  PermissionDecisionReasonCode,
  PermissionDecisionSource,
  PermissionRiskLevel,
} from '../../../permissions/types.js';
import type { GatePresetName } from '../../../gate/presets.js';

/** The effective execution mode shown by every runtime surface. */
export type PermissionMode = GatePresetName;

/**
 * Where a call is in the gate. A recorded decision is always at
 * `decision_emitted`; the operator contract's schema is derived from this list.
 */
export const PERMISSION_DECISION_MACHINE_STATES = [
  'check_boundary',
  'collect_rules',
  'normalize_input',
  'evaluate_policy',
  'evaluate_session_override',
  'read_stakes',
  'evaluate_preset',
  'awaiting_owner',
  'decision_emitted',
] as const;
export type PermissionDecisionMachineState = (typeof PERMISSION_DECISION_MACHINE_STATES)[number];

/** The outcome of a permission decision. */
export const PERMISSION_DECISION_OUTCOMES = ['approved', 'denied', 'deferred'] as const;
export type PermissionDecisionOutcome = (typeof PERMISSION_DECISION_OUTCOMES)[number];

/** Source layer that determined the permission outcome: the gate's own list. */
export type PermissionSourceLayer = PermissionDecisionSource;

/** Reason codes for a permission decision: the gate's own list. */
export type PermissionDecisionReason = PermissionDecisionReasonCode;

/** Full record of the most recent permission decision. */
export interface PermissionDecision {
  /** Tool call ID this decision is for. */
  callId: string;
  /** Tool name. */
  toolName: string;
  /** Permission category. */
  category: PermissionCategory;
  /** State machine state when the decision was emitted. */
  machineState: PermissionDecisionMachineState;
  /** Final outcome. */
  outcome: PermissionDecisionOutcome;
  /** Primary reason code. */
  reason: PermissionDecisionReason;
  /** Source layer that yielded the decision. */
  sourceLayer: PermissionSourceLayer;
  /** Whether the decision was persisted to session approvals. */
  persisted: boolean;
  /** Semantic classification surfaced with the decision. */
  classification?: string | undefined;
  /** Risk level surfaced with the decision. */
  riskLevel?: PermissionRiskLevel | undefined;
  /** Human-readable summary for operators and the prompt UI. */
  summary?: string | undefined;
  /** Epoch ms when the decision was emitted. */
  decidedAt: number;
}

/**
 * PermissionDomainState, the gate's decisions this session. The execution
 * mode is not kept here: it is the `permissions.mode` setting, read where it
 * is shown. Pending owner asks live in the approval broker.
 */
export interface PermissionDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Decisions ──────────────────────────────────────────────────────────────
  /** Calls the gate approved this session. */
  approvalCount: number;
  /** Calls the gate denied this session. */
  denialCount: number;
  /** Decisions the owner answered (source `user_prompt`). */
  promptCount: number;
  /** Every decision the gate emitted this session. */
  totalChecks: number;
  /** The most recent permission decision record. */
  lastDecision?: PermissionDecision | undefined;
}

/**
 * Returns the default initial state for the permissions domain.
 */
export function createInitialPermissionsState(): PermissionDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    approvalCount: 0,
    denialCount: 0,
    promptCount: 0,
    totalChecks: 0,
    lastDecision: undefined,
  };
}
