/**
 * notification-dispatcher.ts, the one owner of which runtime events become an
 * outbound notification and what each one says.
 *
 * Every transport (the Slack and Discord notifier, the generic webhook
 * notifier, a host's own) attaches through {@link attachRuntimeNotifications}
 * and receives typed facts; the words come from `turn-notification.ts` and the
 * live privacy rule is applied by the envelope each transport builds. A new
 * event is added here once and reaches every transport.
 *
 * Events: an agent completed, failed or was cancelled; a workstream passed,
 * failed or was cancelled. Elapsed time is what the event states (agents), the
 * workstream record's own start when the host can look it up (so a workstream
 * started before a restart is still announced), or the time since this
 * dispatcher saw it start. One whose start is known nowhere is not announced,
 * rather than announced with a duration that was never measured.
 */
import type { NotificationDelivery, TurnNotificationFacts } from '../runtime/turn-notification.js';
import type { AgentEvent, RuntimeEventBus } from '../runtime/events/index.js';
import type { ContractEvent } from '../../events/contract.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The events the dispatcher turns into notifications. */
export const RUNTIME_NOTIFICATION_EVENTS = [
  'AGENT_COMPLETED', 'AGENT_FAILED', 'AGENT_CANCELLED',
  'CONTRACT_PASSED', 'CONTRACT_FAILED', 'CONTRACT_CANCELLED',
] as const;

export type RuntimeNotificationEvent = (typeof RUNTIME_NOTIFICATION_EVENTS)[number];

/** Where a notification goes: one transport's typed-delivery entry point. */
export type RuntimeNotificationSink = (delivery: NotificationDelivery, event: RuntimeNotificationEvent) => Promise<unknown>;

/** How many started agents and workstreams are remembered for naming and timing. */
const REMEMBERED_STARTS = 256;

function budgetReason(limit: number | undefined): string {
  return limit !== undefined
    ? `reached its turn budget of ${limit} turn${limit === 1 ? '' : 's'}`
    : 'reached its turn budget';
}

/** A workstream as its owner records it: when it started and what was asked. */
export interface RuntimeNotificationWork {
  readonly startedAt: number;
  readonly name: string;
}

export interface RuntimeNotificationOptions {
  /** Reads a workstream's own record (the contract runner's `get`); one in-memory lookup per ending. */
  readonly lookupContract?: ((contractId: string) => RuntimeNotificationWork | undefined) | undefined;
  readonly clock?: (() => number) | undefined;
}

/**
 * Subscribe `sink` to the runtime notification events on `bus`. Content
 * (names, reasons) is read through getters only when the envelope admits
 * content; the sink's own failure is logged once here and never thrown into
 * the bus. Returns the unsubscribe function.
 */
