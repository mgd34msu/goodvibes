/**
 * Shared execution modes and risk evidence. PermissionManager routes dangerous
 * actions to the owner or Jev in safe modes; YOLO bypasses safety decisions.
 * All modes retain the same prepared action and current execution owner.
 */
export * from './boundary.js';
export * from './presets.js';
export { currentExecutionMode, isYoloExecution, isInvocationAdmitted } from './execution-context.js';
export { withExecutionModeOwner, currentExecutionModeOwner, type ExecutionModeOwner } from './execution-context.js';
export * from './reading.js';
export * from './surface-authority.js';
export { riskFamily, RISK_FAMILY_OPTIONS, type GateRiskFamily } from './batteries/risk-family.js';
export { sideEffect, SIDE_EFFECT_KIND_OPTIONS, MCP_CAPABILITY_OPTIONS, type SideEffectKind } from './batteries/side-effect.js';
export { sandboxAdvisory } from './batteries/sandbox-advisory.js';
export { executionVerification } from './batteries/execution-verification.js';
export { registry as gateJudgmentRegistry } from './judgment-registry.js';

/** Full-size validated snapshots for asynchronous callers; never a projected reading. */
export { snapshotJudgmentInput, snapshotJudgmentEvidence, captureOwnedJson, retainOwnedJson, assertJudgmentInput, judgmentInputCardProblem } from './judgment-input.js';
export type { RetainedOwnedJson } from './judgment-input.js';
export { captureJudgmentFailure } from './failure-input.js';
export { decideAutonomous } from './autonomous-decision.js';
export type { AutonomousDecisionInput, AutonomousDecision, AutonomousContinuation, AutonomousCondition } from './autonomous-decision.js';
export { admitJudgmentJson, captureStrictJudgmentJson, retainStrictJudgmentJson, prepareJudgmentResult, JudgmentResultAdmissionError } from './judgment-result.js';
export type { JudgmentResultAdmissionFailure, JudgmentResultAdmissionProblem, RetainedStrictJudgmentJson } from './judgment-result.js';

export { interactiveRuntimeSchemaStatus, interactiveRuntimeKind, interactiveRuntimeStatus, interactiveRuntimeRouteRole, INTERACTIVE_RUNTIME_ROUTE_ROLES, type InteractiveRuntimeRouteRole } from './batteries/interactive-runtime.js';

export { browserDeviceEvidence } from './batteries/browser-device-evidence.js';
