/**
 * Agents diagnostic panel data provider.
 *
 * Subscribes to agent lifecycle events via the RuntimeEventBus and maintains
 * a bounded buffer of AgentEntry records. Provides filtered snapshots
 * for the agents/cohorts diagnostics panel.
 *
 * Tracks state, ownership, blockers, and completion status for each agent.
 */
import type { RuntimeEventBus, EnvelopeListener } from '../../events/index.js';
import type { AnyRuntimeEvent } from '../../../../events/domain-map.js';
import type { RuntimeEventEnvelope } from '../../events/envelope.js';
import {
  type AgentEntry,
  type AgentDiagnosticState,
  type DiagnosticFilter,
  type ComponentConfig,
  DEFAULT_COMPONENT_CONFIG,
  applyFilter,
  appendBounded,
} from '../types.js';
import { summarizeError } from '../../../utils/error-display.js';
import { logger } from '../../../utils/logger.js';

/** Mutable agent record for in-progress agents. */
interface MutableAgentRecord {
  agentId: string;
  taskId?: string | undefined;
  task: string;
  state: AgentDiagnosticState;
  spawnedAt: number;
  completedAt?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  blockedOnCallId?: string | undefined;
  blockedOnTool?: string | undefined;
  traceId: string;
  sessionId: string;
}

/**
 * AgentsPanel, diagnostic data provider for agent lifecycle telemetry.
 *
 * Active agents are tracked in a live map; terminal agents are moved
 * to the history buffer for filtering and display.
 */
export class AgentsPanel {
  private readonly _config: ComponentConfig;
  private readonly _eventBus: RuntimeEventBus;
  /** Active agents keyed by agentId. */
  private readonly _active = new Map<string, MutableAgentRecord>();
  /** Completed agent history (oldest first). */
  private readonly _history: AgentEntry[] = [];
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Unsubscribe function from the event bus. */
  private _unsub: (() => void) | null = null;

  constructor(eventBus: RuntimeEventBus, config: ComponentConfig = DEFAULT_COMPONENT_CONFIG) {
    this._eventBus = eventBus;
    this._config = config;
    this._start();
  }

  private _start(): void {
    const handler: EnvelopeListener<AnyRuntimeEvent> = (
      envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
    ) => {
      this._handleEnvelope(envelope);
    };
    this._unsub = this._eventBus.onDomain('agents', handler as EnvelopeListener);
  }

