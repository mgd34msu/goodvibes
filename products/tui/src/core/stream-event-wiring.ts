import type { UiRuntimeEvents } from '@/runtime/index.ts';
import type { NoticeLevel } from '@goodvibes-jev/engine/platform/platform/core';
import type { StreamMetrics } from './stream-metrics.ts';
import { createStreamStallWatchdog, type StallTimers } from './stream-stall-watchdog.ts';
import { buildRoutingChip } from './model-routing-chip.ts';
import { userErrorLine } from './format-user-error.ts';
import { describeUserError, readUserErrorClass, type UserFacingError } from '@goodvibes-jev/engine/platform/platform/routing';
import { createUserTurnOwner, type FailoverRetry, type UserTurnOwner } from './user-turn.ts';
import { ProviderSetupReadings, describeProviderSetup, type ProviderSetupClassification } from '../providers/provider-classification.ts';
import type { FailoverTurnState } from './active-model-identity.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { FailoverChoice, ProviderRuntimeMetadata, ReasoningEffortSpec } from '@goodvibes-jev/engine/platform/platform/providers';
import { remapEffortForServingModel } from '../providers/reasoning-effort-surface.ts';

// Preserve the existing wiring API while shared-state consumers use the leaf.
export { createStreamMetrics, type StreamMetrics } from './stream-metrics.ts';

/** Minimal orchestrator surface required for stream token-speed calculation. */
interface StreamOrchestrator {
  readonly streamingOutputTokens: number;
}

