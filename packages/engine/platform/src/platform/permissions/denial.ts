/**
 * Shared construction of what rides on a gated tool call: the decision object
 * (state, who decided, reason, next step), the older {@link ToolDenial}, and
 * the self-explaining error string the asking agent reads. Centralised so every
 * tool path produces identical data.
 */

import type { ToolDecision, ToolDecisionMaker, ToolDenial } from '../types/tools.js';

/**
 * Structured-denial reason surfaced for a plan-mode refusal.
 *
 * Distinct from the internal `PermissionCheckResult.reasonCode` value
 * (`'plan_mode'`): this is the wire-facing token surfaces branch on to render
 * the plan-mode pill/affordance, and it is the value the asking agent sees on
 * `ToolResult.denial.reason`.
 */
export const PLAN_MODE_DENIAL_REASON = 'plan-mode';

/** The reason code the permission layer emits for a plan-mode refusal. */
export const PLAN_MODE_REASON_CODE = 'plan_mode';

/** Minimal shape read from a resolved permission check to build a denial. */
export interface DenialSource {
  readonly reasonCode: string;
  readonly sourceLayer: string;
  /** The user's free-text note from the prompt decision, when one was given. */
  readonly userReason?: string | undefined;
  /** The gate's own explanation of a refusal (a boundary check's reason and fix). */
  readonly detail?: string | undefined;
}

/** True when this refusal was produced by plan mode. */
export function isPlanModeDenial(source: DenialSource): boolean {
  return source.reasonCode === PLAN_MODE_REASON_CODE;
}

/**
 * Build the structured, call-scoped denial for a refused tool call.
 *
 * Plan-mode refusals surface `reason: 'plan-mode'` so surfaces and the asking
 * agent recognise them specifically; every other refusal passes the permission
 * layer's reason code through unchanged.
 */
export function buildToolDenial(source: DenialSource): ToolDenial {
  return {
    denied: true,
    reason: isPlanModeDenial(source) ? PLAN_MODE_DENIAL_REASON : source.reasonCode,
    scope: source.sourceLayer,
    ...(source.userReason ? { detail: source.userReason } : source.detail ? { detail: source.detail } : {}),
  };
}

/** A gate result, as {@link toolDecisionOf} reads it. */
export interface DecisionSource extends DenialSource {
  readonly approved: boolean;
  /** Present when the gate built the decision itself (gate/classify.ts); used as is. */
  readonly decision?: ToolDecision | undefined;
  /** Jev's receipt, when Jev decided. */
  readonly autonomousDecision?: { readonly decisionId: string; readonly summary: string } | undefined;
}

const DECIDED_BY: Readonly<Record<string, ToolDecisionMaker>> = {
  boundary: 'code', safety_check: 'code', invocation_admission: 'code',
  runtime_mode: 'mode', stakes_preset: 'mode',
  config_policy: 'rule', managed_policy: 'rule', session_override: 'rule', user_rule: 'rule',
  user_prompt: 'owner', jev_decision: 'jev',
};

const REASONS: Readonly<Record<string, string>> = {
  boundary_judgment_input: 'the call carries protected material that cannot be sent for a safety reading',
  boundary_catastrophic: 'the command reads as destroying the machine or the user\'s data wholesale',
  boundary_surface_authority: 'the instruction came from a surface that cannot direct changes',
  boundary_card_details: 'the call would send payment card details',
  boundary_outward_effect: 'what the call sends may repeat untrusted text read this turn',
  config_deny: 'the owner\'s permission settings deny this tool',
  managed_policy_deny: 'managed policy denies this call',
  user_rule_deny: 'a rule the owner saved denies this call',
  session_cached_deny: 'the owner denied this earlier in the session',
  user_denied: 'the owner declined this call',
  plan_mode: 'plan mode is on and this call would change something',
  jev_reject: 'Jev refused this call',
  jev_revise: 'Jev asked for a revised action',
  jev_defer: 'Jev deferred this call',
};

/**
 * The decision object for a gate result. A decision the gate built from facts
 * is returned unchanged; anything else is read from the result's layer and
 * reason code, so every result carries one shape.
 */
export function toolDecisionOf(source: DecisionSource): ToolDecision {
  if (source.decision) return source.decision;
  const decidedBy = DECIDED_BY[source.sourceLayer] ?? 'code';
  const decisionId = source.autonomousDecision?.decisionId;
  const id = decisionId ? { decisionId } : {};
  if (source.approved) {
    return { state: decidedBy === 'jev' ? 'allowed-by-jev' : 'allowed', decidedBy,
      reason: source.autonomousDecision?.summary ?? source.detail ?? source.reasonCode, ...id };
  }
  const reason = source.userReason ? `the owner declined: ${source.userReason}` : source.detail ?? REASONS[source.reasonCode] ?? source.reasonCode;
  const next = isPlanModeDenial(source)
    ? ['present the plan of changes and wait for the owner to approve it', 'the owner leaves plan mode to run it']
    : ['carry on without this call and report that it was not run'];
  return { state: 'refused', decidedBy, reason, next, ...id };
}

/**
 * Build the self-explaining error string for a refused tool call. Plan-mode
 * refusals steer the model toward presenting a plan rather than retrying the
 * tool; other refusals get the generic "continue without it" guidance.
 */
export function buildDenialErrorMessage(toolName: string, source: DenialSource): string {
  if (isPlanModeDenial(source)) {
    return (
      `Tool '${toolName}' was refused: you are in plan mode (reason: ${PLAN_MODE_DENIAL_REASON}, `
      + `scope: ${source.sourceLayer}). Do not attempt mutating or command-execution tools. `
      + `Present a concrete plan of the changes you intend to make and wait for the user to `
      + `approve it or switch out of plan mode.`
    );
  }
  const note = source.userReason ? ` The user said: "${source.userReason}".` : source.detail ? ` ${source.detail}` : '';
  return (
    `Permission denied for tool '${toolName}' (reason: ${source.reasonCode}, scope: ${source.sourceLayer}).${note} `
    + `This call was refused; adapt to the user's feedback, continue without it, and report that it was not run.`
  );
}
