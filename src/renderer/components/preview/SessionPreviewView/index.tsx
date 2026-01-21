// ============================================================================
// SESSION PREVIEW VIEW - Read-only formatted session viewer
// Shows ALL entry types from Claude JSONL with expand/collapse functionality
// ============================================================================

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSettingsStore } from '../../../stores/settingsStore';
import { ErrorBoundary } from '../../common/ErrorBoundary';
import type { RawEntry, SessionPreviewViewProps } from './types';
import { parseAllEntries } from './utils';
import { EntryBlock } from './EntryBlock';
import { CountBadge } from './CountBadge';

export function SessionPreviewView({ sessionId, sessionName }: SessionPreviewViewProps): React.JSX.Element {
  const { settings } = useSettingsStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [globalExpanded, setGlobalExpanded] = useState<boolean | null>(null);

  // Validate sessionId early
  const validSessionId = sessionId && typeof sessionId === 'string' && sessionId.trim().length > 0;

  // Debug logging
  console.log('[SessionPreviewView] Render:', { sessionId, sessionName, validSessionId });

  // Query for raw session entries
  const { data: rawEntries = [], isLoading, error, refetch, isSuccess, isFetching } = useQuery({
    queryKey: ['session-raw-entries', sessionId],
    queryFn: async () => {
      console.log('[SessionPreviewView] queryFn called with sessionId:', sessionId);
      if (!validSessionId) {
        console.log('[SessionPreviewView] queryFn returning empty - invalid sessionId');
        return [];
      }
      try {
        const result = await window.goodvibes.getSessionRawEntries(sessionId);
        console.log('[SessionPreviewView] queryFn got result:', { count: result?.length ?? 0 });
        return result;
      } catch (err) {
        console.error('[SessionPreviewView] Failed to fetch raw entries:', err);
        throw err;
      }
    },
    enabled: validSessionId,
    refetchInterval: validSessionId ? 2000 : false,
    refetchIntervalInBackground: false,
  });

  // Debug query status
  console.log('[SessionPreviewView] Query status:', { isLoading, isFetching, isSuccess, error: error?.message, rawEntriesLength: rawEntries.length });

  // Query for live status
  const { data: isLive = false } = useQuery({
    queryKey: ['session-live', sessionId],
    queryFn: () => window.goodvibes.isSessionLive(sessionId),
    enabled: validSessionId,
    refetchInterval: validSessionId ? 5000 : false,
    refetchIntervalInBackground: false,
  });

  // Parse entries into structured messages
  const { entries, counts } = useMemo(() => {
    const result = parseAllEntries(rawEntries as RawEntry[]);
    console.log('[SessionPreviewView] Parsed entries:', {
      rawCount: rawEntries.length,
      parsedCount: result.entries.length,
      counts: result.counts
    });
    return result;
  }, [rawEntries]);

  // Filter entries based on visibility settings
  const visibleEntries = useMemo(() => {
    const result = entries.filter((entry) => {
      switch (entry.type) {
        case 'thinking':
          return settings.showThinkingBlocks;
        case 'tool_use':
          return settings.showToolUseBlocks;
        case 'tool_result':
          return settings.showToolResultBlocks;
        case 'system':
          return settings.showSystemBlocks;
        case 'summary':
          return settings.showSummaryBlocks;
        default:
          return true;
      }
    });
    console.log('[SessionPreviewView] Visible entries:', {
      inputCount: entries.length,
      visibleCount: result.length,
      entryTypes: entries.map(e => e.type),
      settings: {
        showThinkingBlocks: settings.showThinkingBlocks,
        showToolUseBlocks: settings.showToolUseBlocks,
        showToolResultBlocks: settings.showToolResultBlocks,
        showSystemBlocks: settings.showSystemBlocks,
        showSummaryBlocks: settings.showSummaryBlocks,
      }
    });
    return result;
  }, [entries, settings]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visibleEntries, autoScroll]);

  // Handle scroll to detect if user scrolled up
  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
      setAutoScroll(isAtBottom);
    }
  }, []);

  const handleExpandAll = () => setGlobalExpanded(true);
  const handleCollapseAll = () => setGlobalExpanded(false);
  const handleResetExpand = () => setGlobalExpanded(null);

  // Handle invalid sessionId
  if (!validSessionId) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-900">
        <div className="text-center">
          <div className="text-error-400 mb-2">Invalid session</div>
          <div className="text-surface-500 text-sm">Session ID is missing or invalid</div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    console.log('[SessionPreviewView] Returning loading state');
    return (
      <div style={{ height: '100%', minHeight: '200px', border: '5px solid blue', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1a2e' }}>
        <div style={{ color: 'white', fontSize: '20px' }}>Loading session... (DEBUG)</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-900">
        <div className="text-center">
          <div className="text-error-400 mb-2">Failed to load session</div>
          <div className="text-surface-500 text-sm">{error instanceof Error ? error.message : 'Unknown error'}</div>
        </div>
      </div>
    );
  }

  // CRITICAL DEBUG - force visible
  console.log('[SessionPreviewView] About to return main JSX');

  return (
    <div className="flex flex-col bg-surface-900 relative" style={{ height: '100%', minHeight: '200px', border: '5px solid red' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-700 bg-surface-850">
        <div className="flex items-center gap-2">
          <span className="text-surface-200 font-medium">{sessionName}</span>
          {isLive && (
            <span className="px-2 py-0.5 text-xs bg-success-500/20 text-success-400 rounded-full flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-success-400 rounded-full animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExpandAll}
            className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
            title="Expand All"
          >
            Expand All
          </button>
          <button
            onClick={handleCollapseAll}
            className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
            title="Collapse All"
          >
            Collapse All
          </button>
          {globalExpanded !== null && (
            <button
              onClick={handleResetExpand}
              className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
              title="Reset to Defaults"
            >
              Reset
            </button>
          )}
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-lg hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
            title="Refresh"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Entry Count Summary */}
      <div className="px-4 py-2 border-b border-surface-700 bg-surface-850/50 text-xs text-surface-400 flex flex-wrap gap-2">
        <span className="font-medium text-surface-300">{counts.total} entries:</span>
        {counts.user > 0 && <CountBadge type="user" count={counts.user} />}
        {counts.assistant > 0 && <CountBadge type="assistant" count={counts.assistant} />}
        {counts.tool_use > 0 && <CountBadge type="tool_use" count={counts.tool_use} />}
        {counts.tool_result > 0 && <CountBadge type="tool_result" count={counts.tool_result} />}
        {counts.thinking > 0 && <CountBadge type="thinking" count={counts.thinking} />}
        {counts.system > 0 && <CountBadge type="system" count={counts.system} />}
        {counts.summary > 0 && <CountBadge type="summary" count={counts.summary} />}
      </div>

      {/* DEBUG: Test render */}
      <div style={{ padding: '20px', backgroundColor: 'red', color: 'white', fontSize: '20px', fontWeight: 'bold' }}>
        DEBUG: {visibleEntries.length} visible entries, {entries.length} total entries, {rawEntries.length} raw entries, isLoading={String(isLoading)}
      </div>

      {/* Entries */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-4 space-y-3"
        onScroll={handleScroll}
      >
        <ErrorBoundary
          fallback={
            <div className="flex items-center justify-center h-full">
              <div className="text-center p-6 rounded-lg bg-error-500/10 border border-error-500/30">
                <p className="text-error-400 font-medium mb-2">Failed to render session entries</p>
                <p className="text-surface-400 text-sm">There was an error displaying the session content. Try refreshing.</p>
              </div>
            </div>
          }
          resetKeys={[sessionId]}
        >
          {visibleEntries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-surface-400">
              No entries to display
            </div>
          ) : (
            <>
              {console.log('[SessionPreviewView] Rendering', visibleEntries.length, 'entries')}
              {visibleEntries.map((entry) => {
                console.log('[SessionPreviewView] Rendering entry:', entry.id, entry.type, entry.content?.substring(0, 50));
                return (
                  <EntryBlock
                    key={entry.id}
                    entry={entry}
                    settings={settings}
                    globalExpanded={globalExpanded}
                  />
                );
              })}
            </>
          )}
        </ErrorBoundary>
      </div>

      {/* Scroll to bottom button */}
      {!autoScroll && (
        <button
          onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
            setAutoScroll(true);
          }}
          className="absolute bottom-4 right-4 p-2 bg-primary-500 text-white rounded-full shadow-lg hover:bg-primary-600 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
}

// Re-export types for convenience
export type { SessionPreviewViewProps } from './types';
