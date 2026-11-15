import { bindActiveExecutionMode } from '../permissions/execution-mode.ts';
/**
 * remote-conversation-wiring.ts, the composer's one decision about WHERE a
 * turn runs.
 *
 * The router itself (runtime/client/remote-conversation.ts) knows how to
 * observe a hosted turn that native intake delivered and how to render it.
 * This is the surface half: what the composer does with the answer, mirror the
 * user's message when the host took the turn, and say one honest line when it
 * did not.
 *
 * It lives beside main.ts rather than inside it so the composer keeps one call
 * where it used to have one call.
 */

import type { NativeConversationInput } from '../runtime/native-conversation-input.ts';
import { nativeConversationIntakeLines, type NativeConversationIntakeActions, type NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import { createRemoteConversationRouter, sameNativeRemoteConnection, type ConnectedHostResolution } from '../runtime/client/remote-conversation.ts';
import { mirrorHostedSessionToStore, recoverUnmirroredHostedSessions, type HostedAttachReply } from '../runtime/client/hosted-session-mirror.ts';
import { persistConversation, readLastSessionPointer, saveSession } from '@/runtime/index.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { BootstrapContext } from '../runtime/bootstrap.ts';
import type { HostedSessionFrame, HostedTurnCompletion } from '../runtime/client/hosted-frame-render.ts';
import { bridgeHostedFrameOntoRuntimeBus } from '../runtime/client/hosted-turn-bus-bridge.ts';
import { createHostedTurnActivity, type HostedTurnActivity } from './hosted-turn-activity.ts';

export interface RemoteConversationWiringOptions {
  readonly render: () => void;
  /** Passed through to the router, see its `onFrame`. */
  readonly onFrame?: ((frame: HostedSessionFrame) => void) | undefined;
  /**
   * How a one-line notice reaches the person. The same channel the surface
   * already uses for the lines it must not bury.
   */
  readonly notify: (message: string) => void;
  /** Hand refused, unsent text back to the composer so a refusal never costs the person their typing. */
  readonly restoreDraft?: ((text: string) => void) | undefined;
}

export interface RemoteConversationWiring {
  /** Request cancellation while retaining observation until terminal settlement. */
  cancelHostedTurn(): boolean;
  /**
   * The tool a hosted turn is running right now, for the shell's tool preview
   * and Activity modal, both of which otherwise read a local snapshot that
   * a daemon-hosted turn never fills in.
   */
  hostedToolPreview(): string | undefined;
  /**
   * Leave the hosted session this surface is attached to, so the daemon applies
   * its detach policy when the last client goes. Bounded; never throws.
   * Resolves 'none' when nothing was attached.
   */
  detachHostedSession(): Promise<'none' | 'detached' | 'failed'>;
  /** The local conversation was cleared or replaced: the next message opens a new hosted session. */
  resetHostedSession(): void;
  dispose(): void;
  /**
   * True for a turn the connected host ran (its frames carried this turn id).
   * The host's transcript is that conversation's record, so the local autosave
   * and crash snapshot skip it.
   */
  isHostedTurn?(turnId: string): boolean;
}

export interface NativeRemoteConversationWiring extends RemoteConversationWiring {
  /**
   * Decide where this turn runs and act on it. Native admission always
   * precedes delivery. Returns a HANDLE when the connected host has the turn:
   * an interactive caller discards it, because the turn renders itself from
   * the hosted session's event stream; a caller that must wait for one answer
   * awaits `completion`. Returns `null` only when local routing was chosen.
   * `onNotSent` runs when the message is refused before anything was submitted, so the caller can give back what it took for it. */
  routeNativeOrExplain(source: NativeConversationInput, intake: NativeConversationIntakeActions | undefined, onNotSent?: () => void): Promise<RoutedTurnHandle | null>;
  /** Explicit recovery observes the exact saved original without submitting it again. */
  observeNative(state: NativeConversationIntakeState, intake: NativeConversationIntakeActions): Promise<RoutedTurnHandle>;
  /** The same intake, reporting explicit recovery results (/work intake-*) back to this owner. */
  observeIntake(intake: NativeConversationIntakeActions): NativeConversationIntakeActions;
}

/** Why a mode change is refused while a native input's hosted owner is still unconfirmed. */
const UNCONFIRMED_NATIVE_OWNER_MODE_REASON = 'The native input sent from this surface is not yet confirmed by its host, so its '
  + 'execution mode has no confirmed owner. Nothing was changed here or on the host. Inspect it with /work intake-status; '
  + 'once the host reports it settled, or after /work intake-cancel, change the mode again.';

/** A turn the daemon accepted, and the way to wait for how it ended. */
export interface RoutedTurnHandle {
  readonly hostedSessionId: string | null;
  readonly completion: Promise<HostedTurnCompletion>;
}

/** A daemon that accepts the connection and never answers must not hold a socket per completed turn. */
const NATIVE_MIRROR_ATTACH_TIMEOUT_MS = 15_000;

/**
 * The native mirror's attach call. The caller owns the deadline through
 * `signal`, which also covers reading the reply body.
 */
export async function postNativeMirrorAttach(
  connection: { readonly baseUrl: string; readonly token: string },
  body: { readonly sessionId: string; readonly clientId: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly ok: false } | { readonly ok: true; readonly reply: unknown }> {
  const response = await fetchImpl(`${connection.baseUrl}/api/control-plane/methods/sessions.hosted.attach/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
    signal,
  });
  if (!response.ok) return { ok: false };
  return { ok: true, reply: await response.json() };
}

export function installRemoteConversationRouting(
  ctx: BootstrapContext,
  options: RemoteConversationWiringOptions,
): NativeRemoteConversationWiring {
  const conversation = ctx.conversation;
  let routeSequence = 0;
  let disposed = false;
  type PendingNativeAdmission = { readonly intake: NativeConversationIntakeActions; readonly sequence: number; request?: { readonly requestId: string; readonly inputId: string } };
  let nativePending: PendingNativeAdmission | undefined;
  let nativeOwnerUnconfirmed = false;
  // The observed native turn's claim on the shared indicator. Stop can hand that
  // claim forward to its own sequence when it leaves the observation running.
  let observedIndicator: { sequence: number } | undefined;
  // Inputs whose user message is already in the transcript, so a recovery that
  // observes the same input again does not repeat it. Keyed by request and
  // input id only; an entry ends when its turn settles.
  const nativeMirrored = new Set<string>();
  // The waiting state a hosted turn shows is the orchestrator's own, driven on
  // the orchestrator's own cadence, see hosted-turn-activity.ts. Nothing in
  // the render loop has to know that hosted turns exist.
  const activity: HostedTurnActivity = createHostedTurnActivity({
    turnState: ctx.orchestrator,
    requestRender: options.render,
  });
  const clientId = `goodvibes-agent:${ctx.runtime.sessionId}`;
  // Turn ids the host ran, newest kept; read synchronously by the autosave
  // when the bridged TURN_COMPLETED fires.
  const hostedTurnIds = new Set<string>();
  const noteHostedTurn = (frame: HostedSessionFrame): void => {
    const turnId = frame.payload?.['turnId'];
    if (typeof turnId !== 'string' || hostedTurnIds.has(turnId)) return;
    hostedTurnIds.add(turnId);
    if (hostedTurnIds.size > 64) hostedTurnIds.delete(hostedTurnIds.values().next().value as string);
  };
  /**
   * Put the daemon's authoritative transcript into this agent's session store
   * and move last-session.json onto it, so the conversation is resumable from
   * the surface that started it. Failures are reported, never thrown: a turn
   * that answered the person correctly must not look failed because the mirror
   * could not be written.
   */
  const mirrorHostedSession = async (
    hostedSessionId: string, current: () => boolean,
    connection: Extract<ConnectedHostResolution, { readonly baseUrl: string }>,
  ): Promise<void> => {
    if (!current()) return;
    const outcome = await mirrorHostedSessionToStore(hostedSessionId, {
      // A native completion never re-resolves a different host or token while
      // its asynchronous attachment is in flight.
      verbs: { async invoke<T>(method: string): Promise<T> {
        if (!current() || method !== 'sessions.hosted.attach') throw new Error('Native mirror selection changed');
        const attached = await postNativeMirrorAttach(connection, { sessionId: hostedSessionId, clientId }, AbortSignal.timeout(NATIVE_MIRROR_ATTACH_TIMEOUT_MS));
        if (!current() || !attached.ok) throw new Error('Native mirror attachment was not confirmed');
        const reply = attached.reply as HostedAttachReply;
        if (!current() || reply.session.id !== hostedSessionId) throw new Error('Native mirror identity changed');
        return reply as T;
      } },
      clientId,
      persist: (sessionId, snapshot, model, provider, title) => {
        if (!current()) throw new Error('Hosted mirror selection changed');
        persistConversation(sessionId, snapshot, model, provider, title, { surface: ctx.services.surface }, 'auto');
      },
      fallbackModel: ctx.runtime.model,
      fallbackProvider: ctx.runtime.provider,
    });
    if (!outcome.mirrored && current()) logger.warn('[remote-conversation] a hosted conversation was not mirrored into the session store', {
      hostedSessionId, reason: outcome.reason,
    });
  };

  // The crash path, run once at install: a surface that died mid-turn was never
  // handed a completion, so nothing mirrored at turn end. The daemon still has
  // those transcripts. Fire-and-forget, a daemon that is slow or absent at
  // boot must not delay the shell coming up.
  void recoverUnmirroredHostedSessions({
    verbs: ctx.services.daemonVerbs,
    clientId,
    persist: (sessionId, snapshot, model, provider, title, movePointer) => {
      if (movePointer === false) saveSession(sessionId, snapshot, model, provider, title, { surface: ctx.services.surface }, 'auto');
      else persistConversation(sessionId, snapshot, model, provider, title, { surface: ctx.services.surface }, 'auto');
    },
    pointerTargetTimestamp: () => {
      try {
        const target = readLastSessionPointer({ surface: ctx.services.surface });
        return target ? ctx.services.sessionManager.getMeta(target)?.timestamp ?? null : null;
      } catch {
        return null;
      }
    },
    fallbackModel: ctx.runtime.model,
    fallbackProvider: ctx.runtime.provider,
    workspaceRoot: ctx.services.workingDirectory,
    knownSessionIds: () => {
      try {
        return ctx.services.sessionManager.list().map((info) => info.name);
      } catch {
        // An unreadable store means "nothing known", which is the safe answer:
        // it can only cause a re-mirror, never a lost conversation.
        return [];
      }
    },
  }).catch(() => undefined);

  const router = createRemoteConversationRouter({
    verbs: ctx.services.daemonVerbs,
    // The SAME resolution the verb caller uses, so this surface never calls one
    // daemon and streams from another.
    resolveConnection: () => ctx.services.resolveConnectedHost(),
    conversation,
    requestRender: options.render,
    clientId,
    onCancellationNotice: (message) => { options.notify(message); options.render(); },
    onFrame: (frame: HostedSessionFrame) => {
      // Real counts only, and only once the daemon has sent any.
      if (frame.type === 'LLM_RESPONSE_RECEIVED') {
        const input = frame.payload?.['inputTokens'];
        const output = frame.payload?.['outputTokens'];
        activity.noteUsage(
          typeof input === 'number' ? input : 0,
          typeof output === 'number' ? output : 0,
        );
      }
      if (frame.type === 'TOOL_RECEIVED' || frame.type === 'TOOL_EXECUTING') {
        const tool = frame.payload?.['tool'];
        if (typeof tool === 'string') activity.noteTool(tool);
      } else if (frame.type === 'TOOL_SUCCEEDED' || frame.type === 'TOOL_FAILED') {
        activity.noteTool(null);
      }
      noteHostedTurn(frame);
      // Republish onto this process's own runtime bus, see
      // hosted-turn-bus-bridge.ts. Without this, a daemon-hosted turn never
      // fires TURN_SUBMITTED/STREAM_DELTA/TURN_COMPLETED locally, so anything
      // that only watches events.turns (spoken output today) stays silent for
      // it.
      bridgeHostedFrameOntoRuntimeBus(frame, {
        runtimeBus: ctx.runtimeBus,
        sessionId: ctx.runtime.sessionId,
        source: 'goodvibes-agent',
      });
      options.onFrame?.(frame);
    },
  });

  const unbindExecutionMode = bindActiveExecutionMode(ctx.services.configManager, {
    hostedSessionId: () => router.hostedSessionId(),
    hasHostedOwner: () => ctx.services.configManager.get('hostedSessions.routeConversationTurns') !== false
      && (nativePending !== undefined || nativeOwnerUnconfirmed || router.hostedSessionId() !== null),
    executionMode: () => router.executionMode(),
    refreshExecutionMode: () => router.refreshExecutionMode(),
    setExecutionMode: mode => (router.hostedSessionId() === null && (nativePending !== undefined || nativeOwnerUnconfirmed)
      ? Promise.reject(new Error(UNCONFIRMED_NATIVE_OWNER_MODE_REASON))
      : router.setExecutionMode(mode)),
  });

  const detachedHandle = (): RoutedTurnHandle => ({
    hostedSessionId: router.hostedSessionId(),
    completion: Promise.resolve({ status: 'abandoned', response: '',
      error: 'This surface stopped observing the submission; its remote outcome is unconfirmed.', stopReason: 'observer_detached' }),
  });

  /** Clear the unconfirmed-owner latch only on a result that proves no hosted turn of this input can still run. */
  const settleOwnerLatch = (state: NativeConversationIntakeState | undefined): void => {
    if (!state) return;
    const hosted = state.hostedTurn && !('kind' in state.hostedTurn) ? state.hostedTurn : undefined;
    if ((state.result && state.result.kind !== 'turn')
      || ((state.status === 'invalid' || state.status === 'unavailable') && !state.request)
      || hosted?.state === 'completed' || hosted?.state === 'cancelled') nativeOwnerUnconfirmed = false;
  };
  const report = (state: NativeConversationIntakeState | undefined): void => {
    settleOwnerLatch(state);
    for (const line of nativeConversationIntakeLines(state)) options.notify(line);
    options.render();
  };
  const observeNative = async (state: NativeConversationIntakeState, intake: NativeConversationIntakeActions): Promise<RoutedTurnHandle> => {
    const snapshot = state.hostedTurn;
    if (disposed || !state.hostedCurrent?.() || !snapshot || 'kind' in snapshot || !snapshot.sessionId
      || !snapshot.correlationId || !snapshot.brokerInputId || snapshot.state === 'preparing' || snapshot.state === 'recovery-required'
      || state.result?.kind !== 'turn' || !state.request) { activity.end(); return detachedHandle(); }
    const connection = ctx.services.resolveConnectedHost();
    if ('reason' in connection) { activity.end(); return detachedHandle(); }
    const current = () => !disposed && state.hostedCurrent?.() === true
      && sameNativeRemoteConnection(connection, ctx.services.resolveConnectedHost());
    const sequence = ++routeSequence;
    const request = { ...state.request };
    const key = `${request.requestId}:${request.inputId}`;
    // Render the original before opening catch-up. A complete fast reply can
    // arrive synchronously while the stream opens; it must follow its user.
    if (!nativeMirrored.has(key)) {
      nativeMirrored.add(key);
      conversation.addUserMessage(state.result.text);
    }
    activity.begin();
    if (disposed || sequence !== routeSequence || !current()) { if (sequence === routeSequence) activity.end(); return detachedHandle(); }
    const outcome = await router.observeNative(snapshot, async () => {
      if (!current()) throw new Error('Native selection changed');
      const result = await intake.cancel(request);
      if (!current() || !result || result.status === 'unknown' || result.status === 'unavailable'
        || !result.hostedTurn || 'kind' in result.hostedTurn) throw new Error('Native cancellation is unconfirmed');
      report(result);
    }, current);
    if (!outcome.routed) {
      nativeMirrored.delete(key);
      if (sequence === routeSequence) activity.end();
      options.notify(outcome.reason); options.render();
      return detachedHandle();
    }
    nativeOwnerUnconfirmed = false;
    const indicator = { sequence };
    observedIndicator = indicator;
    const finish = (completion?: HostedTurnCompletion): void => {
      // An abandoned observation may be recovered, and must not repeat the
      // user's message; any other ending is final for this input.
      if (completion?.status !== 'abandoned') nativeMirrored.delete(key);
      // The indicator ends with the turn even when the selection changed under
      // it; only the transcript mirror needs the selection to still hold.
      if (indicator.sequence === routeSequence) activity.end();
      if (observedIndicator === indicator) observedIndicator = undefined;
      if (current()) void mirrorHostedSession(outcome.hostedSessionId, current, connection);
    };
    void outcome.completion.then(finish, () => finish());
    return { hostedSessionId: outcome.hostedSessionId, completion: outcome.completion };
  };

  return {
    isHostedTurn: (turnId: string) => hostedTurnIds.has(turnId),
    observeNative,
    routeNativeOrExplain: async (source, intake, onNotSent) => {
      if (disposed) return detachedHandle();
      if (ctx.services.configManager.get('hostedSessions.routeConversationTurns') === false) return null;
      if (nativePending) {
        options.notify('A native input is already pending. No second submission was created; your text is back in the composer.');
        options.restoreDraft?.(source.text);
        onNotSent?.();
        return detachedHandle();
      }
      if (!intake) {
        options.notify('Native conversation intake is unavailable. No legacy turn was started; your text is back in the composer.');
        options.restoreDraft?.(source.text);
        onNotSent?.();
        return detachedHandle();
      }
      const sequence = ++routeSequence;
      const pending: PendingNativeAdmission = { intake, sequence };
      nativePending = pending;
      nativeOwnerUnconfirmed = true;
      try {
        // Own the operation before rendering: render callbacks may reenter
        // submission, Stop, or disposal synchronously.
        activity.begin();
        if (disposed || sequence !== routeSequence || nativePending !== pending) return detachedHandle();
        // Source is the complete text the user sent (pastes spliced in, model
        // directives removed); anything it cannot carry was refused in the
        // composer. The host alone captures a continuation's actual history.
        const state = await intake.submit(source, { delivery: 'hosted' });
        if (disposed || sequence !== routeSequence) return detachedHandle();
        if (state?.request) pending.request = { ...state.request };
        report(state);
        if (disposed || sequence !== routeSequence) return detachedHandle();
        if (state?.hostedTurn) return await observeNative(state, intake);
        // A refusal by the intake itself created no request, so the message was
        // not sent: give back the draft and what was taken for it. 'unknown'
        // may have been delivered and stays with the intake status.
        if (!state || state.status === 'pending' || state.status === 'unavailable' || state.status === 'invalid') {
          options.restoreDraft?.(source.text);
          onNotSent?.();
        }
        activity.end();
        return detachedHandle();
      } catch {
        if (!disposed && sequence === routeSequence) {
          activity.end(); options.notify('Native delivery is unconfirmed. Inspect /work intake-status. No legacy turn was started.'); options.render();
        }
        return detachedHandle();
      } finally { if (nativePending === pending) nativePending = undefined; }
    },
    // Never abort the local runtime merely because the hosted observer has
    // already reached its terminal.
    cancelHostedTurn: () => {
      const pending = nativePending;
      if (pending) {
        const { intake } = pending;
        const sequence = ++routeSequence;
        nativePending = undefined;
        const observed = observedIndicator;
        if (!pending.request && observed && intake.stop) {
          // The admission in flight has saved nothing yet; Stop is meant for the
          // turn already running. Stop the admission without closing the intake,
          // whose selection fence that turn's observation still relies on, then
          // cancel the running turn through its own observer.
          void intake.stop().catch(() => undefined);
          if (router.cancelTurn()) {
            observed.sequence = sequence;
            return true;
          }
        }
        const stoppedBeforeSave = !pending.request;
        const cancellation = pending.request ? intake.cancel(pending.request) : intake.stop ? intake.stop() : (intake.close(), Promise.resolve(undefined));
        void cancellation.then(async state => {
          if (disposed || sequence !== routeSequence) return;
          if (!state && stoppedBeforeSave) {
            activity.end();
            options.notify('[Stop] Admission of this input was stopped and no turn was started for it. /work intake-status shows whether it was saved.');
            options.render();
            return;
          }
          report(state);
          if (disposed || sequence !== routeSequence) return;
          if (state?.hostedTurn) await observeNative(state, intake);
          else activity.end();
        }, () => { if (!disposed) { activity.end(); options.notify('Native cancellation is unconfirmed. Inspect /work intake-status.'); options.render(); } });
        return true;
      }
      if (router.cancelTurn()) return true;
      // The indicator outlived any turn the router can still cancel (its
      // observation ended or was detached): Stop clears it instead of doing nothing.
      if (activity.isActive()) {
        activity.end();
        options.render();
        return true;
      }
      return false;
    },
    hostedToolPreview: () => activity.toolPreview(),
    detachHostedSession: () => router.detach(),
    resetHostedSession: () => router.reset(),
    observeIntake: (intake) => {
      const settle = (state: NativeConversationIntakeState | undefined): NativeConversationIntakeState | undefined => { settleOwnerLatch(state); return state; };
      return {
        submit: (source, submitOptions) => intake.submit(source, submitOptions),
        status: () => intake.status().then(settle),
        retry: () => intake.retry().then(settle),
        resume: () => intake.resume().then(settle),
        cancel: (expected) => intake.cancel(expected).then(settle),
        ...(intake.stop ? { stop: () => intake.stop!().then(settle) } : {}),
        close: () => intake.close(),
      };
    },
    dispose: () => {
      disposed = true;
      routeSequence += 1;
      nativePending?.intake.close(); nativePending = undefined;
      activity.dispose();
      unbindExecutionMode();
      router.dispose();
    },
  };
}

/** Stop belongs to the hosted owner while it is admitting or observing a turn. */
export function cancelConversationGeneration(
  local: { readonly isThinking: boolean; readonly isTurnInFlight?: boolean | undefined; abort(): void },
  remote: Pick<RemoteConversationWiring, 'cancelHostedTurn'>,
): void {
  if (remote.cancelHostedTurn()) return;
  // A local turn occupies the orchestrator from admission to finalization,
  // including the stretch before it starts thinking.
  if (local.isThinking || local.isTurnInFlight === true) local.abort();
}
