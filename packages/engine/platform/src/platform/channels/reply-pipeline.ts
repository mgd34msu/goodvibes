import { classifyFailure } from '@goodvibes-jev/engine/errors';
import type { RuntimeEventBus, RuntimeEventEnvelope, AnyRuntimeEvent } from '../runtime/events/index.js';
import type { ContractEvent } from '../../events/contract.js';
import type {
  ChannelRenderEvent,
  ChannelRenderPhase,
  ChannelRenderPolicy,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelSurface,
} from './types.js';
import type { ChannelPluginRegistry } from './plugin-registry.js';
import type { RouteBindingManager } from './route-manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

import { markEventsDelivered, selectUndeliveredEvents } from './reply-delta.js';
import { buildRenderedFinalParts, buildRenderedText, normalizeChannelRenderEventFromRuntime, type ChannelRenderSources, type ChannelReplyRenderOptions, type ChannelReplyStyle } from './reply-render.js';
import { DEFAULT_POLICY } from './reply-policy.js';
import type { ChannelRenderAudience } from './render-audience.js';

export { normalizeChannelRenderEventFromRuntime } from './reply-render.js';

const MAX_BUFFERED_EVENTS = 64;
const DEFAULT_PROGRESS_INTERVAL_MS = 7_500;

/**
 * How long a run must have been going before it may interrupt anyone with a
 * progress notification.
 *
 * Owner ruling: a progress notification is warranted only when silence would
 * be worse, when the work has been running long enough that a person would
 * reasonably wonder whether it died. Below this floor an exchange produces
 * exactly ONE notification, the answer, which is what asking a question is
 * supposed to feel like.
 *
 * Measured from `pending.createdAt` (when the reply was queued for this
 * agent), so it bounds the WHOLE run rather than the gap between ticks, the
 * pacing interval already does the latter, and pacing alone still let a
 * three-second conversational turn produce a "starting" push before its
 * answer. Applied ahead of `force`, because forcing exists to bypass pacing
 * for something worth interrupting for, and nothing in the first few seconds
 * of a run qualifies.
 */
const MIN_PROGRESS_NOTIFICATION_AGE_MS = 30_000;

export interface TrackedChannelReply {
  readonly agentId: string;
  readonly surfaceKind: ChannelSurface;
  readonly task: string;
  readonly agentTask?: string | undefined;
  readonly contractId?: string | undefined;
  readonly createdAt: number;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly rootAgentId?: string | undefined;
}

/**
 * A reply that was produced for a conversation but never reached it.
 *
 * Handed to the host so the miss lands in the same delivery ledger automation
 * deliveries use. Without this, "the agent answered and the answer was lost"
 * and "no message ever arrived" read identically: zero attempts, no record.
 */
export interface UndeliveredChannelReply {
  readonly surfaceKind: ChannelSurface;
  readonly agentId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly phase: ChannelRenderPhase;
  readonly body: string;
  readonly reason: string;
}

export type UndeliveredChannelReplyReporter = (reply: UndeliveredChannelReply) => void;

/** A reply that did reach its conversation, for the same ledger. */
export interface DeliveredChannelReply {
  readonly surfaceKind: ChannelSurface;
  readonly agentId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly responseId?: string | undefined;
}

export type DeliveredChannelReplyReporter = (reply: DeliveredChannelReply) => void;

interface ReplyPipelineDeps {
  readonly channelPlugins: ChannelPluginRegistry;
  readonly routeBindings: RouteBindingManager;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  readonly now?: (() => number) | undefined;
  /** Records a produced-but-undelivered reply in the delivery ledger. */
  readonly onUndelivered?: UndeliveredChannelReplyReporter | undefined;
  /** Records a reply that reached its conversation in the delivery ledger. */
  readonly onDelivered?: DeliveredChannelReplyReporter | undefined;
  /**
   * The reply style the producing run was started with (`AgentRecord.replyStyle`).
   * Without it, a run attached to a contract counts as a report and any other
   * run's text is delivered as written.
   */
  readonly replyStyleOf?: ((agentId: string) => ChannelReplyStyle | undefined) | undefined;
  /** Pause between attempts at a final reply; defaults to a timer. */
  readonly waitBeforeRetry?: ((ms: number) => Promise<void>) | undefined;
  /**
   * The task of a contract, read from its record, so every line about a
   * workstream names it, also after a restart or once its remembered phrase
   * was evicted.
   */
  readonly contractAsk?: ((contractId: string) => string | undefined) | undefined;
  /**
   * Save, then send: called before a conversation's final answer is sent and
   * awaited, so the record that the answer is owed (the session's channel rows)
   * is on disk before the send can begin; a daemon that dies mid-send sends it
   * again after its restart. A failure is logged and the answer is still sent.
   */
  readonly recordFinalOwed?: ((reply: { readonly sessionId: string; readonly agentId: string }) => Promise<void>) | undefined;
  /** Called once the final was handed to the channel (accepted or not), or found to have nothing to send: the owed record is settled. */
  readonly recordFinalHanded?: ((reply: { readonly sessionId: string; readonly agentId: string }) => Promise<void>) | undefined;
}

