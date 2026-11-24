import { ChangeEvent, Dispatch, FormEvent, KeyboardEvent, SetStateAction, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, CalendarDays, Files, LayoutGrid, Mail } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent } from '../lib/client-lifetime';
import { client as platformClient } from '../lib/goodvibes';
import { copyOutcomeMessage, copyText } from '../lib/copy-text';
import { REASONING_EFFORT_SEVERITY } from '@goodvibes/engine/platform/browser/reasoning-effort';
import { asRecord, bestId, bestTitle, firstString } from '../lib/object';
import { queryKeys } from '../lib/queries';
import { modelOptionsSourceOf, useProviderModelOptions } from '../lib/use-provider-model-options';
import { modelOptionsForProvider, providerOptionsFromResponse, reasoningOptionsForModel, sortProvidersConfiguredFirst } from '../lib/provider-models';
import { modelRefreshSentence, pickerProviderOf } from '../lib/model-picker-data';
import { filesThatFit, TOO_MANY_FILES } from './chat/composer-attachments';
import { deriveProviderStatus } from '../lib/provider-status';
import { shouldSteerComposerKey, shouldSubmitComposerKey } from '../lib/composer-keys';
import { isSessionNotFoundError, formatError } from '../lib/errors';
import {
  companionSessionFromDetail,
  companionMessagesFromListResponse,
  mergeCompanionMessages,
  LocalCompanionMessage,
} from '../lib/companion-chat';
import { ChatFindButton, ChatTitle, ChatTurnNotice } from './chat/ChatHeader';
import { availableSuggestions, greeting, greetingName, type SuggestionIcon } from './chat/new-chat';
import { Spark } from '../components/shell/Spark';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { sessionFiles, useSessionFilesPanel } from './chat/ArtifactsPanel';
import { useHeaderSlots } from '../components/shell/HeaderSlots';
import { formatShortcut, isApplePlatform } from '../lib/shortcut-keys';
import { clearFindMatches, markFindMatches } from './chat/find-highlight';
import { MessageList } from './chat/MessageList';
import { Composer } from './chat/Composer';
import { ChatSearch } from './chat/ChatSearch';
import { QueuedMessagesPanel } from './chat/QueuedMessagesPanel';
import { ChatAsksChip, ElsewhereAsksBanner, InlineAsks } from './chat/InlineAsk';
import { useChatSend, type NewChatRoute } from './chat/useChatSend';
import { isSlashAttempt, parseSlashCommand, slashCommandsOf } from './chat/slash-commands';
import { loadCommandCatalog, useCommandCatalog } from '../lib/command-catalog';
import { openPaletteWith, runCommand } from '../lib/commands';
import { motionReduced } from '../lib/ui-preferences';
import { holdReload } from '../lib/reload-guard';
import { draftFilesInMemory, NEW_CHAT_DRAFT, readDraftText, restoreDraftFiles, writeDraftFiles, writeDraftText } from '../lib/chat-drafts';
import { useToast } from '../lib/toast';
import { useWakeTranscriptSink } from '../lib/voice/useWake';
import { useChatStream } from './chat/useChatStream';
import { createLiveReplyStore } from './chat/live-reply-store';
import { useStableCallback } from '../hooks/useStableCallback';
import { openOverlayCount } from '../components/ui/overlay';
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
  deliveryState,
  toolActivityFromHistory,
  workingStatusLabel,
  type TurnPhase,
  type TurnState,
} from './chat/message-utils';
import { buildLineage } from './chat/lineage';
import { resolveScrollTarget, isScrollTargetReady, isScrollTargetStale } from './chat/search-jump';
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

