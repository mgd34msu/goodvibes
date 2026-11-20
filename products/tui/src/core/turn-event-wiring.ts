import { buildPersistedSessionContextFromFacts, type CrashSnapshotTurnMoment } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { UiRuntimeEvents, RuntimeEventBus } from '@/runtime/index.ts';
import { deleteRecoveryFile, persistConversation } from '@/runtime/index.ts';
import { writeCrashSnapshotIfChanged } from '../runtime/recovery-autosave.ts';
import { markConversationDurable } from './session-resume-core.ts';
import { buildCompactionReceiptBlock } from './compaction-receipt.ts';
import { workstreamFailureNotification } from './workstream-notification.ts';
import { captureTurnAnchor, persistTurnAnchors, recordTurnAnchor } from '@goodvibes/engine/platform/platform/rewind';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { HookDispatcher, HookPhase, HookCategory, HookEventPath } from '@goodvibes/engine/platform/platform/hooks';
import type { ConversationManager } from './conversation.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { openSessionHere, writeCrashSnapshotAtTurnMoments } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { WebhookNotifier } from '@goodvibes/engine/platform/platform/integrations';
import { notifyNow } from '@goodvibes/engine/platform/platform/utils';
import { maybeNotifyLongTask, readNotifyAfterSeconds } from './long-task-notifier.ts';
import type { FocusTracker } from '@goodvibes/engine/platform/platform/runtime/operations';
import {
  shouldFireAlert,
  NOTIFICATION_TEXT_LIMITS,
  TurnActivityTally,
  buildTurnNotificationLine,
  readNotificationsMetadataOnly,
  resolveTurnName,
  trimAtWordBoundary,
  type TurnOutcome,
} from '@goodvibes/engine/platform/platform/runtime/operations';
import { createBudgetBreachNotifier, type BudgetBreachNotifier } from './budget-breach-notifier.ts';
import { createUserTurnOwner, type UserTurnEnd, type UserTurnOwner } from './user-turn.ts';
import { readBudgetAlertUsd } from '@goodvibes/engine/platform/platform/providers';

/** Minimal orchestrator surface required by turn-event wiring. */
interface TurnOrchestrator {
  readonly lastInputTokens: number;
  /** Cumulative session usage, same object the usage modal reads, used here for budget-breach checks. */
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  /**
   * The platform Orchestrator's own end-of-turn popup; handOff() silences it while
   * this wiring's long-task notice owns the popup and returns the release.
   * Optional so bare test doubles still satisfy the type.
   */
  readonly turnEndNotice?: { handOff(): () => void };
}

/** Minimal provider registry surface required by turn-event wiring. */
interface TurnProviderRegistry {
  getCurrentModel(): { readonly contextWindow: number; readonly id?: string };
  getContextWindowForModel(model: { readonly contextWindow: number }): number;
}

/** Minimal config manager surface required by turn-event wiring. */
interface TurnConfigManager {
  get(key: string): unknown;
  /** Subscribe to a config-key change; returns an unsubscribe. Used to keep the
   *  footer permission-mode pill live without polling. Optional so bare test
   *  doubles that only implement get() still satisfy the type. */
  subscribe?(key: string, cb: (...args: unknown[]) => void): () => void;
}

/** Minimal system message router surface required by turn-event wiring. */
interface TurnSystemMessageRouter {
  high(message: string): void;
  low(message: string): void;
  routeSystemMessage(message: string, level: string): void;
}