/** Minimal provider surface required for the stream stall watchdog and failover switching. */
interface StreamProviderRegistry {
  getCurrentModel(): {
    readonly provider: string;
    readonly registryKey?: string;
    /**
     * Model id, display name and reasoning-effort spec, all optional so a test
     * double carrying only provider/registryKey still satisfies this surface.
     * When the id is present the failover path can re-resolve the configured
     * reasoning level against the model that is about to serve; when it is
     * absent that step is skipped rather than guessed at.
     */
    readonly id?: string;
    readonly displayName?: string;
    readonly reasoningEffort?: ReasoningEffortSpec | undefined;
  };
  setCurrentModel(registryKey: string): void;
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

/** Runtime guard validating an unknown STREAM_RETRY-like payload's shape. */
/**
 * Minimal cost lookup surface for attaching cost-delta information to failover notices.
 * Returns USD-per-1M-token pricing for the given model ID, or null when the
 * catalog honestly does not know the model (never a fabricated zero).
 */
export interface FailoverCostLookup {
  getCostFromCatalog(modelId: string): { readonly input: number; readonly output: number } | null;
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
  /** Where switches are logged (the routing chip reads the log so a failover is not narrated twice). */
  readonly providerOptimizer?: FailoverOptimizer;
  /**
   * The engine's failover owner (providers/failover.ts) bound to this
   * session's registry and settings: given the model that failed on every
   * sign-in of its provider and the keys tried this turn, the person's next
   * fallback model, or a stop with its reason and next step. Absent, a
   * failure surfaces as an error and nothing else is tried.
   */
  readonly chooseFailover?: (failed: { readonly registryKey: string; readonly provider: string; readonly displayName: string }, visited: ReadonlySet<string>) => FailoverChoice;
  /**
   * Callback the caller provides to re-submit the last user turn on a
   * different model after a failover switch. Called only when the person's
   * fallback order names a model not yet tried this turn.
   *
   * The re-submission rolls the conversation back to its pre-submission
   * message count, which deletes everything the failed turn added, including
   * a failover notice appended before the call. So the notice is passed IN
   * rather than emitted before: the caller re-posts it after its rollback, and
   * it survives to be read. Implementations that do not roll back may ignore
   * the argument, but must then post the notice themselves.
   *
   * The retry is the user turn's own (FailoverRetry): a deferred submit
   * rechecks `retry.isCurrent()` after its preparatory await, calls
   * `retry.submitting()` right before it submits so that submission continues
   * the same user turn, and calls `retry.abandon()` when it never submitted,
   * which ends the turn as failed.
   *
   * Returns whether the retry was accepted for submission. False means there was
   * nothing to retry (no pre-submission snapshot, the failed turn did not
   * come from the composer) and the notice was NOT posted, so this wiring
   * narrates the switch and surfaces the error itself rather than let a turn end
   * in silence on a backend the user did not choose.
   */
  readonly retryTurn?: (notice: string, retry: FailoverRetry) => boolean;
  /**
   * Optional cost catalog for attaching per-1M-token cost information to
   * the failover notice.  When provided and both models have non-zero pricing,
   * the notice includes input and output cost comparisons.  When absent or pricing is
   * unavailable for either model, the notice honestly states "cost data unavailable".
   */
  readonly costLookup?: FailoverCostLookup;
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
   * Shared holder for the live failover record (core/active-model-identity.ts).
   * Set when failover switches the registry off the user's configured
   * selection, cleared once serving is restored to it. The render frame reads
   * the same object, so the header and footer describe the switch while it is
   * in effect. Omitted by unit tests that only exercise notice content.
   */
  readonly failoverState?: FailoverTurnState;
  /**
   * The user's configured model selection (config `provider.model`) as a
   * registry key. Read at the moment of a failover switch so the turn-end
   * restore targets what the user actually chose, not whatever the registry
   * happened to hold. Without it, failover still works but no restore or
   * divergence marker is possible, so both are skipped rather than guessed at.
   */
  readonly getConfiguredRegistryKey?: () => string | undefined;
  /**
   * The user's configured reasoning level (config `provider.reasoningEffort`).
   * Read at the moment of a failover switch so the level can be re-resolved
   * against the model that is about to serve: a level the configured model
   * offers may not exist on the fallback, and sending it unchanged is how a
   * failover turns into a provider-side 400 the user cannot explain. Omitted
   * means the re-resolution is skipped entirely, never guessed.
   */
  readonly getConfiguredReasoningEffort?: () => string | undefined;
}

/** Result of wireStreamEventMetrics. */
export interface WireStreamEventMetricsResult {
  /** Unsubscribe functions; push into the parent unsubs array for cleanup on exit. */
  readonly unsubs: ReadonlyArray<() => void>;
  /**
   * A new prompt is about to be submitted: a user turn that has not ended
   * (one failing over, or one whose stream stopped without a terminal event)
   * is replaced, and serving is put back on the user's configured selection
   * if a failover left it elsewhere, before the new turn picks its model.
   */
  readonly startNewTurn: () => void;
  /** Cancel a failover retry that has not started yet (no attempt is running, so the platform has nothing to abort). */
  readonly cancelPendingRecovery: () => boolean;
  /**
   * Register a callback that fires whenever a TURN_ERROR is surfaced to the
   * user, either immediately (no optimizer) or after chain exhaustion.
   * Does NOT fire when the optimizer performs a successful automatic failover
   * (in that case the user sees a [Failover] notice, not an error).
   * Used by main.ts to activate the one-key retry affordance. The callback
   * receives exhausted=true when the failover chain was exhausted first, so
   * the notice can say honestly that a retry reuses the same failed provider.
   */
  readonly onErrorSurfaced: (cb: (exhausted: boolean) => void) => void;
}

/**
 * Build the cost-delta suffix for a failover notice.
 *
 * Extracts the model ID from registry keys (format: `provider:modelId`),
 * queries the cost catalog for both, and formats a human-readable comparison.
 * If the lookup is absent or either model returns zero pricing (unknown),
 * returns an honest "cost data unavailable" suffix instead of fabricating values.
 *
 * @param lookup - Optional cost catalog; when absent, returns unavailable notice.
 * @param fromRegistryKey - Registry key of the provider being abandoned (may be undefined).
 * @param toRegistryKey - Registry key of the provider being selected.
 * @returns A parenthesised suffix string or empty string.
 */
function buildCostDeltaSuffix(
  lookup: FailoverCostLookup | undefined,
  fromRegistryKey: string | undefined,
  toRegistryKey: string,
): string {
  if (!lookup) return '';
  // Registry key format: `provider:modelId`, modelId may itself contain `:`.
  const fromModelId = fromRegistryKey ? fromRegistryKey.split(':').slice(1).join(':') : '';
  const toModelId = toRegistryKey.split(':').slice(1).join(':');
  // A null catalog answer means honestly unknown, treated exactly like the
  // legacy zero-pricing sentinel below.
  const fromCost = (fromModelId ? lookup.getCostFromCatalog(fromModelId) : null) ?? { input: 0, output: 0 };
  const toCost = lookup.getCostFromCatalog(toModelId) ?? { input: 0, output: 0 };
  // Report unavailable when either side has no pricing (unknown model).
  if (fromCost.input === 0 && fromCost.output === 0 && !fromModelId) {
    return ' [cost data unavailable]';
  }
  const hasFromData = fromCost.input > 0 || fromCost.output > 0;
  const hasToData = toCost.input > 0 || toCost.output > 0;
  if (!hasFromData || !hasToData) {
    return ' [cost data unavailable]';
  }
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return ` [cost/1M: input ${fmt(fromCost.input)}→${fmt(toCost.input)}, output ${fmt(fromCost.output)}→${fmt(toCost.output)}]`;
}

/**
 * The suffix of the failover billing line, e.g. `[Failover] billing: API key →
 * Subscription: billing class changed`, when both classes are known and differ.
 *
 * This path is NOT the synthetic provider's tier-isolated failover, which is
 * where the documented "free, paid and subscription tiers never mix" contract
 * lives (docs/providers-and-routing.md:77-128, enforced in the platform's
 * synthetic.ts by CanonicalModel.tier). The optimizer chain consumed here
 * carries no tier metadata at all, its nodes are
 * `{ position, providerId, modelId, capable, explanation }` and `explanation`
 * describes functional capability (streaming, tool calling, context size),
 * never billing. So the switch cannot be constrained by a tier it cannot see;
 * what it CAN do is say out loud which billing class it moved to, so a user
 * who does not want their subscription spent on an automatic retry can object
 * and turn the optimizer off.
 *
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
    systemMessageRouter, render, providerOptimizer, chooseFailover, retryTurn, costLookup,
    isApprovalPending, stallThresholdMs, stallTimers, failoverState, getConfiguredRegistryKey,
    getConfiguredReasoningEffort,
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
  // A tool started in this attempt. Re-submitting the turn on another provider would run it again.
  let toolStartedInTurn = false;
  unsubs.push(userTurn.onStart(() => { toolStartedInTurn = false; }));

  /**
   * Deliver a provider-switch notice to the conversation unconditionally.
   * Prefers the router's userReceipt channel, which skips the noise gate and
   * the ui.operationalMessages routing target entirely, so the line cannot be
   * filtered away by a preference and is treated as real content even while
   * the splash still owns the screen. Falls back to high() for bare doubles.
   */
  const announce = (message: string): void => {
    if (systemMessageRouter.userReceipt) systemMessageRouter.userReceipt(message);
    else systemMessageRouter.high(message);
  };

