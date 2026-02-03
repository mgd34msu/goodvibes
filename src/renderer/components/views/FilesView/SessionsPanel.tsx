// ============================================================================
// SESSIONS PANEL COMPONENT
// Shows sessions for a directory with split view: list + preview
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageSquare, X, GripHorizontal, Terminal } from 'lucide-react';
import { clsx } from 'clsx';
import { SessionPreviewView } from '../../preview/SessionPreviewView';

interface SessionsPanelProps {
  sessions: Array<{
    sessionId: string;
    cwd: string;
    messageCount: number;
    costUsd: number;
    startedAt: string;
    lastActive: string;
    firstPrompt?: string;
    tokenCount?: number;
  }>;
  onClose: () => void;
  onOpenInCLI?: (sessionId: string, cwd: string) => void;
}

/**
 * Local formatters for SessionsPanel
 * 
 * Note: These are intentionally different from shared/utils.ts formatters:
 * - formatDateTime: Shows full date + recency (e.g., "February 2nd 2026 10:09PM (4 minutes ago)")
 * - formatCost: Shows "—" for zero instead of "$0.00"
 * - formatTokens: Shows "—" for zero instead of "0"
 * 
 * This provides a more user-friendly display in the sessions context.
 */

/**
 * Format date/time in a human-readable way
 * Returns: "February 2nd 2026 10:09PM (4 minutes ago)"
 */
function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // Format full date/time: "February 2nd 2026 10:09PM"
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, '0');
  
  // Add ordinal suffix to day
  const getOrdinal = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  };
  
  const fullDateTime = `${month} ${day}${getOrdinal(day)} ${year} ${displayHours}:${displayMinutes}${ampm}`;
  
  // Format recency
  let recency: string;
  if (diffMins < 1) {
    recency = 'just now';
  } else if (diffMins < 60) {
    recency = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    recency = `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else if (diffDays < 7) {
    recency = `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  } else {
    recency = `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) === 1 ? '' : 's'} ago`;
  }
  
  return `${fullDateTime} (${recency})`;
}

/**
 * Format cost as currency
 */
function formatCost(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd) || usd <= 0) return '—';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Format token count with K/M suffixes
 */
function formatTokens(count: number | null | undefined): string {
  if (count == null || isNaN(count) || count <= 0) return '—';
  if (count < 1000) return count.toString();
  if (count < 1000000) return `${(count / 1000).toFixed(1)}K`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function SessionsPanel({ sessions, onClose, onOpenInCLI }: SessionsPanelProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [listHeight, setListHeight] = useState(20); // percentage
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  // Sort sessions by date (newest first)
  const sortedSessions = [...sessions].sort((a, b) => {
    return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
  });

  // Wrap handlers in useCallback to prevent stale closures in cleanup
  const handleDragMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newHeight = ((e.clientY - rect.top) / rect.height) * 100;
    setListHeight(Math.min(50, Math.max(10, newHeight)));
  }, []);

  const handleDragEnd = useCallback(() => {
    isDragging.current = false;
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
  }, [handleDragMove]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  }, [handleDragMove, handleDragEnd]);

  // Cleanup event listeners on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      // Cleanup any lingering event listeners on unmount
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, [handleDragMove, handleDragEnd]);

  const handleSessionClick = (sessionId: string) => {
    setSelectedSessionId(sessionId);
  };

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-surface-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700 bg-surface-800">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">Sessions</h3>
          <span className="text-xs text-surface-500">({sessions.length})</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
          title="Close sessions panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Sessions List - Table */}
      <div className="overflow-y-auto" style={{ flex: `0 0 ${listHeight}%` }}>
        {sortedSessions.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-surface-500 text-sm">
            No sessions found
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-surface-800 sticky top-0 z-10">
              <tr className="text-xs text-surface-400 border-b border-surface-700">
                <th className="px-4 py-2 text-left font-medium">Session</th>
                <th className="px-4 py-2 text-left font-medium">Date & Time</th>
                <th className="px-4 py-2 text-left font-medium">Messages</th>
                <th className="px-4 py-2 text-left font-medium">Tokens</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {sortedSessions.map((session) => {
                const isSelected = selectedSessionId === session.sessionId;
                return (
                  <tr
                    key={session.sessionId}
                    onClick={() => handleSessionClick(session.sessionId)}
                    className={clsx(
                      'cursor-pointer transition-colors',
                      isSelected
                        ? 'bg-primary-600/20'
                        : 'hover:bg-surface-800'
                    )}
                  >
                    <td className="px-4 py-2 text-sm text-surface-300 font-mono">
                      {session.sessionId.substring(0, 7)}
                    </td>
                    <td className="px-4 py-2 text-sm text-surface-200">
                      {formatDateTime(session.lastActive)}
                    </td>
                    <td className="px-4 py-2 text-sm text-surface-300">
                      {session.messageCount}
                    </td>
                    <td className="px-4 py-2 text-sm text-surface-300 font-mono">
                      {formatTokens(session.tokenCount)}
                    </td>
                    <td className="px-4 py-2 text-sm text-right text-warning-300 font-mono">
                      {formatCost(session.costUsd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Resizable Divider */}
      <div
        className="h-1.5 bg-surface-700/50 hover:bg-primary-500/50 cursor-row-resize flex items-center justify-center group"
        onMouseDown={handleDragStart}
      >
        <GripHorizontal className="w-4 h-4 text-surface-500 group-hover:text-primary-400" />
      </div>

      {/* Session Preview */}
      <div className="flex-1 overflow-hidden border-t border-surface-700">
        {selectedSessionId ? (
          <div className="h-full flex flex-col">
            {/* Consolidated Session Preview Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-surface-700 bg-surface-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-surface-200">Session</span>
                <span className="text-sm font-mono text-primary-400">{selectedSessionId.substring(0, 7)}</span>
              </div>
              <div className="flex items-center gap-2">
                {onOpenInCLI && (
                  <button
                    onClick={() => {
                      const session = sortedSessions.find(s => s.sessionId === selectedSessionId);
                      if (session) {
                        onOpenInCLI(selectedSessionId, session.cwd);
                      }
                    }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium transition-colors"
                    title="Open this session in CLI"
                  >
                    <Terminal className="w-4 h-4" />
                    <span>Open with CLI</span>
                  </button>
                )}
              </div>
            </div>
            {/* Session Preview Content */}
            <div className="flex-1 overflow-hidden">
              <SessionPreviewView
                sessionId={selectedSessionId}
                sessionName={selectedSessionId.substring(0, 7)}
                hideHeader={true}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-surface-500 text-sm">
            Select a session to preview
          </div>
        )}
      </div>
    </div>
  );
}
