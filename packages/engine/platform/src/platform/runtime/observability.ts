// ── Diagnostics ──────────────────────────────────────────────────────────────
// This barrel uses ONLY named re-exports (no `export *`) so the public
// observability surface is a curated allowlist; sub-barrels contain symbols not
// intended for the public api.md. See bundle-budgets.README.md for context.
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
} from './diagnostics/index.js';
export {
  DEFAULT_BUFFER_LIMIT,
  DEFAULT_COMPONENT_CONFIG,
  applyFilter,
  appendBounded,
} from './diagnostics/index.js';
export {
  DivergencePanel,
  SecurityPanel,
} from './diagnostics/index.js';
export type { SecurityPanelSnapshot } from './diagnostics/index.js';

// ── Eval ─────────────────────────────────────────────────────────────────────
export type {
  EvalScenario,
  EvalRawResult,
  EvalResult,
  EvalSuiteResult,
  EvalScorecard,
  EvalBaseline,
  EvalGateResult,
  EvalDimension,
  EvalJudgmentAccuracy,
  DimensionScore,
  RegressionEntry,
  BaselineSuiteSummary,
  EvalRunnerOptions,
} from './eval/index.js';
export {
  EvalRunner,
  scoreScenario,
  formatScorecard,
  judgmentQualityScore,
  DIMENSION_FLOOR,
  BUILTIN_SUITES,
  ALL_SCENARIOS,
  captureBaseline,
  serialiseBaseline,
  deserialiseBaseline,
  writeBaseline,
  loadBaseline,
  formatBaselineComparison,
  formatSuiteResult,
  formatGateResult,
  runTaskSuite,
  formatTaskSuiteResult,
  createHeadlessRunExecutor,
} from './eval/index.js';
export type { TaskSuiteResult, HeadlessRunExecutorOptions } from './eval/index.js';

// ── Forensics ─────────────────────────────────────────────────────────────────
export type {
  FailureReport,
  FailureClass,
  PhaseTimingEntry,
  CausalChainEntry,
  ForensicsJumpLink,
  ForensicsBundle,
  ForensicsReplayEvidence,
  ForensicsEvidenceSummary,
  ReplaySnapshotInput,
} from './forensics/index.js';
export {
  classifyFailure,
  summariseFailure,
  ForensicsRegistry,
  DEFAULT_REGISTRY_LIMIT,
  ForensicsCollector,
} from './forensics/index.js';

// ── Idempotency ───────────────────────────────────────────────────────────────
export type {
  IdempotencyKeyContext,
  IdempotencyRecord,
  IdempotencyStoreConfig,
  IdempotencyStatus,
} from './idempotency/index.js';
export { IdempotencyStore } from './idempotency/index.js';

// ── Perf ─────────────────────────────────────────────────────────────────────
export type {
  PerfBudget,
  PerfMetric,
  BudgetViolation,
  PerfReport,
  PerfUnit,
  PerfSnapshot,
} from './perf/index.js';
export {
  DEFAULT_BUDGETS,
  PerfMonitor,
  formatReport,
  exitCode,
  SloCollector,
  SLO_METRICS,
} from './perf/index.js';
// DiagnosticsProviderConfig and DiagnosticPanelName are included via the diagnostics block above.
export {
  RuntimeHealthAggregator,
} from './health/aggregator.js';
export { CascadeEngine } from './health/cascade-engine.js';
export { CASCADE_RULES } from './health/cascade-rules.js';
export {
  ALL_CASCADE_RULE_IDS,
  CASCADE_PLAYBOOK_MAP,
  CascadeTimer,
  createCascadeAppliedEvent,
  createHealthSystem,
  deriveCascadeSeverity,
} from './health/index.js';
export type {
  HealthStatus,
  HealthDomain as RuntimeHealthDomain,
  DomainHealth,
  CompositeHealth,
  CascadeRule,
  CascadeEffect,
  CascadeResult,
  EvaluateResult,
  CascadeAppliedEvent,
} from './health/types.js';
export {
  TelemetryApiService,
  attachComposedInstrumentation,
  installComposedTelemetry,
  releaseComposedTelemetry,
} from './telemetry/index.js';
export type {
  LedgerEntry,
} from './telemetry/exporters/local-ledger.js';
export { getSecuritySettingsReport } from './security-settings.js';
export type { SecuritySettingReport, SecuritySettingsReader } from './security-settings.js';

// ── Runtime metrics ────────────────────────────────────────────────────────
// The process-wide RuntimeMeter snapshot (HTTP/LLM/auth/transport counters,
// gauges, histograms) plus per-model tool-format telemetry, see metrics.ts
// and telemetry/tool-format-telemetry.ts. Reachable on the wire via the
// `runtime.metrics.get` operator method; exported here for a consumer that
// wants the same accessor and its typed shape directly.
export { snapshotMetrics, measureLlmRoute } from './metrics.js';
export type { RuntimeMetricsSnapshot, RuntimeMetricsBucket, LlmRouteMeasurement } from './metrics.js';
export type { ToolFormatFailureClass } from './telemetry/tool-format-telemetry.js';
export type { ComponentConfig as PanelConfig } from './diagnostics/types.js';
export { DEFAULT_COMPONENT_CONFIG as DEFAULT_PANEL_CONFIG } from './diagnostics/types.js';

// ── Runtime health ─────────────────────────────────────────────────────────
// A surface composing its own runtime graph builds the same per-domain health
// the platform graph carries: the aggregator, kept current from the event bus.
export { createWiredHealthSystem } from './health/index.js';
export { bindHealthDomainEvents } from './health/domain-events.js';