  /**
   * Registry keys THIS module switched to and narrated itself, counted. The
   * MODEL_CHANGED listener consumes one instead of emitting the generic
   * routing chip, so neither half of a failover is narrated twice: the switch
   * out is announced by `[Failover] from -> to (reason)` and the switch back by
   * `[Failover] Restored …`. The key is the one the registry reports after the
   * switch, which is the key its MODEL_CHANGED carries; the registry emits that
   * event for every switch it makes, so each entry is consumed by its own event
   * and no time window is needed.
   */
  const selfNarratedSwitches = new Map<string, number>();

  /**
   * Run a registry switch this module narrates itself, with the chip suppressed
   * for it. Returns the effort-remap sentence when the switch changed the level
   * that goes on the wire, for the CALLER to place, see
   * reconcileEffortWithServingModel for why it is not announced here.
   */
  let switchInProgress: { seen: boolean } | undefined;
  const switchNarrated = (registryKey: string): string | undefined => {
    // A feed that delivers MODEL_CHANGED inside setCurrentModel is matched by
    // this marker; one that delivers it later, by the recorded key.
    const marker = { seen: false };
    switchInProgress = marker;
    try {
      providerRegistry.setCurrentModel(registryKey);
    } finally {
      switchInProgress = undefined;
    }
    if (!marker.seen) {
      const switched = providerRegistry.getCurrentModel().registryKey ?? registryKey;
      selfNarratedSwitches.set(switched, (selfNarratedSwitches.get(switched) ?? 0) + 1);
    }
    return reconcileEffortWithServingModel();
  };

