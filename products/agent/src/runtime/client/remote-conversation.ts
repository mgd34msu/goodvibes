import { isGatePresetName, type GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate/presets';
/**
 * remote-conversation.ts, observing this surface's own conversation turns
 * running inside the connected host.
 *
 * Native intake hands the original input to the host, which runs the turn in a
 * hosted session rooted at this surface's working directory. This router never
 * creates a session or sends a message body: `observeNative` opens that
 * session's event stream for the verified dispatch and renders the turn into
 * the local conversation as frames arrive.
 *
 * ── Transcript authority ──────────────────────────────────────────────────
 *
 * The host holds the authoritative transcript. What this surface writes
 * locally is a MIRROR of what the stream delivered, kept because it is the
 * offline record a person still has when the host is not running. On any
 * disagreement the host's transcript is the one that ran.
 *
 * ── Position and turn identity ────────────────────────────────────────────
 *
 *  1. POSITION. Every `id:` this router reads is remembered for the life of the
 *     ROUTER and presented as `Last-Event-ID` when the same input's stream is
 *     opened again, so the host replays only what this router has not seen.
 *  2. TURN IDENTITY. `createTurnLifecycleGate` refuses a terminal frame
 *     addressed to a turn this renderer is not rendering.
 *  3. SUBMISSION CORRELATION. The dispatch's correlation id must be echoed in
 *     TURN_SUBMITTED.origin.metadata. A replayed or queued turn is not this
 *     input merely because it is the first stream frame.
 */

import { buildUrl } from '@goodvibes-jev/engine/transport-http';
import { nativeHostedTurnSnapshotSchema, type NativeHostedTurnSnapshot } from '@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client';
import { createOperatorApiClient } from '@goodvibes-jev/engine/operator-client';
import { transport } from '@goodvibes-jev/engine/platform/platform/runtime';
import { TERMINAL_TURN_EVENT_TYPES, createTurnLifecycleGate, readTurnLifecycleFrame } from '@goodvibes-jev/engine/platform/transport-realtime';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  createHostedFrameRenderer,
  type HostedFrameConversation,
  type HostedFrameRenderer,
  type HostedSessionFrame,
  type HostedTurnCompletion,
} from './hosted-frame-render.ts';

/** The reason given when the person has turned routing off themselves. */
class HostedExecutionModeError extends Error {}

/** What happened to one observed input. */
export type RemoteTurnOutcome =
  | {
    readonly routed: true;
    readonly hostedSessionId: string;
    /**
     * Resolves when the hosted turn ENDS, with its final text and stop reason.
     * `observeNative` resolves as soon as the stream is open, so an interactive
     * composer is not blocked on a whole turn; a caller that needs one final
     * answer waits here. Ignoring it is fine and is what the composer does.
     */
    readonly completion: Promise<HostedTurnCompletion>;
  }
  | {
    readonly routed: false;
    /**
     * Why the turn is running here instead. Always a complete sentence, it is
     * shown to the person, not only logged.
     */
    readonly reason: string;
    /** True when the person chose local, so nothing is wrong and nothing warns. */
    readonly chosen: boolean;
    /** Observation was stopped or its selection changed; the caller must not fall back locally. */
    readonly cancelled?: boolean;
  };

/** The connected host's address and token, or the honest reason there is none. */
export type ConnectedHostResolution =
  | { readonly baseUrl: string; readonly token: string; readonly selectionIdentity?: string; readonly expectedPrincipalId?: string }
  | { readonly reason: string };

/** Credential provenance is part of a native selection, even when its token is unchanged. */
export function sameNativeRemoteConnection(left: ConnectedHostResolution, right: ConnectedHostResolution): boolean {
  return !('reason' in left) && !('reason' in right) && left.baseUrl === right.baseUrl && left.token === right.token
    && left.selectionIdentity === right.selectionIdentity && left.expectedPrincipalId === right.expectedPrincipalId;
}

