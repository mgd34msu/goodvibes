import { Plug, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import AppShell from './components/shell/AppShell';
import { ModeChip } from './components/shell/ModeChip';
import { ShellLayout } from './components/shell/ShellLayout';
import { viewTitle } from './components/shell/nav';
import { PowerChip } from './components/status/PowerChip';
import { WakeChip } from './components/voice/WakeChip';
import { getCommands, registerCommand, unregisterCommand } from './lib/commands';
import { useConfirm } from './components/ui/ConfirmDialog';
import { Button } from './components/ui/Button';
import { useUrlState } from './hooks/useUrlState';
import type { ViewId } from './lib/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorMethodInput } from '@goodvibes/engine/contracts';
import { useDaemonHealth } from './hooks/useDaemonHealth';
import { usePairingHandoff } from './hooks/usePairingHandoff';
import { usePreloadErrorReload } from './hooks/usePreloadErrorReload';
import { useRelayPairingHandoff } from './hooks/useRelayPairingHandoff';
import { RelayPairingOffer } from './components/auth/RelayPairingOffer';
import { usePushSubscriptionReconcile } from './hooks/usePushSubscriptionReconcile';
import { useRealtimeInvalidation } from './hooks/useRealtimeInvalidation';
import { StepUpHost } from './components/auth/StepUpHost';
import { PairingHandoffOffers } from './components/pairing/PairingHandoffOffers';
import { PairingPostureNotice } from './components/pairing/PairingPostureNotice';
import { RelayOverflowBanner } from './components/status/RelayOverflowBanner';
import { WakeBanner } from './components/voice/WakeBanner';
import { useWakeHost } from './lib/voice/useWake';
import { DaemonReceipts } from './components/status/DaemonReceipts';
import { getCurrentAuth, hasSignInSync, client as platformClient } from './lib/goodvibes';
import { useSignOut } from './hooks/useSignOut';
import { queryKeys } from './lib/queries';
import { hostedSessionsFromListResult } from './lib/hosted-sessions';
import { ChatView } from './views/ChatView';
import { WorkView } from './views/work/WorkView';
import { LibraryView } from './views/library/LibraryView';
import { PersonalView } from './views/personal/PersonalView';
import { PhoneNodeView } from './views/phone/PhoneNodeView';
import { SignedOutGate } from './components/auth/SignedOutGate';
import { DaemonUnreachableGate } from './components/auth/DaemonUnreachableGate';
import { SettingsDialog } from './components/settings/dialog/SettingsDialog';
import type { SettingsSectionId } from './components/settings/dialog/sections';
import { shellCounts } from './lib/needs-you';
import { useOpenAsks } from './hooks/useOpenAsks';
import { useEventStreamState } from './lib/event-stream';
import { asRecord, bestId, bestTitle, firstString } from './lib/object';
import { nonEmpty } from './lib/non-empty';
import {
  companionSessionsFromListResponse,
  readStoredActiveCompanionSessionId,
  readStoredCompanionSessions,
  writeStoredActiveCompanionSessionId,
  writeStoredCompanionSessions,
} from './lib/companion-chat';
import {
  companionSessionsReducer,
  companionSessionsStateFromStored,
  selectNextSessionId,
  selectRemovedSessionIds,
  selectVisibleSessions,
} from './lib/companion-sessions-state';
import { formatError, isDaemonUnreachableError, isMethodUnavailableError, isServerFaultError, isSessionNotFoundError } from './lib/errors';

/** Read the auth status two minutes before a session's reported end; false for a credential with no end. */
function sessionEndRereadDelay(snapshot: unknown): number | false {
  const expiresAt = asRecord(snapshot).expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return Math.min(2_147_483_647, Math.max(30_000, expiresAt - Date.now() - 120_000));
}

export default function App() {
  const queryClient = useQueryClient();
  const { view, setView, setTab, tab, session: activeChatSessionId, setSession, setUrlState, settings: settingsSection, chatSelection } = useUrlState();
  const activeView: ViewId = view;
  const [draftChatRequested, setDraftChatRequested] = useState(false);
  // One record of the companion chat sessions this browser knows about (local copies,
  // ids created here and not yet confirmed by the daemon, ids hidden after a delete).
  // See src/lib/companion-sessions-state.ts: the rendered list is derived from it, so
  // no handler can leave two views of the same session disagreeing.
  const [chatSessionsState, dispatchChatSessions] = useReducer(
    companionSessionsReducer,
    undefined,
    () => companionSessionsStateFromStored(readStoredCompanionSessions()),
  );
  // Pairing hand-off: a `#pair=<token>` fragment (from the terminal's `goodvibes pair`
  // QR) is consumed once at mount, the token is stripped from the URL, stored, and
  // validated. `pending` shows the pairing splash instead of the gate; `error` surfaces
  // on the gate. See usePairingHandoff.
  const pairing = usePairingHandoff();
  // A lazily loaded chunk that fails because this page is an older build than the daemon serves reloads once.
  usePreloadErrorReload();
  // Relay pairing hand-off: a `#relay=<gvrelay1.…>` fragment is consumed once at
  // mount, same discipline as the token pairing above, but for a DIFFERENT payload,
  // transport bootstrap, not identity. It never gates first paint the way
  // `pairing.status === 'pending'` does: a decoded pairing waits as an offer the
  // operator confirms (relayOffer below), and a malformed code surfaces as a banner on
  // the signed-out gate.
  const relayPairing = useRelayPairingHandoff();
  const auth = useQuery({
    queryKey: queryKeys.auth,
    queryFn: getCurrentAuth,
    retry: false,
    // Auto-recovery: while the daemon is unreachable, keep re-probing so the shell
    // reveals itself the moment the daemon answers again. A 401 (genuinely signed out)
    // is NOT an unreachable error, so this does not busy-poll the sign-in front door.
    // Signed in with a session that ends: read again shortly before that end, so the end the
    // daemon has moved forward while the app was used replaces the stored one (getCurrentAuth).
    refetchInterval: (query) => (isDaemonUnreachableError(query.state.error) || isServerFaultError(query.state.error)
      ? 5_000 : sessionEndRereadDelay(query.state.data)),
    refetchIntervalInBackground: true,
  });
  // D-WEBUI-3: auth.current only re-probes once it has ALREADY errored (see
  // refetchInterval above), while healthy it never re-runs on its own, so a daemon
  // death during an idle session would otherwise surface nothing until the user does
  // something that happens to trigger a query. Health (useDaemonHealth) watches the live
  // event stream and probes the daemon whenever that stream is down, so it is the signal
  // that catches an outage while auth.current is sitting on stale "everything is fine" data.
  const health = useDaemonHealth();
  // Wake-word detection, mounted at the shell rather than in a view: it holds a
  // microphone for as long as the user has it on, so its lifetime cannot be a view's
  // lifetime. This resolves voice.wake.* for this surface and applies it; while
  // voice.wake.surfaces.webui is off (the default) it loads no model and calls no
  // getUserMedia, so no permission prompt appears. The transcript sink is registered
  // separately by the view that owns a composer (ChatView).
  useWakeHost();
  // Live invalidation, session lifecycle and approval updates: one subscriber on the
  // tab's shared event stream (lib/event-stream.ts), opened only once signed in (opening
  // it signed-out just 401s) and re-subscribed on every auth transition. The message is
  // the stream's own while it is paused or stopped, else null.
  const realtimeError = useRealtimeInvalidation(auth.isSuccess);
  const liveUpdates = useEventStreamState('app');
  // Push self-heal: on every rising edge into connected+signed-in (first open, or a
  // reconnect after an outage), compare this browser's live push subscription against
  // the daemon's own record and heal any drift in place. See usePushSubscriptionReconcile.
  usePushSubscriptionReconcile(health.connection === 'connected' && auth.isSuccess);
  // The fleet subscription rides the SAME multiplexed stream as the invalidation
  // hook above; realtimeError == null means that stream is live, so fleet events are
  // flowing and the poll can recede to a safety cadence (FleetView reads this to gate
  // its own poll fallback).
  const fleetSubscriptionActive = realtimeError == null;
  // App-level fleet snapshot: kept warm regardless of the active view so the Fleet
  // nav entry can show an attention badge (count of nodes blocked on a human) even
  // while you are elsewhere. It shares queryKeys.fleet with FleetView, React Query
  // dedupes the fetch and both read the same cache, and it is invalidated by fleet
  // events (useRealtimeInvalidation) for liveness, with the poll as the honest
  // fallback when the subscription is down. Derived purely from current data; no new
  // client store.
  const fleetSnapshot = useQuery({
    queryKey: queryKeys.fleet,
    queryFn: () => platformClient.operator.fleet.snapshot(),
    enabled: auth.isSuccess,
    refetchInterval: fleetSubscriptionActive ? 60_000 : 15_000,
  });
  // The badge and the account menu's "running" are the work board's counts (lib/needs-you.ts):
  // the asks waiting for you (approvals and open inbox items), ready best-of-N groups, the
  // fleet and runtime tasks. Every read shares the Work page's cache keys, so opening the
  // page re-uses them rather than adding more.
  const { asks: openAskList } = useOpenAsks(auth.isSuccess);
  const attemptGroupList = useQuery({
    queryKey: queryKeys.fleetAttempts,
    queryFn: () => platformClient.operator.fleet.attempts.list(),
    enabled: auth.isSuccess,
    refetchInterval: fleetSubscriptionActive ? 60_000 : 15_000,
    retry: false,
  });
  // Runtime tasks: the same key and read the health hook and Work use, so no request is added.
  const taskList = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => platformClient.operator.tasks.list(),
    enabled: auth.isSuccess,
    retry: 0,
  });
  // Daemon-hosted sessions: the same key, request and cadence Work's list reads (Work shows finished
  // ones too), so a hosted turn answering now is counted here as it is on the page, with no second request.
  const hostedList = useQuery({
    queryKey: queryKeys.hostedSessions(true),
    queryFn: () => platformClient.operator.sessions.hosted.list({ includeTerminated: true }),
    enabled: auth.isSuccess,
    refetchInterval: liveUpdates.status === 'live' ? 60_000 : 15_000,
    retry: false,
  });
  const hostedRecords = useMemo(() => hostedSessionsFromListResult(hostedList.data), [hostedList.data]);
  const workCounts = useMemo(
    () => shellCounts({
      asks: openAskList,
      hosted: hostedRecords,
      nodes: fleetSnapshot.data?.nodes ?? [],
      attemptGroups: attemptGroupList.isError ? [] : attemptGroupList.data?.groups ?? [],
      tasks: taskList.data?.tasks ?? [],
    }),
    [openAskList, hostedRecords, fleetSnapshot.data, attemptGroupList.data, attemptGroupList.isError, taskList.data],
  );
  const fleetAttentionCount = workCounts.waiting;
  const runningWork = workCounts.running;
  const chatSessions = useQuery({
    queryKey: ['companion-chat', 'sessions'],
    queryFn: () => platformClient.chat.sessions.list({ limit: 100 }),
    // The sidebar's "Recent" list shows in every view, so the list loads whenever
    // signed in (it used to load only on the chat view).
    enabled: auth.isSuccess,
  });

  // Older chats: the list above is the newest page; "Show older chats" reads the page
  // after it with the daemon's cursor, one request per press and none otherwise, so
  // every chat stays reachable from the sidebar however many there are.
  const [olderChats, setOlderChats] = useState<{
    readonly started: boolean;
    readonly sessions: readonly unknown[];
    readonly cursor: string;
    readonly loading: boolean;
    readonly failed: boolean;
  }>({ started: false, sessions: [], cursor: '', loading: false, failed: false });
  const firstPageCursor = typeof asRecord(chatSessions.data).nextCursor === 'string' ? asRecord(chatSessions.data).nextCursor as string : '';
  const olderCursor = olderChats.started ? olderChats.cursor : firstPageCursor;
  const showOlderChats = useCallback(() => {
    if (!olderCursor || olderChats.loading) return;
    setOlderChats((current) => ({ ...current, loading: true, failed: false }));
    // `cursor` is on the method's schema; the generated input type gains it when the contract is regenerated.
    const input: OperatorMethodInput<'companion.chat.sessions.list'> & { readonly cursor: string } = { limit: 100, cursor: olderCursor };
    platformClient.chat.sessions.list(input).then((page) => {
      const next = asRecord(page).nextCursor;
      setOlderChats((current) => ({
        started: true,
        sessions: [...current.sessions, ...companionSessionsFromListResponse(page)],
        cursor: typeof next === 'string' ? next : '',
        loading: false,
        failed: false,
      }));
    }, () => {
      setOlderChats((current) => ({ ...current, loading: false, failed: true }));
    });
  }, [olderCursor, olderChats.loading]);

  const fetchedChatSessions = useMemo(() => {
    const newest = companionSessionsFromListResponse(chatSessions.data);
    if (olderChats.sessions.length === 0) return newest;
    // A chat updated since its older page was read is in the newest page now: listed once, there.
    const listed = new Set(newest.map((session) => bestId(session)));
    return [...newest, ...olderChats.sessions.filter((session) => !listed.has(bestId(session)))];
  }, [chatSessions.data, olderChats.sessions]);
  const chatSessionItems = useMemo(
    () => selectVisibleSessions(chatSessionsState, {
      serverSessions: fetchedChatSessions,
      serverListLoaded: chatSessions.isSuccess,
    }),
    [chatSessions.isSuccess, chatSessionsState, fetchedChatSessions],
  );
  // The chat named in the address, when it is not among the listed ones: the list holds the
  // newest chats only, so an older one (opened from Work, a bookmark, a link from another
  // device) is read by id before the address is given up on.
  const activeChatListed = chatSessionItems.some((session) => bestId(session) === activeChatSessionId);
  const activeChatRemoved = useMemo(
    () => Boolean(activeChatSessionId) && selectRemovedSessionIds(chatSessionsState).has(activeChatSessionId),
    [activeChatSessionId, chatSessionsState],
  );
  const [missingChatNotice, setMissingChatNotice] = useState(false);

  // DELETE-MEANS-DELETE. "Delete" now names a real hard-delete distinct from
  // "close": companion.chat.sessions.delete permanently removes the on-disk
  // record but requires the session to already be closed (409 SESSION_ACTIVE
  // otherwise), so this always closes first, a no-op if the daemon has no separate
  // close route yet (isMethodUnavailableError) or the session is already closed
  // (SESSION_NOT_FOUND from a double-close race). The mutation never trusts the
  // delete call's 200 at face value: it reads the session back by id and only reports
  // success once the daemon answers that the record is genuinely absent,
  // the exact anti-pattern this replaces was trusting the client-side hide (the
  // removed entry in companion-sessions-state) as proof, which just hides a
  // soft-closed record whose file never left disk. A daemon that still only
  // soft-closes (pre-S1) is caught here and surfaces "Delete did not complete"
  // rather than a false "Deleted".
  const deleteChat = useMutation({
    mutationFn: async (sessionId: string) => {
      try {
        await platformClient.chat.sessions.close(sessionId);
      } catch (error) {
        if (!isMethodUnavailableError(error) && !isSessionNotFoundError(error)) throw error;
      }
      try {
        await platformClient.chat.sessions.delete(sessionId);
      } catch (error) {
        if (!isSessionNotFoundError(error)) throw error;
      }
      // Proof of gone is a read of this one session: 404 means the record left disk; an
      // answer means it is still there (an older daemon only closes on delete).
      try {
        await platformClient.chat.sessions.get(sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) return;
        throw error;
      }
      throw Object.assign(
        new Error('Delete did not complete, the record still exists'),
        { code: 'DELETE_INCOMPLETE' },
      );
    },
    onMutate: async (sessionId) => {
      await queryClient.cancelQueries({ queryKey: ['companion-chat', 'sessions'] });
      const nextSessionId = selectNextSessionId(chatSessionItems, sessionId);
      dispatchChatSessions({ type: 'session-delete-requested', sessionId });
      if (activeChatSessionId === sessionId) {
        setSession(nextSessionId, { replace: true });
        setDraftChatRequested(!nextSessionId);
      }
    },
    onError: (error, sessionId) => {
      // A 404 here means the target is already gone (e.g. a double-delete race),
      // the outcome the user wanted is already true, so leave it hidden. Every OTHER
      // failure, including DELETE_INCOMPLETE from the proof-of-gone reconcile above,
      // restores visibility rather than leaving a false "it's deleted" impression: the
      // optimistic hide was a guess, and this says plainly that the guess was wrong.
      // Restoration comes from the daemon list (onSettled invalidates the query), not
      // from a local copy; before the first successful list the row stays hidden.
      if (isSessionNotFoundError(error)) return;
      dispatchChatSessions({ type: 'session-delete-failed', sessionId });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] });
    },
  });

  // Seed local session state from localStorage on first mount if URL has no session.
  const [sessionRestored, setSessionRestored] = useState(false);
  useEffect(() => {
    if (!activeChatSessionId) {
      const stored = readStoredActiveCompanionSessionId();
      if (stored) setSession(stored, { replace: true });
    }
    setSessionRestored(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The session-selecting effects act only on the chat view: the list loads in every
  // view (for "Recent"), and choosing a session elsewhere would rewrite that view's URL.
  useEffect(() => {
    if (!sessionRestored || view !== 'chat') return;
    if (!activeChatSessionId && !draftChatRequested && chatSessionItems.length) {
      setSession(bestId(chatSessionItems[0]), { replace: true });
    }
  }, [sessionRestored, view, activeChatSessionId, chatSessionItems, draftChatRequested, setSession]);

  // "New chat" is a request for an EMPTY session, so it cannot outlive a URL that names
  // one. Back/forward after "New chat" lands on a session without passing through any
  // handler above; without this the header and sidebar kept reading "New chat" while the
  // chat showed that session. (Every handler that sets the flag also clears the session
  // in the same batch, so this never races a genuine new-chat request.)
  useEffect(() => {
    if (draftChatRequested && activeChatSessionId) setDraftChatRequested(false);
  }, [draftChatRequested, activeChatSessionId]);

  useEffect(() => {
    if (sessionRestored) writeStoredActiveCompanionSessionId(activeChatSessionId);
  }, [activeChatSessionId, sessionRestored]);

  useEffect(() => {
    if (chatSessions.isSuccess || chatSessionItems.length) writeStoredCompanionSessions(chatSessionItems);
  }, [chatSessionItems, chatSessions.isSuccess]);

  useEffect(() => {
    if (!chatSessions.isSuccess) return;
    dispatchChatSessions({ type: 'server-sessions-synced', sessionIds: fetchedChatSessions.map(bestId) });
  }, [chatSessions.isSuccess, fetchedChatSessions]);

  const handleMissingChatSession = useCallback((sessionId: string) => {
    dispatchChatSessions({ type: 'session-reported-missing', sessionId });
    queryClient.removeQueries({ queryKey: ['companion-chat', sessionId] });
    queryClient.removeQueries({ queryKey: ['companion-chat', sessionId, 'messages'] });
    if (activeChatSessionId === sessionId) {
      const nextSessionId = chatSessions.isSuccess ? selectNextSessionId(chatSessionItems, sessionId) : '';
      setMissingChatNotice(true);
      setSession(nextSessionId, { replace: true });
      setDraftChatRequested(!nextSessionId);
    }
    void queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] });
  }, [activeChatSessionId, chatSessionItems, chatSessions.isSuccess, queryClient, setSession]);

  const activeChatLookup = useQuery({
    queryKey: ['companion-chat', activeChatSessionId, 'lookup'],
    queryFn: () => platformClient.chat.sessions.get(activeChatSessionId),
    enabled: sessionRestored && view === 'chat' && chatSessions.isSuccess && Boolean(activeChatSessionId)
      && !activeChatListed && !activeChatRemoved,
    retry: false,
  });
  useEffect(() => {
    if (activeChatLookup.data) dispatchChatSessions({ type: 'session-opened-by-id', session: activeChatLookup.data });
  }, [activeChatLookup.data]);

  // Leave the address only when the daemon says the chat is gone (or this tab removed it).
  // While the by-id read is in flight, or it failed for another reason, the address stays.
  useEffect(() => {
    if (!sessionRestored || view !== 'chat') return;
    if (!chatSessions.isSuccess || !activeChatSessionId || activeChatListed) return;
    if (isSessionNotFoundError(activeChatLookup.error)) {
      handleMissingChatSession(activeChatSessionId);
      return;
    }
    if (!activeChatRemoved) return;
    const nextSessionId = selectNextSessionId(chatSessionItems, activeChatSessionId);
    setSession(nextSessionId, { replace: true });
    setDraftChatRequested(!nextSessionId);
  }, [sessionRestored, view, activeChatSessionId, activeChatListed, activeChatRemoved, activeChatLookup.error,
    chatSessionItems, chatSessions.isSuccess, handleMissingChatSession, setSession]);

  const handleNavigate = useCallback(
    (nextView: ViewId, options?: { newChat?: boolean; tab?: string }) => {
      setMissingChatNotice(false);
      if (options?.newChat) {
        // One URL update for view and session together: setView then setSession would
        // build the second entry from the pre-navigation state and put the old view back.
        setUrlState({ view: nextView, session: '' });
        setDraftChatRequested(true);
        return;
      }
      setView(nextView, options?.tab ? { tab: options.tab } : undefined);
    },
    [setView, setUrlState],
  );

  // The settings dialog lives in the URL (?settings=<section>): opening pushes a
  // history entry, so Back closes it; switching sections replaces the entry.
  const openSettings = useCallback(
    (section?: string) => setUrlState({ settings: nonEmpty(section) ?? 'general' }),
    [setUrlState],
  );
  const closeSettings = useCallback(() => setUrlState({ settings: '' }), [setUrlState]);
  const changeSettingsSection = useCallback(
    (section: SettingsSectionId) => setUrlState({ settings: section }, { replace: true }),
    [setUrlState],
  );
  const openViewFromSettings = useCallback(
    (nextView: ViewId) => setUrlState({ view: nextView, settings: '' }),
    [setUrlState],
  );

  // Open a specific session in the chat view, one history entry (view + session
  // together), used by the Work page and the CI "open fix session" affordance. A session
  // the list does not hold yet (just started, or older than the listed ones) is read by id
  // in the chat view, so this navigates at once; the list refreshes behind it for Recent.
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      setDraftChatRequested(false);
      setMissingChatNotice(false);
      setUrlState({ view: 'chat', session: sessionId });
      void queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] });
    },
    [queryClient, setUrlState],
  );

  const recentChats = useMemo(
    () => chatSessionItems.map((session, index) => {
      const id = bestId(session) || String(index);
      return { id, title: bestTitle(session, id) };
    }),
    [chatSessionItems],
  );
  const activeChatTitle = useMemo(
    () => recentChats.find((chat) => chat.id === activeChatSessionId)?.title ?? '',
    [recentChats, activeChatSessionId],
  );
  // The header names the chat you are in, or the destination for every other view.
  const title = activeView === 'chat'
    ? (draftChatRequested || !activeChatTitle ? 'New chat' : activeChatTitle)
    : viewTitle(activeView);
  // The signed-in name as the identity reports it ('' when it reports none).
  const signedInName = useMemo(() => {
    const record = asRecord(auth.data);
    const identity = asRecord(record.identity);
    return firstString(record, ['username', 'name', 'principal']) || firstString(identity, ['name', 'subject']);
  }, [auth.data]);
  // The identity carries no person's name for a device token; an owner device is the
  // owner's, so his name comes from his profile (one read per sign-in, kept).
  const ownerDevice = asRecord(auth.data).admin === true;
  const ownerName = useQuery({
    queryKey: queryKeys.ownerProfileField('identity.name'),
    queryFn: () => platformClient.operator.profile.get('identity.name'),
    enabled: auth.isSuccess && !signedInName && ownerDevice,
    staleTime: Infinity,
    retry: false,
  });
  const profileName = useMemo(() => {
    const field = asRecord(asRecord(ownerName.data).field);
    return typeof field.value === 'string' ? field.value.trim() : '';
  }, [ownerName.data]);
  const accountName = signedInName || profileName || 'Operator';

  const handleNewChat = useCallback(() => handleNavigate('chat', { newChat: true }), [handleNavigate]);
  const handleOpenChat = useCallback((sessionId: string) => {
    setDraftChatRequested(false);
    setMissingChatNotice(false);
    setUrlState({ view: 'chat', session: sessionId });
  }, [setUrlState]);
  const confirmDialog = useConfirm();
  const askConfirm = confirmDialog.ask;
  const handleDeleteChat = useCallback((sessionId: string, chatTitle: string) => {
    // Truthful confirm text: this is a hard delete, not the close-in-disguise it
    // used to be, see the deleteChat mutation above.
    void askConfirm({
      title: 'Delete this chat?',
      target: chatTitle,
      description: 'The chat is removed for good and cannot be reopened.',
      confirmLabel: 'Delete chat',
      tone: 'danger',
    }).then((confirmed) => {
      if (confirmed) deleteChat.mutate(sessionId);
    });
  }, [askConfirm, deleteChat]);

  // The palette's "Chats" group: the recent chats, each one command that opens it.
  useEffect(() => {
    const ids = recentChats.slice(0, 8).map((chat) => {
      const id = `chats.open.${chat.id}`;
      registerCommand({
        id,
        title: chat.title || 'Untitled chat',
        group: 'chats',
        keywords: ['chat', 'open', 'recent'],
        run: () => handleOpenChat(chat.id),
      });
      return id;
    });
    return () => {
      for (const id of ids) unregisterCommand(id);
    };
  }, [recentChats, handleOpenChat]);
  // Refresh refetches every query the open views hold, the same complete recovery the
  // relay-overflow resync runs. Busy follows this one pass, not the background polls.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void queryClient.invalidateQueries().finally(() => setRefreshing(false));
  }, [queryClient]);
  const handleSearch = useCallback(() => {
    getCommands().find((command) => command.id === 'system.palette')?.run();
  }, []);
  // A sign-out whose daemon session could not be ended: signed out here, and the reason, with a retry.
  // The outcome outlives this mount (signing out remounts the app), so it is read from useSignOut.
  const { problem: signOutProblem, signOut: signOutEverywhere, retry: retrySignOut, leaveIt: leaveSignOutUnended } = useSignOut();
  const handleSignOut = useCallback(() => { void signOutEverywhere(); }, [signOutEverywhere]);
  const handleRetrySignOut = useCallback(() => { void retrySignOut(); }, [retrySignOut]);

  // Honest login gate. Signed-out (auth.current 401 → query error) shows the front door
  // instead of the shell. On first load with a stored token, show a neutral splash while
  // it validates; with NO stored token, show the gate immediately (no white-screen, and
  // no working-looking-but-401ing shell).
  const authPending = auth.isPending;
  const hasToken = hasSignInSync();
  // A genuine 401 (not a network failure) is the ONLY thing that means "signed out",
  // this classification must win over everything else below, including a health-poll
  // outage that happens to be in flight at the same moment: a bad token always routes
  // to sign-in, never the unreachable overlay.
  // The read of who is signed in is one of three answers: a principal, absent
  // (the daemon said this token is not signed in), or failed (no answer: the
  // network, status 0, or a server fault). Only absent signs out.
  const authReadFailed = auth.isError && (isDaemonUnreachableError(auth.error) || isServerFaultError(auth.error));
  const authIsUnauthorized = auth.isError && !authReadFailed;
  // D-WEBUI-3: the daemon is "unreachable" either because auth.current itself just
  // failed with a network error, OR because health has declared the connection 'down'
  // (the event stream dropped and the probes since have failed), the latter is what catches
  // a daemon that dies mid-session while auth.current was sitting on old success data
  // and had no reason to re-fire. A network failure/health-down state with a stored
  // token means the daemon is unreachable, NOT that the operator is signed out: keep
  // the token and show the honest unreachable state. Recovery is driven by whichever
  // probe flips back first, auth.current's own 5s re-probe once IT has errored, or the
  // health poll's next successful 15s cycle.
  const healthUnreachable = health.connection === 'down';
  const daemonUnreachable = !authIsUnauthorized
    && (authReadFailed || healthUnreachable)
    && hasToken;
  // D-WEBUI-2: no stored token means signed-out, full stop, this must NOT wait on
  // auth.current's pending/cached state. Gating this on `authPending` let a stale
  // cached success from a previously-cleared token leak through as a flash of the
  // full authenticated shell (401 banners and all) before the query re-settled; a
  // missing token is knowable synchronously, so show the gate immediately.
  const signedOut = !hasToken || authIsUnauthorized;
  const showSplash = hasToken && authPending && !auth.isError;

  // The daemon-unreachable gate promises the operator will "pick up where it left
  // off" once the daemon comes back, that's only true if the workspace underneath
  // stays mounted through the outage. Render it as an overlay ON TOP of the still-
  // mounted (and inert, so it can't be typed into or clicked while hidden) workspace
  // instead of early-returning in its place; a remount would reset the selected
  // session and discard a half-typed steer/follow-up draft.
  // A pairing hand-off in flight shows a neutral splash INSTEAD of the signed-out gate,
  // so scanning a QR never flashes the gate on the way in. Once it resolves, the normal
  // auth flow below takes over (success → shell; failure → gate with pairing.error).
  if (pairing.status === 'pending') {
    return (
      <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
        <div className="app-splash" role="status" aria-live="polite">
          <img className="app-splash__mark" src="/goodvibes-icon.png" alt="" aria-hidden="true" />
          <span>Pairing this device…</span>
        </div>
      </AppShell>
    );
  }

  const relayOffer = relayPairing.status === 'pending' && relayPairing.pairing !== null
    ? <RelayPairingOffer pairing={relayPairing.pairing} onConfirm={relayPairing.confirm} onDismiss={relayPairing.dismiss} />
    : null;

  if (signedOut) {
    return (
      <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
        {relayOffer}
        {signOutProblem !== null && (
          <div className="banner warning" role="alert">
            Signed out here; the daemon session could not be ended: {signOutProblem.error}. Until it is,
            the old sign-in still works wherever it was copied.{' '}
            <Button variant="secondary" size="sm" onClick={handleRetrySignOut} disabled={signOutProblem.retrying}>
              {signOutProblem.retrying ? 'Trying…' : 'Try again'}
            </Button>{' '}
            <Button variant="ghost" size="sm" onClick={leaveSignOutUnended}>Leave it</Button>
          </div>
        )}
        <SignedOutGate
          pairingError={pairing.status === 'error' ? pairing.error : undefined}
          relayPairingError={relayPairing.status === 'error' ? relayPairing.error : undefined}
        />
      </AppShell>
    );
  }

  if (showSplash) {
    return (
      <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
        <div className="app-splash" role="status" aria-live="polite">
          <img className="app-splash__mark" src="/goodvibes-icon.png" alt="" aria-hidden="true" />
          <span>Signing in…</span>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
    <div className="app-shell-root">
    <StepUpHost />
    {confirmDialog.element}
    {/* A hand-off bundle (#pair=<token>&offers=…) surfaces its offer set once the
        token has validated. usePairingHandoff clears it back to [] via
        dismissOffers once the operator has decided (submitted or explicitly
        skipped everything), so this never reopens on its own. The daemon's one
        honest plain-http-on-LAN notice line (postureNotice) rides the SAME
        one-shot modal when there IS an offer set. */}
    {pairing.offers.length > 0 && (
      <PairingHandoffOffers
        offers={pairing.offers}
        onDone={() => { pairing.dismissOffers(); pairing.dismissPostureNotice(); }}
        postureNotice={pairing.postureNotice}
      />
    )}
    {/* A plain #pair=<token> hand-off (no offer set) has no modal of its own. The
        posture notice, if any, gets this standalone one-shot banner instead. Never
        re-appears once dismissed (postureNotice only fires once per hand-off). */}
    {pairing.offers.length === 0 && pairing.postureNotice && (
      <PairingPostureNotice notice={pairing.postureNotice} onDismiss={pairing.dismissPostureNotice} />
    )}
    {relayOffer}
    {daemonUnreachable && (
      <div className="daemon-gate-overlay">
        <DaemonUnreachableGate
          detail={formatError(auth.error)}
          serverFault={auth.isError && isServerFaultError(auth.error)}
          retrying={auth.isFetching}
          // The health poll can still say 'down' for up to a probe interval after the daemon
          // is back; Retry re-runs those probes now so the overlay does not outlive recovery.
          onRetry={() => {
            void queryClient.refetchQueries({ queryKey: ['daemon-health'] });
            void auth.refetch();
          }}
        />
      </div>
    )}
    <ShellLayout
      view={activeView}
      title={title}
      activeChatId={activeChatSessionId}
      draftChat={draftChatRequested || !activeChatSessionId}
      recentChats={recentChats}
      olderChats={olderCursor ? { loading: olderChats.loading, failed: olderChats.failed, onShow: showOlderChats } : undefined}
      deletingChatId={deleteChat.isPending ? (deleteChat.variables ?? null) : null}
      workAttention={fleetAttentionCount}
      runningNow={runningWork}
      accountName={accountName}
      health={health}
      onNavigate={setView}
      onNewChat={handleNewChat}
      onOpenChat={handleOpenChat}
      onDeleteChat={handleDeleteChat}
      onSearch={handleSearch}
      onSignOut={handleSignOut}
      onOpenSettings={openSettings}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      inert={daemonUnreachable}
      indicators={(
        <>
          {/* These chips replace the status strip's must-stay-visible segments:
              each renders nothing unless its condition holds. */}
          <ModeChip onOpenSettings={openSettings} />
          <PowerChip />
          <WakeChip />
          {health.compatibility?.status === 'restart-required' && (
            <div
              className="status-strip__segment status-strip__segment--compatibility-warning"
              role="status"
              aria-label={health.compatibility.message}
              title={health.compatibility.message}
            >
              <TriangleAlert className="status-strip__icon" aria-hidden="true" size={12} />
              <span className="status-strip__label">Reload to update</span>
            </div>
          )}
        </>
      )}
      banners={(
        <>
          <RelayOverflowBanner />
          {/* voice.wake.indicator: 'banner' is the prominent persistent listening marker.
              Renders nothing for 'statusline' (the header's WakeChip owns that) or 'off'. */}
          <WakeBanner />
          {/* Undelivered daemon receipts, read on connect and acknowledged once shown (see DaemonReceipts). */}
          <DaemonReceipts connected={health.connection === 'connected'} signedIn={auth.isSuccess} />
          {health.daemonCompatibility?.notice && (
            <div className="banner warning" role="status">
              <TriangleAlert size={16} aria-hidden="true" />
              {' '}
              {health.daemonCompatibility.notice}
            </div>
          )}
          {realtimeError && (
            <div className="banner warning">
              <Plug size={16} />
              {' '}
              {realtimeError}
            </div>
          )}
          {missingChatNotice && (
            <div className="banner warning" role="status">
              <TriangleAlert size={16} aria-hidden="true" />
              {' '}
              That chat no longer exists.
              {' '}
              <Button size="sm" variant="ghost" onClick={() => setMissingChatNotice(false)}>Dismiss</Button>
            </div>
          )}
          {deleteChat.error && !isSessionNotFoundError(deleteChat.error) && (
            <div className="banner warning"><Plug size={16} /> {formatError(deleteChat.error)}</div>
          )}
        </>
      )}
    >
      {activeView === 'chat' && (
        <ChatView
          activeSessionId={activeChatSessionId}
          chatSelection={chatSelection}
          sessionItems={chatSessionItems}
          onActiveSessionChange={(sessionId) => {
            setSession(sessionId, { replace: true });
            setDraftChatRequested(false);
          }}
          onDraftSessionRequestedChange={setDraftChatRequested}
          onLocalSessionCreated={(session) => dispatchChatSessions({ type: 'local-session-created', session })}
          onLocalSessionUpdated={(sessionId, session) => dispatchChatSessions({
            type: 'local-session-updated',
            sessionId,
            session,
          })}
          onSessionMissing={handleMissingChatSession}
          userName={signedInName || profileName}
          onOpenSettings={openSettings}
        />
      )}
      {activeView === 'work' && (
        <WorkView
          tab={tab}
          onTabChange={setTab}
          subscriptionActive={fleetSubscriptionActive}
          sessionSubscriptionActive={liveUpdates.status === 'live'}
          streamPaused={realtimeError !== null}
          onOpenSession={handleOpenSession}
        />
      )}
      {activeView === 'library' && <LibraryView tab={tab} onTabChange={setTab} />}
      {activeView === 'personal' && <PersonalView tab={tab} onTabChange={setTab} />}
      {activeView === 'phone' && <PhoneNodeView />}
    </ShellLayout>
    <SettingsDialog
      open={Boolean(settingsSection)}
      section={settingsSection ?? ''}
      onSectionChange={changeSettingsSection}
      onClose={closeSettings}
      onOpenView={openViewFromSettings}
      realtimeError={realtimeError}
    />
    </div>
    </AppShell>
  );
}
