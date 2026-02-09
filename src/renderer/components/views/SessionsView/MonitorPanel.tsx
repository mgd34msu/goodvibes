// ============================================================================
// MONITOR PANEL - Right side of the split view
// ============================================================================

import { useQuery } from '@tanstack/react-query';
import { useResolvedProjectName } from '../../../hooks/useResolvedProjectName';
import { clsx } from 'clsx';
import type {
  MonitorPanelProps,
  CompactMetricCardProps,
  CompactLiveSessionCardProps,
  CompactActivityItemProps,
  Session,
  ActivityLogEntry,
  AccentColor,
} from './types';
import { useAppUptime } from './hooks';
import { formatDuration, formatRelativeTime } from '../../../../shared/utils';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useSettingsStore } from '../../../stores/settingsStore';

// ============================================================================
// MONITOR PANEL
// ============================================================================

export function MonitorPanel({ projectsRoot, onSessionClick, onActivityClick }: MonitorPanelProps): React.JSX.Element {
  const terminalCount = useTerminalStore((s) => s.terminals.size);
  const appUptime = useAppUptime();

  const { data: liveSessions = [] } = useQuery<Session[]>({
    queryKey: ['live-sessions'],
    queryFn: () => window.goodvibes.getLiveSessions(),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  const { data: activity = [] } = useQuery<ActivityLogEntry[]>({
    queryKey: ['activity'],
    queryFn: () => window.goodvibes.getRecentActivity(15),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });

  const { data: analytics } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => window.goodvibes.getAnalytics(),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  // Get today's message count from analytics
  const todayMessageCount = analytics?.messagesToday ?? 0;

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
              icon="screen"
              value={terminalCount.toString()}
              label="Terminals"
              accentColor="primary"
            />
            <CompactMetricCard
              icon="chart"
              value={liveSessions.length.toString()}
              label="Live Sessions"
              accentColor="accent"
            />
            <CompactMetricCard
              icon="mail"
              value={todayMessageCount.toString()}
              label="Today"
              accentColor="success"
            />
            <CompactMetricCard
              icon="clock"
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
                  <CompactLiveSessionCard
                    key={session.id}
                    session={session}
                    projectsRoot={projectsRoot}
                    onClick={() => onSessionClick(session)}
                  />
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
                  <span className="text-lg">clipboard</span>
                </div>
                <p className="text-xs text-surface-400">No recent activity</p>
              </div>
            ) : (
              <div className="divide-y divide-surface-800/50 h-full overflow-auto">
                {activity.map((entry) => (
                  <CompactActivityItem
                    key={entry.id}
                    entry={entry}
                    onClick={entry.sessionId && onActivityClick ? () => onActivityClick(entry.sessionId!) : undefined}
                  />
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

const accentColorClasses: Record<AccentColor, string> = {
  primary: 'bg-primary-500/10 text-primary-400',
  accent: 'bg-accent-500/10 text-accent-400',
  success: 'bg-success-500/10 text-success-400',
  warning: 'bg-warning-500/10 text-warning-400',
  error: 'bg-error-500/10 text-error-400',
};

const iconMap: Record<string, string> = {
  screen: '\uD83D\uDCBB',
  chart: '\uD83D\uDCCA',
  mail: '\uD83D\uDCE8',
  clock: '\u23F1\uFE0F',
  clipboard: '\uD83D\uDCCB',
};

function CompactMetricCard({
  icon,
  value,
  label,
  accentColor = 'primary',
}: CompactMetricCardProps) {
  const iconChar = iconMap[icon] || icon;
  return (
    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-surface-900/80 border border-surface-800/60">
      <div
        className={clsx(
          'w-8 h-8 rounded-md flex items-center justify-center text-base flex-shrink-0',
          accentColorClasses[accentColor]
        )}
      >
        {iconChar}
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

function CompactLiveSessionCard({ session, projectsRoot, onClick }: CompactLiveSessionCardProps) {
  const displayName = useResolvedProjectName(session.projectName, projectsRoot);
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-900/60 border border-surface-800/60 hover:bg-surface-800/40 transition-colors cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className="relative flex h-2 w-2 flex-shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-success-500"></span>
      </span>
      <span className="text-sm font-medium text-surface-200 truncate flex-1">
        {displayName}
      </span>
      <span className="text-xs text-surface-500 flex-shrink-0">{session.messageCount} msgs</span>
    </div>
  );
}

// ============================================================================
// COMPACT ACTIVITY ITEM
// ============================================================================

function CompactActivityItem({ entry, onClick }: CompactActivityItemProps) {
  // Parse metadata to extract encoded project name if available
  let encodedProjectName: string | null = null;
  if (entry.metadata) {
    try {
      const metadata =
        typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : entry.metadata;
      if (metadata?.projectName) {
        encodedProjectName = metadata.projectName;
      }
    } catch {
      // Ignore parse errors
    }
  }

  const { settings } = useSettingsStore();
  const projectName = useResolvedProjectName(encodedProjectName, settings.projectsRoot);

  const { icon, bgColor } = getActivityIconConfig(entry.type);
  const isClickable = !!onClick;

  return (
    <div
      className={clsx(
        'flex items-start gap-2.5 px-3 py-2.5 hover:bg-surface-800/30 transition-colors',
        isClickable && 'cursor-pointer'
      )}
      onClick={onClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div
        className={clsx(
          'w-7 h-7 rounded-md flex items-center justify-center text-sm flex-shrink-0',
          bgColor
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-surface-300 leading-snug line-clamp-2">{entry.description}</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-2xs text-surface-500">{formatRelativeTime(entry.timestamp)}</span>
          {encodedProjectName && (
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
      return { icon: '\u25B6\uFE0F', bgColor: 'bg-success-500/10' };
    case 'terminal_end':
      return { icon: '\u23F9\uFE0F', bgColor: 'bg-surface-700' };
    case 'session_start':
      return { icon: '\u25B6\uFE0F', bgColor: 'bg-primary-500/10' };
    case 'session_end':
      return { icon: '\u23F9\uFE0F', bgColor: 'bg-surface-700' };
    case 'session_detected':
      return { icon: '\uD83D\uDD0D', bgColor: 'bg-accent-500/10' };
    case 'message':
      return { icon: '\uD83D\uDCAC', bgColor: 'bg-primary-500/10' };
    case 'tool_use':
      return { icon: '\uD83D\uDD27', bgColor: 'bg-warning-500/10' };
    case 'error':
      return { icon: '\u274C', bgColor: 'bg-error-500/10' };
    default:
      return { icon: '\uD83D\uDCCC', bgColor: 'bg-surface-700' };
  }
}