export interface RemoteConversationRouterOptions {
  readonly verbs: DaemonVerbCaller;
  /** The same resolution the verb caller uses, so calls and the stream agree. */
  readonly resolveConnection: () => ConnectedHostResolution;
  readonly conversation: HostedFrameConversation;
  readonly requestRender: () => void;
  /** Identifies this surface's attachment to the hosted session. */
  readonly clientId: string;
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Every frame this router applies, before it is rendered.
   *
   * For callers that need the raw stream as well as the rendered conversation
   *, `run --output-format stream-json` re-emits deltas, and counts frames the
   * way the local path counts turn events. Rendering does not depend on it.
   */
  readonly onFrame?: ((frame: HostedSessionFrame) => void) | undefined;
  readonly onCancellationNotice?: ((message: string) => void) | undefined;
  /**
   * Reconnect policy for the hosted event stream. Defaults to the platform's, which
   * retries with backoff, the right behaviour, because the turn is still
   * running on the daemon and a reconnect recovers the rest of it rather than
   * abandoning work that is still happening.
   *
   * Exposed so a caller can disable it: a test needs the stream's close to
   * become a termination immediately instead of waiting out ten attempts.
   */
  readonly reconnect?: { readonly enabled: boolean } | undefined;
  /**
   * How often the router renews this surface's attachment to its hosted
   * session while the session is in use. The daemon ends a session whose lease
   * lapses, and a long turn or a long pause between turns would otherwise
   * outlast the default 10 minutes. 0 disables it. Default 2 minutes.
   */
  readonly leaseRenewIntervalMs?: number | undefined;
  /** Test seam for the renewal timer: schedule `run` every `ms`, return a stopper. */
  readonly scheduleRenewal?: ((run: () => void, ms: number) => () => void) | undefined;
}

export interface RemoteConversationRouter {
  /**
   * Observe a verified native delivery. Never creates a session or sends a body.
   * Never throws: a failure is an outcome with a reason.
   */
  observeNative(snapshot: NativeHostedTurnSnapshot, cancel: () => Promise<void>, current?: () => boolean): Promise<RemoteTurnOutcome>;
  /** The hosted session this conversation is bound to, if any. */
  hostedSessionId(): string | null;
  executionMode(): GatePresetName | undefined;
  refreshExecutionMode(): Promise<void>;
  setExecutionMode(mode: GatePresetName): Promise<void>;
  /** Request Stop for the observed input only; true means the hosted path owns it. */
  cancelTurn(): boolean;
  /**
   * Leave the hosted session: tell the daemon this surface is gone, bounded so a
   * hung host cannot hold an exit open. What happens to the session then is the
   * daemon's detach policy. Resolves 'none' when there is nothing to leave.
   */
  detach(timeoutMs?: number): Promise<'none' | 'detached' | 'failed'>;
  /**
   * Let go of the hosted session after the local conversation was cleared or
   * replaced, so the next message opens a new one instead of continuing the
   * conversation the person just left. The old session is detached, not killed.
   */
  reset(): void;
  /** Stop watching. Leaves the hosted session alone, detaching is separate. */
  dispose(): void;
}

const DEFAULT_LEASE_RENEW_INTERVAL_MS = 120_000;
const DEFAULT_DETACH_TIMEOUT_MS = 2_000;

