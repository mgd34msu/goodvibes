import type { TurnCancellationResult } from '../../core/turn-cancellation.js';
/**
 * routes/session-runtime.ts
 *
 * Per-session permission mode (get/set) and context-usage exposure on the
 * operator wire, the session-scoped RPCs that were missing, so a remote
 * surface (webui) can read/write a session's permission mode and read its
 * context-window pressure instead of only touching the daemon-wide
 * `permissions.mode` config the way the in-process TUI reads per-session
 * state.
 *
 * SCOPE OF TRUTH: the daemon answers for the sessions whose loops it runs:
 * its own local runtime, every hosted session (through the controls the
 * hosted loop binds), and active channel sessions. A request for any other
 * session id is an honest 404 (SESSION_NOT_LOCAL) rather than a fabricated
 * answer. A session it runs but holds no context figure for answers 409
 * CONTEXT_USAGE_UNAVAILABLE, naming why.
 *
 * MODE-CHANGE EVENT: `sessions.permissionMode.set` mutates `permissions.mode`
 * through the ordinary config surface, which the already-wired
 * `bindPermissionModeChangeEvent` binding (permissions/mode-change-emitter.ts,
 * attached in runtime/services.ts) turns into a runtime.gate
 * PRESET_CHANGED event, so surfaces stay in sync without this verb
 * emitting its own event.
 *
 * HONESTY (context usage): estimatedContextTokens is the runtime's current
 * estimate, not a guaranteed fresh preflight count. The field name and the
 * `estimated: true` flag keep that limitation explicit. The percentage
 * and remaining tokens derive from that estimate via the one shared
 * runtime/context-usage.ts helper the in-process read model also uses.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { PermissionMode } from '../../config/schema-types.js';
import { effectivePermissionMode, GATE_PRESETS, isSettableGatePresetName, normalizePermissionMode, type GatePresetName, type SettableGatePresetName } from '../../gate/presets.js';
import { deriveContextUsage } from '../../runtime/context-usage.js';
import type { InboundIntakeBroker } from '../../channel-profiles/install-inbound-intake.js';
import { readCurrentContextWindow } from '../../providers/context-window-reading.js';
import type { ContextWindowOrigin, ContextWindowProvenance } from '../../providers/registry-types.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';

/**
 * The shared execution modes and the separate read-only planning posture.
 */
export type OperatorPermissionMode = GatePresetName;
export type SettableOperatorPermissionMode = SettableGatePresetName;

/** Map the internal config permission mode onto the operator vocabulary. */
export function toOperatorPermissionMode(mode: PermissionMode): OperatorPermissionMode {
  return normalizePermissionMode(mode);
}

/** Map a settable operator mode back onto the internal config permission mode. */
export function toConfigPermissionMode(mode: string): PermissionMode {
  if (isSettableGatePresetName(mode)) return GATE_PRESETS[mode].mode;
  throw new GatewayVerbError(
    `Invalid permission mode: ${String(mode)} (expected ask-me, jev-decides, just-vibes, yolo, or plan)`,
    'INVALID_ARGUMENT',
    400,
    'mode',
  );
}

/** The measured/estimated context usage of a single session's live runtime. */
export interface SessionContextUsage {
  readonly estimatedContextTokens: number;
  /** A source-supported ceiling or configured cap; null when capacity is unknown. */
  readonly contextWindow: number | null;
  readonly contextUsagePct: number | null;
  readonly contextRemainingTokens: number | null;
  readonly contextWindowSource?: ContextWindowProvenance | 'openrouter' | 'registry' | undefined;
  readonly contextWindowOrigin?: ContextWindowOrigin | undefined;
  /** Largest accepted input, not a ceiling. */
  readonly contextWindowAcceptedFloor?: number | undefined;
}

/**
 * The live-turn control surface an interactive runtime host (an Orchestrator)
 * binds so remote surfaces can cancel one in-flight tool call and manage the
 * pending mid-turn message queue. Matches the Orchestrator's own public
 * methods structurally, so binding is `holder.bind(orchestrator)`.
 */
