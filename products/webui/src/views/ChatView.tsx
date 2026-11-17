import { ChangeEvent, Dispatch, FormEvent, KeyboardEvent, SetStateAction, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, CalendarDays, LayoutGrid, Mail } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent } from '../lib/client-lifetime';
import { client as platformClient } from '../lib/goodvibes';
import { REASONING_EFFORT_SEVERITY } from '@goodvibes-jev/engine/platform/browser/reasoning-effort';
import { asRecord, bestId, bestTitle, firstString } from '../lib/object';
import { queryKeys } from '../lib/queries';
import { useProviderModelOptions } from '../lib/use-provider-model-options';
import { providerOptionsFromResponse, reasoningOptionsForModel, sortProvidersConfiguredFirst } from '../lib/provider-models';
import { shouldSteerComposerKey, shouldSubmitComposerKey } from '../lib/composer-keys';
import { isSessionNotFoundError, formatError } from '../lib/errors';
import {
  companionSessionFromDetail,
  companionMessagesFromListResponse,
  mergeCompanionMessages,
  LocalCompanionMessage,
} from '../lib/companion-chat';
import { ChatFindButton, ChatTitle, ChatTurnNotice } from './chat/ChatHeader';
import { CHAT_SUGGESTIONS, greeting, greetingName, type SuggestionIcon } from './chat/new-chat';
import { Spark } from '../components/shell/Spark';
import { Button } from '../components/ui/Button';
import { useHeaderSlots } from '../components/shell/HeaderSlots';
import { useHotkeys } from '../hooks/useHotkeys';
import { MessageList } from './chat/MessageList';
import { Composer } from './chat/Composer';
import { ChatSearch } from './chat/ChatSearch';
import { QueuedMessagesPanel } from './chat/QueuedMessagesPanel';
import { useChatSend } from './chat/useChatSend';
import { parseSlashCommand, SLASH_COMMANDS } from './chat/slash-commands';
import { useToast } from '../lib/toast';
import { useWakeTranscriptSink } from '../lib/voice/useWake';
import { useChatStream } from './chat/useChatStream';
import { createLiveReplyStore } from './chat/live-reply-store';
import { useStableCallback } from '../hooks/useStableCallback';
import '../styles/components/chat-view.css';
import {
  deriveChatTitle,
  isActiveTurnState,
  messageTone,
  messageText,
  messageAttachments,
  IDLE_TURN_PHASE,
  settledFromList,
  settledTurnLabel,
  streamHealthLabel,
  workingStatusLabel,
  type TurnPhase,
  type TurnState,
} from './chat/message-utils';
import { buildLineage } from './chat/lineage';
import { resolveScrollTarget, isScrollTargetReady, isScrollTargetStale, findMessageElement } from './chat/search-jump';
import type { ChatViewProps, ChatMessage } from './chat/types';

export type { ChatViewProps };

type SessionRoutePatch = Parameters<typeof platformClient.chat.sessions.update>[1];
type SessionEffort = NonNullable<SessionRoutePatch['reasoningEffort']>;
/** The canonical vocabulary also produces the actual companion chat wire enum. */
function isSessionEffort(value: string): value is SessionEffort {
  return REASONING_EFFORT_SEVERITY.includes(value);
}

/** How often the transcript is re-read while the live stream is paused. */
const PAUSED_REFRESH_MS = 5000;

const SUGGESTION_ICONS: Record<SuggestionIcon, typeof Mail> = {
  calendar: CalendarDays,
  mail: Mail,
  running: LayoutGrid,
  memory: BookOpen,
};

