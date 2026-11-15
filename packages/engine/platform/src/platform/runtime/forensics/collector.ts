/**
 * ForensicsCollector, subscribes to the RuntimeEventBus and automatically
 * generates FailureReport objects when tasks or turns reach terminal failure
 * states.
 *
 * Integration points:
 * - 'tasks' domain: TASK_FAILED, TASK_CANCELLED
 * - 'turn' domain: TURN_ERROR, TURN_CANCEL
 * - 'tools' domain: tool calls (bracketing the tool phase), failures and
 *   permission denials (TOOL_PERMISSIONED with approved false)
 * - Health cascade events (CASCADE_APPLIED) on the session domain, attributed
 *   only to a turn that called the failed MCP server
 *
 * A turn's phases are named for what happens in them: PREFLIGHT (local checks
 * before the model call), MODEL_REQUEST (waiting for the model to start),
 * STREAM (the model replying), AFTER_STREAM (local work after the reply),
 * TOOLS (from the first tool call received until none is in flight) and
 * AFTER_TOOLS. A task has CREATED and RUNNING. Which phase was unusually long
 * is decided in code (slow-phases.ts); no model is asked.
 *
 * Reports are pushed to the ForensicsRegistry and a FORENSICS_REPORT_CREATED
 * event is emitted so the panel can refresh.
 */
import { randomUUID } from 'node:crypto';
import { OwnedJudgmentWork } from '../owned-judgment-work.js';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../events/index.js';
import type { AnyRuntimeEvent } from '../../../events/domain-map.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type {
  FailureClass,
  FailureReport,
  PhaseTimingEntry,
  PhaseLedgerEntry,
  PhaseLedgerOutcome,
  CausalChainEntry,
  ForensicsJumpLink,
  PermissionEvidenceEntry,
  BudgetBreachEvidence,
} from './types.js';
import { classifyFailure, summariseFailure } from './classifier.js';
import { slowPhases } from './slow-phases.js';
import { isClassicOperation, withConfiguredDecisionModelPolicy } from '../decision-policy.js';
import type { ForensicsRegistry } from './registry.js';
import { emitForensicsReportCreated } from '../emitters/forensics.js';
import { redactAtRestLine } from '../at-rest-persistence.js';

/** Maximum orphaned trackers retained before evicting oldest entries. */
const MAX_TRACKER_SIZE = 500;

/**
 * Error text from events is stored in reports and bundles, so credential-shaped
 * spans are masked on the way in; a provider error can echo the key it was sent.
 */
function scrub(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try { return redactAtRestLine(text); } catch { return '[REDACTED]'; }
}

/** Mutable state accumulated while a turn is in flight. */
interface TurnTracker {
  readonly turnId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly startedAt: number;
  /** Phase timings accumulated as turn events arrive. */
  readonly phaseTimings: PhaseTimingEntry[];
  /** Explicit ordered phase transition ledger. */
  readonly phaseLedger: PhaseLedgerEntry[];
  /** Causal chain entries (tool failures, permission denials, cascade). */
  readonly causalChain: CausalChainEntry[];
  /** Cascade events observed for this turn. */
  readonly cascadeEvents: CausalChainEntry[];
  /** Permission evidence correlated through tool call ids. */
  readonly permissionEvidence: PermissionEvidenceEntry[];
  /** Budget/timeout breaches observed during tool execution. */
  readonly budgetBreaches: BudgetBreachEvidence[];
  hasToolFailure: boolean;
  hasPermissionDenial: boolean;
  hasCascadeEvents: boolean;
  hasCompactionError: boolean;
  lastPhaseStart?: number | undefined;
  currentPhase?: string | undefined;
  currentPhaseEnterEventType?: string | undefined;
  /** Tool calls received and not yet finished; the TOOLS phase lasts while any is. */
  readonly toolCallsInFlight: Set<string>;
  /** MCP servers this turn called (from `mcp:<server>:<tool>` names). */
  readonly mcpServers: Set<string>;
  _causalSeq: number;
  _phaseSeq: number;
}

