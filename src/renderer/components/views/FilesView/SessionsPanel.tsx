// ============================================================================
// SESSIONS PANEL COMPONENT
// Shows sessions for a directory with split view: list + preview
// ============================================================================

import { useState, useRef } from 'react';
import { MessageSquare, Coins, Clock, X, GripHorizontal, Calendar } from 'lucide-react';
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
}

/**
 * Format date/time in a human-readable way
 */
function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // If less than 1 minute ago
  if (diffMins < 1) return 'Just now';
  // If less than 1 hour ago
  if (diffMins < 60) return `${diffMins}m ago`;
  // If less than 24 hours ago
  if (diffHours < 24) return `${diffHours}h ago`;
  // If less than 7 days ago
  if (diffDays < 7) return `${diffDays}d ago`;
  
  // Otherwise show date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Format cost as currency
 */
function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Format token count with K/M suffixes
 */
function formatTokens(count: number | undefined): string {
  if (!count) return '0';
  if (count < 1000) return count.toString();
  if (count < 1000000) return `${(count / 1000).toFixed(1)}K`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function SessionsPanel({ sessions, onClose }: SessionsPanelProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [listHeight, setListHeight] = useState(50); // percentage
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  // Sort sessions by date (newest first)
  const sortedSessions = [...sessions].sort((a, b) => {
    return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
  });

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  };

  const handleDragMove = (e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newHeight = ((e.clientY - rect.top) / rect.height) * 100;
    setListHeight(Math.min(80, Math.max(20, newHeight)));
  };

  const handleDragEnd = () => {
    isDragging.current = false;
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
  };

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

      {/* Sessions List */}
      <div className="overflow-y-auto" style={{ flex: `0 0 ${listHeight}%` }}>
        {sortedSessions.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-surface-500 text-sm">
            No sessions found
          </div>
        ) : (
          <div className="divide-y divide-surface-700/50">
            {sortedSessions.map((session) => {
              const isSelected = selectedSessionId === session.sessionId;
              return (
                <button
                  key={session.sessionId}
                  onClick={() => handleSessionClick(session.sessionId)}
                  className={clsx(
                    'w-full px-4 py-3 text-left transition-colors',
                    isSelected
                      ? 'bg-primary-600/20 border-l-2 border-primary-400'
                      : 'hover:bg-surface-800 border-l-2 border-transparent'
                  )}
                >
                  {/* First line: Date and cost */}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Calendar className="w-3.5 h-3.5 text-surface-400" />
                      <span className={clsx(
                        'font-medium',
                        isSelected ? 'text-primary-300' : 'text-surface-200'
                      )}>
                        {formatDateTime(session.lastActive)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-xs">
                      <Coins className="w-3 h-3 text-warning-400" />
                      <span className="text-warning-300 font-mono">
                        {formatCost(session.costUsd)}
                      </span>
                    </div>
                  </div>

                  {/* Second line: Stats */}
                  <div className="flex items-center gap-4 text-xs text-surface-400">
                    <div className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />
                      <span>{session.messageCount} messages</span>
                    </div>
                    {session.tokenCount && (
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>{formatTokens(session.tokenCount)} tokens</span>
                      </div>
                    )}
                  </div>

                  {/* Third line: First prompt preview */}
                  {session.firstPrompt && (
                    <div className="mt-1.5 text-xs text-surface-500 truncate">
                      {session.firstPrompt}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
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
          <SessionPreviewView
            sessionId={selectedSessionId}
            sessionName={`Session ${sortedSessions.findIndex(s => s.sessionId === selectedSessionId) + 1}`}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-surface-500 text-sm">
            Select a session to preview
          </div>
        )}
      </div>
    </div>
  );
}
