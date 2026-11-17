import { Dispatch, SetStateAction, useCallback, useEffect, useRef } from 'react';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../../lib/client-lifetime';
import type { ChatSelection, ChatSelectionTracker } from '../../lib/chat-selection';
import { useMutation } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { bestId } from '../../lib/object';
import {
  companionSessionFromDetail,
  extractMessageId,
  extractSessionId,
  LocalCompanionMessage,
} from '../../lib/companion-chat';
import {
  isSessionNotFoundError,
  isSessionClosedError,
  isAuthExpiredError,
  formatError,
  isMethodUnavailableError,
} from '../../lib/errors';
import { fileToBase64, uploadedArtifactId, type TurnState } from './message-utils';
import type { ChatMessage } from './types';

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------

interface UseChatSendOptions {
  activeSessionId: string;
  chatSelection: ChatSelectionTracker;
  onActiveSessionChange: (sessionId: string) => void;
  onDraftSessionRequestedChange: (requested: boolean) => void;
  onLocalSessionCreated: (session: unknown) => void;
  onSessionMissing: (sessionId: string) => void;
  setTurnState: Dispatch<SetStateAction<TurnState>>;
  setTurnError: Dispatch<SetStateAction<string>>;
  setLiveText: Dispatch<SetStateAction<string>>;
  setLocalMessages: Dispatch<SetStateAction<LocalCompanionMessage[]>>;
  setPendingUserMessageId: Dispatch<SetStateAction<string>>;
  invalidateChatState: (sessionId: string) => Promise<void>;
  /**
   * A send was abandoned before the daemon accepted it (the chat selection or
   * the sign-in changed, or the view went away): its text and files, so the
   * caller can put them back in the composer. Not called once the daemon has
   * the message; that send succeeded and the server list shows it.
   */
  onSendAbandoned?: (input: { body: string; files: File[] }) => void;
  /**
   * Same auth-expiry handoff useChatStream uses: on a 401 mid-send, re-probe
   * auth.current so a genuinely dead token flips the app to the signed-out gate,
   * rather than collapsing to a generic 'send failed'.
   */
  onAuthExpired: () => void;
}

/**
 * `localMessageId` is set when Resend retries a message that failed: the retry reuses
 * that message's id, which is also the id the daemon dedupes on, so a send the daemon
 * had already accepted (only its response was lost) is not run a second time.
 */
type SendInput = { body: string; files: File[]; steer?: boolean; localMessageId?: string };
type SendMutation = Pick<ReturnType<typeof useMutation<undefined, Error, SendInput>>, 'mutate' | 'mutateAsync' | 'reset' | 'isPending' | 'error'>;
interface SelectionLease {
  selection: ChatSelection;
  sessionId: string;
  readonly owner: ChatSelectionTracker;
  readonly client: ClientLifetime;
}
interface OwnedSendInput extends SendInput { readonly lease: SelectionLease; readonly controller: AbortController }

/** A send given up before the daemon had the message; nothing was posted. */
export class SendAbandonedError extends Error {
  constructor() {
    super('The message was not sent: the chat or sign-in changed before it was sent.');
    this.name = 'SendAbandonedError';
  }
}