export function ChatView({
  activeSessionId,
  chatSelection,
  sessionItems,
  onActiveSessionChange,
  onDraftSessionRequestedChange,
  onLocalSessionCreated,
  onLocalSessionUpdated,
  onSessionMissing,
  userName,
}: ChatViewProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const headerSlots = useHeaderSlots();
  const findRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveTextRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Auto-title bookkeeping: sessions we have already client-side auto-titled (fire once),
  // and sessions the operator renamed by hand (never overwrite a manual title).
  const autoTitledSessionsRef = useRef<Set<string>>(new Set());
  const manuallyTitledSessionsRef = useRef<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  // The streamed reply lives in a store, not in this view's state: a token
  // re-renders only the live bubble. This view re-renders when it gains or loses text.
  const [liveReply] = useState(createLiveReplyStore);
  const setLiveText = liveReply.set;
  const hasLiveText = useSyncExternalStore(liveReply.subscribe, () => liveReply.get() !== '', () => false);
  // turnState and turnError are ONE value (see TurnPhase in message-utils.ts):
  // the reset on a session switch sets both in a single setTurn call, so a
  // terminal state can never survive it. setTurnState/setTurnError are adapters
  // for the hooks, which write one field at a time.
  const [turn, setTurn] = useState<TurnPhase>(IDLE_TURN_PHASE);
  // The session id a send just created (see the reset-on-switch effect below).
  const sendCreatedSessionRef = useRef<ReturnType<typeof chatSelection.capture> | null>(null);
  const selectedChat = chatSelection.capture();
  const handleSendSessionSwitch = useCallback((sessionId: string) => {
    onActiveSessionChange(sessionId);
    sendCreatedSessionRef.current = chatSelection.capture();
  }, [onActiveSessionChange, chatSelection]);
  const { state: turnState, error: turnError } = turn;
  const setTurnState = useCallback<Dispatch<SetStateAction<TurnState>>>((next) => {
    setTurn((current) => ({ ...current, state: typeof next === 'function' ? next(current.state) : next }));
  }, []);
  const setTurnError = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setTurn((current) => ({
      ...current,
      error: typeof next === 'function' ? (next as (prev: string) => string)(current.error) : next,
    }));
  }, []);
  const [localMessages, setLocalMessages] = useState<LocalCompanionMessage[]>([]);
  const [pendingUserMessageId, setPendingUserMessageId] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState('');
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  // Search jump-to-message: set when a MESSAGE-level search result is selected
  // (session-level results carry messageId '' and never set this, see
  // ChatSearch's module doc). Cleared once the target message is found and
  // scrolled to, the operator navigates to a different session first, or the
  // target's session loads without it among the active messages (see
  // isScrollTargetStale).
  const [pendingScrollTarget, setPendingScrollTarget] = useState<{ sessionId: string; messageId: string } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState('');
  const scrollTargetSessionShownRef = useRef(false);

  const providers = useQuery({ queryKey: queryKeys.providers, queryFn: () => platformClient.operator.providers.list() });
  const modelCatalog = useQuery({ queryKey: ['models'], queryFn: () => platformClient.operator.models.list() });
  const currentModel = useQuery({ queryKey: ['models', 'current'], queryFn: () => platformClient.operator.models.current.get() });
  const catalogProviderOptions = useMemo(() => providerOptionsFromResponse(modelCatalog.data), [modelCatalog.data]);

  const providerOptions = useMemo(() => {
    const byId = new Map<string, ReturnType<typeof providerOptionsFromResponse>[number]>();
    for (const provider of providerOptionsFromResponse(providers.data)) byId.set(provider.id, provider);
    for (const provider of catalogProviderOptions) {
      const existing = byId.get(provider.id);
      byId.set(provider.id, existing ? { ...existing, value: { ...asRecord(existing.value), ...asRecord(provider.value) } } : provider);
    }
    return sortProvidersConfiguredFirst([...byId.values()]);
  }, [catalogProviderOptions, providers.data]);
  const activeSession = useMemo(
    () => sessionItems.find((session) => bestId(session) === activeSessionId),
    [activeSessionId, sessionItems],
  );
  const sessionProvider = activeSessionId ? firstString(activeSession, ['provider']) : '';
  const sessionModel = activeSessionId ? firstString(activeSession, ['model']) : '';
  const currentModelRecord = asRecord(asRecord(currentModel.data).model);
  const currentModelData = Object.keys(currentModelRecord).length ? currentModelRecord : asRecord(currentModel.data);
  const defaultRegistryKey = firstString(currentModelData, ['registryKey'])
    || firstString(asRecord(asRecord(modelCatalog.data).currentModel), ['registryKey'])
    || '';
  const currentProviderId = sessionProvider || firstString(currentModelData, ['provider', 'providerId', 'runtimeProviderId'])
    || firstString(asRecord(asRecord(modelCatalog.data).currentModel), ['provider', 'providerId', 'runtimeProviderId'])
    || '';
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId)?.value ?? providerOptions[0]?.value;
  const catalogProviders = useMemo(() => catalogProviderOptions.map(provider => provider.value), [catalogProviderOptions]);
  const providerModels = useProviderModelOptions(selectedProvider, catalogProviders,
    providers.isSuccess && modelCatalog.isSuccess && !providers.isFetching && !modelCatalog.isFetching);
  const providerModelOptions = providerModels.models;
  // Existing chats retain their own route. A default-model change elsewhere
  // must not make this composer claim that its pinned session changed.
  const currentRegistryKey = sessionProvider && sessionModel
    ? (providerModelOptions.find(model => model.providerId === sessionProvider && model.rawModelId === sessionModel)
      ?? providerModelOptions.find(model => model.providerId === sessionProvider && model.registryKey === sessionModel))?.registryKey ?? ''
    : defaultRegistryKey;
  const selectedModelRegistryKey = providerModelOptions.some((model) => model.registryKey === currentRegistryKey) ? currentRegistryKey : '';
  // The effort ladder for the CURRENT model, from its own models.list entry.
  // Null on daemons predating the field, no control renders.
  const effortOptions = useMemo(
    () => reasoningOptionsForModel(catalogProviderOptions.map((provider) => provider.value), currentRegistryKey),
    [catalogProviderOptions, currentRegistryKey],
  );
  const requestedEffort = activeSessionId ? firstString(activeSession, ['reasoningEffort'])
    : firstString(currentModelData, ['effort']) || firstString(asRecord(currentModel.data), ['effort']) || '';

  // The native model projection uses the same resolver as the answering adapter.
  // Keep the preference while showing the effective wire level on the selected model.
  const currentEffort = activeSessionId
    ? effortOptions?.effectiveByRequested?.[requestedEffort]
      ?? (effortOptions?.levels.includes(requestedEffort) ? requestedEffort : '')
    : requestedEffort;

  const activeSessionTitle = activeSessionId ? bestTitle(activeSession, activeSessionId) : 'New chat';

  useEffect(() => {
    if (selectedProviderId) return;
    const preferredProviderId = currentProviderId || providerOptions[0]?.id || '';
    if (preferredProviderId) setSelectedProviderId(preferredProviderId);
  }, [currentProviderId, providerOptions, selectedProviderId]);

  useEffect(() => { if (currentProviderId) setSelectedProviderId(currentProviderId); }, [selectedChat, currentProviderId]);

  useEffect(
    () => setSessionTitleDraft(activeSessionTitle === activeSessionId ? '' : activeSessionTitle),
    [activeSessionId, activeSessionTitle],
  );

  const renameSession = useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) => platformClient.chat.sessions.update(sessionId, { title }),
    onSuccess: async (result, variables) => {
      onLocalSessionUpdated(variables.sessionId, companionSessionFromDetail(result) ?? { sessionId: variables.sessionId, title: variables.title });
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', variables.sessionId] });
    },
  });

  const routeSelectionCurrent = (selection: typeof selectedChat, lifetime: ReturnType<typeof getClientLifetime>) => {
    if (!chatSelection.isCurrent(selection) || !isClientLifetimeCurrent(lifetime)) throw new Error('The selected chat or connection changed. Choose the model again.');
  };
  const applySessionRoute = async (patch: SessionRoutePatch) => {
    const lifetime = getClientLifetime(); routeSelectionCurrent(selectedChat, lifetime);
    if (isActiveTurnState(turnState)) throw new Error('Wait for this chat’s current reply to finish before changing its model or effort.');
    const result = await platformClient.chat.sessions.update(activeSessionId, patch);
    routeSelectionCurrent(selectedChat, lifetime);
    const acknowledged = companionSessionFromDetail(result);
    if (bestId(acknowledged) !== activeSessionId
      || patch.provider !== undefined && firstString(acknowledged, ['provider']) !== patch.provider
      || patch.model !== undefined && firstString(acknowledged, ['model']) !== patch.model
      || patch.reasoningEffort !== undefined && asRecord(acknowledged).reasoningEffort !== patch.reasoningEffort) {
      throw new Error('The selected chat’s model or effort change could not be confirmed. Refresh this chat before retrying.');
    }
    onLocalSessionUpdated(activeSessionId, acknowledged);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] }),
      queryClient.invalidateQueries({ queryKey: ['companion-chat', activeSessionId] }),
    ]);
  };
  const selectModel = useMutation({
    mutationFn: async (registryKey: string) => {
      if (!providerModels.hasCurrentModel(registryKey)) throw new Error('Model options changed. Choose a current model.');
      const model = providerModelOptions.find(option => option.registryKey === registryKey);
      if (!model) throw new Error('The selected model is unavailable.');
      if (activeSessionId) return applySessionRoute({ provider: model.providerId, model: model.rawModelId });
      const lifetime = getClientLifetime(); routeSelectionCurrent(selectedChat, lifetime);
      const result = await platformClient.operator.models.current.set(registryKey);
      routeSelectionCurrent(selectedChat, lifetime); return result;
    },
    onError: () => setSelectedProviderId(currentProviderId),
    onSuccess: async () => {
      if (activeSessionId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'current'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
      ]);
    },
  });

  const selectEffort = useMutation({
    mutationFn: async (effort: string) => {
      if (sessionProvider === 'decision-router') throw new Error('Decision Router effort is configured by category.');
      if (activeSessionId) {
        if (effort !== '' && !isSessionEffort(effort)) throw new Error('This reasoning effort is not supported by chat sessions. Choose a supported level or the provider default.');
        return applySessionRoute({ reasoningEffort: effort === '' ? null : effort });
      }
      const lifetime = getClientLifetime(); routeSelectionCurrent(selectedChat, lifetime);
      const result = await platformClient.operator.models.current.set(currentRegistryKey, effort === '' ? null : effort);
      routeSelectionCurrent(selectedChat, lifetime); return result;
    },
    onSuccess: async () => { if (!activeSessionId) await queryClient.invalidateQueries({ queryKey: ['models', 'current'] }); },
  });

  const invalidateChatState = useCallback(async (sessionId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['companion-chat', sessionId, 'messages'] }),
      queryClient.invalidateQueries({ queryKey: ['companion-chat', sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] }),
    ]);
  }, [queryClient]);

  // Auth-expiry handoff shared by both chat hooks: re-probe auth.current so a
  // genuinely dead token (401 mid-stream or mid-send) flips the whole app to the
  // signed-out gate (App.tsx unmounts this view when auth.current confirms it),
  // rather than either hook retrying a dead token or collapsing to a dead-end error.
  const onChatAuthExpired = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.auth });
  }, [queryClient]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = '0px';
    composer.style.height = `${Math.min(Math.max(composer.scrollHeight, 26), 200)}px`;
  }, [draft]);

  useEffect(() => {
    setShowJumpToBottom(false);
  }, [activeSessionId]);

  // Reset the turn lifecycle to idle on every session switch, in ONE setTurn
  // call. Without this, a terminal turnState left over from a prior session's
  // failed or stopped turn (e.g. 'send failed') rendered in the
  // turn notice until the next send or turn event in the NEWLY active
  // session, even though that session never did anything.
  //
  // The one exempt transition: a first send with no active session creates the
  // session and switches to it mid-send. That switch must NOT wipe the send's
  // own in-flight 'sending'/'submitted' state, or the turn silently reads as
  // idle (no Stop affordance, no streaming bubble) while the daemon is working.
  // useChatSend reports the created id through sendCreatedSessionRef below; the
  // ref is consumed here so any LATER switch to the same session still resets.
  useEffect(() => {
    if (sendCreatedSessionRef.current === selectedChat) {
      if (activeSessionId === selectedChat.sessionId) sendCreatedSessionRef.current = null;
      return;
    }
    setTurn(IDLE_TURN_PHASE);
    setPendingUserMessageId('');
  }, [activeSessionId, selectedChat]);

  const {
    isStreaming, streamHealth, stop, retryStream, activeToolCalls, toolActivityByMessageId, cancelToolCall: cancelToolCallRaw,
  } = useChatStream({
    activeSessionId,
    liveTextRef,
    onSessionMissing,
    setTurnState,
    setTurnError,
    setLiveText,
    setLocalMessages,
    setPendingUserMessageId,
    invalidateChatState,
    onAuthExpired: onChatAuthExpired,
    turnState,
  });

  // The live stream owns the turn while it is connected: its terminal event sets
  // the state and refreshes this list once. The list is re-read on a timer only
  // while the stream is paused, which is when nothing else would bring news.
  const messages = useQuery({
    queryKey: ['companion-chat', activeSessionId, 'messages'],
    enabled: Boolean(activeSessionId),
    queryFn: () => platformClient.chat.messages.list(activeSessionId),
    retry: (failureCount, error) => !isSessionNotFoundError(error) && failureCount < 2,
    refetchInterval: streamHealth === 'paused' ? PAUSED_REFRESH_MS : false,
  });

  useEffect(() => {
    if (!activeSessionId || !messages.isError || !isSessionNotFoundError(messages.error)) return;
    onSessionMissing(activeSessionId);
  }, [activeSessionId, messages.error, messages.isError, onSessionMissing]);

  // Cancel ONE running tool call, the turn continues (unlike stop(), which ends the
  // whole turn). A refusal or transport failure surfaces through the same turnError
  // banner the rest of the composer already renders.
  const cancelToolCall = useCallback(
    async (callId: string) => {
      try {
        const result = await cancelToolCallRaw(callId);
        if (!result.cancelled) setTurnError('Could not cancel that tool call; it may have already finished.');
      } catch (error) {
        setTurnError(formatError(error));
      }
    },
    [cancelToolCallRaw, setTurnError],
  );

  // A send that was abandoned before the daemon accepted it (the chat or the
  // sign-in changed under it) gives its text and files back to the composer.
  const restoreAbandonedSend = useCallback(({ body, files }: { body: string; files: File[] }) => {
    setDraft((current) => (current.trim() ? current : body));
    if (files.length) setAttachedFiles((current) => (current.length ? current : files));
    toast({
      title: 'Message not sent',
      description: 'The chat or sign-in changed before it was sent. It is back in the composer.',
      tone: 'warning',
    });
  }, [toast]);

  const send = useChatSend({
    activeSessionId,
    chatSelection,
    onActiveSessionChange: handleSendSessionSwitch,
    onDraftSessionRequestedChange,
    onLocalSessionCreated,
    onSessionMissing,
    setTurnState,
    setTurnError,
    setLiveText,
    setLocalMessages,
    setPendingUserMessageId,
    invalidateChatState,
    onAuthExpired: onChatAuthExpired,
    onSendAbandoned: restoreAbandonedSend,
  });
  const { editAndResend, regenerateFrom: sendRegenerateFrom } = send;

  const messageItems = companionMessagesFromListResponse(messages.data);

  const renderedMessageItems = useMemo(() => {
    const merged = mergeCompanionMessages(messageItems, localMessages, activeSessionId) as ChatMessage[];
    // Fold in tool activity observed live by this browser tab (see useChatStream's
    // toolActivityByMessageId doc comment): attached by message id regardless of
    // whether the message came from local optimistic state or the server-fetched
    // history, both end up with the same id once the turn completes. A message
    // whose id has no entry (older history, or a full page reload) simply renders
    // without a fold, honestly, rather than fabricating one.
    if (toolActivityByMessageId.size === 0) return merged;
    return merged.map((message) => {
      const toolActivity = toolActivityByMessageId.get(bestId(message));
      return toolActivity ? { ...message, toolActivity } : message;
    });
  }, [activeSessionId, localMessages, messageItems, toolActivityByMessageId]);

  // The honest-lineage render model: active messages as nodes, with any superseded
  // (retained) history attached to the node that heads its fork. Derived purely from
  // the server-authoritative list, so it survives reloads and never drops history.
  const lineageNodes = useMemo(() => buildLineage(renderedMessageItems), [renderedMessageItems]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || showJumpToBottom) return;
    window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [activeSessionId, renderedMessageItems.length, showJumpToBottom]);

  // Follow the streamed reply as it grows (published at most once per frame).
  useEffect(() => {
    if (showJumpToBottom) return undefined;
    return liveReply.subscribe(() => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
  }, [liveReply, showJumpToBottom]);

  // Search jump-to-message: once the target session is active AND its messages
  // have loaded, locate the message in the DOM and scroll to it. Session switch
  // (onActiveSessionChange) and the messages fetch it triggers are both async,
  // the target message may not exist in lineageNodes/the DOM yet on the render
  // right after selecting a search result, so this effect just no-ops until a
  // later render (driven by lineageNodes changing as messages arrive) finds it.
  // The readiness/lookup rules live in search-jump.ts (framework-free, unit
  // tested there), this effect is just the async-retry wiring around them.
  useEffect(() => {
    if (!isScrollTargetReady(pendingScrollTarget, activeSessionId, lineageNodes) || !pendingScrollTarget) return;
    const target = pendingScrollTarget;
    const element = findMessageElement(scrollRef.current, target.messageId);
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightedMessageId(target.messageId);
    setPendingScrollTarget(null);
  }, [pendingScrollTarget, activeSessionId, lineageNodes]);

  const messagesSettled = messages.isSuccess && !messages.isFetching;
  useEffect(() => {
    if (!pendingScrollTarget) {
      scrollTargetSessionShownRef.current = false;
      return;
    }
    if (pendingScrollTarget.sessionId === activeSessionId) scrollTargetSessionShownRef.current = true;
    if (isScrollTargetStale(pendingScrollTarget, activeSessionId, scrollTargetSessionShownRef.current, messagesSettled, lineageNodes)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- drops a target that can never be reached
      setPendingScrollTarget(null);
    }
  }, [pendingScrollTarget, activeSessionId, lineageNodes, messagesSettled]);

  // Auto-clear the search jump-to-message highlight after a brief flash. A
  // separate effect (keyed only on highlightedMessageId) so a fresh highlight
  // starting mid-flash restarts its own timer rather than racing the one
  // above's cleanup.
  useEffect(() => {
    if (!highlightedMessageId) return;
    const target = highlightedMessageId;
    const timer = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === target ? '' : current));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId]);

  // A turn whose end the stream could not report (it was down, or is paused)
  // is settled by the list read after the turn reached its current state: a
  // reply after the message it answers. A list read earlier can still hold a
  // reply a regenerate is replacing, so it is not used.
  const listSettlesTurn = turnState === 'syncing'
    || (streamHealth !== 'live' && isActiveTurnState(turnState) && turnState !== 'sending');
  const listReadMarkRef = useRef<{ state: TurnState; readAt: number }>({ state: 'idle', readAt: 0 });
  const listReadAt = messages.dataUpdatedAt;
  useEffect(() => {
    if (listReadMarkRef.current.state !== turnState) {
      listReadMarkRef.current = { state: turnState, readAt: listReadAt };
      return;
    }
    if (!listSettlesTurn || listReadAt <= listReadMarkRef.current.readAt) return;
    const settled = settledFromList(renderedMessageItems, pendingUserMessageId);
    if (!settled) return;
    liveTextRef.current = '';
    setLiveText('');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- settles the turn from the list the stream could not report
    setPendingUserMessageId('');
    setTurnState(settled);
  }, [listSettlesTurn, listReadAt, pendingUserMessageId, renderedMessageItems, setTurnState, turnState]);

  // Client-side auto-title: once a fresh chat has its first user message AND a first
  // assistant reply, replace the crude create-time title (a raw slice of the first
  // message) with a cleaned title derived from that message, via the existing
  // companion.chat.sessions.update verb (there is no server auto-title verb, this is
  // the ruled client-side path). Fires at most once per session and never overwrites a
  // title the operator set by hand.
  useEffect(() => {
    if (!activeSessionId || isRenamingTitle) return;
    if (autoTitledSessionsRef.current.has(activeSessionId)) return;
    if (manuallyTitledSessionsRef.current.has(activeSessionId)) return;
    const firstUser = renderedMessageItems.find((message) => messageTone(message) === 'user');
    const hasAssistantReply = renderedMessageItems.some((message) => messageTone(message) === 'assistant');
    if (!firstUser || !hasAssistantReply) return;
    const firstUserText = messageText(firstUser);
    const derived = deriveChatTitle(firstUserText);
    if (!derived) return;
    const current = activeSessionTitle;
    const looksAutoGenerated = current === ''
      || current === activeSessionId
      || current === 'New Chat'
      || current === 'New chat'
      || current === firstUserText.slice(0, 72)
      || current === derived;
    // Mark handled regardless, so this never re-evaluates for the session.
    autoTitledSessionsRef.current.add(activeSessionId);
    if (!looksAutoGenerated || current === derived) return;
    renameSession.mutate({ sessionId: activeSessionId, title: derived });
  }, [activeSessionId, activeSessionTitle, isRenamingTitle, renderedMessageItems, renameSession]);

  // A confirmed wake's transcript lands in the SAME two places a dictated one does:
  // appended to the draft for review, or sent straight away when
  // voice.wake.autoSubmit says so. The handler is held in a ref and the sink itself is
  // stable, so registering it does not re-register on every keystroke, the wake host
  // outlives this view and must not be churned by it.
  const wakeHandlerRef = useRef<(text: string, autoSubmit: boolean) => void>(() => undefined);
  useEffect(() => {
    wakeHandlerRef.current = (text: string, autoSubmit: boolean) => {
      if (!text) return;
      // A send already in flight would drop the dictated text, so it goes to the
      // draft for review instead.
      if (autoSubmit && !send.isPending) {
        sendText(text);
        return;
      }
      setDraft(draft.trim() ? `${draft.trimEnd()} ${text}` : text);
      composerRef.current?.focus();
    };
  });
  useWakeTranscriptSink(useCallback((text: string, options: { autoSubmit: boolean }) => {
    wakeHandlerRef.current(text, options.autoSubmit);
  }, []));

  function submitDraft() {
    sendText(draft, attachedFiles);
  }

  /** STEER: send immediately, interrupting the in-flight turn (Ctrl/Cmd+Enter, or hold the send button). */
  function steerDraft() {
    sendText(draft, attachedFiles, { steer: true });
  }

  function sendText(text: string, files: File[] = [], options: { steer?: boolean; localMessageId?: string } = {}) {
    const body = text.trim();
    if (send.isPending || (!body && !files.length)) return;
    if (!files.length && parseSlashCommand(body) === 'new') {
      setDraft('');
      onActiveSessionChange('');
      onDraftSessionRequestedChange(true);
      composerRef.current?.focus();
      return;
    }
    const filesToSend = [...files];
    setDraft('');
    setAttachedFiles([]);
    composerRef.current?.focus();
    send.mutate({
      body,
      files: filesToSend,
      ...(options.steer ? { steer: true } : {}),
      ...(options.localMessageId ? { localMessageId: options.localMessageId } : {}),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    submitDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSteerComposerKey(event)) {
      event.preventDefault();
      steerDraft();
      return;
    }
    if (!shouldSubmitComposerKey(event)) return;
    event.preventDefault();
    submitDraft();
  }

  async function copyMessage(message: unknown) {
    const id = bestId(message);
    const text = messageText(message);
    if (!text) return;
    if (!navigator.clipboard) {
      toast({ title: 'Copy failed', description: 'Clipboard API unavailable', tone: 'danger', durationMs: 3000 });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast({ title: 'Copy failed', description: 'Could not write to clipboard', tone: 'danger', durationMs: 3000 });
      return;
    }
    setCopiedMessageId(id);
    window.setTimeout(() => setCopiedMessageId((current) => (current === id ? '' : current)), 1300);
  }

  function resendMessage(message: unknown) {
    const text = messageText(message);
    // Only a send that failed keeps its id, so the daemon can recognise a repeat of one it
    // already accepted; resending any other message is a new message.
    const failedId = bestId(message);
    const retryOptions = (message as { deliveryState?: unknown } | null)?.deliveryState === 'failed' && failedId.startsWith('local-')
      ? { localMessageId: failedId }
      : {};
    if (messageAttachments(message).length === 0) {
      sendText(text, [], retryOptions);
      return;
    }
    // A message with files is resent only with those files: sending the text alone
    // would read as a normal send while the attachments were dropped.
    if (send.isPending) return;
    const id = bestId(message);
    if (!send.hasHeldFiles(id)) {
      setTurnError('The files of that message are no longer available. Attach them again and send a new message.');
      return;
    }
    sendText(text, send.takeHeldFiles(id), retryOptions);
  }

  function addAttachedFiles(files: File[]) {
    if (files.length) setAttachedFiles((current) => [...current, ...files]);
  }

  function regenerateFrom(messageId: string) {
    sendRegenerateFrom(messageId, renderedMessageItems);
  }

  // Stable identities for the message handlers, so each memoised message
  // re-renders only when its own data changes.
  const onCopyMessage = useStableCallback((message: ChatMessage) => { void copyMessage(message); });
  const onResendMessage = useStableCallback(resendMessage);
  const onRegenerateFrom = useStableCallback(regenerateFrom);
  const onEditMessage = useStableCallback(editAndResend);

  function handleMessagesScroll() {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowJumpToBottom(distanceFromBottom > 180);
  }

  function scrollMessagesToBottom() {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    setShowJumpToBottom(false);
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    addAttachedFiles(files);
    event.target.value = '';
  }

  function removeAttachedFile(index: number) {
    setAttachedFiles((current) => current.filter((_file, fileIndex) => fileIndex !== index));
  }

  function finishRenamingTitle() {
    if (!isRenamingTitle) return;
    const nextTitle = sessionTitleDraft.trim();
    setIsRenamingTitle(false);
    if (!activeSessionId || !nextTitle || nextTitle === activeSessionTitle) return;
    // A hand-set title is authoritative, never auto-title over it afterwards.
    manuallyTitledSessionsRef.current.add(activeSessionId);
    renameSession.mutate({ sessionId: activeSessionId, title: nextTitle });
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setSessionTitleDraft(activeSessionTitle === activeSessionId ? '' : activeSessionTitle);
      setIsRenamingTitle(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      finishRenamingTitle();
    }
  }


  // Ctrl F opens the glass find bar (or refocuses its field when it is already
  // open). Scoped to the chat: it only exists while this view is mounted.
  useHotkeys([
    {
      combo: 'mod+f',
      allowInInput: true,
      handler: (event) => {
        event.preventDefault();
        if (showSearch) {
          findRef.current?.querySelector<HTMLInputElement>('input')?.focus();
          return;
        }
        setShowSearch(true);
      },
    },
  ]);

  // A new chat: no session yet and nothing sent. The greeting and the centered
  // composer show only here; the first send turns it into a conversation.
  const isNewChat = !activeSessionId && lineageNodes.length === 0 && !hasLiveText && !isStreaming && !send.isPending;
  const workingLabel = workingStatusLabel(
    turnState,
    activeToolCalls.filter((call) => !call.cancelled),
    hasLiveText,
    streamHealth,
  );
  // turnError already renders its exact words above the composer; the notice
  // adds plain words for a settled turn only when there is no error text, and
  // always says when the live stream is down.
  const noticeLabel = [turnError ? '' : settledTurnLabel(turnState), streamHealthLabel(streamHealth)]
    .filter(Boolean).join(' ');
  const name = greetingName(userName);

  function applySuggestion(prompt: string) {
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (!composer) return;
      composer.focus();
      composer.setSelectionRange(prompt.length, prompt.length);
    });
  }

  const greetingBlock = isNewChat ? (
    <div className="chat-welcome">
      <h2 className="chat-greeting">
        <Spark size={26} className="chat-greeting__spark" />
        <span>{greeting(new Date().getHours(), name)}</span>
      </h2>
    </div>
  ) : null;

  return (
    <section className="chat-main" data-state={isNewChat ? 'new' : 'conversation'}>
      {headerSlots?.titleSlot && createPortal(
        <ChatTitle
          activeSessionId={activeSessionId}
          title={activeSessionTitle}
          isRenaming={isRenamingTitle}
          draft={sessionTitleDraft}
          onStartRename={() => setIsRenamingTitle(true)}
          onDraftChange={setSessionTitleDraft}
          onFinishRename={finishRenamingTitle}
          onKeyDown={handleTitleKeyDown}
        />,
        headerSlots.titleSlot,
      )}
      {headerSlots?.actionsSlot && createPortal(
        <ChatFindButton open={showSearch} onToggle={() => setShowSearch((v) => !v)} />,
        headerSlots.actionsSlot,
      )}
      {showSearch && (
        <div className="chat-find glass" ref={findRef}>
          <ChatSearch
            onClose={() => setShowSearch(false)}
            onSelect={(payload) => {
              onActiveSessionChange(payload.sessionId);
              setShowSearch(false);
              setPendingScrollTarget(resolveScrollTarget(payload));
            }}
          />
        </div>
      )}
      <MessageList
        nodes={lineageNodes}
        lead={greetingBlock}
        liveReply={liveReply}
        hasLiveText={hasLiveText}
        showJumpToBottom={showJumpToBottom}
        isSendPending={send.isPending}
        isStreaming={isStreaming}
        copiedMessageId={copiedMessageId}
        highlightedMessageId={highlightedMessageId}
        scrollRef={scrollRef}
        hasHeldFiles={send.hasHeldFiles}
        onScroll={handleMessagesScroll}
        onJumpToBottom={scrollMessagesToBottom}
        onCopyMessage={onCopyMessage}
        onResendMessage={onResendMessage}
        onRegenerateFrom={onRegenerateFrom}
        onEditMessage={onEditMessage}
        onStop={stop}
        activeToolCalls={activeToolCalls}
        onCancelToolCall={(callId) => void cancelToolCall(callId)}
        workingLabel={workingLabel}
      />
      <div className="chat-dock">
        {activeSessionId && (
          <QueuedMessagesPanel
            sessionId={activeSessionId}
            active={isStreaming}
            onMoveToComposer={(text) => setDraft((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text))}
          />
        )}
        <ChatTurnNotice label={noticeLabel} onRetryStream={streamHealth === 'paused' ? retryStream : undefined} />
        <Composer
          layout={isNewChat ? 'centered' : 'docked'}
          placeholder={isNewChat ? 'Ask GoodVibes anything' : 'Reply to GoodVibes'}
          draft={draft}
          attachedFiles={attachedFiles}
          isSendPending={send.isPending}
          onSteer={steerDraft}
          sendError={send.error}
          turnError={turnError}
          renameSessionError={renameSession.error}
          selectModelError={selectModel.error ?? selectEffort.error}
          providerOptions={providerOptions}
          selectedProviderId={selectedProviderId}
          providerModelOptions={providerModelOptions}
          selectedModelRegistryKey={selectedModelRegistryKey}
          selectModelPending={selectModel.isPending}
          modelChangesDisabled={isStreaming || send.isPending}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          slashCommands={SLASH_COMMANDS}
          onDraftChange={setDraft}
          onComposerKeyDown={handleComposerKeyDown}
          onSubmit={submit}
          onFileSelection={handleFileSelection}
          onFilesAdded={addAttachedFiles}
          onRemoveAttachedFile={removeAttachedFile}
          onProviderChange={setSelectedProviderId}
          onModelChange={(registryKey) => selectModel.mutate(registryKey)}
          effortLevels={effortOptions?.levels ?? []}
          currentEffort={currentEffort}
          requestedEffort={requestedEffort}
          effortPending={selectEffort.isPending}
          onEffortChange={(effort) => selectEffort.mutate(effort)}
        />
        {isNewChat && (
          <div className="chat-suggestions" role="group" aria-label="Start with">
            {CHAT_SUGGESTIONS.map((suggestion) => {
              const Icon = SUGGESTION_ICONS[suggestion.icon];
              return (
                <Button
                  key={suggestion.id}
                  variant="secondary"
                  size="sm"
                  className="chat-suggestion"
                  icon={<Icon size={16} aria-hidden="true" />}
                  onClick={() => applySuggestion(suggestion.prompt)}
                >
                  <span className="chat-suggestion__label">{suggestion.label}</span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