export interface WireTurnEventHandlersOptions {
  readonly events: UiRuntimeEvents;
  /**
   * Raw runtime event bus. Needed for domains NOT surfaced by the grouped
   * UiRuntimeEvents feed, specifically the 'compaction' domain, whose
   * mandatory COMPACTION_RECEIPT the transcript renders as a distinct block.
   * Optional so headless/test callers can omit it.
   */
  readonly runtimeBus?: RuntimeEventBus | null;
  readonly conversation: ConversationManager;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly orchestrator: TurnOrchestrator;
  readonly configManager: TurnConfigManager;
  readonly providerRegistry: TurnProviderRegistry;
  readonly systemMessageRouter: TurnSystemMessageRouter;
  readonly hookDispatcher: HookDispatcher;
  /**
   * The app's declare-once session-storage handle. The turn snapshot, the
   * last-session pointer it writes, the crash snapshot, and the rewind
   * anchor sidecar all resolve off this one handle, so the boot notice and
   * `--continue`, which read through the same handle, land on the files this
   * writer actually produced.
   */
  readonly surface: SessionSurface;
  readonly gitStatusProvider: { refresh(): Promise<unknown> };
  readonly lastGitInfoRef: { value: unknown };
  readonly buildSessionContinuityHints: () => Parameters<typeof buildPersistedSessionContextFromFacts>[2];
  readonly render: () => void;
  /**
   * Outbound webhook notifier. When provided and URLs are configured,
   * long-task push notifications are delivered to configured ntfy/webhook
   * endpoints after the configured threshold. Optional, silently skipped
   * when absent.
   */
  readonly webhookNotifier?: WebhookNotifier | null;
  /**
   * Terminal focus tracker. Gates the long-task, budget-breach, and
   * agent/chain-failure desktop alerts wired in this module, see
   * alert-gating.ts. Optional; when absent, none of the new alert
   * behavior is gated by focus (long-task keeps its always-fire
   * behavior from before focus gating existed, and budget-breach/failure alerts are
   * skipped entirely, since they have no pre-existing unconditional-fire path
   * to fall back to).
   */
  readonly focusTracker?: Pick<FocusTracker, 'shouldAlertWhenUnfocused'> | null;
  /**
   * Optional in-terminal (OSC 9) notifier. When present: a turn finishing emits
   * a 'turn-end' notification, and a delegated agent blocking on human input
   * (AGENT_AWAITING_MESSAGE) emits an 'agent-blocked' notification. Each is
   * gated independently by the notifier's own per-signal config + focus rule.
   * Absent in tests/headless.
   */
  readonly terminalNotifier?: import('./terminal-notifier.ts').TerminalNotifier | null;
  /**
   * Desktop delivery for the turn, budget, agent and workstream notices wired
   * here, once each caller has decided the notice is due; defaults to the
   * platform notifyNow. Tests pass a spy to read the text.
   */
  readonly notifyDesktop?: typeof notifyNow;
  /**
   * The terminal bell for a turn over 5s that did not reach the desktop popup
   * (the popup rings it itself); defaults to writing BEL to stdout, which is
   * what the platform Orchestrator's own popup did before this wiring took it over.
   */
  readonly ringBell?: () => void;
  /**
   * The shell's one user-turn owner (core/user-turn.ts), shared with the
   * stream wiring, which retries a failed attempt on another provider: the
   * end-of-turn notice follows the user turn, not each attempt. Omitted, this
   * wiring owns a private one on the same feed (a caller that wires it alone).
   */
  readonly userTurn?: UserTurnOwner;
  /**
   * Minimal test seam: injectable clock for controlling Date.now() in tests.
   * Defaults to the real Date.now when absent.
   * @internal, tests only
   */
  readonly _clock?: () => number;
}

/** The Orchestrator's own popup rang the bell for a turn over this long. */
const TURN_BELL_AFTER_MS = 5_000;

/** The Orchestrator's own popup came for a turn over this long (platform notifyCompletion). */
const TURN_DESKTOP_AFTER_MS = 30_000;

/** Most agent/workstream names kept at once; a lost terminal event cannot grow the maps unbounded. */
const MAX_REMEMBERED_NAMES = 256;