/** Settle with `promise`, or reject as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export interface UseChatSendReturn {
  /**
   * Forward the core mutation properties at the top level so existing call
   * sites (`send.mutate`, `send.isPending`, `send.error`) continue to work
   * without modification.
   */
  mutate: SendMutation['mutate'];
  isPending: boolean;
  error: Error | null;
  /** The send controls, with pending/error state for this selection only. */
  sendMutation: SendMutation;
  /**
   * Edit a user message and branch the conversation from it, the honest-lineage
   * edit verb (companion.chat.messages.edit). The original message and everything
   * after it are SUPERSEDED on the server (retained as viewable history, never
   * deleted) and a fresh turn answers the edited message. Falls back to a plain
   * resend only when the target has no server id yet (an un-persisted optimistic
   * message cannot be branched, a new send is the honest action there).
   */
  editAndResend: (messageId: string, newText: string) => void;
  /**
   * Regenerate an assistant response, the honest-lineage regenerate verb
   * (companion.chat.messages.retry). The prior response (and any turns after it)
   * is SUPERSEDED on the server (retained as viewable history, never deleted) and
   * a fresh turn re-runs from the preceding user message.
   */
  regenerateFrom: (messageId: string, messages: ChatMessage[]) => void;
  /** True while a regenerate or edit-and-branch request is in flight. */
  isLineagePending: boolean;
  /** The last regenerate/edit error, if any. */
  lineageError: Error | null;
  /** True when the files of a failed send are still held, so Resend can send them again. */
  hasHeldFiles: (messageId: string) => boolean;
  /** Hand over (and stop holding) the files of a failed send, or [] when none are held. */
  takeHeldFiles: (messageId: string) => File[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when an id is a real server message id rather than a client-synthesized
 * optimistic id. The regenerate/edit verbs act on persisted messages; a local id
 * (`local-…` user echo, `assistant-…` streamed placeholder) has no server row to
 * branch from, so the caller either omits it (regenerate → "latest") or falls back
 * to a plain send (edit).
 */
function isServerMessageId(id: string): boolean {
  if (!id) return false;
  return !id.startsWith('local-') && !id.startsWith('assistant-') && !id.startsWith('user-');
}

const CLOSED_CHAT_MESSAGE = 'This chat is closed and could not be reopened; start a new chat to keep going.';

/**
 * Run a chat verb; when the daemon answers that the chat is closed, reopen it
 * (companion.chat.sessions.reopen) and run the verb once more. Writing in a
 * closed chat is the person asking to continue it. A daemon that cannot reopen
 * leaves the original closed-chat error in place.
 */
async function withReopen<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isSessionClosedError(error)) throw error;
    try {
      await platformClient.chat.sessions.reopen(sessionId);
    } catch {
      throw error;
    }
    return await run();
  }
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useChatSend({
  activeSessionId,
  chatSelection,
  onActiveSessionChange,
  onDraftSessionRequestedChange,
  onLocalSessionCreated,
  onSessionMissing,
  setTurnState,
  setTurnError,
  setLiveText,
  setLocalMessages,
  setPendingUserMessageId,
  invalidateChatState,
  onAuthExpired,
  onSendAbandoned,
}: UseChatSendOptions): UseChatSendReturn {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // The File objects of sends that failed, by local message id. The failed bubble
  // keeps its attachment chips, and Resend needs the bytes again; they are dropped
  // once the message is sent or resent.
  const heldFilesRef = useRef<Map<string, File[]>>(new Map());
  const holdFiles = (messageId: string, files: File[]) => {
    if (files.length) heldFilesRef.current.set(messageId, files);
  };
  const hasHeldFiles = useCallback((messageId: string) => heldFilesRef.current.has(messageId), []);
  const takeHeldFiles = useCallback((messageId: string) => {
    const files = heldFilesRef.current.get(messageId) ?? [];
    heldFilesRef.current.delete(messageId);
    return files;
  }, []);
  // A returned handler belongs to this render, even if navigation leaves and
  // returns to the same session before the handler is invoked.
  const renderedSelection = chatSelection.capture();
  const renderedClient = getClientLifetime();
  const captureLease = (): SelectionLease => ({
    selection: renderedSelection, sessionId: activeSessionId,
    owner: chatSelection, client: renderedClient,
  });
  const isCurrent = (lease: SelectionLease): boolean => mounted.current
    && lease.owner === chatSelection && lease.owner.isCurrent(lease.selection)
    && lease.selection.sessionId === lease.sessionId && isClientLifetimeCurrent(lease.client);

  // The send in flight, aborted the moment its chat selection or sign-in stops
  // being current, or the view unmounts. One controller per send; every await
  // before the daemon accepts the message ends with it.
  const inFlightRef = useRef<{ lease: SelectionLease; controller: AbortController } | null>(null);
  const abandonIfStale = () => {
    const inFlight = inFlightRef.current;
    if (inFlight && !inFlight.controller.signal.aborted && !isCurrent(inFlight.lease)) {
      inFlight.controller.abort(new SendAbandonedError());
    }
  };
  useEffect(abandonIfStale);
  useEffect(() => {
    const unsubscribe = subscribeClientLifetime(() => abandonIfStale());
    return () => {
      unsubscribe();
      inFlightRef.current?.controller.abort(new SendAbandonedError());
    };
    // abandonIfStale reads refs only; one subscription per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Core send mutation (unchanged API, still used by Composer)
  // -------------------------------------------------------------------------
  const ownedSendMutation = useMutation<undefined, Error, OwnedSendInput>({
    mutationFn: async ({ body, files, steer, localMessageId: retriedMessageId, lease, controller }) => {
      if (!body && !files.length) throw new Error('There is nothing to send: write a message or attach a file.');
      const { signal } = controller;
      inFlightRef.current = { lease, controller };
      // Checked after every await before the message is posted: the effect above
      // aborts on the next render, this catches a change within the same tick.
      const ensureCurrent = () => {
        if (!signal.aborted && !isCurrent(lease)) controller.abort(new SendAbandonedError());
        signal.throwIfAborted();
      };
      ensureCurrent();
      setTurnState('sending');
      setTurnError('');

      let sessionId = lease.sessionId;
      if (!sessionId) {
        const createdAt = Date.now();
        const title = body.slice(0, 72) || files[0]?.name?.slice(0, 72) || 'Attachment chat';
        const created = await untilAborted(platformClient.chat.sessions.create({ title }, signal), signal);
        ensureCurrent();
        sessionId = extractSessionId(created);
        const createdSession = companionSessionFromDetail(created);
        onLocalSessionCreated(bestId(createdSession) ? createdSession : {
          id: sessionId,
          sessionId,
          kind: 'companion-chat',
          title: title || sessionId,
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        });
        const previous = lease.selection;
        onActiveSessionChange(sessionId);
        const selected = chatSelection.capture();
        // Only this send's own switch to the chat it created keeps the send going.
        if (selected.revision !== previous.revision + 1 || selected.sessionId !== sessionId
          || selected.view !== 'chat') {
          controller.abort(new SendAbandonedError());
        }
        signal.throwIfAborted();
        lease.selection = selected;
        lease.sessionId = sessionId;
        ensureCurrent();
        onDraftSessionRequestedChange(false);
      }

      const localMessageId = retriedMessageId ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const localAttachments = files.map((file, index) => ({
        artifactId: `local-${localMessageId}-${index}`,
        label: file.name,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      }));
      const localMessage = {
        id: localMessageId,
        sessionId,
        role: 'user' as const,
        content: body,
        createdAt: Date.now(),
        deliveryState: 'local' as const,
        attachments: localAttachments,
      };
      // A resend takes the place of the failed bubble it retries instead of adding a second one.
      setLocalMessages((current) => (current.some((message) => message.id === localMessageId)
        ? current.map((message) => (message.id === localMessageId ? localMessage : message))
        : [...current, localMessage]));
      setPendingUserMessageId(localMessageId);
      setLiveText('');
      setTurnState('submitted');
      const markFailed = () => {
        holdFiles(localMessageId, files);
        setLocalMessages((current) => current.map((message) => (
          message.id === localMessageId ? { ...message, deliveryState: 'failed' as const } : message
        )));
      };
      const dropLocal = () => setLocalMessages((current) => current.filter((message) => message.id !== localMessageId));

      let attachments: typeof localAttachments;
      try {
        attachments = await Promise.all(files.map(async (file) => {
          const dataBase64 = await untilAborted(fileToBase64(file), signal);
          const uploaded = await untilAborted(platformClient.artifacts.create({
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64,
            metadata: { surface: 'webui' },
          }), signal);
          const artifactId = uploadedArtifactId(uploaded);
          if (!artifactId) throw new Error(`Artifact upload for ${file.name} did not return an artifact id.`);
          return {
            artifactId,
            label: file.name,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
          };
        }));
        ensureCurrent();
      } catch (error) {
        if (signal.aborted) dropLocal();
        else markFailed();
        throw error;
      }

      // From here the message is posted: the request is not abandoned part way,
      // its answer decides. The id makes a repeat of it safe.
      let result: unknown;
      try {
        const payload = {
          body,
          attachments: attachments.map(({ artifactId, label }) => ({ artifactId, label })),
          // The daemon answers a repeat of this id with the first message, so a resend after a
          // lost response does not start a second turn.
          clientMessageId: localMessageId,
        };
        if (steer) {
          // STEER: interrupt the in-flight turn and run this message now
          // (companion.chat.messages.steer). On a pre-1.4 daemon the verb
          // doesn't exist, fall back to an ordinary send and SAY so, never
          // silently pretend the interruption happened.
          try {
            result = await withReopen(sessionId, () => platformClient.chat.messages.steer(sessionId, payload));
          } catch (steerError) {
            if (!isMethodUnavailableError(steerError)) throw steerError;
            result = await withReopen(sessionId, () => platformClient.chat.messages.create(sessionId, payload));
            if (isCurrent(lease)) {
              setTurnError(
                'Sent as a normal message: this daemon does not support steering '
                + '(update the connected daemon), so the current reply was not interrupted.',
              );
            }
          }
        } else {
          result = await withReopen(sessionId, () => platformClient.chat.messages.create(sessionId, payload));
        }
      } catch (error) {
        markFailed();
        throw error;
      } finally {
        if (inFlightRef.current?.controller === controller) inFlightRef.current = null;
      }
      // Accepted. When the chat changed meanwhile, its own list shows the message.
      if (!isCurrent(lease)) return;
      const messageId = extractMessageId(result);
      setLocalMessages((current) => current.map((message) => (
        message.id === localMessageId
          ? {
            ...message,
            id: messageId || localMessageId,
            deliveryState: 'sent' as const,
            attachments,
          }
          : message
      )));
      setPendingUserMessageId(messageId || localMessageId);
      await invalidateChatState(sessionId);
    },
    onError: (error, { lease, body, files, controller }) => {
      if (inFlightRef.current?.controller === controller) inFlightRef.current = null;
      if (error instanceof SendAbandonedError) {
        if (mounted.current) onSendAbandoned?.({ body, files });
        // Still on the same chat (only the sign-in changed): say what happened.
        if (mounted.current && lease.owner.isCurrent(lease.selection)) {
          setTurnState('send failed');
          setTurnError(error.message);
        }
        return;
      }
      if (!isCurrent(lease)) return;
      if (isSessionNotFoundError(error) && lease.sessionId) {
        onSessionMissing(lease.sessionId);
        setTurnError('That chat session no longer exists. Starting from the current daemon session list.');
        return;
      }
      // A 401 mid-send means the token died between opening the composer and
      // hitting send, hand off to the sign-in front door instead of a dead-end
      // generic "send failed" that gives no path forward. The message that failed
      // is already marked deliveryState:'failed' above (inside the try/catch around
      // the actual POST), so this only needs to set the honest turn-level state.
      if (isAuthExpiredError(error)) {
        onAuthExpired();
        setTurnState('session expired');
        setTurnError('Your session expired: sign in again to continue.');
        return;
      }
      if (isSessionClosedError(error)) {
        setTurnState('idle');
        setTurnError(CLOSED_CHAT_MESSAGE);
        return;
      }
      setTurnState('send failed');
      setTurnError(formatError(error));
    },
  });

  const callbackOptions = (
    input: SendInput,
    lease: SelectionLease,
    options: Parameters<SendMutation['mutate']>[1],
  ): Parameters<typeof ownedSendMutation.mutate>[1] => {
    if (!options) return undefined;
    const callbacks: NonNullable<Parameters<typeof ownedSendMutation.mutate>[1]> = {};
    if (options.onSuccess) callbacks.onSuccess = (data, _variables, result, context) => {
      if (isCurrent(lease)) options.onSuccess?.(data, input, result, context);
    };
    if (options.onError) callbacks.onError = (error, _variables, result, context) => {
      if (isCurrent(lease)) options.onError?.(error, input, result, context);
    };
    if (options.onSettled) callbacks.onSettled = (data, error, _variables, result, context) => {
      if (isCurrent(lease)) options.onSettled?.(data, error, input, result, context);
    };
    return callbacks;
  };
  const sendCurrent = ownedSendMutation.variables !== undefined && isCurrent(ownedSendMutation.variables.lease);
  // A handler from an older render cannot send into a chat the view has left:
  // the send is refused as abandoned and its text goes back to the composer.
  const sendMutation: SendMutation = {
    mutate(input, options) {
      const lease = captureLease();
      if (!isCurrent(lease)) {
        if (mounted.current) onSendAbandoned?.({ body: input.body, files: input.files });
        return;
      }
      ownedSendMutation.mutate({ ...input, lease, controller: new AbortController() }, callbackOptions(input, lease, options));
    },
    mutateAsync(input, options) {
      const lease = captureLease();
      if (!isCurrent(lease)) {
        if (mounted.current) onSendAbandoned?.({ body: input.body, files: input.files });
        return Promise.reject(new SendAbandonedError());
      }
      return ownedSendMutation.mutateAsync({ ...input, lease, controller: new AbortController() }, callbackOptions(input, lease, options));
    },
    reset() {
      if (isCurrent(captureLease())) ownedSendMutation.reset();
    },
    isPending: sendCurrent && ownedSendMutation.isPending,
    error: sendCurrent ? ownedSendMutation.error : null,
  };

  // -------------------------------------------------------------------------
  // Shared honest handling for the two lineage-forking verbs (regenerate/edit):
  // set the turn in flight, hand server truth the wheel (drop this session's local
  // optimistic echoes so the refetched list, carrying the supersededAt flags, is
  // the single source), and map failures to honest states.
  // -------------------------------------------------------------------------
  const beginLineageTurn = useCallback(() => {
    // Drop this session's optimistic locals: after a fork the authoritative list
    // (with retained/superseded history) is the truth, and the new turn streams back
    // over SSE. The cached server list keeps rendering, so this does not blank the view.
    setLocalMessages((current) => current.filter((message) => message.sessionId !== activeSessionId));
    setLiveText('');
    setPendingUserMessageId('');
    setTurnError('');
    setTurnState('submitted');
  }, [activeSessionId, setLocalMessages, setLiveText, setPendingUserMessageId, setTurnError, setTurnState]);

  const handleLineageError = (error: unknown, lease: SelectionLease) => {
    if (!isCurrent(lease)) return;
    if (isSessionNotFoundError(error) && lease.sessionId) {
      onSessionMissing(lease.sessionId);
      setTurnState('idle');
      setTurnError('That chat session no longer exists. Starting from the current daemon session list.');
      return;
    }
    if (isAuthExpiredError(error)) {
      onAuthExpired();
      setTurnState('session expired');
      setTurnError('Your session expired: sign in again to continue.');
      return;
    }
    if (isSessionClosedError(error)) {
      setTurnState('idle');
      setTurnError(CLOSED_CHAT_MESSAGE);
      return;
    }
    setTurnState('error');
    setTurnError(formatError(error));
  };

  // regenerate (companion.chat.messages.retry)
  const regenerateMutation = useMutation<CompanionRegenerateVars, Error, CompanionRegenerateVars>({
    mutationFn: async (vars) => {
      if (!isCurrent(vars.lease)) return vars;
      beginLineageTurn();
      await withReopen(vars.sessionId, () => platformClient.chat.messages.retry(
        vars.sessionId,
        vars.messageId ? { messageId: vars.messageId } : undefined,
      ));
      if (isCurrent(vars.lease)) await invalidateChatState(vars.sessionId);
      return vars;
    },
    onError: (error, vars) => handleLineageError(error, vars.lease),
  });

  // edit-and-branch (companion.chat.messages.edit)
  const editMutation = useMutation<CompanionEditVars, Error, CompanionEditVars>({
    mutationFn: async (vars) => {
      if (!isCurrent(vars.lease)) return vars;
      beginLineageTurn();
      await withReopen(vars.sessionId, () => platformClient.chat.messages.edit(vars.sessionId, vars.messageId, { content: vars.content }));
      if (isCurrent(vars.lease)) await invalidateChatState(vars.sessionId);
      return vars;
    },
    onError: (error, vars) => handleLineageError(error, vars.lease),
  });

  // -------------------------------------------------------------------------
  // editAndResend: edit a user message and branch (honest server lineage)
  // -------------------------------------------------------------------------
  const editAndResend = useCallback(
    (messageId: string, newText: string) => {
      const content = newText.trim();
      if (!content || !activeSessionId) return;
      const lease = captureLease();
      if (!isCurrent(lease)) return;
      if (isServerMessageId(messageId)) {
        editMutation.mutate({ sessionId: activeSessionId, messageId, content, lease });
        return;
      }
      // No server id yet (an un-persisted optimistic message), a branch has nothing
      // to fork from, so send the edited text as a fresh message instead of faking a
      // branch. Honest: it is a new turn, not a rewrite of history that never persisted.
      sendMutation.mutate({ body: content, files: [] });
    },
    [activeSessionId, editMutation, sendMutation, captureLease],
  );

  // -------------------------------------------------------------------------
  // regenerateFrom: re-run an assistant response (honest server lineage)
  // -------------------------------------------------------------------------
  const regenerateFrom = useCallback(
    (messageId: string, _messages: ChatMessage[]) => {
      if (!activeSessionId) return;
      const lease = captureLease();
      if (!isCurrent(lease)) return;
      // Target a specific assistant message only when it has a server id; otherwise
      // omit it and let the daemon regenerate the latest assistant response, the
      // honest default when the clicked message is still a streamed optimistic echo.
      regenerateMutation.mutate({
        sessionId: activeSessionId,
        lease,
        messageId: isServerMessageId(messageId) ? messageId : undefined,
      });
    },
    [activeSessionId, regenerateMutation, captureLease],
  );

  return {
    // Flattened mutation surface, preserves existing call sites in ChatView
    mutate: sendMutation.mutate,
    isPending: sendMutation.isPending,
    error: sendMutation.error,
    // Send controls for callers that await the actual request outcome
    sendMutation,
    // Honest-lineage handlers (server verbs)
    editAndResend,
    regenerateFrom,
    isLineagePending: (regenerateMutation.variables !== undefined && isCurrent(regenerateMutation.variables.lease) && regenerateMutation.isPending)
      || (editMutation.variables !== undefined && isCurrent(editMutation.variables.lease) && editMutation.isPending),
    hasHeldFiles,
    takeHeldFiles,
    lineageError: (regenerateMutation.variables !== undefined && isCurrent(regenerateMutation.variables.lease) ? regenerateMutation.error : null)
      ?? (editMutation.variables !== undefined && isCurrent(editMutation.variables.lease) ? editMutation.error : null),
  };
}

interface CompanionRegenerateVars {
  sessionId: string;
  lease: SelectionLease;
  messageId?: string;
}

interface CompanionEditVars {
  sessionId: string;
  lease: SelectionLease;
  messageId: string;
  content: string;
}