  /**
   * Re-resolve the REQUESTED reasoning level against whichever model is now
   * serving, and hand back the sentence that says so when it had to change.
   *
   * Both halves of a failover come through switchNarrated, so this covers the
   * switch out and the switch back. The requested level is left untouched in
   * config, the fallback is temporary and the user's choice must survive it,
   * but the level actually sent is the resolved one, and the platform's own sentence
   * explaining the remap is surfaced verbatim rather than reworded.
   *
   * The sentence is RETURNED rather than announced. On the failover-out path
   * this function runs before retryTurn, and retryTurn rolls the conversation
   * back to its pre-submission message count, which deleted this notice every
   * time, exactly as it used to delete the failover notice itself. The caller
   * folds it into the notice it hands to retryTurn so it survives the rollback;
   * the restore path, which has no rollback after it, announces it directly.
   */
  const reconcileEffortWithServingModel = (): string | undefined => {
    const serving = providerRegistry.getCurrentModel();
    if (!serving.id) return undefined; // no model id on this surface: nothing to resolve against
    const model = {
      id: serving.id,
      provider: serving.provider,
      ...(serving.displayName ? { displayName: serving.displayName } : {}),
      ...(serving.reasoningEffort ? { reasoningEffort: serving.reasoningEffort } : {}),
    };
    // getConfiguredReasoningEffort reads config `provider.reasoningEffort`,
    // the REQUESTED level. It must never be re-seeded from a previously snapped
    // effective value, or a single failover onto a capped model would ratchet
    // the level down for the rest of the session.
    const requested = getConfiguredReasoningEffort?.();
    if (requested === undefined || requested === '') return undefined;
    return remapEffortForServingModel(requested, model).note;
  };

  /** True when this MODEL_CHANGED is one of our own narrated switches (consumes the record). */
  const wasSelfNarrated = (registryKey: string): boolean => {
    const pending = selfNarratedSwitches.get(registryKey);
    if (pending === undefined) return false;
    if (pending <= 1) selfNarratedSwitches.delete(registryKey);
    else selfNarratedSwitches.set(registryKey, pending - 1);
    return true;
  };

