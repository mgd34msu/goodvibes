/**
 * ChatSearch, companion-history search panel.
 *
 * Two distinct result sections, never merged (see useChatSearch's module doc
 * for why): a SESSIONS section (sessions.search, id/title match, full
 * history) and a MESSAGES section (the daemon's message-text search across
 * every chat, newest first, paged). Both honor the includeClosed toggle.
 * Selecting a session-level result opens that session with no specific
 * message to scroll to (`messageId: ''`); selecting a message result opens
 * the session and scrolls to that message.
 *
 * Exposes an `onSelect` callback: ({ sessionId, messageId }) => void.
 * Integration: wire this to setSession + scroll in the ChatView/parent;
 * this component does NOT mutate URL state directly.
 *
 * Keyboard navigation:
 *   ArrowDown / ArrowUp, move selection within the Messages list
 *   Enter              , activate selected result
 *   Escape             , clear query (caller can use to close the panel)
 * Session results and the "load more" controls are reached by Tab, each
 * individually activatable via Enter/Space, a separate, secondary
 * navigation zone from the message combobox above.
 */

import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { EmptyState } from '../../components/feedback/EmptyState';
import { IconButton } from '../../components/ui/IconButton';
import { Toggle } from '../../components/ui/Toggle';
import { SkeletonBlock } from '../../components/feedback/SkeletonBlock';
import type { ChatSearchResult, ChatSessionSearchResult } from './useChatSearch';
import { useChatSearch } from './useChatSearch';
import '../../styles/components/chat-search.css';

export interface ChatSearchSelectPayload {
  sessionId: string;
  messageId: string;
  /** What was searched for, so the message jumped to can mark the matching words. */
  query?: string;
}

export interface ChatSearchProps {
  /** Called when the user activates a result. */
  onSelect: (payload: ChatSearchSelectPayload) => void;
  /** Optional CSS class on the root element. */
  className?: string;
  /**
   * Close the find bar. When given, Escape on an empty field closes (Escape
   * with text clears it first) and a close button appears; focus moves into
   * the field on mount.
   */
  onClose?: () => void;
  /** A few words under the field, e.g. that the same key again opens the browser's own find. */
  hint?: string;
}