/** The starter probes: stale at once, so showing the new-chat screen again or focusing the window reads them again. */
const STARTER_PROBE_FRESHNESS = { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true } as const;

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
  onOpenSettings,
  onOpenAsk,
  onReviewAsks,
  renameRequest,
  onRenameRequestHandled,
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
  // The unsent draft belongs to its chat (lib/chat-drafts.ts): kept across a view change and a
  // reload, never shown in another chat. `draftOwner` is the chat the draft in state belongs to;
  // when the open chat changes, that chat's own draft is read in before anything is drawn or kept.
  const draftKey = activeSessionId || NEW_CHAT_DRAFT;
  const [draftOwner, setDraftOwner] = useState(draftKey);
  const [draft, setDraft] = useState(() => readDraftText(draftKey));
  // A /command the composer does not run, held instead of sent (cleared when the draft changes).
  const [heldCommand, setHeldCommand] = useState<{ word: string; known: boolean; steer: boolean } | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<File[]>(() => draftFilesInMemory(draftKey));
  // Said under the attached files when more were added than a message takes.
  const [attachNote, setAttachNote] = useState<string>();
  if (draftOwner !== draftKey) {
    setDraftOwner(draftKey);
    setDraft(readDraftText(draftKey));
    setAttachedFiles(draftFilesInMemory(draftKey));
    setAttachNote(undefined);
    setHeldCommand(null);
  }
  useEffect(() => { writeDraftText(draftOwner, draft); }, [draftOwner, draft]);
  useEffect(() => { writeDraftFiles(draftOwner, attachedFiles); }, [draftOwner, attachedFiles]);
  // Files attached before a reload come back from the browser's store, unless files were attached since.
  useEffect(() => {
    let current = true;
    void restoreDraftFiles(draftOwner).then((files) => {
      if (current && files.length > 0) setAttachedFiles((now) => (now.length === 0 ? files : now));
    });
    return () => { current = false; };
  }, [draftOwner]);
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
  // A new chat's own model and effort, picked in its composer before the first send.
  // The chat is created with them; the saved default for new chats stays as it is.
  // Held for the chat selection it was picked in, so another new chat starts from the default.
  const [newChatPick, setNewChatPick] = useState<{
    selection: ReturnType<typeof chatSelection.capture>;
    route: NewChatRoute & { registryKey?: string };
  } | null>(null);
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
  // What the chat's search last looked for, so the message it jumps to marks the matching words.
  const findQueryRef = useRef('');
  const scrollTargetSessionShownRef = useRef(false);
  // A failed reply's "Use another model": the reply to try again once a model is chosen in the menu.
  const retryAfterModelRef = useRef('');

  const providers = useQuery({ queryKey: queryKeys.providers, queryFn: () => platformClient.operator.providers.list() });
  const modelCatalog = useQuery({ queryKey: ['models'], queryFn: () => platformClient.operator.models.list() });
  const currentModel = useQuery({ queryKey: ['models', 'current'], queryFn: () => platformClient.operator.models.current.get() });
  const catalogProviderOptions = useMemo(() => providerOptionsFromResponse(modelCatalog.data), [modelCatalog.data]);

  const allProviderOptions = useMemo(() => {
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
  const chatSessionIds = useMemo(() => new Set(sessionItems.map((session) => bestId(session)).filter(Boolean)), [sessionItems]);
  const sessionProvider = activeSessionId ? firstString(activeSession, ['provider']) : '';
  const sessionModel = activeSessionId ? firstString(activeSession, ['model']) : '';
  const currentModelRecord = asRecord(asRecord(currentModel.data).model);
  const currentModelData = Object.keys(currentModelRecord).length ? currentModelRecord : asRecord(currentModel.data);
  const defaultRegistryKey = firstString(currentModelData, ['registryKey'])
    || firstString(asRecord(asRecord(modelCatalog.data).currentModel), ['registryKey'])
    || '';
  const newChatRoute = newChatPick && newChatPick.selection === selectedChat ? newChatPick.route : null;
  const draftRoute = activeSessionId ? null : newChatRoute;
  const currentProviderId = sessionProvider || (draftRoute?.provider ?? '')
    || firstString(currentModelData, ['provider', 'providerId', 'runtimeProviderId'])
    || firstString(asRecord(asRecord(modelCatalog.data).currentModel), ['provider', 'providerId', 'runtimeProviderId'])
    || '';
  // The model menu offers the providers that are set up, and the one this chat (or the
  // default model) uses even when it no longer is; a provider with no key and no
  // answering server has no model to pick.
  const providerOptions = useMemo(
    () => allProviderOptions.filter((provider) => deriveProviderStatus(provider.value).configured || provider.id === currentProviderId),
    [allProviderOptions, currentProviderId],
  );
  const currentProviderValue = allProviderOptions.find((provider) => provider.id === currentProviderId)?.value ?? providerOptions[0]?.value;
  const catalogProviders = useMemo(() => catalogProviderOptions.map(provider => provider.value), [catalogProviderOptions]);
  const modelListsSource = modelOptionsSourceOf(providers, modelCatalog);
  const providerModels = useProviderModelOptions(currentProviderValue, catalogProviders, modelListsSource);
  const providerModelOptions = providerModels.models;
  // Every provider's models, for the model menu (provider, then model, then effort).
  const modelsByProvider = useMemo(
    () => new Map(allProviderOptions.map((provider) => [provider.id, modelOptionsForProvider(provider.value, catalogProviders)] as const)),
    [allProviderOptions, catalogProviders],
  );
  // Why a provider's list was not read, from the last Refresh models answer: the model list carries it only
  // for a provider that has a list, so a provider never read (no models yet) gets it from here, on its row.
  const [refreshErrors, setRefreshErrors] = useState<Readonly<Record<string, string>>>({});
  const pickerProviders = useMemo(
    () => allProviderOptions.map((provider) => {
      const picked = pickerProviderOf(provider, modelsByProvider.get(provider.id) ?? []);
      const fromRefresh = refreshErrors[provider.id];
      return picked.listError || !fromRefresh ? picked : { ...picked, listError: fromRefresh };
    }),
    [allProviderOptions, modelsByProvider, refreshErrors],
  );
  const favoriteModels = useMemo(() => {
    const record = asRecord(modelCatalog.data);
    const keys = (value: unknown) => Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
    return { pinned: keys(record.pinned), recent: keys(record.recent) };
  }, [modelCatalog.data]);
  // Existing chats retain their own route. A default-model change elsewhere
  // must not make this composer claim that its pinned session changed.
  const currentRegistryKey = sessionProvider && sessionModel
    ? (providerModelOptions.find(model => model.providerId === sessionProvider && model.rawModelId === sessionModel)
      ?? providerModelOptions.find(model => model.providerId === sessionProvider && model.registryKey === sessionModel))?.registryKey ?? ''
    : draftRoute?.registryKey || defaultRegistryKey;
  // The effort ladder for the CURRENT model, from its own models.list entry.
  // Null on daemons predating the field, no control renders.
  const effortOptions = useMemo(
    () => reasoningOptionsForModel(catalogProviderOptions.map((provider) => provider.value), currentRegistryKey),
    [catalogProviderOptions, currentRegistryKey],
  );
  const requestedEffort = activeSessionId ? firstString(activeSession, ['reasoningEffort'])
    : draftRoute && draftRoute.reasoningEffort !== undefined ? draftRoute.reasoningEffort ?? ''
    : firstString(currentModelData, ['effort']) || firstString(asRecord(currentModel.data), ['effort']) || '';

  // The native model projection uses the same resolver as the answering adapter.
  // Keep the preference while showing the effective wire level on the selected model.
  const currentEffort = activeSessionId
    ? effortOptions?.effectiveByRequested?.[requestedEffort]
      ?? (effortOptions?.levels.includes(requestedEffort) ? requestedEffort : '')
    : requestedEffort;

  const activeSessionTitle = activeSessionId ? bestTitle(activeSession, activeSessionId) : 'New chat';

  useEffect(
    () => setSessionTitleDraft(activeSessionTitle === activeSessionId ? '' : activeSessionTitle),
    [activeSessionId, activeSessionTitle],
  );

  // The sidebar's "Rename": once that chat is the one open, its title opens for editing.
  useEffect(() => {
    if (!renameRequest || renameRequest !== activeSessionId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a request from the sidebar, handled once
    setIsRenamingTitle(true);
    onRenameRequestHandled?.();
  }, [renameRequest, activeSessionId, onRenameRequestHandled]);

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
  // One pick from the model menu: the model and its effort (null: the provider default), in one change.
  const selectRoute = useMutation({
    mutationFn: async ({ registryKey, effort }: { registryKey: string; effort: string | null }) => {
      if (modelListsSource.kind !== 'ready' || modelListsSource.refreshing) throw new Error('Model options changed. Choose a current model.');
      const model = [...modelsByProvider.values()].flat().find(option => option.registryKey === registryKey);
      if (!model) throw new Error('The selected model is unavailable.');
      if (effort !== null && model.providerId === 'decision-router') throw new Error('Decision Router effort is configured by category.');
      if (effort !== null && !isSessionEffort(effort)) throw new Error('This reasoning effort is not supported by chat sessions. Choose a supported level or the provider default.');
      if (activeSessionId) return applySessionRoute({ provider: model.providerId, model: model.rawModelId, reasoningEffort: effort });
      // A new chat: the pick is this chat's, sent when the chat is created by its first message.
      routeSelectionCurrent(selectedChat, getClientLifetime());
      setNewChatPick({ selection: selectedChat, route: { provider: model.providerId, model: model.rawModelId, registryKey, reasoningEffort: effort } });
      return undefined;
    },
    onError: () => { retryAfterModelRef.current = ''; },
    onSuccess: () => {
      const retry = retryAfterModelRef.current;
      retryAfterModelRef.current = '';
      if (retry) regenerateFrom(retry);
    },
  });

  // "Make this the default for new chats": this chat's model and effort become the saved default.
  const defaultEffort = firstString(currentModelData, ['effort']) || firstString(asRecord(currentModel.data), ['effort']) || '';
  const isDefaultRoute = currentRegistryKey !== '' && currentRegistryKey === defaultRegistryKey && requestedEffort === defaultEffort;
  const makeDefault = useMutation({
    mutationFn: () => platformClient.operator.models.current.set(currentRegistryKey, requestedEffort === '' ? null : requestedEffort),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models', 'current'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
      ]);
    },
  });

  const refreshModelLists = async (providerId?: string): Promise<string> => {
    const answer = await platformClient.operator.models.refresh(providerId);
    setRefreshErrors((known) => {
      const next: Record<string, string> = { ...known };
      for (const report of answer.providers as readonly { providerId?: unknown; error?: unknown; notAsked?: unknown }[]) {
        if (typeof report.providerId !== 'string' || report.notAsked === true) continue;
        if (typeof report.error === 'string' && report.error) next[report.providerId] = report.error;
        else delete next[report.providerId];
      }
      return next;
    });
    await queryClient.invalidateQueries({ queryKey: ['models'] });
    return modelRefreshSentence(answer.providers);
  };

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

  // A send that was abandoned or refused before the daemon had it (the chat or
  // the sign-in changed under it, or a new chat could not be created) gives its
  // text and files back to the composer. Something typed since is kept: the
  // returned text goes after it, and its files join the attached ones.
  const putBackInComposer = useCallback(({ body, files }: { body: string; files: File[] }) => {
    if (body) setDraft((current) => (current.trim() && current.trim() !== body ? `${current.trimEnd()}\n\n${body}` : body));
    if (files.length) setAttachedFiles((current) => [...current, ...files.filter((file) => !current.includes(file))]);
  }, []);
  const restoreAbandonedSend = useCallback((input: { body: string; files: File[] }) => {
    putBackInComposer(input);
    toast({
      title: 'Message not sent',
      description: 'The chat or sign-in changed before it was sent. It is back in the composer.',
      tone: 'warning',
    });
  }, [putBackInComposer, toast]);
  const restoreRefusedSend = useCallback((input: { body: string; files: File[]; reason: string }) => {
    putBackInComposer(input);
    toast({
      title: 'Message not sent',
      description: `The chat could not be created (${input.reason}). It is back in the composer.`,
      tone: 'warning',
    });
  }, [putBackInComposer, toast]);

  const send = useChatSend({
    activeSessionId,
    newChatRoute: draftRoute ? {
      ...(draftRoute.provider && draftRoute.model ? { provider: draftRoute.provider, model: draftRoute.model } : {}),
      ...(draftRoute.reasoningEffort !== undefined ? { reasoningEffort: draftRoute.reasoningEffort } : {}),
    } : null,
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
    onSendRefused: restoreRefusedSend,
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
    // A reply this tab did not watch (an older one, or any after a reload) is folded
    // from the turn history the daemon saved with it.
    return merged.map((message) => {
      const toolActivity = toolActivityByMessageId.get(bestId(message))
        ?? (messageTone(message) === 'assistant' ? toolActivityFromHistory(message) : []);
      return toolActivity.length > 0 ? { ...message, toolActivity } : message;
    });
  }, [activeSessionId, localMessages, messageItems, toolActivityByMessageId]);

  // The honest-lineage render model: active messages as nodes, with any superseded
  // (retained) history attached to the node that heads its fork. Derived purely from
  // the server-authoritative list, so it survives reloads and never drops history.
  const lineageNodes = useMemo(() => buildLineage(renderedMessageItems), [renderedMessageItems]);
  // Every file attached to or made in this chat, newest first, for the header's Files list.
  const chatFiles = useMemo(() => sessionFiles(renderedMessageItems), [renderedMessageItems]);
  const { openSessionFiles } = useSessionFilesPanel();
  // Jump-to-message: the transcript mounts the message if it is far from the screen, scrolls to it,
  // then says so (onJumped), and the message flashes.
  const [jumpRequest, setJumpRequest] = useState<{ messageId: string; seq: number } | null>(null);
  const jumpToMessage = useCallback((messageId: string) => {
    setJumpRequest((current) => ({ messageId, seq: (current?.seq ?? 0) + 1 }));
  }, []);
  const onJumped = useCallback((messageId: string) => setHighlightedMessageId(messageId), []);
  // A message still waiting behind the running reply is shown once, in the queue
  // above the composer where it can be edited or dropped; it joins the transcript,
  // after the reply it waited for, when it is sent.
  const transcriptNodes = useMemo(
    () => lineageNodes.filter((node) => !(messageTone(node.message) === 'user' && deliveryState(node.message) === 'queued')),
    [lineageNodes],
  );

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
  // have loaded, the transcript is asked to jump to it (it mounts the message
  // first when it is far from the screen). Session switch (onActiveSessionChange)
  // and the messages fetch it triggers are both async, the target message may not
  // be in lineageNodes yet on the render right after selecting a search result,
  // so this effect just no-ops until a later render (driven by lineageNodes
  // changing as messages arrive) finds it. The readiness rules live in
  // search-jump.ts; this effect is the async wiring around them.
  useEffect(() => {
    if (!isScrollTargetReady(pendingScrollTarget, activeSessionId, lineageNodes) || !pendingScrollTarget) return;
    const target = pendingScrollTarget;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hands a loaded target to the transcript's jump
    setPendingScrollTarget(null);
    jumpToMessage(target.messageId);
  }, [pendingScrollTarget, activeSessionId, lineageNodes, jumpToMessage]);

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

  // The marked words of the last search go when a new search opens or another chat is shown.
  useEffect(() => { if (showSearch) clearFindMatches(); }, [showSearch]);
  useEffect(() => () => clearFindMatches(), [activeSessionId]);

  // Auto-clear the search jump-to-message highlight after a brief flash. A
  // separate effect (keyed only on highlightedMessageId) so a fresh highlight
  // starting mid-flash restarts its own timer rather than racing the one
  // above's cleanup.
  useEffect(() => {
    if (!highlightedMessageId) return;
    const target = highlightedMessageId;
    // The searched words in the message jumped to stay marked after its flash, until the next search.
    const query = findQueryRef.current;
    findQueryRef.current = '';
    if (query) {
      window.requestAnimationFrame(() => {
        markFindMatches(scrollRef.current?.querySelector('.message--search-highlight'), query);
      });
    }
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
    // Decide only once the chat's own record (and so its real title) is here: before
    // the list answers, the title reads as the bare id, which looks auto-generated and
    // would replace a title the chat was created with by its first message.
    if (!activeSession) return;
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
  }, [activeSession, activeSessionId, activeSessionTitle, isRenamingTitle, renderedMessageItems, renameSession]);

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
      // draft for review instead. Sent on its own: whatever is typed or attached
      // in the composer is not part of it and stays there.
      if (autoSubmit && !send.isPending) {
        send.mutate({ body: text.trim(), files: [] });
        return;
      }
      setDraft(draft.trim() ? `${draft.trimEnd()} ${text}` : text);
      composerRef.current?.focus();
    };
  });
  useWakeTranscriptSink(useCallback((text: string, options: { autoSubmit: boolean }) => {
    wakeHandlerRef.current(text, options.autoSubmit);
  }, []));

  // The composer's slash commands: `/new` until the command catalog is loaded, which a `/` typed asks for.
  const commandsCatalog = useCommandCatalog(draft.trimStart().startsWith('/'));
  const slashCommands = useMemo(() => slashCommandsOf(commandsCatalog?.actions ?? null), [commandsCatalog]);
  const [slashSendWaiting, setSlashSendWaiting] = useState<{ text: string; files: File[]; options: { steer?: boolean; localMessageId?: string; asText?: boolean } } | null>(null);
  const [slashCatalogFailed, setSlashCatalogFailed] = useState(false);
  useEffect(() => {
    if (!slashSendWaiting || (!commandsCatalog && !slashCatalogFailed)) return;
    const waiting = slashSendWaiting;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the send that waited for the commands goes now
    setSlashSendWaiting(null);
    setSlashCatalogFailed(false);
    sendTextNow(waiting.text, waiting.files, waiting.options);
    // sendTextNow is this render's; the send runs once, when the commands arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashSendWaiting, commandsCatalog, slashCatalogFailed]);

  function submitDraft() {
    retryAfterModelRef.current = '';
    sendText(draft, attachedFiles);
  }

  /** STEER: send immediately, interrupting the in-flight turn (Ctrl/Cmd+Enter, or hold the send button). */
  function steerDraft() {
    sendText(draft, attachedFiles, { steer: true });
  }

  function sendText(text: string, files: File[] = [], options: { steer?: boolean; localMessageId?: string; asText?: boolean } = {}) {
    const body = text.trim();
    if (send.isPending || (!body && !files.length)) return;
    // A slash command is read against the loaded commands: before they are here, it is read once they
    // are (and the palette has registered them), from the effect below; a failed load reads it against `/new`.
    if (!options.asText && !commandsCatalog && isSlashAttempt(body)) {
      setSlashSendWaiting({ text, files, options });
      void loadCommandCatalog().catch(() => setSlashCatalogFailed(true));
      return;
    }
    sendTextNow(text, files, options);
  }

  function sendTextNow(text: string, files: File[], options: { steer?: boolean; localMessageId?: string; asText?: boolean }) {
    const body = text.trim();
    if (send.isPending || (!body && !files.length)) return;
    const slash = options.asText ? { kind: 'text' as const } : parseSlashCommand(body, slashCommands);
    if (slash.kind === 'command' && !files.length) {
      const run = slash.command.run;
      // A palette entry that is not registered (no palette mounted) is held like any command this composer cannot run.
      const ran = run.kind === 'new-chat' ? true : run.kind === 'palette-command' ? runCommand(run.id) : openPaletteWith(run.query);
      if (!ran) {
        setHeldCommand({ word: `/${slash.command.name}`, known: false, steer: options.steer === true });
        return;
      }
      setDraft('');
      setHeldCommand(null);
      if (run.kind === 'new-chat') {
        onActiveSessionChange('');
        onDraftSessionRequestedChange(true);
        composerRef.current?.focus();
      }
      return;
    }
    // A /command this composer does not run is not sent to the model: the text
    // stays in place and the composer says what to do instead.
    if (slash.kind === 'unknown') {
      setHeldCommand({ word: slash.word, known: slash.known, steer: options.steer === true });
      composerRef.current?.focus();
      return;
    }
    setHeldCommand(null);
    const filesToSend = [...files];
    setDraft('');
    setAttachedFiles([]);
    setAttachNote(undefined);
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
    // The message's own text on the page, selected when the browser lets nothing be copied.
    const shown = [...document.querySelectorAll('[data-message-id]')].find((node) => node.getAttribute('data-message-id') === id)?.querySelector('.message-bubble') ?? null;
    const outcome = await copyText(text, shown);
    const notice = copyOutcomeMessage(outcome);
    if (notice) {
      toast({ title: outcome === 'selected' ? 'Selected' : 'Copy failed', description: notice, tone: outcome === 'selected' ? 'info' : 'danger', durationMs: 6000 });
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
    const retryId = (message as { deliveryState?: unknown } | null)?.deliveryState === 'failed' && failedId.startsWith('local-')
      ? failedId
      : undefined;
    if (send.isPending) return;
    const hasFiles = messageAttachments(message).length > 0;
    // A message with files is resent only with those files: sending the text alone
    // would read as a normal send while the attachments were dropped. Files already
    // uploaded on the failed attempt are not needed again.
    if (hasFiles && !send.hasHeldFiles(failedId)) {
      setTurnError('The files of that message are no longer available. Attach them again and send a new message.');
      return;
    }
    // Resent under its own id (with its steer flag and uploads, which the send keeps), and
    // without touching what is being typed in the composer.
    if (retryId) {
      send.mutate({ body: text.trim(), files: hasFiles ? send.takeHeldFiles(failedId) : [], localMessageId: retryId });
      return;
    }
    // A message already in the chat is sent again as it was, a leading /word included.
    sendText(text, hasFiles ? send.takeHeldFiles(failedId) : [], { asText: true });
  }

  function addAttachedFiles(files: File[]) {
    if (!files.length) return;
    // The daemon's limit, said when the files are added, never first at send.
    const { taken, refused } = filesThatFit(attachedFiles.length, files);
    setAttachNote(refused ? TOO_MANY_FILES : undefined);
    if (taken.length) setAttachedFiles((current) => [...current, ...taken]);
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
  // Opens the composer's model menu; choosing a model there tries the failed reply again with it.
  const onUseAnotherModel = useStableCallback((messageId: string) => {
    retryAfterModelRef.current = messageId;
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.chat-dock .composer-model-btn')?.click());
  });

  function handleMessagesScroll() {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowJumpToBottom(distanceFromBottom > 180);
  }

  function scrollMessagesToBottom() {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: motionReduced() ? 'auto' : 'smooth' });
    setShowJumpToBottom(false);
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    addAttachedFiles(files);
    event.target.value = '';
  }

  function removeAttachedFile(index: number) {
    setAttachedFiles((current) => current.filter((_file, fileIndex) => fileIndex !== index));
    setAttachNote(undefined);
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


  // Ctrl+F (Cmd+F on a Mac) in a chat long enough that some messages are not mounted
  // (their plain-text rows, `.chat-row--text`) opens the chat's own search, which reaches
  // every message and marks the match; pressed again while its field has the focus, the
  // browser's own find opens. In a chat that is mounted whole, the key is the browser's.
  // Scoped to the chat: it only exists while this view is mounted.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const mod = isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f' || event.defaultPrevented) return;
      // A dialog or menu on top (settings has its own Ctrl+F) keeps the key.
      if (openOverlayCount() > 0 || document.querySelector('[data-gv-layer]')) return;
      const field = findRef.current?.querySelector<HTMLInputElement>('input');
      if (field && document.activeElement === field) return;
      if (scrollRef.current?.querySelector('.chat-row--text') == null) return;
      event.preventDefault();
      if (field) field.focus();
      else setShowSearch(true);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // A new chat: no session yet and nothing sent. The greeting and the centered
  // composer show only here; the first send turns it into a conversation.
  const isNewChat = !activeSessionId && lineageNodes.length === 0 && !hasLiveText && !isStreaming && !send.isPending;
  // An update reload waits while a reply streams or a message is being sent (lib/reload-guard).
  const replyInFlight = isStreaming || send.isPending || isActiveTurnState(turnState);
  useEffect(() => (replyInFlight ? holdReload() : undefined), [replyInFlight]);
  // Escape stops the reply while one streams (the Stop button shows the key). A key something
  // else used first (a menu, the find bar, an edit being cancelled) or one pressed with an
  // overlay open is left to that.
  useEffect(() => {
    if (!isStreaming) return undefined;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (openOverlayCount() > 0 || document.querySelector('[data-gv-layer]')) return;
      event.preventDefault();
      stop();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isStreaming, stop]);
  // The calendar and mail starters show only when that account answers a one-item
  // read (the same reads Settings shows the account status from, sharing their cache).
  // Read each time the new-chat screen is shown and when the window regains focus while it
  // is, so an account connected a minute ago shows its starter; nothing is read in a conversation.
  const calendarProbe = useQuery({
    queryKey: queryKeys.calendarProbe,
    queryFn: () => platformClient.operator.calendar.events.list({ limit: 1 }),
    enabled: isNewChat,
    retry: false,
    ...STARTER_PROBE_FRESHNESS,
  });
  const mailProbe = useQuery({
    queryKey: queryKeys.emailInbox(1, false, ''),
    queryFn: () => platformClient.operator.email.inbox.list({ limit: 1 }),
    enabled: isNewChat,
    retry: false,
    ...STARTER_PROBE_FRESHNESS,
  });
  const suggestions = availableSuggestions({ calendar: calendarProbe.isSuccess, mail: mailProbe.isSuccess });
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
        <>
          {activeSessionId && <ChatAsksChip sessionId={activeSessionId} onOpenSettings={onOpenSettings} />}
          {activeSessionId && chatFiles.length > 0 && (
            <IconButton
              label={`Files in this chat (${String(chatFiles.length)})`}
              icon={<Files />}
              className="chat-files-toggle"
              onClick={() => openSessionFiles(chatFiles, jumpToMessage)}
            />
          )}
          <ChatFindButton open={showSearch} onToggle={() => setShowSearch((v) => !v)} />
        </>,
        headerSlots.actionsSlot,
      )}
      {showSearch && (
        <div className="chat-find glass" ref={findRef}>
          <ChatSearch
            hint={`${formatShortcut('mod+f')} again: the browser's own find`}
            onClose={() => setShowSearch(false)}
            onSelect={(payload) => {
              findQueryRef.current = payload.messageId ? payload.query ?? '' : '';
              onActiveSessionChange(payload.sessionId);
              setShowSearch(false);
              setPendingScrollTarget(resolveScrollTarget(payload));
            }}
          />
        </div>
      )}
      <ElsewhereAsksBanner
        sessionId={activeSessionId}
        chatSessionIds={chatSessionIds}
        onOpenChat={onActiveSessionChange}
        onOpenAsk={onOpenAsk}
        onReviewAll={onReviewAsks}
      />
      <MessageList
        // One transcript per chat: another chat starts its own window at its end.
        key={activeSessionId || NEW_CHAT_DRAFT}
        jumpRequest={jumpRequest}
        onJumped={onJumped}
        nodes={transcriptNodes}
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
        trailing={activeSessionId ? <InlineAsks key={activeSessionId} sessionId={activeSessionId} /> : undefined}
        onUseAnotherModel={onUseAnotherModel}
      />
      <div className="chat-dock">
        {activeSessionId && (
          <QueuedMessagesPanel
            key={activeSessionId}
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
          replyRunning={isStreaming || isActiveTurnState(turnState)}
          heldCommand={heldCommand}
          onSendHeldAsText={() => {
            const steer = heldCommand?.steer === true;
            setHeldCommand(null);
            sendText(draft, attachedFiles, { asText: true, ...(steer ? { steer: true } : {}) });
          }}
          sendError={send.error}
          turnError={turnError}
          renameSessionError={renameSession.error}
          selectModelError={selectRoute.error ?? makeDefault.error}
          modelPicker={{
            providers: pickerProviders,
            pinned: favoriteModels.pinned,
            recent: favoriteModels.recent,
            current: { registryKey: currentRegistryKey, effort: currentEffort, requestedEffort },
            isDefault: isDefaultRoute,
            pending: selectRoute.isPending,
            // With no model set up it still opens: its "Not connected" rows are where connecting starts.
            disabled: isStreaming || send.isPending,
            onPick: (registryKey, effort) => selectRoute.mutate({ registryKey, effort }),
            onMakeDefault: () => makeDefault.mutate(),
            makeDefaultPending: makeDefault.isPending,
            onOpenSettings: () => onOpenSettings?.('models'),
            onRefresh: refreshModelLists,
          }}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          slashCommands={slashCommands}
          onDraftChange={(value) => { setDraft(value); setHeldCommand(null); }}
          onComposerKeyDown={handleComposerKeyDown}
          onSubmit={submit}
          onFileSelection={handleFileSelection}
          onFilesAdded={addAttachedFiles}
          onRemoveAttachedFile={removeAttachedFile}
          attachNote={attachNote}
        />
        {/* Starters are for an empty composer: once something is typed (a slash command
            among them, whose menu opens where they sit) they step aside. */}
        {isNewChat && !draft.trim() && (
          <div className="chat-suggestions" role="group" aria-label="Start with">
            {suggestions.map((suggestion) => {
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
