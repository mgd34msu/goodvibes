// ============================================================================
// HOOK EVENTS - Aggregation and analytics queries
// ============================================================================

import { getDatabase } from '../connection.js';
import type { HookEventStats } from './types.js';

// ============================================================================
// HOOK EVENT ANALYTICS
// ============================================================================

/**
 * Get hook event statistics
 */
export function getHookEventStats(): HookEventStats {
  const db = getDatabase();

  const total = db.prepare('SELECT COUNT(*) as count FROM hook_events').get() as { count: number };

  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM hook_events
    GROUP BY event_type
  `).all() as { event_type: string; count: number }[];

  const blocked = db.prepare(
    'SELECT COUNT(*) as count FROM hook_events WHERE blocked = 1'
  ).get() as { count: number };

  const avgDuration = db.prepare(
    'SELECT AVG(duration_ms) as avg FROM hook_events'
  ).get() as { avg: number | null };

  const eventsByType: Record<string, number> = {};
  for (const row of byType) {
    eventsByType[row.event_type] = row.count;
  }

  return {
    totalEvents: total.count,
    eventsByType,
    blockedCount: blocked.count,
    avgDurationMs: avgDuration.avg ?? 0,
  };
}

/**
 * Get hook event counts by hour for the last 24 hours
 */
export function getHookEventsByHour(): Array<{ hour: string; count: number }> {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d %H:00', timestamp) as hour,
      COUNT(*) as count
    FROM hook_events
    WHERE timestamp >= datetime('now', '-24 hours')
    GROUP BY hour
    ORDER BY hour ASC
  `).all() as { hour: string; count: number }[];

  return rows;
}

/**
 * Get blocked events summary
 */
export function getBlockedEventsSummary(): {
  totalBlocked: number;
  byReason: Record<string, number>;
  byTool: Record<string, number>;
} {
  const db = getDatabase();

  const totalBlocked = db.prepare(
    'SELECT COUNT(*) as count FROM hook_events WHERE blocked = 1'
  ).get() as { count: number };

  const byReason = db.prepare(`
    SELECT block_reason, COUNT(*) as count
    FROM hook_events
    WHERE blocked = 1 AND block_reason IS NOT NULL
    GROUP BY block_reason
  `).all() as { block_reason: string; count: number }[];

  const byTool = db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM hook_events
    WHERE blocked = 1 AND tool_name IS NOT NULL
    GROUP BY tool_name
  `).all() as { tool_name: string; count: number }[];

  const reasonMap: Record<string, number> = {};
  for (const row of byReason) {
    reasonMap[row.block_reason] = row.count;
  }

  const toolMap: Record<string, number> = {};
  for (const row of byTool) {
    toolMap[row.tool_name] = row.count;
  }

  return {
    totalBlocked: totalBlocked.count,
    byReason: reasonMap,
    byTool: toolMap,
  };
}

/**
 * Get tool usage statistics from hook events
 */
export function getToolUsageFromHooks(): Array<{
  toolName: string;
  totalCalls: number;
  blockedCalls: number;
  avgDurationMs: number;
}> {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) as total_calls,
      SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) as blocked_calls,
      AVG(duration_ms) as avg_duration
    FROM hook_events
    WHERE tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY total_calls DESC
  `).all() as {
    tool_name: string;
    total_calls: number;
    blocked_calls: number;
    avg_duration: number | null;
  }[];

  return rows.map(row => ({
    toolName: row.tool_name,
    totalCalls: row.total_calls,
    blockedCalls: row.blocked_calls,
    avgDurationMs: row.avg_duration ?? 0,
  }));
}

/**
 * Get session activity summary
 */
export function getSessionActivitySummary(sessionId: string): {
  totalEvents: number;
  eventsByType: Record<string, number>;
  totalDurationMs: number;
  blockedCount: number;
  toolsUsed: string[];
} {
  const db = getDatabase();

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM hook_events WHERE session_id = ?'
  ).get(sessionId) as { count: number };

  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM hook_events
    WHERE session_id = ?
    GROUP BY event_type
  `).all(sessionId) as { event_type: string; count: number }[];

  const duration = db.prepare(
    'SELECT SUM(duration_ms) as total FROM hook_events WHERE session_id = ?'
  ).get(sessionId) as { total: number | null };

  const blocked = db.prepare(
    'SELECT COUNT(*) as count FROM hook_events WHERE session_id = ? AND blocked = 1'
  ).get(sessionId) as { count: number };

  const tools = db.prepare(`
    SELECT DISTINCT tool_name
    FROM hook_events
    WHERE session_id = ? AND tool_name IS NOT NULL
  `).all(sessionId) as { tool_name: string }[];

  const eventsByType: Record<string, number> = {};
  for (const row of byType) {
    eventsByType[row.event_type] = row.count;
  }

  return {
    totalEvents: total.count,
    eventsByType,
    totalDurationMs: duration.total ?? 0,
    blockedCount: blocked.count,
    toolsUsed: tools.map(t => t.tool_name),
  };
}