/** Pauses before the second and third attempt at a final reply a channel refused with a transient error. */
const FINAL_RETRY_BACKOFF_MS = [1_000, 4_000] as const;

interface ReplyBufferState {
  /** Replaced in place (never re-inserted as a copy) so an in-flight delivery's marks stay on this object. */
  pending: TrackedChannelReply;
  readonly events: ChannelRenderEvent[];
  /**
   * Ids of events already published to the surface, the delta watermark.
   * Progress updates render only the events NOT in this set, so a notification
   * carries what just happened rather than the whole accumulated log replayed
   * from the top on every tick.
   */
  readonly deliveredEventIds: Set<string>;
  lastDeliveredText?: string | undefined;
  lastDeliveredAt?: number | undefined;
  /** A final answer for this agent has been taken up (in flight or done); see `finalOwner`. */
  finalTaken?: boolean | undefined;
  /**
   * Announcements made for this reply: `progress` counts progress messages and
   * `final` counts final legs (a chain that keeps tracking sends more than
   * one). The identity a surface deduplicates on (`announces` on the pending
   * copy) is built from them, so two different messages are never taken for
   * one because their words match, and a part of a final keeps one identity
   * for every attempt at it (`agent:<id>:final:<leg>:<part>`), also when it is
   * sent again after a restart.
   */
  announced?: { progress: number; final: number } | undefined;
}

function resolveEnvelopeAgentId(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): string | null {
  if (envelope.agentId) return envelope.agentId;
  const payload = envelope.payload as { readonly agentId?: unknown };
  return typeof payload.agentId === 'string' ? payload.agentId : null;
}

function isContractEventPayload(payload: AnyRuntimeEvent): payload is ContractEvent {
  return payload.type.startsWith('CONTRACT_');
}

function resolveEnvelopeContractId(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): string | null {
  const payload = envelope.payload as { readonly contractId?: unknown };
  return typeof payload.contractId === 'string' && payload.contractId.length > 0 ? payload.contractId : null;
}

function isAgentFinalEvent(type: AnyRuntimeEvent['type']): boolean {
  return type === 'AGENT_COMPLETED' || type === 'AGENT_FAILED' || type === 'AGENT_CANCELLED';
}

