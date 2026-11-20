/**
 * Internal registry of platform capabilities and their default dispositions.
 *
 * Every entry here is a first-class feature configured through its own domain
 * settings: `settings` is the key that turns it on, `tuningKeys` the keys that
 * tune it, and feature-settings.ts derives FEATURE_SETTINGS (what surfaces
 * consume) from them. Each defaultState is an owner-ruled default, recorded in
 * the 2026-07-11 rulings worksheet; a disabled entry is a chosen default on a
 * configurable feature, never unreachable capability.
 *
 * This module is implementation detail: no surface renders this registry as its own
 * category, consumers render FEATURE_SETTINGS (domain, option shapes,
 * descriptions) from feature-settings.ts.
 *
 * Ids follow the kebab-case naming convention used throughout the runtime.
 */
import type { ConfigKey } from '../../config/schema-types.js';
import type { FeatureFlag } from './types.js';
import { VOICE_FEATURE_FLAGS } from './flags-voice.js';
import { CHANNEL_SURFACE_FEATURE_FLAGS } from './flags-surfaces.js';

/** Gate ids other code checks by name: each is spelled once, here, and imported. */
export const CONTROL_PLANE_FEATURE_FLAG = 'control-plane-gateway';
export const ROUTE_BINDING_FEATURE_FLAG = 'route-binding';
export const DELIVERY_ENGINE_FEATURE_FLAG = 'delivery-engine';
export const SERVICE_MANAGEMENT_FEATURE_FLAG = 'service-management';

const PERMISSION_TOOL_KEYS: readonly ConfigKey[] = [
  'permissions.tools.read',
  'permissions.tools.write',
  'permissions.tools.edit',
  'permissions.tools.exec',
  'permissions.tools.find',
  'permissions.tools.fetch',
  'permissions.tools.analyze',
  'permissions.tools.inspect',
  'permissions.tools.agent',
  'permissions.tools.state',
  'permissions.tools.workflow',
  'permissions.tools.registry',
  'permissions.tools.delegate',
  'permissions.tools.mcp',
];

/**
 * The canonical list of platform capabilities across all implementation tiers,
 * one entry per feature with everything about it: adding a feature is adding
 * an entry. The manager initialises from this array at startup.
 */
