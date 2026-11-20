import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState, RefObject } from 'react';
import { client as platformClient, DEFAULT_SSE_RECONNECT } from '../../lib/goodvibes';
import { getClientLifetime, isClientLifetimeCurrent } from '../../lib/client-lifetime';
import { asRecord, firstString } from '../../lib/object';
import { RefusalError } from '@goodvibes-jev/engine/errors';
import { readStreamGapDropped } from '@goodvibes-jev/engine/transport-core/errors';
import { noteRelayOverflow } from '../../lib/relay-stream-overflow';
import { isSessionNotFoundError, isAuthExpiredError, isMethodUnavailableError, isNoActiveTurnError, isTurnStoppingError } from '../../lib/errors';
import type { ToolActivityWords } from '@goodvibes-jev/engine/contracts';
import { LocalCompanionMessage } from '../../lib/companion-chat';
import {
  ACTIVE_TURN_STATES,
  assistantContentFromCompletedTurn,
  companionEventType,
  nextTurnStatus,
  readToolActivityWords,
  type CompletedToolCall,
  type StreamHealth,
  type TurnState,
} from './message-utils';

/**
 * Cap on how many completed turns' tool activity are retained in
 * toolActivityByMessageId at once, an insertion-ordered Map, oldest evicted
 * first. Purely a memory ceiling for a very long-lived tab; unrelated to any
 * server-side retention (this state never touches the daemon).
 */
const MAX_TOOL_ACTIVITY_ENTRIES = 200;

function withToolActivity(
  current: ReadonlyMap<string, readonly CompletedToolCall[]>,
  messageId: string,
  calls: readonly CompletedToolCall[],
): ReadonlyMap<string, readonly CompletedToolCall[]> {
  if (!messageId || calls.length === 0) return current;
  const next = new Map(current);
  next.set(messageId, calls);
  while (next.size > MAX_TOOL_ACTIVITY_ENTRIES) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }
  return next;
}

interface UseChatStreamOptions {
  activeSessionId: string;
  liveTextRef: RefObject<string>;
  onSessionMissing: (sessionId: string) => void;
  setTurnState: Dispatch<SetStateAction<TurnState>>;
  setTurnError: Dispatch<SetStateAction<string>>;
  setLiveText: Dispatch<SetStateAction<string>>;
  setLocalMessages: Dispatch<SetStateAction<LocalCompanionMessage[]>>;
  setPendingUserMessageId: Dispatch<SetStateAction<string>>;
  invalidateChatState: (sessionId: string) => Promise<void>;
  /**
   * Called once when the stream (or a send) discovers the token has expired mid-
   * session (401 / category:'authentication'). The caller re-probes auth.current,
   * which, for a genuinely dead token, flips the app into the signed-out gate. This
   * hook never retries a dead token itself; it hands off and stops.
   */
  onAuthExpired: () => void;
  /**
   * The authoritative turn state managed by the caller (ChatView), the same
   * value fed to `setTurnState`, so `isStreaming` is right during the
   * sending/submitted window before the first stream frame arrives.
   */
  turnState?: TurnState;
}

/**
 * One tool call currently in flight for the active turn (turn.tool_call ->
 * turn.tool_result). `cancelled` is set OPTIMISTICALLY the instant
 * sessions.toolCalls.cancel resolves `cancelled: true`, the entry is not
 * removed until the matching turn.tool_result (or a terminal turn event)
 * actually arrives, so "Cancelled" renders honestly for exactly as long as the
 * daemon is still winding the call down, never flashing to nothing early.
 */
export interface ActiveToolCall {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** The words the tool's definition gives this call, as `turn.tool_call` carried them. */
  readonly activity?: ToolActivityWords;
  /** The call's arguments, as `turn.tool_call` carried them: the line shows its key argument. */
  readonly toolInput?: unknown;
  readonly cancelled: boolean;
}

