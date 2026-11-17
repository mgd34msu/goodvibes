/**
 * useChatSearch, companion-history search hook.
 *
 * TWO DISTINCT STAGES, kept separate rather than merged:
 *
 *   1. SESSION search (`sessionResults`), via
 *      `platform.operator.sessions.search({ query, kind: 'companion-chat', ... })`.
 *      Matches session id/title/project across full history.
 *
 *   2. MESSAGE-text search (`results`), via `platform.chat.messages.search`:
 *      the daemon matches message text across every chat in one scan and
 *      answers newest first, paged. One request per settled query; nothing is
 *      read chat by chat in the browser.
 *
 * THE includeClosed DIVERGENCE (load-bearing, name it wherever this is read):
 * sessions.search defaults `includeClosed` to FALSE, the OPPOSITE of
 * SharedSessionBroker.listSessions' own default (session-search.ts's handler
 * comment on the platform side calls this out explicitly; sessions-union.ts's
 * consumer, SessionsView, defaults its own includeClosed toggle to TRUE for
 * exactly the same reason it should NOT be true here). A search surface
 * hides dead sessions by default; a full list surface shows them. Do not
 * "fix" this hook to match SessionsView's default, they are intentionally
 * different truths for different surfaces. `includeClosed` is exposed here
 * as an explicit, off-by-default toggle so the user can opt in, and it
 * applies to both stages.
 *
 * Failures degrade honestly: a route-absent/NOT_INVOKABLE response (the
 * daemon does not serve the method) surfaces as the `'unavailable'` state,
 * never a silent empty list indistinguishable from a genuine zero-result
 * search.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { client as platformClient } from '../../lib/goodvibes';
import type { CompanionMessageSearchHit } from '../../lib/goodvibes';
import { errorCode, formatError } from '../../lib/errors';
import type { SessionsSearchSessionSummary } from '../../lib/contract-bridge-types';

/** A single search result referencing a specific message. */
export interface ChatSearchResult {
  sessionId: string;
  messageId: string;
  /** Up to 160-character extract around the matched term. */
  snippet: string;
  /** Display title for the containing session. */
  sessionTitle: string;
  /** Message creation timestamp (epoch ms), if known. */
  createdAt?: number;
}

/** A single session-level search result (title/id match, not a specific message). */
export interface ChatSessionSearchResult {
  sessionId: string;
  sessionTitle: string;
  /** Rendered honestly, a closed session is never relabeled as active. */
  status: 'active' | 'closed';
  project?: string;
  /** Most recent activity timestamp (epoch ms), if known. */
  updatedAt?: number;
}

/**
 * Lifecycle of one search stage.
 *   'idle'       , no query typed yet.
 *   'searching'  , request in flight (debounced).
 *   'ready'      , a response landed (the results reflect it, may be empty).
 *   'unavailable', the daemon does not serve the method (NOT_INVOKABLE /
 *                   route-absent), distinct from a genuine empty result.
 *   'error'      , some other request failure (network, 5xx, etc).
 */
export type SessionSearchState = 'idle' | 'searching' | 'ready' | 'unavailable' | 'error';

/** The value returned from useChatSearch. */
export interface UseChatSearchReturn {
  /** Message-text matches for the current query, newest first. */
  results: ChatSearchResult[];
  /** True while the first page of message matches is being fetched. */
  isSearching: boolean;
  /** Lifecycle of the message-text stage. */
  messageSearchState: SessionSearchState;
  /** True when the daemon holds further message matches (nextCursor present). */
  hasMoreResults: boolean;
  /** True while a further page of message matches is in flight. */
  isLoadingMoreResults: boolean;
  /** Fetch the next page of message matches and append them. */
  loadMoreResults: () => void;
  /** Why the last further page of message matches failed; cleared by the next try or a new search. */
  loadMoreResultsError?: string;
  /** Session-discovery results from sessions.search (title/id match, full history). */
  sessionResults: ChatSessionSearchResult[];
  /** Lifecycle of the session-search stage, see SessionSearchState. */
  sessionSearchState: SessionSearchState;
  /**
   * Whether closed/reaped sessions are included in both stages.
   * Defaults to false, matching sessions.search's own default (NOT
   * sessions.list's), see the module doc comment above.
   */
  includeClosed: boolean;
  setIncludeClosed: (value: boolean) => void;
  /** True when a further page of session results exists (nextCursor present). */
  hasMoreSessions: boolean;
  /** True while a load-more request for session results is in flight. */
  isLoadingMoreSessions: boolean;
  /** Fetch the next page of session results and append them. */
  loadMoreSessions: () => void;
  /** Why the last further page of session results failed; cleared by the next try or a new search. */
  loadMoreSessionsError?: string;
}

