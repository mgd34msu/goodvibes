/**
 * Diagnostics types and the panels live owners build. The policy runtime
 * builds the policy and divergence panels; the security read model shares the
 * security snapshot type; the state inspector and deterministic replay share
 * the runtime-state snapshot types. Remediation (retry or cancel a task, cancel
 * an agent) and health and event reads are served by the live owners through
 * the operator methods `tasks.retry`, `tasks.cancel`, `health.snapshot` and
 * `telemetry.*`.
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  DiagnosticFilter,
  DiagnosticLevel,
  ComponentConfig,
  ToolCallEntry,
  ToolCallPhase,
  ToolCallPermission,
  AgentEntry,
  AgentDiagnosticState,
  TaskEntry,
  EventEntry,
  DomainStateEntry,
  RuntimeStateSnapshot,
  DomainHealthSummary,
  HealthDashboardData,
  ComponentResourceEntry,
  ComponentResourceSnapshot,
} from './types.js';
export { DEFAULT_BUFFER_LIMIT, DEFAULT_COMPONENT_CONFIG, applyFilter, appendBounded } from './types.js';

// ── Panel data providers ─────────────────────────────────────────────────────
export { DivergencePanel } from './panels/divergence.js';
export { PolicyPanel } from './panels/policy.js';
export type { PolicyPanelSnapshot } from './panels/policy.js';
export { SecurityPanel } from './panels/security.js';
export type { SecurityPanelSnapshot } from './panels/security.js';
