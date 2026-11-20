import type { UiRuntimeEvents } from '@/runtime/index.ts';
import type { NoticeLevel } from '@goodvibes-jev/engine/platform/platform/core';
import type { StreamMetrics } from './stream-metrics.ts';
import { createStreamStallWatchdog, type StallTimers } from './stream-stall-watchdog.ts';
import { buildRoutingChip } from './model-routing-chip.ts';
import { userErrorLine } from './format-user-error.ts';
import { describeUserError, readUserErrorClass, type UserFacingError } from '@goodvibes-jev/engine/platform/platform/routing';
import { createUserTurnOwner, type UserTurnOwner } from './user-turn.ts';
import { ProviderSetupReadings, describeProviderSetup, type ProviderSetupClassification } from '../providers/provider-classification.ts';
import type { ProviderRuntimeMetadata } from '@goodvibes-jev/engine/platform/platform/providers';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';

// Preserve the existing wiring API while shared-state consumers use the leaf.
export { createStreamMetrics, type StreamMetrics } from './stream-metrics.ts';

/** Minimal orchestrator surface required for stream token-speed calculation. */
interface StreamOrchestrator {
  readonly streamingOutputTokens: number;
}

/** Minimal provider surface required for the stream stall watchdog and the failover billing line. */
interface StreamProviderRegistry {
  getCurrentModel(): { readonly provider: string; readonly registryKey?: string };
  /** Live declared facts; absence is unknown, never provider-id folklore. */
  describeRuntime?(providerId: string): Promise<ProviderRuntimeMetadata | null>;
  /** Exact instance identity fences replacement while asynchronous facts are read. */
  getRegistered?(providerId: string): object;
}

/** Minimal ProviderOptimizer surface: the fallback log the routing chip and /provider read. */
interface FailoverOptimizer {
  recordFallbackTransition(from: string, to: string, reason: string): void;
  /** Recent fallback transitions, read by the routing chip to skip double-narrating a failover. */
  readonly fallbackLog: readonly { readonly from: string; readonly to: string; readonly reason: string; readonly ts: number }[];
}

/** Minimal system-message surface required for user-visible notifications. */
interface StreamSystemMessageRouter {
  high(message: string, level?: NoticeLevel): void;
  low(message: string): void;
  /**
   * Unconditional conversation delivery (see system-message-router.ts). Used
   * for provider-switch notices: which backend serves a turn, and therefore
   * who bills for it, is never ambient chatter that a routing preference or
   * the noise gate may filter out. Optional so bare test doubles that supply
   * only high/low still type-check; announce() below falls back to high().
   */
  userReceipt?(message: string): void;
}

/**
 * Loosely-typed variant of the turns event feed, used only to subscribe to
 * STREAM_STALL, a proposed event the platform's TurnEvent union does not carry, so
 * `events.turns.on` rejects the name at compile time. See the subscription site
 * below. `events.turns.on` stays fully typed against the real union everywhere
 * else in this file, STREAM_RETRY included.
 */
interface LooseTurnEventFeed {
  on(type: string, listener: (payload: unknown) => void): () => void;
}