/** Relative time label for a result. */
function relativeTime(ms?: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ChatSearch({ onSelect, className, onClose, hint }: ChatSearchProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputId = useId();
  const listId = useId();

  const {
    results,
    isSearching,
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
  } = useChatSearch(query);

  // Reset active index when results change
  const prevResultsLen = useRef(results.length);
  // eslint-disable-next-line react-hooks/refs -- documented derived-state-during-render guard, intentional
  if (results.length !== prevResultsLen.current) {
    setActiveIndex(-1);
    // eslint-disable-next-line react-hooks/refs -- documented derived-state-during-render guard, intentional
    prevResultsLen.current = results.length;
  }

  useEffect(() => {
    if (onClose) inputRef.current?.focus();
    // Focus once, when the find bar opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  }, []);

  const handleSelect = useCallback(
    (result: ChatSearchResult) => {
      onSelect({ sessionId: result.sessionId, messageId: result.messageId, query: query.trim() });
    },
    [onSelect, query],
  );

  // Session-level result: no specific message to scroll to, open the session.
  const handleSelectSession = useCallback(
    (result: ChatSessionSearchResult) => {
      onSelect({ sessionId: result.sessionId, messageId: '' });
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        // Esc only ever closes or clears the find bar; it never reaches
        // anything that would stop work.
        e.preventDefault();
        e.stopPropagation();
        if (query) setQuery('');
        else onClose?.();
        return;
      }
      if (!results.length) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < results.length) {
          handleSelect(results[activeIndex]);
        } else if (results.length > 0) {
          handleSelect(results[0]);
        }
      }
    },
    [results, activeIndex, handleSelect, query, onClose],
  );

  // Scroll active item into view, in a layout effect to avoid DOM mutations during render.
  useLayoutEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const hasQuery = query.trim().length > 0;
  const showSkeleton = isSearching && results.length === 0;
  const showEmpty = messageSearchState === 'ready' && hasQuery && results.length === 0;
  const showResults = results.length > 0;

  const showSessionSkeleton = sessionSearchState === 'searching' && sessionResults.length === 0;
  const showSessionUnavailable = sessionSearchState === 'unavailable';
  const showSessionError = sessionSearchState === 'error';
  const showSessionEmpty = sessionSearchState === 'ready' && hasQuery && sessionResults.length === 0;
  const showSessionResults = sessionResults.length > 0;

  return (
    <div
      className={['chat-search', className].filter(Boolean).join(' ')}
      role="search"
      aria-label="Search chat history"
    >
      <div className="chat-search__input-row">
        <label htmlFor={inputId} className="chat-search__label gv-sr-only">
          Search chat history
        </label>
        <Search size={16} aria-hidden="true" className="chat-search__icon" />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          className="chat-search__input"
          placeholder="Find in your chats"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          role="combobox"
          autoComplete="off"
          aria-label="Search messages"
          aria-controls={listId}
          aria-activedescendant={
            activeIndex >= 0 ? `chat-search-result-${activeIndex}` : undefined
          }
          aria-autocomplete="list"
          aria-expanded={showResults || showSkeleton}
        />
        {(isSearching || sessionSearchState === 'searching') && (
          <span className="chat-search__spinner" aria-label="Searching…" role="status" />
        )}
        {onClose && (
          <IconButton size="sm" label="Close find" shortcut="Esc" icon={<X />} onClick={onClose} className="chat-search__close" />
        )}
      </div>
      {hint && <p className="chat-search__section-caption chat-search__hint">{hint}</p>}

      {hasQuery && (
        <section className="chat-search__section" aria-label="Sessions matching your search">
          <div className="chat-search__section-header">
            <div className="chat-search__section-heading">
              <h3 className="chat-search__section-title">Chats</h3>
              <p className="chat-search__section-caption">Titles, across all history</p>
            </div>
            <Toggle
              className="chat-search__closed-toggle"
              checked={includeClosed}
              onChange={setIncludeClosed}
              title="Also search closed and idle-reaped chats, titles and messages: hidden by default"
            >
              Include closed
            </Toggle>
          </div>

          {showSessionSkeleton && (
            <div className="chat-search__skeleton" aria-busy="true" aria-label="Searching sessions">
              <SkeletonBlock variant="text" lines={2} />
            </div>
          )}

          {showSessionUnavailable && (
            <EmptyState
              title="Search unavailable"
              description="The daemon did not serve session search, try again later."
              className="chat-search__empty"
            />
          )}

          {showSessionError && (
            <EmptyState
              title="Session search failed"
              description="Something went wrong searching sessions: try again."
              className="chat-search__empty"
            />
          )}

          {showSessionEmpty && (
            <EmptyState
              title="No sessions match"
              description={
                includeClosed
                  ? `No sessions match "${query}", including closed ones.`
                  : `No sessions match "${query}". Closed sessions are hidden, include them?`
              }
              action={includeClosed ? undefined : { label: 'Include closed sessions', onClick: () => setIncludeClosed(true) }}
              className="chat-search__empty"
            />
          )}

          {showSessionResults && (
            <ul className="chat-search__session-results" role="listbox" aria-label="Matching sessions">
              {sessionResults.map((result) => {
                const time = relativeTime(result.updatedAt);
                return (
                  <li
                    key={result.sessionId}
                    role="option"
                    aria-selected={false}
                    className="chat-search__session-result"
                    onClick={() => handleSelectSession(result)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectSession(result);
                      }
                    }}
                    tabIndex={0}
                  >
                    <span className="chat-search__session-result-title">{result.sessionTitle}</span>
                    <span className="chat-search__session-result-meta">
                      {result.status === 'closed' && <span className="chat-search__closed-chip">Closed</span>}
                      {time && <span className="chat-search__result-time">{time}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {hasMoreSessions && (
            <button
              type="button"
              className="chat-search__load-more"
              onClick={loadMoreSessions}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? 'Loading…' : 'Load more sessions'}
            </button>
          )}
          {loadMoreSessionsError && (
            <p className="chat-search__load-more-error" role="alert">{loadMoreSessionsError}</p>
          )}
        </section>
      )}

      {hasQuery && (
        <div className="chat-search__section-heading chat-search__section-heading--messages">
          <h3 className="chat-search__section-title chat-search__section-title--messages">Messages</h3>
          <p className="chat-search__section-caption">Text, across all chats</p>
        </div>
      )}

      {showSkeleton && (
        <div className="chat-search__skeleton" aria-busy="true" aria-label="Loading results">
          <SkeletonBlock variant="text" lines={3} />
        </div>
      )}

      {showEmpty && (
        <EmptyState
          title="No text matches"
          description={
            includeClosed
              ? `No messages match "${query}", including closed chats.`
              : `No messages match "${query}". Closed chats are not searched unless included.`
          }
          className="chat-search__empty"
        />
      )}

      {hasQuery && messageSearchState === 'unavailable' && (
        <EmptyState
          title="Message search unavailable"
          description="This daemon does not serve message search; update it to search message text."
          className="chat-search__empty"
        />
      )}

      {hasQuery && messageSearchState === 'error' && (
        <EmptyState
          title="Message search failed"
          description="The daemon did not answer the search: change the query or try again."
          className="chat-search__empty"
        />
      )}

      {showResults && (
        <ul
          ref={listRef}
          id={listId}
          className="chat-search__results"
          role="listbox"
          aria-label="Search results"
        >
          {results.map((result, index) => {
            const isActive = index === activeIndex;
            const time = relativeTime(result.createdAt);
            return (
              <li
                key={`${result.sessionId}-${result.messageId}-${index}`}
                id={`chat-search-result-${index}`}
                role="option"
                aria-selected={isActive}
                className={[
                  'chat-search__result',
                  isActive ? 'chat-search__result--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => handleSelect(result)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelect(result);
                  }
                }}
                tabIndex={0}
              >
                <div className="chat-search__result-meta">
                  <span className="chat-search__result-session">{result.sessionTitle}</span>
                  {time && (
                    <span className="chat-search__result-time" aria-label={`Posted ${time}`}>
                      {time}
                    </span>
                  )}
                </div>
                <p className="chat-search__result-snippet">{result.snippet}</p>
              </li>
            );
          })}
        </ul>
      )}

      {hasQuery && hasMoreResults && (
        <button
          type="button"
          className="chat-search__load-more"
          onClick={loadMoreResults}
          disabled={isLoadingMoreResults}
        >
          {isLoadingMoreResults ? 'Loading…' : 'Load more messages'}
        </button>
      )}
      {hasQuery && loadMoreResultsError && (
        <p className="chat-search__load-more-error" role="alert">{loadMoreResultsError}</p>
      )}
    </div>
  );
}