  private _handleEnvelope(
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const p = envelope.payload;
    if (!('type' in p)) return;
    const type = (p as { type: string }).type;
    const traceId = envelope.traceId ?? '';
    const sessionId = envelope.sessionId ?? '';

    switch (type) {
      case 'AGENT_SPAWNING': {
        const evt = p as { type: 'AGENT_SPAWNING'; agentId: string; taskId?: string; task: string };
        this._active.set(evt.agentId, {
          agentId: evt.agentId,
          taskId: evt.taskId,
          task: evt.task,
          state: 'spawning',
          spawnedAt: envelope.ts,
          traceId,
          sessionId,
        });
        this._retireStaleActive();
        this._notify();
        break;
      }
      case 'AGENT_RUNNING': {
        const evt = p as { type: 'AGENT_RUNNING'; agentId: string; wake?: true };
        let record = this._active.get(evt.agentId);
        // A woken agent finished before and runs again: it belongs back in the
        // live set, not frozen in history with its old terminal state.
        if (!record && evt.wake === true) record = this._reviveFromHistory(evt.agentId);
        if (record) {
          record.state = 'running';
          record.blockedOnCallId = undefined;
          record.blockedOnTool = undefined;
          this._notify();
        }
        break;
      }
      case 'AGENT_AWAITING_MESSAGE': {
        const evt = p as { type: 'AGENT_AWAITING_MESSAGE'; agentId: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'awaiting_message';
          this._notify();
        }
        break;
      }
      case 'AGENT_AWAITING_TOOL': {
        const evt = p as { type: 'AGENT_AWAITING_TOOL'; agentId: string; callId: string; tool: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'awaiting_tool';
          record.blockedOnCallId = evt.callId;
          record.blockedOnTool = evt.tool;
          this._notify();
        }
        break;
      }
      case 'AGENT_FINALIZING': {
        const evt = p as { type: 'AGENT_FINALIZING'; agentId: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'finalizing';
          this._notify();
        }
        break;
      }
      case 'AGENT_COMPLETED': {
        const evt = p as { type: 'AGENT_COMPLETED'; agentId: string; durationMs: number };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'completed';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          this._finalize(record);
        }
        break;
      }
      case 'AGENT_FAILED': {
        const evt = p as { type: 'AGENT_FAILED'; agentId: string; error: string; durationMs: number };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'failed';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          record.error = evt.error;
          this._finalize(record);
        }
        break;
      }
      case 'AGENT_CANCELLED': {
        const evt = p as { type: 'AGENT_CANCELLED'; agentId: string; reason?: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'cancelled';
          record.completedAt = envelope.ts;
          record.error = evt.reason;
          this._finalize(record);
        }
        break;
      }
      default:
        break;
    }
  }

  private _reviveFromHistory(agentId: string): MutableAgentRecord | undefined {
    const index = this._history.findIndex((entry) => entry.agentId === agentId);
    if (index === -1) return undefined;
    const [entry] = this._history.splice(index, 1);
    const record: MutableAgentRecord = {
      agentId: entry!.agentId,
      taskId: entry!.taskId,
      task: entry!.task,
      state: 'running',
      spawnedAt: entry!.spawnedAt,
      traceId: entry!.traceId,
      sessionId: entry!.sessionId,
    };
    this._active.set(agentId, record);
    return record;
  }

  /**
   * Bound the live set. A record whose terminal event never arrived (the
   * emitter died, or the event was dropped) would otherwise stay "active"
   * forever and grow without limit; the oldest is retired into history in its
   * last known state with a note saying why.
   */
  private _retireStaleActive(): void {
    while (this._active.size > this._config.bufferLimit) {
      const oldest = this._active.values().next();
      if (oldest.done) return;
      const record = oldest.value;
      record.error = 'no terminal event was observed for this agent; it was retired from the live list';
      logger.warn('[AgentsPanel] retired an agent with no terminal event: too many are outstanding', { agentId: record.agentId, limit: this._config.bufferLimit });
      this._finalize(record);
    }
  }

  private _finalize(record: MutableAgentRecord): void {
    this._active.delete(record.agentId);
    // A finished agent is not waiting on a tool, whatever it was last blocked on.
    record.blockedOnCallId = undefined;
    record.blockedOnTool = undefined;
    const entry: AgentEntry = {
      agentId: record.agentId,
      taskId: record.taskId,
      task: record.task,
      state: record.state,
      spawnedAt: record.spawnedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      error: record.error,
      blockedOnCallId: record.blockedOnCallId,
      blockedOnTool: record.blockedOnTool,
      traceId: record.traceId,
      sessionId: record.sessionId,
    };
    appendBounded(this._history, entry, this._config.bufferLimit);
    this._notify();
  }

  /**
   * Return a filtered snapshot combining active agents and completed history.
   * Ordered most-recent first.
   *
   * @param filter - Optional filter to restrict entries.
   */
  public getSnapshot(filter?: DiagnosticFilter): AgentEntry[] {
    const activeEntries: AgentEntry[] = [];
    for (const record of this._active.values()) {
      activeEntries.push({
        agentId: record.agentId,
        taskId: record.taskId,
        task: record.task,
        state: record.state,
        spawnedAt: record.spawnedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        error: record.error,
        blockedOnCallId: record.blockedOnCallId,
        blockedOnTool: record.blockedOnTool,
        traceId: record.traceId,
        sessionId: record.sessionId,
      });
    }
    const combined: AgentEntry[] = [...this._history, ...activeEntries];
    return applyFilter(combined, filter, (e) => e.spawnedAt, this._config.bufferLimit);
  }

  /**
   * Register a callback invoked whenever the data changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release all event bus subscriptions and clear internal state.
   */
  public dispose(): void {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._subscribers.clear();
    this._active.clear();
    this._history.length = 0;
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (error) {
        logger.warn('[AgentsPanel] subscriber error', { error: summarizeError(error) });
      }
    }
  }
}