const DEBOUNCE_MS = 300;
const MESSAGE_SEARCH_LIMIT = 25;

function toChatSearchResult(hit: CompanionMessageSearchHit): ChatSearchResult {
  return {
    sessionId: hit.sessionId,
    messageId: hit.messageId,
    snippet: hit.snippet,
    sessionTitle: hit.sessionTitle || 'Untitled session',
    createdAt: hit.createdAt,
  };
}

/** Fetch one page of message-text matches from the daemon. */
async function fetchMessageSearchPage(
  query: string,
  includeClosed: boolean,
  signal?: AbortSignal,
  cursor?: string,
): Promise<{ results: ChatSearchResult[]; nextCursor?: string; hasMore: boolean }> {
  const page = await platformClient.chat.messages.search({
    query,
    includeClosed,
    limit: MESSAGE_SEARCH_LIMIT,
    ...(cursor ? { cursor } : {}),
  }, signal);
  return {
    results: page.items.map(toChatSearchResult),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

const SESSION_SEARCH_LIMIT = 20;

/**
 * Kind filter for sessions.search, scopes the backend session-discovery
 * stage to companion chat sessions (this hook's domain), matching one of the
 * six KNOWN_SESSION_KINDS in sessions-union.ts. Not imported from there: that
 * module exports the full list for the cross-surface union view, not a single
 * literal for one consumer.
 */
const COMPANION_CHAT_KIND = 'companion-chat';

/** Map a wire session-search summary onto this hook's honest result shape. */
function toSessionSearchResult(summary: SessionsSearchSessionSummary): ChatSessionSearchResult {
  return {
    sessionId: summary.id,
    sessionTitle: summary.title || 'Untitled session',
    status: summary.status === 'closed' ? 'closed' : 'active',
    project: summary.project,
    updatedAt: summary.lastActivityAt ?? summary.updatedAt,
  };
}

/** True when `error` is the daemon's honest "this method is not served" rejection. */
function isNotInvokableError(error: unknown): boolean {
  return errorCode(error) === 'NOT_INVOKABLE';
}

/**
 * Fetch one page of the backend session-search stage.
 *
 * `includeClosed` defaults to false at the call site below to match
 * sessions.search's own default, see the module doc comment for why this is
 * intentionally different from the union session list's default.
 */
async function fetchSessionSearchPage(
  query: string,
  includeClosed: boolean,
  cursor?: string,
): Promise<{ sessions: ChatSessionSearchResult[]; nextCursor?: string; hasMore: boolean }> {
  const page = await platformClient.operator.sessions.search({
    query,
    kind: COMPANION_CHAT_KIND,
    includeClosed,
    limit: SESSION_SEARCH_LIMIT,
    ...(cursor ? { cursor } : {}),
  });
  return {
    sessions: page.sessions.map(toSessionSearchResult),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/**
 * Hook that searches across all companion chat sessions and messages.
 *
 * @param query - The raw search string (hook debounces internally).
 */
export function useChatSearch(query: string): UseChatSearchReturn {
  const [includeClosed, setIncludeClosed] = useState(false);

  // Message-text stage (chat.messages.search).
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [messageSearchState, setMessageSearchState] = useState<SessionSearchState>('idle');
  const [messageCursor, setMessageCursor] = useState<string | undefined>(undefined);
  const [hasMoreResults, setHasMoreResults] = useState(false);
  const [isLoadingMoreResults, setIsLoadingMoreResults] = useState(false);
  const [loadMoreResultsError, setLoadMoreResultsError] = useState<string | undefined>(undefined);
  // Bumped for every fresh message search, so a page requested for an earlier
  // search is dropped instead of appended.
  const messageGenerationRef = useRef(0);
  const messageParamsRef = useRef({ query: '', includeClosed });

  // Session-search stage (sessions.search), a separate concern from the
  // message stage above: different backend, its own pagination and lifecycle.
  const [sessionResults, setSessionResults] = useState<ChatSessionSearchResult[]>([]);
  const [sessionSearchState, setSessionSearchState] = useState<SessionSearchState>('idle');
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
  const [loadMoreSessionsError, setLoadMoreSessionsError] = useState<string | undefined>(undefined);
  const sessionSearchAbortRef = useRef<AbortController | null>(null);
  // Tracks the query/includeClosed pair the currently-visible sessionResults were
  // fetched for, so a slow load-more response that lands after the user has
  // already changed the query/toggle is discarded rather than silently applied.
  const activeSessionParamsRef = useRef({ query: '', includeClosed });
  // Monotonic generation counter, bumped every time a FRESH search begins (see
  // runSessionSearch). The param check above can't catch the query-changed-then-changed-
  // BACK case: a load-more launched against generation N, whose page lands after the user
  // retyped the SAME query (a new fresh search, generation N+1, with its own backend
  // cursor), would pass the param equality test and append a stale page onto fresh
  // results. Comparing the generation captured at load-more time closes that hole.
  const searchGenerationRef = useRef(0);

  useEffect(() => {
    messageGenerationRef.current += 1;
    messageParamsRef.current = { query, includeClosed };
    setLoadMoreResultsError(undefined);
    if (!query.trim()) {
      setResults([]);
      setMessageSearchState('idle');
      setMessageCursor(undefined);
      setHasMoreResults(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setMessageSearchState('searching');
      void (async () => {
        try {
          const page = await fetchMessageSearchPage(query, includeClosed, controller.signal);
          if (controller.signal.aborted) return;
          setResults(page.results);
          setMessageCursor(page.nextCursor);
          setHasMoreResults(page.hasMore);
          setMessageSearchState('ready');
        } catch (error) {
          if (controller.signal.aborted) return;
          setResults([]);
          setMessageCursor(undefined);
          setHasMoreResults(false);
          setMessageSearchState(isNotInvokableError(error) ? 'unavailable' : 'error');
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, includeClosed]);

  const loadMoreResults = useCallback(() => {
    if (isLoadingMoreResults || !hasMoreResults || !messageCursor) return;
    const requested = messageParamsRef.current;
    const generation = messageGenerationRef.current;
    setIsLoadingMoreResults(true);
    setLoadMoreResultsError(undefined);
    void (async () => {
      try {
        const page = await fetchMessageSearchPage(requested.query, requested.includeClosed, undefined, messageCursor);
        if (messageGenerationRef.current !== generation) return;
        setResults((prev) => [...prev, ...page.results]);
        setMessageCursor(page.nextCursor);
        setHasMoreResults(page.hasMore);
      } catch (error) {
        // A failed further page leaves the matches already shown in place and
        // says why; "Load more" stays offered so the user can try again.
        if (messageGenerationRef.current !== generation) return;
        setLoadMoreResultsError(isNotInvokableError(error)
          ? 'This daemon does not serve message search any more.'
          : `More messages could not be loaded: ${formatError(error)}`);
      } finally {
        setIsLoadingMoreResults(false);
      }
    })();
  }, [hasMoreResults, messageCursor, isLoadingMoreResults]);

  // ── Session-search stage (sessions.search) ────────
  //
  // Debounced independently of the message stage above; it re-runs on
  // `includeClosed` toggling in addition to `query` changes.
  const runSessionSearch = useCallback(
    async (term: string, closed: boolean, signal: AbortSignal): Promise<void> => {
      // A fresh search supersedes any in-flight load-more from a prior generation.
      searchGenerationRef.current += 1;
      setLoadMoreSessionsError(undefined);
      if (!term.trim()) {
        setSessionResults([]);
        setSessionSearchState('idle');
        setNextCursor(undefined);
        setHasMoreSessions(false);
        return;
      }

      setSessionSearchState('searching');
      try {
        const page = await fetchSessionSearchPage(term, closed);
        if (signal.aborted) return;
        setSessionResults(page.sessions);
        setNextCursor(page.nextCursor);
        setHasMoreSessions(page.hasMore);
        setSessionSearchState('ready');
      } catch (error) {
        if (signal.aborted) return;
        setSessionResults([]);
        setNextCursor(undefined);
        setHasMoreSessions(false);
        setSessionSearchState(isNotInvokableError(error) ? 'unavailable' : 'error');
      }
    },
    [],
  );

  useEffect(() => {
    activeSessionParamsRef.current = { query, includeClosed };
  }, [query, includeClosed]);

  useEffect(() => {
    sessionSearchAbortRef.current?.abort();

    if (!query.trim()) {
      setSessionResults([]);
      setSessionSearchState('idle');
      setNextCursor(undefined);
      setHasMoreSessions(false);
      return;
    }

    const controller = new AbortController();
    sessionSearchAbortRef.current = controller;

    const timer = window.setTimeout(() => {
      void runSessionSearch(query, includeClosed, controller.signal);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
      sessionSearchAbortRef.current = null;
    };
  }, [query, includeClosed, runSessionSearch]);

  const loadMoreSessions = useCallback(() => {
    if (isLoadingMoreSessions || !hasMoreSessions || !nextCursor) return;
    const requestedParams = activeSessionParamsRef.current;
    const requestedGeneration = searchGenerationRef.current;

    setIsLoadingMoreSessions(true);
    setLoadMoreSessionsError(undefined);
    void (async () => {
      try {
        const page = await fetchSessionSearchPage(requestedParams.query, requestedParams.includeClosed, nextCursor);
        // Discard if a FRESH search has begun since this page was requested, even if its
        // params happen to match (query changed away and back), it is a different search
        // with a different backend cursor, so appending this page would mix generations.
        if (searchGenerationRef.current !== requestedGeneration) {
          return;
        }
        // Belt-and-braces: also discard on a bare param change (a fresh search may not
        // have STARTED yet, e.g. still debouncing, but the toggle already moved).
        if (
          activeSessionParamsRef.current.query !== requestedParams.query
          || activeSessionParamsRef.current.includeClosed !== requestedParams.includeClosed
        ) {
          return;
        }
        setSessionResults((prev) => [...prev, ...page.sessions]);
        setNextCursor(page.nextCursor);
        setHasMoreSessions(page.hasMore);
      } catch (error) {
        // A failure for a superseded request says nothing about the newer search.
        const superseded = searchGenerationRef.current !== requestedGeneration
          || activeSessionParamsRef.current.query !== requestedParams.query
          || activeSessionParamsRef.current.includeClosed !== requestedParams.includeClosed;
        if (!superseded && isNotInvokableError(error)) setSessionSearchState('unavailable');
        // Otherwise: leave the existing page's results in place and say why
        // no more came. A failed load-more is not a failed search, do not blow
        // away what already rendered successfully.
        else if (!superseded) setLoadMoreSessionsError(`More sessions could not be loaded: ${formatError(error)}`);
      } finally {
        setIsLoadingMoreSessions(false);
      }
    })();
  }, [hasMoreSessions, nextCursor, isLoadingMoreSessions]);

  return {
    results,
    isSearching: messageSearchState === 'searching',
    messageSearchState,
    hasMoreResults,
    isLoadingMoreResults,
    loadMoreResults,
    loadMoreResultsError,
    sessionResults,
    sessionSearchState,
    includeClosed,
    setIncludeClosed,
    hasMoreSessions,
    isLoadingMoreSessions,
    loadMoreSessions,
    loadMoreSessionsError,
  };
}