export interface SessionLiveTurnControls {
  getPermissionMode?(): GatePresetName;
  /** This session's own context usage, read from the conversation and model it runs. */
  getContextUsage?(): SessionContextUsage;
  setPermissionMode?(mode: SettableGatePresetName): Promise<void>;
  cancelTurn?(expectedTurnId: string): TurnCancellationResult;
  cancelToolCall(callId: string): boolean;
  listQueuedMessages(): ReadonlyArray<{ readonly id: string; readonly queuedAt: number; readonly text: string }>;
  editQueuedMessage(id: string, text: string): boolean;
  deleteQueuedMessage(id: string): boolean;
}

/**
 * Settable holder an interactive consumer binds its live Orchestrator-backed
 * controls into (the contextAccountingHolder pattern): the verbs read whatever
 * is currently bound; unbinding (or a different instance being bound) is safe.
 */
export class SessionLiveTurnControlsHolder {
  private controls: SessionLiveTurnControls | null = null;
  /**
   * Per-session bindings, for a host that runs SEVERAL loops at once.
   *
   * The single slot above is the interactive host's: one process, one
   * conversation, and `sessions.toolCalls.cancel` against "the local runtime"
   * means that one. A daemon hosting sessions runs many at the same time, and
   * "the local runtime" is no longer a single thing, so each hosted loop binds
   * under its own id and the verbs resolve by id first, falling back to the
   * single slot for the interactive case that has always worked that way.
   */
  private readonly bySession = new Map<string, SessionLiveTurnControls>();

  bind(controls: SessionLiveTurnControls): void {
    this.controls = controls;
  }
  /** Unbind only when the caller is still the bound instance (idempotent). */
  unbind(controls: SessionLiveTurnControls): void {
    if (this.controls === controls) this.controls = null;
  }
  get(): SessionLiveTurnControls | null {
    return this.controls;
  }

  /** Bind one session's live-turn controls by id. Replaces any previous binding for that id. */
  bindSession(sessionId: string, controls: SessionLiveTurnControls): void {
    this.bySession.set(sessionId, controls);
  }
  /** Unbind only when the caller is still the bound instance for that id (idempotent). */
  unbindSession(sessionId: string, controls: SessionLiveTurnControls): void {
    if (this.bySession.get(sessionId) === controls) this.bySession.delete(sessionId);
  }
  /** The controls bound for this session id, or null. */
  getSession(sessionId: string): SessionLiveTurnControls | null {
    return this.bySession.get(sessionId) ?? null;
  }
  /** Whether any loop is bound under this id. */
  hasSession(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }
}

/**
 * The narrow control surface the session-runtime verbs need over the live
 * local runtime. `isLocalSession` decides whether a requested session id is
 * the runtime this daemon hosts (the only one whose mode/usage it can answer
 * for truthfully).
 */
export interface SessionRuntimeControls {
  isLocalSession(sessionId: string): boolean;
  getPermissionMode(sessionId?: string): PermissionMode;
  setPermissionMode(mode: PermissionMode, sessionId?: string): void | Promise<void>;
  getContextUsage(sessionId: string): SessionContextUsage;
  /**
   * The live-turn controls for this session id.
   *
   * Takes the id because a daemon hosting sessions runs several loops at once:
   * a per-session binding answers for a hosted session, and the single
   * interactive binding answers for the local runtime. Null when neither is
   * bound, which the verbs report as an honest refusal.
   */
  getLiveTurnControls(sessionId: string): SessionLiveTurnControls | null;
}

function requireLocalSessionId(controls: SessionRuntimeControls, params: Record<string, unknown>): string {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) {
    throw new GatewayVerbError('sessionId is required', 'INVALID_ARGUMENT', 400, 'sessionId');
  }
  if (!controls.isLocalSession(sessionId)) {
    throw new GatewayVerbError(
      `This daemon does not host a live runtime for session ${sessionId}.`,
      'SESSION_NOT_LOCAL',
      404,
    );
  }
  return sessionId;
}

export function createSessionPermissionModeGetHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const sessionId = requireLocalSessionId(controls, readInvocationParams(invocation));
    return { sessionId, mode: toOperatorPermissionMode(controls.getPermissionMode(sessionId)) };
  };
}

export function createSessionPermissionModeSetHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const nextMode = toConfigPermissionMode(typeof params.mode === 'string' ? params.mode : '');
    const previousMode = toOperatorPermissionMode(controls.getPermissionMode(sessionId));
    const changed = controls.setPermissionMode(nextMode, sessionId);
    const result = {
      sessionId,
      mode: toOperatorPermissionMode(nextMode),
      previousMode,
    };
    return changed instanceof Promise ? changed.then(() => result) : result;
  };
}

/** Resolve the bound live-turn controls or refuse honestly (no fabricated success). */
function requireLiveTurnControls(controls: SessionRuntimeControls, sessionId: string): SessionLiveTurnControls {
  const live = controls.getLiveTurnControls(sessionId);
  if (!live) {
    throw new GatewayVerbError(
      'No interactive runtime is bound on this daemon, live-turn controls are unavailable for this session.',
      'LIVE_TURN_CONTROLS_UNAVAILABLE',
      404,
    );
  }
  return live;
}

export function createSessionTurnCancelHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const live = requireLiveTurnControls(controls, sessionId);
    const expectedTurnId = typeof params.expectedTurnId === 'string' ? params.expectedTurnId.trim() : '';
    if (!expectedTurnId) throw new GatewayVerbError('expectedTurnId is required', 'INVALID_ARGUMENT', 400, 'expectedTurnId');
    if (!live.cancelTurn) throw new GatewayVerbError('Turn cancellation is unavailable for this runtime.', 'LIVE_TURN_CONTROLS_UNAVAILABLE', 404);
    return { sessionId, expectedTurnId, ...live.cancelTurn(expectedTurnId) };
  };
}

export function createSessionToolCallCancelHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const live = requireLiveTurnControls(controls, sessionId);
    const callId = typeof params.callId === 'string' ? params.callId.trim() : '';
    if (!callId) {
      throw new GatewayVerbError('callId is required', 'INVALID_ARGUMENT', 400, 'callId');
    }
    if (!live.cancelToolCall(callId)) {
      throw new GatewayVerbError(
        `No tool call ${callId} is currently in flight (already settled, or never started).`,
        'TOOL_CALL_NOT_RUNNING',
        404,
      );
    }
    return { sessionId, callId, cancelled: true };
  };
}

export function createSessionQueuedMessagesListHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const sessionId = requireLocalSessionId(controls, readInvocationParams(invocation));
    const live = requireLiveTurnControls(controls, sessionId);
    return { sessionId, messages: live.listQueuedMessages() };
  };
}

export function createSessionQueuedMessageEditHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const live = requireLiveTurnControls(controls, sessionId);
    const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
    const text = typeof params.text === 'string' ? params.text : '';
    if (!messageId) {
      throw new GatewayVerbError('messageId is required', 'INVALID_ARGUMENT', 400, 'messageId');
    }
    if (!text.trim()) {
      throw new GatewayVerbError('text must be non-empty', 'INVALID_ARGUMENT', 400, 'text');
    }
    if (!live.editQueuedMessage(messageId, text)) {
      throw new GatewayVerbError(
        `Message ${messageId} is not in the pending queue (already delivered, delivered messages are immutable).`,
        'MESSAGE_NOT_QUEUED',
        404,
      );
    }
    return { sessionId, id: messageId, text };
  };
}

export function createSessionQueuedMessageDeleteHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const live = requireLiveTurnControls(controls, sessionId);
    const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
    if (!messageId) {
      throw new GatewayVerbError('messageId is required', 'INVALID_ARGUMENT', 400, 'messageId');
    }
    if (!live.deleteQueuedMessage(messageId)) {
      throw new GatewayVerbError(
        `Message ${messageId} is not in the pending queue (already delivered, delivered messages are immutable).`,
        'MESSAGE_NOT_QUEUED',
        404,
      );
    }
    return { sessionId, id: messageId, deleted: true };
  };
}

export function createSessionContextUsageGetHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const sessionId = requireLocalSessionId(controls, readInvocationParams(invocation));
    const usage = controls.getContextUsage(sessionId);
    return {
      sessionId,
      ...usage,
      // The stored token estimate is not a fresh preflight measurement.
      estimated: true,
    };
  };
}