export function attachRuntimeNotifications(
  bus: Pick<RuntimeEventBus, 'on'>,
  sink: RuntimeNotificationSink,
  options: RuntimeNotificationOptions = {},
): () => void {
  const clock = options.clock ?? Date.now;
  let active = true;
  const starts = new Map<string, { readonly started: number; readonly name: () => string }>();
  const remember = (key: string, name: () => string): void => {
    if (!active) return;
    starts.delete(key);
    starts.set(key, { started: clock(), name });
    while (starts.size > REMEMBERED_STARTS) starts.delete(starts.keys().next().value!);
  };
  const take = (key: string) => {
    const value = starts.get(key);
    starts.delete(key);
    return value;
  };
  // The record's start wins: it survives a restart and is the owner's fact.
  const takeContract = (contractId: string): { readonly started: number; readonly name: () => string } | undefined => {
    const seen = take(`contract:${contractId}`);
    let recorded: RuntimeNotificationWork | undefined;
    try { recorded = options.lookupContract?.(contractId); } catch { recorded = undefined; }
    if (recorded && Number.isFinite(recorded.startedAt)) {
      const name = recorded.name;
      return { started: recorded.startedAt, name: () => name };
    }
    return seen;
  };
  const send = (event: RuntimeNotificationEvent, facts: TurnNotificationFacts): void => {
    if (!active) return;
    let pending: Promise<unknown>;
    try { pending = sink({ kind: 'turn', facts }, event); }
    catch (error) { pending = Promise.reject(error); }
    void pending.catch((error: unknown) => {
      logger.warn('Runtime notification was not delivered', { event, error: summarizeError(error) });
    });
  };

  // Nothing is read from an event once detached, and an event that cannot be
  // read costs its own notification, never the bus that delivered it.
  const on = <E extends AgentEvent | ContractEvent>(type: E['type'], handle: (payload: E) => void): (() => void) =>
    bus.on<E>(type, (envelope) => {
      if (!active) return;
      try { handle(envelope.payload); }
      catch (error) { logger.warn('Runtime notification could not be prepared', { event: type, error: summarizeError(error) }); }
    });

  const unsubscribers = [
    on<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>('AGENT_SPAWNING', (payload) => {
      remember(`agent:${payload.agentId}`, () => payload.task);
    }),
    on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', (payload) => {
      const work = take(`agent:${payload.agentId}`);
      send('AGENT_COMPLETED', {
        outcome: 'completed',
        subject: 'agent',
        elapsedMs: payload.durationMs,
        toolCalls: payload.toolCallsMade,
        get name() { return work?.name() ?? payload.output; },
      });
    }),
    on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', (payload) => {
      const work = take(`agent:${payload.agentId}`);
      send('AGENT_FAILED', {
        outcome: 'failed',
        subject: 'agent',
        elapsedMs: payload.durationMs,
        get name() { return work?.name(); },
        get reason() { return payload.error; },
      });
    }),
    on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>('AGENT_CANCELLED', (payload) => {
      const work = take(`agent:${payload.agentId}`);
      if (!work) return;
      send('AGENT_CANCELLED', {
        outcome: 'cancelled',
        subject: 'agent',
        elapsedMs: Math.max(0, clock() - work.started),
        get name() { return work.name(); },
        get reason() { return payload.reason; },
      });
    }),
    on<Extract<ContractEvent, { type: 'CONTRACT_CREATED' }>>('CONTRACT_CREATED', (payload) => {
      remember(`contract:${payload.contractId}`, () => payload.ask);
    }),
    on<Extract<ContractEvent, { type: 'CONTRACT_PASSED' }>>('CONTRACT_PASSED', (payload) => {
      const work = takeContract(payload.contractId);
      if (!work) return;
      send('CONTRACT_PASSED', {
        outcome: 'completed',
        subject: 'contract',
        elapsedMs: Math.max(0, clock() - work.started),
        get name() { return work.name(); },
      });
    }),
    on<Extract<ContractEvent, { type: 'CONTRACT_FAILED' }>>('CONTRACT_FAILED', (payload) => {
      const work = takeContract(payload.contractId);
      if (!work) return;
      send('CONTRACT_FAILED', {
        outcome: 'failed',
        subject: 'contract',
        elapsedMs: Math.max(0, clock() - work.started),
        get name() { return work.name(); },
        get reason() {
          return payload.failureKind === 'max_turns'
            ? budgetReason(payload.turnLimit)
            : payload.failureKind === 'transport' ? 'transient transport error' : payload.reason;
        },
      });
    }),
    on<Extract<ContractEvent, { type: 'CONTRACT_CANCELLED' }>>('CONTRACT_CANCELLED', (payload) => {
      const work = takeContract(payload.contractId);
      if (!work) return;
      send('CONTRACT_CANCELLED', {
        outcome: 'cancelled',
        subject: 'contract',
        elapsedMs: Math.max(0, clock() - work.started),
        filesChanged: payload.filesModified,
        get name() { return work.name(); },
        get reason() { return payload.reason; },
      });
    }),
  ];

  return () => {
    if (!active) return;
    active = false;
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch { /* a bus that cannot unsubscribe has nothing left to deliver here */ }
    }
    starts.clear();
  };
}