export interface WireStreamEventMetricsOptions {
  /** The UI runtime event bus (turns + tools sub-buses). */
  readonly events: UiRuntimeEvents;
  /** Orchestrator reference used to read real output token counts. */
  readonly orchestrator: StreamOrchestrator;
  /** Provider registry used by the stall watchdog to name the current provider. */
  readonly providerRegistry: StreamProviderRegistry;
  /** System message router for turn-error and stall notifications. */
  readonly systemMessageRouter: StreamSystemMessageRouter;
  /** Trigger a UI repaint after a state mutation. */
  readonly render: () => void;
  /**
   * Caller-owned metrics object to mutate in place.  Declared before render()
   * so the render closure can read it without a forward-reference issue.
   */
  readonly metrics: StreamMetrics;
  /** The active session and terminal lifetime are rechecked before a late line is added. */
  readonly getSessionId?: () => string;
  readonly isActive?: () => boolean;
  /**
   * The shell's one user-turn owner (core/user-turn.ts), shared with the
   * turn-event wiring: it decides when a user turn starts, fails over and
   * ends, and hands each failed attempt to this wiring. Omitted, this wiring
   * owns a private one on the same feed (a caller that wires it alone).
   */
  readonly userTurn?: UserTurnOwner;
  /** Where the synthetic provider's switches are logged (the routing chip reads the log so one is not narrated twice). */
  readonly providerOptimizer?: FailoverOptimizer;
  /**
   * Optional accessor for whether an approval card is currently waiting on the USER. When it
   * returns true, the stall watchdog does NOT emit its "Still waiting on <provider>… Ctrl+C to
   * cancel" hint: the stream is legitimately silent because we asked the user a question, so
   * blaming the provider (or framing it as a stall) would be dishonest. The approval surface owns
   * the honest "Waiting for your approval" label instead.
   */
  readonly isApprovalPending?: (() => boolean) | undefined;
  /**
   * Stall watchdog threshold in ms. Defaults to the watchdog's own default (STALL_THRESHOLD_MS,
   * 30 000). Exposed only so unit tests can drive the stall path without waiting 30s, production
   * callers omit it.
   */
  readonly stallThresholdMs?: number | undefined;
  /** Timer seam for the stall watchdog so tests can drive the clock; production callers omit it. */
  readonly stallTimers?: StallTimers | undefined;
  /**
   * Subscribes to the engine's failover moves within a turn (the orchestrator's
   * onTurnFailover): each one gets its billing line once the classes of both
   * providers are read. The move itself is narrated by the engine's [Failover] line.
   */
  readonly observeTurnFailover?: ((listener: (move: { readonly fromRegistryKey: string; readonly fromProvider: string; readonly toRegistryKey: string; readonly toProvider: string; readonly because: string }) => void) => () => void) | undefined;
}

/** Result of wireStreamEventMetrics. */
export interface WireStreamEventMetricsResult {
  /** Unsubscribe functions; push into the parent unsubs array for cleanup on exit. */
  readonly unsubs: ReadonlyArray<() => void>;
  /**
   * A new prompt is about to be submitted: a user turn that has not ended
   * (one whose stream stopped without a terminal event) is replaced.
   */
  readonly startNewTurn: () => void;
  /**
   * Register a callback that fires whenever a TURN_ERROR is surfaced to the
   * user. A provider failure surfaces only after the engine's turn loop has
   * tried the person's fallback order (providers/failover.ts), whose
   * [Failover] lines are already in the conversation. Used by main.ts to
   * activate the one-key retry affordance. The callback receives
   * exhausted=true for a provider failure, so the notice can say honestly
   * that a retry starts on the same failed provider.
   */
  readonly onErrorSurfaced: (cb: (exhausted: boolean) => void) => void;
}

/**
 * The suffix of the failover billing line, e.g. `[Failover] billing: API key →
 * Subscription: billing class changed`, when both classes are known and differ.
 * Classification is an owned asynchronous engine reading of instance facts.
 * Missing, stale or unavailable facts say Unknown, including familiar ids.
 * This display result never chooses or authorizes the fallback.
 */
function billingChangedSuffix(from: ProviderSetupClassification, to: ProviderSetupClassification): string {
  return from.setupClass !== 'unknown' && to.setupClass !== 'unknown' && from.setupClass !== to.setupClass
    ? ': billing class changed' : '';
}

/**
 * Wire STREAM_* and TOOL_* runtime events to the provided StreamMetrics object
 * and install the stream-stall watchdog.  The caller owns the metrics object
 * and declares it before render() so both the render closure and the returned
 * event handlers share the same reference.
 *
 * Returns an object with unsubscribe functions and the new-turn and cancel helpers.
 *
 * Responsibilities:
 *   - Track stream start time, delta count, token speed, and TTFT
 *   - Track the currently executing tool name and start time
 *   - Display TURN_ERROR messages via systemMessageRouter
 *   - Emit a stall hint when STREAM_START has no delta within the watchdog threshold
 */