export const FEATURE_FLAGS: FeatureFlag[] = [
  // ── Tier 2 ───────────────────────────────────────────────────────────────
  {
    id: 'permissions-policy-engine',
    name: 'Permissions Policy Engine',
    description:
      'Activates the redesigned permission model with granular tool-level and path-level rules.',
    defaultState: 'disabled',
    tier: 2,
    runtimeToggleable: false,
    settings: { key: 'permissions.engine', kind: 'enum', enabledValues: ['policy-engine'] },
    tuningKeys: ['permissions.mode', ...PERMISSION_TOOL_KEYS],
  },

  {
    id: 'permissions-simulation',
    name: 'Permissions Simulation Mode',
    description:
      'Enables the dual-evaluator simulation pipeline for the permissions policy engine. '
      + 'Tracks divergence between actual and candidate evaluators without '
      + 'changing enforcement behaviour until switched to enforce mode. '
      + 'On by default so divergence evidence accumulates before any stricter '
      + 'enforcement is considered; it never blocks tool execution by itself.',
    defaultState: 'enabled',
    tier: 2,
    runtimeToggleable: false,
    settings: { key: 'permissions.simulation', kind: 'boolean' },
  },

  // ── Tier 3 ───────────────────────────────────────────────────────────────
  {
    id: 'hitl-ux-modes',
    name: 'HITL UX Modes',
    description:
      'Enables the HITL UX mode system (quiet/balanced/operator) for notification verbosity '
      + 'control. When enabled, ModeManager applies the configured HITL preset to the '
      + 'notification router at startup and on mode change. '
      + 'Set behavior.hitlMode to off to keep the router on its baseline delivery policy '
      + 'and reject HITL mode changes.',
    defaultState: 'enabled',
    tier: 3,
    runtimeToggleable: true,
    settings: { key: 'behavior.hitlMode', kind: 'enum', enabledValues: ['quiet', 'balanced', 'operator'] },
    tuningKeys: ['behavior.hitlMode'],
  },

  {
    id: 'unified-runtime-task',
    name: 'Unified RuntimeTask',
    description:
      'The unified RuntimeTask interface used for task tracking across all subsystems, including the /tasks command and operator interventions. On by default; turn runtime.unifiedTasks off to disable it.',
    defaultState: 'enabled',
    tier: 3,
    runtimeToggleable: false,
    settings: { key: 'runtime.unifiedTasks', kind: 'boolean' },
  },

  {
    id: 'watcher-triggers',
    name: 'Trigger Family',
    description:
      'Enables three unattended watcher kinds over one supervision spine: stream watchers that regex-filter and batch a long-lived command\'s output; model-free condition checks running a declarative probe/extract/rule pipeline with no LLM in the loop; and one-shot on-exit triggers where GoodVibes launches a command and fires exactly one payload when it terminates (daemon-owned, so a six-hour build does not hold an agent turn open). A firing trigger runs an agent turn or a pre-registered digest-pinned action grant, never a command composed at fire time. Off by default: a trigger launches and supervises real processes with nobody watching, so turning it on is a deliberate choice; with it on and no triggers defined the supervisor idles and consumes nothing. Tune the backoff ladder, strike breaker, retention bounds, batching and process caps via the watchers.triggers.* settings.',
    defaultState: 'disabled',
    tier: 3,
    runtimeToggleable: true,
    settings: { key: 'watchers.triggers.enabled', kind: 'boolean' },
    tuningKeys: [
      'watchers.triggers.enabled',
      'watchers.triggers.backoffLadderMs',
      'watchers.triggers.breakerStrikes',
      'watchers.triggers.defaultCheckIntervalMs',
      'watchers.triggers.probeTimeoutMs',
      'watchers.triggers.maxConcurrentChecks',
      'watchers.triggers.observationRingSize',
      'watchers.triggers.runHistoryLimit',
      'watchers.triggers.runHistoryTtlHours',
      'watchers.triggers.eventLogLimit',
      'watchers.triggers.eventLogTtlHours',
      'watchers.triggers.sweepIntervalMs',
      'watchers.triggers.supervisionTickMs',
      'watchers.triggers.streamQueueLimit',
      'watchers.triggers.streamBatchLines',
      'watchers.triggers.streamBatchIntervalMs',
      'watchers.triggers.onExitMaxDurationMs',
      'watchers.triggers.onExitStdin',
      'watchers.triggers.outputTailBytes',
    ],
  },

  // ── Tier 4 ───────────────────────────────────────────────────────────────
  {
    id: 'plugin-lifecycle',
    name: 'Plugin Lifecycle',
    description:
      'Publishes each plugin\'s lifecycle (loading, loaded, active, error, unloading, disabled, with the reason) as plugin events: the runtime store\'s plugin view, automation triggers on plugin loaded or failed, and tracing read them. Read at each event, so a change applies at once. Off: plugins load, run and unload the same, and nothing is reported.',
    defaultState: 'enabled',
    tier: 4,
    runtimeToggleable: true,
    settings: { key: 'runtime.pluginLifecycle', kind: 'boolean' },
  },
  {
    id: 'mcp-lifecycle',
    name: 'MCP Lifecycle',
    description:
      'Reconnects an MCP server that failed to connect or whose process exited, with exponential back-off (1 s doubling to 30 s, at most 5 attempts), '
      + 'and reports each server\'s connecting, connected, degraded, reconnecting and disconnected state to /mcp servers, the MCP workspace, '
      + 'the mcp tool and the health view. When the attempts run out the server stays disconnected and a call to it says why and to run /mcp reload. '
      + 'Read each time a server drops, so a change applies to the next drop. Off: a server that drops stays disconnected until /mcp reload.',
    defaultState: 'enabled',
    tier: 4,
    runtimeToggleable: true,
    settings: { key: 'runtime.mcpLifecycle', kind: 'boolean' },
  },
  {
    id: 'otel-foundation',
    name: 'OTel Foundation',
    description:
      'Enables the OpenTelemetry instrumentation foundation: platform init, span creation, and in-process export.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
    settings: { key: 'telemetry.otelMode', kind: 'enum', enabledValues: ['in-process', 'remote-export'] },
  },

  // ── Tier 5 ───────────────────────────────────────────────────────────────
  {
    id: 'otel-remote-export',
    name: 'OTel Remote Export',
    description:
      'Enables OTLP/HTTP JSON remote export of spans to a configured collector endpoint. Requires otel-foundation.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
    settings: { key: 'telemetry.otelMode', kind: 'enum', enabledValues: ['remote-export'] },
    tuningKeys: [
      'telemetry.decisionOtlpEnabled',
      'telemetry.decisionOtlpEndpoint',
      'telemetry.decisionOtlpSignal',
    ],
  },

  // ── Tier 7 ───────────────────────────────────────────────────────────────
  {
    id: 'tool-result-reconciliation',
    name: 'Tool Result Reconciliation',
    description:
      'Detects and reconciles unresolved tool calls at turn end. '
      + 'When enabled, dangling tool-call state causes synthetic error results '
      + 'to be injected and a reconciliation event to be emitted, preventing '
      + 'silent conversation corruption. Disable to keep warning-only logging '
      + 'without synthetic result injection.',
    defaultState: 'enabled',
    tier: 7,
    runtimeToggleable: true,
    settings: { key: 'behavior.toolResultReconciliation', kind: 'enum', enabledValues: ['reconcile'] },
  },

  // ── Tier 7 (continued) ──────────────────────────────────────────────────
  {
    id: 'policy-signing',
    name: 'Policy Signing',
    description:
      'Enables HMAC-SHA256 signature validation on policy bundle load. '
      + 'When enabled, a bundle that is unsigned, altered or signed with another key is refused, '
      + 'and so is every bundle when no signing key is set (GOODVIBES_POLICY_SIGNING_KEY, hex, at least 16 bytes).',
    defaultState: 'disabled',
    tier: 7,
    runtimeToggleable: false,
    settings: { key: 'policy.requireSignedBundles', kind: 'boolean' },
  },
  {
    id: 'session-compaction',
    name: 'Session Compaction',
    description:
      'Activates structured session compaction with semantic chunking and relevance scoring. '
      + 'On by default: long sessions compact at behavior.autoCompactThreshold with a receipt '
      + 'on every compaction. Set behavior.compactionStrategy to off to run uncompacted.',
    defaultState: 'enabled',
    tier: 6,
    runtimeToggleable: true,
    settings: { key: 'behavior.compactionStrategy', kind: 'enum', enabledValues: ['structured', 'distiller'] },
    tuningKeys: [
      'behavior.autoCompactThreshold',
      'behavior.compactionStrategy',
      'behavior.staleContextWarnings',
    ],
  },

  {
    id: 'compaction-distiller-strategy',
    name: 'Fresh-Context Distiller Compaction',
    description:
      'Enables the fresh-context DISTILLER compaction strategy as an alternative to '
      + 'the default in-place structured summarization. When on AND '
      + 'behavior.compactionStrategy is set to "distiller", one fresh model call distills '
      + 'the conversation into a structured continuation brief (task state, decisions, open '
      + 'threads, key file/symbol references) that seeds a fresh context, instead of '
      + 'assembling a handoff from many targeted extraction calls. The distillation is scored '
      + 'through the SAME quality scorer as the structured strategy and falls back to '
      + 'structured when it scores below the floor or the fresh call is unavailable, the '
      + 'receipt names the strategy used and any fallback. Standing instruction-chain / '
      + 'active-skill re-injection at the boundary applies to both strategies. Not the '
      + 'default: structured remains the default strategy until quality-score evidence '
      + 'earns distiller the default slot; choose it via behavior.compactionStrategy.',
    defaultState: 'disabled',
    tier: 6,
    runtimeToggleable: true,
    settings: { key: 'behavior.compactionStrategy', kind: 'enum', enabledValues: ['distiller'] },
    tuningKeys: ['behavior.compactionStrategy'],
  },

  {
    id: 'fetch-sanitization',
    name: 'Fetch Response Sanitization',
    description:
      'Enables fetch response sanitization and host trust tier classification.'
      + ' Sanitizes HTTP response content (none/safe-text/strict modes, default safe-text).'
      + ' Requests to cloud metadata endpoints and encoded private-IP forms are always refused'
      + ' with an honest tool-result reason; a private-network host a call writes is reached only'
      + ' when fetch.allowedPrivateHosts lists it or, written as an IP, in YOLO or an admitted call,'
      + ' and never by redirect. Fetches to localhost dev servers'
      + ' ask once; approving saves fetch.allowLocalhost in your own settings.'
      + ' Set fetch.sanitizeMode to none to skip content sanitization for trusted flows.',
    defaultState: 'enabled',
    tier: 8,
    runtimeToggleable: true,
    // Sanitization mode and localhost approval tune the fetch pipeline; host
    // blocking of private IPs and metadata endpoints is absolute, so the
    // capability itself has no off switch.
    settings: { key: 'fetch.sanitizeMode', kind: 'constant' },
    tuningKeys: ['fetch.sanitizeMode', 'fetch.trustedHosts', 'fetch.blockedHosts', 'fetch.allowLocalhost', 'fetch.allowedPrivateHosts'],
  },

  {
    id: 'runtime-tools-budget-enforcement',
    name: 'Runtime Budget Enforcement',
    description:
      'Applies the per-call limits in runtime.toolBudget.* to every tool call: a call is stopped '
      + 'when it reaches its wall-clock limit, and a call that returns over its token or cost limit '
      + 'is reported to the model as failed, output kept, with a note that its action may have taken effect.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
    settings: { key: 'runtime.toolBudget.enforced', kind: 'boolean' },
    tuningKeys: ['runtime.toolBudget.maxMs', 'runtime.toolBudget.maxTokens', 'runtime.toolBudget.maxCostUsd'],
  },

  {
    id: 'overflow-spill-backends',
    name: 'Overflow Spill Backends',
    description:
      'Enables the pluggable spill backend system for overflow content. '
      + 'When enabled, spillBackend can be set to file|ledger|diagnostics via config. '
      + 'When disabled, overflow content uses the file spill backend. '
      + 'The spill handler reads the gate and the backend once when the runtime starts, so a change takes effect after a restart.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: false,
    settings: { key: 'tools.overflowSpillBackend', kind: 'enum', enabledValues: ['ledger', 'diagnostics'] },
    tuningKeys: ['tools.overflowSpillBackend'],
  },

  {
    id: 'permission-divergence-dashboard',
    name: 'Divergence Dashboard and Enforce Gate',
    description:
      'Enables the divergence dashboard and enforcement gate for permissions simulation. '
      + 'Aggregates divergence by tool/prefix/mode, exposes trend history in diagnostics, '
      + 'and blocks enforce mode transitions when the divergence rate exceeds the configured '
      + 'threshold. Disable to fall back to warn mode (no gate enforcement).',
    defaultState: 'enabled',
    tier: 8,
    runtimeToggleable: true,
    settings: { key: 'permissions.divergenceDashboard', kind: 'boolean' },
    tuningKeys: ['permissions.divergenceThreshold', 'permissions.maxDivergenceRecords'],
  },

  {
    id: 'shell-ast-normalization',
    name: 'Shell AST Normalization',
    description:
      'Parses each exec command into segments just before it runs and refuses a '
      + 'command in which a segment (or the whole command) has nothing to run, '
      + 'naming that segment. It does not decide '
      + 'risk: the permission gate has already decided every command before this '
      + 'parse, with this flag on or off. When the parser cannot read the command '
      + '(a parse error), the command is allowed through to run as the gate decided. '
      + 'Disable to skip the parse entirely.',
    defaultState: 'enabled',
    tier: 8,
    runtimeToggleable: true,
    settings: { key: 'permissions.commandParser', kind: 'enum', enabledValues: ['ast'] },
  },

  {
    id: 'local-provider-context-ingestion',
    name: 'Local Provider Context Window Ingestion',
    description:
      'Enables dynamic ingestion of max_context_length from local/custom provider '
      + '/v1/models endpoints. When enabled, local models use the provider-reported '
      + 'context window (provenance: provider_api) for token budgeting and compaction '
      + 'thresholds instead of the statically-configured contextWindow value. '
      + 'Disable to revert to explicit configured or static limits (configured_cap / fallback).',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
    settings: { key: 'provider.localContextIngestion', kind: 'boolean' },
  },

  {
    id: 'agent-context-window-awareness',
    name: 'Agent Context Window Awareness',
    description:
      'Enables context window validation and compaction in the AgentOrchestrator. '
      + 'Before each provider.chat() call, estimates total token count (system prompt + '
      + 'messages + tool definitions) and compacts the conversation when usage exceeds '
      + '85% of the model context window. Also applies layered system prompt assembly '
      + '(drops conventions then project context for small windows) and catches '
      + '"context size exceeded" errors from the provider with a single compaction retry. '
      + 'Disable to revert to unchecked provider.chat() calls.',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
    settings: { key: 'agents.contextWindowGuard', kind: 'boolean' },
    tuningKeys: ['agents.contextCompactThreshold'],
  },

  {
    id: 'agent-passive-knowledge-injection',
    name: 'Agent Passive Knowledge Injection',
    description:
      'Enables per-turn re-retrieval of project-memory knowledge against the EVOLVING main-'
      + 'session conversation (steers, new sub-topics), not just the frozen spawn-time task. '
      + 'Re-runs retrieval only when a new user/steer message arrived this turn, applies a '
      + 'relevance floor to filter filler, and holds the injected block to a hard token '
      + 'budget (min ~800 tokens or 3% of the model context window) with a visible per-turn '
      + 'record (candidates considered, ids injected, ids dropped for budget, token cost, '
      + 'embeddings backend) stored on AgentRecord.turnInjections and the session transcript. '
      + 'Default-on is safe specifically because the block is hard-budgeted and every turn '
      + 'is honestly recorded, never silently eating context. Disable or set the budget to 0 '
      + 'to revert to spawn-time-only injection (base system prompt byte-identical).',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
    settings: { key: 'agents.passiveInjection.knowledge', kind: 'boolean' },
    tuningKeys: ['agents.passiveInjection.budgetTokens', 'agents.passiveInjection.relevanceFloor'],
  },

  {
    id: 'agent-passive-code-injection',
    name: 'Agent Passive Code Injection',
    description:
      'Enables per-turn passive retrieval from the repo SOURCE-TREE CODE INDEX (CodeIndexStore) '
      + 'alongside project-memory knowledge, sharing the SAME token budget and relevance floor. '
      + 'When the query would benefit and the index is built, similarity-ranked code chunks are '
      + 'injected as untrusted reference pointers, each recorded on the turn injection record with '
      + 'source=code-index and its honest match label (semantic/lexical). Never injects from an '
      + 'empty or provider-mismatched index, or from a hashed-only (no real semantic) provider, '
      + 'the store exposes each of those and the turn record states which. '
      + 'DEFAULT OFF (unlike agent-passive-knowledge-injection, which defaults on): code injection '
      + 'is a newer, higher-variance signal than reviewed project memory, code chunks carry no '
      + 'review/trust provenance and a weak similarity match can pull in a plausibly-worded but '
      + 'wrong chunk, so this first landing is opt-in, earned on by the same hard-budget + '
      + 'honest-record discipline before it becomes a default. Also respects the embedder\'s '
      + 'storage.codeIndexEnabled setting; disable either to revert to memory-only injection.',
    defaultState: 'disabled',
    tier: 9,
    runtimeToggleable: true,
    settings: { key: 'agents.passiveInjection.code', kind: 'boolean' },
    tuningKeys: [
      'agents.passiveInjection.codeLimit',
      'agents.passiveInjection.budgetTokens',
      'agents.passiveInjection.relevanceFloor',
    ],
  },

  {
    id: 'output-schema-fingerprint',
    name: 'Output Schema Fingerprints',
    description:
      'Appends `_meta.outputSchemaFingerprint` (exact sorted result key names) '
      + 'and `_meta.schemaShapeId` (canonical mode identifier) to tool results from '
      + 'the find, analyze, and inspect tools. Enables schema drift detection and '
      + 'diagnostic fingerprint surfaces. Disable to omit fingerprint metadata.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
    settings: { key: 'tools.outputSchemaFingerprints', kind: 'boolean' },
  },
  // ── Policy-as-Code ───────────────────────────────────────────────────────────
  {
    id: 'policy-as-code',
    name: 'Policy-as-Code',
    description:
      'Enables the versioned policy bundle registry with promote/rollback semantics. '
      + 'Before enforcement, /policy simulate shows the rule diff and the calls this installation recorded '
      + 'that the bundle would decide differently, and /policy promote --yes confirms them. '
      + 'Exposes /policy load, /policy simulate, /policy diff, /policy promote, '
      + 'and /policy rollback commands.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
    settings: { key: 'policy.registryEnabled', kind: 'boolean' },
    tuningKeys: ['policy.bundleSource', 'policy.bundlePath'],
  },

  // Adaptive Execution Planner.
  {
    id: 'adaptive-execution-planner',
    name: 'Adaptive Execution Planner',
    description:
      'Reserved for choosing an execution strategy (single/cohort/background/remote) '
      + 'on every conversation turn. No turn reads a strategy yet, so turning this on '
      + 'changes nothing today. /project-plan mode, override, explain and status work '
      + 'without it: they configure the planner /workstream drafting consults.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
    settings: { key: 'planner.adaptive', kind: 'boolean' },
  },
  // Provider Optimizer.
  {
    id: 'provider-optimizer',
    name: 'Provider Optimizer',
    description:
      'Enables the capability-contract-driven provider routing optimizer. '
      + 'In auto mode, selects the best capable provider for each request profile '
      + 'using ProviderCapabilityRegistry contracts. Supports manual, auto, and pinned '
      + 'routing modes with deterministic, fully-explainable route decisions. '
      + 'Exposes /provider route, /provider explain-route, /provider pin, and '
      + '/provider fallback test commands.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
    settings: { key: 'provider.optimizerMode', kind: 'enum', enabledValues: ['manual', 'auto', 'pinned'] },
    tuningKeys: ['provider.optimizerMode', 'provider.optimizerPinnedModel'],
  },

  // ── Integration Delivery SLO ────────────────────────────────────────────
  {
    id: 'integration-delivery-slo',
    name: 'Integration Delivery SLO',
    description:
      'Enforces delivery service-level objectives for the enabled channel surfaces '
      + '(Slack, Discord, webhooks): failures are classified as retryable or terminal, '
      + 'retried with exponential backoff, and dead-letter events are logged at error '
      + 'level and surfaced in integration diagnostics. Failed webhook notifications are listed '
      + 'with /notify failed and sent again with /notify resend <id|all>. Enabled by default alongside '
      + 'the channel family it belongs to; disable to keep warn-level logging without '
      + 'DLQ tracking.',
    defaultState: 'enabled',
    tier: 6,
    runtimeToggleable: true,
    settings: { key: 'integrations.delivery.sloEnforced', kind: 'boolean' },
    tuningKeys: [
      'integrations.delivery.maxRetries',
      'integrations.delivery.initialDelayMs',
      'integrations.delivery.maxDelayMs',
      'integrations.delivery.maxDlqSize',
      'integrations.delivery.sloEnforced',
    ],
  },
  // ── Adaptive Notification Suppression ──────────────────────────────────────
  {
    id: 'adaptive-notification-suppression',
    name: 'Adaptive Notification Suppression',
    description:
      'Holds repeats off the screen: past notifications.burstThreshold notifications '
      + 'of one kind (same domain, level and title) in one collapse window, the rest '
      + 'are counted into that kind\'s notification-history entry without a toast. '
      + 'Disable to let every one toast as its level and the print level allow.',
    defaultState: 'enabled',
    tier: 3,
    runtimeToggleable: true,
    settings: { key: 'notifications.adaptiveSuppression', kind: 'boolean' },
    tuningKeys: ['notifications.burstThreshold'],
  },

  // ── Token Scope and Rotation Audit ────────────────────────────────────────
  {
    id: 'token-scope-rotation-audit',
    name: 'Token Scope and Rotation Audit',
    description:
      'Enables minimum scope principle checks and rotation cadence audits for API tokens. '
      + 'In managed mode, tokens with excess scopes or overdue rotation are blocked from use. '
      + 'Diagnostics panel surfaces token age, scope violations, and rotation warnings. '
      + 'Emits TOKEN_SCOPE_VIOLATION, TOKEN_ROTATION_WARNING, TOKEN_ROTATION_EXPIRED, '
      + 'and TOKEN_BLOCKED events via the security event domain. '
      + 'On by default in advisory mode (security.tokenAudit.managed false): tokens are '
      + 'reported, never blocked, until managed enforcement is opted into.',
    defaultState: 'enabled',
    tier: 7,
    runtimeToggleable: true,
    settings: { key: 'security.tokenAudit.enabled', kind: 'boolean' },
    tuningKeys: [
      'security.tokenAudit.rotationCadenceDays',
      'security.tokenAudit.rotationWarningDays',
      'security.tokenAudit.managed',
    ],
  },

  // ── Automation and Omnichannel Foundation ───────────────────────────────
  {
    id: 'automation-domain',
    name: 'Automation Domain',
    description:
      'Enables the first-class automation job/run domain used by the shared scheduling engine. '
      + 'This is the top-level switch for durable automation records, schedule evaluation, and '
      + 'run history. On by default: with no routines defined it idles and surfaces a '
      + 'how-to-create-your-first-routine empty state instead of requiring setup.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'automation.enabled', kind: 'boolean' },
    tuningKeys: [
      'automation.enabled',
      'automation.maxConcurrentRuns',
      'automation.runHistoryLimit',
      'automation.defaultTimeoutMs',
      'automation.catchUpWindowMinutes',
      'automation.failureCooldownMs',
      'automation.deleteAfterRun',
    ],
  },
  {
    // NOTE: control-plane-gateway was the first tier-10 capability to default ON (One-Platform).
    // A stock daemon (no config) must be able to stream companion chat over SSE;
    // leaving this OFF made a fresh daemon return 503 on the live-stream path (the
    // "stock daemon is dead" bug).
    //
    // HONEST SURFACE STATEMENT: flipping this default ON DOES expose surface, just not
    // an UNAUTHENTICATED one. Concretely it turns on: (1) the auth-gated streaming surface
    //, SSE `/api/control-plane/events`, the companion-chat `.../events` stream, and the WS
    // control channel, every one of which returns 401 before any principal is resolved
    // (daemon-api/control-routes.ts), and per-channel scopes are enforced on the fan-out
    // (e.g. read:sessions on session-update); and (2) the inert pre-auth login shell, the
    // handful of unauthenticated bootstrap endpoints that carry NO session/runtime data and
    // exist only to establish auth. The default bind stays loopback and the 60/min + 5/min
    // rate limiters are unchanged. It remains runtimeToggleable, so an operator who wants a
    // request/response-only daemon can turn it back off via the controlPlane.gateway
    // setting, which is honoured over this default.
    // The channel family (route-binding, delivery-engine, the chat surfaces,
    // homeassistant-surface) graduated together once inbound channel messages became gated
    // by the per-surface owner allowlist (unknown senders ignored) with reply-based
    // approve/deny wired to the shared approval broker. web-surface, watcher-framework, and
    // service-management were later ruled on as defaults too (2026-07-11 rulings), so the
    // whole reachability tier now defaults on with the web surface bound to loopback.
    id: CONTROL_PLANE_FEATURE_FLAG,
    name: 'Control-Plane Gateway',
    description:
      'Enables the shared gateway/control-plane host that serves state snapshots, live streams, '
      + 'and authenticated automation control APIs to terminal hosts and remote clients.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'controlPlane.gateway', kind: 'boolean' },
    tuningKeys: [
      'controlPlane.enabled',
      'controlPlane.hostMode',
      'controlPlane.host',
      'controlPlane.port',
      'controlPlane.publicBaseUrl',
      'controlPlane.streamMode',
      'controlPlane.trustProxy',
      'controlPlane.openaiCompatible.enabled',
      'controlPlane.openaiCompatible.pathPrefix',
      'controlPlane.webui.serve',
      'controlPlane.webui.bundleDir',
      'controlPlane.cors.enabled',
      'controlPlane.cors.allowedOrigins',
      'controlPlane.tls.mode',
      'controlPlane.tls.certFile',
      'controlPlane.tls.keyFile',
    ],
  },
  {
    id: ROUTE_BINDING_FEATURE_FLAG,
    name: 'Route Binding',
    description:
      'Enables durable binding and resolution of external conversation routes, thread contexts, '
      + 'and reply targets across surfaces.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'integrations.routeBinding', kind: 'boolean' },
  },
  {
    id: DELIVERY_ENGINE_FEATURE_FLAG,
    name: 'Delivery Engine',
    description:
      'Enables first-class delivery tracking for automation results, retries, dead letters, and '
      + 'surface-specific delivery outcomes.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'integrations.deliveryTracking', kind: 'boolean' },
  },
  // The channel adapters live in flags-surfaces.ts.
  ...CHANNEL_SURFACE_FEATURE_FLAGS,
  {
    id: 'web-surface',
    name: 'Web Surface',
    description:
      'Enables the browser-based operator surface backed by the shared control plane. '
      + 'On by default, bound to loopback (web.hostMode local, 127.0.0.1): a stock install '
      + 'serves the web surface on this machine only and announces its URL once at start. '
      + 'Widen deliberately via web.hostMode network/custom.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'web.enabled', kind: 'boolean' },
    tuningKeys: [
      'web.enabled',
      'web.hostMode',
      'web.host',
      'web.port',
      'web.publicBaseUrl',
      'web.staticAssetsDir',
    ],
  },
  {
    id: 'watcher-framework',
    name: 'Watcher Framework',
    description:
      'Enables managed watcher/listener services, checkpointing, and recovery semantics for '
      + 'long-running external sources. On by default: with no watchers configured the '
      + 'framework idles and consumes nothing.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'watchers.enabled', kind: 'boolean' },
    tuningKeys: [
      'watchers.enabled',
      'watchers.pollIntervalMs',
      'watchers.heartbeatIntervalMs',
      'watchers.recoveryWindowMinutes',
    ],
  },
  {
    id: SERVICE_MANAGEMENT_FEATURE_FLAG,
    name: 'Service Management',
    description:
      'Enables install/start/stop/status/autostart management for running Goodvibes as a '
      + 'durable host service. On by default: the management verbs become available, but '
      + 'nothing is installed or started until explicitly requested (service.autostart '
      + 'stays false).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'service.enabled', kind: 'boolean' },
    tuningKeys: [
      'service.enabled',
      'service.autostart',
      'service.restartOnFailure',
      'service.platform',
      'service.serviceName',
      'service.logPath',
    ],
  },
  {
    id: 'daemon-auto-update',
    name: 'Daemon Auto-Update',
    description:
      'The daemon checks for a new release hourly, downloads and checksum-verifies it, swaps '
      + 'binaries at a no-active-work moment (never mid-turn), keeps the previous binary for '
      + 'one-command rollback, and restarts via the service manager. On by default per the '
      + 'owner directive; update.auto turns it off, update.intervalMinutes tunes the cadence.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'update.auto', kind: 'boolean' },
    tuningKeys: ['update.auto', 'update.intervalMinutes', 'update.releasesUrl'],
  },

  // ── Execution Isolation ────────────────────────────────────────────────────
  {
    id: 'exec-sandbox',
    name: 'Per-Command Exec Sandbox',
    description:
      'Enables the per-command OS-level exec boundary (bubblewrap on Linux): the workspace is '
      + 'writable, the rest of the filesystem read-only, /tmp isolated, and network disabled unless '
      + 'a command is on sandbox.egressAllowlist. When active, boundary-safe commands that would '
      + 'otherwise prompt can auto-allow, and commands needing host access (network, host-privilege '
      + 'escalation, package installs) surface as named escalation asks. The permission '
      + 'gate reads the catastrophic case before the call, inside the boundary as outside it. On by default where the '
      + 'host probe passes (Linux with bubblewrap available); the first auto-allow announces '
      + 'once that commands now run contained and escalations will ask. When bubblewrap is '
      + 'absent (or on non-Linux hosts) the feature reports honestly unavailable and the exec '
      + 'path is byte-for-byte unchanged. Set sandbox.enabled false to revert to unsandboxed exec.',
    defaultState: 'enabled',
    tier: 11,
    runtimeToggleable: true,
    settings: { key: 'sandbox.enabled', kind: 'boolean' },
    tuningKeys: ['sandbox.enabled', 'sandbox.mcpIsolation'],
  },
  {
    id: 'sandbox-model-judgment',
    name: 'Sandbox Model-Judgment Tier',
    description:
      'Enables an optional model-judgment pass on the residual sandbox ask-tail: when the '
      + 'per-command exec sandbox is active and a command still lands on ask (a boundary needing '
      + 'host access, network, host-privilege escalation), a provider call over the command, its '
      + 'sandbox plan, workspace context, and the policy reasons produces a PROPOSED verdict with '
      + 'stated reasons. The tier NEVER converts allow→deny and NEVER touches the frozen '
      + 'catastrophic-only exec block (rm -rf /, dd to devices, mkfs, fork bomb…); it can only '
      + 'ANNOTATE the human ask ("model judgment: looks safe because… / flags risk because…") or, '
      + 'ONLY when the operator opted into sandbox.judgment auto-approve, auto-approve a looks-safe '
      + 'verdict. A flags-risk verdict never auto-denies, it annotates the ask the human still '
      + 'decides; a judgment failure degrades to a plain ask. Every judgment leaves a receipt. '
      + 'On by default in annotate-only mode (sandbox.judgment annotate); auto-approval is a '
      + 'separate explicit opt-in (sandbox.judgment auto-approve).',
    defaultState: 'enabled',
    tier: 11,
    runtimeToggleable: true,
    settings: { key: 'sandbox.judgment', kind: 'enum', enabledValues: ['annotate', 'auto-approve'] },
    tuningKeys: ['sandbox.judgment'],
  },
  // ── Reachability ───────────────────────────────────────────────────────────
  {
    id: 'relay-connect',
    name: 'Outbound Zero-Knowledge Relay',
    description:
      'Lets the daemon connect OUTBOUND to a self-hostable, zero-knowledge relay and register under '
      + 'an unguessable rendezvous id so surfaces can reach it from outside the LAN. An end-to-end '
      + 'channel (ECDH P-256 → HKDF → AES-256-GCM) terminates INSIDE the daemon before any application '
      + 'byte, so the relay operator only ever sees ciphertext plus connection metadata; the daemon is '
      + 'authenticated to surfaces by static-key pinning from the pairing payload. Relay, channel, and '
      + 'OAuth credentials at rest are encrypted under the random secrets keyfile (never host-derived '
      + 'identity). No connection is made without explicit configuration: the relay.enabled config '
      + 'switch and a configured relay.url still gate every connection, leave either unset to keep '
      + 'the daemon LAN-only.',
    defaultState: 'enabled',
    tier: 11,
    runtimeToggleable: true,
    settings: { key: 'relay.enabled', kind: 'boolean' },
    tuningKeys: [
      'relay.enabled',
      'relay.url',
      'relay.rendezvousId',
      'relay.label',
      'relay.requireStepUpForMutations',
    ],
  },
  // ── Paired devices ─────────────────────────────────────────────────────────
  {
    id: 'paired-device-capabilities',
    name: 'Paired Phone Capabilities',
    description:
      'Lets the agent use a PAIRED phone as a tool: either camera, its screen, its location, its '
      + 'clipboard, and a small set of device commands (notification, link, buzz). It rides the '
      + 'existing peer transport as a native contract, never an MCP server, so a web app node and '
      + 'a native app node are the same kind of peer. Every capture and every effect asks the person '
      + 'first; choosing "always allow" on that prompt writes ONE durable grant for that one '
      + 'capability on that one phone, listed and revocable in the grants surface, with an age TTL '
      + 'and a count cap so nothing is granted forever. Pictures the phone takes are kept for 24 '
      + 'hours by default and then deleted, and every housekeeping sweep discloses exactly what it '
      + 'removed and why. Configure the whole posture through device.*, device.capabilities.mode '
      + 'chooses between off, ask-every-time, and honouring grants; device.capabilities.allowAlwaysOffer '
      + 'chooses which capabilities may be granted durably; device.capture.retentionHours sets how '
      + 'long a picture lives.',
    defaultState: 'enabled',
    tier: 11,
    runtimeToggleable: true,
    settings: { key: 'device.capabilities.mode', kind: 'enum', enabledValues: ['ask-every-time', 'honor-grants'] },
    tuningKeys: [
      'device.capabilities.mode',
      'device.capabilities.allowAlwaysOffer',
      'device.capabilities.requestTimeoutSeconds',
      'device.location.precision',
      'device.clipboard.readMode',
      'device.capture.retentionHours',
      'device.capture.maxArtifacts',
      'device.capture.sweepIntervalMinutes',
      'device.grants.expiryDays',
      'device.grants.maxPerNode',
      'device.grants.auditRetentionDays',
      'device.nodes.maxPaired',
    ],
  },

  // Voice capabilities live in flags-voice.ts.
  ...VOICE_FEATURE_FLAGS,
];

/**
 * Convenience map for O(1) lookups by flag id.
 * Built once at module load time.
 */
export const FEATURE_FLAG_MAP: ReadonlyMap<string, FeatureFlag> = new Map(
  FEATURE_FLAGS.map((f) => [f.id, f]),
);
