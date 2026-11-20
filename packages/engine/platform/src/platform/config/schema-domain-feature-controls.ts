/**
 * schema-domain-feature-controls.ts, ConfigSetting entries for per-feature
 * enablement and mode keys that live in domains declared elsewhere
 * (schema-domain-core.ts / schema-domain-runtime.ts own the defaults; this
 * file only contributes the schema entries, keeping those files under their
 * line ceilings). Every platform capability is a first-class domain setting;
 * the runtime derives its internal gates from these keys (see
 * runtime/feature-flags/feature-settings.ts for the bindings).
 */
import type { ConfigSettingRow } from './schema-types.js';
import { intRange, numRange } from './schema-shared.js';

export const featureControlSettings: ConfigSettingRow[] = [
  {
    key: 'permissions.engine',
    type: 'enum',
    description:
      'Permission evaluator: baseline (default) or policy-engine (the redesigned layered model with granular tool-level, path-level, and parameter-level rules). Restart to apply. Default baseline until divergence evidence from the shadow simulation clears the gate.',
    enumValues: ['baseline', 'policy-engine'],
  },
  {
    key: 'permissions.simulation',
    type: 'boolean',
    description:
      'Run the candidate permission evaluator beside the active one, recording divergence without changing enforcement. Default on so divergence evidence accumulates before stricter enforcement is considered; it never blocks tool execution by itself. Restart to apply.',
  },
  {
    key: 'permissions.divergenceDashboard',
    type: 'boolean',
    description:
      'Aggregate permission-evaluator divergence by tool/prefix/mode, expose trend history in diagnostics, and block enforce-mode transitions while the divergence rate exceeds permissions.divergenceThreshold. Turn off to fall back to warn mode (no gate enforcement).',
  },
  {
    key: 'permissions.commandParser',
    type: 'enum',
    description:
      'Shell parse before an exec command runs: ast (default) parses the command into segments and refuses one in which a segment has nothing to run, naming it; a command the parser cannot read runs as the permission gate decided. flat skips the parse. The permission gate decides risk, including the catastrophic-command block, identically in both modes.',
    enumValues: ['ast', 'flat'],
  },
  {
    key: 'behavior.toolResultReconciliation',
    type: 'enum',
    description:
      'What happens to dangling tool-call state at turn end: reconcile (default, synthetic error results are injected and a reconciliation event emitted, preventing silent conversation corruption) or warn-only (log a warning without injecting results).',
    enumValues: ['reconcile', 'warn-only'],
  },
  {
    key: 'provider.localContextIngestion',
    type: 'boolean',
    description:
      'Ingest max_context_length from local/custom provider /v1/models endpoints so local models use the provider-reported context window for token budgeting and compaction thresholds. Turn off to use only explicitly configured or static limits.',
  },
  {
    key: 'planner.adaptive',
    type: 'boolean',
    description:
      'Reserved for choosing an execution strategy (single/cohort/background/remote) on every conversation turn. No turn reads a strategy yet, so this setting changes nothing today. The planner that /project-plan mode, override, explain and status work with is consulted when /workstream drafts a plan, whatever this setting says.',
  },
  {
    key: 'tools.outputSchemaFingerprints',
    type: 'boolean',
    description:
      'Append _meta.outputSchemaFingerprint (exact sorted result key names) and _meta.schemaShapeId to results from the find, analyze, and inspect tools, enabling schema drift detection. Default off.',
  },
  {
    key: 'telemetry.otelMode',
    type: 'enum',
    description:
      'OpenTelemetry instrumentation: off (default, no OTel SDK initialization; a daemon left at the default records spans in-process so its telemetry traces list answers, and setting off explicitly turns that off too), in-process (spans for LLM calls, turns, tool calls, agents, tasks, plugins, MCP servers, transport, permission checks, sessions, compaction and health cascades, recorded and exported in-process only; a turn span records the prompt length, not its text), or remote-export (additionally export spans as OTLP/HTTP JSON to the collector named by OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, or OTEL_EXPORTER_OTLP_ENDPOINT with /v1/traces appended). Switching away from off requires a restart; in-process <-> remote-export applies live.',
    enumValues: ['off', 'in-process', 'remote-export'],
  },
  {
    key: 'runtime.unifiedTasks',
    type: 'boolean',
    description:
      'The unified RuntimeTask interface used for task tracking across all subsystems (exec, agent, acp, scheduler, daemon, mcp, plugin, integration), including the /tasks command and operator interventions (cancel/pause/resume/retry). Restart to apply. Default on. Set false to turn the runtime task manager off.',
  },
  {
    key: 'runtime.pluginLifecycle',
    type: 'boolean',
    description:
      'Publishes each plugin\'s lifecycle (loading, loaded, active, error, unloading, disabled, with the reason) as plugin events: the runtime store\'s plugin view, automation triggers on plugin loaded or failed, and tracing read them. Read at each event, so a change applies at once. Off: plugins load, run and unload the same, and nothing is reported. Default on.',
  },
  {
    key: 'runtime.mcpLifecycle',
    type: 'boolean',
    description:
      'Reconnect an MCP server automatically when its connect fails or its process exits: exponential back-off from 1 s to 30 s, at most 5 attempts, then the server stays disconnected and a call to it says why and to run /mcp reload. Each server\'s state (connecting, connected, degraded, reconnecting, disconnected) shows in /mcp servers, the MCP workspace, the mcp tool and the health view. Read each time a server drops, so a change applies to the next drop. Default on. Off: a server that drops stays disconnected until /mcp reload.',
  },
  {
    key: 'runtime.toolBudget.enforced',
    type: 'boolean',
    description:
      'Enforce per-call budgets on tool execution: wall-clock, token, and cost limits (runtime.toolBudget.maxMs/maxTokens/maxCostUsd). The wall-clock limit stops a call when it is reached and tells the model what it was stopped by. A call that finishes anyway, or finishes over its token or cost limit (known only when the tool returns), is reported to the model as succeeded, with its output and a note naming the limit it went over; token and cost apply only to tools that report tokenCount or costUsd.',
  },
  {
    key: 'runtime.toolBudget.maxMs',
    type: 'number',
    description:
      'Wall-clock budget (ms) for one tool call when runtime.toolBudget.enforced is true: the call is stopped when it is reached. 0 = unlimited.',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'runtime.toolBudget.maxTokens',
    type: 'number',
    description:
      'Token budget for one tool call when runtime.toolBudget.enforced is true, checked when the tool returns against the tokenCount the result reports. 0 = unlimited.',
    ...intRange(0, 100_000_000),
  },
  {
    key: 'runtime.toolBudget.maxCostUsd',
    type: 'number',
    description:
      'Cost budget (USD) for one tool call when runtime.toolBudget.enforced is true, checked when the tool returns against the costUsd the result reports. 0 = unlimited.',
    ...numRange(0, 1_000_000),
  },
  {
    key: 'notifications.adaptiveSuppression',
    type: 'boolean',
    description:
      'Adaptive notification suppression: past notifications.burstThreshold notifications of one kind (same domain, level and title) in one collapse window, the rest are counted into that kind\'s notification-history entry without a toast. Critical, milestone, and alert notifications are always exempt. Turn off to let every one toast as its level and the print level allow. Read when the app starts.',
  },
  {
    key: 'notifications.burstThreshold',
    type: 'number',
    description:
      'How many notifications with the same domain, level and title toast within one collapse window while notifications.adaptiveSuppression is on; later ones in that window are counted into the same notification-history entry without a toast. The window follows the print level (behavior.hitlMode: 5 s quiet, 2 s balanced, 0.5 s operator) and runs from the first notification, so a steady trickle cannot keep one open. Critical, milestone and alert notifications never collapse. Read when the app starts.',
    ...intRange(1, 10_000),
  },
  {
    key: 'notifications.pushApproval',
    type: 'boolean',
    description:
      'Device-push fan-out for the approval class: a pending approval pushes to every paired push target. On by default, the toggle exists to silence the class, never as a prerequisite for it to work. Read live per event.',
  },
  {
    key: 'notifications.pushNeedsInput',
    type: 'boolean',
    description:
      'Device-push fan-out for the needs-input class: a fleet node blocked on the operator pushes to every paired push target (presence-suppressed when a surface is attached). On by default; the toggle only silences. Read live per event.',
  },
  {
    key: 'notifications.pushCompletion',
    type: 'boolean',
    description:
      'Device-push fan-out for the completion class: a tracked run reaching a terminal state (done/failed/killed) pushes to every paired push target. On by default with zero setup; the toggle only silences. Read live per event.',
  },
  {
    key: 'notifications.blockedEscalationGraceMs',
    type: 'number',
    description:
      'How long a fleet node blocked on the operator may wait for a HUMAN response before a device push is sent REGARDLESS of an attached surface. Presence (an open TUI, a heartbeat) suppresses only the immediate push, never this escalation, a process being attended is not a human answer. A real interaction that clears the block cancels the escalation. Read live when a block is first tracked.',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'notifications.blockedEscalationFollowUpMs',
    type: 'number',
    description:
      'Interval between the bounded follow-up reminders that fire after the first blocked-too-long escalation, while the block remains unanswered. Read live per reminder.',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'notifications.blockedEscalationMaxFollowUps',
    type: 'number',
    description:
      'Upper bound on follow-up reminders after the first blocked-too-long escalation (0 = escalate exactly once, no reminders). Keeps a long-unanswered block from becoming an unbounded stream of pushes.',
    ...intRange(0, 100),
  },
];