/**
 * The `permissions.mode` config surface the session-runtime controls read and
 * write. The daemon's real ConfigManager (whose generic get/set resolve
 * `permissions.mode` to {@link PermissionMode}) satisfies this narrower shape.
 */
export interface PermissionModeConfig {
  get(key: 'permissions.mode' | 'behavior.autoApprove'): PermissionMode | boolean;
  set(key: 'permissions.mode' | 'behavior.autoApprove', value: PermissionMode | boolean): void;
}

/** The slice of the runtime state the session-runtime controls read. */
export interface SessionRuntimeStateReader {
  getState(): {
    readonly session: { readonly id: string };
    readonly conversation: { readonly estimatedContextTokens: number };
  };
}

/**
 * Build the concrete controls over the daemon's config + runtime store. The
 * local runtime is addressable by its own store session id, or by the stable
 * `'runtime'` alias the mode-change binding stamps on its wire event
 * (runtime/services.ts) so a surface can subscribe before it knows the id.
 */
export function createSessionRuntimeControls(deps: {
  readonly config: PermissionModeConfig;
  readonly store: SessionRuntimeStateReader;
  readonly providerRegistry?: Pick<ProviderRegistry, 'getCurrentModel' | 'getContextWindowForModel' | 'getKnownContextWindowForModel'> | undefined;
  /** Live-turn controls holder an interactive consumer binds; absent = no live-turn verbs. */
  readonly liveTurnHolder?: SessionLiveTurnControlsHolder | undefined;
  readonly channelSessions?: Pick<InboundIntakeBroker, 'getSession' | 'setChannelExecutionMode'> | undefined;
  readonly channelModeChanged?: ((sessionId: string, mode: GatePresetName, previousMode: GatePresetName) => void) | undefined;
}): SessionRuntimeControls {
  const LOCAL_RUNTIME_ALIAS = 'runtime';
  return {
    isLocalSession(sessionId: string): boolean {
      // A session this process HOSTS is local by the only definition that
      // matters here: this daemon owns its loop and can answer for it. Without
      // this branch every hosted session's cancel and queued-message verbs
      // refused with SESSION_NOT_LOCAL while the loop ran in this very process.
      if (deps.liveTurnHolder?.hasSession(sessionId) === true) return true;
      const channel = deps.channelSessions?.getSession?.(sessionId);
      if (channel?.status === 'active' && channel.channelPermissionMode !== undefined) return true;
      const localId = deps.store.getState().session.id;
      return sessionId === LOCAL_RUNTIME_ALIAS || (localId.length > 0 && sessionId === localId);
    },
    getLiveTurnControls(sessionId: string): SessionLiveTurnControls | null {
      const hosted = deps.liveTurnHolder?.getSession(sessionId);
      if (hosted) return hosted;
      const localId = deps.store.getState().session.id;
      return sessionId === LOCAL_RUNTIME_ALIAS || sessionId === localId
        ? deps.liveTurnHolder?.get() ?? null : null;
    },
    getPermissionMode(sessionId?: string): PermissionMode {
      const hosted = sessionId && deps.liveTurnHolder?.getSession(sessionId);
      if (hosted) {
        if (!hosted.getPermissionMode) throw new GatewayVerbError('Hosted execution mode is unavailable.', 'LIVE_MODE_UNAVAILABLE', 409);
        return hosted.getPermissionMode();
      }
      const channel = sessionId && deps.channelSessions?.getSession?.(sessionId);
      if (channel && channel.channelPermissionMode !== undefined) return channel.channelPermissionMode;
      return effectivePermissionMode(deps.config.get('permissions.mode'), deps.config.get('behavior.autoApprove') === true);
    },
    setPermissionMode(mode: PermissionMode, sessionId?: string): void | Promise<void> {
      const hosted = sessionId && deps.liveTurnHolder?.getSession(sessionId);
      if (hosted) {
        if (!hosted.setPermissionMode) throw new GatewayVerbError('Hosted execution mode is unavailable.', 'LIVE_MODE_UNAVAILABLE', 409);
        return hosted.setPermissionMode(normalizePermissionMode(mode));
      }
      const channel = sessionId && deps.channelSessions?.getSession?.(sessionId);
      if (sessionId && channel && channel.channelPermissionMode !== undefined) {
        const previousMode = channel.channelPermissionMode;
        const set = deps.channelSessions?.setChannelExecutionMode;
        if (!set) throw new GatewayVerbError('Channel execution mode is unavailable.', 'LIVE_MODE_UNAVAILABLE', 409);
        const selected = normalizePermissionMode(mode);
        return set.call(deps.channelSessions, sessionId, selected).then(() => {
          if (selected !== previousMode) deps.channelModeChanged?.(sessionId, selected, previousMode);
        });
      }
      deps.config.set('behavior.autoApprove', false);
      deps.config.set('permissions.mode', mode);
    },
    getContextUsage(sessionId: string): SessionContextUsage {
      const hosted = deps.liveTurnHolder?.getSession(sessionId);
      if (hosted) {
        if (!hosted.getContextUsage) throw contextUsageUnavailable(sessionId, 'its host does not report context usage');
        return hosted.getContextUsage();
      }
      const state = deps.store.getState();
      if (sessionId !== LOCAL_RUNTIME_ALIAS && (!state.session.id || sessionId !== state.session.id)) {
        // Local by `isLocalSession` (an active channel session) but with no
        // conversation figure this process holds.
        throw contextUsageUnavailable(sessionId, 'no conversation figure is kept for it');
      }
      return readSessionContextUsage(state.conversation.estimatedContextTokens, deps.providerRegistry);
    },
  };
}

