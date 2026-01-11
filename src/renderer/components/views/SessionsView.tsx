// ============================================================================
// SESSIONS VIEW COMPONENT - Unified Sessions + Monitor View
// ============================================================================

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { clsx } from 'clsx';
import type { Session, ActivityLogEntry } from '../../../shared/types';
import { SessionCardSkeleton } from '../common/Skeleton';
import { formatCost, formatNumber, formatRelativeTime, formatDuration, decodeProjectName, decodeProjectPath } from '../../../shared/utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAppStore } from '../../stores/appStore';
import { SessionDetailModal } from '../overlays/SessionDetailModal';

export default function SessionsView() {
  const { settings } = useSettingsStore();
  const [filter, setFilter] = useState<'all' | 'favorites' | 'archived'>('all');
  const [search, setSearch] = useState('');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  const { data: sessions = [], isLoading, error } = useQuery({
    queryKey: ['sessions', filter],
    queryFn: async () => {
      switch (filter) {
        case 'favorites':
          return await window.clausitron.getFavoriteSessions();
        case 'archived':
          return await window.clausitron.getArchivedSessions();
        default:
          return await window.clausitron.getActiveSessions();
      }
    },
  });

  // Query for live sessions to show indicator
  const { data: liveSessions = [] } = useQuery({
    queryKey: ['live-sessions'],
    queryFn: () => window.clausitron.getLiveSessions(),
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  const liveSessionIds = useMemo(() => new Set<string>(liveSessions.map((s: Session) => s.id)), [liveSessions]);

  // Filter sessions by search and hideAgentSessions setting
  const filteredSessions = useMemo(() => {
    let result = sessions;

    // Filter out agent sessions if hideAgentSessions is enabled
    if (settings.hideAgentSessions) {
      result = result.filter((s: Session) => !s.id.startsWith('agent-'));
    }

    // Filter by search term
    if (search.trim()) {
      const lower = search.toLowerCase();
      result = result.filter((s: Session) =>
        s.projectName?.toLowerCase().includes(lower) ||
        s.customTitle?.toLowerCase().includes(lower) ||
        s.summary?.toLowerCase().includes(lower)
      );
    }

    return result;
  }, [sessions, search, settings.hideAgentSessions]);

  return (
    <div className="flex h-full">
      {/* Left Panel - Sessions List (60%) */}
      <div className="flex flex-col w-[60%] min-w-0 border-r border-surface-700/50">
        {/* Sessions Header */}
        <div className="px-5 py-4 border-b border-surface-800 bg-surface-900/80 h-[68px] flex items-center">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-4">
              <h2 className="text-lg font-semibold text-surface-100">Session History</h2>
              {/* Filter tabs - inline with title */}
              <div className="flex items-center gap-1.5">
                {(['all', 'favorites', 'archived'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={clsx(
                      'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors',
                      filter === f
                        ? 'bg-primary-500/20 text-primary-400'
                        : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200'
                    )}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="text"
              placeholder="Search sessions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input w-56 text-sm"
            />
          </div>
        </div>

        {/* Sessions Content */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState error={error} />
        ) : filteredSessions.length === 0 ? (
          <EmptyState filter={filter} search={search} />
        ) : (
          <VirtualSessionList
            sessions={filteredSessions}
            projectsRoot={settings.projectsRoot}
            liveSessionIds={liveSessionIds}
            onSessionClick={setSelectedSession}
          />
        )}
      </div>

      {/* Right Panel - Monitor (40%) */}
      <div className="w-[40%] min-w-0 bg-surface-950/50">
        <MonitorPanel projectsRoot={settings.projectsRoot} />
      </div>

      {/* Session Detail Modal */}
      {selectedSession && (
        <SessionDetailModal
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// MONITOR PANEL - Right side of the split view
// ============================================================================

interface MonitorPanelProps {
  projectsRoot: string | null;
}

function MonitorPanel({ projectsRoot }: MonitorPanelProps) {
  const terminalCount = useTerminalStore((s) => s.terminals.size);
  const [appUptime, setAppUptime] = useState(0);

  const { data: liveSessions = [] } = useQuery<Session[]>({
    queryKey: ['live-sessions'],
    queryFn: () => window.clausitron.getLiveSessions(),
    refetchInterval: 5000,
  });

  const { data: activity = [] } = useQuery<ActivityLogEntry[]>({
    queryKey: ['activity'],
    queryFn: () => window.clausitron.getRecentActivity(15),
    refetchInterval: 10000,
  });

  const { data: analytics } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => window.clausitron.getAnalytics(),
    refetchInterval: 30000,
  });

  // Get today's message count from analytics
  const todayMessageCount = analytics?.messagesToday ?? 0;

  // Track app uptime
  useEffect(() => {
    const interval = setInterval(() => {
      setAppUptime((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Monitor Header */}
      <div className="px-5 py-4 border-b border-surface-800 bg-surface-900/80 h-[68px] flex items-center">
        <div className="flex items-center justify-between w-full">
          <h2 className="text-lg font-semibold text-surface-100">Live Monitor</h2>
          {terminalCount > 0 ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success-500/10 border border-success-500/20">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success-500"></span>
              </span>
              <span className="text-xs font-medium text-success-400">{terminalCount} active</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-800 border border-surface-700">
              <span className="relative flex h-2 w-2">
                <span className="relative inline-flex rounded-full h-2 w-2 bg-surface-500"></span>
              </span>
              <span className="text-xs text-surface-400">Idle</span>
            </div>
          )}
        </div>
      </div>

      {/* Content Area - flex column to allow activity feed to grow */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Fixed content - Metrics and Live Sessions */}
        <div className="flex-shrink-0 p-4 space-y-4">
          {/* Metrics Row - Compact 2x2 grid */}
          <div className="grid grid-cols-2 gap-2">
            <CompactMetricCard
              icon="🖥️"
              value={terminalCount.toString()}
              label="Terminals"
              accentColor="primary"
            />
            <CompactMetricCard
              icon="📊"
              value={liveSessions.length.toString()}
              label="Live Sessions"
              accentColor="accent"
            />
            <CompactMetricCard
              icon="📨"
              value={todayMessageCount.toString()}
              label="Today"
              accentColor="success"
            />
            <CompactMetricCard
              icon="⏱️"
              value={formatDuration(appUptime)}
              label="Uptime"
              accentColor="warning"
            />
          </div>

          {/* Live Sessions - Only show if there are any */}
          {liveSessions.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-surface-200">Live Sessions</h3>
                <span className="text-xs text-surface-500 bg-surface-800 px-1.5 py-0.5 rounded">
                  {liveSessions.length}
                </span>
              </div>
              <div className="space-y-2">
                {liveSessions.slice(0, 4).map((session) => (
                  <CompactLiveSessionCard key={session.id} session={session} projectsRoot={projectsRoot} />
                ))}
                {liveSessions.length > 4 && (
                  <p className="text-xs text-surface-500 text-center py-1">
                    +{liveSessions.length - 4} more sessions
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Activity Feed - grows to fill remaining space */}
        <div className="flex-1 flex flex-col min-h-0 px-4 pb-4">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <h3 className="text-sm font-semibold text-surface-200">Activity Feed</h3>
            {activity.length > 0 && (
              <span className="text-xs text-surface-500 bg-surface-800 px-1.5 py-0.5 rounded">
                {activity.length}
              </span>
            )}
          </div>
          <div className="flex-1 rounded-lg overflow-hidden border border-surface-800/80 bg-surface-900/50 min-h-0">
            {activity.length === 0 ? (
              <div className="py-8 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-surface-800 flex items-center justify-center">
                  <span className="text-lg">📋</span>
                </div>
                <p className="text-xs text-surface-400">No recent activity</p>
              </div>
            ) : (
              <div className="divide-y divide-surface-800/50 h-full overflow-auto">
                {activity.map((entry) => (
                  <CompactActivityItem key={entry.id} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// COMPACT METRIC CARD
// ============================================================================

type AccentColor = 'primary' | 'accent' | 'success' | 'warning' | 'error';

const accentColorClasses: Record<AccentColor, string> = {
  primary: 'bg-primary-500/10 text-primary-400',
  accent: 'bg-accent-500/10 text-accent-400',
  success: 'bg-success-500/10 text-success-400',
  warning: 'bg-warning-500/10 text-warning-400',
  error: 'bg-error-500/10 text-error-400',
};

function CompactMetricCard({ icon, value, label, accentColor = 'primary' }: {
  icon: string;
  value: string;
  label: string;
  accentColor?: AccentColor
}) {
  return (
    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-surface-900/80 border border-surface-800/60">
      <div className={clsx(
        'w-8 h-8 rounded-md flex items-center justify-center text-base flex-shrink-0',
        accentColorClasses[accentColor]
      )}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-surface-100 truncate">{value}</div>
        <div className="text-xs text-surface-500 truncate">{label}</div>
      </div>
    </div>
  );
}

// ============================================================================
// COMPACT LIVE SESSION CARD
// ============================================================================

function CompactLiveSessionCard({ session, projectsRoot }: { session: Session; projectsRoot: string | null }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-900/60 border border-surface-800/60 hover:bg-surface-800/40 transition-colors">
      <span className="relative flex h-2 w-2 flex-shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-success-500"></span>
      </span>
      <span className="text-sm font-medium text-surface-200 truncate flex-1">
        {decodeProjectName(session.projectName, projectsRoot)}
      </span>
      <span className="text-xs text-surface-500 flex-shrink-0">
        {session.messageCount} msgs
      </span>
    </div>
  );
}

// ============================================================================
// COMPACT ACTIVITY ITEM
// ============================================================================

function CompactActivityItem({ entry }: { entry: ActivityLogEntry }) {
  // Parse metadata to extract project name if available
  let projectName: string | null = null;
  if (entry.metadata) {
    try {
      const metadata = typeof entry.metadata === 'string'
        ? JSON.parse(entry.metadata)
        : entry.metadata;
      if (metadata?.projectName) {
        projectName = decodeProjectName(metadata.projectName);
      }
    } catch {
      // Ignore parse errors
    }
  }

  const { icon, bgColor } = getActivityIconConfig(entry.type);

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-surface-800/30 transition-colors">
      <div className={clsx(
        'w-7 h-7 rounded-md flex items-center justify-center text-sm flex-shrink-0',
        bgColor
      )}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-surface-300 leading-snug line-clamp-2">{entry.description}</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-2xs text-surface-500">{formatRelativeTime(entry.timestamp)}</span>
          {projectName && (
            <>
              <span className="text-surface-600">&#8226;</span>
              <span className="text-2xs text-surface-400 truncate">{projectName}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function getActivityIconConfig(type: string): { icon: string; bgColor: string } {
  switch (type) {
    case 'terminal_start':
      return { icon: '▶️', bgColor: 'bg-success-500/10' };
    case 'terminal_end':
      return { icon: '⏹️', bgColor: 'bg-surface-700' };
    case 'session_start':
      return { icon: '▶️', bgColor: 'bg-primary-500/10' };
    case 'session_end':
      return { icon: '⏹️', bgColor: 'bg-surface-700' };
    case 'session_detected':
      return { icon: '🔍', bgColor: 'bg-accent-500/10' };
    case 'message':
      return { icon: '💬', bgColor: 'bg-primary-500/10' };
    case 'tool_use':
      return { icon: '🔧', bgColor: 'bg-warning-500/10' };
    case 'error':
      return { icon: '❌', bgColor: 'bg-error-500/10' };
    default:
      return { icon: '📌', bgColor: 'bg-surface-700' };
  }
}

// ============================================================================
// VIRTUAL SESSION LIST
// ============================================================================

interface VirtualSessionListProps {
  sessions: Session[];
  projectsRoot: string | null;
  liveSessionIds: Set<string>;
  onSessionClick: (session: Session) => void;
}

// Fixed card height (card padding 16px*2 + content ~56px + gap 8px = 96px)
const CARD_HEIGHT = 96;
const CARD_GAP = 8;

function VirtualSessionList({ sessions, projectsRoot, liveSessionIds, onSessionClick }: VirtualSessionListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT + CARD_GAP,
    overscan: 5,
    // No measureElement - using fixed heights for uniform spacing
  });

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-auto px-5 py-4"
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const session = sessions[virtualItem.index];
          if (!session) return null;
          return (
            <div
              key={session.id}
              className="absolute top-0 left-0 w-full"
              style={{
                height: `${CARD_HEIGHT}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <SessionCard
                session={session}
                projectsRoot={projectsRoot}
                isLive={liveSessionIds.has(session.id)}
                onClick={() => onSessionClick(session)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// SESSION CARD
// ============================================================================

interface SessionCardProps {
  session: Session;
  projectsRoot: string | null;
  isLive: boolean;
  onClick: () => void;
}

function SessionCard({ session, projectsRoot, isLive, onClick }: SessionCardProps) {
  const { createPreviewTerminal, createTerminal } = useTerminalStore();
  const { setCurrentView } = useAppStore();
  const queryClient = useQueryClient();

  const handleToggleFavorite = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await window.clausitron.toggleFavorite(session.id);
    // Invalidate session queries to refresh the UI
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }, [session.id, queryClient]);

  const handleToggleArchive = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await window.clausitron.toggleArchive(session.id);
    // Invalidate session queries to refresh the UI
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }, [session.id, queryClient]);

  const displayName = session.customTitle || decodeProjectName(session.projectName, projectsRoot);

  // Quick action: Open Preview
  const handleOpenPreview = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const cwd = decodeProjectPath(session.projectName) || undefined;
    createPreviewTerminal(session.id, displayName, cwd);
    setCurrentView('terminal');
  }, [session.id, session.projectName, displayName, createPreviewTerminal, setCurrentView]);

  // Quick action: Open in CLI (Resume Session)
  const handleOpenCLI = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const cwd = decodeProjectPath(session.projectName) || undefined;
    await createTerminal(cwd, displayName, session.id);
    setCurrentView('terminal');
  }, [session.id, session.projectName, displayName, createTerminal, setCurrentView]);

  return (
    <div className="card-hover cursor-pointer h-full overflow-hidden" onClick={onClick}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {/* Live indicator */}
            {isLive && (
              <span className="relative flex h-2 w-2 flex-shrink-0" title="Session is live">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success-500"></span>
              </span>
            )}
            <h3 className="text-sm font-medium text-surface-100 truncate">
              {displayName}
            </h3>
            {session.favorite && (
              <span className="text-warning-400 flex-shrink-0">&#9733;</span>
            )}
            {/* Agent badge */}
            {session.id.startsWith('agent-') && (
              <span className="badge text-xs bg-accent-500/20 text-accent-400 flex-shrink-0">agent</span>
            )}
            {/* Outcome badge - inline for consistent height */}
            {session.outcome && (
              <span className={clsx(
                'badge text-xs flex-shrink-0',
                session.outcome === 'success' && 'badge-success',
                session.outcome === 'partial' && 'badge-warning',
                session.outcome === 'failed' && 'badge-error',
                session.outcome === 'abandoned' && 'text-surface-500 bg-surface-700'
              )}>
                {session.outcome}
              </span>
            )}
            {session.rating && (
              <span className="badge badge-primary text-xs flex-shrink-0">
                {'★'.repeat(session.rating)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4 text-xs text-surface-500">
            <span>{formatRelativeTime(session.endTime)}</span>
            <span>{session.messageCount} messages</span>
            <span>{formatNumber(session.tokenCount)} tokens</span>
            <span>{formatCost(session.cost)}</span>
            {session.summary && (
              <span className="truncate text-surface-400" title={session.summary}>
                {session.summary}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Quick action buttons */}
          <button
            onClick={handleOpenPreview}
            className="p-1.5 rounded-lg text-surface-500 hover:text-primary-400 hover:bg-surface-700 transition-colors"
            title="Open Preview"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <button
            onClick={handleOpenCLI}
            className="p-1.5 rounded-lg text-surface-500 hover:text-success-400 hover:bg-surface-700 transition-colors"
            title="Open in CLI"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
          <button
            onClick={handleToggleFavorite}
            className="p-1.5 rounded-lg text-surface-500 hover:text-warning-400 hover:bg-surface-700 transition-colors"
            title={session.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <svg className="w-4 h-4" fill={session.favorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          </button>
          <button
            onClick={handleToggleArchive}
            className="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700 transition-colors"
            title={session.archived ? 'Unarchive' : 'Archive'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
          </button>
        </div>
      </div>

    </div>
  );
}

// ============================================================================
// LOADING SKELETON
// ============================================================================

function LoadingSkeleton() {
  return (
    <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <SessionCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================

function EmptyState({ filter, search }: { filter: string; search: string }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-4">📋</div>
        <h2 className="text-lg font-semibold text-surface-100 mb-2">
          {search ? 'No matching sessions' : `No ${filter === 'all' ? '' : filter} sessions`}
        </h2>
        <p className="text-sm text-surface-400">
          {search
            ? 'Try a different search term'
            : filter === 'favorites'
            ? 'Star sessions to add them to favorites'
            : filter === 'archived'
            ? 'Archived sessions will appear here'
            : 'Start a new Claude session to see it here'}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// ERROR STATE
// ============================================================================

function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-4">😕</div>
        <h2 className="text-lg font-semibold text-surface-100 mb-2">Failed to load sessions</h2>
        <p className="text-sm text-surface-400 mb-4">
          {error instanceof Error ? error.message : 'An unexpected error occurred'}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="btn btn-secondary"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