/** Mutable state accumulated while a task is in flight. */
interface TaskTracker {
  readonly taskId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly startedAt: number;
  readonly phaseTimings: PhaseTimingEntry[];
  readonly phaseLedger: PhaseLedgerEntry[];
  readonly causalChain: CausalChainEntry[];
  readonly cascadeEvents: CausalChainEntry[];
  readonly permissionEvidence: PermissionEvidenceEntry[];
  readonly budgetBreaches: BudgetBreachEvidence[];
  agentId?: string | undefined;
  hasToolFailure: boolean;
  hasPermissionDenial: boolean;
  hasCascadeEvents: boolean;
  hasCompactionError: boolean;
  currentPhase?: string | undefined;
  lastPhaseStart?: number | undefined;
  currentPhaseEnterEventType?: string | undefined;
  _causalSeq: number;
  _phaseSeq: number;
}

/** The MCP server of a qualified MCP tool name (`mcp:<server>:<tool>`), if it is one. */
function mcpServerOf(tool: string | undefined): string | undefined {
  if (!tool?.startsWith('mcp:')) return undefined;
  const server = tool.slice(4).split(':')[0];
  return server ? server : undefined;
}

// ── ForensicsCollector ─────────────────────────────────────────────────────

export class ForensicsCollector {
  private readonly _bus: RuntimeEventBus;
  private readonly _registry: ForensicsRegistry;
  private readonly _lifetime = new AbortController();
  private readonly _pending = new Set<Promise<void>>();
  private readonly _unsubs: Array<() => void> = [];

  /** Active turn trackers keyed by turnId. */
  private readonly _turns = new Map<string, TurnTracker>();
  /** Active task trackers keyed by taskId. */
  private readonly _tasks = new Map<string, TaskTracker>();
  /** Correlation map from tool call id to owning turn id. */
  private readonly _callToTurn = new Map<string, string>();

  public constructor(bus: RuntimeEventBus, registry: ForensicsRegistry) {
    this._bus = bus;
    this._registry = registry;
    this._start();
  }

  private _start(): void {
    // Subscribe to turn domain
    this._unsubs.push(
      this._bus.onDomain('turn', (env) => this._collect('turn', env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>, () => {
        this._handleTurnEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }))
    );
    // Subscribe to tasks domain
    this._unsubs.push(
      this._bus.onDomain('tasks', (env) => this._collect('tasks', env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>, () => {
        this._handleTaskEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }))
    );
    // Subscribe to tools domain for permission/failure context
    this._unsubs.push(
      this._bus.onDomain('tools', (env) => this._collect('tools', env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>, () => {
        this._handleToolEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }))
    );
    this._unsubs.push(
      this._bus.onDomain('gate', (env) => this._collect('gate', env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>, () => {
        this._handlePermissionEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }))
    );
    // Health cascades are emitted on the session domain.
    this._unsubs.push(
      this._bus.onDomain('session', (env) => this._collect('session', env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>, () => {
        this._handleCascadeEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }))
    );
    this._unsubs.push(
      this._bus.onDomain('compaction', (env) => this._collect('compaction', env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>, () => {
        this._handleCompactionEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }))
    );
  }

  /** Forget a turn's tracker and the tool calls that were mapped to it. */
  private _dropTurn(turnId: string): void {
    this._turns.delete(turnId);
    for (const [callId, owner] of this._callToTurn) {
      if (owner === turnId) this._callToTurn.delete(callId);
    }
  }

  private _collect(
    domain: string,
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
    handle: () => void,
  ): void {
    if (this._lifetime.signal.aborted) return;
    try {
      handle();
    } catch (error) {
      logger.warn('Forensics collector event collection failed', {
        domain,
        type: env.type,
        sessionId: env.sessionId,
        traceId: env.traceId,
        turnId: env.turnId,
        taskId: env.taskId,
        error: summarizeError(error),
      });
    }
  }

  // ── Turn handling ──────────────────────────────────────────────────────────

  private _handleTurnEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const raw = env.payload as { type: string; turnId?: string; reason?: string; error?: string; response?: string; content?: string; toolCalls?: unknown[]; accumulated?: string; prompt?: string; stopReason?: string };
    const payload = { ...raw, reason: scrub(raw.reason), error: scrub(raw.error) };
    const turnId = payload.turnId;
    if (!turnId) return;