export interface UseChatStreamResult {
  /** Whether a turn is in flight on the daemon, whatever the stream's health. */
  isStreaming: boolean;
  /**
   * The live connection's own health, owned here and set by the stream's
   * callbacks: `live` on every successful open (first connect, automatic
   * reconnect or a Retry alike), `reconnecting` while the built-in reconnect
   * retries, `paused` once it gave up or the stream could not be opened.
   */
  streamHealth: StreamHealth;
  /**
   * Stop the in-flight turn, a TRUE server-side stop: calls
   * companion.chat.turns.cancel and keeps the stream open awaiting the
   * terminal turn.cancelled event (which also converges every other
   * connected client). Falls back to the old local-render stop, honestly
   * labeled, only on a pre-1.4 daemon that doesn't serve the verb.
   */
  stop: () => void;
  /**
   * Force a fresh connection attempt after the stream gave up (`paused`).
   * The built-in reconnect only retries up to DEFAULT_SSE_RECONNECT.maxAttempts with
   * backoff; once exhausted the platform stops entirely on its own, so recovery needs an
   * explicit re-open. Safe to call any time, it just re-runs the connect effect.
   */
  retryStream: () => void;
  /** Tool calls currently running for this turn (see ActiveToolCall). Empty outside
   *  a 'tooling' window and cleared on every terminal turn event. */
  activeToolCalls: readonly ActiveToolCall[];
  /**
   * Completed tool calls (name, input, result) for every turn this browser tab has
   * watched finish live, keyed by the assistant message id the turn produced,
   * ChatView attaches these onto the matching rendered message (whether it came
   * from local optimistic state or the server-fetched history) so the fold
   * renders regardless of which source produced that message object. Built
   * purely from turn.tool_call/turn.tool_result/turn.completed stream events;
   * never present for a turn this tab did not watch live (server history has no
   * tool data, see CompletedToolCall's doc comment).
   */
  toolActivityByMessageId: ReadonlyMap<string, readonly CompletedToolCall[]>;
  /**
   * Cancel ONE running tool call (sessions.toolCalls.cancel), the turn itself
   * continues; only this one call is stopped. Marks the local entry
   * `cancelled: true` on a `{cancelled: true}` response; a `{cancelled: false}`
   * response (the daemon declined, e.g. the call already finished) surfaces via
   * the returned promise so the caller can toast the honest reason.
   */
  cancelToolCall: (callId: string) => Promise<{ cancelled: boolean }>;
}

