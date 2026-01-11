// ============================================================================
// ANALYTICS VIEW COMPONENT
// ============================================================================

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { Analytics, ToolUsageStat } from '../../../shared/types';
import { formatNumber, formatCost, formatDate, decodeProjectName } from '../../../shared/utils';
import { AnalyticsCardSkeleton } from '../common/Skeleton';
import { toast } from '../../stores/toastStore';
import { useSettingsStore } from '../../stores/settingsStore';

export default function AnalyticsView() {
  const { settings } = useSettingsStore();

  const { data: analytics, isLoading } = useQuery<Analytics>({
    queryKey: ['analytics'],
    queryFn: () => window.clausitron.getAnalytics(),
  });

  const { data: toolUsage } = useQuery<ToolUsageStat[]>({
    queryKey: ['tool-usage'],
    queryFn: () => window.clausitron.getToolUsage(),
  });

  const handleGenerateReport = async () => {
    try {
      const reportData = {
        generatedAt: new Date().toISOString(),
        summary: {
          totalSessions: analytics?.totalSessions ?? 0,
          totalTokens: analytics?.totalTokens ?? 0,
          totalCost: analytics?.totalCost ?? 0,
          avgTokensPerSession: analytics?.avgTokensPerSession ?? 0,
        },
        costByProject: analytics?.costByProject ?? {},
        toolUsage: toolUsage ?? [],
      };

      const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clausitron-report-${formatDate(new Date().toISOString()).replace(/[,\s]+/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success('Report exported successfully');
    } catch (error) {
      toast.error('Failed to export report');
    }
  };

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-surface-100">Analytics Dashboard</h1>
          <button
            onClick={handleGenerateReport}
            className="btn btn-primary"
          >
            Export Report
          </button>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Total Sessions"
            value={formatNumber(analytics?.totalSessions ?? 0)}
            icon="📊"
          />
          <StatCard
            title="Total Tokens"
            value={formatNumber(analytics?.totalTokens ?? 0)}
            icon="🔤"
          />
          <StatCard
            title="Total Cost"
            value={formatCost(analytics?.totalCost ?? 0)}
            icon="💰"
          />
          <StatCard
            title="Avg Tokens/Session"
            value={formatNumber(analytics?.avgTokensPerSession ?? 0)}
            icon="📈"
          />
        </div>

        {/* Charts Row */}
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Cost Over Time */}
          <div className="card p-6 overflow-visible">
            <h3 className="text-sm font-medium text-surface-100 mb-4">Cost Over Time (Last 30 Days)</h3>
            <CostChart data={analytics?.sessionsOverTime ?? []} />
          </div>

          {/* Cost by Project */}
          <div className="card p-6">
            <h3 className="text-sm font-medium text-surface-100 mb-4">Cost by Project</h3>
            <CostByProject data={analytics?.costByProject ?? {}} projectsRoot={settings.projectsRoot} />
          </div>
        </div>

        {/* Tool Usage & Activity Heatmap Row - Tool usage expands, heatmap is compact */}
        <div className="flex gap-6">
          {/* Tool Usage - takes remaining space */}
          <div className="card p-6 flex-1 min-w-0">
            <h3 className="text-sm font-medium text-surface-100 mb-4">Tool Usage</h3>
            <ToolUsageGrid data={toolUsage ?? []} />
          </div>

          {/* Activity Heatmap - compact width to fit content */}
          <div className="card p-6 shrink-0">
            <h3 className="text-sm font-medium text-surface-100 mb-4">Activity Heatmap (Last 12 Weeks)</h3>
            <ActivityHeatmap data={analytics?.sessionsOverTime ?? []} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// STAT CARD
// ============================================================================

function StatCard({ title, value, icon }: { title: string; value: string; icon: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div>
          <div className="text-2xl font-bold text-surface-100">{value}</div>
          <div className="text-xs text-surface-500">{title}</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// COST CHART
// ============================================================================

function CostChart({ data }: { data: Array<{ date: string; cost: number }> }) {
  const [tooltip, setTooltip] = React.useState<{ date: string; cost: number; x: number; y: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  if (data.length === 0) {
    return <EmptyChartState message="No data available" />;
  }

  const maxCost = Math.max(...data.map(d => d.cost), 0.01);

  const handleMouseEnter = (day: { date: string; cost: number }, e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setTooltip({
        date: day.date,
        cost: day.cost,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  const handleMouseMove = (day: { date: string; cost: number }, e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setTooltip({
        date: day.date,
        cost: day.cost,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
  };

  return (
    <div ref={containerRef} className="h-48 flex items-end gap-1 relative overflow-visible">
      {data.slice(-30).map((day) => (
        <div
          key={day.date}
          className="flex-1 bg-primary-500/20 hover:bg-primary-500/40 rounded-t transition-colors cursor-pointer"
          style={{ height: `${(day.cost / maxCost) * 100}%`, minHeight: '4px' }}
          onMouseEnter={(e) => handleMouseEnter(day, e)}
          onMouseMove={(e) => handleMouseMove(day, e)}
          onMouseLeave={handleMouseLeave}
        />
      ))}
      {tooltip && (
        <div
          className="absolute pointer-events-none z-[9959] px-3 py-2 bg-surface-900 border border-surface-600 rounded-lg shadow-lg text-sm whitespace-nowrap"
          style={{
            left: Math.min(Math.max(tooltip.x, 60), containerRef.current ? containerRef.current.clientWidth - 60 : tooltip.x),
            top: Math.max(0, tooltip.y - 60),
            transform: 'translateX(-50%)',
          }}
        >
          <div className="text-surface-300 text-xs">{formatDate(tooltip.date)}</div>
          <div className="text-surface-100 font-medium">{formatCost(tooltip.cost)}</div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// COST BY PROJECT
// ============================================================================

function CostByProject({ data, projectsRoot }: { data: Record<string, number>; projectsRoot: string | null }) {
  const entries = Object.entries(data)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (entries.length === 0) {
    return <EmptyChartState message="No projects tracked yet" />;
  }

  const maxCost = entries[0]?.[1] ?? 1;

  return (
    <div className="space-y-2">
      {entries.map(([project, cost]) => {
        const displayName = decodeProjectName(project, projectsRoot);
        return (
          <div key={project} className="flex items-center gap-3">
            <div className="w-24 text-xs text-surface-400 truncate" title={displayName}>{displayName}</div>
            <div className="flex-1 h-6 bg-surface-800 rounded overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary-600 to-accent-600"
                style={{ width: `${(cost / maxCost) * 100}%` }}
              />
            </div>
            <div className="w-16 text-xs text-surface-400 text-right">{formatCost(cost)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// TOOL USAGE GRID
// ============================================================================

function ToolUsageGrid({ data }: { data: ToolUsageStat[] }) {
  if (data.length === 0) {
    return <EmptyChartState message="No tool usage recorded" />;
  }

  return (
    <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-2">
      {data.slice(0, 24).map((tool) => (
        <div key={tool.toolName} className="p-3 bg-surface-800 rounded-lg">
          <div className="text-lg font-bold text-surface-100">{formatNumber(tool.totalCount)}</div>
          <div className="text-xs text-surface-500 truncate">{tool.toolName}</div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// ACTIVITY HEATMAP - Weeks as columns, days as rows (Sun-Sat top to bottom)
// ============================================================================

function ActivityHeatmap({ data }: { data: Array<{ date: string; count: number }> }) {
  const numWeeks = 12;

  const dateMap = new Map(data.map(d => [d.date, d.count]));
  const maxCount = Math.max(...data.map(d => d.count), 1);

  // Format date as YYYY-MM-DD in local timezone (not UTC)
  const formatLocalDate = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const today = new Date();
  const todayStr = formatLocalDate(today);

  // Find the Sunday of the current week
  const currentSunday = new Date(today);
  currentSunday.setDate(today.getDate() - today.getDay());

  // Go back numWeeks-1 weeks to get the starting Sunday
  const startSunday = new Date(currentSunday);
  startSunday.setDate(currentSunday.getDate() - (numWeeks - 1) * 7);

  // Build grid: grid[weekIndex][dayIndex] where dayIndex 0=Sun, 6=Sat
  const grid: Array<Array<{ date: string; count: number } | null>> = [];

  for (let week = 0; week < numWeeks; week++) {
    const weekData: Array<{ date: string; count: number } | null> = [];
    for (let day = 0; day < 7; day++) {
      const cellDate = new Date(startSunday);
      cellDate.setDate(startSunday.getDate() + week * 7 + day);
      const dateStr = formatLocalDate(cellDate);

      // Don't show future dates
      if (dateStr > todayStr) {
        weekData.push(null);
      } else {
        weekData.push({ date: dateStr, count: dateMap.get(dateStr) ?? 0 });
      }
    }
    grid.push(weekData);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Heatmap grid - weeks as columns, days as rows */}
      <div className="flex gap-1">
        {grid.map((week, weekIdx) => (
          <div key={weekIdx} className="flex flex-col gap-1">
            {week.map((cell, dayIdx) => {
              if (!cell) return <div key={dayIdx} className="w-3 h-3" />;

              const level = cell.count === 0 ? 0 : Math.ceil((cell.count / maxCount) * 4);
              return (
                <div
                  key={dayIdx}
                  className={clsx(
                    'w-3 h-3 rounded-sm cursor-default',
                    level === 0 && 'bg-surface-800',
                    level === 1 && 'bg-success-500/20',
                    level === 2 && 'bg-success-500/40',
                    level === 3 && 'bg-success-500/60',
                    level === 4 && 'bg-success-500/80'
                  )}
                  title={`${cell.date}: ${cell.count} sessions`}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1 text-2xs text-surface-500">
        <span>Less</span>
        <div className="w-3 h-3 rounded-sm bg-surface-800" />
        <div className="w-3 h-3 rounded-sm bg-success-500/20" />
        <div className="w-3 h-3 rounded-sm bg-success-500/40" />
        <div className="w-3 h-3 rounded-sm bg-success-500/60" />
        <div className="w-3 h-3 rounded-sm bg-success-500/80" />
        <span>More</span>
      </div>
    </div>
  );
}

// ============================================================================
// EMPTY CHART STATE
// ============================================================================

function EmptyChartState({ message }: { message: string }) {
  return (
    <div className="h-32 flex items-center justify-center text-surface-500">
      {message}
    </div>
  );
}

// ============================================================================
// LOADING SKELETON
// ============================================================================

function LoadingSkeleton() {
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <div className="h-8 w-48 skeleton" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <AnalyticsCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