    switch (payload.type) {
      case 'TURN_SUBMITTED': {
        // Evict oldest orphaned tracker if at cap
        if (this._turns.size >= MAX_TRACKER_SIZE) {
          const firstKey = this._turns.keys().next().value;
          if (firstKey !== undefined) {
            const evicted = this._turns.get(firstKey);
            this._dropTurn(firstKey);
            logger.warn('Forensics collector evicted active turn tracker', {
              turnId: firstKey,
              sessionId: evicted?.sessionId,
              traceId: evicted?.traceId,
              maxTrackerSize: MAX_TRACKER_SIZE,
            });
          }
        }
        this._turns.set(turnId, {
          turnId,
          sessionId: env.sessionId ?? '',
          traceId: env.traceId ?? '',
          startedAt: env.ts,
          phaseTimings: [],
          phaseLedger: [],
          causalChain: [],
          cascadeEvents: [],
          permissionEvidence: [],
          budgetBreaches: [],
          hasToolFailure: false,
          hasPermissionDenial: false,
          hasCascadeEvents: false,
          hasCompactionError: false,
          currentPhase: 'PREFLIGHT',
          lastPhaseStart: env.ts,
          currentPhaseEnterEventType: payload.type,
          toolCallsInFlight: new Set(),
          mcpServers: new Set(),
          _causalSeq: 0,
          _phaseSeq: 0,
        });
        break;
      }
      case 'PREFLIGHT_OK': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'MODEL_REQUEST', env.ts, payload.type);
        break;
      }
      case 'PREFLIGHT_FAIL': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'failed', payload.type, payload.reason);
        this._addCausal(t, env.ts, `Preflight failed: ${payload.reason ?? 'unknown reason'}`, payload.type, true);
        this._finalise_turn(t, payload.stopReason ?? payload.reason, payload.reason ?? 'Preflight failed', false);
        this._dropTurn(turnId);
        break;
      }
      case 'STREAM_START': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'STREAM', env.ts, payload.type);
        break;
      }
      case 'STREAM_END': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'AFTER_STREAM', env.ts, payload.type);
        break;
      }
      case 'TURN_COMPLETED': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'succeeded', payload.type);
        this._dropTurn(turnId);
        break;
      }
      case 'TURN_ERROR': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'failed', payload.type, payload.error);
        this._addCausal(t, env.ts, `Turn error: ${payload.error ?? 'unknown error'}`, payload.type, true);
        this._finalise_turn(t, payload.stopReason, payload.error, false);
        this._dropTurn(turnId);
        break;
      }
      case 'TURN_CANCEL': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'cancelled', payload.type, payload.reason);
        this._addCausal(t, env.ts, `Turn cancelled: ${payload.reason ?? 'no reason given'}`, payload.type, false);
        this._finalise_turn(t, payload.stopReason ?? payload.reason, payload.reason, true);
        this._dropTurn(turnId);
        break;
      }
    }
  }

  // ── Task handling ──────────────────────────────────────────────────────────

  private _handleTaskEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const raw = env.payload as { type: string; taskId?: string; agentId?: string; error?: string; reason?: string; description?: string; priority?: number; durationMs?: number; progress?: number; message?: string };
    const payload = { ...raw, reason: scrub(raw.reason), error: scrub(raw.error) };
    const taskId = payload.taskId;
    if (!taskId) return;

    switch (payload.type) {
      case 'TASK_CREATED': {
        // Evict oldest orphaned tracker if at cap
        if (this._tasks.size >= MAX_TRACKER_SIZE) {
          const firstKey = this._tasks.keys().next().value;
          if (firstKey !== undefined) {
            const evicted = this._tasks.get(firstKey);
            this._tasks.delete(firstKey);
            logger.warn('Forensics collector evicted active task tracker', {
              taskId: firstKey,
              sessionId: evicted?.sessionId,
              traceId: evicted?.traceId,
              maxTrackerSize: MAX_TRACKER_SIZE,
            });
          }
        }
        this._tasks.set(taskId, {
          taskId,
          sessionId: env.sessionId ?? '',
          traceId: env.traceId ?? '',
          startedAt: env.ts,
          phaseTimings: [],
          phaseLedger: [],
          causalChain: [],
          cascadeEvents: [],
          permissionEvidence: [],
          budgetBreaches: [],
          agentId: payload.agentId,
          hasToolFailure: false,
          hasPermissionDenial: false,
          hasCascadeEvents: false,
          hasCompactionError: false,
          currentPhase: 'CREATED',
          lastPhaseStart: env.ts,
          currentPhaseEnterEventType: payload.type,
          _causalSeq: 0,
          _phaseSeq: 0,
        });
        break;
      }
      case 'TASK_STARTED': {
        const task = this._tasks.get(taskId);
        if (task && payload.agentId) {
          (task as { agentId?: string }).agentId = payload.agentId;
        }
        if (task) {
          this._transitionPhase(task, 'task', 'RUNNING', env.ts, payload.type);
        }
        break;
      }
      case 'TASK_FAILED': {
        const task = this._tasks.get(taskId);
        if (!task) break;
        this._closePhase(task, 'task', env.ts, 'failed', payload.type, payload.error);
        this._addCausal(task, env.ts, `Task failed: ${payload.error ?? 'unknown error'}`, payload.type, true);
        this._finalise_task(task, payload.error, false);
        this._tasks.delete(taskId);
        break;
      }
      case 'TASK_CANCELLED': {
        const task = this._tasks.get(taskId);
        if (!task) break;
        this._closePhase(task, 'task', env.ts, 'cancelled', payload.type, payload.reason);
        this._addCausal(task, env.ts, `Task cancelled: ${payload.reason ?? 'no reason given'}`, payload.type, false);
        this._finalise_task(task, payload.reason, true);
        this._tasks.delete(taskId);
        break;
      }
      case 'TASK_COMPLETED': {
        const task = this._tasks.get(taskId);
        if (task) {
          this._closePhase(task, 'task', env.ts, 'succeeded', payload.type);
        }
        this._tasks.delete(taskId);
        break;
      }
    }
  }

  // ── Tool handling ──────────────────────────────────────────────────────────

  private _handleToolEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const raw = env.payload as {
      type: string;
      turnId?: string | undefined;
      callId?: string | undefined;
      tool?: string | undefined;
      error?: string | undefined;
      approved?: boolean | undefined;
      phase?: string | undefined;
      limitMs?: number | undefined;
      elapsedMs?: number | undefined;
      limitTokens?: number | undefined;
      usedTokens?: number | undefined;
      limitCostUsd?: number | undefined;
      usedCostUsd?: number | undefined;
    };
    const payload = { ...raw, error: scrub(raw.error) };

    // Only calls of a turn still being tracked are remembered, so a late event
    // cannot re-add a call after its turn ended.
    if (payload.callId && payload.turnId && this._turns.has(payload.turnId)) {
      this._callToTurn.set(payload.callId, payload.turnId);
    }

    const tracker = payload.turnId ? this._turns.get(payload.turnId) : undefined;
    switch (payload.type) {
      case 'TOOL_RECEIVED': {
        if (!tracker || !payload.callId) break;
        if (tracker.toolCallsInFlight.size === 0) this._transitionPhase(tracker, 'turn', 'TOOLS', env.ts, payload.type);
        tracker.toolCallsInFlight.add(payload.callId);
        const server = mcpServerOf(payload.tool);
        if (server) tracker.mcpServers.add(server);
        break;
      }
      case 'TOOL_FAILED': {
        if (tracker && payload.callId) this._endToolCall(tracker, payload.callId, env.ts, payload.type);
        if (!payload.turnId) break;
        const t = this._turns.get(payload.turnId);
        if (!t) break;
        t.hasToolFailure = true;
        this._addCausal(
          t, env.ts,
          `Tool "${payload.tool ?? 'unknown'}" failed: ${payload.error ?? 'unknown error'}`,
          payload.type,
          false,
          payload.tool ? { tool: payload.tool } : undefined,
        );
        if (payload.callId) this._callToTurn.delete(payload.callId);
        break;
      }
      case 'BUDGET_EXCEEDED_MS':
      case 'BUDGET_EXCEEDED_TOKENS':
      case 'BUDGET_EXCEEDED_COST': {
        if (!payload.turnId || !payload.callId) break;
        const t = this._turns.get(payload.turnId);
        if (!t) break;
        t.budgetBreaches.push({
          callId: payload.callId,
          tool: payload.tool ?? 'unknown',
          eventType: payload.type,
          phase: payload.phase ?? 'unknown',
          ts: env.ts,
          meta: {
            ...(payload.limitMs !== undefined ? { limitMs: payload.limitMs } : {}),
            ...(payload.elapsedMs !== undefined ? { elapsedMs: payload.elapsedMs } : {}),
            ...(payload.limitTokens !== undefined ? { limitTokens: payload.limitTokens } : {}),
            ...(payload.usedTokens !== undefined ? { usedTokens: payload.usedTokens } : {}),
            ...(payload.limitCostUsd !== undefined ? { limitCostUsd: payload.limitCostUsd } : {}),
            ...(payload.usedCostUsd !== undefined ? { usedCostUsd: payload.usedCostUsd } : {}),
          },
        });
        this._addCausal(
          t,
          env.ts,
          `Tool "${payload.tool ?? 'unknown'}" exceeded runtime budget (${payload.type}) during ${payload.phase ?? 'unknown phase'}`,
          payload.type,
          false,
          { tool: payload.tool ?? 'unknown', phase: payload.phase ?? 'unknown' },
        );
        break;
      }
      case 'TOOL_PERMISSIONED': {
        // If approved is explicitly false, record permission denial
        if (payload.approved === false && payload.turnId) {
          const t = this._turns.get(payload.turnId);
          if (!t) break;
          t.hasPermissionDenial = true;
          this._addCausal(
            t, env.ts,
            `Permission denied for tool "${payload.tool ?? 'unknown'}"`,
            payload.type,
            false,
            payload.tool ? { tool: payload.tool } : undefined,
          );
        }
        break;
      }
      case 'TOOL_SUCCEEDED':
      case 'TOOL_CANCELLED': {
        if (tracker && payload.callId) this._endToolCall(tracker, payload.callId, env.ts, payload.type);
        if (payload.callId) this._callToTurn.delete(payload.callId);
        break;
      }
    }
  }

  /** A tool call finished; when it was the last one in flight, the tool phase ends. */
  private _endToolCall(t: TurnTracker, callId: string, ts: number, eventType: string): void {
    if (!t.toolCallsInFlight.delete(callId)) return;
    if (t.toolCallsInFlight.size === 0) this._transitionPhase(t, 'turn', 'AFTER_TOOLS', ts, eventType);
  }

  private _handlePermissionEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const payload = env.payload as {
      type: string;
      callId?: string | undefined;
      tool?: string | undefined;
      approved?: boolean | undefined;
      source?: string | undefined;
      reasonCode?: string | undefined;
      classification?: string | undefined;
      riskLevel?: string | undefined;
      summary?: string | undefined;
    };
    const callId = payload.callId;
    if (!callId) return;
    const turnId = this._callToTurn.get(callId);
    if (!turnId) return;
    const tracker = this._turns.get(turnId);
    if (!tracker) return;

    if (payload.type === 'GATE_REQUESTED') {
      tracker.permissionEvidence.push({
        callId,
        tool: payload.tool ?? 'unknown',
        requestedAt: env.ts,
        classification: payload.classification,
        riskLevel: payload.riskLevel,
        summary: payload.summary,
      });
      return;
    }

    if (payload.type === 'DECISION_EMITTED') {
      const existing = tracker.permissionEvidence.find((entry) => entry.callId === callId);
      if (existing) {
        const idx = tracker.permissionEvidence.indexOf(existing);
        tracker.permissionEvidence[idx] = {
          ...existing,
          tool: payload.tool ?? existing.tool,
          decidedAt: env.ts,
          durationMs: existing.requestedAt !== undefined ? env.ts - existing.requestedAt : undefined,
          approved: payload.approved,
          source: payload.source,
          reasonCode: payload.reasonCode,
          classification: payload.classification ?? existing.classification,
          riskLevel: payload.riskLevel ?? existing.riskLevel,
          summary: payload.summary ?? existing.summary,
        };
      } else {
        tracker.permissionEvidence.push({
          callId,
          tool: payload.tool ?? 'unknown',
          decidedAt: env.ts,
          approved: payload.approved,
          source: payload.source,
          reasonCode: payload.reasonCode,
          classification: payload.classification,
          riskLevel: payload.riskLevel,
          summary: payload.summary,
        });
      }
    }
  }

  // ── Cascade handling ───────────────────────────────────────────────────────

  /**
   * A cascade is attributed only to work that depends on the failed entity: a
   * turn that called a tool of the MCP server the cascade reports as failed.
   * Other failures (a compaction, a tool, a permission) are recorded from their
   * own events, so unrelated work in the same session is never blamed on a cascade.
   */
  private _handleCascadeEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const payload = env.payload as { type: string; ruleId?: string; source?: string; target?: string; sourceContext?: Record<string, string> };
    if (payload.type !== 'CASCADE_APPLIED' || payload.source !== 'mcp') return;
    const server = payload.sourceContext?.['serverId'];
    if (!server) return;
    const description = `Health cascade ${payload.ruleId ?? 'unknown rule'}: MCP server ${server} failed while this turn was using it`;
    for (const t of this._turns.values()) {
      if (!t.mcpServers.has(server)) continue;
      t.hasCascadeEvents = true;
      t.cascadeEvents.push(this._addCausal(t, env.ts, description, payload.type, false, { server }));
    }
  }

  // ── Compaction handling ────────────────────────────────────────────────────

  private _handleCompactionEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const raw = env.payload as { type: string; turnId?: string; error?: string };
    const payload = { ...raw, error: scrub(raw.error) };
    if (payload.type !== 'COMPACTION_FAILED') return;

    // Mark all active turns as having a compaction error
    for (const t of this._turns.values()) {
      if (t.sessionId === env.sessionId) {
        t.hasCompactionError = true;
        this._addCausal(t, env.ts, `Compaction failed: ${payload.error ?? 'unknown error'}`, payload.type, false);
      }
    }
  }

  // ── Report finalisation ───────────────────────────────────────────────────

  private _finalise_turn(
    tracker: TurnTracker,
    stopReason: string | undefined,
    errorMessage: string | undefined,
    wasCancelled: boolean,
  ): void {
    this._trackReport((work) => this._reportTurn(tracker, stopReason, errorMessage, wasCancelled, work),
      tracker, { turnId: tracker.turnId });
  }

  private async _reportTurn(
    tracker: TurnTracker,
    stopReason: string | undefined,
    errorMessage: string | undefined,
    wasCancelled: boolean,
    work: OwnedJudgmentWork,
  ): Promise<void> {
    work.assertCurrent();
    const classification = await this._classify({
      stopReason,
      errorMessage,
      wasCancelled,
      hasCascadeEvents: tracker.hasCascadeEvents,
      hasToolFailure: tracker.hasToolFailure,
      hasPermissionDenial: tracker.hasPermissionDenial,
      hasCompactionError: tracker.hasCompactionError,
    }, tracker, { turnId: tracker.turnId }, work);
    work.assertCurrent();

    const summary = summariseFailure(classification, errorMessage, stopReason);

    const jumpLinks: ForensicsJumpLink[] = [
      { label: 'Open tool inspector', kind: 'panel', target: 'tools' },
      { label: 'Open health dashboard', kind: 'panel', target: 'provider-health' },
    ];

    const reportId = this._shortId(tracker.traceId);

    const report: FailureReport = {
      id: reportId,
      traceId: tracker.traceId,
      sessionId: tracker.sessionId,
      generatedAt: Date.now(),
      classification,
      summary,
      stopReason,
      errorMessage,
      turnId: tracker.turnId,
      phaseTimings: tracker.phaseTimings,
      ...this._assessSlowPhases('turn', tracker.phaseTimings, wasCancelled),
      phaseLedger: tracker.phaseLedger,
      causalChain: tracker.causalChain,
      cascadeEvents: tracker.cascadeEvents,
      permissionEvidence: tracker.permissionEvidence,
      budgetBreaches: tracker.budgetBreaches,
      jumpLinks,
    };

    this._publishReport(report, { turnId: tracker.turnId }, work);
  }

  private _finalise_task(
    tracker: TaskTracker,
    errorMessage: string | undefined,
    wasCancelled: boolean,
  ): void {
    this._trackReport((work) => this._reportTask(tracker, errorMessage, wasCancelled, work),
      tracker, { taskId: tracker.taskId });
  }

  private async _reportTask(
    tracker: TaskTracker,
    errorMessage: string | undefined,
    wasCancelled: boolean,
    work: OwnedJudgmentWork,
  ): Promise<void> {
    work.assertCurrent();
    const classification = await this._classify({
      errorMessage,
      wasCancelled,
      hasCascadeEvents: tracker.hasCascadeEvents,
      hasToolFailure: tracker.hasToolFailure,
      hasPermissionDenial: tracker.hasPermissionDenial,
      hasCompactionError: tracker.hasCompactionError,
    }, tracker, { taskId: tracker.taskId }, work);
    work.assertCurrent();

    const summary = summariseFailure(classification, errorMessage);

    const jumpLinks: ForensicsJumpLink[] = [
      { label: 'View in ops-control', kind: 'panel', target: 'ops-control' },
      { label: 'Open health dashboard', kind: 'panel', target: 'provider-health' },
    ];

    const reportId = this._shortId(tracker.traceId);

    const report: FailureReport = {
      id: reportId,
      traceId: tracker.traceId,
      sessionId: tracker.sessionId,
      generatedAt: Date.now(),
      classification,
      summary,
      errorMessage,
      taskId: tracker.taskId,
      agentId: tracker.agentId,
      phaseTimings: tracker.phaseTimings,
      ...this._assessSlowPhases('task', tracker.phaseTimings, wasCancelled),
      phaseLedger: tracker.phaseLedger,
      causalChain: tracker.causalChain,
      cascadeEvents: tracker.cascadeEvents,
      permissionEvidence: tracker.permissionEvidence,
      budgetBreaches: tracker.budgetBreaches,
      jumpLinks,
    };

    this._publishReport(report, { taskId: tracker.taskId }, work);
  }

  /** Which phases ran unusually long, decided from the phase table; a cancellation is not assessed. */
  private _assessSlowPhases(domain: 'turn' | 'task', timings: readonly PhaseTimingEntry[], wasCancelled: boolean) {
    const assessed = !wasCancelled && timings.some((timing) => timing.durationMs !== undefined);
    return {
      slowPhases: assessed ? slowPhases(domain, timings) : [],
      slowPhaseAssessment: assessed ? 'table' as const : 'not-needed' as const,
      ...(isClassicOperation() ? { operationProvenance: 'classic' as const } : {}),
    };
  }

  /**
   * The failure class. When the error-message reading cannot be had (the
   * decision model is down, which is often why the turn failed), the report is
   * still published, classified `unknown`, with everything else collected in code.
   */
  private async _classify(
    input: Parameters<typeof classifyFailure>[0],
    tracker: { sessionId: string; traceId: string },
    context: { turnId?: string; taskId?: string },
    work: OwnedJudgmentWork,
  ): Promise<FailureClass> {
    try {
      return await classifyFailure(input, work.options('runtime.forensics.classifier'));
    } catch (error) {
      if (!work.current) throw error;
      this._logUnclassified(error, tracker, context);
      return 'unknown';
    }
  }

  private _trackReport(
    report: (work: OwnedJudgmentWork) => Promise<void>,
    tracker: { sessionId: string; traceId: string },
    context: { turnId?: string; taskId?: string },
  ): void {
    if (this._lifetime.signal.aborted) return;
    const work = new OwnedJudgmentWork({ signal: this._lifetime.signal });
    const pending = withConfiguredDecisionModelPolicy(() => work.wait(() => report(work))).catch((error: unknown) => {
      if (work.current) this._logUnclassified(error, tracker, context);
    }).finally(() => { this._pending.delete(pending); work.retire(); });
    this._pending.add(pending);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _transitionPhase(
    t: TurnTracker | TaskTracker,
    domain: 'turn' | 'task',
    nextPhase: string,
    ts: number,
    eventType: string,
  ): void {
    this._closePhase(t, domain, ts, 'succeeded', eventType);
    (t as { currentPhase?: string }).currentPhase = nextPhase;
    (t as { lastPhaseStart?: number }).lastPhaseStart = ts;
    (t as { currentPhaseEnterEventType?: string }).currentPhaseEnterEventType = eventType;
  }

  private _closePhase(
    t: TurnTracker | TaskTracker,
    domain: 'turn' | 'task',
    ts: number,
    outcome: Extract<PhaseLedgerOutcome, 'succeeded' | 'failed' | 'cancelled'>,
    eventType: string,
    error?: string,
  ): void {
    if (!t.currentPhase || t.lastPhaseStart === undefined) return;
    t.phaseTimings.push({
      phase: t.currentPhase,
      startedAt: t.lastPhaseStart,
      endedAt: ts,
      durationMs: ts - t.lastPhaseStart,
      success: outcome === 'succeeded',
      error,
    });
    t.phaseLedger.push({
      seq: ++t._phaseSeq,
      domain,
      phase: t.currentPhase,
      enterEventType: t.currentPhaseEnterEventType ?? 'unknown',
      enteredAt: t.lastPhaseStart,
      exitEventType: eventType,
      exitedAt: ts,
      durationMs: ts - t.lastPhaseStart,
      outcome,
      error,
    });
  }

  private _addCausal(
    t: TurnTracker | TaskTracker,
    ts: number,
    description: string,
    sourceEventType: string,
    isRootCause: boolean,
    context?: Record<string, string | number | boolean>,
  ): CausalChainEntry {
    const entry: CausalChainEntry = {
      seq: ++t._causalSeq,
      ts,
      description,
      sourceEventType,
      isRootCause,
      context,
    };
    t.causalChain.push(entry);
    return entry;
  }

  /** A failure whose error message could not be read is reported as `unknown`; what went wrong with the reading is logged. */
  private _logUnclassified(error: unknown, t: { sessionId: string; traceId: string }, context: { turnId?: string; taskId?: string }): void {
    logger.warn('Forensics collector could not read a failure message; reporting it as unknown', { sessionId: t.sessionId, traceId: t.traceId, ...context, error: summarizeError(error) });
  }

  private _publishReport(
    built: FailureReport,
    context: { turnId?: string | undefined; taskId?: string | undefined },
    work: OwnedJudgmentWork,
  ): void {
    work.assertCurrent();
    // Several failures can share one trace; each report needs its own id so a
    // lookup by id never resolves to a different failure.
    let id = built.id;
    for (let n = 2; this._registry.getById(id); n++) id = `${built.id}-${n}`;
    const report: FailureReport = id === built.id ? built : { ...built, id };
    try {
      this._registry.push(report);
    } catch (error) {
      if (!work.current) return;
      logger.warn('Forensics collector failed to store report', {
        reportId: report.id,
        classification: report.classification,
        sessionId: report.sessionId,
        traceId: report.traceId,
        ...context,
        error: summarizeError(error),
      });
      return;
    }

    work.assertCurrent();
    try {
      emitForensicsReportCreated(
        this._bus,
        { sessionId: report.sessionId, traceId: report.traceId, source: 'ForensicsCollector' },
        {
          reportId: report.id,
          classification: report.classification,
          errorMessage: report.errorMessage,
          ...context,
        },
      );
    } catch (error) {
      if (!work.current) return;
      logger.warn('Forensics collector failed to emit report event', {
        reportId: report.id,
        classification: report.classification,
        sessionId: report.sessionId,
        traceId: report.traceId,
        ...context,
        error: summarizeError(error),
      });
    }
  }

  /** Derive a short human-readable report ID from a trace ID. */
  private _shortId(traceId: string): string {
    // Use the first 8 hex chars of the trace ID, fall back to a fresh UUID prefix
    const clean = traceId.replace(/-/g, '');
    return clean.length >= 8 ? clean.slice(0, 8) : randomUUID().replace(/-/g, '').slice(0, 8);
  }

  /** Dispose all event bus subscriptions. */
  public dispose(): void {
    if (this._lifetime.signal.aborted) return;
    this._lifetime.abort(new Error('Forensics collector is disposed'));
    for (const unsub of this._unsubs) {
      try {
        unsub();
      } catch (error) {
        logger.warn('Forensics collector unsubscribe failed', { error: summarizeError(error) });
      }
    }
    this._unsubs.length = 0;
    this._turns.clear();
    this._tasks.clear();
    this._callToTurn.clear();
  }
}