/** Build the hosted session's event-stream URL. */
export function hostedSessionEventStreamUrl(baseUrl: string, hostedSessionId: string): string {
  return buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(hostedSessionId)}/events`);
}

export function createRemoteConversationRouter(
  options: RemoteConversationRouterOptions,
): RemoteConversationRouter {
  interface WatchedTurn {
    readonly correlationId: string;
    readonly sessionId: string;
    turnId: string | null;
    renderer: HostedFrameRenderer | null;
    closeStream: (() => void) | null;
    finished: boolean;
    settledByHost: boolean;
    cancelQueued: boolean;
    cancellationAcknowledged: boolean;
    identityNoticeShown: boolean;
    cancelRequest: Promise<void> | null;
    readonly nativeCancel: () => Promise<void>;
    readonly nativeCurrent: () => boolean;
    readonly nativeKey: string;
    readonly nativeBrokerInputId: string;
    nativeTerminal?: 'completed' | 'cancelled' | undefined;
    readonly connection: Extract<ConnectedHostResolution, { readonly baseUrl: string }>;
    selectionTimer?: ReturnType<typeof setInterval> | undefined;
  }
  let hostedId: string | null = null;
  let hostedConnection: Extract<ConnectedHostResolution, { readonly baseUrl: string }> | undefined;
  let hostedMode: GatePresetName | undefined;
  let modeObservation = 0;
  let modeRequest = 0;
  let stopRenewal: (() => void) | null = null;
  const renewLease = (): void => {
    const id = hostedId;
    if (!id || disposed) return;
    // Attaching again with the same client id is the daemon's documented renewal.
    options.verbs.invoke<unknown>('sessions.hosted.attach', { sessionId: id, clientId: options.clientId }).catch((error: unknown) => {
      logger.debug('[remote-conversation] renewing the hosted session lease failed', { error: String(error) });
    });
  };
  const startRenewal = (): void => {
    const ms = options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
    if (stopRenewal || ms <= 0) return;
    if (options.scheduleRenewal) {
      stopRenewal = options.scheduleRenewal(renewLease, ms);
      return;
    }
    const timer = setInterval(renewLease, ms);
    timer.unref?.();
    stopRenewal = () => clearInterval(timer);
  };
  const endRenewal = (): void => { stopRenewal?.(); stopRenewal = null; };
  // A session this surface no longer uses: leave it so it does not hold a slot
  // until its lease lapses. Best effort.
  const detachQuietly = (sessionId: string): void => {
    options.verbs.invoke<unknown>('sessions.hosted.detach', { sessionId, clientId: options.clientId }).catch((error: unknown) => {
      logger.debug('[remote-conversation] detaching an unused hosted session failed', { sessionId, error: String(error) });
    });
  };
  const currentModeOwner = () => {
    const connection = options.resolveConnection();
    if (disposed || !hostedId || !hostedConnection || !sameNativeRemoteConnection(hostedConnection, connection)) throw new HostedExecutionModeError('The active hosted execution owner is unavailable or changed.');
    return { id: hostedId, connection: hostedConnection };
  };
  const refreshExecutionMode = async (): Promise<void> => {
    const owner = currentModeOwner();
    const revision = ++modeObservation;
    const operator = createOperatorApiClient({ baseUrl: owner.connection.baseUrl, authToken: owner.connection.token, fetchImpl: options.fetchImpl ?? globalThis.fetch });
    try {
      const reply = await operator.invoke('sessions.permissionMode.get', { sessionId: owner.id });
      const current = currentModeOwner();
      if (revision !== modeObservation) return;
      if (current.id !== owner.id || !sameNativeRemoteConnection(current.connection, owner.connection) || reply.sessionId !== owner.id || !isGatePresetName(reply.mode)) {
        throw new HostedExecutionModeError('The host returned an unconfirmed session execution mode.');
      }
      hostedMode = reply.mode;
      options.requestRender();
    } catch (error) {
      if (revision === modeObservation) { hostedMode = undefined; options.requestRender(); }
      throw error;
    } finally { operator.dispose(); }
  };
  const setRemoteExecutionMode = async (mode: GatePresetName): Promise<void> => {
    if (!isGatePresetName(mode)) throw new HostedExecutionModeError('Invalid execution mode.');
    const owner = currentModeOwner();
    const revision = ++modeRequest;
    modeObservation++;
    hostedMode = undefined;
    options.requestRender();
    const operator = createOperatorApiClient({ baseUrl: owner.connection.baseUrl, authToken: owner.connection.token, fetchImpl: options.fetchImpl ?? globalThis.fetch });
    try {
      const reply = await operator.invoke('sessions.permissionMode.set', { sessionId: owner.id, mode });
      const current = currentModeOwner();
      if (revision !== modeRequest || current.id !== owner.id || !sameNativeRemoteConnection(current.connection, owner.connection)) throw new HostedExecutionModeError('The hosted execution owner changed during the mode update.');
      if (reply.sessionId !== owner.id || !isGatePresetName(reply.mode) || reply.mode !== mode) throw new HostedExecutionModeError('The host did not confirm the requested session execution mode.');
      modeObservation++;
      hostedMode = reply.mode;
      options.requestRender();
    } catch {
      if (revision === modeRequest) { hostedMode = undefined; modeObservation++; options.requestRender(); }
      throw new HostedExecutionModeError('The hosted execution mode update is unconfirmed. No local default was changed.');
    } finally { operator.dispose(); }
  };
  let active: WatchedTurn | null = null;
  let disposed = false;
  const streamPositions = new Map<string, string>();
  const nativeTurnIds = new Map<string, string>();
  const nativeObservations = new Map<string, { readonly turn: WatchedTurn; readonly outcome: Extract<RemoteTurnOutcome, { routed: true }> }>();
  const refuse = (reason: string, chosen = false): RemoteTurnOutcome => ({ routed: false, reason, chosen });
  const stopped = (): RemoteTurnOutcome => ({
    routed: false, chosen: true, cancelled: true,
    reason: 'Observation stopped: this surface closed or its host selection changed. The input was not run locally.',
  });
  const notice = (turn: WatchedTurn, message: string): void => {
    if (active !== turn || turn.finished || disposed) return;
    try { options.onCancellationNotice?.(message); } catch (error) {
      logger.debug('[remote-conversation] cancellation observer threw', { error: String(error) });
    }
  };
  const release = (turn: WatchedTurn): void => {
    if (turn.finished) return;
    turn.finished = true;
    if (active === turn) active = null;
    if (turn.selectionTimer) clearInterval(turn.selectionTimer);
    const close = turn.closeStream;
    turn.closeStream = null;
    try { close?.(); } catch (error) {
      logger.debug('[remote-conversation] closing the hosted event stream raised', { error: String(error) });
    }
  };
  const abandon = (turn: WatchedTurn, reason: string): void => {
    turn.renderer?.abandon(reason);
    release(turn);
  };
  const isCurrent = (turn: WatchedTurn): boolean => {
    if (active !== turn || turn.finished || disposed || !turn.nativeCurrent()) return false;
    return sameNativeRemoteConnection(options.resolveConnection(), turn.connection);
  };

  const sendCancellation = (turn: WatchedTurn): void => {
    if (!isCurrent(turn) || !turn.cancelQueued || turn.cancelRequest || turn.cancellationAcknowledged) return;
    turn.cancelQueued = false;
    turn.cancelRequest = Promise.resolve().then(async () => {
      if (!isCurrent(turn)) return;
      try {
        await turn.nativeCancel();
        if (isCurrent(turn)) {
          turn.cancellationAcknowledged = true;
          notice(turn, '[Stop] Native cancellation recorded for this original input; waiting for its terminal event.');
        }
      } catch {
        notice(turn, '[Stop] Native cancellation is unconfirmed. Inspect /work intake-status or press Stop to retry the same input.');
      } finally { turn.cancelRequest = null; }
    });
  };

  const watch = async (turn: WatchedTurn, baseUrl: string, token: string, sessionId: string): Promise<HostedFrameRenderer> => {
    const renderer = createHostedFrameRenderer(options.conversation, options.requestRender);
    turn.renderer = renderer;
    const isCurrentWatch = (): boolean => isCurrent(turn) && turn.renderer === renderer;
    const gate = createTurnLifecycleGate(turn.turnId ? { turnId: turn.turnId } : undefined);
    const streamUrl = hostedSessionEventStreamUrl(baseUrl, sessionId);
    const positionKey = turn.nativeKey;
    const terminalTypes = new Set(TERMINAL_TURN_EVENT_TYPES);
    const close = await transport.openServerSentEventStream(options.fetchImpl ?? globalThis.fetch, streamUrl, {
      // The platform parses id: before dispatching its event. After terminal release
      // or replacement, buffered frames no longer advance this watch's cursor.
      onEventId: (id: string) => { if (isCurrentWatch()) streamPositions.set(positionKey, id); },
      onEvent: (_domain: string, payload: unknown) => {
        // The first heartbeat follows catch-up replay. A terminal native
        // receipt remains authoritative even when bounded event history can
        // no longer reconstruct its reply; never wait forever or infer a turn.
        if (isCurrentWatch() && _domain === 'heartbeat' && turn.nativeTerminal && !renderer.isTurnFinished()) {
          abandon(turn, `The host reports this native turn ${turn.nativeTerminal}, but its complete event history is no longer available. Inspect the hosted conversation; this input was not replayed.`);
          return;
        }
        if (!isCurrentWatch() || !payload || typeof payload !== 'object') return;
        const frame = payload as HostedSessionFrame;
        if (typeof frame.type !== 'string') return;
        if (frame.sessionId !== undefined && frame.sessionId !== sessionId) return;
        const frameTurnId = frame.payload?.['turnId'];
        // A session stream may replay prior work or carry somebody else's
        // queued turn. Only the server's echo of this submission can confer
        // ownership. Prompt text, timing and first-frame order are not ids.
        if (frame.type === 'TURN_SUBMITTED') {
          const origin = frame.payload?.['origin'];
          const metadata = origin && typeof origin === 'object' ? (origin as Record<string, unknown>)['metadata'] : undefined;
          const correlationId = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)['correlationId'] : undefined;
          if (frame.sessionId !== sessionId || correlationId !== turn.correlationId
            || typeof frameTurnId !== 'string' || frameTurnId.length === 0) {
            if (correlationId === undefined && !turn.identityNoticeShown) {
              turn.identityNoticeShown = true;
              notice(turn, '[Turn] The host has not identified this submission. Waiting for its correlated start; Stop will not cancel an unidentified turn.');
            }
            return;
          }
          if (turn.turnId !== null && turn.turnId !== frameTurnId) return;
          turn.turnId = frameTurnId;
          nativeTurnIds.set(turn.nativeKey, frameTurnId);
        }
        // Neither rendering nor terminal settlement can use unrelated work
        // while this submission is still queued. Non-turn session notices may
        // still reach observers, but have no rendering or lifecycle authority.
        if (turn.turnId === null && (typeof frameTurnId === 'string'
          || terminalTypes.has(frame.type) || frame.type.startsWith('STREAM_')
          || frame.type.startsWith('TOOL_') || frame.type.startsWith('LLM_')
          || frame.type.startsWith('PREFLIGHT_'))) return;
        if (turn.turnId !== null && typeof frameTurnId === 'string' && frameTurnId !== turn.turnId) return;
        if (terminalTypes.has(frame.type)
          && (frame.sessionId !== sessionId || frameTurnId !== turn.turnId)) return;
        // The public gate retains duplicate/stale lifecycle protection within
        // the positively correlated execution.
        const lifecycle = readTurnLifecycleFrame(frame.sessionId, frame.payload);
        if (lifecycle && !gate.accepts(lifecycle)) return;
        if (frame.type === 'PRESET_CHANGED') {
          hostedMode = undefined;
          void refreshExecutionMode().catch(() => undefined);
        }
        try { options.onFrame?.(frame); } catch (error) {
          logger.debug('[remote-conversation] a hosted-frame observer threw', { error: String(error) });
        }
        if (!isCurrentWatch()) return;
        try { renderer.apply(frame); } catch (error) {
          logger.debug('[remote-conversation] rendering a hosted frame raised', { error: String(error) });
        }
        if (renderer.isTurnFinished()) { turn.settledByHost = true; release(turn); }
        else sendCancellation(turn);
      },
      onTerminate: ({ error }: { readonly error: unknown }) => {
        if (isCurrentWatch()) abandon(turn, 'The connection to the hosting daemon ended before this turn finished. '
          + `Cancellation and completion are unconfirmed${error ? `: ${String(error)}` : '.'} `
          + 'The turn may still be running there; reopen this conversation to see how it ended.');
      },
      onClose: () => {
        if (isCurrentWatch()) abandon(turn, 'The connection to the hosting daemon ended before this turn finished. '
          + 'The turn may still be running there; reopen this conversation to see how it ended.');
      },
    }, {
      getAuthToken: () => token,
      lastEventId: streamPositions.get(positionKey) ?? null,
      ...(options.reconnect ? { reconnect: options.reconnect } : {}),
    });
    if (!isCurrentWatch()) close();
    else turn.closeStream = close;
    return renderer;
  };

  const observeNative = async (raw: NativeHostedTurnSnapshot, cancel: () => Promise<void>, current: () => boolean = () => true): Promise<RemoteTurnOutcome> => {
    const parsed = nativeHostedTurnSnapshotSchema.safeParse(raw);
    if (!parsed.success) return refuse('Native hosted delivery identity is invalid. No legacy turn was started.', true);
    const snapshot = parsed.data;
    if (!snapshot.sessionId || !snapshot.correlationId || !snapshot.brokerInputId) {
      return refuse(`Native hosted turn is ${snapshot.state}; inspect /work intake-status. No legacy turn was started.`, true);
    }
    const connection = options.resolveConnection();
    if (disposed || !current() || 'reason' in connection) return stopped();
    const key = JSON.stringify([connection.baseUrl, connection.token, connection.selectionIdentity, connection.expectedPrincipalId, snapshot.projectId, snapshot.requestId, snapshot.inputId, snapshot.sourceRevision]);
    const observed = nativeObservations.get(key);
    if (observed) {
      if (observed.turn.sessionId !== snapshot.sessionId || observed.turn.correlationId !== snapshot.correlationId
        || observed.turn.nativeBrokerInputId !== snapshot.brokerInputId) {
        abandon(observed.turn, 'The host returned a different dispatch identity for the original native source. Observation was detached without replay.');
        return refuse('Native hosted dispatch identity changed. Inspect the original input; no replacement was adopted.', true);
      }
      if (snapshot.state === 'completed' || snapshot.state === 'cancelled') observed.turn.nativeTerminal = snapshot.state;
      if (isCurrent(observed.turn) || observed.turn.settledByHost) return observed.outcome;
      nativeObservations.delete(key);
      abandon(observed.turn, 'The previous native observation was detached. Reopening the saved original with current selection.');
    }
    if (active) { abandon(active, 'This surface switched observations. The original remote outcome is unconfirmed; switching did not cancel it.'); }
    const turn: WatchedTurn = {
      correlationId: snapshot.correlationId, sessionId: snapshot.sessionId,
      turnId: nativeTurnIds.get(key) ?? null, renderer: null, closeStream: null, finished: false,
      settledByHost: false, cancelQueued: false,
      cancellationAcknowledged: false, identityNoticeShown: false, cancelRequest: null,
      nativeCancel: cancel, nativeCurrent: current, nativeKey: key, nativeBrokerInputId: snapshot.brokerInputId, connection,
      ...(snapshot.state === 'completed' || snapshot.state === 'cancelled' ? { nativeTerminal: snapshot.state } : {}),
    };
    active = turn;
    if (hostedId !== snapshot.sessionId || !hostedConnection || !sameNativeRemoteConnection(hostedConnection, connection)) {
      modeObservation++; modeRequest++;
      hostedMode = undefined;
    }
    hostedId = snapshot.sessionId;
    hostedConnection = connection;
    startRenewal();
    void refreshExecutionMode().catch(() => undefined);
    turn.selectionTimer = setInterval(() => {
      if (!isCurrent(turn) && !turn.finished) abandon(turn, 'Selected host or credentials changed. Detached from this native turn; its remote outcome is unconfirmed.');
    }, 100);
    turn.selectionTimer.unref?.();
    try {
      const renderer = await watch(turn, connection.baseUrl, connection.token, snapshot.sessionId);
      const outcome: Extract<RemoteTurnOutcome, { routed: true }> = {
        routed: true, hostedSessionId: snapshot.sessionId, completion: renderer.completion(),
      };
      nativeObservations.set(key, { turn, outcome });
      void outcome.completion.then(value => { if (value.status === 'abandoned' && nativeObservations.get(key)?.outcome === outcome) nativeObservations.delete(key); });
      return outcome;
    } catch {
      abandon(turn, 'Native turn observation could not be opened. The original hosted dispatch remains authoritative; inspect /work intake-status.');
      return refuse('Native turn observation is unavailable. No legacy turn was started.', true);
    }
  };

  return {
    observeNative,
    hostedSessionId: () => hostedId,
    executionMode: () => {
      try { currentModeOwner(); return hostedMode; } catch { return undefined; }
    },
    setExecutionMode: setRemoteExecutionMode,
    refreshExecutionMode,
    cancelTurn: () => {
      const turn = active;
      if (!turn || !isCurrent(turn) || turn.renderer?.isTurnFinished()) return false;
      if (!turn.cancelRequest && !turn.cancellationAcknowledged) turn.cancelQueued = true;
      sendCancellation(turn);
      return true;
    },
    detach: async (timeoutMs = DEFAULT_DETACH_TIMEOUT_MS) => {
      const id = hostedId;
      endRenewal();
      if (!id) return 'none';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          options.verbs.invoke<unknown>('sessions.hosted.detach', { sessionId: id, clientId: options.clientId })
            .then(() => 'detached' as const),
          new Promise<'failed'>((resolve) => { timer = setTimeout(() => resolve('failed'), timeoutMs); timer.unref?.(); }),
        ]);
      } catch (error) {
        logger.debug('[remote-conversation] leaving the hosted session was refused', { sessionId: id, error: String(error) });
        return 'failed';
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    reset: () => {
      const id = hostedId;
      endRenewal();
      hostedId = null; hostedConnection = undefined; hostedMode = undefined;
      modeObservation++; modeRequest++;
      if (active) { abandon(active, 'The conversation was cleared before the hosted turn settled. Clearing did not cancel the remote turn.'); }
      if (id) detachQuietly(id);
    },
    dispose: () => {
      disposed = true;
      endRenewal();
      if (active) { abandon(active, 'This surface detached before the hosted turn settled. Detaching does not cancel the remote turn.'); }
    },
  };
}