export function wireStreamEventMetrics(
  options: WireStreamEventMetricsOptions,
): WireStreamEventMetricsResult {
  const {
    events, metrics, orchestrator, providerRegistry,
    systemMessageRouter, render, providerOptimizer,
    isApprovalPending, stallThresholdMs, stallTimers, observeTurnFailover,
  } = options;

  const unsubs: Array<() => void> = [];
  let closed = false;
  unsubs.push(() => { closed = true; });
  const userTurn = options.userTurn ?? createUserTurnOwner({ turns: events.turns, sessionId: () => options.getSessionId?.() ?? '' });
  if (options.userTurn === undefined) unsubs.push(() => userTurn.dispose());
  const setupReadings = new ProviderSetupReadings();
  let setupGeneration = 0;
  // Both custom-provider reload and credential refresh emit this owner event.
  // Only narration expires here; it is not a new fallback admission policy.
  if (events.providers) unsubs.push(events.providers.on('PROVIDERS_CHANGED', () => {
    setupGeneration++; setupReadings.invalidate();
  }));

  /**
   * Deliver a provider-switch notice to the conversation unconditionally.
   * Prefers the router's userReceipt channel, which skips the noise gate and
   * the ui.operationalMessages routing target entirely, so the line cannot be
   * filtered away by a preference. Falls back to high() for bare doubles.
   */
  const announce = (message: string): void => {
    if (systemMessageRouter.userReceipt) systemMessageRouter.userReceipt(message);
    else systemMessageRouter.high(message);
  };
  unsubs.push(events.turns.on('STREAM_START', () => {
    metrics.modelActive = true;
    metrics.startTime = Date.now();
    metrics.deltaCount = 0;
    metrics.tokenSpeed = 0;
    metrics.ttftMs = undefined;
    metrics.ttftRecorded = false;
    metrics.lastDeltaAtMs = Date.now();
    metrics.stallEpisode = 0;
    metrics.reconnectAttempt = undefined;
    metrics.reconnectMaxAttempts = undefined;
  }));

  unsubs.push(events.turns.on('STREAM_END', () => {
    metrics.modelActive = false;
    render();
  }));

  unsubs.push(events.turns.on('STREAM_DELTA', () => {
    metrics.deltaCount++;
    metrics.lastDeltaAtMs = Date.now();
    // A byte arrived: any in-flight reconnect (if the platform reported one)
    // has succeeded.
    metrics.reconnectAttempt = undefined;
    metrics.reconnectMaxAttempts = undefined;
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    // Record TTFT on the first delta of each turn.
    if (!metrics.ttftRecorded) {
      metrics.ttftMs = Date.now() - metrics.startTime;
      metrics.ttftRecorded = true;
    }
    // Use real output token count for accurate tok/s; fall back to delta count.
    const tokenCount = orchestrator.streamingOutputTokens > 0
      ? orchestrator.streamingOutputTokens
      : metrics.deltaCount;
    metrics.tokenSpeed = elapsed > 0 ? tokenCount / elapsed : 0;
  }));

  unsubs.push(userTurn.onEnd(() => {
    metrics.modelActive = false;
    // No call of an ended turn is still main's running work.
    metrics.runningTools.clear();
  }));

  // Routing chip (never-silent model change): every MODEL_CHANGED becomes a
  // one-line conversation notice. Deferred a microtask so a synthetic
  // provider's recordFallbackTransition has landed in the fallback log before
  // buildRoutingChip checks for correlation. A failover inside a turn changes
  // no selection: the engine's [Failover] line names the model that answers.
  // Degrade gracefully when a bare test double omits the providers feed.
  if (events.providers) {
    unsubs.push(events.providers.on('MODEL_CHANGED', (change) => {
      queueMicrotask(() => {
        const chip = buildRoutingChip(change, providerOptimizer?.fallbackLog ?? [], Date.now());
        if (chip === null) return;
        systemMessageRouter.high(chip);
        render();
      });
    }));
  }

  /**
   * The billing class of each side of an engine failover move, read after the
   * move is made and announced on its own line, so failover never waits on it. The cached
   * reading answers at once on a later hop. A side whose facts are missing or
   * were replaced while they were read says Unknown, never a guessed class.
   */
  const narrateBilling = (fromProvider: string, toProvider: string, stillCurrent: () => boolean): void => {
    const readingSetupGeneration = setupGeneration;
    const readSide = async (providerId: string): Promise<ProviderSetupClassification> => {
      const unknown = describeProviderSetup('unknown');
      try {
        const instance = providerRegistry.getRegistered?.(providerId);
        if (instance === null || typeof instance !== 'object' || !providerRegistry.describeRuntime) return unknown;
        const runtime = await providerRegistry.describeRuntime(providerId);
        if (readingSetupGeneration !== setupGeneration) return unknown;
        const value = await setupReadings.read({ providerId, runtime: runtime ?? undefined }, { site: 'tui.failover.setup' });
        // A provider replaced while its facts were read is not the one that serves.
        return instance === providerRegistry.getRegistered?.(providerId) ? value : unknown;
      } catch { return unknown; }
    };
    void Promise.all([readSide(fromProvider), readSide(toProvider)]).then(([from, to]) => {
      // A credential or config change while the facts were read makes them stale: say nothing.
      if (closed || readingSetupGeneration !== setupGeneration || !stillCurrent()) return;
      announce(`[Failover] billing: ${from.setupLabel} → ${to.setupLabel}${billingChangedSuffix(from, to)}`);
      render();
    });
  };
  if (observeTurnFailover) {
    unsubs.push(observeTurnFailover((move) => {
      // /provider lists the recent moves from this log.
      providerOptimizer?.recordFallbackTransition(move.fromRegistryKey, move.toRegistryKey, move.because);
      narrateBilling(move.fromProvider, move.toProvider, () => options.isActive?.() !== false);
    }));
  }

  /**
   * The error line was printed from structure at once. A reading of the
   * wording may say more (a context overflow, a subscription session that
   * ended); then it adds one line, never replaces or delays the first.
   */
  const refineErrorLater = (errVal: unknown, shown: UserFacingError, stillCurrent: () => boolean): void => {
    void readUserErrorClass(errVal, 'tui.stream-error').then((reading) => {
      if (reading.kind === shown.kind && !reading.sessionEnded) return;
      if (closed || !stillCurrent() || options.isActive?.() === false) return;
      systemMessageRouter.high(`[Error] ${userErrorLine(describeUserError(errVal, reading))}`, 'error');
      render();
    }, (error: unknown) => logger.debug('error reading failed', { error: String(error) }));
  };

  /**
   * One failed turn. The error line is decided from facts already held, at
   * once, from the status and errno. A provider failure reaches here only
   * after the engine's turn loop tried the person's fallback order
   * (providers/failover.ts) and said so in its [Failover] lines.
   */
  unsubs.push(userTurn.onFailure((failure) => {
    const event = failure.event;
    metrics.modelActive = false;
    // The wire text alone can only be read by wording. When the emitter also carries the
    // provider's status or errno code, the line fixes 401, 429 and network failures from those.
    const errVal: unknown = event.status === undefined && event.code === undefined
      ? event.error
      : { message: event.error, ...(event.status === undefined ? {} : { status: event.status }), ...(event.code === undefined ? {} : { code: event.code }) };
    const shown = describeUserError(errVal);
    const errorClass = userErrorLine(shown);
    if (options.isActive?.() === false) return;
    systemMessageRouter.high(`[Error] ${errorClass}`, 'error');
    // An event without a stop reason comes from an older emitter and is read as a provider failure.
    notifyErrorSurfaced(event.stopReason === undefined || event.stopReason === 'provider_error' || event.stopReason === 'provider_exhausted');
    render();
    refineErrorLater(errVal, shown, failure.isCurrent);
  }));

  // --- Stream stall watchdog: emit a low hint each time a no-delta gap (at
  // start of turn OR mid-stream, after a re-arm) crosses 30s. The transient
  // system message below is the initial alert; streamMetrics.stallEpisode
  // (read every render frame) drives the persistent "stalled Ns" indicator
  // in the thinking fragment, so the two coexist rather than conflict, the
  // message announces the stall, the indicator tracks it ongoing.
  const stallWatchdog = createStreamStallWatchdog({
    events: events.turns,
    onStall: (providerName, episode) => {
      // Suppress the provider-blaming stall hint while an approval card is waiting on the user: the
      // stream is silent because WE asked the user a question, not because the provider stalled.
      if (isApprovalPending?.()) return;
      metrics.stallEpisode = episode;
      systemMessageRouter.low(`Still waiting on ${providerName}… Ctrl+C to cancel`);
      render();
    },
    getProviderName: () => providerRegistry.getCurrentModel().provider,
    // thresholdMs defaults to 30 000 in the watchdog; only unit tests override it.
    ...(stallThresholdMs !== undefined ? { thresholdMs: stallThresholdMs } : {}),
    ...(stallTimers !== undefined ? { timers: stallTimers } : {}),
  });
  unsubs.push(() => stallWatchdog.dispose());

  // A provider call that reconnected mid-stream rather than failing the turn.
  // The attempt counter rides into the thinking fragment so a long silence
  // reads as "retrying 2/3" instead of as a hang; STREAM_DELTA clears it,
  // because a byte arriving means the reconnect worked.
  unsubs.push(events.turns.on('STREAM_RETRY', (event) => {
    metrics.reconnectAttempt = event.attempt;
    metrics.reconnectMaxAttempts = event.maxAttempts;
    render();
  }));
  // STREAM_STALL is a proposed platform event and is not on the TurnEvent union, so
  // the typed feed rejects the name at compile time. Subscribing through the
  // loose variant means the platform's own signal is observed the day it lands
  // rather than silently dropped. Informational only: the local
  // createStreamStallWatchdog above is the authoritative no-delta detector and
  // already drives the visible indicator via streamMetrics.stallEpisode, so
  // this repaints and does not duplicate or fight it.
  const looseTurnsFeed = events.turns as unknown as LooseTurnEventFeed;
  unsubs.push(looseTurnsFeed.on('STREAM_STALL', () => {
    render();
  }));

  unsubs.push(events.tools.on('TOOL_RECEIVED', (ev) => {
    // Bounded: a turn that never finishes its calls cannot grow this without limit.
    if (metrics.toolArgsByCallId.size >= 64) metrics.toolArgsByCallId.delete(metrics.toolArgsByCallId.keys().next().value!);
    metrics.toolArgsByCallId.set(ev.callId, ev.args ?? {});
  }));
  unsubs.push(events.tools.on('TOOL_EXECUTING', (ev) => {
    // Re-inserted last, so the map stays in start order; bounded like the arguments.
    metrics.runningTools.delete(ev.callId);
    metrics.runningTools.set(ev.callId, { name: ev.tool, startedAtMs: ev.startedAt });
    if (metrics.runningTools.size > 64) metrics.runningTools.delete(metrics.runningTools.keys().next().value!);
    render();
  }));
  // On every tool-completion path, reset lastDeltaAtMs to "now" so the
  // post-tool silence window starts fresh. Tool execution suppresses stall
  // detection at the render call site (see main.ts), but lastDeltaAtMs itself
  // keeps its pre-tool value the whole time the tool runs, without this
  // reset, the instant a tool completes (potentially long after the last real
  // delta), the very next frame would read msSinceLastDelta as the full
  // tool-execution duration and immediately report a stall, even though the
  // model hasn't had a chance to resume producing tokens yet.
  unsubs.push(events.tools.on('TOOL_SUCCEEDED', (ev) => {
    metrics.toolArgsByCallId.delete(ev.callId);
    metrics.runningTools.delete(ev.callId);
    metrics.lastDeltaAtMs = Date.now();
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', (ev) => {
    metrics.toolArgsByCallId.delete(ev.callId);
    metrics.runningTools.delete(ev.callId);
    metrics.lastDeltaAtMs = Date.now();
  }));
  unsubs.push(events.tools.on('TOOL_CANCELLED', (ev) => {
    metrics.toolArgsByCallId.delete(ev.callId);
    metrics.runningTools.delete(ev.callId);
    metrics.lastDeltaAtMs = Date.now();
  }));

  let _errorSurfacedCb: ((exhausted: boolean) => void) | undefined;
  function notifyErrorSurfaced(exhausted: boolean) { _errorSurfacedCb?.(exhausted); }
  return {
    unsubs,
    startNewTurn: () => { userTurn.supersede(); },
    onErrorSurfaced: (cb: (exhausted: boolean) => void) => { _errorSurfacedCb = cb; },
  };
}