function rememberBounded<V>(map: Map<string, V>, id: string, value: V): void {
  map.delete(id);
  map.set(id, value);
  while (map.size > MAX_REMEMBERED_NAMES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function normalizeTitleSource(source: unknown): 'user' | 'system' | null {
  return source === 'user' || source === 'system' ? source : null;
}

export interface WireTurnEventHandlersResult {
  /** Trigger a git status refresh; may be called from external code after tool execution. */
  readonly refreshGit: () => void;
  /** Unsubscribe functions to push into the parent unsubs array. */
  readonly unsubs: ReadonlyArray<() => void>;
}

/**
 * Wire TURN_COMPLETED, TOOL_SUCCEEDED, and TOOL_FAILED runtime events.
 *
 * Responsibilities:
 *   - Auto-save conversation to persistent store after each LLM turn
 *   - Fire the Lifecycle:session:save hook
 *   - Refresh git status after turns and tool results
 *
 * Note: auto-compaction is intentionally NOT performed here. The platform
 * Orchestrator already runs post-turn context maintenance every turn
 * (handlePostTurnContextMaintenance) using the resolved context window and
 * its own getAutoCompactDecision; re-triggering it from the TUI duplicated
 * that work and raced the platform's compaction on the shared message array.
 *
 * Returns refreshGit (callable externally) and unsubs (push into parent unsubs).
 */
export function wireTurnEventHandlers(options: WireTurnEventHandlersOptions): WireTurnEventHandlersResult {
  const {
    events,
    conversation,
    runtime,
    configManager,
    hookDispatcher,
    orchestrator,
    providerRegistry,
    surface,
    gitStatusProvider,
    lastGitInfoRef,
    buildSessionContinuityHints,
    render,
    webhookNotifier,
    focusTracker,
    terminalNotifier,
    runtimeBus,
    systemMessageRouter,
    notifyDesktop = notifyNow,
    ringBell = () => {
      process.stdout.write('\x07');
    },
    _clock = Date.now,
  } = options;

  const unsubs: Array<() => void> = [];
  const userTurn = options.userTurn ?? createUserTurnOwner({ turns: events.turns, sessionId: () => runtime.sessionId, clock: _clock });
  if (options.userTurn === undefined) unsubs.push(() => userTurn.dispose());
  const configGet = (key: string): unknown => configManager.get(key);

  // ONE POPUP PER TURN. The long-task notice below owns the turn's desktop
  // popup: it names the turn, counts what it did, honors
  // behavior.notifyAfterSeconds and the unfocused-only gate, and reaches the
  // webhook. The platform Orchestrator pops its own end-of-turn notice too, so it
  // is handed off here for as long as this wiring lives.
  const releaseTurnEndNotice = orchestrator.turnEndNotice?.handOff();
  if (releaseTurnEndNotice) unsubs.push(releaseTurnEndNotice);

  // The crash snapshot: one copy of the conversation, written when a prompt is
  // accepted and after each tool batch (the rule both terminal apps share,
  // runtime/session-persistence.ts) and when the turn-end save fails, each time
  // only if the conversation changed since its last write. A successful
  // turn-end save deletes it, so a snapshot on disk always holds something the
  // session store does not.
  const writeCrashSnapshot = (moment: CrashSnapshotTurnMoment = 'TURN_COMPLETED'): void => {
    // The session lock's backstop: a hold that another process had (a forced resume) is taken once it left.
    openSessionHere(surface, runtime.sessionId);
    writeCrashSnapshotIfChanged({ conversation, sessionId: runtime.sessionId, surface, buildSessionContinuityHints, moment });
  };
  unsubs.push(writeCrashSnapshotAtTurnMoments({
    subscribe: (moment, handler) => events.turns.on(moment, handler),
    write: writeCrashSnapshot,
  }));

  // Set while a user turn runs (failover retries included); gates the activity tally.
  let turnStartTime: number | null = null;

  // What names the turn and what it did, for the end-of-turn notices
  // (platform runtime/turn-notification.ts): the submitted text, and a tally of
  // tool calls, changed files, agents started and the latest review score.
  let readTurnText: (() => string | null) | null = null;
  let lastTurnName: string | null = null;
  const tally = new TurnActivityTally();
  const nameCurrentTurn = (): string | null =>
    resolveTurnName({
      title: conversation.title,
      titleSource: normalizeTitleSource(conversation.getTitleSource()),
      turnText: readTurnText?.(),
    });

  // Task text for agents and workstreams, from their opening events; the
  // terminal events carry only the id. Bounded, dropped at the terminal event.
  const agentTasks = new Map<string, () => string>();
  const workstreams = new Map<string, () => string>();

  // Budget-breach edge-trigger checker, one instance per session,
  // piggybacking on the same TURN_COMPLETED handler as the long-task
  // notification below rather than adding a second TURN_COMPLETED subscription.
  const budgetBreachNotifier: BudgetBreachNotifier | null = focusTracker
    ? createBudgetBreachNotifier({
        focusTracker,
        configGet,
        webhookNotifier: webhookNotifier ?? null,
        sessionId: runtime.sessionId,
        getSessionId: () => runtime.sessionId,
        getTurnName: () => lastTurnName,
        notifyDesktop,
      })
    : null;

  // Set while auto-saves keep failing, so one failure streak warns once, not on every turn.
  let autoSaveFailureShown = false;

  /**
   * The end of a user turn, however it ended (the user-turn owner decides,
   * failover retries included): the in-terminal (OSC 9) notice on its own
   * per-signal config + focus gate, then the long-task desktop and webhook
   * notice past behavior.notifyAfterSeconds, then the budget-breach check.
   * A turn a new prompt or a session switch replaced is not told.
   */
  const notifyTurnEnd = (end: UserTurnEnd): void => {
    turnStartTime = null;
    if (end.outcome === 'superseded') return;
    const outcome: TurnOutcome = end.outcome;
    const turnElapsedMs = end.startedAt !== null ? _clock() - end.startedAt : 0;
    const metadataOnly = readNotificationsMetadataOnly(configGet);
    const reason = metadataOnly ? null : end.reason;
    const name = metadataOnly ? null : nameCurrentTurn();
    lastTurnName = name;
    const activity = tally.snapshot();
    terminalNotifier?.notify(
      'turn-end',
      buildTurnNotificationLine(
        {
          outcome,
          elapsedMs: turnElapsedMs,
          name,
          reason,
          sessionId: runtime.sessionId,
          ...activity,
        },
        { metadataOnly },
        NOTIFICATION_TEXT_LIMITS.terminal,
      ),
    );
    const notifyOnComplete = configGet('behavior.notifyOnComplete') !== false;
    const popped = maybeNotifyLongTask({
      elapsedMs: turnElapsedMs,
      status: outcome === 'completed' ? 'ok' : 'fail',
      outcome,
      name,
      reason,
      activity,
      metadataOnly,
      kind: 'turn',
      sessionId: runtime.sessionId,
      thresholdSeconds: readNotifyAfterSeconds(configGet),
      webhookNotifier: webhookNotifier ?? null,
      focusTracker,
      configGet,
      notifyDesktop,
      desktop: notifyOnComplete,
      // The platform popup this replaces came past 30s whatever notifyAfterSeconds
      // said (default 60): the one popup keeps that, the webhook keeps the threshold.
      desktopAfterMs: TURN_DESKTOP_AFTER_MS,
    });
    // The popup rings the bell itself; a shorter turn still gets the bell the
    // Orchestrator's own popup gave it (behavior.notifyOnComplete).
    if (!popped && notifyOnComplete && turnElapsedMs > TURN_BELL_AFTER_MS) {
      try {
        ringBell();
      } catch {
        /* stdout may already be torn down */
      }
    }
    // Budget-breach alert: edge-triggered, checked once per user turn after
    // the turn is named (a failed turn spent tokens too).
    if (budgetBreachNotifier) {
      const sessionModel = providerRegistry.getCurrentModel().id ?? 'unknown';
      budgetBreachNotifier.check(orchestrator.usage, sessionModel, readBudgetAlertUsd(configGet));
    }
  };
  unsubs.push(userTurn.onEnd(notifyTurnEnd));
  unsubs.push(userTurn.onStart((start) => {
    turnStartTime = _clock();
    readTurnText = () => start.prompt;
    tally.reset();
  }));

  const refreshGit = (): void => {
    gitStatusProvider
      .refresh()
      .then((info) => {
        lastGitInfoRef.value = info;
        render();
      })
      .catch(() => {
        /* non-fatal */
      });
  };

  unsubs.push(
    events.turns.on('TURN_COMPLETED', (evt) => {
      // Auto-save after every LLM turn so kills don't lose the session
      try {
        const snapshot = conversation.toJSON() as {
          messages: Array<import('./conversation.ts').ConversationMessageSnapshot>;
          timestamp?: number;
        };
        const persisted = buildPersistedSessionContextFromFacts(
          snapshot.messages,
          conversation.getTitleSource(),
          buildSessionContinuityHints(),
        );
        persistConversation(
          runtime.sessionId,
          { ...snapshot, ...persisted },
          runtime.model,
          runtime.provider,
          conversation.title || '',
          { surface },
          // Turn-completion persistence is machinery, not a user act: stated
          // explicitly so the retention sweep can tell it apart from a session
          // the user asked to keep via /session save.
          'auto',
        );
        // The store now holds everything the crash snapshot did.
        markConversationDurable(conversation, runtime.sessionId, 'store');
        deleteRecoveryFile({ surface }, runtime.sessionId);
        hookDispatcher
          .fire({
            path: 'Lifecycle:session:save' as HookEventPath,
            phase: 'Lifecycle' as HookPhase,
            category: 'session' as HookCategory,
            specific: 'save',
            sessionId: runtime.sessionId,
            timestamp: Date.now(),
            payload: { sessionId: runtime.sessionId },
          })
          .catch((err: unknown) => logger.debug('hook fire error', { error: summarizeError(err) }));
        autoSaveFailureShown = false;
      } catch (e) {
        // The session file did not take this turn: the crash snapshot keeps it.
        try {
          writeCrashSnapshot();
        } catch (error) {
          logger.warn('[Recovery] Crash snapshot after a failed save also failed', { error: summarizeError(error) });
        }
        logger.debug('auto-save on turn:complete failed', { error: summarizeError(e) });
        if (!autoSaveFailureShown) {
          autoSaveFailureShown = true;
          systemMessageRouter.high(`[Warning] This session could not be saved (${summarizeError(e)}). /session save retries, and --continue may not include this turn.`);
        }
      }
      // Record this turn's rewind anchor: pair the turnId (shared with the
      // workspace checkpoint the turn engine snapshots for this same turn) with
      // the live conversation message count and a key of the turn's last
      // message, so a later message-anchored /checkpoint rewind cuts the conversation at
      // exactly this boundary, or says the turn was compacted away, never at an
      // unrelated message (see platform/rewind/turn-anchors.ts).
      try {
        recordTurnAnchor(runtime.sessionId, captureTurnAnchor(evt.turnId, conversation, _clock()));
        // Mirror the anchors to the session's sidecar so message-anchored /checkpoint rewind
        // survives a resume (the in-memory registry alone is process-local).
        persistTurnAnchors(runtime.sessionId, surface);
      } catch {
        /* best-effort; a rewind-anchor miss must never break the turn */
      }
      // Auto-compaction is owned by the platform Orchestrator's post-turn maintenance
      // (handlePostTurnContextMaintenance), which runs on every turn against the
      // resolved context window (getContextWindowForModel) via the platform's
      // getAutoCompactDecision (percentage threshold + 15k safety buffer +
      // small-window handling). The TUI must not independently re-trigger it.
      refreshGit();
    }),
  );

  // Activity for the end-of-turn notice, counted only while a turn runs.
  unsubs.push(
    events.tools.on('TOOL_RECEIVED', (payload) => {
      if (turnStartTime !== null) tally.noteToolReceived(payload.callId, payload.tool, payload.args);
    }),
  );
  unsubs.push(
    events.tools.on('TOOL_CANCELLED', (payload) => {
      if (turnStartTime !== null) tally.noteToolFailed(payload.callId);
    }),
  );
  unsubs.push(
    events.agents.on('AGENT_SPAWNING', (payload) => {
      if (turnStartTime !== null) tally.noteAgentStarted();
      rememberBounded(agentTasks, payload.agentId, () => payload.task);
    }),
  );
  unsubs.push(
    events.agents.on('AGENT_COMPLETED', (payload) => {
      agentTasks.delete(payload.agentId);
    }),
  );
  unsubs.push(
    events.agents.on('AGENT_CANCELLED', (payload) => {
      agentTasks.delete(payload.agentId);
    }),
  );
  unsubs.push(
    events.contracts.on('CONTRACT_CREATED', (payload) => {
      rememberBounded(workstreams, payload.contractId, () => payload.ask);
    }),
  );
  // Contract checks expose criterion verdicts, not a numeric review score.
  // Do not manufacture an old workflow score from those verdicts.
  unsubs.push(
    events.contracts.on('CONTRACT_PASSED', (payload) => {
      workstreams.delete(payload.contractId);
    }),
  );

  // In-terminal (OSC 9) agent-blocked notification: a delegated agent parked
  // waiting for a human message (AGENT_AWAITING_MESSAGE) is "blocked on you".
  // Gated by the notifier's own per-signal config + focus rule. Names the
  // agent's task unless behavior.notificationsMetadataOnly is on.
  if (terminalNotifier) {
    unsubs.push(
      events.agents.on('AGENT_AWAITING_MESSAGE', (payload) => {
        const task = readNotificationsMetadataOnly(configGet) ? null : agentTasks.get(payload.agentId)?.();
        terminalNotifier.notify(
          'agent-blocked',
          task
            ? trimAtWordBoundary(`Agent waiting for your input: ${task}`, NOTIFICATION_TEXT_LIMITS.terminal)
            : 'An agent is waiting for your input',
        );
      }),
    );
  }

  unsubs.push(
    events.tools.on('TOOL_SUCCEEDED', (payload) => {
      if (turnStartTime !== null) tally.noteToolSucceeded(payload.callId);
      refreshGit();
    }),
  );
  unsubs.push(
    events.tools.on('TOOL_FAILED', (payload) => {
      if (turnStartTime !== null) tally.noteToolFailed(payload.callId);
      refreshGit();
    }),
  );

  // Desktop-only agent/contract alerts. Bootstrap owns typed webhook and
  // Slack/Discord delivery for these events, independently of terminal focus.
  // Keeping outbound delivery there avoids a duplicate from this local notice.
  if (focusTracker) {
    unsubs.push(
      events.agents.on('AGENT_FAILED', (payload) => {
        const task = agentTasks.get(payload.agentId);
        agentTasks.delete(payload.agentId);
        if (!shouldFireAlert(focusTracker, configGet, 'behavior.notifyOnAgentFailure')) return;
        try {
          const metadataOnly = readNotificationsMetadataOnly(configGet);
          const name = metadataOnly
            ? ''
            : trimAtWordBoundary(task?.() ?? '', NOTIFICATION_TEXT_LIMITS.desktopTitle - 'Agent failed: '.length);
          notifyDesktop(
            name ? `Agent failed: ${name}` : 'GoodVibes: agent failed',
            metadataOnly ? 'An agent failed' : trimAtWordBoundary(`Agent failed: ${payload.error}`, NOTIFICATION_TEXT_LIMITS.desktopBody),
          );
        } catch (err) {
          logger.debug('turn-event-wiring: agent-failure notify error', { error: String(err) });
        }
      }),
    );
    const notifyWorkstreamEnd = (
      payload: import('./workstream-notification.ts').WorkstreamFailureNarrationInput & { contractId: string },
    ): void => {
      const task = workstreams.get(payload.contractId);
      workstreams.delete(payload.contractId);
      if (!shouldFireAlert(focusTracker, configGet, 'behavior.notifyOnChainFailure')) return;
      try {
        const notice = workstreamFailureNotification(payload, {
          get task() {
            return task?.();
          },
          metadataOnly: readNotificationsMetadataOnly(configGet),
        });
        notifyDesktop(notice.title, notice.body);
      } catch (err) {
        logger.debug('turn-event-wiring: contract notification error', { error: String(err) });
      }
    };
    unsubs.push(events.contracts.on('CONTRACT_FAILED', notifyWorkstreamEnd));
    unsubs.push(events.contracts.on('CONTRACT_CANCELLED', notifyWorkstreamEnd));
  }

  // Live footer permission-mode pill: re-render whenever the platform config
  // surface reports permissions.mode changed. Mode changes are made through
  // configManager.set('permissions.mode', ...) (the platform-owned surface the
  // PermissionManager reads), so this covers our own Shift+Tab / /plan toggles
  // as well as any other in-process writer. No polling.
  if (typeof configManager.subscribe === 'function') {
    unsubs.push(
      configManager.subscribe('permissions.mode', () => {
        render();
      }),
    );
  }

  // Post-compaction receipt (never-silent): the platform emits a mandatory
  // COMPACTION_RECEIPT on the 'compaction' domain after every automatic (and
  // the manual) compaction. That domain is NOT in the grouped UiRuntimeEvents
  // feed, so we subscribe on the raw bus and render the receipt as a distinct
  // [Compaction] block. Automatic compaction previously left no transcript
  // trace; this makes the audit visible.
  if (runtimeBus) {
    unsubs.push(
      runtimeBus.on('COMPACTION_RECEIPT', (envelope) => {
        try {
          const payload = envelope.payload;
          if (payload.type !== 'COMPACTION_RECEIPT') return;
          systemMessageRouter.high(buildCompactionReceiptBlock(payload));
          render();
        } catch (err) {
          logger.debug('turn-event-wiring: compaction-receipt render error', { error: String(err) });
        }
      }),
    );
  }

  unsubs.push(() => {
    agentTasks.clear();
    workstreams.clear();
    readTurnText = null;
  });
  return { refreshGit, unsubs };
}