  /**
   * Put serving back on the user's configured selection after a failed-over
   * turn ends.
   *
   * Failover is per-turn recovery, not a permanent re-selection. Without this,
   * the one setCurrentModel() call that rescued a single failed turn stayed in
   * force for the rest of the session: every later turn ran on the fallback
   * backend while nothing in the session state or the footer had changed to
   * say so. The user's configured selection is authoritative, so the NEXT turn
   * starts from it again. If that backend is still unhealthy, the normal
   * per-turn failover handles it again, visibly, with a fresh notice, which
   * is exactly the behaviour a sticky override was hiding.
   *
   * The record is kept (not cleared) when the restore itself fails, so the
   * header and footer keep reporting the real serving backend rather than
   * claiming a revert that did not happen.
   */
  const restoreConfiguredSelection = (): void => {
    const record = failoverState?.current();
    if (!record || !failoverState) return;
    if (providerRegistry.getCurrentModel().registryKey === record.configuredRegistryKey) {
      failoverState.clear();
      return;
    }
    try {
      const effortNote = switchNarrated(record.configuredRegistryKey);
      failoverState.clear();
      // Nothing rolls the transcript back after this point, so the restore line
      // and any effort remap that came with it are announced directly.
      announce(
        `[Failover] Restored ${record.configuredRegistryKey} for the next turn.`
        + (effortNote ? `\n[Failover] ${effortNote}` : ''),
      );
    } catch (restoreErr) {
      logger.debug('failover restore failed', {
        configuredRegistryKey: record.configuredRegistryKey, error: String(restoreErr),
      });
      announce(
        `[Failover] Could not switch back to ${record.configuredRegistryKey}; still serving ${record.servingRegistryKey}.`,
      );
    }
    render();
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

  // Per-user-turn set of the models (registry keys) already tried this turn, so
  // failover cannot ping-pong between two failing models: at most one attempt
  // per model per user turn. Cleared when the user turn ends.
  const failoverVisited = new Set<string>();

  // However the user turn ended (completed, failed, cancelled while failing
  // over, or replaced by a new prompt), the failover's authority over the
  // registry ends with it.
  unsubs.push(userTurn.onEnd(() => {
    metrics.modelActive = false;
    // No call of an ended turn is still main's running work.
    metrics.runningTools.clear();
    failoverVisited.clear();
    restoreConfiguredSelection();
  }));

  // Routing chip (never-silent model change): every MODEL_CHANGED that is not
  // already narrated by the richer [Failover] line becomes a one-line
  // conversation notice. Deferred a microtask so a failover's
  // recordFallbackTransition (which runs right AFTER its setCurrentModel) has
  // landed in the fallback log before buildRoutingChip checks for correlation.
  // Degrade gracefully when a bare test double omits the providers feed.
  if (events.providers) {
    unsubs.push(events.providers.on('MODEL_CHANGED', (change) => {
      if (switchInProgress) { switchInProgress.seen = true; return; } // a [Failover] line says this, with its reason
      if (wasSelfNarrated(change.registryKey)) return;
      queueMicrotask(() => {
        const chip = buildRoutingChip(change, providerOptimizer?.fallbackLog ?? [], Date.now());
        if (chip === null) return;
        systemMessageRouter.high(chip);
        render();
      });
    }));
  }

  /**
   * The billing class of each side of a switch, read after the switch is made
   * and announced on its own line, so failover never waits on it. The cached
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
   * One failed attempt. Everything here is decided from facts already held,
   * at once: the error line from the status and errno, whether failover may
   * run, the next provider, the switch. The user turn ends failed unless this
   * starts a failover retry (userTurn decides that from failOver()).
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
    const stillCurrent = () => failure.isCurrent() && options.isActive?.() !== false;
    if (options.isActive?.() === false) return;
    // Only a shown error line is refined: a failover notice already names the
    // class, and an [Error] line beside a running retry would read as the end.
    const surface = (exhausted: boolean): void => {
      systemMessageRouter.high(`[Error] ${errorClass}`, 'error');
      notifyErrorSurfaced(exhausted);
      render();
      refineErrorLater(errVal, shown, failure.isLatestAttempt);
    };
    // Failover re-submits the whole user turn, which is only safe when the failure was the
    // provider's and nothing has run yet: a denied call would be asked again, and tools
    // already executed would run a second time with their results rolled out of the transcript.
    // An event without a stop reason comes from an older emitter and is read as a provider failure.
    // The same model on the provider's other sign-ins was already tried inside the request
    // (OpenAI: subscription, then API key); what is left is the person's own fallback order.
    const providerFailure = event.stopReason === undefined || event.stopReason === 'provider_error' || event.stopReason === 'provider_exhausted';
    if (!providerFailure || toolStartedInTurn || chooseFailover === undefined || retryTurn === undefined) {
      surface(false);
      return;
    }
    const failed = providerRegistry.getCurrentModel();
    const fromProvider = failed.provider;
    const fromRegistryKey = failed.registryKey ?? `${failed.provider}:${failed.id ?? ''}`;
    failoverVisited.add(fromRegistryKey);
    const choice = chooseFailover({ registryKey: fromRegistryKey, provider: fromProvider, displayName: failed.displayName ?? failed.id ?? fromRegistryKey }, failoverVisited);
    if (choice.kind === 'stop') {
      // Nothing else is tried: the error, why nothing else was tried, and what to do next.
      systemMessageRouter.high(`[Error] ${errorClass}`, 'error');
      announce(`[Failover] Stopped: ${choice.reason} ${choice.next}`);
      notifyErrorSurfaced(true);
      render();
      refineErrorLater(errVal, shown, failure.isLatestAttempt);
      return;
    }
    const toRegistryKey = choice.registryKey;
    // The effort remap that comes with the switch is carried, not announced:
    // retryTurn's rollback below would delete it (see reconcileEffortWithServingModel).
    let effortNote: string | undefined;
    try {
      effortNote = switchNarrated(toRegistryKey);
    } catch (switchErr) {
      // Switch failed: the honest error stands and the user turn ends.
      logger.debug('failover setCurrentModel failed', { toRegistryKey, error: String(switchErr) });
      surface(false);
      return;
    }
    // Record the chosen model as tried before the retry fires so a later
    // failure of it moves on down the order.
    failoverVisited.add(toRegistryKey);
    // Remember the user's configured selection so the turn-end restore
    // targets it, and so both shell surfaces can name it while the switch
    // is in force. Sticky across a second hop within the same turn.
    const configuredRegistryKey = getConfiguredRegistryKey?.();
    if (configuredRegistryKey) {
      failoverState?.begin({ configuredRegistryKey, servingRegistryKey: toRegistryKey });
    }
    providerOptimizer?.recordFallbackTransition(fromProvider, choice.provider, errorClass);
    const costSuffix = buildCostDeltaSuffix(costLookup, fromRegistryKey, toRegistryKey);
    // Handed to retryTurn so it outlives that call's transcript rollback (see
    // the retryTurn option doc). Emitting it here instead would delete it.
    const failoverNotice = `[Failover] ${fromRegistryKey} -> ${toRegistryKey}, ${choice.because} (${errorClass})${costSuffix}`
      + (effortNote ? `\n[Failover] ${effortNote}` : '');
    const retry = failure.failOver();
    const guarded: FailoverRetry = {
      signal: retry.signal,
      isCurrent: () => retry.isCurrent() && options.isActive?.() !== false
        && providerRegistry.getCurrentModel().registryKey === toRegistryKey,
      submitting: retry.submitting,
      abandon: retry.abandon,
    };
    try {
      if (retryTurn(failoverNotice, guarded)) {
        narrateBilling(fromProvider, choice.provider, stillCurrent);
        render();
        return;
      }
    } catch (error) {
      logger.debug('failover retry failed to start', { error: String(error) });
    }
    // No turn to re-submit (the failed turn did not come from the composer,
    // so there is no pre-submission snapshot to roll back to). The registry
    // has still MOVED, so the switch is narrated and the original error
    // surfaces; abandoning the retry ends the user turn, which restores the
    // configured selection.
    announce(failoverNotice);
    surface(false);
    retry.abandon();
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
    toolStartedInTurn = true;
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
    // A new user submission is also a turn boundary: restore here too, so a
    // turn that ended without any terminal event (an aborted stream that
    // emitted neither TURN_COMPLETED nor TURN_CANCEL) still cannot leave the
    // next turn silently pinned to a fallback backend.
    startNewTurn: () => { userTurn.supersede(); restoreConfiguredSelection(); },
    cancelPendingRecovery: () => {
      if (!userTurn.cancel()) return false;
      render();
      return true;
    },
    onErrorSurfaced: (cb: (exhausted: boolean) => void) => { _errorSurfacedCb = cb; },
  };
}