export function useChatStream({
  activeSessionId,
  liveTextRef,
  onSessionMissing,
  setTurnState,
  setTurnError,
  setLiveText,
  setLocalMessages,
  setPendingUserMessageId,
  invalidateChatState,
  onAuthExpired,
  turnState,
}: UseChatStreamOptions): UseChatStreamResult {
  // Ref to the SSE disconnect fn so stop() can call it at any time. Owned by the
  // CURRENT connection effect only, a stale effect never writes here (see the
  // per-effect `cancelled` flag in the connect effect below).
  const disconnectRef = useRef<(() => void) | undefined>(undefined);
  // Intra-turn stop signal for the CURRENT connection effect: set by stop() so the
  // live stream's callbacks and its (possibly still-pending) open promise both go
  // inert for the rest of this turn. Distinct from the per-effect `cancelled` flag,
  // which handles the CROSS-effect case (session switch / retry / unmount).
  const stoppedRef = useRef(false);
  // True from a local stop until the next send reopens the stream: the local stop
  // leaves this connection inert, so the next turn would never be streamed.
  const stoppedLocallyRef = useRef(false);
  const connectionOwner = useRef<object | null>(null);
  // Bumped by retryStream() to force a fresh connect after the platform's own
  // reconnect loop gives up (it never retries again on its own past onEnd).
  const [retryNonce, setRetryNonce] = useState(0);
  const [streamHealth, setStreamHealth] = useState<StreamHealth>('connecting');
  // True while this session's stream has been down since its last successful
  // open, so the next open refreshes the transcript (frames sent meanwhile were
  // not replayed). A Retry keeps it; a different session starts clean.
  const streamWasDownRef = useRef(false);
  const streamSessionRef = useRef('');
  // Tool calls currently in flight for this turn, see ActiveToolCall's own doc comment.
  const [activeToolCalls, setActiveToolCalls] = useState<readonly ActiveToolCall[]>([]);
  // Completed tool calls, keyed by the assistant message id of the turn that produced
  // them, see toolActivityByMessageId's own doc comment on UseChatStreamResult.
  const [toolActivityByMessageId, setToolActivityByMessageId] = useState<
    ReadonlyMap<string, readonly CompletedToolCall[]>
  >(new Map());
  // Accumulates completed tool calls for the turn CURRENTLY in flight, flushed into
  // toolActivityByMessageId (keyed by assistantMessageId) on turn.completed,
  // turn.cancelled and turn.error (the daemon stores a failed reply too).
  const turnToolActivityRef = useRef<CompletedToolCall[]>([]);
  // toolCallId -> {toolName, toolInput} captured at turn.tool_call time, so the
  // matching turn.tool_result can build a full CompletedToolCall without the daemon
  // having to repeat the input back on the result event.
  const pendingToolInputRef = useRef<Map<string, { toolName: string; activity?: ToolActivityWords; toolInput: unknown; startedAt: number }>>(new Map());
  /**
   * The turn this tab is showing: frames of any other turn (an earlier turn's
   * late delta, a frame from before a reconnect) are not applied to it. Empty
   * until a turn starts, or the first frame of a turn already running names it.
   */
  const currentTurnIdRef = useRef('');
  /** Turns that already ended here: a late frame of one never reopens it. */
  const endedTurnIdsRef = useRef<Set<string>>(new Set());

  // Latest turn status this hook knows of (the prop each render, plus every plain
  // write made through syncedSetTurnState), so stop()'s late catch can tell a
  // turn that already settled from one still in flight.
  const turnStateRef = useRef<TurnState>(turnState ?? 'idle');
  useEffect(() => {
    turnStateRef.current = turnState ?? 'idle';
  }, [turnState]);

  // Forward state updates to the caller's authoritative turnState.
  const syncedSetTurnState: Dispatch<SetStateAction<TurnState>> = useCallback(
    (nextState) => {
      if (typeof nextState === 'string') turnStateRef.current = nextState;
      setTurnState(nextState);
    },
    [setTurnState],
  );

  // The pre-1.4 behavior, kept as the honest fallback: stops RENDERING only.
  const stopLocally = useCallback(() => {
    stoppedRef.current = true;
    stoppedLocallyRef.current = true;
    disconnectRef.current?.();
    disconnectRef.current = undefined;
    liveTextRef.current = '';
    setLiveText('');
  }, [liveTextRef, setLiveText]);

  const stop = useCallback(() => {
    if (!activeSessionId) return;
    const owner = connectionOwner.current;
    const lifetime = getClientLifetime();
    turnStateRef.current = 'stopping';
    setTurnState('stopping');
    void platformClient.chat.turns.cancel(activeSessionId).catch((error: unknown) => {
      if (!owner || connectionOwner.current !== owner || !isClientLifetimeCurrent(lifetime)) return;
      if (isNoActiveTurnError(error)) {
        // Benign: the turn finished before the stop landed. The terminal
        // turn.completed already (or will) settle the state; just don't get
        // stuck in 'stopping' if it already did.
        setTurnState((current) => (current === 'stopping' ? 'idle' : current));
        return;
      }
      if (isTurnStoppingError(error)) {
        // The stop was accepted and the turn is still ending (a slow tool call): it stays
        // 'stopping' until the terminal turn.cancelled event arrives on the stream.
        return;
      }
      if (isMethodUnavailableError(error)) {
        // Pre-1.4 daemon: no server-side stop exists. Do the old local stop
        // and SAY exactly what that means, never pretend the turn is dead.
        stopLocally();
        setTurnState('stopped locally');
        setTurnError(
          'Stopped rendering only. This daemon does not support stopping a turn '
          + 'server-side (update the connected daemon). The reply may still finish and will '
          + 'appear in the history.',
        );
        return;
      }
      // A terminal outcome (completed/stopped/...) may have arrived while the
      // cancel request was in flight: a late failure must not overwrite it, nor
      // leave an error message next to a settled turn.
      if (nextTurnStatus(turnStateRef.current, 'error') !== 'error') return;
      setTurnState((current) => nextTurnStatus(current, 'error'));
      setTurnError(error instanceof Error ? error.message : String(error));
    });
    // On success nothing else happens here: the terminal turn.cancelled event
    // on the open stream is the authoritative signal (for this client AND
    // every other subscriber).
  }, [activeSessionId, setTurnState, setTurnError, stopLocally]);

  const retryStream = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!stoppedLocallyRef.current) return;
    if (turnState === 'sending' || turnState === 'submitted') {
      stoppedLocallyRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reopens the stream a local stop closed
      setRetryNonce((n) => n + 1);
    }
  }, [turnState]);

  useEffect(() => {
    if (!activeSessionId) {
      // A new chat has no stream yet; an older chat's paused stream says nothing here.
      setStreamHealth('connecting');
      return undefined;
    }
    // Per-effect cancellation flag, the "epoch" of THIS connection instance. Set to
    // true by this effect's own cleanup and nothing else; a superseding effect (a
    // session switch, a retryStream(), or unmount) runs this cleanup FIRST, so the
    // outgoing effect's `cancelled` is already true before the incoming effect touches
    // any shared ref. Every callback below, plus the stream-open .then/.catch, closes
    // over ITS OWN `cancelled`. That is what makes a late callback from the OLD stream
    // inert: it reads its own `cancelled` (true), never the shared stoppedRef the new
    // effect just reset to false. Without this, a platform stream() whose disconnect handle
    // only resolves AFTER the switch would (a) let the old stream's onReconnect/onEvent
    // clobber the new session's state, and (b) store the OLD handle into the shared
    // disconnectRef, orphaning the new stream. See the "session switch mid-handshake"
    // tests.
    let cancelled = false;
    const owner = {};
    connectionOwner.current = owner;
    stoppedRef.current = false;
    stoppedLocallyRef.current = false;
    disconnectRef.current = undefined;
    setLiveText('');
    liveTextRef.current = '';
    setTurnError('');
    setActiveToolCalls([]);
    turnToolActivityRef.current = [];
    pendingToolInputRef.current.clear();
    currentTurnIdRef.current = '';
    if (streamSessionRef.current !== activeSessionId) {
      endedTurnIdsRef.current = new Set();
      streamSessionRef.current = activeSessionId;
      streamWasDownRef.current = false;
    }
    setStreamHealth('connecting');

    // Guards the auth-expiry handoff to fire exactly once per connection instance,
    // idempotent either way, but avoids redundant invalidateQueries churn if the dead
    // token keeps producing 401s across more than one handler callback.
    let handledAuthExpiry = false;

    const handleAuthExpiry = (error: unknown): boolean => {
      if (handledAuthExpiry) return true;
      if (!isAuthExpiredError(error)) return false;
      handledAuthExpiry = true;
      onAuthExpired();
      syncedSetTurnState('session expired');
      setTurnError('Your session expired: sign in again to continue.');
      // Stop relying on the built-in reconnect loop: a stale token will just keep
      // 401ing on every retry, burning the bounded attempt budget for nothing.
      disconnectRef.current?.();
      return true;
    };

    void platformClient.chat.events.stream(activeSessionId, {
      onReady: () => {
        if (cancelled || stoppedRef.current) return;
        setStreamHealth('live');
        if (streamWasDownRef.current) {
          streamWasDownRef.current = false;
          // Frames sent while the stream was down are not replayed: one refresh of
          // the transcript shows what happened, and a turn this tab was following
          // may have ended meanwhile, so it waits on that refresh ('syncing')
          // unless the stream reports it first.
          void invalidateChatState(activeSessionId);
          // Text streamed before the drop has a gap now; the refreshed message or
          // the frames still to come replace it.
          liveTextRef.current = '';
          setLiveText('');
          syncedSetTurnState((current) => (
            current === 'submitted' || current === 'running' || current === 'streaming'
            || current === 'tooling' || current === 'stopping' ? 'syncing' : current
          ));
        }
      },
      // Turn frames were dropped (by the daemon for a slow reader, or by the relay). Record the
      // honest notice and resync this session's chat state: the missed frames may include turn
      // deltas, so a refetch of the authoritative message list restores the true transcript.
      onGap: (gap) => {
        if (cancelled || stoppedRef.current) return;
        noteRelayOverflow(gap.dropped);
        // The dropped frames may include deltas: the live text has a hole, so it
        // is cleared and the refetched transcript (or the frames still to come) replaces it.
        liveTextRef.current = '';
        setLiveText('');
        void invalidateChatState(activeSessionId);
      },
      onEvent: ({ name: eventName, payload }) => {
        if (cancelled || stoppedRef.current) return;
        if (!eventName.startsWith('companion-chat.')) return;
        if (firstString(payload, ['sessionId']) !== activeSessionId) return;
        const type = companionEventType(eventName, payload);
        // Frames apply only to the turn being shown: one that names another turn is dropped.
        const frameTurnId = firstString(payload, ['turnId']);
        if (type === 'turn.started') {
          if (frameTurnId) {
            if (endedTurnIdsRef.current.has(frameTurnId)) return;
            currentTurnIdRef.current = frameTurnId;
          }
        } else if (type.startsWith('turn.') && frameTurnId) {
          if (endedTurnIdsRef.current.has(frameTurnId)) return;
          if (!currentTurnIdRef.current) currentTurnIdRef.current = frameTurnId;
          else if (currentTurnIdRef.current !== frameTurnId) return;
        }
        if ((type === 'turn.completed' || type === 'turn.cancelled' || type === 'turn.error') && frameTurnId) {
          endedTurnIdsRef.current.add(frameTurnId);
          // A few dozen turns at most per open chat; the oldest are forgotten past 64.
          if (endedTurnIdsRef.current.size > 64) endedTurnIdsRef.current.delete(endedTurnIdsRef.current.values().next().value!);
          currentTurnIdRef.current = '';
        }

        if (type === 'turn.started') {
          setLiveText('');
          liveTextRef.current = '';
          // Fresh turn: drop any leftover tool-activity bookkeeping from a turn that
          // never reached a terminal event (should not happen, but never carry a
          // prior turn's tool calls into this one's fold).
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          syncedSetTurnState('running');
          void invalidateChatState(activeSessionId);
          return;
        }

        if (type === 'turn.delta') {
          const delta = firstString(payload, ['delta']);
          if (delta) {
            liveTextRef.current += delta;
            setLiveText((current) => current + delta);
          }
          syncedSetTurnState((current) => nextTurnStatus(current, 'streaming'));
          return;
        }

        if (type === 'turn.tool_call') {
          const turnId = firstString(payload, ['turnId']);
          const toolCallId = firstString(payload, ['toolCallId']);
          const toolName = firstString(payload, ['toolName']);
          const activity = readToolActivityWords(asRecord(payload).activity);
          if (toolCallId) {
            setActiveToolCalls((current) => (
              current.some((c) => c.toolCallId === toolCallId)
                ? current
                : [...current, { turnId, toolCallId, toolName, ...(activity ? { activity } : {}), toolInput: asRecord(payload).toolInput, cancelled: false }]
            ));
            // Captured so the matching turn.tool_result (which does not repeat the
            // input back) can still build a full CompletedToolCall for the fold.
            pendingToolInputRef.current.set(toolCallId, { toolName, ...(activity ? { activity } : {}), toolInput: asRecord(payload).toolInput, startedAt: Date.now() });
          }
          syncedSetTurnState((current) => nextTurnStatus(current, 'tooling'));
          return;
        }

        if (type === 'turn.tool_result') {
          // The tool call ended (normally OR because it was cancelled, either way
          // the daemon's own result arrived, so the honest thing is to drop the
          // entry rather than leave a stale "Cancelled" chip behind).
          const toolCallId = firstString(payload, ['toolCallId']);
          if (toolCallId) {
            setActiveToolCalls((current) => current.filter((c) => c.toolCallId !== toolCallId));
            const pending = pendingToolInputRef.current.get(toolCallId);
            pendingToolInputRef.current.delete(toolCallId);
            const resultRecord = asRecord(payload);
            turnToolActivityRef.current = [
              ...turnToolActivityRef.current,
              {
                toolCallId,
                toolName: pending?.toolName ?? firstString(payload, ['toolName']),
                ...(pending?.activity ? { activity: pending.activity } : {}),
                toolInput: pending?.toolInput,
                result: resultRecord.result,
                isError: Boolean(resultRecord.isError),
                // Timed by this browser: the row's "· 4 s" is what the person waited.
                ...(pending ? { startedAt: pending.startedAt, finishedAt: Date.now() } : {}),
              },
            ];
          }
          syncedSetTurnState((current) => nextTurnStatus(current, 'tooling'));
          return;
        }

        if (type === 'turn.completed') {
          const assistantMessageId = firstString(payload, ['assistantMessageId', 'messageId']);
          const assistantContent = assistantContentFromCompletedTurn(payload, liveTextRef.current);
          if (assistantContent) {
            setLocalMessages((current) => [
              ...current,
              {
                id: assistantMessageId || `assistant-${firstString(payload, ['turnId']) || Date.now()}`,
                sessionId: activeSessionId,
                role: 'assistant' as const,
                content: assistantContent,
                createdAt: Date.now(),
                deliveryState: 'sent' as const,
              },
            ]);
          }
          // The terminal event ends the turn; the one refresh below brings the
          // stored reply when the event carried none.
          setPendingUserMessageId('');
          syncedSetTurnState('completed');
          // Fold this turn's completed tool calls onto the message they produced,
          // matched by id whether the message renders from this optimistic local
          // copy or from the server-fetched history that invalidateChatState below
          // brings in (both end up with the same assistantMessageId).
          const completedCalls = turnToolActivityRef.current;
          if (completedCalls.length) {
            setToolActivityByMessageId((current) => withToolActivity(current, assistantMessageId, completedCalls));
          }
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          setLiveText('');
          liveTextRef.current = '';
          setActiveToolCalls([]);
          void invalidateChatState(activeSessionId);
          return;
        }

        if (type === 'turn.cancelled') {
          // Terminal, exactly like turn.completed/turn.error. The daemon has
          // already persisted the honest partial (deliveryState 'cancelled')
          // when partialPersisted is true; the refetch below renders it with
          // its badge, so no optimistic local copy is needed.
          const assistantMessageId = firstString(payload, ['assistantMessageId']);
          const completedCalls = turnToolActivityRef.current;
          if (assistantMessageId && completedCalls.length) {
            setToolActivityByMessageId((current) => withToolActivity(current, assistantMessageId, completedCalls));
          }
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          setPendingUserMessageId('');
          syncedSetTurnState('stopped');
          setLiveText('');
          liveTextRef.current = '';
          setActiveToolCalls([]);
          void invalidateChatState(activeSessionId);
          return;
        }

        if (type === 'turn.error') {
          setLiveText('');
          liveTextRef.current = '';
          // The daemon stores the failed reply (deliveryState 'failed', with its
          // partial and reason) under assistantMessageId; this turn's completed
          // tool calls fold onto it as they do on a stopped reply.
          const failedReplyId = firstString(payload, ['assistantMessageId']);
          const completedCalls = turnToolActivityRef.current;
          if (failedReplyId && completedCalls.length) {
            setToolActivityByMessageId((current) => withToolActivity(current, failedReplyId, completedCalls));
          }
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          syncedSetTurnState('error');
          // A stored failed reply says why in the conversation (its failure row); only a turn
          // with no stored reply says it above the composer.
          if (!failedReplyId) setTurnError(firstString(payload, ['error']) || 'Companion chat turn failed.');
          setActiveToolCalls([]);
          void invalidateChatState(activeSessionId);
        }
      },
      // A drop the built-in reconnect is about to retry. The turn is untouched:
      // the daemon keeps working, only this tab's channel is down.
      onReconnect: ({ error }) => {
        if (cancelled || stoppedRef.current) return;
        if (isSessionNotFoundError(error)) {
          onSessionMissing(activeSessionId);
          return;
        }
        if (handleAuthExpiry(error)) return;
        streamWasDownRef.current = true;
        setStreamHealth('reconnecting');
        // The relay ended the tunnelled stream because it dropped chunks; the reconnect
        // resumes from the last event id and the open refreshes the transcript.
        const dropped = readStreamGapDropped(error);
        if (dropped !== undefined) noteRelayOverflow(dropped);
      },
      // The stream ended for good (the built-in reconnect gave up, or the daemon ended it).
      // ChatView then refreshes the transcript slowly until retryStream() re-opens the stream.
      onEnd: (end) => {
        if (cancelled || stoppedRef.current || end.kind === 'closed') return;
        if (end.kind === 'failed') {
          const error = new RefusalError(end.refusal);
          if (isSessionNotFoundError(error)) {
            onSessionMissing(activeSessionId);
            return;
          }
          if (handleAuthExpiry(error)) return;
        }
        streamWasDownRef.current = true;
        setStreamHealth('paused');
      },
    }, { reconnect: DEFAULT_SSE_RECONNECT }).then((nextDisconnect) => {
      // The platform only yields the disconnect handle AFTER the handshake. If this effect
      // was superseded (cancelled) or the turn was stopped while that promise was still
      // pending, the handle is already orphaned: disconnect it immediately and never
      // store it, storing a stale handle here is exactly what used to clobber the new
      // session's live disconnectRef.
      if (cancelled || stoppedRef.current) {
        nextDisconnect();
        return;
      }
      disconnectRef.current = nextDisconnect;
    }).catch((err: unknown) => {
      if (!cancelled && !stoppedRef.current) {
        if (isSessionNotFoundError(err)) {
          onSessionMissing(activeSessionId);
          return;
        }
        if (handleAuthExpiry(err)) return;
        streamWasDownRef.current = true;
        setStreamHealth('paused');
      }
    });

    return () => {
      // Set ONLY this effect's own flag. Its late callbacks / late-resolving open
      // promise read this same closure variable and go inert; the incoming effect
      // (which has already run its predecessor's cleanup by the time it executes)
      // starts with a fresh `cancelled = false` of its own.
      cancelled = true;
      if (connectionOwner.current === owner) connectionOwner.current = null;
      stoppedRef.current = true;
      disconnectRef.current?.();
      disconnectRef.current = undefined;
    };
  }, [
    activeSessionId,
    onSessionMissing,
    onAuthExpired,
    invalidateChatState,
    syncedSetTurnState,
    setLiveText,
    liveTextRef,
    setTurnError,
    setLocalMessages,
    setPendingUserMessageId,
    retryNonce,
  ]);

  const isStreaming = ACTIVE_TURN_STATES.includes(turnState ?? 'idle');

  // cancelToolCall: the turn ITSELF keeps running, only this one tool call is
  // stopped (unlike stop(), which ends the whole turn). Marks the local entry
  // cancelled:true on {cancelled:true}; the entry is removed for real once the
  // matching turn.tool_result (or a terminal turn event) arrives above.
  const cancelToolCall = useCallback(
    async (callId: string): Promise<{ cancelled: boolean }> => {
      const result = await platformClient.operator.sessions.toolCalls.cancel(activeSessionId, callId);
      if (result.cancelled) {
        setActiveToolCalls((current) => current.map((c) => (c.toolCallId === callId ? { ...c, cancelled: true } : c)));
      }
      return result;
    },
    [activeSessionId],
  );

  return { isStreaming, streamHealth, stop, retryStream, activeToolCalls, toolActivityByMessageId, cancelToolCall };
}