export class ChannelReplyPipeline {
  private readonly channelPlugins: ChannelPluginRegistry;
  private readonly routeBindings: RouteBindingManager;
  private readonly now: () => number;
  private readonly buffers = new Map<string, ReplyBufferState>();
  /**
   * Tail of the in-flight delivery chain for each agent, the serialization
   * point that makes "read the watermark, publish, mark delivered" atomic.
   *
   * Two callers reach this concurrently by design: `handleEnvelope` fires on
   * every bus event, and the daemon's pending-reply poller calls
   * `deliverProgress(..., force)` on its own 2s tick. Both used to read the
   * same unmarked watermark while a publish was still in flight, so each one
   * selected the same events plus whatever had arrived since, the reader got
   * a ladder of notifications where each body was a strict SUPERSET of the one
   * before it. The single-call delta was already correct; the interleaving was
   * not.
   */
  private readonly deliveryChains = new Map<string, Promise<void>>();
  private readonly contracts = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];
  private undeliveredReporter: UndeliveredChannelReplyReporter | null;
  private deliveredReporter: DeliveredChannelReplyReporter | null;
  private readonly replyStyleOf: ((agentId: string) => ChannelReplyStyle | undefined) | null;
  private readonly waitBeforeRetry: (ms: number) => Promise<void>;
  private readonly renderSources: ChannelRenderSources;
  private readonly recordFinalOwed: ReplyPipelineDeps['recordFinalOwed'];
  private readonly recordFinalHanded: ReplyPipelineDeps['recordFinalHanded'];

  constructor(deps: ReplyPipelineDeps) {
    this.channelPlugins = deps.channelPlugins;
    this.routeBindings = deps.routeBindings;
    this.recordFinalOwed = deps.recordFinalOwed;
    this.recordFinalHanded = deps.recordFinalHanded;
    this.now = deps.now ?? (() => Date.now());
    this.undeliveredReporter = deps.onUndelivered ?? null;
    this.deliveredReporter = deps.onDelivered ?? null;
    this.replyStyleOf = deps.replyStyleOf ?? null;
    this.waitBeforeRetry = deps.waitBeforeRetry ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.renderSources = deps.contractAsk ? { contractAsk: deps.contractAsk } : {};
    this.attachRuntimeBus(deps.runtimeBus ?? null);
  }

  /** Install (or replace) the ledger reporters after construction. */
  setUndeliveredReporter(reporter: UndeliveredChannelReplyReporter | null): void {
    this.undeliveredReporter = reporter;
  }

  setDeliveredReporter(reporter: DeliveredChannelReplyReporter | null): void {
    this.deliveredReporter = reporter;
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.disposeSubscriptions();
    if (!runtimeBus) return;
    const domains: Array<Parameters<RuntimeEventBus['onDomain']>[0]> = [
      'agents',
      'turn',
      'tools',
      'planner',
      'gate',
      'providers',
      'compaction',
      'contracts',
    ];
    for (const domain of domains) {
      this.unsubscribers.push(runtimeBus.onDomain(domain, (envelope) => {
        void this.handleEnvelope(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>).catch((error: unknown) => {
          logger.warn('Channel reply pipeline failed to handle runtime event', {
            domain,
            eventType: envelope.type,
            error: summarizeError(error),
          });
        });
      }));
    }
  }

  dispose(): void {
    this.disposeSubscriptions();
    this.buffers.clear();
    this.contracts.clear();
    this.deliveryChains.clear();
  }

  /**
   * Run `task` with no other delivery for the same agent in flight.
   *
   * Serializing the whole read-decide-publish-mark body, rather than only
   * reserving the watermark before the await, is deliberate. Reserving the
   * watermark alone stops the superset ladder, but it leaves the two OTHER
   * pieces of state this method reads before the await and writes after it
   * racing: `lastDeliveredText` (the identical-body suppression) and
   * `lastDeliveredAt` (the pacing interval). Under a reserve-only fix two
   * callers still both pass the pacing check and both publish, so one message
   * still arrives as two notifications, disjoint instead of nested, which is
   * a smaller bug of the same kind. With the section serialized, the second
   * caller observes the first one's marks and correctly suppresses itself.
   *
   * Scope is per agent id, so a slow surface can only delay that agent's own
   * updates, never another agent's. Rejections are absorbed into the chain
   * tail (callers still see their own), so one failed send cannot poison the
   * next one.
   */
  private runExclusive<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.deliveryChains.get(agentId);
    const started = previous ? previous.then(task, task) : task();
    const settled = started.then(() => undefined, () => undefined);
    this.deliveryChains.set(agentId, settled);
    void settled.then(() => {
      if (this.deliveryChains.get(agentId) === settled) {
        this.deliveryChains.delete(agentId);
      }
    });
    return started;
  }

  trackPending(pending: TrackedChannelReply): void {
    this.buffers.set(pending.agentId, {
      pending,
      events: [],
      deliveredEventIds: new Set<string>(),
    });
    if (typeof pending.contractId === 'string' && pending.contractId.length > 0) {
      this.contracts.set(pending.contractId, pending.agentId);
    }
  }

  untrack(agentId: string): void {
    this.buffers.delete(agentId);
    for (const [contractId, mappedAgentId] of this.contracts.entries()) {
      if (mappedAgentId === agentId) {
        this.contracts.delete(contractId);
      }
    }
  }

  has(agentId: string): boolean {
    return this.buffers.has(agentId);
  }

  getPending(agentId: string): TrackedChannelReply | null {
    return this.buffers.get(agentId)?.pending ?? null;
  }

  /**
   * `audience` classifies `explicitText` only, the buffered events carry their
   * own. It defaults to `operator` for the same reason the field does
   * everywhere else: a caller who hands over a status string without saying who
   * wrote it is handing over `AgentRecord.progress`, which is the orchestrator's
   * running tool name and a scrap of its arguments. That reached the owner's
   * phone as `registry, email send`. See agents/progress-audience.ts.
   */
  async deliverProgress(
    agentId: string,
    explicitText?: string,
    force = false,
    audience: ChannelRenderAudience = 'operator',
  ): Promise<ChannelRenderResult | null> {
    return await this.runExclusive(agentId, async () => await this.deliverProgressExclusive(agentId, explicitText, force, audience));
  }

  private async deliverProgressExclusive(
    agentId: string,
    explicitText: string | undefined,
    force: boolean,
    audience: ChannelRenderAudience,
  ): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    // Nothing is worth interrupting for yet. See MIN_PROGRESS_NOTIFICATION_AGE_MS:
    // this is what makes a conversational exchange exactly one notification.
    if (this.now() - state.pending.createdAt < MIN_PROGRESS_NOTIFICATION_AGE_MS) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    // Every surface gets the status line, ntfy included. Blanking it for ntfy
    // made the owner's primary channel the only one with no "what is happening
    // now" at all, and it was inert anyway, because the progress phase used to
    // discard explicitText entirely. buildRenderedText bounds it to one line.
    // ...as long as it was written FOR the reader. Operator status is dropped
    // here rather than filtered downstream, so it never enters the rendered
    // body, never sets `lastDeliveredText`, and never consumes a delivery slot.
    const explicit = audience === 'owner' ? explicitText ?? '' : '';
    // Delta only. Rendering the whole accumulated buffer on every tick is what
    // made each notification re-send everything that came before it, so line
    // counts climbed 3 -> 10 -> 13 while the reader learned nothing new.
    //
    // Progress-phase events ONLY. The buffer is appended to by the bus while
    // this call is queued, so by the time a tick actually runs the agent may
    // already have completed and pushed its final events. Rendering the whole
    // buffer let a progress notification carry "Agent completed in 5ms", and,
    // worse, consume the watermark for a final-phase event, which would then
    // be missing from the final body. What the agent is DOING is progress;
    // what it SAID is the final's to deliver.
    const freshEvents = selectUndeliveredEvents(state, state.events.filter((event) => event.phase !== 'final'));
    if (freshEvents.length === 0 && explicit.trim().length === 0) return null;
    const text = buildRenderedText(explicit, freshEvents, policy, 'progress', this.renderOptions(state));
    if (!text) return null;
    // Identical content is never republished, forced or not. `force` exists to
    // bypass the pacing interval for something worth interrupting for; it is
    // not authorization to send the same body again. Letting it skip this
    // check is what turned one workstream into 14 copies of one message.
    if (state.lastDeliveredText === text) return null;
    if (!force && (this.now() - (state.lastDeliveredAt ?? 0)) < DEFAULT_PROGRESS_INTERVAL_MS && state.lastDeliveredText !== undefined) {
      return null;
    }
    const delivered = freshEvents.slice(-policy.maxEventsPerUpdate);
    // A failed progress update must not abort the turn or unwind the delta
    // watermark: the final reply is the one that has to arrive, and replaying
    // the same events on the next tick would only repeat the same failure.
    let result: ChannelRenderResult | null = null;
    try {
      result = await this.dispatch(state, policy, 'progress', text, delivered);
    } catch (error) {
      logger.warn('Agent progress update could not be delivered to its surface', {
        surface: state.pending.surfaceKind,
        agentId,
        sessionId: state.pending.sessionId ?? null,
        bindingId: state.pending.routeId ?? null,
        reason: summarizeError(error),
      });
      this.reportUndelivered(state, 'progress', text, summarizeError(error));
    }
    markEventsDelivered(state, freshEvents);
    state.lastDeliveredText = text;
    state.lastDeliveredAt = this.now();
    return result;
  }

  async deliverFinal(
    agentId: string,
    explicitText: string,
    options: { readonly keepTracking?: boolean } = {},
  ): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (state) state.finalTaken = true;
    return await this.runExclusive(agentId, async () => await this.deliverFinalExclusive(agentId, explicitText, options));
  }

  /**
   * Who has this agent's final answer. The agent's own terminal event delivers
   * it through this pipeline; anything else that notices the agent ended (the
   * daemon's reply poll) sends the answer only when nobody has taken it up.
   * - `untracked`: no reply is tracked for the agent (delivered and closed, or never queued).
   * - `in-flight`: a final is being sent now.
   * - `taken`: a final was sent and the reply stays tracked for a contract's later reports.
   * - `none`: the agent is tracked and no final has been started.
   */
  finalOwner(agentId: string): 'untracked' | 'in-flight' | 'taken' | 'none' {
    const state = this.buffers.get(agentId);
    if (!state) return 'untracked';
    if (!state.finalTaken) return 'none';
    return this.deliveryChains.has(agentId) ? 'in-flight' : 'taken';
  }

  private async deliverFinalExclusive(
    agentId: string,
    explicitText: string,
    options: { readonly keepTracking?: boolean },
  ): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    const finalEvents = state.events.filter((event) => event.phase === 'final');
    // Delta, no floor.
    //
    // Buffered events are rendered only if the reader has not already been sent
    // them. Rendering the lot made the final body a strict SUPERSET of every
    // progress update before it, so the exact-body check below could never
    // fire, and one trivial message arrived as three notifications, each
    // repeating the previous one plus a little more.
    //
    // This used to end in a floor: when everything had already been delivered,
    // a synthesised status event rendered "Completed" so that a run "never ends
    // in silence". Owner ruling: it should. Work that produced nothing to
    // report reports nothing, and a bare acknowledgement is not a message,
    // it is a notification whose entire content is that a notification was
    // possible. The guarantee that a CONVERSATION always gets an answer moved
    // to where it belongs, upstream, where there is still a model to ask
    // (agents/conversational-reply-recovery.ts).
    const candidateEvents = finalEvents.length > 0 ? finalEvents : state.events;
    const renderEvents = selectUndeliveredEvents(state, candidateEvents);
    const parts = buildRenderedFinalParts(explicitText, renderEvents, policy, this.renderOptions(state));
    const text = parts.join('\n\n');
    // Nothing to say, so say nothing, but close the run out.
    //
    // Two ways here: a run that finished with no output at all, and a body that
    // rendered to nothing after the completion report was stripped out of it.
    // Either way the reader gets no notification, and the pipeline still marks
    // the events delivered and untracks the agent, so this can never leave an
    // agent tracked forever or make the poller re-deliver it.
    if (!text.trim()) {
      markEventsDelivered(state, renderEvents);
      if (!options.keepTracking) this.untrack(agentId);
      await this.settleFinalRecord(state);
      return null;
    }
    // A chain that keeps tracking (an ntfy reply that follows a contract) can reach this more
    // than once. An identical final body is a duplicate notification, not a
    // second outcome, publish it once.
    if (text && state.lastDeliveredText === text) {
      if (!options.keepTracking) this.untrack(agentId);
      await this.settleFinalRecord(state);
      return null;
    }
    // Save, then send: the answer is recorded as owed before its first part goes out.
    await this.recordFinalOwedFor(state);
    // One leg of finals for this reply; every part of it keeps its identity for every attempt.
    const announced = state.announced ??= { progress: 0, final: 0 };
    announced.final += 1;
    const leg = announced.final;
    // A final reply is delivered ONCE, whether or not the surface accepted it.
    //
    // Letting a throwing dispatch escape used to skip the untrack below, which
    // left the agent still tracked; the pending-reply poller then treated the
    // completed agent as unhandled, re-appended its answer to the shared
    // session, and retried the same failing send. The observable symptom was
    // every Telegram answer stored twice with nothing delivered. The send is
    // still allowed to fail, it just fails once, loudly, and stops.
    let result: ChannelRenderResult | null = null;
    let deliveryError: unknown = null;
    let partsDelivered = 0;
    try {
      // The body is the delta; the event list handed to the renderer is not.
      // Renderers classify an outcome from it (an `error` event is what marks a
      // notification failed), and that verdict must not flip just because the
      // error line was already delivered by a progress tick.
      //
      // A long answer is delivered as several messages in order (the per-agent
      // chain keeps them from interleaving); the first one the surface did not
      // accept is the result, so a partial delivery is never reported as whole.
      const dispatchEvents = finalEvents.length > 0 ? finalEvents : state.events.slice(-policy.maxEventsPerUpdate);
      for (const [index, part] of parts.entries()) {
        const partResult = await this.dispatchFinalWithRetry(state, policy, part, dispatchEvents, `agent:${state.pending.agentId}:final:${leg}:${index + 1}`);
        if (result === null || result.delivered) result = partResult;
        if (!partResult?.delivered) break;
        partsDelivered += 1;
      }
    } catch (error) {
      deliveryError = error;
      logger.error('Agent reply could not be delivered to the surface it came from', {
        surface: state.pending.surfaceKind,
        agentId,
        sessionId: state.pending.sessionId ?? null,
        bindingId: state.pending.routeId ?? null,
        phase: 'final',
        reason: summarizeError(error),
      });
      this.reportUndelivered(state, 'final', text, summarizeError(error));
    }
    // Mark what this body was built from only when every part of it arrived, so
    // a later leg of a chain that keeps tracking still carries what did not.
    if (partsDelivered === parts.length) markEventsDelivered(state, renderEvents);
    state.lastDeliveredText = text;
    state.lastDeliveredAt = this.now();
    if (!options.keepTracking) {
      this.untrack(agentId);
    }
    // Handed to the channel, accepted or not (a final is sent once): the owed record is settled.
    await this.settleFinalRecord(state);
    if (deliveryError) return null;
    if (result?.delivered) {
      // Close the ledger entry this reply opened when it was queued. Without
      // this the ledger shows every surface reply stuck at "pending" forever,
      // which is only marginally more useful than showing nothing.
      this.deliveredReporter?.({
        surfaceKind: state.pending.surfaceKind,
        agentId: state.pending.agentId,
        sessionId: state.pending.sessionId,
        routeId: state.pending.routeId,
        ...(result.responseId ? { responseId: result.responseId } : {}),
      });
    }
    return result;
  }

  /** The conversation's own final (not a child agent's) records its owed answer; a failed record is logged and the answer is still sent. */
  private async recordFinalOwedFor(state: ReplyBufferState): Promise<void> {
    const sessionId = state.pending.sessionId;
    if (!this.recordFinalOwed || !sessionId || !state.pending.routeId || state.pending.parentAgentId) return;
    try { await this.recordFinalOwed({ sessionId, agentId: state.pending.agentId }); }
    catch (error) {
      logger.error('A channel answer could not be recorded as owed before its send; a restart during the send would lose it', {
        surface: state.pending.surfaceKind, agentId: state.pending.agentId, sessionId, reason: summarizeError(error),
      });
    }
  }

  private async settleFinalRecord(state: ReplyBufferState): Promise<void> {
    const sessionId = state.pending.sessionId;
    if (!this.recordFinalHanded || !sessionId || !state.pending.routeId || state.pending.parentAgentId) return;
    try { await this.recordFinalHanded({ sessionId, agentId: state.pending.agentId }); }
    catch (error) {
      logger.warn('A sent channel answer could not be marked sent; a restart may send it again', {
        surface: state.pending.surfaceKind, agentId: state.pending.agentId, sessionId, reason: summarizeError(error),
      });
    }
  }

  /**
   * Report a reply that was produced but never reached its conversation.
   *
   * Routed through the SAME delivery ledger the automation deliveries use, so
   * a "should have sent, did not" is a visible failed attempt rather than an
   * absence indistinguishable from "nothing happened".
   */
  private reportUndelivered(
    state: ReplyBufferState,
    phase: ChannelRenderPhase,
    text: string,
    reason: string,
  ): void {
    this.undeliveredReporter?.({
      surfaceKind: state.pending.surfaceKind,
      agentId: state.pending.agentId,
      sessionId: state.pending.sessionId,
      routeId: state.pending.routeId,
      phase,
      body: text,
      reason,
    });
  }

  private async handleEnvelope(
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): Promise<void> {
    if (isContractEventPayload(envelope.payload)) {
      await this.handleContractEnvelope(envelope as RuntimeEventEnvelope<ContractEvent['type'], ContractEvent>);
      return;
    }
    if (
      envelope.payload.type === 'AGENT_SPAWNING'
      && typeof envelope.payload.parentAgentId === 'string'
      && envelope.payload.parentAgentId.length > 0
    ) {
      this.trackChildPendingReply(
        envelope.payload.agentId,
        envelope.payload.parentAgentId,
        envelope.payload.task,
      );
    }
    const agentId = resolveEnvelopeAgentId(envelope);
    if (!agentId) return;
    const state = this.buffers.get(agentId);
    if (!state) return;
    const events = normalizeChannelRenderEventFromRuntime(envelope, this.renderSources);
    if (events.length === 0) return;
    state.events.push(...events);
    if (state.events.length > MAX_BUFFERED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFERED_EVENTS);
    }
    const hasFinal = events.some((event) => event.phase === 'final');
    if (hasFinal) {
      // The same set for every surface, ntfy included. ntfy used to drop
      // `assistant_text` here, which meant the one notification the owner
      // actually waits for carried "Agent completed in Nms" and never the
      // reply that produced it. Length is a rendering concern, and it is
      // already handled: the ntfy policy trims the body to maxChunkChars.
      const finalKinds = new Set<ChannelRenderEvent['kind']>(['assistant_text', 'error', 'status']);
      const text = events
        .filter((event) => finalKinds.has(event.kind))
        .map((event) => event.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      await this.deliverFinal(agentId, text, {
        keepTracking: state.pending.surfaceKind === 'ntfy'
          && typeof state.pending.contractId === 'string'
          && isAgentFinalEvent(envelope.payload.type),
      });
      return;
    }
    await this.deliverProgress(agentId);
  }

  private async handleContractEnvelope(
    envelope: RuntimeEventEnvelope<ContractEvent['type'], ContractEvent>,
  ): Promise<void> {
    if (envelope.payload.type === 'CONTRACT_CREATED') {
      const matched = this.findPendingForAsk(envelope.payload.ask, envelope.payload.ownerAgentId, envelope.sessionId);
      if (matched) {
        this.associateContract(matched.pending.agentId, envelope.payload.contractId);
      }
    }
    const contractId = resolveEnvelopeContractId(envelope);
    if (!contractId) return;
    const agentId = this.contracts.get(contractId);
    if (!agentId) return;
    const state = this.buffers.get(agentId);
    if (!state) {
      this.contracts.delete(contractId);
      return;
    }
    const events = normalizeChannelRenderEventFromRuntime(envelope, this.renderSources);
    if (events.length === 0) return;
    state.events.push(...events);
    if (state.events.length > MAX_BUFFERED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFERED_EVENTS);
    }
    const hasFinal = events.some((event) => event.phase === 'final');
    if (hasFinal) {
      const text = events
        .filter((event) => event.kind === 'error' || event.kind === 'status')
        .map((event) => event.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      await this.deliverFinal(agentId, text);
      return;
    }
    await this.deliverProgress(agentId, undefined, true);
  }

  private trackChildPendingReply(agentId: string, parentAgentId: string, task: string): void {
    if (this.buffers.has(agentId)) return;
    const parentState = this.buffers.get(parentAgentId);
    if (!parentState) return;
    const rootAgentId = typeof parentState.pending.rootAgentId === 'string'
      ? parentState.pending.rootAgentId
      : parentAgentId;
    this.buffers.set(agentId, {
      pending: {
        ...parentState.pending,
        agentId,
        task,
        parentAgentId,
        rootAgentId,
      },
      events: [],
      deliveredEventIds: new Set<string>(),
    });
  }

  /**
   * The pending reply a new contract belongs to: the one tracking its owner
   * agent when there is one, else the one whose task is the contract's ask.
   *
   * The ask is short text ("status") that two conversations can share, so the
   * match is used only when every pending reply that fits belongs to one
   * conversation, and never across sessions: progress for one chat must not be
   * delivered into another.
   */
  private findPendingForAsk(ask: string, ownerAgentId: string, sessionId?: string): ReplyBufferState | null {
    const owned = this.buffers.get(ownerAgentId);
    if (owned && typeof owned.pending.contractId !== 'string') return owned;
    const normalizedTask = ask.trim();
    if (!normalizedTask) return null;
    const byAgentTask: ReplyBufferState[] = [];
    const byTask: ReplyBufferState[] = [];
    for (const state of this.buffers.values()) {
      if (typeof state.pending.contractId === 'string') continue;
      if (sessionId && state.pending.sessionId && state.pending.sessionId !== sessionId) continue;
      const agentTask = typeof state.pending.agentTask === 'string' ? state.pending.agentTask.trim() : '';
      if (agentTask === normalizedTask) byAgentTask.push(state);
      else if (state.pending.task.trim() === normalizedTask) byTask.push(state);
    }
    const candidates = byAgentTask.length > 0 ? byAgentTask : byTask;
    // Several workstreams started from one conversation pair up in order, but an
    // ask shared by different conversations cannot be told apart, so it is not
    // attached to any of them.
    const conversations = new Set(candidates.map((state) => `${state.pending.sessionId ?? ''}|${state.pending.routeId ?? ''}`));
    if (conversations.size > 1) {
      logger.warn('Contract ask matches pending replies in several conversations; not attaching its progress to any', { candidates: candidates.length });
      return null;
    }
    return candidates[0] ?? null;
  }

  private associateContract(agentId: string, contractId: string): void {
    const state = this.buffers.get(agentId);
    if (!state) return;
    this.contracts.set(contractId, agentId);
    // In place: a delivery already in flight holds this object and writes its
    // pacing and identical-body marks to it, so a replacement copy would lose them.
    state.pending = { ...state.pending, contractId };
  }

  /**
   * The producing run's reply style decides whether the prose completion form
   * is reduced to its summary (see reply-render.ts). The host states it; a run
   * attached to a contract is a report run when the host does not.
   */
  private renderOptions(state: ReplyBufferState): ChannelReplyRenderOptions {
    const stated = this.replyStyleOf?.(state.pending.agentId);
    if (stated) return { replyStyle: stated };
    return typeof state.pending.contractId === 'string' && state.pending.contractId.length > 0 ? { replyStyle: 'report' } : {};
  }

  private async resolvePolicy(surface: ChannelSurface): Promise<ChannelRenderPolicy> {
    // A plugin's policy is third-party code. If it throws, the reply still has to
    // be delivered and untracked, so the surface's default policy stands in.
    try {
      return await this.channelPlugins.getRenderPolicy(surface) ?? DEFAULT_POLICY[surface];
    } catch (error) {
      logger.warn('Channel render policy could not be read; using the surface default', { surface, reason: summarizeError(error) });
      return DEFAULT_POLICY[surface];
    }
  }

  /**
   * A channel that throws a transient error (a rate limit, a dropped
   * connection) usually accepts the same message a moment later. Only the part
   * that failed is retried, so a long answer never repeats parts the reader
   * already has. A failure the error table calls permanent (a rejected token, a
   * malformed request) is not retried: the same send would fail the same way.
   * After the last attempt the error reaches the caller, which reports the
   * reply undelivered with its body.
   */
  private async dispatchFinalWithRetry(
    state: ReplyBufferState,
    policy: ChannelRenderPolicy,
    text: string,
    events: readonly ChannelRenderEvent[],
    announces: string,
  ): Promise<ChannelRenderResult | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.dispatch(state, policy, 'final', text, events, announces);
      } catch (error) {
        const backoff = FINAL_RETRY_BACKOFF_MS[attempt];
        const failure = classifyFailure(error);
        if (backoff === undefined || failure?.retryable === false) throw error;
        logger.warn('Agent reply delivery failed; retrying', {
          surface: state.pending.surfaceKind,
          agentId: state.pending.agentId,
          attempt: attempt + 1,
          reason: summarizeError(error),
        });
        await this.waitBeforeRetry(Math.max(backoff, Math.min(failure?.retryAfterMs ?? 0, 10_000)));
      }
    }
  }

  private async dispatch(
    state: ReplyBufferState,
    policy: ChannelRenderPolicy,
    phase: ChannelRenderPhase,
    text: string,
    events: readonly ChannelRenderEvent[],
    finalAnnounces?: string,
  ): Promise<ChannelRenderResult | null> {
    // A final part brings its identity (fixed for every attempt); each progress message is a new one.
    let announces = finalAnnounces;
    if (announces === undefined) {
      const announced = state.announced ??= { progress: 0, final: 0 };
      announced.progress += 1;
      announces = `agent:${state.pending.agentId}:${phase}:${announced.progress}`;
    }
    const request: ChannelRenderRequest = {
      surface: state.pending.surfaceKind,
      phase,
      agentId: state.pending.agentId,
      sessionId: state.pending.sessionId,
      routeId: state.pending.routeId,
      title: state.pending.task,
      text,
      events,
      // Renderers read provider-specific fields by name, so they get a plain copy of the record.
      pending: { ...state.pending, announces },
      metadata: {
        policy,
        announces,
      },
    };
    const result = await this.channelPlugins.render(state.pending.surfaceKind, request);
    if (!result || !result.delivered) {
      // Not an exception, but the reply still did not reach anyone. A final
      // answer that silently reports "not delivered" is the exact failure this
      // module exists to make visible, so it is an error with the binding in
      // hand and a ledger entry, not a warn nobody reads.
      const reason = !result
        ? 'no-renderer-or-delivery-handler'
        : String(result.metadata.reason ?? 'renderer-reported-not-delivered');
      const describe = {
        surface: state.pending.surfaceKind,
        phase,
        agentId: state.pending.agentId,
        sessionId: state.pending.sessionId ?? null,
        bindingId: state.pending.routeId ?? null,
        reason,
      };
      if (phase === 'final') {
        logger.error('Agent reply was produced but no channel delivered it', describe);
        this.reportUndelivered(state, phase, text, reason);
      } else {
        logger.warn('ChannelReplyPipeline: channel render did not report delivery', describe);
      }
    }
    if (result?.responseId && state.pending.routeId) {
      // The channel already accepted this message. A failure to remember its
      // reply target must not reach the final-delivery retry, which would send it again.
      try {
        await this.routeBindings.captureReplyTarget(
          state.pending.routeId,
          result.responseId,
          typeof result.threadId === 'string' && result.threadId.length > 0 ? result.threadId : undefined,
        );
      } catch (error) {
        logger.warn('Reply was delivered but its reply target could not be recorded', {
          surface: state.pending.surfaceKind,
          agentId: state.pending.agentId,
          bindingId: state.pending.routeId,
          reason: summarizeError(error),
        });
      }
    }
    return result;
  }

  private disposeSubscriptions(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }
}
