/**
 * Permissions domain state, tracks the permission mode, session approvals,
 * and the most recent permission decision with full audit trail.
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
 * Where a call is in the gate, as its gate events report it (see the reducer's
 * permissionMachineStateForEvent). The operator contract's schema is derived from this list.
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
 * PermissionDomainState, permission configuration and decision state.
 */
export interface PermissionDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Mode ───────────────────────────────────────────────────────────────────
  /** Current `permissions.mode` setting value. */
  mode: PermissionMode;
  /** The canonical execution mode, or the separate planning posture. */
  preset: GatePresetName;
  /**
   * Set while the gate reports a request without a decision. Gate events are
   * emitted after the permission check resolves, so this is not a live
   * "prompt open" signal; read pending approvals from the approval broker
   * (`listApprovals()` entries that are `pending` or `claimed`) for that.
   */
  awaitingDecision: boolean;
  /**
   * Calls the gate has reported on without yet emitting their decision. Parallel
   * tool calls interleave their gate events, so `awaitingDecision` is derived
   * from this list rather than from whichever event came last.
   */
  inFlightCallIds?: readonly string[] | undefined;
  /** Current state of the decision state machine (while a decision is in flight). */
  decisionMachineState?: PermissionDecisionMachineState | undefined;

  // ── Session approvals ──────────────────────────────────────────────────────
  /**
   * Per-session tool approval cache.
   * Key format: "<toolName>:<argsHash>" → boolean (approved/denied).
   */
  sessionApprovals: Map<string, boolean>;
  /** Number of approvals granted this session. */
  approvalCount: number;
  /** Number of denials issued this session. */
  denialCount: number;

  // ── Last decision ──────────────────────────────────────────────────────────
  /** The most recent permission decision record. */
  lastDecision?: PermissionDecision | undefined;

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total permission checks performed this session. */
  totalChecks: number;
  /** Total checks that were served from session cache. */
  cachedChecks: number;
}

/**
 * Returns the default initial state for the permissions domain.
 */
export function createInitialPermissionsState(): PermissionDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    mode: 'safe-owner',
    preset: 'safe-owner',
    awaitingDecision: false,
    inFlightCallIds: [],
    decisionMachineState: undefined,
    sessionApprovals: new Map(),
    approvalCount: 0,
    denialCount: 0,
    lastDecision: undefined,
    totalChecks: 0,
    cachedChecks: 0,
  };
}