function contextUsageUnavailable(sessionId: string, why: string): GatewayVerbError {
  return new GatewayVerbError(
    `Context usage is unavailable for session ${sessionId}: ${why}. Its permission mode, cancel and queue verbs still answer.`,
    'CONTEXT_USAGE_UNAVAILABLE',
    409,
  );
}

/**
 * One session's context usage from its token estimate and the model it runs,
 * the one derivation the local runtime and every hosted session share.
 */
export function readSessionContextUsage(
  usedTokens: number,
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getContextWindowForModel' | 'getKnownContextWindowForModel'> | undefined,
): SessionContextUsage {
  const reading = readCurrentContextWindow(providerRegistry);
  const window = reading?.knownContextWindow ?? null;
  const derived = deriveContextUsage(usedTokens, window);
  return {
    estimatedContextTokens: usedTokens,
    contextWindow: window,
    contextUsagePct: derived.contextUsagePct,
    contextRemainingTokens: derived.contextRemainingTokens,
    ...(reading ? {
      contextWindowSource: reading.contextWindowSource,
      ...(reading.contextWindowOrigin ? { contextWindowOrigin: reading.contextWindowOrigin } : {}),
      ...(reading.contextWindowAcceptedFloor !== undefined ? { contextWindowAcceptedFloor: reading.contextWindowAcceptedFloor } : {}),
    } : {}),
  };
}

/**
 * Attach the session-runtime handlers to the descriptors already registered
 * (without a handler) from ../method-catalog-control-core.ts's static builtin
 * array. Call once, at RuntimeServices construction time. A missing descriptor
 * is a silent no-op, the same rationale as routes/fleet.ts.
 */
export function registerSessionRuntimeGatewayMethods(
  catalog: GatewayMethodCatalog,
  controls: SessionRuntimeControls,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('sessions.permissionMode.get', createSessionPermissionModeGetHandler(controls));
  attach('sessions.permissionMode.set', createSessionPermissionModeSetHandler(controls));
  attach('sessions.contextUsage.get', createSessionContextUsageGetHandler(controls));
  attach('sessions.turns.cancel', createSessionTurnCancelHandler(controls));
  attach('sessions.toolCalls.cancel', createSessionToolCallCancelHandler(controls));
  attach('sessions.queuedMessages.list', createSessionQueuedMessagesListHandler(controls));
  attach('sessions.queuedMessages.edit', createSessionQueuedMessageEditHandler(controls));
  attach('sessions.queuedMessages.delete', createSessionQueuedMessageDeleteHandler(controls));
}
